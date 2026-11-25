import { TelegramClient, MemoryStorage, InputMedia, html, type Message, type UploadedFile } from '@mtcute/node';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { sentMsgStore } from '../store.js';

let _userClient: TelegramClient | null = null;
let _userSelfId: number | null = null;
const _topicMuteStateCache = new Map<number, boolean>();

function resolveSessionFilePath(rawPath: string): string {
    try {
        if (existsSync(rawPath) && statSync(rawPath).isDirectory()) {
            return path.join(rawPath, 'user.session');
        }
    } catch { }
    if (path.basename(rawPath) === 'data' || !rawPath.endsWith('.session')) {
        return path.join(rawPath, 'user.session');
    }
    return rawPath;
}

export function isUserClientReady(): boolean {
    return _userClient !== null;
}

export function getUserClient(): TelegramClient | null {
    return _userClient;
}

export function getUserSelfId(): number | null {
    return _userSelfId;
}

/**
 * Khởi tạo client User-bot (mtcute MTProto).
 * Sử dụng MemoryStorage + String Session file để hoạt động thuần túy trên JavaScript/TypeScript,
 * không phụ thuộc vào thư viện C++ native better-sqlite3 (tránh lỗi binding trên ARM64/Ubuntu).
 */
export async function initUserClient(): Promise<TelegramClient | null> {
    if (!config.telegram.apiId || !config.telegram.apiHash) {
        console.warn('[UserBot] TG_API_ID hoặc TG_API_HASH chưa được cung cấp trong .env. Bỏ qua khởi tạo User-bot.');
        return null;
    }

    try {
        const sessionPath = resolveSessionFilePath(config.telegram.userSessionPath);
        let savedSession: string | undefined;
        if (existsSync(sessionPath) && !statSync(sessionPath).isDirectory()) {
            try {
                const content = readFileSync(sessionPath, 'utf8').trim();
                if (content.length > 0) {
                    savedSession = content;
                }
            } catch { /* ignore read error */ }
        }

        const client = new TelegramClient({
            apiId: config.telegram.apiId,
            apiHash: config.telegram.apiHash,
            storage: new MemoryStorage(),
            network: {
                // Keep upload connections alive 5 minutes (default 60s) to avoid
                // repeated MTProto handshake delays on consecutive media sends.
                inactivityTimeout: 5 * 60_000,
                // Use 8 parallel upload sockets across DCs (default caps DC 2/4 at 4)
                // while keeping main = 0 (recommended default).
                connectionCount: (kind, _dcId, isPremium) => {
                    switch (kind) {
                        case 'main':
                            return 0;
                        case 'upload':
                            return isPremium ? 12 : 8;
                        case 'download':
                            return isPremium ? 8 : 2;
                        case 'downloadSmall':
                            return 2;
                    }
                },
            },
        });

        if (!savedSession && !process.stdin.isTTY) {
            console.warn('[UserBot] Chưa có session đăng nhập Telegram. Vui lòng chạy lệnh: "npm run login-userbot" trên terminal để đăng nhập lần đầu.');
            return null;
        }

        console.log('[UserBot] Đang kết nối User-bot MTProto...');
        const user = await client.start({
            session: savedSession,
        });

        // Xuất và lưu String Session để các lần sau tự động đăng nhập không cần nhập lại OTP
        try {
            const exported = await client.exportSession();
            mkdirSync(path.dirname(sessionPath), { recursive: true });
            writeFileSync(sessionPath, exported, 'utf8');
        } catch (saveErr) {
            console.warn('[UserBot] Không thể lưu file session:', saveErr);
        }

        _userClient = client;
        _userSelfId = user.id;
        console.log(`[UserBot] Đã đăng nhập User-bot thành công: ${user.displayName} (@${user.username || user.id})`);
        return _userClient;
    } catch (err) {
        console.error('[UserBot] Khởi động User-bot thất bại:', err);
        return null;
    }
}

/**
 * Đồng bộ trạng thái mute của 1 topic trên Telegram theo Zalo thời gian thực.
 * Sử dụng MTProto TL method: account.updateNotifySettings
 */
export async function syncTelegramTopicMute(topicId: number, isMuted: boolean): Promise<void> {
    if (!_userClient) return;

    const current = _topicMuteStateCache.get(topicId);
    if (current === isMuted) return;

    try {
        const peer = await _userClient.resolvePeer(config.telegram.groupId);
        await _userClient.call({
            _: 'account.updateNotifySettings',
            peer: {
                _: 'inputNotifyForumTopic',
                peer,
                topMsgId: topicId,
            },
            settings: {
                _: 'inputPeerNotifySettings',
                muteUntil: isMuted ? 2147483647 : 0,
            },
        });
        _topicMuteStateCache.set(topicId, isMuted);
        console.log(`[UserBot] Đồng bộ mute topic ${topicId}: ${isMuted ? 'MUTED' : 'UNMUTED'}`);
    } catch (err) {
        console.warn(`[UserBot] Lỗi đồng bộ mute topic ${topicId}:`, err);
    }
}

export interface UserSendOptions {
    threadId: number;
    replyTo?: number;
    caption?: string;
    fileName?: string;
}

/**
 * Upload a local file ahead of sendMedia/sendMediaGroup using larger chunks
 * (up to 512 KB) and 4 pipelined requests per upload socket. Also runs outside
 * trackUserBotSend so user messages in the same topic never stall waiting for uploads.
 */
async function uploadLocalFile(
    client: TelegramClient,
    localPath: string,
    fileName?: string,
    requirePhotoMeta = false,
): Promise<UploadedFile> {
    const cleanPath = localPath.startsWith('file:') ? localPath.slice(5) : localPath;
    let partSize = 128;
    try {
        const { size } = await stat(cleanPath);
        if (size >= 4 * 1024 * 1024) partSize = 512;
        else if (size >= 1 * 1024 * 1024) partSize = 256;
    } catch { /* fallback to 128 KB */ }

    return client.uploadFile({
        file: cleanPath,
        fileName,
        partSize,
        requestsPerConnection: 4,
        requireFileSize: requirePhotoMeta,
        requireExtension: requirePhotoMeta,
    });
}

async function sendSingleAsUser(
    threadId: number,
    fn: (client: TelegramClient) => Promise<Message>,
): Promise<Message> {
    if (!_userClient) throw new Error('User-bot client chưa sẵn sàng');
    const client = _userClient;
    return sentMsgStore.trackUserBotSend(threadId, async () => {
        const sent = await fn(client);
        sentMsgStore.markUserBotEcho(sent.id);
        return sent;
    });
}

export async function sendTextAsUser(
    text: string,
    options: UserSendOptions,
): Promise<Message> {
    return sendSingleAsUser(options.threadId, client =>
        client.sendText(
            config.telegram.groupId,
            html(text),
            {
                threadId: options.threadId,
                replyTo: options.replyTo,
            },
        ),
    );
}

export async function sendPhotoAsUser(
    localPath: string,
    options: UserSendOptions,
): Promise<Message> {
    if (!_userClient) throw new Error('User-bot client chưa sẵn sàng');
    const base = path.basename(localPath);
    const fileName = options.fileName ?? (path.extname(base) ? base : `${base}.jpg`);
    const uploaded = await uploadLocalFile(_userClient, localPath, fileName, true);
    return sendSingleAsUser(options.threadId, client =>
        client.sendMedia(
            config.telegram.groupId,
            InputMedia.photo(uploaded, {
                caption: options.caption ? html(options.caption) : undefined,
            }),
            {
                threadId: options.threadId,
                replyTo: options.replyTo,
            },
        ),
    );
}

export async function sendMediaGroupAsUser(
    items: Array<{ localPath: string; caption?: string }>,
    options: UserSendOptions,
): Promise<Message[]> {
    if (!_userClient) throw new Error('User-bot client chưa sẵn sàng');
    const client = _userClient;
    const uploadedItems = await Promise.all(
        items.map(async item => {
            const base = path.basename(item.localPath);
            const fileName = path.extname(base) ? base : `${base}.jpg`;
            const uploaded = await uploadLocalFile(client, item.localPath, fileName, true);
            return InputMedia.photo(uploaded, {
                caption: item.caption ? html(item.caption) : undefined,
            });
        }),
    );
    return sentMsgStore.trackUserBotSend(options.threadId, async () => {
        const sentMsgs = await client.sendMediaGroup(
            config.telegram.groupId,
            uploadedItems,
            {
                threadId: options.threadId,
                replyTo: options.replyTo,
            },
        );
        for (const sent of sentMsgs) {
            sentMsgStore.markUserBotEcho(sent.id);
        }
        return sentMsgs;
    });
}

export async function sendVideoAsUser(
    localPath: string,
    options: UserSendOptions,
): Promise<Message> {
    if (!_userClient) throw new Error('User-bot client chưa sẵn sàng');
    const rawExt = path.extname(localPath).toLowerCase();
    const videoExt = rawExt && rawExt !== '.bin' ? rawExt : '.mp4';
    const fileName = options.fileName ?? `video_${Date.now()}${videoExt}`;
    const uploaded = await uploadLocalFile(_userClient, localPath, fileName);
    return sendSingleAsUser(options.threadId, client =>
        client.sendMedia(
            config.telegram.groupId,
            InputMedia.video(uploaded, {
                fileName,
                supportsStreaming: true,
                caption: options.caption ? html(options.caption) : undefined,
            }),
            {
                threadId: options.threadId,
                replyTo: options.replyTo,
            },
        ),
    );
}

export async function sendVoiceAsUser(
    localPath: string,
    options: UserSendOptions,
): Promise<Message> {
    if (!_userClient) throw new Error('User-bot client chưa sẵn sàng');
    const fileName = options.fileName ?? path.basename(localPath);
    const uploaded = await uploadLocalFile(_userClient, localPath, fileName);
    return sendSingleAsUser(options.threadId, client =>
        client.sendMedia(
            config.telegram.groupId,
            InputMedia.voice(uploaded, {
                caption: options.caption ? html(options.caption) : undefined,
            }),
            {
                threadId: options.threadId,
                replyTo: options.replyTo,
            },
        ),
    );
}

export async function sendAnimationAsUser(
    localPath: string,
    options: UserSendOptions,
): Promise<Message> {
    if (!_userClient) throw new Error('User-bot client chưa sẵn sàng');
    const fileName = options.fileName ?? path.basename(localPath);
    const uploaded = await uploadLocalFile(_userClient, localPath, fileName);
    return sendSingleAsUser(options.threadId, client =>
        client.sendMedia(
            config.telegram.groupId,
            InputMedia.animation(uploaded, {
                fileName,
                caption: options.caption ? html(options.caption) : undefined,
            }),
            {
                threadId: options.threadId,
                replyTo: options.replyTo,
            },
        ),
    );
}

export async function sendFileAsUser(
    localPath: string,
    options: UserSendOptions,
): Promise<Message> {
    if (!_userClient) throw new Error('User-bot client chưa sẵn sàng');
    const fileName = options.fileName ?? path.basename(localPath);
    const uploaded = await uploadLocalFile(_userClient, localPath, fileName);
    return sendSingleAsUser(options.threadId, client =>
        client.sendMedia(
            config.telegram.groupId,
            InputMedia.document(uploaded, {
                fileName,
                caption: options.caption ? html(options.caption) : undefined,
            }),
            {
                threadId: options.threadId,
                replyTo: options.replyTo,
            },
        ),
    );
}

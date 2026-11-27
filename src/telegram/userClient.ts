import {
    TelegramClient,
    MemoryStorage,
    InputMedia,
    html,
    getMarkedPeerId,
    type Message,
    type UploadedFile,
    type tl,
} from '@mtcute/node';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { sentMsgStore } from '../store.js';
import {
    isSameMuteState,
    normalizePeerNotifyMute,
    normalizeTargetMuteUntil,
} from '../utils/mute.js';

let _userClient: TelegramClient | null = null;
let _userSelfId: number | null = null;
let _groupInputPeer: tl.TypeInputPeer | null = null;
const _topicMuteUntilCache = new Map<number, number>();
const _selfMuteEchoSuppress = new Map<number, { isMuted: boolean; untilMs: number }>();

export interface TelegramTopicMuteEvent {
    topicId: number;
    isMuted: boolean;
    muteUntil: number;
}

let _topicMuteChangeHandler: ((event: TelegramTopicMuteEvent) => void | Promise<void>) | null = null;

export function setTelegramTopicMuteChangeHandler(
    handler: ((event: TelegramTopicMuteEvent) => void | Promise<void>) | null,
): void {
    _topicMuteChangeHandler = handler;
}

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
        _groupInputPeer = null;

        // Lắng nghe thay đổi mute từ Telegram (chỉ bắt các topic thuộc supergroup bridge)
        client.onRawUpdate.add(({ update }) => {
            if (update._ !== 'updateNotifySettings') return;
            if (update.peer._ !== 'notifyForumTopic') return;
            if (getMarkedPeerId(update.peer.peer) !== config.telegram.groupId) return;

            const topicId = update.peer.topMsgId;
            const normalized = normalizePeerNotifyMute(update.notifySettings);

            const suppress = _selfMuteEchoSuppress.get(topicId);
            if (suppress && Date.now() < suppress.untilMs && suppress.isMuted === normalized.isMuted) {
                _topicMuteUntilCache.set(topicId, normalized.muteUntil);
                return;
            }

            // Dedupe identical/replayed updateNotifySettings packets (Telegram often
            // delivers duplicate updates immediately and/or re-emits during sync).
            const prevMuteUntil = _topicMuteUntilCache.get(topicId);
            if (prevMuteUntil !== undefined && isSameMuteState(prevMuteUntil, normalized.muteUntil)) {
                return;
            }

            _topicMuteUntilCache.set(topicId, normalized.muteUntil);
            if (_topicMuteChangeHandler) {
                void Promise.resolve(_topicMuteChangeHandler({
                    topicId,
                    isMuted: normalized.isMuted,
                    muteUntil: normalized.muteUntil,
                })).catch(err => {
                    console.warn(`[UserBot] Lỗi xử lý mute từ Telegram cho topic ${topicId}:`, err);
                });
            }
        });

        console.log(`[UserBot] Đã đăng nhập User-bot thành công: ${user.displayName} (@${user.username || user.id})`);
        return _userClient;
    } catch (err) {
        console.error('[UserBot] Khởi động User-bot thất bại:', err);
        return null;
    }
}

async function getGroupInputPeer(): Promise<tl.TypeInputPeer> {
    if (!_userClient) throw new Error('User-bot client chưa sẵn sàng');
    if (!_groupInputPeer) {
        _groupInputPeer = await _userClient.resolvePeer(config.telegram.groupId);
    }
    return _groupInputPeer;
}

/**
 * Đọc trạng thái mute hiện tại của các forum topic trên Telegram theo batch (tối đa 100/lần)
 * để tránh gọi account.updateNotifySettings dư thừa khi khởi động.
 */
export async function fetchTelegramTopicMuteStates(topicIds: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (!_userClient || topicIds.length === 0) return result;

    const peer = await getGroupInputPeer();
    const nowSec = Math.floor(Date.now() / 1000);
    const BATCH_SIZE = 100;

    for (let i = 0; i < topicIds.length; i += BATCH_SIZE) {
        const batch = topicIds.slice(i, i + BATCH_SIZE);
        try {
            const resp = await _userClient.call({
                _: 'messages.getForumTopicsByID',
                peer,
                topics: batch,
            });
            for (const topic of resp.topics) {
                if (topic._ !== 'forumTopic') continue;
                const { muteUntil } = normalizePeerNotifyMute(topic.notifySettings, nowSec);
                result.set(topic.id, muteUntil);
                _topicMuteUntilCache.set(topic.id, muteUntil);
            }
        } catch (err) {
            console.warn('[UserBot] Lỗi đọc danh sách trạng thái mute topic:', err);
        }
    }

    return result;
}

/**
 * Đồng bộ trạng thái mute của 1 topic trên Telegram theo Zalo thời gian thực.
 * Hỗ trợ cả boolean và mốc muteUntil (Unix timestamp giây; >= 2e9 = vĩnh viễn).
 * Trả về true nếu thực sự có gọi API cập nhật lên Telegram.
 */
export async function syncTelegramTopicMute(
    topicId: number,
    muteUntilOrFlag: boolean | number,
): Promise<boolean> {
    if (!_userClient) return false;

    const nowSec = Math.floor(Date.now() / 1000);
    const targetMuteUntil = normalizeTargetMuteUntil(muteUntilOrFlag, nowSec);
    const cached = _topicMuteUntilCache.get(topicId);
    if (cached !== undefined && isSameMuteState(cached, targetMuteUntil, nowSec)) {
        return false;
    }

    const isMuted = targetMuteUntil > 0;
    const prevCached = cached;
    _selfMuteEchoSuppress.set(topicId, { isMuted, untilMs: Date.now() + 10_000 });
    _topicMuteUntilCache.set(topicId, targetMuteUntil);

    try {
        const peer = await getGroupInputPeer();
        await _userClient.call({
            _: 'account.updateNotifySettings',
            peer: {
                _: 'inputNotifyForumTopic',
                peer,
                topMsgId: topicId,
            },
            settings: targetMuteUntil === 0
                ? { _: 'inputPeerNotifySettings', silent: false, muteUntil: 0 }
                : targetMuteUntil >= 2_000_000_000
                    ? { _: 'inputPeerNotifySettings', silent: true, muteUntil: targetMuteUntil }
                    : { _: 'inputPeerNotifySettings', muteUntil: targetMuteUntil },
        });
        const label = targetMuteUntil === 0
            ? 'UNMUTED'
            : (targetMuteUntil >= 2_000_000_000 ? 'MUTED (forever)' : `MUTED until ${targetMuteUntil}`);
        console.log(`[UserBot] Đồng bộ mute topic ${topicId}: ${label}`);
        return true;
    } catch (err) {
        _selfMuteEchoSuppress.delete(topicId);
        if (prevCached === undefined) {
            _topicMuteUntilCache.delete(topicId);
        } else {
            _topicMuteUntilCache.set(topicId, prevCached);
        }
        console.warn(`[UserBot] Lỗi đồng bộ mute topic ${topicId}:`, err);
        return false;
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

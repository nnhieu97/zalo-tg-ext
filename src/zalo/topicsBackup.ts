import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import type { Context } from 'telegraf';
import { config } from '../config.js';
import {
  getTopicsFilePath,
  setOnTopicsPersisted,
  store,
  validateTopicsJson,
} from '../store.js';
import { tgBot } from '../telegram/bot.js';
import { findLatestDocumentByName, isUserClientReady } from '../telegram/userClient.js';
import { escapeHtml } from '../utils/format.js';
import { tgQueue } from '../utils/tgQueue.js';
import { zaloApiWithRetry } from '../utils/zaloRetry.js';
import type { ZaloAPI } from './types.js';

interface TopicsBackupMeta {
  messageId: number;
  fileName: string;
  phoneLabel: string;
}

interface PendingRestoreState {
  id: string;
  rawJson: string;
  fileName: string;
  phoneLabel: string;
  fileMessageId: number;
  onRestored?: () => void;
}

const META_FILE = path.resolve(config.dataDir, 'topics-backup.json');

let _cachedIdentity: { phoneLabel: string; fileName: string } | null = null;
let _backupChain: Promise<void> = Promise.resolve();
let _restoreChecked = false;
let _pendingRestore: PendingRestoreState | null = null;

function sanitizeBackupLabel(raw: string): string {
  return raw.trim().replace(/[\\/:*?"<>|\r\n\0]/g, '');
}

function readBackupMeta(): TopicsBackupMeta | null {
  if (!existsSync(META_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(META_FILE, 'utf8')) as Partial<TopicsBackupMeta>;
    if (
      typeof parsed.messageId === 'number'
      && Number.isSafeInteger(parsed.messageId)
      && parsed.messageId > 0
      && typeof parsed.fileName === 'string'
      && parsed.fileName.length > 0
    ) {
      return {
        messageId: parsed.messageId,
        fileName: parsed.fileName,
        phoneLabel: typeof parsed.phoneLabel === 'string' ? parsed.phoneLabel : '',
      };
    }
  } catch { /* ignore malformed meta */ }
  return null;
}

function writeBackupMeta(meta: TopicsBackupMeta): void {
  mkdirSync(path.dirname(META_FILE), { recursive: true });
  const tmp = META_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
  renameSync(tmp, META_FILE);
}

async function resolveBackupIdentity(api: ZaloAPI): Promise<{ phoneLabel: string; fileName: string }> {
  if (_cachedIdentity) return _cachedIdentity;

  let phoneLabel = '';
  try {
    const info = await zaloApiWithRetry(api).fetchAccountInfo() as {
      profile?: { phoneNumber?: string; userId?: string };
    };
    if (typeof info?.profile?.phoneNumber === 'string' && info.profile.phoneNumber.trim()) {
      phoneLabel = sanitizeBackupLabel(info.profile.phoneNumber);
    } else if (typeof info?.profile?.userId === 'string' && info.profile.userId.trim()) {
      phoneLabel = sanitizeBackupLabel(info.profile.userId);
    }
  } catch (err) {
    console.warn('[TopicsBackup] Không đọc được fetchAccountInfo:', err);
  }

  if (!phoneLabel) {
    const ownUid = String(api.getOwnId?.() ?? '').trim();
    phoneLabel = sanitizeBackupLabel(ownUid) || 'unknown';
  }

  _cachedIdentity = {
    phoneLabel,
    fileName: `${phoneLabel}topics.json`,
  };
  return _cachedIdentity;
}

function isMessageMissingError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('message to edit not found')
    || msg.includes('message_id_invalid')
    || msg.includes('message not found')
    || msg.includes("message can't be edited")
  );
}

function isMessageNotModifiedError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('message is not modified');
}

async function performBackup(api: ZaloAPI): Promise<void> {
  if (store.all().length === 0) return;

  const topicsPath = getTopicsFilePath();
  if (!existsSync(topicsPath)) return;

  let fileBuf: Buffer;
  try {
    fileBuf = readFileSync(topicsPath);
  } catch (err) {
    console.warn('[TopicsBackup] Không đọc được file topics.json:', err);
    return;
  }

  const { phoneLabel, fileName } = await resolveBackupIdentity(api);
  const topicCount = store.all().length;
  const caption = `💾 Sao lưu topics.json tài khoản Zalo ${phoneLabel} (${topicCount} topics)`;
  const meta = readBackupMeta();

  if (meta && meta.fileName === fileName) {
    try {
      await tgQueue(() =>
        tgBot.telegram.editMessageMedia(
          config.telegram.groupId,
          meta.messageId,
          undefined,
          {
            type: 'document',
            media: { source: fileBuf, filename: fileName },
            caption,
          },
        ),
      );
      return;
    } catch (err) {
      if (isMessageNotModifiedError(err)) return;
      if (!isMessageMissingError(err)) {
        console.warn('[TopicsBackup] Lỗi cập nhật file backup cũ:', err);
        return;
      }
      // Tin nhắn backup cũ đã bị xoá trên Telegram → gửi tin nhắn mới bên dưới
    }
  }

  try {
    const sent = await tgQueue(() =>
      tgBot.telegram.sendDocument(
        config.telegram.groupId,
        { source: fileBuf, filename: fileName },
        { caption, disable_notification: true },
      ),
    );
    writeBackupMeta({
      messageId: sent.message_id,
      fileName,
      phoneLabel,
    });
  } catch (err) {
    console.warn('[TopicsBackup] Lỗi gửi file backup mới:', err);
  }
}

export function enqueueTopicsBackup(api: ZaloAPI): void {
  _backupChain = _backupChain
    .then(() => performBackup(api))
    .catch(err => console.warn('[TopicsBackup] Backup chain error:', err));
}

/**
 * Kích hoạt theo dõi lưu backup cho mọi thay đổi của topics.json,
 * đồng thời kiểm tra khôi phục nếu khi khởi động không có dữ liệu topics.json.
 */
export async function initTopicsBackupAndRestore(
  api: ZaloAPI,
  onRestored?: () => void,
): Promise<void> {
  // Cho phép thay đổi API instance khi Zalo reconnect/login lại
  _cachedIdentity = null;
  setOnTopicsPersisted(() => {
    enqueueTopicsBackup(api);
  });

  if (_restoreChecked) return;
  _restoreChecked = true;

  const topicsPath = getTopicsFilePath();
  const hasTopics = existsSync(topicsPath) && store.all().length > 0;
  if (hasTopics) return;

  try {
    await tgQueue(() =>
      tgBot.telegram.sendMessage(
        config.telegram.groupId,
        'Không có sẵn dữ liệu topics.json trong thư mục cài đặt.',
      ),
    );
  } catch (err) {
    console.warn('[TopicsBackup] Không gửi được thông báo thiếu topics.json:', err);
  }

  if (!isUserClientReady()) return;

  const { phoneLabel, fileName } = await resolveBackupIdentity(api);
  const rawBuf = await findLatestDocumentByName(fileName);
  if (!rawBuf) return;

  const rawJson = rawBuf.toString('utf8');
  if (!validateTopicsJson(rawJson)) {
    console.warn(`[TopicsBackup] File "${fileName}" tìm thấy nhưng JSON không hợp lệ — bỏ qua.`);
    return;
  }

  // Tin nhắn 1: gửi file backup hợp lệ để người dùng xem trước
  const fileMsg = await tgQueue(() =>
    tgBot.telegram.sendDocument(
      config.telegram.groupId,
      { source: rawBuf, filename: fileName },
    ),
  );

  const restoreId = Date.now().toString(36);
  _pendingRestore = {
    id: restoreId,
    rawJson,
    fileName,
    phoneLabel,
    fileMessageId: fileMsg.message_id,
    onRestored,
  };

  // Tin nhắn 2: hỏi xác nhận khôi phục với 2 nút Đồng ý / Hủy bỏ
  await tgQueue(() =>
    tgBot.telegram.sendMessage(
      config.telegram.groupId,
      `Đã tìm thấy dữ liệu topics.json được sao lưu cho tài khoản Zalo ${escapeHtml(phoneLabel)}. Bạn có muốn khôi phục nó không?`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Đồng ý', callback_data: `topics_restore:accept:${restoreId}` },
              { text: 'Hủy bỏ', callback_data: `topics_restore:cancel:${restoreId}` },
            ],
          ],
        },
      },
    ),
  );
}

export async function handleTopicsRestoreCallback(
  ctx: Context,
  data: string,
  isAdmin: (userId: number) => Promise<boolean>,
): Promise<boolean> {
  if (!data.startsWith('topics_restore:')) return false;

  const userId = ctx.from?.id;
  if (userId === undefined || !await isAdmin(userId)) {
    await ctx.answerCbQuery('⛔ Chỉ admin Telegram mới có thể thao tác.', { show_alert: true }).catch(() => undefined);
    return true;
  }

  const [, action, restoreId] = data.split(':');
  const pending = _pendingRestore;
  if (!pending || pending.id !== restoreId) {
    await ctx.answerCbQuery('Yêu cầu khôi phục này đã hết hạn hoặc đã được xử lý.', { show_alert: true }).catch(() => undefined);
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    return true;
  }

  _pendingRestore = null;

  if (action === 'cancel') {
    await ctx.answerCbQuery('Đã hủy khôi phục.').catch(() => undefined);
    await ctx.editMessageText('Hủy khôi phục topics.json').catch(() => undefined);
    return true;
  }

  if (action === 'accept') {
    const ok = store.restoreFromJson(pending.rawJson);
    if (!ok) {
      await ctx.answerCbQuery('❌ Dữ liệu JSON không hợp lệ.', { show_alert: true }).catch(() => undefined);
      await ctx.editMessageText('❌ Khôi phục thất bại: dữ liệu topics.json không hợp lệ.').catch(() => undefined);
      return true;
    }

    writeBackupMeta({
      messageId: pending.fileMessageId,
      fileName: pending.fileName,
      phoneLabel: pending.phoneLabel,
    });

    await ctx.answerCbQuery('Đã khôi phục thành công!').catch(() => undefined);
    await ctx.editMessageText('Đã khôi phục file topics.json thành công!').catch(() => undefined);
    pending.onRestored?.();
    return true;
  }

  return true;
}

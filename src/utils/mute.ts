export const TG_MUTE_FOREVER = 2_147_483_647;
export const TG_MUTE_FOREVER_THRESHOLD = 2_000_000_000;
export const ZALO_MAX_TIMED_MUTE_SEC = 30 * 24 * 3600;
export const ZALO_MIN_TIMED_MUTE_SEC = 60;

export interface ZaloMuteEntryLike {
  duration: number;
  startTime: number;
  systemTime?: number;
  currentTime?: number;
}

export interface PeerNotifySettingsLike {
  silent?: boolean;
  muteUntil?: number;
}

export interface NormalizedMuteState {
  isMuted: boolean;
  /** 0 = unmuted, TG_MUTE_FOREVER = forever, else Unix timestamp (seconds). */
  muteUntil: number;
}

export function normalizeTargetMuteUntil(
  target: boolean | number,
  nowSec = Math.floor(Date.now() / 1000),
): number {
  if (target === false || target === 0) return 0;
  if (target === true) return TG_MUTE_FOREVER;
  if (!Number.isFinite(target) || target <= 0) return 0;
  if (target >= TG_MUTE_FOREVER_THRESHOLD) return TG_MUTE_FOREVER;
  if (target <= nowSec) return 0;
  return Math.floor(target);
}

export function normalizePeerNotifyMute(
  settings: PeerNotifySettingsLike | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): NormalizedMuteState {
  if (!settings) return { isMuted: false, muteUntil: 0 };

  if (settings.muteUntil !== undefined && settings.muteUntil > nowSec) {
    const muteUntil = settings.muteUntil >= TG_MUTE_FOREVER_THRESHOLD
      ? TG_MUTE_FOREVER
      : Math.floor(settings.muteUntil);
    return { isMuted: true, muteUntil };
  }

  // A positive muteUntil in the past means a timed mute has expired,
  // even if Telegram left `silent: true` attached.
  if (settings.muteUntil !== undefined && settings.muteUntil > 0 && settings.muteUntil <= nowSec) {
    return { isMuted: false, muteUntil: 0 };
  }

  if (settings.silent === true) {
    return { isMuted: true, muteUntil: TG_MUTE_FOREVER };
  }

  return { isMuted: false, muteUntil: 0 };
}

export function isSameMuteState(
  aMuteUntil: number,
  bMuteUntil: number,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const a = normalizeTargetMuteUntil(aMuteUntil, nowSec);
  const b = normalizeTargetMuteUntil(bMuteUntil, nowSec);
  if (a === 0 && b === 0) return true;
  if (a >= TG_MUTE_FOREVER_THRESHOLD && b >= TG_MUTE_FOREVER_THRESHOLD) return true;
  if (a > 0 && b > 0) return Math.abs(a - b) <= 15;
  return false;
}

/**
 * Convert a Zalo mute entry into a local Telegram-compatible `muteUntil` timestamp
 * (0 = not muted, TG_MUTE_FOREVER = permanent, else local Unix expiry in seconds).
 * Uses remaining duration relative to Zalo's clock to avoid clock-skew mismatches.
 */
export function getZaloMuteExpiresAt(
  entry: ZaloMuteEntryLike,
  nowSec = Math.floor(Date.now() / 1000),
): number {
  if (entry.duration === -1) return TG_MUTE_FOREVER;
  if (entry.duration <= 0) return 0;

  const zaloNow = entry.currentTime ?? entry.systemTime ?? nowSec;
  const remaining = (entry.startTime + entry.duration) - zaloNow;
  if (remaining <= 0) return 0;
  return Math.floor(nowSec + remaining);
}

export function telegramMuteToZaloSpec(
  isMuted: boolean,
  muteUntil: number,
  nowSec = Math.floor(Date.now() / 1000),
): { action: 'mute' | 'unmute'; duration: number } {
  if (!isMuted || muteUntil <= 0) {
    return { action: 'unmute', duration: -1 };
  }
  if (muteUntil >= TG_MUTE_FOREVER_THRESHOLD) {
    return { action: 'mute', duration: -1 };
  }
  const remaining = Math.round(muteUntil - nowSec);
  if (remaining <= 0) {
    return { action: 'unmute', duration: -1 };
  }
  if (remaining > ZALO_MAX_TIMED_MUTE_SEC) {
    return { action: 'mute', duration: -1 };
  }
  return {
    action: 'mute',
    duration: Math.max(ZALO_MIN_TIMED_MUTE_SEC, remaining),
  };
}

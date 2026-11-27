import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TG_MUTE_FOREVER,
  getZaloMuteExpiresAt,
  isSameMuteState,
  normalizePeerNotifyMute,
  normalizeTargetMuteUntil,
  telegramMuteToZaloSpec,
} from '../src/utils/mute.js';

test('normalizePeerNotifyMute handles unmuted, timed, silent and forever states', () => {
  const now = 1_700_000_000;
  assert.deepEqual(normalizePeerNotifyMute(undefined, now), { isMuted: false, muteUntil: 0 });
  assert.deepEqual(normalizePeerNotifyMute({ muteUntil: 0 }, now), { isMuted: false, muteUntil: 0 });
  assert.deepEqual(normalizePeerNotifyMute({ muteUntil: now - 10 }, now), { isMuted: false, muteUntil: 0 });
  assert.deepEqual(normalizePeerNotifyMute({ silent: true, muteUntil: now - 10 }, now), { isMuted: false, muteUntil: 0 });
  assert.deepEqual(normalizePeerNotifyMute({ silent: false, muteUntil: 0 }, now), { isMuted: false, muteUntil: 0 });

  assert.deepEqual(normalizePeerNotifyMute({ silent: true }, now), { isMuted: true, muteUntil: TG_MUTE_FOREVER });
  assert.deepEqual(normalizePeerNotifyMute({ muteUntil: now + 3600 }, now), { isMuted: true, muteUntil: now + 3600 });
  assert.deepEqual(normalizePeerNotifyMute({ muteUntil: 2_147_483_647 }, now), { isMuted: true, muteUntil: TG_MUTE_FOREVER });
});

test('getZaloMuteExpiresAt adjusts for server clock and rejects expired entries', () => {
  const localNow = 1_700_000_000;
  assert.equal(getZaloMuteExpiresAt({ duration: -1, startTime: 1_000 }, localNow), TG_MUTE_FOREVER);
  assert.equal(getZaloMuteExpiresAt({ duration: 0, startTime: 1_000 }, localNow), 0);

  // Server clock is 50s ahead of local clock, 3600s mute started 600s ago -> 3000s remaining
  assert.equal(
    getZaloMuteExpiresAt({ duration: 3600, startTime: localNow + 50 - 600, currentTime: localNow + 50 }, localNow),
    localNow + 3000,
  );

  // Already expired on server
  assert.equal(
    getZaloMuteExpiresAt({ duration: 3600, startTime: localNow - 4000, currentTime: localNow }, localNow),
    0,
  );
});

test('telegramMuteToZaloSpec maps forever, timed, clamped and unmute accurately', () => {
  const now = 1_700_000_000;
  assert.deepEqual(telegramMuteToZaloSpec(false, 0, now), { action: 'unmute', duration: -1 });
  assert.deepEqual(telegramMuteToZaloSpec(true, now - 1, now), { action: 'unmute', duration: -1 });
  assert.deepEqual(telegramMuteToZaloSpec(true, TG_MUTE_FOREVER, now), { action: 'mute', duration: -1 });
  assert.deepEqual(telegramMuteToZaloSpec(true, now + 7200, now), { action: 'mute', duration: 7200 });
  // Very short mute clamps to 60s minimum
  assert.deepEqual(telegramMuteToZaloSpec(true, now + 15, now), { action: 'mute', duration: 60 });
  // Very long mute (> 30 days) falls back to forever (-1)
  assert.deepEqual(telegramMuteToZaloSpec(true, now + 60 * 24 * 3600, now), { action: 'mute', duration: -1 });
});

test('isSameMuteState compares unmuted, forever and timed within tolerance', () => {
  const now = 1_700_000_000;
  assert.equal(isSameMuteState(0, 0, now), true);
  assert.equal(isSameMuteState(now - 5, 0, now), true);
  assert.equal(isSameMuteState(TG_MUTE_FOREVER, 2_050_000_000, now), true);
  assert.equal(isSameMuteState(now + 3600, now + 3605, now), true);
  assert.equal(isSameMuteState(now + 3600, now + 14400, now), false);
  assert.equal(isSameMuteState(now + 3600, 0, now), false);
  assert.equal(normalizeTargetMuteUntil(true, now), TG_MUTE_FOREVER);
});

// Volume sync between YouTube and MPRIS.
//
// The native host is the only side that touches MPRIS. It polls the MPRIS
// Volume property (Firefox never announces changes to it) and reports only the
// changes it did not cause, so attribution is explicit instead of guessed:
//
//   host  -> page: an external MPRIS change. Apply it to the player and remember
//                  the value as expected. Never send it back.
//   page  -> host: the user moved YouTube's slider. Debounce it so a drag or an
//                  animation settles into one value, then write that value.
//
// On top of that, the host refuses to write a value MPRIS already holds, and a
// short lock after applying a host value ignores the onVolumeChange events that
// Firefox itself produces while applying it. Together those two rules are what
// stop the old YouTube -> MPRIS -> YouTube echo.
const VOLUME_EVENT = 'ytmpris-set-volume';
const api = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
const SEND_DELAY_MS = 150; // let a drag or a volume animation settle
const APPLY_LOCK_MS = 400; // ignore page events caused by applying a host value
const VOLUME_EPS = 1e-6; // ignore float noise, not real volume changes

let bridgeInjected = false;
let adopted = false;
let expected = null; // normalized volume last applied from the host or sent to it
let lockUntil = 0;
let sendTimer = null;
let pending = null;

// Volume normalized to 0..1 without cutting decimals.
function normalizeVolume(volume) {
  if (volume === null || volume === undefined || volume === '') return null;
  const v = Number(volume);
  if (!Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

// YouTube reports volume as percent (0..100), possibly with decimals (52.6461).
function percentToVolume(percent) {
  const p = Number(percent);
  if (!Number.isFinite(p)) return null;
  return normalizeVolume(p / 100);
}

function sameVolume(a, b) {
  return a !== null && b !== null && Math.abs(a - b) <= VOLUME_EPS;
}

// Runs in the page's JS world, where movie_player is reachable.
function pageVolumeBridge() {
  const REPORT = 'ytmpris-volume-report';
  // YouTube's loudness / Stable Volume processing scales the media element away
  // from the slider, so a 5% slider can make video.volume 0.026. That means
  // "slider value" (logical) and video.volume (actual) are two different
  // scales, and if MPRIS holds one while the element holds the other, every
  // sync bounces between them (the 1ms blip). The calc layer below keeps a
  // single logical scale everywhere: MPRIS always gets the slider value, and
  // the element is pinned to that same value so there is nothing to fight over.
  let scale = 1; // element volume per 1.0 of slider; learned as we observe

  function currentVideo() {
    return document.querySelector('video');
  }
  function readActual() {
    const vid = currentVideo();
    if (!vid) return null;
    const v = Number(vid.volume);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
  }
  // The logical slider value as percent (0..100), in the MPRIS scale.
  function readSliderPercent(player) {
    if (player && typeof player.getVolume === 'function') {
      const v = Number(player.getVolume());
      if (Number.isFinite(v)) return v;
    }
    const panel = document.querySelector('.ytp-volume-panel[aria-valuenow]');
    if (panel && typeof panel.getAttribute === 'function') {
      const v = parseFloat(panel.getAttribute('aria-valuenow'));
      if (Number.isFinite(v)) return v;
    }
    // Last resort: recover the logical value from the media element. This is
    // the calc layer the other way around (video.volume 0.026 -> slider 5%).
    const actual = readActual();
    if (actual === null || scale <= 0) return null;
    return (actual / scale) * 100;
  }
  // Learn the element/slider ratio while the page is idle, so the fallback
  // above can convert video.volume back into the logical slider value.
  function observeScale(player) {
    const logical = player && typeof player.getVolume === 'function'
      ? Number(player.getVolume()) / 100 : null;
    const actual = readActual();
    if (logical === null || !Number.isFinite(logical) || logical <= 1e-6) return;
    if (actual === null || actual <= 1e-6) return;
    const s = actual / logical;
    if (s >= 0.05 && s <= 2) scale = scale * 0.8 + s * 0.2;
  }
  // Pin the media element to the logical slider level so loudness / Stable
  // Volume normalization cannot leave the real audio on a different scale
  // than MPRIS reports.
  function pinElement(logical) {
    const vid = currentVideo();
    if (!vid) return;
    const v = Math.min(1, Math.max(0, logical));
    const cur = Number(vid.volume);
    if (Number.isFinite(cur) && Math.abs(cur - v) <= 1e-6) return;
    vid.volume = v;
  }
  function report(player) {
    observeScale(player);
    const v = readSliderPercent(player);
    if (v !== null) {
      window.dispatchEvent(new CustomEvent(REPORT, { detail: v }));
      pinElement(v / 100);
    }
  }
  window.addEventListener('ytmpris-set-volume', (e) => {
    const volume = Number(e.detail);
    if (!Number.isFinite(volume)) return;
    const logical = Math.min(1, Math.max(0, volume));
    const percent = logical * 100;
    const player = document.getElementById('movie_player');
    if (player && typeof player.setVolume === 'function') {
      let changed = true;
      if (typeof player.getVolume === 'function') {
        const current = Number(player.getVolume());
        // 1e-4 percent is 1e-6 of the 0..1 volume, the same tolerance used above.
        if (Number.isFinite(current) && Math.abs(current - percent) <= 1e-4) changed = false;
      }
      if (changed) player.setVolume(percent);
    }
    // The slider is set; now fix the element to the same logical value so
    // Firefox's MPRIS write and YouTube's normalization agree on one scale.
    pinElement(logical);
  });
  function hook() {
    const player = document.getElementById('movie_player');
    if (!player || player.__ytmprisHooked || typeof player.addEventListener !== 'function') return;
    player.__ytmprisHooked = true;
    player.addEventListener('onVolumeChange', () => report(player));
  }
  window.addEventListener('ytmpris-attach', hook);
  hook();
}

function ensureBridge() {
  if (!bridgeInjected) {
    bridgeInjected = true;
    window.addEventListener('ytmpris-volume-report', (e) => onPageVolume(e.detail));
    const script = document.createElement('script');
    script.textContent = '(' + pageVolumeBridge.toString() + ')();';
    document.documentElement.appendChild(script);
    script.remove();
  }
  window.dispatchEvent(new CustomEvent('ytmpris-attach'));
}

function sendToHost(volume) {
  try {
    const sent = api.runtime.sendMessage({
      type: 'volume',
      volume,
      // Legacy field for an older background/host; the new host prefers volume.
      millis: Math.round(volume * 1000),
    });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch (e) {
    // Background page not ready yet; the next change will retry.
  }
}

function flushPageVolume() {
  sendTimer = null;
  const volume = pending;
  pending = null;
  if (volume === null) return;
  // The value may have been applied from MPRIS while the timer was pending.
  if (Date.now() < lockUntil) return;
  if (sameVolume(volume, expected)) return;
  expected = volume;
  sendToHost(volume);
}

// YouTube -> host: the page volume changed for a reason we did not cause.
function onPageVolume(percent) {
  const volume = percentToVolume(percent);
  if (volume === null) return;
  // First value on this page belongs to the site; adopt it without writing.
  if (!adopted) {
    adopted = true;
    expected = volume;
    return;
  }
  if (Date.now() < lockUntil) return;
  if (sameVolume(volume, expected)) return;
  pending = volume;
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = setTimeout(flushPageVolume, SEND_DELAY_MS);
}

// Host -> YouTube: MPRIS changed externally (volume keys, mixer, another tool).
function onHostVolume(volume) {
  const v = normalizeVolume(volume);
  if (v === null) return;
  expected = v;
  lockUntil = Date.now() + APPLY_LOCK_MS;
  if (sendTimer) {
    clearTimeout(sendTimer);
    sendTimer = null;
    pending = null;
  }
  ensureBridge();
  window.dispatchEvent(new CustomEvent(VOLUME_EVENT, { detail: v }));
}

api.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'mpris-volume') return;
  const volume = normalizeVolume(message.volume);
  if (volume !== null) {
    onHostVolume(volume);
    return;
  }
  // Legacy push from an older background/host.
  const millis = Math.trunc(Number(message.millis));
  if (!Number.isFinite(millis) || millis < 0 || millis > 1000) return;
  onHostVolume(millis / 1000);
});

// Tell the background which tab should receive MPRIS updates.
try {
  const registered = api.runtime.sendMessage({ type: 'register' });
  if (registered && typeof registered.catch === 'function') registered.catch(() => {});
} catch (e) {
  // Background not ready; the observer below still attaches the page hook.
}

new MutationObserver(() => {
  const vids = document.querySelectorAll('video:not([data-ext-fixed])');
  for (let vid of vids) {
    vid.dataset.extFixed = "1";
    vid.addEventListener('loadeddata', () => vid.currentTime = vid.currentTime);
    // This is a firefox patch; firefox does not track seeked playback change
    // That means the MPRIS position will continue counting even when paused
    // play will forecably align the position when Playback state play occurs
    vid.addEventListener('play', () => vid.currentTime = vid.currentTime);
  }
  // Attach the YouTube volume hook even before any MPRIS event arrives.
  ensureBridge();
}).observe(document.documentElement, { childList: true, subtree: true });

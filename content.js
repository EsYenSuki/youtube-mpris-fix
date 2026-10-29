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

let bridgeInjected = false;
let adopted = false;
let expected = null; // millis last applied from the host or sent to it
let lockUntil = 0;
let sendTimer = null;
let pending = null;

// Volume (0..1) as thousandths, cutting the noisy decimals.
// The epsilon compensates for binary float error (0.29 * 1000 = 289.999...).
function volumeToMillis(volume) {
  const v = Number(volume);
  if (!Number.isFinite(v)) return null;
  return Math.trunc(Math.min(1, Math.max(0, v)) * 1000 + 1e-6);
}

// YouTube reports volume as percent (0..100), possibly with decimals (52.6).
function percentToMillis(percent) {
  const p = Number(percent);
  if (!Number.isFinite(p)) return null;
  return volumeToMillis(p / 100);
}

// Runs in the page's JS world, where movie_player is reachable.
function pageVolumeBridge() {
  const REPORT = 'ytmpris-volume-report';
  // The logical slider volume. Do not read the media element: YouTube applies
  // loudness normalization to it, so a 5% slider can make video.volume 0.026.
  function readPercent(player) {
    if (player && typeof player.getVolume === 'function') {
      const v = Number(player.getVolume());
      if (Number.isFinite(v)) return v;
    }
    const panel = document.querySelector('.ytp-volume-panel[aria-valuenow]');
    if (!panel || typeof panel.getAttribute !== 'function') return null;
    const v = parseFloat(panel.getAttribute('aria-valuenow'));
    return Number.isFinite(v) ? v : null;
  }
  function report(player) {
    const v = readPercent(player);
    if (v !== null) window.dispatchEvent(new CustomEvent(REPORT, { detail: v }));
  }
  window.addEventListener('ytmpris-set-volume', (e) => {
    const player = document.getElementById('movie_player');
    if (!player || typeof player.setVolume !== 'function') return;
    const millis = Math.min(1000, Math.max(0, Math.round(Number(e.detail))));
    // setVolume takes percent, so 0.526 becomes 52.6 and keeps its 3 decimals.
    const percent = millis / 10;
    if (typeof player.getVolume === 'function') {
      const current = Math.round(Number(player.getVolume()) * 10);
      if (Math.abs(current - millis) <= 1) return;
    }
    player.setVolume(percent);
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

function sendToHost(millis) {
  try {
    const sent = api.runtime.sendMessage({ type: 'volume', millis });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch (e) {
    // Background page not ready yet; the next change will retry.
  }
}

function flushPageVolume() {
  sendTimer = null;
  const millis = pending;
  pending = null;
  if (millis === null) return;
  // The value may have been applied from MPRIS while the timer was pending.
  if (Date.now() < lockUntil) return;
  if (expected !== null && Math.abs(millis - expected) <= 1) return;
  expected = millis;
  sendToHost(millis);
}

// YouTube -> host: the page volume changed for a reason we did not cause.
function onPageVolume(percent) {
  const millis = percentToMillis(percent);
  if (millis === null) return;
  // First value on this page belongs to the site; adopt it without writing.
  if (!adopted) {
    adopted = true;
    expected = millis;
    return;
  }
  if (Date.now() < lockUntil) return;
  if (expected !== null && Math.abs(millis - expected) <= 1) return;
  pending = millis;
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = setTimeout(flushPageVolume, SEND_DELAY_MS);
}

// Host -> YouTube: MPRIS changed externally (volume keys, mixer, another tool).
function onHostVolume(millis) {
  expected = millis;
  lockUntil = Date.now() + APPLY_LOCK_MS;
  if (sendTimer) {
    clearTimeout(sendTimer);
    sendTimer = null;
    pending = null;
  }
  ensureBridge();
  window.dispatchEvent(new CustomEvent(VOLUME_EVENT, { detail: millis }));
}

api.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'mpris-volume') return;
  const millis = Math.trunc(Number(message.millis));
  if (!Number.isFinite(millis) || millis < 0 || millis > 1000) return;
  onHostVolume(millis);
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

// Two-way volume sync between YouTube's slider and MPRIS.
// MPRIS -> YouTube: a long-float <video>.volume (e.g. 0.526461) sets the slider.
// YouTube -> MPRIS: the slider's integer percent goes to the native host as 0.xx.
// Echo guard: a value with at most 3 decimals is never applied from MPRIS, and
// the last percent in either direction is remembered so it is not sent back.
const VOLUME_EVENT = 'ytmpris-set-volume';
const REPORT_EVENT = 'ytmpris-volume-report';
const api = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
let bridgeInjected = false;
let lastPercent = null;

// Runs in the page's JS world, where movie_player is reachable.
function pageVolumeBridge() {
  const REPORT = 'ytmpris-volume-report';
  window.addEventListener('ytmpris-set-volume', (e) => {
    const player = document.getElementById('movie_player');
    if (!player || typeof player.setVolume !== 'function') return;
    const v = Math.min(100, Math.max(0, Math.round(Number(e.detail))));
    if (typeof player.getVolume === 'function' && player.getVolume() === v) return;
    player.setVolume(v);
  });
  function hook() {
    const player = document.getElementById('movie_player');
    if (!player || player.__ytmprisHooked || typeof player.addEventListener !== 'function') return;
    player.__ytmprisHooked = true;
    player.addEventListener('onVolumeChange', (data) => {
      const v = data && typeof data.volume === 'number'
        ? data.volume
        : (typeof player.getVolume === 'function' ? player.getVolume() : null);
      if (v !== null) window.dispatchEvent(new CustomEvent(REPORT, { detail: v }));
    });
  }
  window.addEventListener('ytmpris-attach', hook);
  hook();
}

function ensureBridge() {
  if (!bridgeInjected) {
    bridgeInjected = true;
    window.addEventListener(REPORT_EVENT, (e) => onYouTubeVolume(e.detail));
    const script = document.createElement('script');
    script.textContent = '(' + pageVolumeBridge.toString() + ')();';
    document.documentElement.appendChild(script);
    script.remove();
  }
  window.dispatchEvent(new CustomEvent('ytmpris-attach'));
}

function onYouTubeVolume(percent) {
  const v = Math.min(100, Math.max(0, Math.round(Number(percent))));
  if (v === lastPercent) return;
  lastPercent = v;
  api.runtime.sendMessage({ type: 'volume', percent: v });
}

// YouTube -> MPRIS: send the integer percent to the background, unless it is unchanged.
function reportInitialVolume(video) {
  if (!video) return;
  const v = Math.min(100, Math.max(0, Math.round(video.volume * 100)));
  if (v !== lastPercent) {
    onYouTubeVolume(v);
  }
}

// True when the value has at most 3 decimal places (e.g. 0.5, 0.52, 0.526).
function hasAtMostThreeDecimals(v) {
  const m = v * 1000;
  return Math.abs(m - Math.round(m)) < 1e-6;
}

function onExternalVolume(vid) {
  if (hasAtMostThreeDecimals(vid.volume)) return;
  // Long MPRIS float: round to YouTube's integer percent (0..100).
  const percent = Math.min(100, Math.max(0, Math.round(vid.volume * 100)));
  if (percent === lastPercent) return;
  lastPercent = percent;
  ensureBridge();
  window.dispatchEvent(new CustomEvent(VOLUME_EVENT, { detail: percent }));
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
    vid.addEventListener('volumechange', () => onExternalVolume(vid));
    // Report volume once the video has loaded enough data.
    vid.addEventListener('loadedmetadata', () => reportInitialVolume(vid));
  }
  // Attach the YouTube -> MPRIS hook even before any MPRIS volume event arrives.
  ensureBridge();
}).observe(document.documentElement, { childList: true, subtree: true });

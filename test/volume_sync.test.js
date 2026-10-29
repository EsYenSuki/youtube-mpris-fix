// Simulates content.js + background.js against a fake page and a fake native
// host. Proves the host-push/page-send split cannot echo, and that a real page
// change is still forwarded after its debounce.
// Run with: node test/volume_sync.test.js   (or: make test)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

// --- fake clock -------------------------------------------------------------
let now = 1000;
const timers = new Map();
let nextTimer = 1;
function fakeSetTimeout(fn, ms) {
  const id = nextTimer++;
  timers.set(id, { at: now + (ms || 0), fn });
  return id;
}
function fakeClearTimeout(id) { timers.delete(id); }
function advance(ms) {
  const end = now + ms;
  for (;;) {
    let best = null;
    for (const [id, timer] of timers) {
      if (timer.at <= end && (!best || timer.at < best.timer.at)) best = { id, timer };
    }
    if (!best) break;
    timers.delete(best.id);
    now = best.timer.at;
    best.timer.fn();
  }
  now = end;
}

const FakeDate = { now: () => now };

// --- fake page --------------------------------------------------------------
const listeners = {};
const applied = [];        // ytmpris-set-volume values the page would apply
const pageWindow = {
  addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
  dispatchEvent: (event) => {
    if (event.type === 'ytmpris-set-volume') applied.push(event.detail);
    (listeners[event.type] || []).forEach((fn) => fn(event));
  },
};
class FakeCustomEvent {
  constructor(type, init) { this.type = type; this.detail = init && init.detail; }
}
// The player's logical slider volume differs from the normalized media element
// volume; the bridge must report the former.
const fakePlayer = {
  volume: 100,
  elementVolume: 0.5,
  listeners: {},
  getVolume() { return this.volume; },
  setVolume(percent) {
    this.volume = percent;
    (this.listeners.onVolumeChange || []).forEach((fn) => fn({ volume: this.elementVolume }));
  },
  addEventListener(name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
  },
};
function emitPlayerVolumeChange() {
  (fakePlayer.listeners.onVolumeChange || []).forEach((fn) => fn({ volume: fakePlayer.elementVolume }));
}
const fakePanel = {
  getAttribute: (name) => name === 'aria-valuenow' ? String(fakePlayer.volume) : null,
};
const fakeVideo = {
  dataset: {},
  currentTime: 0,
  volume: 0.026,
  listeners: {},
  addEventListener(name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
  },
};
function emitVideoEvent(name) {
  (fakeVideo.listeners[name] || []).forEach((fn) => fn());
}
const pageDocument = {
  documentElement: {
    appendChild(script) {
      if (script && script.textContent) vm.runInContext(script.textContent, pageSandbox);
    },
  },
  querySelectorAll: (selector) => selector === 'video:not([data-ext-fixed])' &&
    !fakeVideo.dataset.extFixed ? [fakeVideo] : [],
  querySelector: (selector) => selector === '.ytp-volume-panel[aria-valuenow]' ? fakePanel : null,
  createElement: () => ({ textContent: '', remove() {} }),
  getElementById: (id) => id === 'movie_player' ? fakePlayer : null,
};
class FakeMutationObserver {
  constructor(cb) { this.cb = cb; }
  observe() { this.cb(); }
}

// The page-world side of the injected bridge (content.js stringifies it).
const pageSandbox = {
  console, Math, Number, parseFloat, CustomEvent: FakeCustomEvent,
  document: pageDocument,
  window: pageWindow,
};
pageSandbox.globalThis = pageSandbox;
vm.createContext(pageSandbox);

// --- fake runtime wiring ----------------------------------------------------
const contentMessages = [];   // content -> background
const hostMessages = [];      // background -> native host
const pageMessages = [];      // background -> content
let contentListener = null;

const contentRuntime = {
  sendMessage: (message) => { contentMessages.push(message); return Promise.resolve(); },
  onMessage: { addListener: (fn) => { contentListener = fn; } },
};

const hostPort = {
  posted: hostMessages,
  push: null,
  onMessage: { addListener: (fn) => { hostPort.push = fn; } },
  onDisconnect: { addListener: () => {} },
  postMessage: (message) => { hostMessages.push(message); },
};
const backgroundRuntime = {
  connectNative: () => hostPort,
  onMessage: { addListener: (fn) => { backgroundRuntime.listener = fn; } },
  lastError: undefined,
};
const backgroundTabs = {
  sendMessage: (tabId, message) => { pageMessages.push({ tabId, message }); return Promise.resolve(); },
};

// --- load content.js and background.js -------------------------------------
const contentSandbox = {
  console, Math, Number, Promise,
  Date: FakeDate,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  CustomEvent: FakeCustomEvent,
  MutationObserver: FakeMutationObserver,
  document: pageDocument,
  window: pageWindow,
  browser: { runtime: contentRuntime },
};
contentSandbox.globalThis = contentSandbox;
vm.createContext(contentSandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'), contentSandbox);

const backgroundSandbox = {
  console, Math, Number, Promise, Set, Date: FakeDate,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  browser: { runtime: backgroundRuntime, tabs: backgroundTabs },
};
backgroundSandbox.globalThis = backgroundSandbox;
vm.createContext(backgroundSandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), backgroundSandbox);

// Deliver everything the content script sent through the background listener.
function deliverContentMessages() {
  while (contentMessages.length) {
    const message = contentMessages.shift();
    backgroundRuntime.listener(message, { tab: { id: 1 } });
  }
}
// Deliver host pushes from background to the content script.
function deliverHostPushes() {
  while (pageMessages.length) {
    const { message } = pageMessages.shift();
    contentListener(message);
  }
}
// The page reports its volume as percent.
function pageReports(percent) {
  pageWindow.dispatchEvent(new FakeCustomEvent('ytmpris-volume-report', { detail: percent }));
}
function hostChanges(millis) {
  hostPort.push({ type: 'volume', millis });
  deliverHostPushes();
}
function settle() {
  advance(150);
  deliverContentMessages();
}
function sentSets() {
  return hostMessages.filter((m) => m.type === 'set').map((m) => m.millis);
}

let failures = 0;
function check(name, ok) {
  console.log(ok ? 'PASS' : 'FAIL', name);
  if (!ok) failures++;
}

// --- checks -----------------------------------------------------------------
const trunc = contentSandbox.volumeToMillis;
check('0.526461 -> 526', trunc(0.526461) === 526);
check('0.123999 -> 123', trunc(0.123999) === 123);
check('0.29 -> 290 despite float error', trunc(0.29) === 290);
check('1 -> 1000', trunc(1) === 1000);
check('52.6 percent -> 526', contentSandbox.percentToMillis(52.6) === 526);

// Background registered this tab and eagerly connected to the host.
deliverContentMessages();
check('content registers its tab', contentMessages.length === 0);
check('host port exists without a message', hostPort.posted.length === 0);

// Page load: the bridge reports the logical slider volume. The site's own
// starting volume is adopted, never written.
check('the page bridge is injected and hooked',
  (fakePlayer.listeners.onVolumeChange || []).length === 1);
emitPlayerVolumeChange();     // slider 100, normalized element volume 0.5
check('startup volume is not written to MPRIS', sentSets().length === 0);

// At a 5% slider YouTube normalizes the media element to 0.026. MPRIS must get
// the slider value (0.050), not the element value (0.026).
fakePlayer.volume = 5;
fakePlayer.elementVolume = 0.026;
emitPlayerVolumeChange();
advance(100);
check('a 5% slider change is debounced', sentSets().length === 0);
settle();
check('a 5% slider writes 50 millis, not the normalized 26',
  sentSets().length === 1 && sentSets()[0] === 50);

// Repeats and Stable Volume's element-only changes are not new user changes.
emitPlayerVolumeChange();
settle();
check('repeat of the same logical volume is ignored', sentSets().length === 1);
fakePlayer.elementVolume = 0.4;
emitPlayerVolumeChange();
settle();
check('a media-element-only volume change sends nothing', sentSets().length === 1);

// The <video> element's own volumechange must not be listened to either.
emitVideoEvent('volumechange');
settle();
check('a <video> volumechange is not forwarded', sentSets().length === 1);

// User drags the slider to 53%. It is debounced into one write.
fakePlayer.volume = 53;
fakePlayer.elementVolume = 0.53;
emitPlayerVolumeChange();
advance(100);
check('a slider change is debounced', sentSets().length === 1);
settle();
check('the slider change is written once as 530',
  sentSets().length === 2 && sentSets()[1] === 530);

// The same page event repeated (the browser applying it) is not a new change.
emitPlayerVolumeChange();
settle();
check('repeat of the same page value is ignored', sentSets().length === 2);

// External MPRIS change: host pushes 412, page applies it, never echoes it.
hostChanges(412);
check('host value is applied to the page', applied[applied.length - 1] === 412);
check('host value is not written back to MPRIS', sentSets().length === 2);
settle();                     // the page's onVolumeChange report arrives later
check('applying a host value does not echo back', sentSets().length === 2);
advance(500);                 // after the apply lock
pageReports(41.2);
settle();
check('a late report of the expected value is still ignored', sentSets().length === 2);

// A genuine page change after that is forwarded.
pageReports(60);
settle();
check('a real page change is forwarded', sentSets().length === 3 && sentSets()[2] === 600);

// A host push cancels a page change that has not been flushed yet.
pageReports(70);
advance(50);
hostChanges(300);
settle();
check('a pending page change is dropped when MPRIS moves',
  sentSets().length === 3 && applied[applied.length - 1] === 300);

// Background ignores malformed host pushes instead of forwarding them.
const before = pageMessages.length;
hostPort.push({ type: 'volume', millis: 1001 });
hostPort.push({ type: 'volume', millis: 'x' });
hostPort.push({ type: 'nope' });
check('invalid host pushes are dropped', pageMessages.length === before);

// If getVolume() is unavailable, use the slider's aria-valuenow.
advance(500);                 // let the previous host push release the apply lock
fakePlayer.getVolume = undefined;
fakePlayer.volume = 25;
emitPlayerVolumeChange();
settle();
check('aria-valuenow fallback is used',
  sentSets().length === 4 && sentSets()[3] === 250);

console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed');
process.exit(failures ? 1 : 0);

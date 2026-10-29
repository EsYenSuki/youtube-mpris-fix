// Relays volume between the YouTube content scripts and the native MPRIS host.
//
// The native host owns the MPRIS side: it polls MPRIS and pushes only changes it
// did not cause. So a "volume" push received here is always an external change,
// and a message from a content script is always a page-side change to write.
// Content scripts cannot call runtime.connectNative, so the port lives here.
const api = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
const HOST = 'mpris_volume_host';
const RECONNECT_MS = 3000;
let port = null;
let reconnectTimer = null;
const tabs = new Set();

function validVolume(value) {
  if (value === null || value === undefined || value === '') return null;
  const volume = Number(value);
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) return null;
  return volume;
}

function validMillis(value) {
  if (value === null || value === undefined || value === '') return null;
  const millis = Math.trunc(Number(value));
  if (!Number.isFinite(millis) || millis < 0 || millis > 1000) return null;
  return millis;
}

// Prefer the exact volume; fall back to the legacy millis field.
function volumeFrom(message) {
  if (!message) return null;
  const volume = validVolume(message.volume);
  if (volume !== null) return volume;
  const millis = validMillis(message.millis);
  return millis === null ? null : millis / 1000;
}

function sendToTabs(message) {
  for (const tabId of tabs) {
    try {
      const sent = api.tabs.sendMessage(tabId, message);
      if (sent && typeof sent.catch === 'function') sent.catch(() => tabs.delete(tabId));
    } catch (e) {
      tabs.delete(tabId);
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function connect() {
  if (port) return port;
  try {
    port = api.runtime.connectNative(HOST);
  } catch (e) {
    port = null;
    scheduleReconnect();
    return null;
  }
  port.onMessage.addListener((message) => {
    if (!message || message.type !== 'volume') return;
    const volume = volumeFrom(message);
    if (volume === null) return;
    sendToTabs({
      type: 'mpris-volume',
      volume,
      // Legacy field for an older content script.
      millis: Math.round(volume * 1000),
    });
  });
  port.onDisconnect.addListener(() => {
    port = null;
    void api.runtime.lastError;
    scheduleReconnect();
  });
  return port;
}

function postVolume(volume) {
  const active = connect();
  if (!active) return;
  try {
    active.postMessage({
      type: 'set',
      volume,
      // Legacy field for an older native host.
      millis: Math.round(volume * 1000),
    });
  } catch (e) {
    port = null;
    scheduleReconnect();
  }
}

api.runtime.onMessage.addListener((message, sender) => {
  if (!message) return;
  if (message.type === 'register') {
    if (sender && sender.tab && sender.tab.id != null) tabs.add(sender.tab.id);
    connect();
    return;
  }
  if (message.type === 'volume') {
    const volume = volumeFrom(message);
    if (volume !== null) postVolume(volume);
  }
});

// Start the host eagerly so its MPRIS watcher is running before the first change.
connect();

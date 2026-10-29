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

function validMillis(value) {
  const millis = Math.trunc(Number(value));
  if (!Number.isFinite(millis) || millis < 0 || millis > 1000) return null;
  return millis;
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
    const millis = validMillis(message.millis);
    if (millis === null) return;
    sendToTabs({ type: 'mpris-volume', millis });
  });
  port.onDisconnect.addListener(() => {
    port = null;
    void api.runtime.lastError;
    scheduleReconnect();
  });
  return port;
}

function postVolume(millis) {
  const active = connect();
  if (!active) return;
  try {
    active.postMessage({ type: 'set', millis });
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
    const millis = validMillis(message.millis);
    if (millis !== null) postVolume(millis);
  }
});

// Start the host eagerly so its MPRIS watcher is running before the first change.
connect();

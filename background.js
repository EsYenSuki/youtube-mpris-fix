// Relays the YouTube slider value from content.js to the native MPRIS host.
// Content scripts cannot call runtime.connectNative, so this background script owns the port.
const api = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
const HOST = 'mpris_volume_host';
let port = null;

function getPort() {
  if (!port) {
    port = api.runtime.connectNative(HOST);
    port.onDisconnect.addListener(() => { port = null; });
  }
  return port;
}

api.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'volume') return;
  try {
    getPort().postMessage({ volume: message.percent });
  } catch (e) {
    port = null;
  }
});

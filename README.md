# ![icon32](icons/icon32.png) YouTube MPRIS Fix

A browser fix addressing MPRIS metadata bugs on YouTube and YouTube Music

Tested on:

- Google Chrome
- Chromium
- Brave
- Vivaldi
- Microsoft Edge
- Opera
- Firefox
- Librewolf
- Zen

---

## The Problem

YouTube is a Single-Page Application (SPA) that loads new videos dynamically without a full page refresh. Because of this, MPRIS often does not detect video changes and metadata updates. This also fixes firefox based browser position incrementing when paused.

## Our Solution's Approach

*Seeking updates MPRIS.*

On first frame loaded or PlaybackState 'play' we forcibly seek to the current position.

---

## Installation:

### 1. Native Messaging Host (Required for Firefox/Zen)

Since this extension uses native messaging to communicate with your system, you must install the host component:

1.  Ensure you have `make` and `gcc` installed.
2.  Clone this repository.
3.  Run the installation script:
    ```bash
    chmod +x install.sh
    ./install.sh
    ```
4.  **Restart your browser** for the changes to take effect.

---

### 2. Browser Extension

#### Firefox / Zen / Librewolf
1.  Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2.  Click **"Load Temporary Add-on..."**.
3.  Select the `manifest.json` file from this repository.
    *   *Note: For permanent installation, please download from the [Firefox Add-Ons store](https://addons.mozilla.org/en-US/firefox/addon/youtube-mpris).*

#### Chromium (Chrome, Brave, Edge, etc.)
1.  Open browser and go to `chrome://extensions` (or `yourbrowser://extensions`).
2.  Toggle **"Developer mode"** on.
3.  Click **"Load unpacked"**.
4.  Select the extension directory (the folder that contains `manifest.json`).
5.  The extension should appear in the extensions list; reload the extension if you make alterations.


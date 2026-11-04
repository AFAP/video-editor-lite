# 轻剪 · Lite Video Editor

<div align="center">
  <a href="README.md">中文</a> · <b>English</b>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **Ultra-lightweight. Open it in your browser and start editing.**
> One HTML file, zero dependencies, no installation. Edit and export without FFmpeg, or connect local FFmpeg for faster exports.

## 1. Get started

**Just open it:** Download the project and open `index.html` in your browser. Import your media and start editing. No Node.js, FFmpeg, or internet connection is required; local editing and built-in assets work offline.

Browser export records in real time and requires keeping the page in the foreground. The output format depends on browser support and may be WebM.

**For faster exports:** Install Node.js 18+, FFmpeg, and ffprobe, add them to your `PATH`, then run this in the project directory:

```sh
npm start
```

Open [http://127.0.0.1:8787/](http://127.0.0.1:8787/) to export through the local FFmpeg bridge. No npm dependencies need to be installed. On Windows, you can also double-click `启动视频工具.bat`.

## 2. Features

- **Multitrack editing:** Import video, images, and audio; freely add visual, audio, and text tracks.
- **Everyday tools:** Split, trim, duplicate, snap, adjust volume and fades, undo, and redo.
- **Visual controls:** Scale, position, opacity, canvas presets, and timeline transitions with previews.
- **Text and stickers:** 30 editable text styles and 112 built-in transparent stickers.
- **Captions and speech:** SRT import/export, Bailian speech recognition, automatic captions, TTS, and text editing.
- **Project saving:** Save projects, recover drafts, and relink original media when reopening.

AI features require the bridge and your own Bailian endpoints, models, and key, entered in the UI. They send the relevant audio or text to the provider and may incur usage charges.

## 3. Screenshots

Editor and multitrack timeline:

![Editor overview](screenshot/editor.jpg)

Text style presets:

![Text style library](screenshot/text-styles.jpg)

Transparent stickers:

![Sticker library](screenshot/stickers.jpg)

## 4. More information

[Usage guide (Chinese)](docs/usage.md) · [Sticker assets (Chinese)](assets/stickers/README.md) · [Privacy and security](SECURITY.md)

[MIT](LICENSE) © 2026 AFAP and contributors

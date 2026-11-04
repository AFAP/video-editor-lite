# 安全说明 / Security

- 桥接服务仅监听 `127.0.0.1`。请勿通过代理、端口转发或隧道公开服务。
- The bridge listens on `127.0.0.1` only. Do not expose it through a proxy, port forwarding, or a tunnel.
- 本地剪辑和 FFmpeg 导出不上传云端。启用 AI 识别、配音或文字处理时，相关音频或文字会发送到你配置的服务商。
- Editing and FFmpeg export are local. AI recognition, speech synthesis, and text processing send the selected audio or text to your configured provider.
- Key 仅保留在桥接进程内存中，也可通过环境变量传入；不写入工程、草稿或前端存储。更换接口域名需重新输入 Key。
- API keys stay in bridge process memory and may be supplied through environment variables. They are not stored in projects, drafts, or browser storage. A domain change requires re-entering the key.
- 上传的素材、配音和导出文件会写入系统临时目录 `video-tool-bridge/`，进程结束不保证立即清空；在共享设备上使用后请自行清理。
- Uploaded media, generated speech, and exported files are written to the system temporary directory `video-tool-bridge/`. Process exit does not guarantee immediate deletion; clean up after using a shared device.
- 工程和草稿可能含文件名、字幕、图片等内容，分享前请检查。仅使用你信任的 AI 接口地址。
- Projects and drafts may include filenames, captions, and images. Review them before sharing and use only trusted AI endpoints.

报告漏洞时请先联系仓库维护者。公开 Issue 中不要附带 Key、私有媒体、完整本机路径或其他敏感信息。

Contact the repository maintainer before disclosing a vulnerability. Do not post keys, private media, full local paths, or other sensitive information in public issues.

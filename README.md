# 轻剪 · Lite Video Editor

<div align="center">
  <b>中文</b> · <a href="README.en.md">English</a>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **轻量本地视频编辑器，支持多轨剪辑、AI 字幕与配音。**
> 单页前端，零 npm 依赖，通过桥接器调用本机 FFmpeg 导出。

## 1. 它解决了什么问题

在浏览器里完成日常剪辑，用本机 FFmpeg 合成成片；需要时再连接百炼处理语音和文字。

```text
浏览器 index.html → 本机 Node.js 桥接器 → FFmpeg → 视频文件
                                      └→ 百炼 → 字幕 / 配音
```

## 2. 功能特性

- ✅ 导入视频、图片、音频，动态添加画面、音频和文字轨道。
- ✅ 分割、裁剪、复制、吸附、音量与淡入淡出，支持撤销和重做。
- ✅ 画面缩放、位置、不透明度，以及横屏、竖屏、方形画幅。
- ✅ 可插入时间线、调整时长并预览的转场。
- ✅ 30 套可编辑花字、112 张透明贴纸。
- ✅ 百炼语音识别、自动字幕、TTS 配音和 DeepSeek 文字润色。
- ✅ SRT 导入导出、工程保存、草稿恢复、本机 FFmpeg 导出。

### 效果预览

编辑器与动态多轨时间线：

![编辑器主界面](screenshot/editor.jpg)

花字预设：

![花字素材库](screenshot/text-styles.jpg)

透明贴纸：

![贴纸素材库](screenshot/stickers.jpg)

## 3. 目录结构

```text
index.html            # 独立单页编辑器，内嵌贴纸图集
ffmpeg-bridge.mjs     # 本机 HTTP 服务和 FFmpeg 任务
timeline-render.mjs   # 多轨画面、转场与混音
speech-service.mjs    # 百炼语音和文字接口
启动视频工具.bat      # Windows 启动入口
assets/stickers/      # 贴纸切片、源图和生成提示词
screenshot/           # 功能截图
docs/                 # 详细使用指南
scripts/              # 素材生成脚本，运行编辑器时不需要
test/                 # 回归与集成测试
```

## 4. 快速开始

```sh
npm start
```

先下载或克隆仓库，在项目根目录执行上面的命令，打开 [http://127.0.0.1:8787/](http://127.0.0.1:8787/)。无需运行 `npm install`。

需要 Node.js 18+、FFmpeg 和 ffprobe，并将它们加入 `PATH`。Windows 也可双击 `启动视频工具.bat`。

也可直接打开 `index.html`，使用浏览器实时录制导出；**AI 功能需要从桥接器地址访问**。

## 5. 使用

1. 导入视频、图片或音频，按需添加轨道。
2. 在时间线上裁剪、分割和移动片段，加入文字、贴纸或转场。
3. 需要自动字幕或配音时，打开「AI 语音 → 百炼设置」，填写自己的接口地址、模型和 Key。
4. 保存工程，再点击「导出视频」。桥接器可用时使用本机 FFmpeg。

工程不打包原始视频和音频，恢复时需要重新关联素材。修改或升级前请备份工程与原文件；更新后执行 `npm start` 验证。

## 6. API 速查

| 接口 | 用途 |
| --- | --- |
| `GET /ping` | 桥接器和 FFmpeg 状态 |
| `POST /upload?name=` / `POST /overlay` | 上传媒体 / PNG 图层 |
| `POST /render` | 创建视频导出任务 |
| `GET /job/:id` / `GET /download/:id` | 进度 / 下载 |
| `GET /speech/config` / `POST /speech/config` | 读取 / 更新 AI 配置 |
| `POST /speech/jobs` / `GET /speech/jobs/:id` | 创建 / 查询 AI 任务 |

```sh
curl http://127.0.0.1:8787/ping
```

成功响应包含 `{"ok":true,...}`；详细参数见[使用指南](docs/usage.md#桥接接口)。

## 7. 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 本机服务端口 |
| `FFMPEG_PATH` | 从 `PATH` 查找 | FFmpeg 文件或所在目录 |
| `FFPROBE_PATH` | FFmpeg 同目录或 `PATH` | ffprobe 文件路径 |
| `BAILIAN_API_KEY` / `DASHSCOPE_API_KEY` | 空 | AI Key，也可在界面填写 |

**仓库中的 AI 地址是占位符，必须替换为自己的百炼服务地址。** 模型和音色需在对应服务开通；预填模型名只是适配示例。真实云端鉴权和模型效果需要有效 Key 验证。

## 8. 日志与排错

| 现象 | 排查方向 |
| --- | --- |
| 未连接本机 FFmpeg | 检查启动终端日志、`PATH` 或 `FFMPEG_PATH` |
| 素材没有浏览器预览 | 检查浏览器是否支持该编码 |
| AI 调用失败 | 检查接口地址、Key、模型权限及时间戳支持 |
| 工程提示缺少素材 | 重新选择原始媒体文件关联 |

## 9. 安全与隐私

**桥接器仅监听 `127.0.0.1`，请勿暴露到公网。** 剪辑和成片导出在本机完成；启用 AI 时，相应音频或文字会发送到配置的服务商，并按账户用量计费。

Key 仅保留在桥接进程内存中，不写入工程或草稿。媒体和导出文件会写入系统临时目录。详情见 [SECURITY.md](SECURITY.md)。

## 10. FAQ

**需要联网吗？** 本地剪辑、内置素材和 FFmpeg 导出可离线使用；云端 AI 需要联网。

**没有 FFmpeg 能导出吗？** 可使用浏览器实时录制，需保持页面在前台；格式取决于浏览器，可能回落到 WebM。

**只有音频能导出吗？** 可以，当前导出为带黑色画面的视频文件。

## 11. 开发与验证

前端为原生 HTML / CSS / JavaScript，桥接器只使用 Node.js 内置模块。无需编译或打包，因此不配置构建发布工作流。

```sh
npm test
npm run test:bridge
npm run test:speech
npm run test:transitions
```

集成测试需要本机 FFmpeg，使用生成素材和模拟 AI 服务，不调用真实百炼 API。可选素材脚本的依赖见 `scripts/requirements.txt`。

## 12. 相关文档

- [详细使用指南](docs/usage.md)
- [贴纸素材与重建](assets/stickers/README.md)
- [安全说明](SECURITY.md)

## 13. License

[MIT](LICENSE) © 2026 AFAP and contributors

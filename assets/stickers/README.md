# 112 张透明贴纸

总图集数据已内嵌在 `index.html` 中，网页运行无需读取本目录中的总图文件。独立的 PNG/WebP 总图副本已清理。

`sticker-atlas-112.json`：每张素材的编号、名称、分类、裁切坐标和独立 PNG 路径；其中 `image` 对应 ZIP 内的 4096×2048 PNG 总图集。七类各 16 张：日常灵感、表情互动、美食饮品、旅行出行、自然天气、工作学习、庆祝创作。

`png/` 提供 112 张独立图片。开发脚本生成 `sets/` 分类图集和 `stickers-112.zip` 素材包（含总图集、独立 PNG、分类图集、坐标和提示词）；这些生成产物不提交到仓库。

原先的 `sticker-atlas.json` 和 16 张切片保留；旧工程里的贴纸编号继续兼容。需要整张图时，可从编辑器面板或生成的 ZIP 素材包获取。

使用内置 image_gen 生成图集，再提取主体、保留透明边缘、统一留白。新增六组的完整提示词见 `generation-prompts-112.json`，重建用的原始生成图保存在 `sources/`。打包脚本在内存中生成 PNG/WebP 图集，直接写入 ZIP 和 HTML，不在目录中重复保存总图文件。

在项目根目录执行以下命令重建 112 张素材：

```sh
python -m pip install -r scripts/requirements.txt
python scripts/expand-sticker-library.py assets/stickers/generation-prompts-112.json
```

`build-sticker-atlas.py` 用于从原始 4×4 图集提取最初的 16 张；它会将页面切回 16 张素材。日常重建完整素材库请使用上面的 `expand-sticker-library.py`。

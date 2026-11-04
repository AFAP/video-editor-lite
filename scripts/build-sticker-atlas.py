"""Extract 16 sticker subjects, preserving alpha, and pack a portable atlas.

Development helper only; the editor itself has no Python/Pillow dependency.
Usage: python scripts/build-sticker-atlas.py source.png
"""
import argparse
import base64
import json
import re
from io import BytesIO
from collections import deque
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image, ImageChops, ImageFilter

NAMES = ['点赞', '爱心', '大笑', '惊讶', '火焰', '星星', '闪电', '奖杯', '向右箭头', '向左箭头', '对话气泡', '重点提醒', '咖啡', '相机', '庆祝', '火箭']
IDS = ['like', 'heart', 'laugh', 'wow', 'fire', 'stars', 'lightning', 'trophy', 'arrow-right', 'arrow-left', 'bubble', 'attention', 'coffee', 'camera', 'party', 'rocket']


def extract(cell):
    """Isolate the main subject and its colored accents from detached matte dust."""
    w, h = cell.size
    pixels = list(cell.getdata())
    seen = bytearray(w * h)
    components = []
    for start, pixel in enumerate(pixels):
        if seen[start] or pixel[3] < 32:
            continue
        queue = deque([start])
        seen[start] = 1
        members, colored = [], 0
        while queue:
            index = queue.popleft()
            members.append(index)
            r, g, b, alpha = pixels[index]
            colored += max(r, g, b) - min(r, g, b) > 22 and alpha > 100
            x, y = index % w, index // w
            neighbors = []
            if x: neighbors.append(index - 1)
            if x + 1 < w: neighbors.append(index + 1)
            if y: neighbors.append(index - w)
            if y + 1 < h: neighbors.append(index + w)
            for other in neighbors:
                if not seen[other] and pixels[other][3] >= 32:
                    seen[other] = 1
                    queue.append(other)
        components.append((members, colored))
    if not components:
        raise ValueError('Empty sticker cell')
    largest = max(components, key=lambda item: len(item[0]))
    mask_data = bytearray(w * h)
    for members, colored in components:
        # A neighboring sticker can protrude slightly across an atlas cell.
        # Discard detached fragments touching that boundary; retain the main
        # subject and inset colored accents such as stars and confetti.
        at_edge = any(index % w in (0, w-1) or index // w in (0, h-1) for index in members)
        if members is largest[0] or not at_edge and len(members) > 40 and colored > max(12, len(members) * .12):
            for index in members:
                mask_data[index] = 255
    mask = Image.frombytes('L', (w, h), bytes(mask_data)).filter(ImageFilter.MaxFilter(3))
    cell.putalpha(ImageChops.multiply(cell.getchannel('A'), mask))
    bounds = cell.getchannel('A').getbbox()
    if not bounds:
        raise ValueError('Sticker subject has no visible pixels')
    subject = cell.crop(bounds)
    subject.thumbnail((224, 224), Image.Resampling.LANCZOS)
    result = Image.new('RGBA', (256, 256))
    result.alpha_composite(subject, ((256 - subject.width) // 2, (256 - subject.height) // 2))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    dest = root / 'assets' / 'stickers'
    dest.mkdir(parents=True, exist_ok=True)
    source = Image.open(args.source).convert('RGBA')
    atlas = Image.new('RGBA', (1024, 1024))
    frames = []
    for i, name in enumerate(NAMES):
        x, y = i % 4, i // 4
        cell = source.crop((round(x * source.width / 4), round(y * source.height / 4), round((x + 1) * source.width / 4), round((y + 1) * source.height / 4)))
        sticker = extract(cell)
        sticker.save(dest / (IDS[i] + '.png'), optimize=True)
        atlas.alpha_composite(sticker, (x * 256, y * 256))
        frames.append(dict(id=IDS[i], name=name, x=x * 256, y=y * 256, w=256, h=256))
    png = BytesIO()
    atlas.save(png, format='PNG', optimize=True)
    webp = BytesIO()
    atlas.save(webp, format='WEBP', quality=90, method=6)
    manifest = dict(image='sticker-atlas.png', size=dict(w=1024, h=1024), frames=frames)
    (dest / 'sticker-atlas.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    html = root / 'index.html'
    content = html.read_text(encoding='utf-8')
    data = 'data:image/webp;base64,' + base64.b64encode(webp.getvalue()).decode('ascii')
    content, replacements = re.subn(r"const STICKER_ATLAS='[^']*';", lambda _: "const STICKER_ATLAS='" + data + "';", content)
    if replacements != 1:
        raise ValueError('Expected exactly one embedded atlas declaration')
    html.write_text(content, encoding='utf-8')
    with ZipFile(dest / 'stickers-16.zip', 'w', ZIP_DEFLATED) as archive:
        for asset_id in IDS:
            archive.write(dest / (asset_id + '.png'), asset_id + '.png')
        archive.writestr('sticker-atlas.png', png.getvalue())
        archive.write(dest / 'sticker-atlas.json', 'sticker-atlas.json')
    print(json.dumps(dict(count=len(frames), png=png.tell(), embedded=webp.tell())))


if __name__ == '__main__':
    main()

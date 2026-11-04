"""Pack the original stickers and six generated 4x4 sheets into 112 assets.

Development helper; not needed to run the editor. Input JSON contains groups
with id, name, source (PNG path), items ([id, Chinese name, prompt] rows).
"""
import argparse
import base64
import importlib.util
import json
import re
import shutil
from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('catalog', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    dest = root / 'assets' / 'stickers'
    config = json.loads(args.catalog.read_text(encoding='utf-8'))
    groups = config['groups']
    if len(groups) != 6 or any(len(group['items']) != 16 for group in groups):
        raise ValueError('Expected six complete groups of sixteen stickers')
    spec = importlib.util.spec_from_file_location('sticker_extract', Path(__file__).with_name('build-sticker-atlas.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in ['png', 'sets', 'sources']:
        (dest / name).mkdir(exist_ok=True)
    old = json.loads((dest / 'sticker-atlas.json').read_text(encoding='utf-8'))
    atlas = Image.new('RGBA', (4096, 2048))
    frames = []
    for item in old['frames']:
        image = Image.open(dest / (item['id'] + '.png')).convert('RGBA')
        atlas.alpha_composite(image, (item['x'], item['y']))
        image.save(dest / 'png' / (item['id'] + '.png'), optimize=True)
        frames.append({**item, 'category': 'daily', 'file': 'png/' + item['id'] + '.png'})
    categories = {'daily': '日常灵感'}
    for sheet_index, group in enumerate(groups, 1):
        source_path = Path(group['source'])
        if not source_path.is_absolute():
            source_path = args.catalog.resolve().parent / source_path
        stored_source = dest / 'sources' / (group['id'] + '-source.png')
        if source_path.resolve() != stored_source.resolve():
            shutil.copyfile(source_path, stored_source)
        source = Image.open(source_path).convert('RGBA')
        sheet = Image.new('RGBA', (1024, 1024))
        offset_x, offset_y = sheet_index % 4 * 1024, sheet_index // 4 * 1024
        for i, (short_id, name, prompt) in enumerate(group['items']):
            x, y = i % 4, i // 4
            cell = source.crop((round(x * source.width / 4), round(y * source.height / 4), round((x + 1) * source.width / 4), round((y + 1) * source.height / 4)))
            image = module.extract(cell)
            asset_id = group['id'] + '-' + short_id
            file = 'png/' + asset_id + '.png'
            image.save(dest / file, optimize=True)
            sheet.alpha_composite(image, (x * 256, y * 256))
            frames.append(dict(id=asset_id, name=name, category=group['id'], x=offset_x+x*256, y=offset_y+y*256, w=256, h=256, file=file))
        sheet.save(dest / 'sets' / (group['id'] + '.png'), optimize=True)
        atlas.alpha_composite(sheet, (offset_x, offset_y))
        categories[group['id']] = group['name']
    if len(frames) != 112 or len({item['id'] for item in frames}) != 112:
        raise ValueError('Sticker count or uniqueness is incorrect')
    # The editor embeds WebP bytes; the downloadable ZIP contains the PNG.
    # Keep these in memory instead of leaving duplicate atlas files on disk.
    png = BytesIO()
    atlas.save(png, format='PNG', optimize=True)
    webp = BytesIO()
    atlas.save(webp, format='WEBP', quality=90, method=6)
    manifest = dict(image='sticker-atlas-112.png', size=dict(w=4096, h=2048), categories=categories, frames=frames)
    (dest / 'sticker-atlas-112.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    # Save the exact generation prompts and portable source paths.
    portable = {**config, 'groups': [{**g, 'source': 'sources/' + g['id'] + '-source.png'} for g in groups]}
    (dest / 'generation-prompts-112.json').write_text(json.dumps(portable, ensure_ascii=False, indent=2), encoding='utf-8')
    html = root / 'index.html'
    content = html.read_text(encoding='utf-8')
    data = 'data:image/webp;base64,' + base64.b64encode(webp.getvalue()).decode('ascii')
    replacements = [
        (r'const STICKER_ATLAS_SIZE=\{[^;]+;', 'const STICKER_ATLAS_SIZE=' + json.dumps(manifest['size']) + ';'),
        (r'const STICKER_ASSETS=\[[^;]+;', 'const STICKER_ASSETS=' + json.dumps(frames, ensure_ascii=False, separators=(',', ':')) + ';'),
        (r"const STICKER_ATLAS='[^']*';", "const STICKER_ATLAS='" + data + "';"),
    ]
    for pattern, replacement in replacements:
        content, count = re.subn(pattern, lambda _, value=replacement: value, content)
        if count != 1:
            raise ValueError('Expected exactly one atlas declaration')
    html.write_text(content, encoding='utf-8')
    with ZipFile(dest / 'stickers-112.zip', 'w', ZIP_DEFLATED) as archive:
        for frame in frames:
            archive.write(dest / frame['file'], frame['file'])
        archive.writestr('sticker-atlas-112.png', png.getvalue())
        for name in ['sticker-atlas-112.json', 'generation-prompts-112.json', 'generation-prompts.json']:
            archive.write(dest / name, name)
        for group in groups:
            archive.write(dest / 'sets' / (group['id'] + '.png'), 'sets/' + group['id'] + '.png')
    print(json.dumps(dict(count=len(frames), categories=categories, embedded=webp.tell(), html=html.stat().st_size)))


if __name__ == '__main__':
    main()

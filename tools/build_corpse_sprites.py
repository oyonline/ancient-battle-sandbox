#!/usr/bin/env python3
"""
躺尸素材流水线：AI 原图（白底）→ 洪泛抠图 → 去噪点 → 宽度归一 156 → 蓝方换色 → assets/units + manifest。

红方是美术源头；蓝方仅把绯红队服像素换成蓝色（换色规则与 build_generated_sprites.py 一致）。
运行：python3 tools/build_corpse_sprites.py
"""
import colorsys
import json
import os
from collections import deque

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tools', 'ai_corpse')
DEST = os.path.join(ROOT, 'assets', 'units')
TARGET_W = 156
PAD = 6
SPECK_AREA = 1500          # 1920 分辨率下的杂点面积上限
TYPES = ['infantry', 'pikeman', 'archer', 'cavalry']


def flood_key(img, tol=55):
    """从边缘洪泛抠掉与角落背景色连通的像素（白底），主体内部高光不受影响。"""
    img = img.convert('RGBA')
    w, h = img.size
    px = img.load()
    cp = [img.getpixel((4, 4)), img.getpixel((w - 5, 4)),
          img.getpixel((4, h - 5)), img.getpixel((w - 5, h - 5))]
    br = sum(c[0] for c in cp) // 4
    bgc = sum(c[1] for c in cp) // 4
    bb = sum(c[2] for c in cp) // 4

    def is_bg(x, y):
        r, g, b = px[x, y][:3]
        return ((r - br) ** 2 + (g - bgc) ** 2 + (b - bb) ** 2) ** 0.5 < tol

    seen = [[False] * w for _ in range(h)]
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not seen[y][x] and is_bg(x, y):
                seen[y][x] = True; q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not seen[y][x] and is_bg(x, y):
                seen[y][x] = True; q.append((x, y))
    while q:
        x, y = q.popleft()
        px[x, y] = (0, 0, 0, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and is_bg(nx, ny):
                seen[ny][nx] = True
                q.append((nx, ny))
    return img


def drop_specks(img):
    """删掉孤立噪点连通域，保留主体与散落武器。"""
    px = img.load()
    w, h = img.size
    seen = [[False] * w for _ in range(h)]
    for sy in range(h):
        for sx in range(w):
            if seen[sy][sx] or px[sx, sy][3] <= 40:
                continue
            blob, q = [], deque([(sx, sy)])
            seen[sy][sx] = True
            while q:
                x, y = q.popleft()
                blob.append((x, y))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and px[nx, ny][3] > 40:
                        seen[ny][nx] = True
                        q.append((nx, ny))
            if len(blob) < SPECK_AREA:
                for x, y in blob:
                    px[x, y] = (0, 0, 0, 0)
    return img


def trim(img):
    px = img.load()
    xs, ys = [], []
    for y in range(img.height):
        for x in range(img.width):
            if px[x, y][3] > 40:
                xs.append(x); ys.append(y)
    if not xs:
        return None
    return img.crop((min(xs), min(ys), max(xs) + 1, max(ys) + 1))


def quantize(img, colors=32):
    alpha = img.split()[3]
    q = img.convert('RGB').quantize(colors=colors, method=Image.MEDIANCUT).convert('RGB')
    q.putalpha(alpha)
    return q


def recolor_blue(img):
    """绯红队服 → 蓝：规则与 build_generated_sprites.recolor_blue 一致。"""
    result = img.copy()
    pixels = result.load()
    for y in range(result.height):
        for x in range(result.width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            crimson = (h <= 0.07 or h >= 0.96) and s >= 0.38 and r >= 62
            if crimson:
                nr, ng, nb = colorsys.hsv_to_rgb(0.61, min(0.88, s * 0.92), v)
                pixels[x, y] = round(nr * 255), round(ng * 255), round(nb * 255), a
    return result


def process_one(src_path):
    img = flood_key(Image.open(src_path))
    img = drop_specks(img)
    trimmed = trim(img)
    if trimmed is None:
        raise RuntimeError(f'{src_path}: 抠图后为空')
    bw, bh = trimmed.size
    if bw / bh < 1.05:
        raise RuntimeError(f'{src_path}: 剪影长宽比 {bw / bh:.2f}，不是躺平构图')
    trimmed = quantize(trimmed)
    scale = TARGET_W / bw
    trimmed = trimmed.resize((TARGET_W, max(1, round(bh * scale))), Image.NEAREST)
    canvas = Image.new('RGBA', (trimmed.width + PAD * 2, trimmed.height + PAD * 2), (0, 0, 0, 0))
    canvas.paste(trimmed, (PAD, PAD))
    return canvas


def main():
    corpses = {}
    for utype in TYPES:
        src = os.path.join(SRC, f'red_{utype}.jpg')
        if not os.path.exists(src):
            src = src.replace('.jpg', '.png')
        base = process_one(src)
        for team in ('red', 'blue'):
            final = base if team == 'red' else recolor_blue(base)
            name = f'corpse_{team}_{utype}.png'
            final.save(os.path.join(DEST, name))
            corpses[f'corpse_{team}_{utype}'] = {
                'file': f'units/{name}', 'w': final.width, 'h': final.height
            }
            print(f'✅ {name}: {final.width}x{final.height}')

    mp = os.path.join(ROOT, 'assets', 'manifest.json')
    manifest = json.load(open(mp, encoding='utf-8'))
    manifest['corpses'] = corpses
    serialized = json.dumps(manifest, ensure_ascii=False, indent=2)
    open(mp, 'w', encoding='utf-8').write(serialized + '\n')
    open(os.path.join(ROOT, 'assets', 'manifest.js'), 'w', encoding='utf-8').write(
        '// 素材清单（由处理脚本生成；corpses 段由 build_corpse_sprites.py 维护）\n'
        'const MANIFEST = ' + serialized + ';\n')
    print('manifest 已更新（新增 corpses 段）')


if __name__ == '__main__':
    main()

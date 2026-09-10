#!/usr/bin/env python3
"""
AI 兵种贴图接入流水线
用法：
  python3 tools/process_ai_sprites.py --src tools/ai_raw --dest assets/units
  （默认 src=tools/ai_raw, dest=assets/units，质检不过的图会明确报错，不会写入）

输入文件命名（8 张，AI 生成，建议纯色背景、单角色、全身、等距 3/4 视角）：
  red_infantry.png / blue_infantry.png   剑士
  red_pikeman.png  / blue_pikeman.png    长枪兵
  red_archer.png   / blue_archer.png     弓箭手
  red_cavalry.png  / blue_cavalry.png    骑士（骑马）

流程：自动抠背景（四角取色+色距容差）→ 边缘收缩羽化 → 裁剪留边 →
      深色描边 → 尺寸归一 → 写入目标并更新 manifest
质检：尺寸下限、单一主体（连通域）、剪影长宽比、覆盖率
"""
import os, sys, json, argparse
from collections import deque
from PIL import Image, ImageFilter

GAME_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

UNIT_TYPES = ["infantry", "pikeman", "archer", "cavalry"]
TEAMS = ["red", "blue"]
# 剪影长宽比期望（w/h）：人形瘦高，骑兵带马偏宽
ASPECT_RANGE = {
    "infantry": (0.30, 1.10),
    "pikeman":  (0.25, 1.10),   # 长枪可能更瘦长
    "archer":   (0.30, 1.10),
    "cavalry":  (0.60, 1.60),
}

def corner_bg_color(img):
    """四角 + 边缘中点取色，返回出现最多的颜色（视为背景色）"""
    w, h = img.size
    px = img.load()
    pts = [(4, 4), (w - 5, 4), (4, h - 5), (w - 5, h - 5),
           (w // 2, 3), (3, h // 2), (w - 5, h // 2), (w // 2, h - 5)]
    cols = {}
    for x, y in pts:
        c = px[x, y][:3]
        cols[c] = cols.get(c, 0) + 1
    return max(cols.items(), key=lambda kv: kv[1])[0]

def chroma_key(img, bg, tol=90):
    """按与背景色的欧氏距离抠图，>tol 保留"""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    br, bgc, bb = bg
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            d = ((r - br) ** 2 + (g - bgc) ** 2 + (b - bb) ** 2) ** 0.5
            if d < tol:
                px[x, y] = (0, 0, 0, 0)
            elif d < tol * 1.4:
                # 过渡带：部分透明，抗锯齿
                px[x, y] = (r, g, b, int(a * (d - tol) / (tol * 0.4)))
    return img

def chroma_key_flood(img, bg, tol=60):
    """洪泛抠背景：只移除与图像边缘连通的背景色。
    全局色距抠图会把主体内部的近白高光（盔甲反光）也挖空，洪泛不会。"""
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    br, bgc, bb = bg

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

def quantize_keep_alpha(img, colors=32):
    """限定调色板（像素风收色），保留 alpha 通道"""
    alpha = img.split()[3]
    q = img.convert("RGB").quantize(colors=colors, method=Image.MEDIANCUT).convert("RGB")
    q.putalpha(alpha)
    return q

def largest_blob_ratio(img):
    """最大连通域占不透明像素比例（判断是否单一主体）"""
    px = img.load()
    w, h = img.size
    seen = [[False] * w for _ in range(h)]
    total = 0
    best = 0
    for sy in range(h):
        for sx in range(w):
            if seen[sy][sx] or px[sx, sy][3] <= 40:
                continue
            size = 0
            q = deque([(sx, sy)])
            seen[sy][sx] = True
            while q:
                x, y = q.popleft()
                size += 1
                for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and px[nx, ny][3] > 40:
                        seen[ny][nx] = True
                        q.append((nx, ny))
            total += size
            best = max(best, size)
    return best / total if total else 0

def trim(img):
    px = img.load()
    w, h = img.size
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > 40:
                xs.append(x); ys.append(y)
    if not xs:
        return None, None
    return img.crop((min(xs), min(ys), max(xs) + 1, max(ys) + 1)), (min(xs), min(ys), max(xs), max(ys))

def add_outline(img, radius=2, color=(40, 30, 20, 210)):
    a = img.split()[3]
    dilated = a.filter(ImageFilter.MaxFilter(radius * 2 + 1))
    diff = Image.new("L", img.size)
    dp, op, fp = dilated.load(), a.load(), diff.load()
    for y in range(img.height):
        for x in range(img.width):
            dv, ov = dp[x, y], op[x, y]
            fp[x, y] = max(0, dv - ov) if dv > ov else 0
    outline = Image.new("RGBA", img.size, color)
    outline.putalpha(diff)
    canvas = Image.new("RGBA", img.size, (0, 0, 0, 0))
    canvas.alpha_composite(outline)
    canvas.alpha_composite(img)
    return canvas

def process_one(src_path, dest_path, utype, pixel=False, target_h=220):
    img = Image.open(src_path).convert("RGBA")
    if img.width < 128 or img.height < 128:
        return False, f"尺寸过小 ({img.width}x{img.height})，至少 128px"

    if pixel and max(img.size) > 640:
        # 预缩小降低洪泛成本；后续还要收色+NEAREST，LANCZOS 的柔边会被抹平
        k = 640 / max(img.size)
        img = img.resize((int(img.width * k), int(img.height * k)), Image.LANCZOS)

    bg = corner_bg_color(img)
    if pixel:
        cut = chroma_key_flood(img, bg)
    else:
        cut = chroma_key(img, bg)
        cut = cut.filter(ImageFilter.MinFilter(3))      # 边缘收缩1px去杂边

    blob = largest_blob_ratio(cut)
    if blob < 0.72:
        return False, f"主体不完整或出现多主体（最大连通域 {blob*100:.0f}% < 72%）"

    trimmed, _ = trim(cut)
    if trimmed is None:
        return False, "抠图后为空：背景色判定可能失败"

    bw, bh = trimmed.size
    aspect = bw / bh
    lo, hi = ASPECT_RANGE[utype]
    if not (lo <= aspect <= hi):
        return False, f"剪影长宽比 {aspect:.2f} 超出 {utype} 预期 [{lo}, {hi}]（构图可能不对）"

    px = trimmed.load()
    opaque = sum(1 for y in range(bh) for x in range(bw) if px[x, y][3] > 40)
    cover = opaque / (bw * bh)
    if not (0.18 <= cover <= 0.80):
        return False, f"覆盖率 {cover*100:.0f}% 异常（可能半透明/构图破碎）"

    # 尺寸归一（像素风：先收色调色板，再 NEAREST 硬缩放保像素颗粒）
    if pixel:
        trimmed = quantize_keep_alpha(trimmed)
    scale = target_h / bh
    resample = Image.NEAREST if pixel else Image.LANCZOS
    trimmed = trimmed.resize((max(1, int(bw * scale)), target_h), resample)

    # 加描边（先留 pad；像素风用 1px 深色硬描边）
    pad = 3
    canvas = Image.new("RGBA", (trimmed.width + pad * 2, trimmed.height + pad * 2), (0, 0, 0, 0))
    canvas.paste(trimmed, (pad, pad))
    if pixel:
        final = add_outline(canvas, radius=1, color=(26, 22, 18, 255))
    else:
        final = add_outline(canvas)
    final.save(dest_path)
    return True, f"OK {final.width}x{final.height}（原 {bw}x{bh}, 长宽比 {aspect:.2f}, 覆盖 {cover*100:.0f}%）"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(GAME_ROOT, "tools/ai_raw"))
    ap.add_argument("--dest", default=os.path.join(GAME_ROOT, "assets/units"))
    ap.add_argument("--no-manifest", action="store_true")
    ap.add_argument("--pixel", action="store_true", help="像素风模式：洪泛抠图+收色+NEAREST 缩放+1px 硬描边")
    ap.add_argument("--target-h", type=int, default=220, help="归一化目标高度（像素）")
    args = ap.parse_args()

    os.makedirs(args.dest, exist_ok=True)
    ok_all = True
    results = {}
    for team in TEAMS:
        for utype in UNIT_TYPES:
            name = f"{team}_{utype}.png"
            src = os.path.join(args.src, name)
            if not os.path.exists(src):
                print(f"⚠️  缺少 {name}，跳过")
                ok_all = False
                continue
            ok, msg = process_one(src, os.path.join(args.dest, name), utype,
                                  pixel=args.pixel, target_h=args.target_h)
            print(("✅" if ok else "❌") + f" {name}: {msg}")
            results[name] = ok
            if not ok:
                ok_all = False

    if not ok_all:
        print("\n存在未通过项，未更新 manifest（请重生成失败项后重跑）")
        sys.exit(1)

    if not args.no_manifest:
        mp = os.path.join(GAME_ROOT, "assets/manifest.json")
        m = json.load(open(mp))
        for key in m["units"]:
            img = Image.open(os.path.join(GAME_ROOT, "assets", m["units"][key]["file"]))
            m["units"][key]["w"], m["units"][key]["h"] = img.width, img.height
        json.dump(m, open(mp, "w"), ensure_ascii=False, indent=2)
        with open(os.path.join(GAME_ROOT, "assets/manifest.js"), "w") as f:
            f.write("// 素材清单（由处理脚本生成）\nconst MANIFEST = ")
            f.write(json.dumps(m, ensure_ascii=False, indent=2))
            f.write(";\n")
        print("manifest 已更新 ✅")

if __name__ == "__main__":
    main()

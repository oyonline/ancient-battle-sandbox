#!/usr/bin/env python3
"""
AI 道具贴图接入流水线（像素风）
用法：python3 tools/process_ai_props.py
输入：tools/ai_raw_props/{tree_big,tree_small,rock,tower}.png
输出：assets/props/*.png + 更新 manifest
"""
import os, sys, json
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from process_ai_sprites import (
    GAME_ROOT, corner_bg_color, chroma_key_flood, quantize_keep_alpha,
    trim, add_outline, largest_blob_ratio
)

# 目标高度（像素）：按游戏内现有显示尺寸 × ~2.2 超采样
PROPS = {
    "tree_big":   210,
    "tree_small": 170,
    "rock":       150,
    "tower":      210,
}

def process_prop(name, src, dest, target_h):
    img = Image.open(src).convert("RGBA")
    if max(img.size) > 640:
        k = 640 / max(img.size)
        img = img.resize((int(img.width * k), int(img.height * k)), Image.LANCZOS)

    cut = chroma_key_flood(img, corner_bg_color(img))
    blob = largest_blob_ratio(cut)
    if blob < 0.55:
        return False, f"主体破碎（最大连通域 {blob*100:.0f}%）"

    trimmed, _ = trim(cut)
    if trimmed is None:
        return False, "抠图后为空"

    trimmed = quantize_keep_alpha(trimmed)
    scale = target_h / trimmed.height
    trimmed = trimmed.resize((max(1, int(trimmed.width * scale)), target_h), Image.NEAREST)

    pad = 3
    canvas = Image.new("RGBA", (trimmed.width + pad * 2, trimmed.height + pad * 2), (0, 0, 0, 0))
    canvas.paste(trimmed, (pad, pad))
    final = add_outline(canvas, radius=1, color=(26, 22, 18, 255))
    final.save(dest)
    return True, f"OK {final.width}x{final.height}"

def main():
    src_dir = os.path.join(GAME_ROOT, "tools/ai_raw_props")
    dest_dir = os.path.join(GAME_ROOT, "assets/props")
    os.makedirs(dest_dir, exist_ok=True)

    ok_all = True
    for name, th in PROPS.items():
        src = os.path.join(src_dir, f"{name}.png")
        if not os.path.exists(src):
            print(f"⚠️  缺少 {name}.png，跳过"); ok_all = False; continue
        ok, msg = process_prop(name, src, os.path.join(dest_dir, f"{name}.png"), th)
        print(("✅" if ok else "❌") + f" {name}: {msg}")
        ok_all = ok_all and ok

    if not ok_all:
        sys.exit("存在未通过项，manifest 未更新")

    mp = os.path.join(GAME_ROOT, "assets/manifest.json")
    m = json.load(open(mp))
    for key in m["props"]:
        img = Image.open(os.path.join(GAME_ROOT, "assets", m["props"][key]["file"]))
        m["props"][key]["w"], m["props"][key]["h"] = img.width, img.height
    json.dump(m, open(mp, "w"), ensure_ascii=False, indent=2)
    with open(os.path.join(GAME_ROOT, "assets/manifest.js"), "w") as f:
        f.write("// 素材清单（由处理脚本生成）\nconst MANIFEST = ")
        f.write(json.dumps(m, ensure_ascii=False, indent=2))
        f.write(";\n")
    print("manifest 已更新 ✅")

if __name__ == "__main__":
    main()

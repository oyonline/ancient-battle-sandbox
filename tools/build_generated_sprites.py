#!/usr/bin/env python3
"""Build production unit sprites from the generated 4x2 transparent sheets.

Top row contains four walk frames; bottom row contains four attack frames.
The red artwork is the source of truth. Blue variants recolor only crimson
team-cloth pixels so skin, leather, steel, and horse colors stay untouched.
"""

from __future__ import annotations

import colorsys
import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "tools" / "ai_raw_v2"
UNIT_DIR = ROOT / "assets" / "units"
ANIM_DIR = UNIT_DIR / "anim"
TARGET_HEIGHT = 156
PAD_X = 8
PAD_Y = 2
UNIT_TYPES = ("infantry", "pikeman", "archer", "cavalry")
DIRECTIONAL_SHEETS = {"cavalry_down": "cavalry_down_sheet.png"}


def cell_bounds(size: int, index: int, count: int) -> tuple[int, int]:
    return round(index * size / count), round((index + 1) * size / count)


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    bbox = image.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("generated frame contains no visible pixels")
    return bbox


def extract_rows(sheet: Image.Image) -> tuple[list[Image.Image], list[Image.Image]]:
    rows: list[list[Image.Image]] = []
    for row in range(2):
        y0, y1 = cell_bounds(sheet.height, row, 2)
        frames: list[Image.Image] = []
        for col in range(4):
            x0, x1 = cell_bounds(sheet.width, col, 4)
            cell = sheet.crop((x0, y0, x1, y1))
            frames.append(cell.crop(alpha_bbox(cell)))
        rows.append(frames)
    return rows[0], rows[1]


def scale_frames(frames: list[Image.Image]) -> list[Image.Image]:
    tallest = max(frame.height for frame in frames)
    usable_height = TARGET_HEIGHT - PAD_Y * 2
    scale = usable_height / tallest
    output: list[Image.Image] = []
    for frame in frames:
        width = max(1, round(frame.width * scale))
        height = max(1, round(frame.height * scale))
        output.append(frame.resize((width, height), Image.Resampling.NEAREST))
    return output


def recolor_blue(image: Image.Image) -> Image.Image:
    result = image.copy()
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


def make_strip(frames: list[Image.Image], blue: bool) -> tuple[Image.Image, int]:
    frames = scale_frames(frames)
    frame_width = max(frame.width for frame in frames) + PAD_X * 2
    strip = Image.new("RGBA", (frame_width * len(frames), TARGET_HEIGHT), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        if blue:
            frame = recolor_blue(frame)
        x = index * frame_width + (frame_width - frame.width) // 2
        y = TARGET_HEIGHT - PAD_Y - frame.height
        strip.alpha_composite(frame, (x, y))
    return strip, frame_width


def save_static(frame: Image.Image, destination: Path, blue: bool) -> None:
    scaled = scale_frames([frame])[0]
    if blue:
        scaled = recolor_blue(scaled)
    canvas = Image.new("RGBA", (scaled.width + PAD_X * 2, TARGET_HEIGHT), (0, 0, 0, 0))
    canvas.alpha_composite(scaled, (PAD_X, TARGET_HEIGHT - PAD_Y - scaled.height))
    canvas.save(destination)


def build() -> dict[str, dict[str, dict[str, int | str]]]:
    ANIM_DIR.mkdir(parents=True, exist_ok=True)
    animation_manifest: dict[str, dict[str, dict[str, int | str]]] = {}
    sources = [(unit_type, f"{unit_type}_sheet.png", True) for unit_type in UNIT_TYPES]
    sources.extend((name, filename, False) for name, filename in DIRECTIONAL_SHEETS.items())
    for unit_type, filename, save_unit_static in sources:
        sheet = Image.open(RAW / filename).convert("RGBA")
        walk, attack = extract_rows(sheet)
        for team in ("red", "blue"):
            blue = team == "blue"
            name = f"{team}_{unit_type}"
            if save_unit_static:
                save_static(walk[0], UNIT_DIR / f"{name}.png", blue)
            clips: dict[str, dict[str, int | str]] = {}
            for clip_name, frames in (("walk", walk), ("attack", attack)):
                strip, frame_width = make_strip(frames, blue)
                filename = f"{name}_{clip_name}.png"
                strip.save(ANIM_DIR / filename)
                clips[clip_name] = {
                    "file": f"anim/{filename}",
                    "fw": frame_width,
                    "fh": TARGET_HEIGHT,
                    "frames": 4,
                }
            animation_manifest[name] = clips
    return animation_manifest


def update_manifests(anims: dict[str, dict[str, dict[str, int | str]]]) -> None:
    manifest_path = ROOT / "assets" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for name, metadata in manifest["units"].items():
        image = Image.open(ROOT / "assets" / metadata["file"])
        metadata["w"], metadata["h"] = image.size
    manifest["anims"] = anims
    serialized = json.dumps(manifest, ensure_ascii=False, indent=2)
    manifest_path.write_text(serialized + "\n", encoding="utf-8")
    (ROOT / "assets" / "manifest.js").write_text(
        "// 素材清单（由 build_generated_sprites.py 生成；corpses 段由 build_corpse_sprites.py 维护）\n"
        f"const MANIFEST = {serialized};\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    animations = build()
    update_manifests(animations)
    strip_count = sum(len(clips) for clips in animations.values())
    print(f"Built {len(animations)} unit variants and {strip_count} animation strips.")

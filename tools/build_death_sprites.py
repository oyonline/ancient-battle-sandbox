#!/usr/bin/env python3
"""Pack generated six-pose death sheets into ground-aligned game atlases.

This is asset preparation only: the articulated poses are drawn by ImageGen.
One scale is shared by all six frames, and the last frame remains the corpse.
Source sheets are a 3-column, 2-row grid with transparent backgrounds.
"""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image
from build_generated_sprites import recolor_blue


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "tools" / "ai_death_v1"
DEST = ROOT / "assets" / "units" / "death"
TYPES = ("infantry", "pikeman", "archer", "cavalry")
FRAME_HEIGHT = 192
GROUND_Y = 178


def pack(source: Path, standing_height: int) -> tuple[Image.Image, dict]:
    sheet = Image.open(source).convert("RGBA")
    # The game uses hard-edged pixel sprites. Drop near-transparent matte fringe
    # while retaining the generated alpha of every visible sprite pixel.
    sheet.putalpha(sheet.getchannel("A").point(lambda a: a if a >= 128 else 0))
    cells = []
    boxes = []
    for row in range(2):
        for col in range(3):
            cell = sheet.crop((round(col * sheet.width / 3), round(row * sheet.height / 2),
                               round((col + 1) * sheet.width / 3), round((row + 1) * sheet.height / 2)))
            box = cell.getchannel("A").getbbox()
            if box is None:
                raise ValueError(f"Empty frame {len(cells)} in {source}")
            cells.append(cell)
            boxes.append(box)

    factor = standing_height / (boxes[0][3] - boxes[0][1])
    width = round(cells[0].width * factor) + 16
    atlas = Image.new("RGBA", (width * 6, FRAME_HEIGHT))
    for index, (cell, box) in enumerate(zip(cells, boxes)):
        # Preserve the horizontal position within the artist's cell instead of
        # centering each silhouette independently as its limbs unfold.
        sprite = cell.crop(box)
        sprite = sprite.resize((max(1, round(sprite.width * factor)), max(1, round(sprite.height * factor))),
                               Image.Resampling.NEAREST)
        x = index * width + 8 + round(box[0] * factor)
        y = GROUND_Y - sprite.height
        if y < 0 or x + sprite.width > (index + 1) * width:
            raise ValueError(f"Frame {index} does not fit its fixed cell: {source}")
        atlas.alpha_composite(sprite, (x, y))
    return atlas, {"fw": width, "fh": FRAME_HEIGHT, "frames": 6,
                   "anchorX": 0.5, "anchorY": GROUND_Y / FRAME_HEIGHT}


def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    manifest_path = ROOT / "assets" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    clips = {}
    for kind in TYPES:
        live = manifest["anims"][f"red_{kind}"]["walk"]
        standing = Image.open(ROOT / "assets" / "units" / live["file"]).convert("RGBA")
        standing = standing.crop((0, 0, live["fw"], live["fh"]))
        visible = standing.getchannel("A").point(lambda a: 255 if a >= 128 else 0).getbbox()
        # Match the real rendered body, not the 156px canvas (which contains
        # substantial transparent padding for some existing units).
        atlas, metadata = pack(SOURCE / f"{kind}.png", visible[3] - visible[1])
        for team in ("red", "blue"):
            name = f"{team}_{kind}"
            image = atlas if team == "red" else recolor_blue(atlas)
            image.save(DEST / f"{name}.png", optimize=True)
            clips[name] = {"file": f"units/death/{name}.png", **metadata,
                           "scale": 0.4995 if kind == "cavalry" else 0.30}
            print(f"{name}: 6 frames, {metadata['fw']}x{FRAME_HEIGHT}")
    manifest["deaths"] = clips
    serialized = json.dumps(manifest, ensure_ascii=False, indent=2)
    manifest_path.write_text(serialized + "\n")
    (ROOT / "assets" / "manifest.js").write_text(
        "// 素材清单；死亡动画由 tools/build_death_sprites.py 维护。\nconst MANIFEST = " + serialized + ";\n")


if __name__ == "__main__":
    main()

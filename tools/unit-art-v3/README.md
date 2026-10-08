# New troop artwork, 2026-10-08

These original transparent sheets were generated with the built-in ImageGen tool,
using the existing infantry and archer sheets as style/camera references. The full
prompts are retained in prompts.json. Source PNGs are checked in here, unlike the
older ignored tools/ai_raw_v2 reference directory.

Run `python3 tools/build_unit_art.py` to package only axe/worker/medic assets into
public/assets/units and update the actual JS/JSON manifests. Old troops are never
redrawn or overwritten. All action clips of one troop share a single physical
scale measured from its walk body (axe 122px, worker 116px, medic 112px, matching the existing swordsman/archer bodies rather than the full atlas bounding box). A raised axe does not shrink the body. The
256px cells leave weapon padding; feet align at y=224 (FOOT.pad=32). Transparent
alpha dust at values <=32 is cleaned during packing; approved originals remain
unchanged. The axe source's real horizontal gutter is y=400, slightly above the
nominal two-row halfway line; slicing there preserves the entire overhead axe.

The source rows are:
- Axe: walk / attack, four frames each.
- Worker: walk / build / attack / carry, four frames each.
- Medic: walk / heal, four frames each; attack is a compatibility alias of heal.

Red is the source palette. Blue/black variants recolor crimson team-cloth pixels
only, preserving skin, leather, steel, medical markings and the alpha channel.

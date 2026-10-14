# Sword/shield comparison sources

Both authors dedicate the included source content to CC0 1.0; original packaged license statements are adjacent. Exact download URLs and SHA-256 are in `sources.json`.

- Quaternius **RPG Characters — Nov 2020**, Warrior. Official catalog: https://quaternius.com/packs/rpgcharacters.html ; archive is the author Quaternius’s own OpenGameArt upload. This is not the newer paid/free-partial Fantasy Outfit series. Original body mesh, weights, sword and shoulder armor remain. Legacy Diffuse materials are converted to Principled with unchanged packaged textures.
- Kay Lousberg **KayKit Adventurers 1.0** (13 March 2023), Knight. Official author repository linked in sources.json; this is not Adventurers 2.0. Original body, helmet, cape, one-handed sword, Badge_Shield, weights and authored animations remain.
- Warrior’s shield uses KayKit’s CC0 Badge_Shield, fitted to the left hand. Warrior’s three attacks, guard/block and hit are rest-orientation retargets of KayKit clips; no claim that these were authored by Quaternius. Quaternius’s own Death is baked with its original constraints.

Preparation: `tools/prepare-library-models.py` expects the unzipped source folders, requires Blender 5.2, and does no network access. Original archives are retained outside Git under the session evidence directory.

Height is measured from bind-pose foot sole to top of hair/helmet, excluding sword/shield, preserving each character’s proportions. Both normalize to 2.6122968197 before the user-selected 0.3 scale (visible reference height 0.7836890459). Metadata records source bounds, normalization, rest matrices, semantic bone mapping, grips and source clip identities. Blender dots are stripped by glTF export (`Fist.R`→`FistR`, `hand.r`→`handr`).

Contact metadata records measured native clip seconds. Runtime maps these to the unchanged SwordDuel contacts .48/.72/.30. Bone-space rotations and a bounded arm IK compensate for different opponent torso heights; HP, ranges, contact times, random seed and RNG draws stay in the existing SwordDuel. This is a visual contact adaptation, not triangle collision combat.

## KayKit refinement candidate

`kaykit-refined.glb/json` use the same licensed source, geometry, original weights and normalization as `kaykit.glb/json`; only the exported Death clip selects author-native `Death_B` instead of `Death_A`. Regenerate with an optional final `Death_B` argument to `tools/prepare-library-models.py`; output only the KayKit pair under the refined filenames. Without the argument, the prior Death_A output remains the default. Runtime joint/guard/death-space adjustments live in the separate KayRefinement class.

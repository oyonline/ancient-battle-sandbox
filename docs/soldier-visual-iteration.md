# 剑盾兵视觉迭代

第 1 项：R1.1 候选已完成，等待视觉验收。

2026-10-12，当前候选 R1.1。R1 未获通过；用户要求继续改善下半身。R1.1 尚未收到视觉验收反馈。只有用户明确说本项 OK / 通过后才更新验收状态。

## 基线与范围

实际基线 clean `main` / HEAD `d6787a8128b0cd7762b7aadc70262434a03051dc`，真实 `github/main` 经 ls-remote → exact fetch → ls-remote 一致；不是回退至历史评估版本。任务分支 `codex/sword-shield-round1`，没有 commit / push。原始 GLB 保留原路径，另保存逐字节快照 `public/assets/3d-sample/round1/infantry-before.glb`。其 SHA256 为 `3fb6c804576bf2683da48f658ca2343bccb1e5c0d302026d2c30b3270245ba9d`。

参考 `public/assets/units/red_infantry.png`；当前角色脚本共用于 infantry / pikeman / archer / cavalry，本轮只启用 `--candidate` 且强制 infantry。其他兵种资产没有生成或替换，主战场默认仍使用原资产。

实际游戏默认与最近机位基线问题（3 个）：

1. 胸腰变化小，罩袍悬直，整体像长板附在躯干。
2. 肩甲环带与直锥袖子使肩肘连接像几何零件拼装。
3. 两腿窄且直挺，剑盾与躯干没有形成明确的防守和承重关系。

## R1 修改

- 胸甲扩大上胸、收腰，罩袍增加包向侧面的弧面及腰髋过渡；修复自检时发现的背袍与胸甲穿插。
- 袖子和前臂采用沿长度变化的截面，肩甲改连续曲面，减少环带式层叠。
- 现有骨架的 Idle 动作增加错步、轻弯膝和承重，盾臂与剑臂收拢；Attack / Hit 起止兼容准备姿态，Walk 和 Death 后段保留原动作。
- 护胫与靴筒沿原 Shin 轴塑形，护胫保持单骨刚性权重；不把战备姿态烘入绑定姿态。

18 个骨骼名称、层级和逆绑定矩阵逐字节与原 GLB 相同，前向仍为 Three +Z，角色没有整体缩放，根节点与世界尺度不变。Idle 膝弯导致站高略低，是姿态变化。

## 游戏内对照

启动 `npm run dev -- --host 0.0.0.0`，端口 5301。

- 候选默认：http://localhost:5301/battle3d.html?soldier=candidate&view=default&time=0
- 候选最近：http://localhost:5301/battle3d.html?soldier=candidate&view=near&time=0
- 旧版：把 soldier=candidate 改 soldier=old，或点击底部「旧版」「候选 R1」。

同一 Three 场景、地形、灯光、背景、38° FOV、角色位置与世界尺度；1440×1000 截图，Idle 0 秒冻结。默认距离 43，最近距离 10（原游戏允许的最近距离）。近景焦点是完整的红方剑盾兵 index 3，周围保留原兵阵。`clip=walk|attack|hit|death&time=秒` 可采样动作，`angle=弧度` 可检查焦点角色方向；镜头不变。

截图位于 `docs/visual-iteration/round1/`：`old-default.png` / `candidate-default.png`、`old-near.png` / `candidate-near.png`。侧背及动作中段截图同目录，来自实际 GLB 游戏加载，不是离线渲染。

## 验证

- Blender 成功导出真实 GLB + 可编辑 blend；候选 `public/assets/3d-sample/round1/infantry-rigged.glb`。
- 两资产 × 5 动作 × 首/中/尾共 30 个游戏内采样，顶点全部有限，浏览器 console / page error 为 0；检查了前、侧、背和五动作截图，没有观察到明显剑盾脱手、肩肘膝断裂或新穿插。
- 独立 Review 发现过依赖图旧缓存造成关键帧逐次下沉，已修复：读 Hips.matrix 前更新依赖图。最终 Idle 0 / 1 / 1.98 秒顶高相对根地面为 2.53402 / 2.53402 / 2.53395，Attack 首尾均 2.53402，Hit 首尾 2.53402 / 2.53405。
- Idle 采样脚底最低约 -0.0065，和原版一致。死亡动作保留原有地形落地校正 `settleCorpse`；对照也调用同一函数，避免将未校正的原始 clip 当实际游戏最终画面。
- `npm run build` 通过（已有 bundle 大小提示）；`npm test` 763 pass / 0 fail。测试说明对应检查没有发现问题，不代表视觉验收通过。

视觉不足：默认全景兵像素较少，准备姿态变化比近景含蓄；腿和装备仍采用简洁风格，成人比例与自然程度由用户判断。步态与完整接战逻辑不在本轮整改范围。

## 文件与回退

主要修改：`tools/generate-rigged-soldier.py`、`js/three-demo/main.js`；本记录及截图/检查数据；独立 `public/assets/3d-sample/round1/` 资产。

重导出：

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python tools/generate-rigged-soldier.py -- "$PWD/public/assets/3d-sample/round1" --kind infantry --candidate
```

恢复原效果：打开不带 soldier 参数的 `battle3d.html`，或点击「旧版」；原主资产没有被改动，无需回滚代码或重导出。如以后原主资产变化，修改前完整快照仍在 `round1/infantry-before.glb`。本轮仅本地候选，未设为默认、未发布、未记为已验收。

## R1.1 下肢形体与承重续改（2026-10-12）

用户对 R1 的反馈（未通过）：「下半身的形体与承重关系仍不够自然。」并指出膝盖、护胫、靴子的分段突出，一侧小腿斜折抢眼，骨盆、躯干、双腿缺少连贯稳定的战备关系。该反馈是对截图的判断；本轮先实际加载 R1 的无遮挡斜俯、正、侧视，再确定处理方式。

真实原因与处理：

1. 原下罩袍遮住大部分大腿，膝甲前凸且跨 Thigh / Shin 混合权重，视觉上变成膝盖零件接长小腿。R1.1 重塑髋至膝连续裤腿体积，末缘略提高显露大腿；膝甲缩小并使用单 Thigh 刚性权重，护胫保留单 Shin。
2. 靴筒、护胫原截面与连接不统一。新小腿体积沿原绑定轴线成形，护胫与靴筒截面协调，弱化分段和外置膝甲感。
3. R1 骨盆向后偏置与后踝错步叠加，令后小腿斜折突出。R1.1 将骨盆轻移到前脚承重区域，躯干做克制的前倾联动，保持错步轻屈膝；没有扩站距或进一步下蹲。

肩轮廓、收拢的剑盾、钢盔与原配色保留。18 骨及逆绑定矩阵逐字节和 R1 一致，绑定姿态、世界尺度不变。R11 开关只允许 infantry；其他兵种和主默认资产没有更换，Walk / 转向 / 接战规则未改。

预览：

- R1.1 默认：`http://localhost:5301/battle3d.html?soldier=r11&view=default&time=0`
- R1.1 完整单兵近景：`http://localhost:5301/battle3d.html?soldier=r11&view=near&time=0&solo=1`
- R1.1 无遮挡侧面：`http://localhost:5301/battle3d.html?soldier=r11&view=near&time=0&solo=1&angle=2.214297`
- 将 `soldier=r11` 改成 `soldier=candidate` 即看 R1；底部「候选 R1」/「候选 R1.1」可切换，并保留机位和采样设置。

已实际访问并加载 R1.1 GLB。正式五张游戏截图在 `docs/visual-iteration/round1-1/`：`r1-default.png`、`r11-default.png`、`r1-near.png`、`r11-near.png`、`r11-side.png`。默认同一兵阵；近景两版都仅隐藏周围单位、显示同一 index 3 剑盾兵且头脚完整。38° FOV、原距离 43 / 10、1440×1000 画布、光地背景角色尺度位置相同，Idle 0 秒；侧面仅转角色，不改镜头。另有前后、Walk 最大摆腿和 Attack / Hit / Death 图片用于自检。

验证：两版完整 Idle 各 49 次采样、覆盖两个循环，另四动作各首中尾，总计 122 次采样，全部有限顶点、console / page errors 为 0。R1.1 左右脚骨世界位置最大漂移分别 0.167mm / 0.080mm，首尾位置差 0；身高仅在 2.55907..2.57470 呼吸范围内，没有累计下沉。追加 Walk .25 / .75 极值与侧面检查 4 次，未看到本次引入的肩肘膝断裂、剑盾脱手或明显穿插；Death 复用既有地形落地校正。独立 Review 无 P0/P1。build 通过，完整测试 763/763；这些结果不表示视觉已通过。默认全景变化仍较近景含蓄，腿甲仍有简洁分段风格，自然程度等待用户裁决。

R1.1 独立资产：`public/assets/3d-sample/round1-1/infantry-rigged.glb` + 同目录可编辑 blend、metadata。GLB SHA256 `50b7dbda0589910fd6ba7053d6239e2b58abb5c6f15b8f4cb9c145f61919b2ca`。重导出使用 `--kind infantry --candidate-r11` 并指定 round1-1 输出目录。R1 GLB 原指纹 `122b85368ad4b21ed25d5c10a467cb9653d029dae43a3299d6190e4390543963` 保持；R1 精准生成脚本快照为 `public/assets/3d-sample/round1/generate-rigged-soldier-r1.py`。回退只需切回「候选 R1」，无需改代码或覆盖任何资产。

当前状态：**第 1 项：R1.1 候选已完成，等待视觉验收。** 本项没有记录为通过，不进入下一项。

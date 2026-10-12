# T1：活人步兵坡面接地

2026-10-12，续接 Q1 本地基准 `56ec7ca201818481b0bc4892aad8ea5c5a69e0ef`。本项仅剑盾、长矛、弓兵的活人接地；技术验证 / 独立内部效果复审通过，用户明确视觉认可未知。当前 NO PUSH。

## 问题与修改

原场景只在人物根中心采地形高度，前后错步的两只脚仍沿同一平面。实际候选 GLB 在原地形 `(-3,-1)` 四朝向 Idle 检查，最差脚底入地约 0.153m、悬空约 0.053m。原 QA 强制平地，之前的移动证据没有覆盖这一风险。

T1 从现有靴子权重顶点取得每脚 14 个底面局部点，结合脚下原地形高度和法向，复用既有两段腿链和膝前向；踝高修正限幅 ±0.18m，坡向倾角限幅 0.28rad。只做腿部旋转，不移动根节点或骨盆，不改变世界尺度、地形、灯光、镜头、GLB、绑定、规则和马系统。每帧 mixer 前恢复本轮叠加前的腿姿态，避免常值动画轨道产生累计偏移。

移动时在 mixer 后、M1 世界支撑锚处理前保存原生脚底抬升，再据此处理坡差，保留摆腿抬脚。第一版使用 M1 后的高度，发现下坡支撑锚会叠加根高度变化：仅据该原因修复，没有继续加大屈膝或压低身体。平地高度场完全跳过叠加，原 M1 位姿逐位一致。Death 不应用 T1，沿用 Q1 尸体处理。

## 实际预览与回退

主混合 32：[组合 T1](http://127.0.0.1:5301/battle3d.html?motion=candidate&duel=candidate&crowd=candidate&pike=candidate&bow=candidate&ride=candidate&coordination=candidate&terrain=candidate)。删除 `terrain` 或设 `terrain=baseline`，保留其他参数即回退本项。无参数默认资产未替换。

单兵真实坡面：[剑盾动态](http://127.0.0.1:5301/battle3d.html?qa=single&unit=infantry&motion=candidate&duel=candidate&crowd=candidate&pike=candidate&bow=candidate&ride=candidate&coordination=candidate&terrainScene=slope&terrain=candidate)。点击“重放动作序列”；修改 `unit=pikeman` 或 `unit=archer` 检查其他兵种。两版均使用 `terrainScene=slope`，仅切换 `terrain`。

固定近景在上述地址加 `still=1&view=near&time=0&solo=1`。现有页面的“地形接地基准 / 地形接地候选 T1”按钮保持其余阶段参数。截图的兵种由实际目标 `kind` 标记。

## 实机证据及采样边界

正式数据：[summary.json](visual-iteration/terrain1/summary.json)。原录像与同源 PNG / trace 在本地 `.omc/evidence/terrain1/`，未纳入 Git。这里的图均来自实际加载现有候选 GLB 的 Three.js 场景。

- 三兵种两版各 23 次静态采样，包含完整 2s Idle 循环的五个时点、Walk / Attack / Hit / Death、四朝向；全部有限、浏览器错误 0、五个实际资源 HTTP 200。四朝向 Idle 候选脚底约 −0.0065～+0.0096m；保留原靴底约 −0.0065m 的边缘。
- 每兵种两版各 240 个正常速度、post-render 精确模拟时刻 PNG。候选最终 trace：剑盾 1440、弓兵 1438、长矛 1440。完整真实移动、左右转、掉头、停止、重新起步、短距与收尾均保留。
- 支撑相位取 Walk 相位（L 加 0.5）0.1～0.4，最终候选真实移动间隙：剑盾 −0.01955～+0.04470m、弓兵 −0.02152～+0.04573m、长矛 −0.01727～+0.04514m；摆腿最大约 +0.1215m，未将两脚全时压地。
- 两版混合 32 均真实 16s 正常交战、暂停、重置：16+16 → 16+10 → 16+16，浏览器错误 0，五 GLB HTTP 200。混合图是明确记录 wall-clock 的屏幕截图，不冒充精确同一模拟时刻帧。

重要边界：正式静态在 native-lift 修复前拍摄，但纯 mixer 静态采样不执行 M1 支撑锚，因此该修复不改变所展示的静态路径；正式动态与混合 32 已使用最终修复。基准动态在新增 `soleContact` 字段前录制，原 trace 只有 Foot 骨位置，不虚构旧版动态脚底间隙。动态图片可同场景对照，静态 / 独立离线真实 GLB 检查用于旧版脚底数值。`pre-ui-*` 和 `pre-lift-*` 保留为诊断记录，未当作最终动态交付。

前后近景：

| 兵种 | 基准 | T1 |
|---|---|---|
| 剑盾 | [近景](visual-iteration/terrain1/baseline-infantry-near.png) | [近景](visual-iteration/terrain1/candidate-infantry-near.png) |
| 长矛 | [近景](visual-iteration/terrain1/baseline-pikeman-near.png) | [近景](visual-iteration/terrain1/candidate-pikeman-near.png) |
| 弓兵 | [近景](visual-iteration/terrain1/baseline-archer-near.png) | [近景](visual-iteration/terrain1/candidate-archer-near.png) |

动态精选（标注每张实际模拟时刻）：[剑盾基准](visual-iteration/terrain1/baseline-infantry-move-frames.png) / [T1](visual-iteration/terrain1/candidate-infantry-move-frames.png)、[长矛基准](visual-iteration/terrain1/baseline-pikeman-move-frames.png) / [T1](visual-iteration/terrain1/candidate-pikeman-move-frames.png)、[弓兵基准](visual-iteration/terrain1/baseline-archer-move-frames.png) / [T1](visual-iteration/terrain1/candidate-archer-move-frames.png)。另有剑盾同默认机位、侧面与背面以及两版混合战场暂停图。

## 验证与保留问题

相关 26 个检查通过（地形 7 个）：三实际 GLB 四向接地、平地与原 M1 逐位相同、150 次常值 Idle 无累计、死亡清理叠加、摆脚抬升、真实上 / 下坡移动支撑锚高度不重复叠加。最终全量 780/780 和 build 通过；独立源码 / 实际动态效果复审 APPROVE（仅活人步兵有限接地范围，未发现新增 P0/P1）。15 个既有 GLB 和 combat-model 未修改，哈希记录在 summary。

T1 是有界坡差改善，仍保留起停 / 转身窗口脚底约 2cm 入地或 4.6cm 悬空、旧 M1 局部滑脚、C1 边界和骑兵不逐蹄贴合等 P2；不宣称全周期毫米级接地、不代表全角色地形 IK 或用户美术验收。没有扩展建筑、镜头、灯光，也没有改变 Q1 箭矢 / 冲锋 / 尸体规则或接口。下一项仅建筑比例检查，尚未实施。

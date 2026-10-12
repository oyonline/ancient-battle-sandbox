# 长矛兵 P1：成人体态与持矛战备

2026-10-12，接续 R1.1 / M1 / D1 / C1。用户授权内部技术与效果复审通过后继续下一兵种，适当本地 commit，**不 push**；用户明确视觉认可仍未知。

## 集中问题与候选

实看原 2D `public/assets/units/red_pikeman.png` 以及真实 Three.js 原长矛兵后，集中问题为：肩环、外置膝块、笔直且分段的腿部与窄直罩袍共同使持矛者显得直立拼装；现有两手持矛关系已紧凑，予以保留。

P1 只在 `--kind pikeman --pikeman-candidate` 生效。胸腰与包身罩袍、连续肩壳和袖截面采用已成立的形体原则；裤腿、膝甲、刚性护胫、靴筒沿不变绑定轴协调体积；Idle 小幅骨盆前移、错步屈膝，保持原生双手持矛 IK 和刺矛节奏。相关移动使用 M1 已成立的步距、Turn 和位移同步控制，不将剑盾挥剑轨迹套到矛。

原始长矛 GLB 保留 `public/assets/3d-sample/spear-rigged.glb`，SHA256 `eb02d13c6bfdbde76e72ee4d64c77b2666ef7553fe74114c2cfe79492a2f11e0`。候选 `public/assets/3d-sample/pikeman1/spear-rigged.glb`，SHA256 `b3c60a64134fb091988bd4c692274df9136673c30a2a3d270cfc311b06389d15`，同目录 metadata。18 骨绑定与逆绑定矩阵和原长矛逐字节一致，身高 2.6123、不变世界尺度 / 根节点 / Three +Z 前向。原 R1.1 / M1 / D1 资产未覆盖；C1 模拟源码未修改，原有碰撞、人数、血量、伤害、攻击距离保持。

重导出：

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python tools/generate-rigged-soldier.py -- public/assets/3d-sample/pikeman1 --kind pikeman --pikeman-candidate
```

## 正式预览与回退

- 全景 / 单兵近景：`http://localhost:5301/battle3d.html?motion=candidate&duel=candidate&crowd=candidate&pike=candidate&view=near&time=0&solo=1`，`view=default` 为原默认机位。底部「长矛基准 / 长矛候选 P1」同条件切换。
- 平地静态检查：增加 `qa=single&unit=pikeman&still=1`，复用既有单兵 QA 平地，不替代默认场景对照。
- 正常速度移动：`http://localhost:5301/battle3d.html?qa=single&unit=pikeman&pike=candidate&motion=candidate&duel=candidate&crowd=candidate`，点击「重放动作序列」。
- 原生刺矛双兵：上址将 `qa=single` 改为 `qa=duel`，点击「重放双兵交战」。少量同型接触用 `qa=four`。
- 主混合 32 人：删除 `qa` / `unit`，保留 M1 / D1 / C1 查询参数和 `pike=candidate`，正常开战 / 暂停 / 重置。

将 `pike=candidate` 改为 `pike=baseline` 即回原长矛网格与移动表现；移除 pike 参数回原默认入口。M1 / D1 / C1 查询仍保留既有剑盾阶段成果。没有替换默认资产。

## 检查与状态

技术验证：真实 GLB 导出、build 通过；相关动画 / 移动 19 项和全量 767 项测试通过。正式无 route Three.js URLs 实际加载候选，所有五类场景资产 HTTP 200、console / page errors 为 0。源码最后两处仅补不合法 P1 + Sword Duel 参数拒绝和区分静态 view / still 与正常实时入口，已单独语法与构建检查。

- 默认 / 近 / 前 / 侧 / 背，Idle 全循环五点、Walk 两极值、Attack 首 / 蓄力 / 刺击 / 收回、Hit、Death 共 17 次实际皮肤采样均有限。原生双手矛 IK 保留，独立复审未见新增明显肩肘膝断裂、脱手或穿插。
- 平地正式候选 Idle 脚骨最大漂移约 0.00000031 世界单位，最低顶点相对地面 -0.00650（原有约 6.5 毫米鞋底边缘）；原版 Idle 因 9 毫米呼吸位移最低 -0.01550。Walk 两点最低 -0.00697 / -0.00650；Death 地面校正后 +0.025。不能用这些有限检查宣称所有地形无问题。
- 完整正常速度单兵六类移动操作：同原生长矛速度上限 1.65，候选使用 Turn / 位移同步 Walk；两版各 1440 次 trace，候选正式录制和基准私有第一轮录制同摄像、场景、时间命令和 GLB 参数。私有首轮经过精确 route 的 QA 适配代码，正式 URL 已取消 route 验证相同候选。对照连续帧带真实 post-render 模拟时间，不以视频时长估算。
- 原生双兵真实刺击：基准首次 attack / hit 1.1002 / 1.5668s，候选 1.1334 / 1.6001s，均保留 11/24s 出手结算；原有先手 / 受击中断行为不变，两版均红 100、蓝 -12，Death 完成并落地。
- 少量同型真实接触用 4 对 4：320 同源帧、89 真实事件，活人最小中心距离 1.9599966（原半径 .95 + .95 + .06），没有扩大半径或关闭碰撞；最终红 4、蓝 0。
- 完整混合 32 人实际开战 / 暂停 / 重置：初始红 16、蓝 16，交战红 16、蓝 11，重置红 16、蓝 16，五 GLB 全部 HTTP 200、浏览器 errors 0。最后入口条件修正使无 view / still 的正常混合入口直接运行 Idle，已复验；独立窄评确认。

技术验证：通过。独立内部视觉复审：通过（没有未解决 P0 / P1，保留下述 P2）。用户明确认可：未知，未冒写满意。内部通过后继续弓兵，仍接受用户后续修改意见。

正式精选同条件图片 / 同步动态帧：`docs/visual-iteration/pikeman1/`。完整本地正常速度录像、原始帧、精确 trace、测试：`.omc/evidence/pikeman1/`；基准移动私有第一轮已归档至 `baseline-move/`，不依赖临时目录续接。RAW 录像不进 Git。

已知限制：原默认坡地无逐脚地形贴合，P1 所在坡地 sampled 最低顶点相对地形 -0.126，原版 -0.102；这不是平地脚底结论，不能宣称候选已适应所有坡地。保留 M1 局部收脚足滑、C1 宽外翼边界限制。技术通过、内部视觉通过、用户明确认可分别记账。

# Q1：箭矢、冲锋、尸体与人物动作协调

2026-10-12，保留 M1 / D1 / C1 / P1 / A1 / V1。用户授权普通可回退本地实现、真实运行和独立复审后继续，适当本地 commit，**NO PUSH**。用户明确视觉认可未知。技术检查和独立内部复审已通过；用户视觉认可仍未知。

## 原因与实际改动

1. 原飞箭只取模拟平面位置和固定地面 +1.5 高度，没有衔接持箭骨，也只有水平朝向。Q1 从实际 Arrow 骨的箭尖后 0.15 处移交飞箭；飞箭的 0.15 前端延伸与原轴长对应。持箭显隐改为 draw / shoot / death 事件状态在 mixer 后处理，避免动画 scale 插值抢先隐藏或放箭后重现；飞箭使用原模拟 x / z / age / duration，表现偏移逐渐消退，方向沿显示曲线切线。没有改伤害、射程、射速、碰撞或命中计算。
2. 冲锋结算原来只触发目标 Hit 与地面圈，来源可能仍处于普通攻击动作。Q1 用实际 charge 事件接管普通 thrust，在原 Charge 上叠加最多 0.10 rad 的胸部冲击反馈；每次 mixer 更新前恢复上一帧原生胸姿态，更新后只施加当前反馈，避免常值轨道累乘；Hit / Death 保持优先，持续时间来自已有 chargeFlash，没有伪造冲锋事件。马步、骑乘坐姿、速度、runup 阈值和原马死亡均保留。
3. 完整实际弓兵 Death 显示整尸悬空，逐骨顶点证明原左手 / 弓最低点 -0.8074、左前臂 -0.5576，而躯干 / 腿最低约 -0.1236。原全模型接地把整个尸体抬高 0.8324。Q1 仅在弓兵 Death 后段 0.35–0.65 秒将相连左上臂放到体侧，保留原弓 world 朝向，再执行完整网格接地，不忽略武器或允许手臂穿地。完成后缓存修正骨姿态，每次 mixer 后重施并保留尸体高度，防止 clamped 动画写回原下垂手臂。bind、inverseBind、GLB、根 / 尺度 / 前向不变。

## 实机入口与回退

- 组合候选：<http://127.0.0.1:5301/battle3d.html?motion=candidate&duel=candidate&crowd=candidate&pike=candidate&bow=candidate&ride=candidate&coordination=candidate>
- 弓兵真实双兵：在上述地址增加 `qa=duel&unit=archer`，点击「重放双兵交战」。
- 骑兵真实冲锋：改成 `qa=duel&unit=cavalry`，沿用 V1 的 ±8 起点、原阈值。
- 4 对 4：`qa=four&unit=archer` 或 `unit=cavalry`，点击重放。
- 底部「动作协调基准 / 动作协调候选 Q1」切换只改变 `coordination`；所有前阶段标志保留。`coordination=baseline` 或删除该参数回退本轮效果，不回退旧资产阶段。无参数主场默认不变。

## 证据与检查边界

正式证据是实际 Three.js 场景加载既有候选 GLB 后的 1 倍速录像、post-render PNG 与真实模拟 trace；每版双兵 18 秒 / 180 帧，覆盖完整 Death 和完成后至少两秒，4v4 32 秒 / 320 帧。相机、灯光、尺寸 1280×900、单位位置和已有资产参数相同；实时浏览器 dt 有差异，不伪称两次战斗 bitwise 一样。

- 弓兵双兵两版均 draw / shoot / arrow-hit 16 次、death 2；首次放箭约 0.483 秒，原 11/24s windup 保留。候选首飞箭 origin 与实际显示位置完全相同，实测约 (-1.7641, 2.2381, -0.1099)，原版首飞箭高度 1.65；同帧持箭 scale 0.001。不是从录像时长猜放箭时刻。
- 实际弓兵尸体完成后：原全模型最小离地 0.025、躯干 / 腿最小离地约 0.7088；Q1 全模型 0.025、躯干 / 腿约 0.1160，modelY 从 0.8324 降为 0.2396。15–18 秒实际连续帧及接地数值稳定，没有恢复站立。仍是原整人侧倒，没有 ragdoll 或落马系统；右手仍参与支撑，身体不是完全平贴地面。
- 骑兵双兵两版均 charge 2、attack 10、hit 5、death 1；正式帧可见 resolved charge 与冲击反馈、Hit / Death 优先、最后原整马侧倒保持。不宣称马步、骑姿或独立落马全面自然。
- 弓兵 4v4 两版各 320 同源帧，原 78 draw / 56 shoot / 56 hit / 6 death，候选 84 / 58 / 56 / 6；骑兵 4v4 原 {'attack': 72, 'hit': 38, 'death': 6, 'charge': 4}、候选 {'attack': 72, 'hit': 38, 'death': 6, 'charge': 4}。各真实运行 dt 有差异，事件数量差异不包装为同一确定性回放；规则源码未改。
- 主混合 32 两版各 16 秒正常录像 / 16 wall-clock 截图，初始和重置均红16蓝16、五 GLB 200、浏览器 errors 0；具体交战状态详见 summary。
- 最终实际骑兵双兵和4v4的所有采样胸X绝对值最高约0.26877 rad，修复前离线常值轨叠加可升至1.669 rad；修复后最大反馈受0.10rad约束，Hit / Death不泄漏。最后新增胸缓存仅骑兵候选路径执行，弓及baseline留用此前相同有效路径正式对照；全部结果明确区分pre-impactfix归档。
- 全量 773 / 773、相关 39 / 39 和 build 通过。
- 15 个既有 GLB 与 HEAD bytes 完全相同，`combat-model.js` bytes 完全相同；详见精选 summary 中 invariants。
- 已执行相关测试 39 / 39（6 个协调测试 + 原相关 33）。初版 clamp 测试曾误用非完全单位 quaternion 的 angleTo 导致失败；已改为更严格的逐分量 deepEqual，真实 A1 GLB 完成后连续 180 次更新的骨 / 高度 / Death 状态全部一致。首次 shell 多命令末尾 exit 掩盖失败已纠正，保留失败日志，不作成功证据。

完整 raw 录像 / 连续同源帧 / trace 保存本地 `.omc/evidence/coordination1/`，不进 Git；`preliminary-*`、`first-*` / `pre-impactfix-*` 保留试录和首次返工记录，不冒充最终结果。正式精选证据在 `docs/visual-iteration/coordination1/`。主混合 32 检查使用正常坡地和人数，录像与 wall-clock 截图 / 状态；明确不是 post-render 同模拟时刻 trace 对照。

## 三态与后续

技术验证：通过。独立内部视觉复审：通过（原生独立只读 lane，未解决 P0 / P1 为 0，root 接受限定本专项范围）。用户明确认可：未知。下一项按 KB 顺序为完整场景协调，先处理人物接地与建筑比例，再分别处理镜头 / 灯光；未在本专项展开。

保留 M1 起停局部足滑、C1 外翼边界、原骑兵整马侧倒 / 骑手坐姿与马步等 P2。Q1 使用当前 A1 的已确认 Arrow / UpperArmL / HandL 接口，没有承诺任意未来骨架资产自动兼容。

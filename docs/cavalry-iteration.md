# 骑兵 V1：骑手胸腰与骑乘承重

2026-10-12，接续 R1.1 / M1 / D1 / C1 / P1 / A1。用户授权内部技术 / 效果复审后顺序推进，适当本地 commit，**NO PUSH**；用户明确认可未知。

## 集中问题与候选

实看 `public/assets/units/red_cavalry.png` 与正式 Three.js 旧骑兵：原肩双环、窄直胸袍与腰部衔接使骑手像拼装的直立杆；持长械、缰、原坐姿与马步接口已成立。V1 集中骑手连续肩壳、袖截面与胸腰包身体积，保留简洁钢甲 / 红袖 / 象牙罩袍 / 长械识别。没有全面重做马体，也没有改灯光 / 镜头来掩盖模型问题。

`--kind cavalry --cavalry-candidate` 只启用骑手 SHAPE 形体，不启步兵 LOWER、MOTION、ready_legs 或足锁。原骑乘大腿 / 胫 / 脚骨沿坐姿与鞍关系保持；不套步兵站姿。仍有挺直坐姿和正面长板袍感，不能据连续肩改善宣称全部骑兵动作自然；原马体与马步几何感保留为后续范围。

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python tools/generate-rigged-soldier.py -- public/assets/3d-sample/cavalry1 --kind cavalry --cavalry-candidate
```

原 `public/assets/3d-sample/cavalry-rigged.glb` SHA256 `1e6ba2d0f9142e6608cc45e315ac31c79c0830579d3c363b128c42bf7d6b958f`；独立候选 `cavalry1/cavalry-rigged.glb` SHA256 `f8360500293593247185536fe0547ace7634928f06e1b54ac8d07ff6eeb73e46`。实际 34 骨（18 骑手 + 16 马），全部骨节点 bind transform 与 inverseBindBytes 原样；Idle / Walk / Attack / Hit / Death / Charge 六个原生动画采样 accessor bytes 逐字节一致。14 个既有 GLB hash 与本轮 HEAD 保持。世界尺度、根和 Three +Z 前向保持。

## 实际入口与回退

- 同条件近景：`http://localhost:5301/battle3d.html?motion=candidate&duel=candidate&crowd=candidate&pike=candidate&bow=candidate&ride=candidate&view=near&time=0&solo=1`；`view=default` 是原默认机位。
- 平地：增加 `qa=single&unit=cavalry&still=1`。普通 `ride=candidate` 无 view / still 时实时运行，没有自动冻结。
- 正常六类移动：`http://localhost:5301/battle3d.html?qa=single&unit=cavalry&ride=candidate&motion=candidate&duel=candidate&crowd=candidate&pike=candidate&bow=candidate`，点击重放动作序列。
- 真冲锋双兵：改 `qa=duel`；仅骑兵 QA 起点 ±8，给原 runup 阈值留真实冲锋距离。其他兵種仍 ±3；没有强制 charge 状态、改伤害或阈值。少量接触用 `qa=four`。
- 主混合 32：移除 `qa` / `unit`，保留 ride 和其他已有阶段参数，开战 / 暂停 / 重置。

`ride=baseline` 回原骑兵资产；移除 ride 回默认原骑兵。其他兵种阶段独立保留。明确静态才冻结；Charge 静态采样只在骑兵执行，混合里缺 Charge 的非骑兵回 Idle。

## 验证与三态

技术验证：通过。独立内部视觉复审：通过（原生 Codex 独立只读 lane，P0 / P1 无未解决项；root 接受本轮骑手形体改善）。用户明确认可：未知。通过范围是本轮骑手形体及原生接口兼容；没有宣称马步 / 控制 / 全骑兵整体艺术已全面通过。下一项为箭矢、冲锋、尸体与人物动作协调专项，尚未执行。

- 正式无 route 默认 / 近 / 前 / 侧 / 背；19 皮肤采样覆盖 Idle 五点、Walk 两极值、Attack / Charge / Hit / Death，候选与原版 finite、五 GLB HTTP 200、浏览器 errors 0。平地候选另 19，Idle 五点马蹄最低点相对平地 +0.013；默认坡地约 -0.03504，原候选相同。没有逐蹄地形贴合，不能将此有限采样当全面接地通过。
- 正常速度六类移动，两版各 240 同源 render 帧、1439 / 1440 trace，原速度上限 4.8；两版均自然进入 Charge 状态 16 次采样。实施者实际查看候选全部 240 帧及原版代表对照，独立复审查看转向 / 停止 / 起步连续段；没有声称完整观看视频。
- 冲锋双兵第一轮 ±6 只有 attack / hit / death，有效 runup 最高 2.458，不误报冲锋成功，raw 归档 short-duel。最终仅骑兵 QA 改为 ±8 后两版各 180 同源 render 帧 / 1080 trace，真实 charge 2、attack 10、hit 5、death 1；max runup 5.34291 / 5.33330，Charge 状态各 100 次采样。基准 charge 时间 1.8665 / 2.0834，候选 1.8668 / 2.0658 秒；最后红 64、蓝 -6，蓝 Death Complete 并 settled。真实冲锋 / 穿刺推进、受击 / 死亡前后同步帧已查看；不强制动画或降低阈值。
- 4 对 4：320 同源帧、charge 4、attack 72、hit 38、death 6；最后红 2、蓝 0，6 名死者全部 settled。活人最小中心距 4.05999552，与原半径 2 + 2 + .06 对应，没有扩大半径或移除碰撞；真实接触与晚倒地代表同步帧已查看。
- 主混合 32 真开战 / 暂停 / 重置：初始 / 重置红 16、蓝 16，交战红 16、蓝 11，五 GLB HTTP 200、浏览器 errors 0。
- 正常权限全量 767 / 767；最后 QA 起点 ±6→±8 的小调整后相关 19 / 19 与 build 再通过，不无意义重复全量。绑定 / 原生动作 / 14 既有 GLB 保持见精选 summary 中 invariants。

保留 P2：骑手坐姿仍挺直、正面罩袍仍有长板感；马体 / 马步几何感、坡地不逐蹄贴合、原整马侧倒带骑手（没有独立落马）均未全面重做。保留 M1 起停局部足滑 / C1 外翼近边界限制。与 2D 的红羽 / 马披细部尚非完整复刻；本轮没有靠添饰物替代肩胸形体改进。

完整 raw 录像 / 同源 render PNG / 模拟 trace：`.omc/evidence/cavalry1/`，不进 Git；精选 `docs/visual-iteration/cavalry1/`。实际 post-render 时间标在图上，两次真实运行有小于约 0.018 秒的采样差异，无法以录像时长替代模拟时间。所有技术结果与内部复审均不等于用户明确满意。

# 弓兵 A1：成人承重与持弓战备

2026-10-12，接续 R1.1 / M1 / D1 / C1 / P1。当前用户授权普通本地可回退施工、实机检查、独立复审后继续下一兵种，适当本地 commit，**不 push**；用户明确视觉认可仍未知。

## 集中问题与候选

实看 2D `public/assets/units/red_archer.png` 与真实 Three.js 旧弓兵：2D 的象牙色兜帽、箭袋、红袖与褐靴有明确兵种识别；原 3D 是共用金属帽，没有箭袋，直分段腿部与窄罩袍使持弓者显得拼装直立。原双手持弓 / 拉弦关系已成立，保留原生 solver，不套剑盾挥剑或长矛手臂。

A1 仅 `--kind archer --archer-candidate` 生效。沿不变绑定轴协调胸腰、包身罩袍、连续肩壳、袖部与裤腿 / 膝 / 护胫体积；Idle 采用低幅错步屈膝承重，恢复简洁兜帽与箭袋识别。背带沿肩和胸表面分段布置，首版直穿胸的杆已替换。Walk / Turn 使用既有 M1 步距与位移同步控制，手臂仍交原生弓兵 solver；原弓、变形弦、手中箭、Attack / Hit / Death 时序与 11/24s 放箭接口保留。

原 `public/assets/3d-sample/archer-rigged.glb` SHA256 `14b9cf5348eb4bd30cae4befb0bd15ed628899dae32500f26f8aeb9effe80abf` 保留。独立候选 `public/assets/3d-sample/archer1/archer-rigged.glb` SHA256 `a86fce43b1bf022e7a0d1acf7e0e039e0ce53da94354868cd37f55b4f43deb11`，同目录 metadata。真实原弓兵是 18 人形骨加 Arrow 共 19 骨，候选保留全部节点绑定 transform 与逐字节 inverseBindMatrices；不改世界尺度、根节点、Three +Z 前向。13 个既有 GLB 与本轮 HEAD hash 一致，M1 / D1 / C1 / P1 资产未覆盖。

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python tools/generate-rigged-soldier.py -- public/assets/3d-sample/archer1 --kind archer --archer-candidate
```

## 实际预览与回退

- 默认 / 近景静态：`http://localhost:5301/battle3d.html?motion=candidate&duel=candidate&crowd=candidate&pike=candidate&bow=candidate&view=near&time=0&solo=1`；`view=default` 为原默认机位。
- 平地静态：增加 `qa=single&unit=archer&still=1`；不是默认坡地检查的替代品。
- 正常速度六类移动：`http://localhost:5301/battle3d.html?qa=single&unit=archer&bow=candidate&motion=candidate&duel=candidate&crowd=candidate&pike=candidate`，点击「重放动作序列」。
- 原生弓兵双兵：将 `qa=single` 改成 `qa=duel`，点击「重放双兵交战」；少量同型 `qa=four`。
- 混合 32 人：移除 `qa` / `unit`，保持候选参数，实际开战 / 暂停 / 重置。

`bow=baseline` 回原弓兵网格与移动，移除 bow 回默认原资产；其他 M1 / D1 / C1 / P1 参数继续保留。没有 view / still 的 bow 正常入口运行实时 Idle，只有明确静态比较冻结。QA `capture=1` 使用正常渲染后的真实模拟时间、trace 与 PNG；移动全序列 10Hz，重放重置帧数组。不根据录像时长推算对照时间。

## 验证与三态

技术验证：通过。独立内部视觉复审：通过（原生 Codex 独立 lane，P0 / P1 无未解决项，root 同意保存 A1）。用户明确认可：未知。内部通过后下一项骑兵，尚未开始重做；箭专项仍在后续队列。

- 最新正式无 route URL：默认 / 近 / 前 / 侧 / 背、Idle 五点 / Walk 两点 / Attack draw-release / Hit / Death 共 17 皮肤采样均 finite；平地另 17，五 GLB HTTP 200，console / page errors 为 0。
- 平地候选 Idle 五点最小顶点相对地面约 -0.00650030，保留既有约 6.5 毫米鞋底边；默认坡地约 -0.05435，原版约 -0.04446。没有逐脚地形贴合，不能宣称已适应所有坡地。
- 正常速度单兵完整六类移动：基准 / 候选各 240 同源 render 连续 PNG，各 1439 / 1440 trace，原生速度上限均 1.8。实施者实际查看全部候选 240 连续帧及基准代表对照，独立 reviewer 查看关键转向、停止、起步连续段；没有声称完整观看视频。实际模拟时间标在精选图上；两次实时运行小于约 0.018s 的采样差异如实显示，不以视频时间代替模拟时间。
- 原生双弓真实交战：两版各 draw / shoot / arrow-hit 16 次、death 2；首次 shoot 基准 0.4840s、候选 0.4834s，首次 arrow-hit 0.7840 / 0.7834s。原 11/24s 放箭结算保留；最后双方 hp -12，Death 完成并 settled。双兵连续 PNG 采到约 12.9s，死亡在 13.4s 后，由完整事件 / trace 确认，实际倒地形态另外查看四人场景晚帧与 Death 静态，不伪称双兵 PNG 已覆盖死亡。
- 少量同型 4 对 4：320 同源 render 帧，74 draw、58 shoot、58 arrow-hit、6 death，最后双方各 1 存活；活人最小中心距离 2.25999729，原半径和碰撞保留。实际晚帧倒地形态已检查，6 名 Death 完成并 settled。
- 主混合 32 人真实开战 / 暂停 / 重置：初始 / 重置红 16 蓝 16，交战红 16 蓝 11；五 GLB 200、浏览器 errors 0。正常权限全量 767 / 767、相关 19 / 19、build 通过。
- 骨 / 资产不回归见 `.omc/evidence/archer1/invariants.json`：19 骨节点 transform 和 inverseBindBytes 相同；13 个既有 GLB hash 与 HEAD 一致。原生 Bow / flexible string / Arrow 接口保留。源码最后的 movement capture 扩为全序列 10Hz 仅在 QA capture=1，重放会重置帧数组，已检查语法 / build / 相关测试。

保留 M1 起停局部足滑与 C1 宽外翼边界 P2；新增箭袋 / 分段背带仅为本种识别，未制作完整箭袋取箭动作，动作仍是原生持箭准备 / 拉弦 / 放箭。

完整 raw 录像、准确连续帧与 trace 本地 `.omc/evidence/archer1/`，不进 Git；精选证据 `docs/visual-iteration/archer1/`。箭物理专项仍在后续队列，本项只核验原接口兼容，未改箭伤害 / 射程 / 射速、碰撞半径、人数、场景光照或镜头。

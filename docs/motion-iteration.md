# 剑盾兵动作迭代

## M1：行走、转向与起停（2026-10-12）

技术验证通过；内部视觉验收通过（独立 Review 与总控实际同步帧核验，保留 P2）；用户明确认可：未知。已形成移动阶段基准，下一项两人交战正在执行，不等待逐项 OK。

基准为 R1.1 静态网格和18骨接口。独立动作资产 public/assets/3d-sample/locomotion1/infantry-rigged.glb，SHA256 edd8cc96e804f3d63ca1408c5c63111f382d17196538fb153bcba868a57ad504，增加 Walk .75s / Turn .5s；R1/R1.1及原默认资产保留。

实际基线：位置立即沿新目标方向走，而朝向另以5rad/s转；动画仅按moving固定播1秒Walk。实测根朝向与位移最大偏差173.26°。未发现同态每帧重启动画。

修改：剑盾 opt-in 根运动协调（按真实heading前进、有限转速与大转角减速）；最终碰撞分离后的真实位移调步频；支撑/摆动Walk、小步Turn及限定剑盾骨链的平滑接地校正。不移动模型掩盖真实碰撞位置，不改变伤害、范围、碰撞半径或其他兵种规则。

首版锁足在半周期/动作切换直接松锚导致脚弹跳，已返工为接地渐入、离地与状态退出约.12s残余修正渐退。首版与返工证据分存，不覆写问题版本。实看的是正常1x录像的同步渲染帧/contact sheets，未将读取抽帧描述为完整观看视频。早期按录像总长度估时轴的sheet不用于验收；最终采用同一render调用的PNG与精确sim时间/trace。

六操作同序列基线/候选各1441逐帧轨迹；4兵共同目标收敛真实接触最小距2.059994（规则contact2.06），阻挡低速Walk空踏0。主32人完整兵种候选已实际开战14s并reset，errors0，初始/重置红16蓝16。build通过，765/765测试通过。默认非候选路径、其他兵种和主人数保留。

P2：局部转/停/短目标仍有快速收脚与少量足滑，剩8~11cm数值峰对应实际较快重摆足，独立同步帧Review与总控判为非阻断；不是已经完美自然。后续真实交战若暴露新回退继续修。

可玩32人：http://localhost:5301/battle3d.html?motion=candidate
单兵重放：http://localhost:5301/battle3d.html?qa=single&motion=candidate
碰撞重放：http://localhost:5301/battle3d.html?qa=small&motion=candidate
回退对照：motion=baseline（QA中使用R1.1模型和原移动/动画运行）；主原版无query。

正常速录像与原始数据（本地、Git忽略，避免大量录像入库）：.omc/evidence/locomotion1/baseline-single/、candidate-single/（首版问题）、candidate2-single/（返工）、candidate2-exact/（精确帧/trace）、candidate2-small/。正式摘要与同步sheet：docs/visual-iteration/locomotion1/。每帧图注是sim时间与heading。

当前分支 codex/sword-shield-round1、HEAD d6787a8 仅本轮live快照，全部候选dirty未commit/push，后续恢复重新实测。

## D1：两名剑盾兵交战

技术验证通过；内部视觉验收通过（独立只读 Review 与总控核验）；用户明确认可未知。已保存交战阶段基准，下一项 4v4→16v16，未经用户表达不写成用户满意。

实际原因：原 Attack 近距离仍在自身一侧摆剑，真实伤害发生却缺少打到对方的读感。仅修改剑盾候选 Attack 的肩肘腕与前送轨迹，保留 M1 移动和 R1.1 形体；不改伤害、攻击范围、先手顺序或受击取消规则。

独立资产 public/assets/3d-sample/duel1/infantry-rigged.glb，SHA256 61180645e4a8ee8533da2e8c41f9eecbbc48511bba5529ce53168c12be83ffcb。复用真实 stepSkirmish 前摇、伤害、受击取消与死亡，qa=duel 仅设置两名剑盾平地近景，主场仍为 32 人全部原兵种。

正常速度实际录像与同一次渲染 PNG：基线 trace 1081 帧、候选 trace 1079 帧，均 errors=[]、真实事件28条；终态死者 DeathComplete/corpseSettled=true。独立 Review 实看出手、受击、死亡同步 sheets 与 raw frames，确认剑轨迹进入对方前盾/肩颈，Hit 与 Death 来自真实事件。独立 Review 重新以现存候选 1079 帧的每帧精确 dt 重放，locomotion=true 根轨迹总误差 1.385e-12、最大 8.88e-16；false 总误差 11.9767、最大 .0608，确认包含 M1 真实协调。早先1081帧读取发生于重录前，当前候选以1079帧为准。

限制：既有固定数组红先手压制与受击打断仍保留，不在本轮改平衡；M1 快速收脚/局部足滑 P2 未声称完全消除。完整正常速度录像以连续渲染帧、同步序列自检与独立复审，不冒写人工观看完整 WebM。

候选重放：http://localhost:5301/battle3d.html?qa=duel&motion=candidate&duel=candidate
基线重放：http://localhost:5301/battle3d.html?qa=duel&motion=candidate
主 32 人组合：http://localhost:5301/battle3d.html?motion=candidate&duel=candidate
点击“重放双兵交战”运行同样初始条件。基线保留 M1、仅回退 Attack；motion=baseline 且不带 duel 则回退 R1.1 原动作协调。原默认路径无 query，未替换默认资产。

精选动态同步图保存在 docs/visual-iteration/duel1/{baseline,candidate}-{first-attack,hit,death}.png。原始录像本地存在且 Git 忽略：
- [M1 修改前录像](/Users/linshen/Cursor/ancient-battle-sandbox/.omc/evidence/locomotion1/baseline-single/page@958c948414cad8c06e1d19bd7e15e931.webm)
- [M1 最终精确同步候选录像](/Users/linshen/Cursor/ancient-battle-sandbox/.omc/evidence/locomotion1/candidate2-exact/page@8894164bda7101f2fa5a19c8351a9851.webm)
- [D1 候选录像](/Users/linshen/Cursor/ancient-battle-sandbox/.omc/evidence/duel1/candidate/page@eab1a7316bf160a8482f40898f0aa64b.webm)

文档收口只修改本任务 docs 与精选证据，无源码/资产改动、无 Git 写/commit/push，不抢或删除原 worker lease；原 worker capacity 失败后由总控明确交接文档所有权。lease 位于 .git/agent-git-writers，owner codex-soldier-candidate；有效性未据过期时间擅自推断，后续 Git 写须原 provider 核验/合规释放。

最终 D1 主32实测（独立只读 Review，2026-10-12）：14s交战/暂停/重置，初始与重置红16蓝16，交战红16蓝12/骑兵冲锋6；候选步兵及长矛、弓兵、骑兵、塔全部实际加载，console/page errors=[]。证据 docs/visual-iteration/duel1/battle-smoke.json。
KB 当前权威已由总控按SOP精确原路径 manual_override 原子落盘回读，SHA256 caeda17bb483e244d18b6376948773988d7d49b57164872407642290be037f8d；单文档 validate errors=0，未 commit/push。

## C1：4 对 4 → 16 对 16 的拥挤与战线（2026-10-12）

沿用 M1 移动/D1 攻击资产，未改 GLB、碰撞半径、伤害、近战距离、兵种或原 32 人主场。`crowd=candidate` 仅对启用 M1 的剑盾兵调整近同伴外肩绕行；`crowd=baseline` 保留原 M1/D1 运行。4v4 平地错列队伍使用真实 stepSkirmish，原版后列在同伴后等位，首攻 10.984–19.567 秒。没有证据表明本段存在目标频繁重选或阻挡原地空踏，因此移除首版预防性目标迟滞，不将这两项写成已修问题。

C1 最终 4v4 候选自检：后排首攻均 4.117 秒，有限绕肩后形成展开的接战线，死亡腾位后继续真实交战。原规则固定红先手仍保留，绕行使参战次序/终态变化，不保证与基线相同战果。技术检查 37/37 相关测试通过；4v4 独立内部效果 Review 与总控实际同步帧复核通过（无明显叠身、绕圈、骨断、脱手；接触最小距 2.059991，阻挡原地 Walk 0）。用户明确认可未知。16v16 技术与独立内部效果 Review/总控实际帧核验也已通过（COMMENT/P2 外翼宽展开）。三项均未记录用户明确认可。首版 candidate-four 含目标迟滞，已废止为验收对象；最终记录 candidate2-four。安全修正（目标之前才认同伴阻挡、零计划清除诊断 blocker）按最终录像 1920 精确 dt 重放，物理差 0、事件差 0。

4v4 实测地址： http://localhost:5301/battle3d.html?qa=four&motion=candidate&duel=candidate&crowd=candidate 。点击“重放4 对 4”；“M1/D1 基准 / 多人候选 C1”按钮切换并保持机位、人数、初始阵列、GLB与灯光。32 秒正常速度录像与同次 render PNG/逐帧 trace 保存在本地 Git 忽略的 `.omc/evidence/crowd1/{baseline-four,candidate2-four}/`。sheets 图注来自原渲染 frame 的精确 sim 时间，未将读取连续帧描述为人工完整观看 WebM。M1/D1 核心运行快照在 `.omc/evidence/crowd1/m1-d1-snapshot/`，独立 assets 路径未动。


16v16 同场景错列四层队伍：基线 trace 1920 / render 320，候选 trace 1911 / render 320，errors 均 0。候选外侧后排约 4.08、6.22、10.08 秒陆续加入，形成更宽连续接战线；真实攻击/受击/死亡继续执行，26.9857 秒蓝方最后死亡，最终红15/蓝0；基线32秒红11/蓝5。实际战果变化是参战分配变化与既有先手规则共同造成，不宣称平衡改良。候选28人曾首攻/4人未轮到（基线27/5），死者腾位后仍继续寻敌；独立 Review 连续末帧确认战后位置稳定，无明显叠身、绕圈、骨断、脱手、边界反转。

保留 P2：候选最外翼最大 |z|=12.978，靠近真实边界13；晚段个别外翼靠画布下沿、局部脚底裁切。没有为掩盖问题改变镜头/人数/碰撞，不代表完美队形或容量结论；后续混合兵种若暴露不可收敛拥挤再针对实际问题返工。M1 快速收脚/局部足滑仍保留。

16v16 对照： http://localhost:5301/battle3d.html?qa=sixteen&motion=candidate&duel=candidate&crowd=candidate 。底部同样重放/切换；基线和候选初始场景、机位、分辨率1280×900、GLB、灯光一致，连续帧每条都有真实模拟时刻，不将 WebM wall-clock 估时轴当精确同步。8张精选 approach/vacancy 正式对照与指标存入 `docs/visual-iteration/crowd1/`；late sheet 和所有原录像/逐帧图仍保留本地 `.omc/evidence/crowd1/{baseline-four,candidate2-four,baseline-sixteen,candidate-sixteen}/`，未删除原 R1/M1/D1 产物。

验证：相关37/37通过；build通过（既有大chunk警告）；全量767/767正常权限通过。第一次 sandbox 全量765/767，两项 arena-server listen EPERM，经正常权限全量重跑确认环境原因；judge triage 已按纪律尝试，但因 ancient-battle-sandbox 项目配置不存在退出2，无报告/反馈结果，未伪造工具判定。混合32主场真实14秒开战/暂停/重置：初始与重置红16蓝16，交战红15蓝12；剑盾D1、长矛、弓兵、骑兵、塔五GLB均HTTP200，errors=[]。证据 `docs/visual-iteration/crowd1/mixed-smoke.json`。

R1.1/M1/D1 GLB SHA256 与施工前快照完全一致。本轮新增的是 runtime opt-in C1，不新增模型资产，也未设为无query默认。回退 C1 用 `crowd=baseline`（或删除crowd），保留 motion=candidate/duel=candidate 即 M1/D1；继续删除duel或motion按上述记录逐级回退。用户已授权本系列适当 commit/push，Git SHA/远端回读另据真实收口回执，不以历史dirty快照当live。下一项：长矛兵实际诊断，尚未开始重做。

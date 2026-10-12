# 3D 持续总控入口

当前目标：固定斜俯镜头下的 32 人战斗观感验证版，简洁统一成人士兵风格，保持 2D 识别特征。当前阶段基准 R1.1：public/assets/3d-sample/round1-1/infantry-rigged.glb。详细视觉历史和证据只维护 [视觉迭代记录](soldier-visual-iteration.md)。

长期规则/队列：[KB 当前 3D 总控权威](/Users/linshen/kb-vault/projects/古代战争沙盒-3D持续总控与待办.md)；[项目固定入口](/Users/linshen/kb-vault/projects/帝国亲子沙盒-当前推进索引.md)。来源为用户 2026-10-12 贴入的持续总控指令（完整原文保存在 KB notes/20261012-古代战争沙盒-持续总控授权原文.md）。

历史保存回合仅保存规则和跟进逻辑；当前已实际完成移动 M1 与两人交战 D1 闭环，没有定时任务。R1/R1.1 技术制作已完成；用户授权采用 R1.1 作动作调试静态阶段基准，不能改写为“用户视觉满意”。旧视觉记录中的逐项等待确认是历史约束，现已被下述授权替代。

## 推进与验收

普通可回退本地工作已授权：一个主问题→实现→实际运行→效果检查→独立复审→返工或保存基准→继续下一项，无需每项再等 OK。分开记录技术验证、内部视觉验收、用户明确认可；最后一态仅凭用户反馈。保留基准与证据，不减兵种/碰撞/人数或绕过真实交战。付费、主要引擎调整、外部发布或真实不可解阻断带具体结果找用户；现有权限/Git约束仍适用。

## 当前待办与下一轮

当前主问题：长矛兵 P1 成人体态与持矛战备技术 / 独立内部效果通过，用户明确认可未知，下一项弓兵实际诊断；详见 [长矛记录](pikeman-iteration.md)。移动 M1、两人交战 D1、多人 C1（4v4 后 16v16）技术/独立内部视觉已通过，用户明确认可均未知；详见 [动作记录](motion-iteration.md)。

1. [x] 行走、转向、起停（M1内部通过，保留P2）。
2. [x] 两名剑盾兵交战（D1 内部通过，既有先手规则保留）。
3. [x] 4v4，再 16v16 的多人移动与战线（C1 内部通过，外翼近边界 P2）。
4. [x] 长矛兵 P1 技术与独立内部视觉通过；[ ] 弓兵、骑兵。
5. [ ] 箭矢、冲锋、尸体与动作协调。
6. [ ] 完整场景地形、建筑、镜头、光照。

下一轮保留 R1.1/M1/D1/C1/P1 基准，按兵种逐项推进，先弓兵实际诊断静态轮廓、双手持弓与放箭接口，再集中一个主要问题做候选和实机独立复审。弓兵尚未开始重做，不提前记为通过。C1 不改 GLB、原规则/半径/伤害/兵种人数；未确认的目标迟滞已删除。

里程碑后：先复用2D共享模拟（时钟/命令/随机/事件/伤害一致），再做明确设备、画质、人数的容量验证；软件渲染成绩不代表目标设备能力。

## 恢复检查点

每完成小项/关键决定/结束运行更新当前项、三态、队列和证据；详细造型历史只写视觉记录。恢复或压缩后先读本入口与当前项，核对 live Git/资产/产物，再从未完成步骤继续。

2026-10-12 保存时观察：branch codex/sword-shield-round1，HEAD d6787a8128b0cd7762b7aadc70262434a03051dc；已有 R1/R1.1 脚本、预览、资产、记录未提交且保留。本次没有 commit/push。以后重新采样，不将此快照当 live。

启动 npm run dev（5301）。基准复现：http://localhost:5301/battle3d.html?soldier=r11&view=near&time=0&solo=1；底部 R1/R1.1 可切换。是否有活跃服务须实测；没有会话结束后持续后台工作的承诺。

组合试玩：http://localhost:5301/battle3d.html?motion=candidate&duel=candidate
双兵对照：http://localhost:5301/battle3d.html?qa=duel&motion=candidate&duel=candidate；移除 duel=candidate 保持 M1 并回退原 Attack。重放按钮重新开始同一场景；详细证据与回退见动作记录。

最终 D1 主32实测（独立只读 Review，2026-10-12）：14s交战/暂停/重置，初始与重置红16蓝16，交战红16蓝12/骑兵冲锋6；候选步兵及长矛、弓兵、骑兵、塔全部实际加载，console/page errors=[]。证据 docs/visual-iteration/duel1/battle-smoke.json。
KB 当前权威已由总控按SOP精确原路径 manual_override 原子落盘回读，SHA256 caeda17bb483e244d18b6376948773988d7d49b57164872407642290be037f8d；单文档 validate errors=0，未 commit/push。


2026-10-12 C1 收口：4v4→16v16 已依序真实运行与独立复审，技术/内部通过，用户明确认可未知。相关37与正常权限全量767测试通过，build通过；主混合32真实14秒开战/暂停/重置，初始/重置16+16、交战15+12，五GLB HTTP200/浏览器errors0。保留M1局部足滑与C1宽外翼近真实边界、画布下沿局部裁脚P2；不把测试/软件渲染当美术或容量验收。正式指标/同步图：`docs/visual-iteration/crowd1/summary.json`；动态原录像本地 `.omc/evidence/crowd1/`。详细因果与回退见动作记录。

C1 4v4：http://localhost:5301/battle3d.html?qa=four&motion=candidate&duel=candidate&crowd=candidate
C1 16v16：http://localhost:5301/battle3d.html?qa=sixteen&motion=candidate&duel=candidate&crowd=candidate
混合32：http://localhost:5301/battle3d.html?motion=candidate&duel=candidate&crowd=candidate
底部“重放”开始真实交战，“M1/D1 基准 / 多人候选 C1”同条件切换。服务可达性只认live。无query原默认资产保持，删除crowd保留M1/D1。

用户本轮另授权适当commit/push，精确本系列源码/独立候选/精选文档拟里程碑提交到既有 `codex/sword-shield-round1` 同名远端分支；不 merge main、不推原录像/令牌。实际 Git 结果另见收口回执，当前保存时尚未提交，禁止预写已推送。

2026-10-12 P1 实施：在 HEAD 5457376 的既有工作分支续接，独立长矛候选 `public/assets/3d-sample/pikeman1/spear-rigged.glb`。原 M1 / D1 / C1 和原长矛资产保留；原生双手持矛 IK、攻击 / 伤害 / 碰撞规则未改。正式 Three.js 前后 / 动态 / 平地 / 4 对 4 / 混合 32 与独立复审已完成，技术 / 内部视觉通过，用户明确认可未知；详细状态与 P2 仅见长矛记录。下一项弓兵，尚未完成重做。当前用户授权适当本地 commit，暂时不要 push，覆盖早期拟推送口径。

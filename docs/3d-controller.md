# 3D 持续总控入口

当前目标：固定斜俯镜头下的 32 人战斗观感验证版，简洁统一成人士兵风格，保持 2D 识别特征。当前阶段基准 R1.1：public/assets/3d-sample/round1-1/infantry-rigged.glb。详细视觉历史和证据只维护 [视觉迭代记录](soldier-visual-iteration.md)。

长期规则/队列：[KB 当前 3D 总控权威](/Users/linshen/kb-vault/projects/古代战争沙盒-3D持续总控与待办.md)；[项目固定入口](/Users/linshen/kb-vault/projects/帝国亲子沙盒-当前推进索引.md)。来源为用户 2026-10-12 贴入的持续总控指令（完整原文保存在 KB notes/20261012-古代战争沙盒-持续总控授权原文.md）。

历史保存回合仅保存规则和跟进逻辑；当前已实际完成移动 M1 与两人交战 D1 闭环，没有定时任务。R1/R1.1 技术制作已完成；用户授权采用 R1.1 作动作调试静态阶段基准，不能改写为“用户视觉满意”。旧视觉记录中的逐项等待确认是历史约束，现已被下述授权替代。

## 推进与验收

普通可回退本地工作已授权：一个主问题→实现→实际运行→效果检查→独立复审→返工或保存基准→继续下一项，无需每项再等 OK。分开记录技术验证、内部视觉验收、用户明确认可；最后一态仅凭用户反馈。保留基准与证据，不减兵种/碰撞/人数或绕过真实交战。付费、主要引擎调整、外部发布或真实不可解阻断带具体结果找用户；现有权限/Git约束仍适用。

## 当前待办与下一轮

当前主问题：L1 灯光候选技术 / 独立内部限定通过，用户明确认可未知；详见 [光照记录](lighting-iteration.md)。M1/D1/C1/P1/A1/V1/Q1/T1/B1/C2 基准保留。下一阶段已做[共享模拟只读差异审计](shared-simulation-audit.md)，首次箭逻辑提取仅建议，尚未实施。
1. [x] 行走、转向、起停（M1内部通过，保留P2）。
2. [x] 两名剑盾兵交战（D1 内部通过，既有先手规则保留）。
3. [x] 4v4，再 16v16 的多人移动与战线（C1 内部通过，外翼近边界 P2）。
4. [x] 长矛兵 P1 技术与独立内部视觉通过；[x] 弓兵 A1；[x] 骑兵 V1 本轮骑手形体。
5. [x] 箭矢、冲锋、尸体与动作协调：Q1 技术 / 独立内部通过，用户未知。
6. [x] 当前完整场景限定检查：[x] T1 活人步兵地形接地；[x] B1 建筑比例；[x] C2 主场取景；[x] L1 光照。技术 / 独立内部通过不等于用户整体验收或容量验证。
7. [~] 共享模拟：只读差异审计完成；[ ] 首次2D箭更新纯逻辑提取，尚未实施。

下一轮保留 R1.1/M1/D1/C1/P1/A1/V1/Q1/T1/B1/C2/L1 基准。L1只调整既有两光色彩与强度，16GLB / 材质 / C2镜头 / 光位及阴影参数 / 规则不变，技术与独立内部限定通过，用户未知。当前2026-10-12用户授权适当本地commit及push，覆盖历史NO PUSH；仅既有codex工作分支、不merge main / 不部署，实际结果以总控Git回读为准。

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

2026-10-12 A1 收口：独立弓兵候选 `public/assets/3d-sample/archer1/archer-rigged.glb`，19 骨（18 人形 + Arrow）bind / inverseBind 不变；13 个既有 GLB 保留。正式静态 / 平地 / 正常六类移动 / 真实箭事件双兵 / 4 对 4 / 主混合 32 与独立复审已完成；767 / 19 / build 通过。技术 / 独立内部视觉通过、用户明确认可未知，下一项骑兵；箭物理专项未完成。详细采样边界 / P2 仅见弓兵记录。当前授权适当本地 commit，NO PUSH。

2026-10-12 V1 收口：独立 `public/assets/3d-sample/cavalry1/cavalry-rigged.glb`，原生34骨bind / inverseBind与Idle / Walk / Attack / Hit / Death / Charge六动作bytes保持，14此前GLB hash不变；仅骑手连续肩、袖与胸腰形体，本轮技术 / 独立内部视觉通过，用户明确认可未知。正式19静态 / 平地采样、两版各240移动同源帧、最终±8骑兵QA双兵各180帧真实charge2/hit5/death1、4v4 charge4/death6、混合32初重置16+16交战16+11/errors0，767 / 19 / build通过。最后小QA间距调整后19/build再通过。详见 [骑兵记录](cavalry-iteration.md)；保留挺直骑手 / 长板袍、原马步几何与坡地不逐蹄贴合、整马侧倒带骑手P2，未全面验收马步 / 控制 / 骑兵整体艺术。下一项箭矢、冲锋、尸体与人物动作协调专项尚未执行。NO PUSH。


2026-10-12 Q1 收口：持箭由实际draw / shoot事件移交，从Arrow骨起飞并沿显示曲线俯仰；实际charge来源胸反馈维持Hit / Death优先；弓兵Death原低垂手 / 弓抬起整尸已用相连体侧放臂修复，clamped末态缓存防恢复 / 漂移。15 GLB和combat-model bytes不变，正常18秒双兵两版、32秒两兵种4v4两版、混合32两版真实录像与对照完成，773 / 39 / build通过；独立内部通过、用户认可未知。当前本地commit授权，NO PUSH。精确事件 / 接地数值 / 实时dt和修复前归档边界仅见 [协调记录](coordination-iteration.md)。下一项完整场景接地与建筑比例，不在Q1修改镜头 / 光照。


2026-10-12 T1 收口：实际靴底14局部点 / 脚、±0.18m踝高与0.28rad倾角限幅，原根高度不变，native lift 在 M1 支撑锚前缓存，mixer 前还原常值骨姿防累计。三兵种静态各两版23采样、正式移动各两版240同源PNG、mixed两版16+16→16+10→reset16+16/5GLB200/errors0；相关26 / 全量780/780 / build通过。独立内部限定通过、用户未知；保留动态起停/转身约2.2cm入地 / 4.6cm悬空P2，不扩大马逐蹄 / 建筑 / 镜头 / 灯光。详细采样版本和baseline动态metrics边界仅见 [接地记录](terrain-iteration.md)。适当本地commit，NO PUSH。


2026-10-12 B1 收口：基于442eb1f，仅实际两座装饰塔，独立building1/tower.glb SHA256 8932d1896158503d6dd5903ed887ec5381ccc6fbefc6d743b599b806a9f82666，15旧GLB保持。按currentD1战士Idle头顶相对root2.5670校准真实门净高2.785/上层净高2.855，platform3.50；未整体缩放士兵/塔，原root/摆位/默认FOV38相机/灯光/terrain/rules保持。实际页面1280×900、canvas1280×695，近/默认/侧/背与mixed32正式对照；两版glbHTTP200/errors0，初/重置16+16/交战14s暂停16+11。最终780/780/build/组合加载及nearreset严格samepose检查通过，独立APPROVE内部限定比例，用户明确认可未知。原无碰撞塔/无楼梯室内/2D石构上层未重建保持。NO PUSH，仅本地commit按实际Git回读；下一项镜头独立检查，光照未实施。详见建筑比例记录。


2026-10-12 C2 收口：基于B1本地109279300e82a9503a906651c7b930370e6ebb85，仅normal32初始 / reset / 全景opt-in44m、focus(0,0,4)，FOV38 / 朝向 / 灯光 / 16GLB / 规则保持。配对1280×900 / canvas1280×695；初始deformedmesh旧底出画26.4319px，新余75.7418px，两塔顶余18.7194px。两版各23实际检查通过、五GLB200/errors0；鼠标sameunit选择 / 原点ground命令、± / wheel / selected / overview / reset以及QA4 / 16和B1still旧机位正常。14秒1x动态七连续实拍PNG / WebM，末态dt差异旧27 / 新26活人如实记，不宣称逐帧战果一样。full780/780 / build退出0，独立readonly复审限定APPROVE，用户未知。板前角仍部分出画、任意位置/手动zoom不保证，NO PUSH，下一项仅灯光尚未实施。详见[取景记录](camera-iteration.md)。


2026-10-12 L1 收口：固定C2镜头及16GLB，只改原hemi / sun色与强度，保留shadow geometry / 材质 / gameplay。真实两版各98检查、四组Idle0静态camera / canvas / root-scale / material等严格相等，GLB200 / errors[]，reset32全血；7次约2秒等待连续PNG和WebM，末elapsed15.784 / 15.118、均26活人，非同源逐帧战果。full780/780 / build退出0，独立限定APPROVE、用户未知。精选10图及机器summary见光照记录；原方向阴影保持、未宣称全面艺术 / 容量通过。随后只读共享模拟五项差异审计，首个箭逻辑提取未实施。当前用户授权push，实际commit / pushed_verified由总控记录，不复用历史NO PUSH。

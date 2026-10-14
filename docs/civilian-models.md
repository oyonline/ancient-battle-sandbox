# A / C 成人比例剑盾样板

2026-10-14 用户选择 A 与 C，授权两者配剑、小盾，保持原参照真实身高的 30%，接原三招与真实格挡。入口 `http://localhost:5301/ac-duel.html`，默认 A 对 C，可同款、交换阵营、重新交战、暂停、拖动视角。旧 KayKit / Quaternius / 原模型入口保留。未提交、推送或部署。

## 来源与本地范围

- A：Leonardo Carvalho，**.Fuse Civilian 1**，官方页面 <https://sketchfab.com/3d-models/fuse-civilian-1-6fc4bddf4d364e6b9fa2f050011e03ce>，CC BY 4.0 <https://creativecommons.org/licenses/by/4.0/>。2026-10-14 用户登录后经正式 Download UI 下载；原始与派生文件 SHA256 见 sources.json。
- C：Leonardo Carvalho，**Medieval Civilian 3**，官方页面 <https://sketchfab.com/3d-models/medieval-civilian-3-d99ca22f06134e8dab28fdfa75d87f31>，页面 Free Standard。仅限用户已授权的本机样板，未把独立模型当作可公开分发资产。
- 源文件真实包含 66 骨 Mixamo rig，但动画 `mixamo.com` 时长 0，不能称原作者提供了三招。保留原皮肤权重；将旧 specular/glossiness 材质的原 diffuse 纹理转换为 Three 可读 PBR，保留深棕皮革色。
- 躯干基础动作来自已经获得的 KayKit Adventurers 1.0 Knight CC0；成人手臂与双腿按原骨长做语义 IK，独立编制横斩、举劈、刺击腕部轨迹、成人步幅、握柄手指和倒地顺序。剑与圆盾为本项目原始几何。不是把 KayKit 的四肢长度套给成人。

官方原件与派生 GLB 均在 Git ignored 的 `local-assets/ac/` 本地流程内使用；仓库不含该模型二进制。Vite 插件仅给 loopback 的四个固定文件提供 `/local-models/ac/`，阻止默认 `local-assets`、`@fs` 与编码路径。生产构建包含入口壳，**不包含 A/C 私有模型**；其他机器须先合法取得源资产才能运行此页。

## 适配与规则边界

身体脚底到头顶归一至 2.6122968197，再乘 0.3，实际参考高度 **0.7836890459m**；保留两者原头身比例。`civilian-animation.js` / `civilian-performance.js` 独立实现语义映射、局部轴、手指卷曲、剑尖/盾面标记、三招、承力与倒地。旧 LibraryAnimation 与 KayRefinement 不变。

`SwordDuel` 完全未改，HP140、seed728、招式伤害/概率/抽样/取消与同时死亡规则保留。逻辑接触时间横斩 0.48s / 劈砍 0.72s / 刺击 0.30s，映射到导出片段的 0.256 / 0.587 / 0.42s；生成器保留此元数据。出招、真实 hit/block、死亡优先均按事件；守势提前迎盾不预测随机结果。受击保护期仍有轻微躯干反馈。

倒地使用离线编制的成人屈膝、支掌、髋胸落地顺序，选择空侧方向。整个倒地的鞋底支撑按原顶点和皮肤权重离线校准，运行时沿用原有身体支撑的小残差纠正。它是受约束的关键帧表现，不是布娃娃物理。接触窗含有限手臂 IK；画面观感仍由用户判断。

## 重现和验证

1. 合法下载两份官方 GLB；用 `tools/convert-civilian-materials.py` 转换旧材质。
2. Blender 运行 `tools/prepare-civilian-models.py -- A_PBR_GLB C_PBR_GLB KAYKIT_KNIGHT_GLB OUTPUT_DIR`，派生文件放 `local-assets/ac/`。
3. `npm run dev`，进入 `ac-duel.html`。`node --test tests/three-civilian-models.test.js tests/three-sword-duel.test.js` 2026-10-14 自然动作二轮 18/18，0 fail / 0 skip；缺少合法本地模型时资产测试明确 skip，不伪报资产通过。

初版针对性构建退出 0；技术审发现的 Vite deny 覆盖默认项已修，并新增 1/1 配置策略测试通过（未读取敏感文件）。GET/HEAD 的18项实测、LAN handler拒绝、构建产物不含私有 GLB、暂停/重开/同款/换边与支撑数字见 `docs/visual-iteration/civilian/summary.json`。原始逐帧和视频在 `/private/tmp/ancient-ac-models-20261014/`，不进 Git。

初版独立技术审 APPROVE，视觉审 APPROVE_WITH_NOTES，requiredRemaining=[]。技术审另核 21 秒规则 trace 与无渲染基线完全一致（47 事件/80 抽样/HP[-2,2]），61 个关键点各追加 3 次零 dt 无累计；旧 Kay/Library/SwordDuel 文件字节未变。视觉独立低侧角确认胸髋/鞋底支撑与持盾问题已关闭；保留“倒地中段仍略整体僵硬、并非物理布娃娃”说明，不代用户宣称满意。最终审查收据位于同目录 technical-review.json / visual-review.json。

## 2026-10-14 自然动作二轮

冻结版本 `ac-natural-20261014-final2`。原模型、30%身高、材质和 `SwordDuel` 规则保持；本轮修改成人动作导出和独立表现层，不增加新模型或美术内容。

- 肘/膝使用角色解剖方向的显式 pole 和最小/最大屈曲可达范围，避免接近伸直时翻面。横斩腕部轨迹插值完整姿态，收招最后键直接回同一个 guard quaternion；不只闭合剑尖方向而留下 86.68° 的腕部 roll。
- 运行时剑尖贴近接触点前，先扣除实际刀身长度，再解可达腕部位置。削除原先举劈 1.4–1.65 倍臂长的目标请求。接触/出收招使用平滑权重，接触后骨盆的卸力项用 0.10s 平滑起幅；收步到守势混合 0.24s，格挡恢复混合 0.14s。
- 倒地先屈膝失重、手臂支撑，再髋胸落下；移除原先运行时胸颈各约 54°、手肘约 100° 的强压。A 的臀部衣物最低顶点为纯 Hips 权重，不能通过强弯膝盖解决。末段按两款各自原衣物/鞋底支撑面离线校准，接触同时烘焙到骨盆轨迹，完成后运行时整人抬升约 0。源皮肤权重没有改写。

final1 独立复核发现末帧通过仍不能覆盖中段：A/C 鞋底曾在倒地中段穿地 12.2/16.6mm。final2 增加逐源帧鞋底几何约束，将已有身体支撑下沉纳入离线目标；髋腿从同一准备姿态短渐入，避免动作过渡把鞋底插值到地面下。源帧保留约 0.784mm 插值余量；原活动作的 8 个片段、每款 1584 个轨迹数值完全一致，运行时 JS 未改。

最终产品必要测试 18/18、0 fail / 0 skip，Vite build 退出 0；测试覆盖两种阵营的真实 seed728 事件到倒地，以及 120Hz 全程原鞋底顶点与零 dt 暂停。1mm 为本轮数值容差，并不宣称数学零。作者侧 120Hz 真实准备姿态转倒地最坏鞋底残差 A −0.515mm、C −0.252mm，末帧两款鞋底约 +0.783mm；头部 A 约 0.2mm、C 约 0mm，胸部衣物最低点 A 约 22mm、C 约 10mm。独立 240Hz 真实 seed728 / 换边复核 APPROVE，requiredRemaining=[]；入口、中段及全过程低侧接片无可见鞋底切入、明显全身抬升或新突跳，1–2s 原失败窗口鞋底最低 A +0.172mm、C +0.561mm。该结论只覆盖本鞋底窄修。

本轮冻结摘要与独立审/关键帧归档见 `docs/visual-iteration/civilian/natural/`，逐帧与原始日志在 `/private/tmp/ancient-ac-natural-20261014/`。仅完成本机候选，未 commit、push 或部署。

独立收据：[verdict.json](visual-iteration/civilian/natural/review/verdict.json)。实页面关键图：[A 全过程](visual-iteration/civilian/natural/review/visual/a-death-low-side-full.jpg)、[C 全过程](visual-iteration/civilian/natural/review/visual/c-death-low-side-full.jpg)。


## 2026-10-14 交锋承重轮

本轮本机候选保留 A/C 原身体网格、UV、PBR、皮肤权重及 0.7836890459m 高度（30%）。`SwordDuel`、伤害/格挡抽样、接触时刻与模拟单位坐标/朝向均不改，未 commit 或 push。

- 盾后横柄由实际卷曲中指指节的几何圆拟合，增加横握柄与支柱；各指沿自身局部轴卷合，拇指独立对掌。原 skin 着色确认 A 的上翘轮廓属于 Index 群，A 左 Index 后两节按实际皮肤指垫有限拟合，保留 Thumb 掌侧小自然角，避免误拉掌皮。
- 手臂 IK 使用完整解剖 frame，去掉方向对齐后残留的源 axial twist。状态过渡混合未叠加表现覆盖的源姿态，避免反复抬盾；真实格挡的髋胸承力独立于抬盾准备权重。回弹作用在腕/躯干，不再在 110ms 内追赶整段 clip-time。
- 独立脚步层在模拟坐标之外编排有限踏入、侧移、退步与回收。落地脚保持世界锚，摆动脚实际离地；前脚落定后髋承重。步幅随成人实际骨长及尺度限制，不改规则距离。接触按近侧胸部真实 skin 三角面、真实盾 Wood/Rim/Boss 几何校准；胸骨/盾心 marker 只作诊断，不等同实体碰触。
- 倒地事件一次捕获已呈现姿态，不回 Idle；先膝软失衡、左盾支撑，再躯干落下与右臂放松。原鞋底全程几何约束保留，腕部残差沿原 bend plane 修正，并同时约束手皮肤和剑盾接地，避免全身抬升或大幅反关节。

验证范围为 seed728 正常与交换阵营的真实 `step → event → update → aim`，并覆盖 slash/cleave/thrust/guard/hurt 多入口倒地、零 dt 骨骼/模型/时钟/脚锚幂等、真实鞋/身体/装备支撑及有限关节。冻结回执、独立探针、实际握柄与低侧关键帧见本轮 `docs/visual-iteration/civilian/weight/`。数值与技术核验不代表用户对自然程度已经满意；这是受约束关键帧表现，非物理布娃娃。

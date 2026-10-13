# 模型造型标准：R2 → P2 → A2 → V2

2026-10-13 当前 R2 冻结候选已完成真实生成、游戏内静态与正常动态检查；高级独立视觉复审 `APPROVE_WITH_NOTES`，独立技术 QA `APPROVE`（末次纯标签修正补验通过），总控已接受 R2 作为下一兵种造型基准。**技术验证、内部视觉通过、用户明确认可分别记录；用户明确认可仍未知。**

用户本轮明确评价：候选与录像一致，模型、动作反馈和整体战争感三类不足同时存在，战争感最突出。授权先优化剑盾成为其他兵种造型标准，再依次长矛、弓兵、骑兵（马＋骑手），每项实际静态与动作检查、必要验证及独立复审通过后自主继续，不逐项等用户确认。共享模拟首次 2D 箭逻辑提取后移，未实施。

## 范围与设计

剑盾仅新增独立 `public/assets/3d-sample/sword-standard/infantry-rigged.glb`，默认入口及 16 个旧 GLB 保留。复用现有 Blender authoring helpers、18 骨 bind 和 D1 六动作路线；不复制另一份巨型四兵种生成器，不改战斗/时钟/伤害/命令、镜头或光照。

- 胸廓、腰、髋使用连续截面；罩袍贴合弧面、收腰并缩短下摆，留出有体量的大腿，避免前后长板。
- 袖子从肩至腕是连续软网格，肩根混合胸/上臂权重，肘部混合上/前臂；肩甲和前臂甲保留刚性并覆盖软袖，袖子体量适当克制。
- 裤腿呈现髋、大腿、膝、腓肠与踝的连续变化，护胫只是薄的外层；靴底及脚骨保持既有基准。
- 袍两半面统一外向法线；衣料一致向内 9mm 厚度。胸/腰局部增加 17–20mm 净距，后髋下摆按实际后截面修正，不整体平移袍子。
- 保留现有封闭盔、红蓝布、米色罩袍、狮纹盾身份；真实剑刃楔截面加宽 40%，刃轴与既有持握位置保留。

首稿胸袍出现可见黑色穿插，未获通过。实际 Three 射线证实甲比布外表仅前出 1–2.5mm；高级独立诊断确认局部截面几乎重合，并发现左右袍片绕序不同造成相反法线。已先统一法线再局部修净距。首/第二/第三稿及前修复版本的 PNG 均保留 `.omc/evidence/model-standard/`，不能当最终证据。

## 冻结候选与同条件对照

最终 GLB SHA256：`35aec7367cb8e8eabe7809e1aea449fcc81374fa73ffd81d8cb07d6c4883035e`。

静态最终原始证据：`.omc/evidence/model-standard/frozen-r2-final/`；`manifest.json` 把候选、生成器、PNG 指纹和条件绑定。来源是实际 `battle3d.html` 的 GLTFLoader / SkinnedMesh，独立 headless Chromium 页面，不是离线模型渲染。两版均 1280×900；同场景配对画布一致，近景1280×695、主场1280×666（模型对照按钮行数差别）；FOV38、相同 L1 灯光、材质体系、地形、单位位置与尺度；固定近景 10m，主场 C2 44m、focus(0,0,4)，主場隐藏选择环。

两版各 13 近景采样：Idle 前/侧/背；Walk .12/.25/.40/.60；Attack .12/.30/.46/.66；Hit .125；Death 1.25（沿既有尸体接地）；另两版主场。28 次实际采样有限顶点，20 次 GLB 请求 HTTP200，console/page errors=[]。

组合试玩在原全候选 URL 追加 `model=r2`；切 `model=baseline` 明确加载 D1。单独 model=baseline 也使用 D1，元数据与实际 loader 同源。`model=r2&still=1&view=near&solo=1&motion=candidate&duel=candidate&terrain=candidate&light=candidate` 为静态剑盾检查；`clip`、`time`、`angle` 沿用原采样接口。非剑盾 `unit=pikeman|archer|cavalry` 的 QA 不使用 R2 静态取空目标，其他兵种资产开关仍由原独立参数控制。

## 验证与三态

- 18 骨 bind transforms / inverseBind 数值与 D1 相同；Idle / Walk / Turn / Hit track 数值完全相同。Attack / Death 仅 Hand.R 浮点导出差，最大分别 `2.384185791015625e-7` / `1.7881393432617188e-7`，不宣称六动作逐字节全等。
- 16 旧 GLB 的 SHA256 均保持。候选 7,507 顶点、14,582 三角，较 D1 +56 顶点 / +132 三角；9 种原材料，不增加每模型材质数。
- 正常权限完整测试 780/780 通过；最终构建通过（既有 bundle 大小提示）。首次沙箱测试为778/780，两项 arena-server 失败均 `listen EPERM`；不是通过。按用户规则尝试 judge 本地 backend none，但本项目缺配置、exit2，无有效报告；全量正常权限重跑是通过凭证。
- 动态已真实运行两版：24秒移动命令序列；18秒双兵各 attack18 / hit9 / death1；32秒4v4各 attack72 / hit36 / death4，8→4→reset8；主混合32各32→27→reset32。主场暂停实际时刻 baseline14.48s / R2 15.73s（截图/浏览器时序造成超时），不宣称逐帧同步或相同战果源于严格锁步。40GLB请求HTTP200、errors=[]，采样中实际渲染顶点边界均有限。连续WebM、游戏事件和完整trace保留 `.omc/evidence/model-standard/dynamic-r2-final/`。
- 独立技术 QA：8个 model × single/duel × pikeman/archer 组合安全，单独 baseline 明确加载 D1；24坡面静态采样双版脚底gap差0，Death minimumGap=.025m；两版实际走坡4.566秒各274帧包含idle/turn/walk并有推进、有限数值，70GLB全部200、errors=[]。独立原始证据 `.omc/evidence/qa-standard-20261013/final-r2/`；范围限关键兼容性，非全设备或长坡全面验收。
- 高级独立 review requested `gpt-6-astra / high`、actual 模型/档位未知；正式 `APPROVE_WITH_NOTES`，实际回看final15图、SHA与关键源码。确认胸腰髋/衣甲/腿部改善、前/Attack/Hit已消除已知破口；头盔主要延续既有设计，44m主场提升较近景含蓄，未宣称战争感完成。廉价修正已吸收：R2单独入口的基准按钮也明确标D1，与实际切换目标一致。保留非阻断notes：肩甲暗杯口、腰带略凸。用户明确认可 R2 / 整体美术未知。

后续：独立复审发现实质问题则明确解冻返工并重采；R2 内部通过后再按统一胸腰髋、软硬层、成人比例和明暗分组推广长矛，然后弓兵、骑兵。不得减兵种或回避真实交战。既有 M1 局部足滑 / T1 小入地悬空 / C1 外翼与骑兵接地限制保留，未证明目标设备容量。

## 生成、恢复与授权边界

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python tools/generate-standard-soldier.py -- "$PWD/public/assets/3d-sample/sword-standard"
```

生成器复用 `tools/generate-rigged-soldier.py`，三个明确插入点变动时 fail closed；metadata 保存基生成器 SHA。metadata 与新 GLB 同目录；生成时的可编辑 blend 收口后转存本地 `.omc/evidence/model-standard/authoring/infantry-rigged.blend`，不进 Git。少量精选 PNG / manifest / summary 位于 `docs/visual-iteration/model-standard/r2/`。去掉 model 参数恢复原各阶段路由；model=baseline 直接恢复 D1 模型，不覆盖或重导出旧资产。

本轮 stable repo_id `github-repository:1200045147`；既有 `codex/sword-shield-round1`、开工 HEAD / 真远端 / exact fetch 一致 `ef4355ff01ec8995eac4dd06dc672e9ec1166944`，开工干净。唯一 writer `codex-native-asset-worker`，controlled_shared hot-zone `.`，review/调查只读。普通本地 commit 依唯一 writer / 精确文件 / 验证及独立 review 门，本地精确提交结果以收口Git回读为准；**本 task NO PUSH / NO MERGE / NO DEPLOY**。

KB 源尚未同步：目标已有 dirty，owner/handoff 未确认；仅保留总控候选 `/private/tmp/ancient-r2-kb-01a132c6/index.candidate.md` / `authority.candidate.md`，不能称作已落正式权威。当前施工推进状态以本仓记录与 live 实测为准。


## P2 长矛：技术与内部复审限定通过

独立 `pike-standard/spear-rigged.glb` 最终补件SHA256 `135115c7a5b01514ce75e13c614979d162242eeedd358e3cbb3f12aef0f920cb`；前稿 `f3d0f31…`因下述独立QA坡面回归已superseded，原截图/manifest/故障证据保留。`pike=standard` 继承 P1 原移动、Q1、T1和C1候选行为；`pike=candidate` 保留P1。`modelRole=pikeman` 仅选择造型视角/紧凑对照控件；配对混合主场两版都固定 `model=r2`，只替换长矛，旧入口不受影响。状态文字按实际资产来源派生，原始剑盾不误标D1。

复用已成立的胸腰髋、衣甲覆盖、短曲面罩袍与腿型；双臂按P1真实bind坐标造型。首稿保留旧持矛姿态，但实测杆中线x=.23穿胸；高级独立初审REVISE，不能因P1也存在而豁免。仅新P2后手/矛共同外移.13m、后收.06m，前手沿同杆后移.10m；最大刺击位移.21→.16m，事件时序/范围/伤害未改。固定骨长双臂IK实测104关键姿态，左臂最远.942837m / 最大.962083m，约19.25mm余量；upper/forearm scale 最大偏差1.3113e-6。

旧P1晚Death前手/袖低于人体，整体接地只保证全网格最低点，body-only实际仍悬空.3625m。初次新动作更高，已拒绝。P2晚段13→23双臂放体侧、左手释放、右手握全长杆沿尸体体侧铺平，跳过原作者在求解后再次覆写Hand.R方向的旧分支；0/5保持新guard入口。按原最终身体姿态在23帧形成末态，23→30保持，clip仍1.25秒。完整6clip名称、duration与18骨bind/inverseBind保持，动作数值明确有变，不宣称clip bytes或采样key数量相同（constant track优化会缩短部分输入数组）。Euler连续展开检查无跨π修正，不能把插值问题归因于已证实的Euler翻转。

返工实测还发现新袖子在回折右臂上误权重：实际前臂环因坐标投影落在上臂轴内，部分顶点归UpperArmR，晚态拉到身体下。现只新P2按tube明确环序分配Chest→UpperArm→肘混合→Forearm，消除支点；不重导已冻结R2。原17 GLB SHA保持；新网格5,467顶点/10,418三角/9种原材质，脚部主权重顶点96（每脚48）原始位置保持。

真实正式对照 `.omc/evidence/model-standard/p2/frozen-p2-final/` 共46采样，20GLB HTTP200，errors=[]；前/侧/背、Walk4、Attack4及侧视4、Hit、Death0/.08/.20/.54/1.25与main，1280×900视口，近景1280×695/main1280×666分别配对相同；固定L1/FOV38，近10m/mainC2 44m。manifest绑定GLB、当前main/generator和PNG SHA。额外 `.omc/evidence/model-standard/p2/pose10-death-slope/` 是72次真实23~30逐中间帧+hold：四朝向、原坡与QA平地，fullGap≈.025m、bodyGap最大.039379m，两者最大差.014379m，shaft torsoHits均0；body定义为主权重Hips/Spine/Chest/Head/Thigh/Shin/Foot网格，排除双臂与杆，不宣称人体每处均贴坡。

正常动态已完成两版24s移动、18sduel各14攻击/7命中/1死亡、32s4v4各56/28/4死亡（cancel1）、混合32→27→reset32；暂停实际时刻P1 14.4587 / P2 14.2782，不宣称两个wallclockrun同步。40GLB HTTP200/errors=[]、8连续WebM和trace保留dynamic-p2-final/；新P2实际duel末态full/bodyGap=.025（P1同跑bodyGap约.2807）。补真实Attack .4668极值、HP100→84命中、Death .05入口/1.25末态图与summary见contact-runtime-final/。正常权限全量780/780及build通过。高级正式APPROVE_WITH_NOTES；P3缺ring mapping静默fallback已改P2专用assert，真实全生成coverage与missing-key故障探针通过，公共f3 GLB不变；临时重导重要蒙皮/位置/normal/bind/动画数据相同，UV与一组三角索引有重导差，不声称bytes完全同。

独立技术QA仍在收口，并发现新增边界：qa=single、terrainScene=slope原单兵点x-3/z-1、朝向.6435，Death23~30/hold枪尖支撑导致bodyGap=.068868/fullGap=.025（该点不在上述QA平地72样本范围）；同点旧P1 bodyGap=.025，属于新局部回归。总控批准仅新P2 LateDeath右腕/全杆+50mm局部余隙，左手/旧资产/全局接地/时长不动。新135版目标坡四向bodyGap均.025，108真实末段/保持采样（原坡/单兵平地/单兵坡）最大bodyGap=.039379，fullGap≈.025；一次新真实duel死亡 body/full=.025。与f3重要数据等同的本地assert-coverage导出作有界semantic比对，仅Death右臂3骨track实差>2e-6，左手/非Death保持；浮点导出不声明bytes同。补件新图/manifest/.glb源码快照在frozen-p2-death-fix/，实际坡点见pose11-death-slope/，正常死亡见contact-runtime-death-fix/；两路独立补审已通过，总控正式接受P2。独立技术QA APPROVE：24实机点覆盖三个场景×前反方向×23/26.5中点/30/hold，body/full≈.025、杆torsoHits0；真实duel Death完成t10.6508/body与full=.024999996，实际坡走2.5498s/153帧有推进且finite，25GLB HTTP200/errors=[]，main32ef前后稳定、18bind/6实际duration/old17保持。高级视觉补审 APPROVE_WITH_NOTES，实看新side/Death.54/1.25与单兵坡前反5图及新SHA，确认腕袖连续、右手仍接杆、无新矛穿身或整尸体架起；范围限定本模型和实际采样，非全设备/全坡面/战争感完成。独立原始记录见qa-standard-20261013/p2-death-fix/。技术、内部视觉、用户明确认可分开，P2用户认可未知。NO PUSH/MERGE/DEPLOY；KB源因既有dirty owner-handoff未知尚未同步，仍见本篇R2的候选路径记录。


P2三态：技术验证限定通过；高级独立视觉APPROVE_WITH_NOTES、独立技术APPROVE，总控接受；用户明确认可P2/整体美术未知。高级requested gpt-6-astra/high、actual未知。前f3完整动态/全量780/build引用的是同一main32ef接线；最终只LateDeath右侧局部修复，不重复与改动无关的full，另完成目标坡/实际死亡和独立补验。保留靴底约6.5mm边界、T1局部足滑/坡足gap、主场44m细节提升含蓄、轻微衣甲视觉notes及此前系统局限；不证明数百兵性能。精选16图和绑定最终manifest见docs/visual-iteration/model-standard/p2/；真实连续录像raw不进Git。

下一项A2按轻装、兜帽、箭袋、连续躯干/袖与腿型实施；保留原19骨Arrow、Bow/String蒙皮与Q1释放接口，弯臂按明确环序权重，先不改骑兵。混合A/B固定model=r2&pike=standard，只替换弓兵。完成后独立复审再继续V2（马与骑手），不等用户逐项确认。

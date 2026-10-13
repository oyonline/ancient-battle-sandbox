# 模型造型标准：R2 → P2 → A2 → V2

2026-10-13 R2、P2、A2、V2 四种独立模型均已完成实际制作、游戏内静态/动作检查及独立复审，按各节限定范围由总控接受。本批最后 S1 共享尸体坡面支撑亦已实现、真实验证与两路最终 `APPROVE_WITH_NOTES`，总控正式接受受检范围；四类 GLB/16旧资产保持，783/783及build通过。A2/V2原坡面门由S1受检范围闭环，以下阶段故障历史保留。详见 [S1 记录](corpse-support-iteration.md)。**技术验证、内部视觉通过、用户明确认可分别记录；用户对原有整体的明确反馈是模型、动作和战争感均不足，四个新模型及 S1 的用户认可仍未知。**

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


## A2 弓兵：资产、生者与平地晚Death限定接受，坡面门开放

最终独立 `archer-standard/archer-rigged.glb` SHA256 `b5789081913da6f6c6d052602af6fe49e3e18b42b889d32dc6963db9dc2cfe27`；原188d首候选的造型/生者正项保留，晚Death已superseded。`bow=standard` 继承 A1 移动/C1/T1/Q1行为，`bow=candidate` 保留A1；`modelRole=archer` 只选对照角色。混合A/B固定SwordR2+PikeP2，只换弓兵；紧凑role selector、状态与metadata和实际资产一致。

沿用成人胸腰髋、短曲面罩袍与连续腿型，胸/肩/前臂/护胫采用轻皮革，肩片半径收20%、厚12mm，髋层红布；保留象牙兜帽、箭袋、背带、弓/弦/箭身份。只A2将首稿过厚颈块收至2.235m下颏；头/脸仍沿A1简化设计。折肘袖按明确ring权重，缺map fail-loud。7,061顶点/13,514三角/6种原材料；19骨、Arrow parent HandR、bind/inverseBind、96脚点与旧18GLB保持。

初始188d六clip数值相同，但真实Q1尸体最低HandR/leather：全mesh gap=.025，torso=.13773、legs=.14551、head=.25084，整段躯干悬空被高级review REVISE，不能因A1也有而豁免。仅新A2晚Death修改固定骨长Right肩肘腕，使弦中央随右手回到左手弓平面附近，保留8cm微拉；第一次Right-only去掉原右臂支点后剩HandL/Bow约33mm，再只作Late HandL绕弓长轴-.38rad（约22°）小roll，Left肩肘腕位置和全局Q1保持。右手nock随新弓平面求解，最大reach=.83420/.95403m，scale偏差≤6e-7。0/5入口、射击动作和事件保持，13→23平滑形成末态，23/30身体末态hold，Death duration仍1.25。最终Idle/Walk/Turn/Attack/Hit插值值与A1差0；Death仅Hips平移/旋转、HandL旋转、Right三骨旋转有有界实差。位置/法线/UV/蒙皮与188d相同，材质相同；一primitive索引导出排序不同，但oriented triangle multiset相同，不宣称整个GLB bytes同。

首候选42实机静态在 `a2/frozen-a2-first/`：前侧背、Walk4、Attack4/侧draw-release-recovery、Hit、Death入口及main；两版viewport1280×900，near1280×695/main1280×666各自配对同，FOV38/L1、near10m/mainC2 44m，20GLB200/errors=[]。高级独立造型/生者与main限定 APPROVE_WITH_NOTES；保留肩片偏平、hood脸简化、主场44m细节含蓄。

首候选正常动态 `dynamic-a2-first/` 实际两版24秒移动、18秒双兵各draw/shoot/arrow-hit16及death2、32秒4v4各draw78/shoot56/arrow-hit56/death6（8→2→reset8）、mixed32→27→reset32；40GLB200/errors=[]、有限bounds、8连续WebM。mixed实际暂停14.3437/14.3835，不宣称逐帧同步。全量780/780及build通过，Death-only后另最终build通过，不机械重跑无关全量。独立技术实际draw→release→flight→hit→death接口已验证，flight方向dot≥.999918；Q1全局源未改。

最终b578真实Q1双兵死亡 `.omc/evidence/model-standard/a2/runtime-death-roll1/`：elapsed14.7009、native Death完成1.25，full/主权重Chest=.025（最低v1273实际是原箭袋胸带第4段装备）、hips=.04395、legs=.03278、feet=.10664、head=.13811m；排除装备后胸腹布料=.073224、皮甲/皮带=.093081m。整段悬空明显改善，但不得称皮肤/全躯干贴地.025。弦心距弦端中点=.08000012m、弦长/端距=1.0075455，没有拖成跨尸体长V。最小冻结补件 `a2/frozen-a2-death-final/` 绑定GLB/main627120f…/generator c2f27941…及6张新有效图、分区/兼容与平坡对照报告。

有效控制夹具在实际battle3d actor中，以hp=-1、native mixer、原Q1 restBowArm及settleCorpse，固定(-3,-1)、平/坡四向、23/24→26.5/24中间→30/24→hold1.65，共32点：flat四向full/主权重Chest均=.025，最低装备与真正胸腹衣料分开记录。之前 `death-roll1-boundaries/` 夹具漏hp死亡使Q1持箭scale1、Arrow成为假支点，已明确INVALID并排除；修正是私有QA脚本，不是模型修复。最终有效组见 `death-roll1-boundaries-final/`。

**坡面门仍开放**：当前尸体root只有Y朝向，无随坡倾斜；正常可达qaSlope(-3,-1)大悬空为共享rigid-corpse限制。相同条件A1→A2 torso gap：heading .6435 `.4086→.4264m`（新增17.8mm、FootR支点）；2.214 `.1088→.025`；3.785 `.3551→.3159`；5.356 `.1122→.0761`。后三向改善不能豁免首向新增，也不能用Foot/body最低值替代胸髋支撑。旧A1同条件报告 `death-baseline-boundaries/` 保留。

总控2026-10-13范围裁决：A2资产/生者/主场/平地晚Death限定接受；坡面完整目标未通过。单列本批最后S1共享尸体坡面视觉支撑（纯renderer opt-in，保留T1/Q1及旧资产对照，不改规则/时钟/命令），在V2马＋骑手形体复审后实施，避免四类GLB盲调腕高。技术/内部视觉按上述限定范围记录，用户明确认可A2/整体美术仍未知；高级requested gpt-6-astra/high、actual未知。独立技术最终限定APPROVE_WITH_NOTES（Q1 on平地/资产；S1坡面开放）：25GLB200/errors=[]，自然持箭scale=.001，平地late/hold稳定，19bind/旧18/非Death/网格属性保持；实际最低点归原胸带装备，衣料/皮甲分区如上。Q1off原本仍有拉弦，A2 nock到弓平面距.7158 vsA1 .7431m略减，但弦长比1.6417 vs旧1.5258、总长约增加15cm，记为注意项；未见新增端点脱离/骨伸长证据，不宣称off是松弦。独立原始qa-standard-20261013/a2-death-fix/{summary,structural-summary}.json；总控结合高级既有造型/生者/main APPROVE_WITH_NOTES与实际平地补图判断，正式接受Q1on平地限定范围；高级坡面整体目标保持开放，不能写全坡通过。当前NO PUSH/MERGE/DEPLOY；KB源未同步的既有dirty owner-handoff限制保持。

A2 收口时的后续计划已执行：V2 独立马＋骑手模型见下一节。当前后续为 S1，共享坡面尸体支持门在下述四类模型基础上单独验证；整批最终状态见首屏及 S1 专项。

## V2 马＋骑手：技术与内部视觉限定通过，坡面S1开放

独立 `cavalry-standard/cavalry-rigged.glb` 新冻结SHA256 `6c6db675430b3b6b5b8881be0b374e86e64cec1b357c0195eacf852ff07cb649`。`ride=standard`继承V1/Q1 native行为，`ride=candidate`仍V1；紧凑角色selector加入cavalry，混合A/B固定R2/P2/A2，只换骑兵。原19GLB保持。

骑手新胸腰颈布层单独+1m，新袖/肩/护臂按真实骑乘骨轴造型，不重复平移；裤腿按原mounted_leg_point变换，显式作者环语义分配Thigh/Shin/Hips，侧别用L/R后缀，原脚/鞍/缰/握手保持。马只替换指定body/shoulder/hip球、颈杆/头吻球、腿杆/膝球/蹄：连续椭圆马身肩胯、弧线渐变颈头、肌肉到细腱、平底前低后高楔蹄；耳眼鬃尾与马具保留。HorseBody/Neck/Head与腿根/膝连接使用明确环权重。

新网格7,483顶点/14,350三角/9种原材质；34骨bind/inverseBind、Hips父HorseBody、四腿链、96骑手Foot点保持。骑兵不启用biped M1/T1骑手Foot锚为逐马蹄IK，旧马蹄坡接地限制保留。首稿cb06六clip插值与V1差0，实机44静态/动作/main配对20GLB200/errors=[]；生者高级独立APPROVE_WITH_NOTES，实看12关键图，成人骑姿与马体连续收益可见、无明显持枪/缰绳脱手或蹄腿断开，肩甲杯口和近镜蹄较方留notes。原生首稿与真实Death明确REVISE，不纳生者批准；快照 `v2/frozen-v2-living-first/` 保留cb06/main0a12/gen8c31及真实故障图。

真实flat首稿最低FootR/leather v72 gap=.025、HorseBody=.329037；同场V1 HorseBody=.329037，旧骑手下侧靴支点也抬整马，不能因历史存在豁免新标准。仅新V2晚Death将右腿向马肩外侧收拢，固定Thigh/Shin骨长，不塞进马腹；0/5入口、左腿/手/缰/鞍/整马侧倒路线与时长保持，13→23渐入、23→30随原马体末段。三key最大reach1.095901/1.479374m、scale偏差≤4.8e-7。Death仅Right Thigh/Shin/Foot三旋转通道实差，时长1.25；Idle/Walk/Attack/Hit/Charge插值差0。相对cb06位置/蒙皮/材质相同，金色UV float最大2.98e-8、头skin法线9.37e-5导出差，两组索引排序变但oriented triangles同，不宣称全属性bytes同。

新6c6真实duel死亡完成后full=.025、最低HorseHoofFR，HorseBody=.097699；骑手Foot=.145953、legs=.146327、hips=.330826、torso=.322896、head=.530492m。原骑手脚撑马已消除，马腿/蹄提供合理支持；整体马骑侧倒保留，马头/骑手头胸离地并非各部贴地，不新增下马或死亡物理系统。真实图/分区 `v2/runtime-death-leg1/`；8次真实平地入口/过渡/末态/hold采样 `death-leg1-mid/`。最终冻结 `frozen-v2-death-final/` 绑定6c6/main0a12/gen c3b6068a…、5晚段侧图/实际Q1图、结构/兼容报告。

高级独立晚Death补审APPROVE_WITH_NOTES，实看6图及新SHA：未见下侧靴继续顶马、换膝撑马、腿脚反折或可确认穿出马腹；2D遮挡不能证明内部零相交。生者批准按实际5clip与网格兼容继承。独立技术最终APPROVE_WITH_NOTES，总控接受：80GLB200/errors=[]，旧19/34bind/父子/六duration/五生者键值保持；Death仅右三骨旋转实改，translation/scale浮差最大5.364418e-7。12生者姿态四蹄最低gap5.0289mm、两版最大差1.8802mm；真实5.652秒走转与自然Charge（HP100→64）、Hit/Attack/Death完成1.25及分区支持通过。原不匹配入口 `ride=standard&modelRole=cavalry&qa=single&unit=pikeman&still=1&view=near` 在main0a12实际空target失败，现只main1e0dc使QA角色/控件/metadata按真实qaKind，旧独立比较匹配kind且有明确missing-actor guard，Terrain metadata含cavalry；原错配及infantry/archer边界、正常cavalry基准/候选已独立复验。新源快照 `v2/frozen-v2-preview-fix/`，GLB6c6/gen c3b保持，生者/Death几何批准不重开。

独立192点/380面闭合马腹查询另确认新增右shin骨段中心浅入4.65–24.43mm（末态7.88mm），旧cb06同点在外145.084mm；晚态膝心始终在外、末态外距78.35mm，踝在外165.21mm，实际图无塞膝/穿出/反折/新支点。该中心线/马腹范围是P3模型限制，不能写全网格零相交或无碰撞；未因此再盲调已通过姿态。独立原始回执 `qa-standard-20261013/v2-final/verdict.json`。

正常两版各24s移动，18s双骑均Charge2/attack10/hit5/death1；32s4v4均Charge4/death6（8→2→reset8），mixed32→27→reset32。40GLB200/errors=[]、finite bounds、8连续WebM与trace见 `v2/dynamic-final/`；candidate mixed暂停实际14.2675s，两版为独立wallclock，不声明锁步。该8run源为0a12，正常明确role/unit均cavalry，后有界1e0dc标签/入口修正不改变此路由；新源真实Charge/移动由独立QA另验。相关21/21动画/协调测试与新源最终build通过，全量留S1共享renderer更改后最终一次。精选13实图与机器摘要见 `docs/visual-iteration/model-standard/v2/`；authoring Blend/原录像只本地保存。

三态：V2技术限定APPROVE_WITH_NOTES；高级生者与flat晚DeathAPPROVE_WITH_NOTES、独立技术同结论，总控接受；用户认可V2/整体美术未知。高级requested gpt-6-astra/high actual未知。保留近景肩甲杯口/方蹄、右shin浅交叠、整马携骑手侧倒与头胸高度简化、四蹄活人坡面不足和未测容量；**S1共享坡尸完整门仍OPEN，本批未整体完成**。NO PUSH/MERGE/DEPLOY。

A2高级最终可引用原句："APPROVE_WITH_NOTES，仅限 A2 资产造型、生者动作、44m 主场识别及 Q1 on 平地晚 Death；画面整段悬空已明显收敛，未见新增手弓脱离或袖子断裂。胸腹并非全贴地：排除装备后布料约 .0732m、皮甲约 .0931m。正常可达坡面完整门仍 REVISE，留 S1；Q1 off 弦长余量列 notes，不宣称已通过完整兼容。"

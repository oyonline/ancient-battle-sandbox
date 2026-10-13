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

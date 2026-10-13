# 战争感 W1 / F1 / F2 / W2

## 当前批 F2 → W2（2026-10-13，进行中）

用户本批明确继续主场冲锋反馈F2，再交战后期拥挤W2；每项实际游戏检查和独立技术/高级复审后自主继续，当前批适当commit/push仅既有工作分支，不merge main/部署。owner_task=`codex-native-asset-worker / warfeel-f2-w2-20261013`。requested native继承，actual未知，无fallback。

- [x] F2 独立 `chargefx=baseline|candidate`，仅`feedback=candidate`时新候选生效；baseline是已通过F1。仅改post-pose target footprint土尘与短方向cue，首强续弱/快速衰减，depthTest真、cap/TTL/暂停/reset保持；不把knockback后但separation前的event.x/z当最终接触位置。最终main05fa0cb…/feedbackd771823…冻结；9/9focused、800/800全量及build退出0，主镜44m/骑duel真实首撞短窗完成，20GLB200/errors=[]、Idle0画布像素差0。两路独立APPROVE_WITH_NOTES/requiredRemaining=[]，总控接受受检范围。技术/内部视觉限定通过，用户新候选认可未知；主镜帮助定位但短小/局部遮挡仍P3，不宣称整体战争感显著增强。
- [ ] W2 尚未施工：独立晚段movement intent，在敌alive≤2/foot≤1、己方显著占优、远离合法接敌且被ally挡住的有限残局处理绕行/稳定side与退出滞回；不改旧W1/core碰撞/伤害/时钟/命令，不宣称早期23s拥挤全解决。具体卡由总控在F2通过后接续。

开工正式snapshot09:45:45UTC，trueRemote=fetched=local4c6f2086f553ab8ccd2d98fbe649313b5e5ae133、equal0/0、clean/dirtyOwnernone，official GitHub ID1200045147与绑定一致；两writerproviders free、5301 PID69740 HTTP200。随后同owner新task正常claim09:48:35UTC（new0600token、common-dir controlled_shared、机械hotzone仅mutex），精确10项ownership；20GLB/生成器/2D与battle-line/combat-model/旧测试保护。进程/Git/lease不从本文推断live。

本轮KB提醒由总控真实查询并展示，台账170合法1卡/去重1/0600：旧2D“回撤/驻守边界 + 滞回承诺（3s 144 次折返→0）”仅归纳为W2设计经验，3D需要本批实测，不计3D已过。KB未知dirty源仍不接管，新候选明确用户认可仍未知；测试与内部视觉分别记录。


### F2 最终冻结与受检证据（限定通过）

`frozen-f2-final/manifest.json`绑定四源码完整SHA、真实采样与8精选，精选摘要在`docs/visual-iteration/war-feel/f2/summary.json`。主场两版初始32、44m、画布1280×646；骑duel10m/同画布。真实首charge均from30→12（主场）/from0→1（双骑），候选main16.6351s、基准16.6684s，独立wallclock/dt不声称战果同步；候选实际后窗0/.1000/.2004/.4171s，图名仅请求时段。四正常WebM保存但不宣称完整逐帧实看。

只在实际feedback候选时启F2；新selector在feedback基准时disabled，正常首撞后仍仅一个控件。最终direction cue复用同4/2粒子且收细/集中在真实近侧肩外，readonly camera.position通过new Vector3.subVectors读取、不修改相机；未再加土尘数/面积。主场0/.1/.4与近镜.1两版图用于独立判定，观察为适度改善，用户新候选认可未知。第一稿新控件误插进event loop导致QA等待，已在首有效采样前修正；first-valid/low-cue仅校准历史。补camera不可变assert首次漏Vector3导入，已修且最终9/9；judge按规运行exit2缺项目配置，无有效报告/feedback目标，不将其当通过诊断。

技术正式`.omc/evidence/qa-standard-20261013/f2-final/verdict.json`（cbe4d431…）独立9合同、900帧F1禁用路径数值精确同、三组同dt核心状态事件精确同与fresh正常32真实charge/HP/Hit、10GLB200/errors0；实际锚纠偏约.838932m。高级`.omc/evidence/war-feel/f2/advanced-final/verdict.json`（94646860…）实看14图/四源/独立9测试，接受主镜外肩cue和近镜适度形体。两路均APPROVE_WITH_NOTES/requiredRemaining=[]，requested/actual分开，actual未知。近骑`.4`图另一侧cue来自2.0835s第二次真实reciprocal charge，不能当首cue超TTL。保留低面数和局部遮挡，原模型/2D/W1/core/Q1/S1均保持；Git最终结果只认本批外部live receipt，不预写push。

## 上一批 W1 / F1（2026-10-13 历史）

2026-10-13 W1 `[x]`、F1 `[x]`：两项实际实现、真实游戏检查、必要验证及两路独立复审均在受检范围通过，总控接受。W1本地提交3392abb，F1源码冻结mainab57e057…/feedback2b7b077…；最终全量797/797/build退出0。独立技术和高级源码/视觉均为 `APPROVE_WITH_NOTES`；用户对旧整体战争感已明确不足，新候选认可未知。owner_task=`codex-native-asset-worker / warfeel-w1-f1-20261013`。用户本批授权适当本地commit及最终push仅到既有工作分支，覆盖模型5笔、W1与F1，不merge main、不部署。保留原20GLB及R2/P2/A2/V2/S1和全部早期基准。Git最终tip/远端/writer/service只认下文外部live receipt，不在本文预写执行结果。

## 新批开工 live 基线（历史采样）

完整读取code-workspace-default与当前MULTI_AGENT_GIT，kb_current链路解析有效。fresh snapshot sampled2026-10-13T05:51:48UTC，local ff27af530042f7eee771a708322e3583c69bb2d2、真实/fetched remote ef4355ff01ec8995eac4dd06dc672e9ec1166944，ahead5/behind0；branch codex/sword-shield-round1，github URL身份一致。GitHub官方API repository id1200045147与正式stable repo_id一致；repo clean、dirtyOwner none，common-dir与global两provider writer_free。5301实际PID69740/HTTP200。本批writer独占仅Git机械互斥，owner只10项精确源码/测试/工具/docs，保护范围外修改。

本批新0600token、controlled_shared，intended main/combat-model/battle-line/combat-feedback、两对应tests、qa-war-feel、controller/本专项/精选目录；实际代码行为更改遵循W1有界卡。开工KB台账169、event evt-20261013-ancient-warfeel-lines-feedback-01a132c6已去重回读0600，0条额外旧经验，不凑提醒。KB原权威未知dirty不接管，旧模型阶段tmp草案已stale。

## W1 范围

独立 `front=baseline|candidate`。旧无参数/default/C1不改变；single/duel不启用W1。新纯BattleLine只产生自动motion intent，不写u.target、真实enemy或坐标，不生成damage/event；原真实敌d/stop/攻击朝向门、射箭/蓄力/近战结算/时钟/扫掠碰撞/分离及单位数组顺序保持。意图不和C1外肩绕行竞争；有意图时取其移动向量，fallback才原C1。pendingStrike/pendingShot/Hit/pierce/manual命令及真实近接敌优先原语义。

初始布阵/reset坐标和模型完全保持。4v4两列两层，16v16四列四层，mixed10步战四列，spacing=max(2.2,2*实际步战最大radius+.2)，按现位置排序稳定ID分槽/排；死去前排提升本/邻列候补，不窃取其他存活前排。线方向只取步战主体，有限滞后/侧向跟随，残局孤立敌/无对方步战释放原自主防僵住；弓在友线后软带，实际8m射程/3m紧急退步及无友军步战释放优先。骑兵保留原自主、既有正z翼，未改spawn或声称新双翼/分批冲锋。

## 首冻结与实际证据

首冻结 `.omc/evidence/war-feel/w1/frozen-w1-first/manifest.json` 绑定main5d6df87…、combat804daff…、battle-lineab16d36…及QA/test源码。20GLB逐hash保持。新增6合同与原C1/战斗共28/28；首次一个pike fixture的.6s漏掉id2原生.18s冷却＋11/24windup，延至.8s后伤害84成立，源码未因此改；judge按规调用exit2缺本项目配置，无有效report，不伪称完成诊断。首build退出0。

纯stepSkirmish同源dt pilot与真实浏览器分开统计：pure4v4 baseline12.58s/W1 19.83s、16v16 26.92/38.40、mixed39.60/47.77各正常决胜，W1补缺2/12/12、mixed真实逻辑draw75/shoot66/arrow-hit63/charge5/death25；这些不是浏览器总数。

真实paired首game 4v4均同camera21m/canvas1280×646、same初始8人、四模型与C2/L1/S1固定；candidate23.17s/基准24.62s均4活，nativeattack72/hit36/death4、候补2。mixed主镜44m/同canvas固定，candidate23.268s22活/refill9、baseline23.401s21活。正常速度WebM、初始及4/8/12/18/23请求时段PNG、actual位置/HP/队列/实际采样时刻/pause/reset记录在 `w1/pilot/`。独立wallclock/dt，不声称同战果或逐帧动作锁步；20GLB200/errors=[]。

约8s实际红步战横向span：4v4 6.178→2.377m；mixed12.633→6.435m，mixed前排X depth约.007→.038m。4v4实际前排Death后18.6ms产生slot决策，候补首次真实Attack延迟.7983s。定义是固定初始X/Z方向上的最近前沿tier与全部步战范围，不是任意转向军阵统计；均保留实际radius碰撞gap，指标不能代替游戏视觉判断。`pilot/metrics.json`。

补充真实16v16至candidate45.615s16活/refill12、baseline48.652s11活；mixed至candidate55.288s6活/refill12、baseline55.836s10活。末态分team HP/胜负/finite/pause/reset和镜头见 `complete-first/outcome-summary.json`，12关键PNG另冻结 `frozen-w1-complete-first/`。原native crowdQA trace固定32s停止，事件是前32s部分记录；后续HP/renderer继续，不能把partial events假充45–55s总数。正常mixed无crowdQA事件记录，不为补全总数改规则/重跑。

高级首source+12实图限定 `APPROVE_WITH_NOTES`（requested gpt-6-astra/high、actual未知），独立重跑28/28；4v4两前排与后排纵深/mixed8–12s前后层次改善可辨，23s局部骑/近战拥挤列P3，不扩完整军阵系统。随后完整game/技术增量由独立两路复审接受；不把首范围结论扩大为最终完整范围。

首稿ab16边界：给存活前排一个“走到原地”manual target、尚未位移即detach/promotion。第一次0a7b修版以其他列均值/理想侧带作槽位基准，初始点通过但独立正常mixed演进277活动头探针仍53次误判，正式REVISE、已superseded（该合同未过）。正常无manual实图/测试正项未丢，不能用初始点通过豁免动态弯曲front。

最新df86e132…仅helper改为既有头收到manual时缓存它真实occupied centre，只在actor自身实际离开body-sized原位才补；manual结束/死亡/reset清缓存，绝不写u.target。test2242ef49…新增不齐mixed前线逐活动头自身坐标指令回归，覆盖200以上演进探针；相关30/30，三类旧first→新helper正常无manual各3600帧全unit/event/refill精确同。main5d6df87…/combat804daff…/20GLB不动，原正常4/16/mixed全部实图可继承，source证明在 `frozen-w1-occupied-final/manifest.json`。最终当前代码全量791/791、build退出0；此前790全量对应0a7旧revision，仅历史记录，不混写为新版本。高级最终same-defect与独立技术最终均为 APPROVE_WITH_NOTES，requiredRemaining=[]；五source hash、20GLB、2D60文件/6项保护呈现代码保持，技术独立2700正常帧精确继承。正式技术凭证 `.omc/evidence/qa-standard-20261013/w1-final/verdict.json`。

最终df86实际UI新21采样：真实选兵/地面同槽指令（目标距原位1.30155m，并非精确自身坐标）首次更新保0/refill0；首次观察actor离原位2.62195m>2.2占位阈值后补2，命令在elapsed6.2845s自然完成target=null、同列[2,0]唯一重入后排；reset回[0,2]/全健康/refill0。5GLB200/errors=[]，两关键PNG、连续WebM/actual-summary及冻结manifest绑定同source；高级实际看2图/读21点并认可该样本自然完成。精确原地合同另由控制夹具覆盖。第一次不同raycast/dt长UI采样仍停d=.1000000000000003m、target非空，是历史stop浮点边缘，未修命令规则；不能以本次成功扩大为所有命令都保证完成。首图正常结果和全部失败历史保留。

## 当前三态与保留范围

W1技术791/791/build和独立技术最终通过；内部源码/视觉高级最终APPROVE_WITH_NOTES，总控接受。F1技术797/797/build、独立技术8契约/6focused及1200同dt核心状态/事件逐值同，fresh正常32真实hit/arrow-hit/晚Death/charge四点、pause/reset、5GLB200/errors=[]；高级实看18张近镜/主镜短序列、独立6测试/6source同冻，两路APPROVE_WITH_NOTES，总控接受。两项均不自动代表用户认可，新W1/F1及模型候选的明确用户认可仍未知。

W1晚段骑兵/近战局部拥挤、获胜方部分候补未参战、旧manual .1m stop epsilon保留。F1 44m主镜冲锋反馈小且易被马体遮挡列P3，提升适度，不宣称整体战争感完成；真实结算的骨点表现锚不是3D碰撞物理。首/续charge强弱由受控真实类型事件合同验证，独立自然主场此次只观察first=true。原足滑/坡部局部接地及骑兵简化仍保留，未验证目标设备大军容量或声音。

## F1 最终受检候选

W1已本地提交 `3392abbca2f5a538a9e9bcafc6b6a38db8599014`；最终整批Git状态见下文live receipt。F1独立 `feedback=baseline|candidate`；固定W1及四标准模型/S1/C2/L1，旧无feedback/基准路径保留地面细环、原动画/Q1/飞箭顺序。纯呈现CombatFeedback只接收真实hit/arrow-hit/charge/death摘要，root/骨动画/Q1/S1/T1与world matrices完成后采Chest或HorseBody位置。灰白/暗金短接触碎片、首冲锋强/续击弱土尘、实际位移且低位skinnedHoof的轻尘、真实死亡晚段一次土尘；无attack/draw/cancel伪命中，不改damage、sim fields、资产、单位shared材质或箭释放时序。骨点为已结算命中的表现锚点，不声称真实3D碰撞点。

资源独立geometry/material、128粒子/64事件队列cap，TTL跟游戏dt；暂停不推进，reset清队列/旧unit引用，pagehide只dispose自己资源。第一试稿胸骨内锚点/向体内散射被甲遮，自检修成近侧表面与外散，失败首图保留。可读首冻结 `f1/frozen-f1-first/manifest.json`：mainab57e057…、feedback2b7b077…、test3273851…、QA9d75a006…；W1combat804/helperdf86和20GLB保持。

6个相关合同通过：固定W1同源1800帧simstate/真实event逐值同、取消不造命中、真实arrow-hit、暂停/reset ID复用安全、finite/cap/过期资源回落、实GLB蹄底近地与晚Death仅一次。双兵剑盾/弓/骑和默认主场32两版实机与录像已完成：pilot40GLB200、自然主镜事件短窗10GLB200/errors=[]，暂停逐值稳定/reset归零。最终全量797/797/build退出0；相同reset+Idle0样本两版canvas像素SHA、32单位投影bounds、材质逐值同，另三次真实命中后reset清FX/队列/cache。技术/内部视觉独立最终均APPROVE_WITH_NOTES、requiredRemaining=[]，总控接受受检范围；用户新候选认可未知。


F1完整冻结 `f1/frozen-f1-final/manifest.json` 与12精选图在 `docs/visual-iteration/war-feel/f1/`；代码指纹同首可读候选，20GLB复核全同。正常main命中4.6652s、箭击6.5619s、首冲锋18.0974s后使用页面pause取短时序；PNG名.08/.16是请求偏移，实际.118–.131/.201–.235写入manifest，不称精确帧或A/B战斗锁步。极短受击闪在44m主镜表现克制、土尘有限；高级已实看18图限定接受，冲锋偏小/马遮列P3，未用创建数量替代视觉判断。

补充QA采样失败历史保留：首reset读取已跨一个新Idle帧，8个新马缓存被误认清理失败；同任务reset+inspect后三循环通过。首Idle两页面自由布阵步数不同，原separation尚在收敛，未声称相同；相同真实reset+Idle0freeze后canvas hash均28b50ac6…、world投影bounds及材质全同。候选源码未因这两次私有QA夹具校准而更改。judge按规调用退出2、项目配置缺失，无valid report/feedback目标，只留排查输入局限。

独立最终凭证：技术 `.omc/evidence/qa-standard-20261013/f1-final/verdict.json` SHA7ab31b95…，高级 `.omc/evidence/war-feel/f1/advanced-final/verdict.json` SHAcf0e1b33…；高级requested gpt-6-astra/high，actual model/effort未知。此前总控原生turn曾报告selected model at capacity，随后同原生路线恢复完成独立复审；这段为运行时历史，不是项目代码反复失败或自动批准拒绝。技术首paused-CDP截图夹具等待无效并保留，普通poll重取成功，不把invalid截图算通过。

## 本批 Git 实时收口入口

本轮当前授权仅工作分支 `codex/sword-shield-round1`，最终本地F1精确19路径commit后冻结tip，再正式prepush三读/clean/identity/fast-forward门、精确SHA无force push、postpush三读同tip才记pushed_verified，最后正常writer释放/两provider复查；不merge main、不部署。最终执行状态、F1/整批tip、真实remote三读、clean/dirty owner、writerrelease和combined preview健康都记录到 `.omc/evidence/war-feel/final/git-receipt.json`（不入Git）。本文是执行前审定版本，**未生成pushed_verified receipt前不能从本文推断已推送**；不为回填自身commit SHA再修改已push源码/文档，最终结果由同轮receipt和live回读核验。共享模拟箭提取仍未实施，KB未知dirty源仍不接管。

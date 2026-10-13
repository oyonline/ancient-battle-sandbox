# S1 共享尸体坡面视觉支撑

2026-10-13 S1 受检范围技术与内部视觉均 `APPROVE_WITH_NOTES`，总控正式接受；全量783/783、构建及四类真实倒地/主场证据已完成。A2/V2原坡面整段悬空门由本专项在受检范围内关闭，四类模型及16旧资产保持。用户既有整体评价是模型、动作和战争感均不足；这些新候选的用户明确认可未知，不将内部批准写成整体美术/战争感完成。

## 有界实现

`corpse=baseline` 保留原竖直接地；`corpse=candidate` 仅 3D Death 外层 model 适应坡面。未带参数的旧入口保持原行为。紧凑“尸体支撑”选择与既有角色对照并存，角色/资产元数据依真实实体；四类新模型和16旧资产都不重导，不改伤害、时钟、命令或事件系统。

entity.root 仍是 scale1 的纯 yaw 和模拟位置；倾斜的是其子 model，因此 model.position.y 仍沿世界竖直，原 settleCorpse 全网格最小间距算法可保留。每帧在 mixer/Q1 前恢复基准 model quaternion/lift，在 Q1 持弓/持箭/冲锋修正及 legacy z 清理之后，按绝对 Death phase 加局部倾角，再刷新蒙皮、以原全网格算法竖直接地。倾角从 .45s 起 smoothstep 渐入、在实际 Death clip duration 完成，最多 .45rad；不累乘。支持法线取死后胸髋/HorseBody 足迹中心±.1m 的实际 heightAt 差分。

末态缓存依位置/root yaw、model scale、采样时间/时长及骨的局部 pose；不稳定阶段不缓存。Death→Idle 明确撤销 overlay/cache，重复采样及换角度/位置重新求支撑。当前地形固定，cache 不含 terrain revision/非骨局部变换列维护 notes；不宣称动态改地形已验证。

当前 heightAt 在 x[-19,19]/z[-15,15] 按 .25m 网格及相同±.1差分只读计算最大坡角 .31943rad，低于 .45rad cap；这是本地已知地形域采样，不是任意地形或几何全域证明。

分区工具按主权重骨和材料给出真实 skinned world 顶点最小间距。Chest/Spine 可能含箭袋/胸带装备，`torsoIncludingEquipment` 和真正胸腹布料/甲分别记录；`horseBodyIncludingTack` 也不是纯马皮。最低 gap 不代表全身每处贴地。

## 冻结实现与首轮对照

首冻结 `.omc/evidence/model-standard/s1/frozen-s1-first/manifest.json` 绑定：main `4e5e07702b5cd75bbf4574b5b2e07e621729840a0e4e6f69c38babb94fd0c68b`、helper `5cd2c6d5a3760c79354d543886947fc6544a536af2b5185bc18f335d60cfa5eb`、QA `58911cb8537a626e2aa3ef3009a4b8b4cbdf2d06aefb640dc837956be296a243`，20 GLB 指纹完全保持。GLB 基准仍分别为 R2 `35aec736…`、P2 `135115c7…`、A2 `b5789081…`、V2 `6c6db675…`。

实际 headless Chromium battle3d 同镜头/画布/灯光/单位位置/模型，两版只切尸体支撑；viewport1280×900、canvas1280×646（此专项新增紧凑控制行后实测尺寸）。受控夹具调用原 mixer 与显式死亡 Q1 presentation proxy，不改实际 unit HP/模拟状态；该组不是自然死亡。每类正/反坡 heading .643501/3.785094，time .8/1.25/1.65：48点、16末态PNG、40GLB HTTP200/errors=[]。另48平地点、40GLB200/errors=[]，model quaternion、lift、分区与gap严格相同。Death→Idle→Death重复/换heading零累积。

| 已知坡末态区域 | 原接地 | S1 | 含义 |
| --- | ---: | ---: | --- |
| R2 正坡胸腹布料 | .4264m | .1274m | 大悬空收敛，刚性衣甲/头脚支持仍有余隙 |
| R2 反坡胸腹布料 | .1194m | .1266m | 约7mm增量，须按视觉及平地支持余隙解释 |
| P2 正/反坡胸腹布料 | .4264/.0999m | .0651/.0702m | 长杆、双手相对关系保持 |
| A2 正/反坡胸腹布料 | .4264/.3159m | .0735/.0783m | 最低装备与真正衣料区分 |
| A2 正坡 hips | .3425m | .0438m | 改善并非只脚点数字 |
| V2 正/反坡马身含马具 | .1383/.4103m | .0566/.0250m | 骑手被马携带，不要求骑手胸头同马腹高度 |

3项必要回归已通过：四 yaw 的解析平面 world normal、四个真实 GLB 平地逐区域/姿态完全原值、Q1 末态多帧不累积且换位置/clear 正确。最终全量 **783/783、fail0**（原780＋3），构建退出0；原有超500KB bundle提示保留。日志 `.omc/evidence/model-standard/s1/{tests-final,build-final}.log`；未因为文档/精选图更新重复全量。

## 正常连续倒地与主场补件

首冻结源未改。`.omc/evidence/model-standard/s1/natural/manifest.json` 绑定源码、测试、真实图与摘要。R2/P2/V2 三场真实坡地双兵走正常 stepSkirmish 伤害/Death 事件及动画循环，无改 HP、时间或 pose proxy；死事件 elapsed9.7671/9.4338/7.9838s，各观察至约18s并完成1.25s原Death。各保存死后约 .2/.55/.8/1.25/2s 的 renderer 原帧PNG、完整trace/event、晚态图/分区及连续WebM；文件名只表示请求的死后时间，actual native actionTime 以对应 trace 为准。V2 `natural-death-1.25.png` 实际action1.2338、尚未complete，2.00及hold才实际action1.25完成；不因命名混写末态。nearest frame 的绝对时间在summary中，不宣称两独立wallclock锁步。duel canvas1280×666，与前受控固定比较646分别记录。

三类晚态 fullgap≈.025m、root始终纯yaw、无采样穿地/非有限点。自然R2胸布.14464/hips.11788、P2胸布.07239/hips.04650、V2马身含马具.14017/horseLegs.025m；位置/曲率不同，不直接和固定(-3,-1)控制夹具同值比较。合理盾/装备/马腿支撑仍可令胸头/弯腿留缝，不能写全身皮肤贴地。

同源正常开局32人主场真实交战25.7039s，14个实际死亡（剑盾/长矛/骑兵）；其中13个tilt weight=1，1个长矛仍晚段weight=.2867，不能称14全完成。dead各点finite且全mesh gap≥-.001；没有等全灭再取证。真实UI暂停300ms elapsed/全部pose与分区严格稳定，恢复400ms elapsed推进，重置回32活人且model quaternion全identity；C2正常镜头、canvas1280×646见 summary。录像/两张战线PNG和读回在 `natural/mixed32/`，不据此推断数百人或目标设备容量。

worker这一组20GLB HTTP200/errors=[]，先前控制两组分别40请求；独立QA另95请求按独立范围统计，不能混写为同一次run。精选12真实图、紧凑summary和20资产指纹在 `docs/visual-iteration/model-standard/s1/`；原始录像和大trace不进Git。

## 独立复审与未关闭项

高级 reviewer requested `gpt-6-astra/high`，actual 未知；已实看16坡图/48点及共享源，首轮 `APPROVE_WITH_NOTES`。R2布料约.127m、头脚余隙/马骑整体侧倒属于刚性模型简化；未见新增穿地/矛弓握持/马骑相对关系阻断。.8s 为过渡，1.25/1.65 为稳定末态，不能称全身零gap。

独立技术已验证20GLB/规则/Q1/T1未变、四兵平地 Idle/Death/hold 逐world顶点差0、坡正反 finite/fullgap≈.025，以及 A2/V2 early/repeat/reverse/idle/reset/cache 链；真实自然 A2 平地双版完全一致、坡候选事件/Arrow scale=.001/纯yaw正确。95GLB200/errors=[]，正式限定 `APPROVE_WITH_NOTES` 见 `qa-standard-20261013/s1-final/verdict.json`。

高级最终视觉/源码合并 `APPROVE_WITH_NOTES`：在原16受控坡图与自然A2/flat基础上，本次实看三类duel各5phase及mixed2图共17新实图、真实正常来源/trace与pause/reset读回，受检坡面门限定关闭；不称全部录像逐帧审阅、任意terrain或容量通过。R2自然cloth约.145/hips.118、V2自然HorseBody约.140及头脚装备余隙/马骑侧倒简化保留 notes。

独立技术最终合并 `APPROVE_WITH_NOTES`，三类duel真实HP跨零/伤害与死亡事件、完成1.25及fullgap≈.025，mixed14死=13完成+1过渡、pause/resume/reset、源和20资产指纹/25自然补件文件hash、worker783/build日志回读均通过。正式回执 `qa-standard-20261013/s1-final/{verdict,natural-readback-addendum}.json`。总控收到两路结论后正式接受S1受检范围；本批模型与此必要支撑项完成，不据此宣称任意坡面/目标设备容量/战争感全目标完成。

最终快照 `s1/frozen-s1-final/manifest.json` 汇总原比较、自然补件、3项新测试、783全量/build和20资产指纹，源码仍同首冻结；精选图summary记录两路最终限定结论，不覆盖历史故障稿。

收口前新测 `http://127.0.0.1:5301/battle3d.html?model=r2&pike=standard&bow=standard&ride=standard&motion=candidate&duel=candidate&crowd=candidate&coordination=candidate&terrain=candidate&building=candidate&camera=candidate&light=candidate&corpse=candidate`：页面HTTP200、实际四标准资产＋B1共5GLB200、32人健康、errors=[]。证据 `.omc/evidence/model-standard/s1/final-preview-smoke.json` 和 final-preview.png；服务保留供用户看，不能把本轮端口状态当未来会话运行证据。

NO PUSH/MERGE/DEPLOY。KB source 存在未知 dirty ownership，未同步；旧 `/private/tmp/ancient-r2-kb-01a132c6/` 草案已经过时，不能当本轮当前成果。模型残留、活人足滑/骑兵四蹄坡面不足、多人边界与容量未验证继续保留；S1不包含新死亡物理/下马或任意曲率全身贴地。

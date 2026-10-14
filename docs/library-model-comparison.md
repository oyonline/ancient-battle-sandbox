# 公开剑盾模型比较（2026-10-14）

用户指出自制模型关键关节和美术不理想，授权 Quaternius / KayKit 各一名、固定剩30%、继续真实三招和格挡，先看页面再决定。入口 `model-duel.html`；旧 `battle3d.html?impact=sword` 有“公开模型对比”入口，比较页可回原模型和骑兵。初版默认混合；用户随后选择KayKit，现默认同款优化（见kaykit-refinement.md），仍可同款、交换阵营、同seed重开、换种子、暂停、拖转与缩放。

资源采用 **Quaternius RPG Characters — Nov 2020 Warrior**、**KayKit Adventurers 1.0 Knight**，并非较新的 Fantasy Outfit / Adventurers 2.0。新版官方下载服务本轮不可达；作者公开旧版本许可与文件已核。Q保留原几何、骨架、权重和剑，盾来自KayKit；三招/格挡/受击采用Kay作者动画经明确rest世界方向校准重定向，腿用原长度IK保持脚锚；Q死亡用其原生约束烘焙。K保留原动作和手槽。来源、原包许可、下载SHA见 `public/assets/3d-sample/libraries/ASSETS.md` / `sources.json` / LICENSE文件。

按bind站姿脚底到发顶/盔顶测量（排除武器），统一参考高度2.6122968197后乘0.3，结果约0.783689m；保持各自头身比例。两者独立复验高差低于8.2e-8m。

规则直接复用未改的SwordDuel：HP140、原seed728、三招伤害/时序和条件格挡均不变。实测原clip刀刃切入帧映射到规则contact .48/.72/.30，短窗手臂IK按对方实际躯干高度校准。这里是呈现接触适配，不是三角形碰撞判伤。命中不打断时仍有轻方向胸部反应；死亡优先，暂停不推进时钟/RNG。

尸体按髋/躯干/头支撑，末40%渐入正向落地，早期只修核心身体穿地；Q裙甲末态约2.37cm入地，作为次要衣摆折衷明确保留。不能将其写成所有网格完全零穿插。

验证：15/15受影响测试，生产build成功并产出model-duel.html。正常真实局16hit/2block/1death；控制回归混合/互换/两同款均seed728、80次抽样、终HP[-2,2]（显示0/2），完整历史一致；暂停稳定、重开恢复。独立技术受检通过；视觉 APPROVE_WITH_NOTES、requiredRemaining=[]，原生死亡仍拱背（躯干/头约5.5/7.2cm未完全贴平），不称布娃娃物理。后续用户已选择KayKit风格；本轮新动作认可仍待试玩。未改旧GLB、2D或其他样板，不commit/push/merge/deploy。

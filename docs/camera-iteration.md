# C2 主场取景迭代

2026-10-12；前一阶段 B1 本地提交 `109279300e82a9503a906651c7b930370e6ebb85`。保留 M1 / D1 / C1 / P1 / A1 / V1 / Q1 / T1 / B1。C2 只调整正常32人战场的初始、重置及“全景”取景，不同时修改建筑、灯光、角色、地形、规则或既有动作。

## 定位与候选

实际 B1 32人画面，1280×900页面 / 1280×695画布，最前蓝骑的脚被下沿裁切。原镜头关注原点，而骑兵排在 z=6 / 10.2 近端；固定 distance43 在当前斜俯朝向下未为整阵列留出余量。reset 与“全景”又会回到相同的裁切构图。

唯一候选 `camera=candidate`：distance44、focus(0,0,4)。FOV38、归一化朝向(.75,.95,1)、灯光、演员与建筑尺寸均不变。内部探索选择以先移动关注点为主、只微调距离，避免仅靠大幅缩小人物解决裁脚。近端板角仍在画外，不能据此宣称整块沙盘或任意移动位置都在画内。

仅正常非QA、非still、非view、非兵种静态比较启用；QA以及 B1 / T1 / Q1 的既有固定对照继续原机位。滚轮、＋／－、看选中和地面投影的交互算法不改。正式对照两版使用同一底部切换按钮布局，以固定画布尺寸。

## 预览与回退

http://127.0.0.1:5301/battle3d.html?motion=candidate&duel=candidate&crowd=candidate&pike=candidate&bow=candidate&ride=candidate&coordination=candidate&terrain=candidate&building=candidate&camera=candidate

底部原镜头栏“取景基准 / 取景候选 C2”只改 camera query，保留其他阶段flag。`camera=baseline` 或删除camera恢复原点43。候选未取代无query默认。两版地址实际加载5个GLB均HTTP200，无浏览器错误。

## 验证状态

源码语法与diff检查通过。两版实际运行各23检查通过：32人开局，FOV38/画布1280×695；真实鼠标点中同一红方剑盾并单选，地面原点命令目标误差<0.05m；＋／－4m、滚轮2.3m、看选中18m均保持原行为，全景与重置返回对应preset。正常速度交战14秒，每约2秒实拍同源游戏PNG及WebM，随后暂停、重置16+16。QA四人 / 16人保持21 / 31m，B1静态default / near保持43 / 18m，C2明确inactive。

同一初始实际变形网格的最低像素：旧版721.4319超出695画布26.4319px；候选619.2582，底部留75.7418px。候选两塔屋顶最小y18.7194px，未裁顶。以上是当前1280×900开局固定条件，不代表所有窗口、任意战位都完整。主场正常时钟dt不同，交战末旧27 / 候选26活人，记录准确elapsed，不将实时分歧描述为规则一致性测试；战斗源和16个GLB哈希保持。

- [旧版初始](visual-iteration/camera2/baseline-initial.png) / [C2初始](visual-iteration/camera2/candidate-initial.png)
- [旧版约8秒交战](visual-iteration/camera2/baseline-fighting-4.png) / [C2约8秒交战](visual-iteration/camera2/candidate-fighting-4.png)
- [旧版重置](visual-iteration/camera2/baseline-reset.png) / [C2重置](visual-iteration/camera2/candidate-reset.png)

完整正常速度视频、7个连续游戏帧及机器记录在`.omc/evidence/camera2/{baseline,candidate}/`，原视频不提交Git；小图和读数见[summary](visual-iteration/camera2/summary.json)。自检实际看初始、约8秒、约14秒、重置PNG，未宣称完整播放WebM。

最终全量780/780退出0、构建退出0。独立只读源码与实际游戏画面复审APPROVE，限定1280×900初始阵列、14秒采样和本轮交互；用户明确认可未知。技术与独立内部效果通过，不等于用户美术验收。仅本地commit，NO PUSH；下一项灯光，尚未实施。

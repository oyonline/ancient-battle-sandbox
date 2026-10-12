# B1 建筑比例迭代

## 定位与范围

在当前 HEAD 442eb1f 基础，实际Three场景只有红蓝两座装饰塔，本轮仅该塔候选；保留全部M1/D1/C1/P1/A1/V1/Q1/T1。原2D public/assets/props/tower.png 的石塔、木平台、覆瓦顶与阵营旗识别保持。现有士兵不是旧sample的约1.8单位模型：current duel1/infantry-rig-metadata.json height2.6123，正式Idle0实机头顶相对根节点2.5670，完整bounds高2.60165（含靴低缘），数值另见summary.json。没有缩士兵或改世界尺度。

主要原因最多三项：原门板仅0.60×1.18、上层楼面至屋檐1.19，与当前成人战士比例脱节；平台/栏杆狭窄低矮，难读为可站立的塔层；原门立面不随塔身收分，局部被墙遮埋。

## 实际改变

1. 门板宽1.14、高2.86，门梁最低点至门槛实际2.785；跟随塔壁收分贴合。仅外立面尺度提示，未新增可穿过的室内/驻塔逻辑。
2. 木平台由2.24增至3.50宽；楼面顶3.80，顶部横梁最低点6.655，真净高2.855；栏杆最高点距楼面1.275。柱、平台和屋顶单独重理尺寸，非整体uniform scale。
3. 石基与塔身适度加宽，基座下延到根节点以下.48作为贴坡裙，塔位置/root约定不变。保留材质、简洁面数与屋顶语言，不堆装饰。

## 真实游戏对照

正式对照http://127.0.0.1:5301/battle3d.html?motion=candidate&duel=candidate&crowd=candidate&pike=candidate&bow=candidate&ride=candidate&coordination=candidate&terrain=candidate&building=candidate 。底部“建筑比例基准 / 建筑比例候选 B1”只改building query，其他阶段flag保留。正常URL仍运行原32人，未冻结。删除building或设baseline恢复tower.glb。

静态相同士兵做尺：加 &still=1&view=default 或 &still=1&view=near；头脚完整、Idle0，两版同演员位置/尺度/采样，默认镜头不变，near统一distance18。页面1280×900，实际canvas1280×695、FOV38，两版读数一致。建筑静态只用于无qa模式（QA组合优先各兵种原QA），静态模式只暂停展示，重置保持同条件；开始交战/暂停禁用避免误操作；删still恢复正常32人。side/back使用buildingAngle=π/2或π，只转模型，不改正式相机/灯光。除比对专用actor摆位，正常32单位布阵未调整。

- [默认旧版](visual-iteration/building1/baseline-default.png) / [默认B1](visual-iteration/building1/candidate-default.png)
- [近观察旧版](visual-iteration/building1/baseline-near.png) / [近观察B1](visual-iteration/building1/candidate-near.png)
- [B1侧面](visual-iteration/building1/candidate-side.png) / [B1背面](visual-iteration/building1/candidate-back.png)
- [真实32人旧版](visual-iteration/building1/baseline-mixed-initial.png) / [B1](visual-iteration/building1/candidate-mixed-initial.png)
- [旧版交战](visual-iteration/building1/baseline-mixed-fighting.png) / [B1交战](visual-iteration/building1/candidate-mixed-fighting.png)

本地正常速度原录像与每约2秒实拍连续帧在.omc/evidence/building1/{baseline,candidate}/，视频含静态检查与真实交战14秒、暂停、重置；不是离线渲染。截图与数值记录来自实际GLB加载后的Three画面。完整机器读数见visual-iteration/building1/summary.json。

## 验证与边界

独立候选 public/assets/3d-sample/building1/tower.glb；静态一mesh/two nodes，无骨架/动画/相机/灯光。候选SHA256 8932d1896158503d6dd5903ed887ec5381ccc6fbefc6d743b599b806a9f82666，179840 bytes；15个已有GLB哈希保持。正式加载5个GLB均HTTP200、两版浏览器error0。主场景开局/重置均16+16，真实交战/暂停正常；比例变化不改变装饰塔原有无碰撞性质。正常32交战实拍检查新基座未包住原开局士兵；既有塔无碰撞仍可由用户命令走入，未扩展建筑玩法。地形裙仅现塔位置有界贴坡，不代表任意地形放置。

最终截图之后仅增加buildingComparing不接管qa组合的一行保护，候选几何与正式非qa截图条件未改变；追加实机cavalry / archer / pikeman QA + still组合加载与建筑near重置检查均error0，重置后actor / camera / canvas / pose与正式near完全一致，见summary。最终全量780/780 exit0、构建exit0（root正式执行回执）；独立只读复审APPROVE：source和真实游戏内比例效果限定内部通过，root接受。无新增P0/P1；原2D上层石构未完整重建、无楼梯/室内/原塔无碰撞仍明确保留。三态：技术通过 / 限定内部比例效果通过 / 用户明确认可未知。原2D塔石构上层与城垛未完整重建，楼梯/室内/驻军继续未接入；这是尺度修订，不代表整建筑系统或美术最终验收。下一项仅独立镜头检查，不同时变灯光。

## 导出与回退

/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python tools/generate-3d-sample.py -- public/assets/3d-sample/building1 --tower-candidate --no-previews

只有--tower-candidate分支导出塔、独立OUT，不生成/覆盖其他兵。无query默认仍原tower.glb；保留候选可独立复查。源码只涉及shared生成脚本的新增tower-only分支和main.js加载/最小预览。当前授权仅本地commit，NO PUSH。

# AI 纪律批次2（C 骑兵绕枪墙）接力交接

> 日期：2026-09-28。本文档为会话接力用，commit 前请勿提交此文件。

## 一、总目标

优化所有兵种 AI（用户已批准方案）：A 目标粘滞 / B+C 火力与冲锋纪律 / D+E 防守补强 / F 战线意识。追击溃兵维持现状。当前处于批次2（C 骑兵绕枪墙）收尾：修完镜像对称后"适当 commit"。

## 二、已完成（勿重做）

- 批次1（A/B/E）已提交：`d67c148 feat: AI纪律批次1——目标粘滞、弓手火力纪律、矛兵遇骑结阵`（本地领先 origin/main 1 个提交，未 push）
- C 骑兵绕枪墙主体已实现（未提交）：
  - `js/units.js` CavalryAI.detourPikes：冲锋线逐格采样（1-6格）探测枪口朝来路的停步矛簇→沿世界锚定墙轴垂直偏移落点；带宽滞回选边（detourSign 粘滞）；蓝方默认绕向取反保镜像
  - `js/game.js` 帧首快照 `unit.pikeViewMoving = unit.moving`（矛兵 moving 读序统一，换座对称）
  - `tests/ai-discipline.test.js`：新增 9 个绕枪墙测试，文件共 14 测试全过
- 平衡回归已定位并加了"宽墙门控"（见下），加门控后矛阵两座位都重新获胜

## 三、当前卡点（核心）

**全量 298/300，挂 2 个测试（同根因）**：

1. `combat-balance.test.js:28` 矛阵方阵对冲等价骑兵——挂镜像断言 `forward.survivors.red === reversed.survivors.blue`（34 !== 29），两座位都赢但存活数不等
2. `combat-balance.test.js:63` 矛屏护弓对比——同镜像发散根因

**根因链（已查实）**：

1. 原版绕枪墙只收冲锋线 ±1.5 格内的矛兵，宽墙的边缘在视野外→偏移钳制在 6 格→骑兵贴墙滑进未架好的矛丛内部绞杀（改动前矛阵 0 存活全歼，基线是矛阵 28 存活大胜）
2. 修复：detourPikes 内新增"探边 walk"——从冲锋线过墙点沿墙轴 ±方向步进 0.7 采样（forEachNear 半径 1.1，空隙累计 ≥2.2 停），量出绕行侧矛簇真实边宽 wallEdge；`rawOffset = (wallEdge+1.6)*distance/max(nearestAlong,1.5) > 6 且未在绕行中（!wasSwinging）→ 不绕，正面硬冲`（矛墙 counter 本职保住）
3. 新问题：**镜像对称被打破**。`tools/debug-cav-mirror.js` 显示 step296 首发偏差 6e-3 → step374 爆到 0.75
4. 用 `tools/debug-first-diverge.js` 定位：帧前位置完全镜像一致，单帧内决策分岔；再用 `tools/debug-detour-internals.js`（依赖 units.js 里临时调试钩子）对比两座位 detourPikes 内部值：**第 50 次调用 wallEdge 0.298 vs 0.573 分歧**
5. 刀刃在 forEachNear（`js/game.js:1593`）：`((gx - r) / SP_CELL) | 0` 算格子范围，采样点/矛兵位置带 ~1e-15 量级的镜像算术噪声（部署 16-2.4000000000000004 vs 54+2.4000000000000004 不对称），恰落在格子边界时两座位查询的格子集不同→walk 找到不同矛→wallEdge 差一个矛位→rawOffset 差 0.7→单帧 0.006 位移差→混沌放大

**修复方向（未实施，供参考）**：

- 探边 walk 的采样点坐标量化到镜像对称格点（如 0.05 网格；70/35 均为 0.05 倍数，`round((crossX+sideX*s)*20)/20` 两座位量化后相同），再喂给 forEachNear
- 或单次大半径查询（forEachNear cross 半径 ~9）+ 走廊过滤（投影 ∈[0,8]、离墙线 |横距|≤1.5）+ 关键比较值量化（如 wallEdge、rawOffset、阈值比较前 round 到 0.05）
- 注意矛兵位置本身带噪声，距离过滤比较也需量化；原则：所有离散决策的输入先粗量化，噪声 1e-15 << 量子 0.05 就不会翻转
- 修完必须同时保住：14 个 ai-discipline 测试全过 + 2 个 combat-balance 测试过（含镜像存活数相等）+ `tools/debug-cav-mirror.js` 跑到底无宏观分歧

**镜像换算备忘（调试时极易搞错）**：x 镜像（x→70-x）下：centerX→70-x；**axisX 不变、axisY 取反**（axis=(-faceY,faceX)，faceX 取反 faceY 不变）；riderAxis 取反；detourSign 取反（红+1/蓝-1）；落点直接镜像

## 四、提交前必做

1. **删除 `js/units.js` 618-620 行临时调试钩子**（`if (unit.scene.__detourDebug ...)`，本轮调试用，debug-detour-internals.js 依赖它，删钩子后该工具作废可一并删）
2. 全量测试：`node --test "tests/*.test.js"`（注意必须带引号通配；`node --test tests/` 不可用）
3. 镜像验证：`node tools/debug-cav-mirror.js` + `node tools/debug-seat-mirror.js`
4. commit 计划（跟随仓库惯例）：
   - feat 提交：`js/units.js js/game.js tests/ai-discipline.test.js`，消息风格如 `feat: AI纪律C骑兵绕枪墙——宽墙探边门控、世界锚定墙轴绕行与矛簇快照镜像`
   - tools 提交：本轮 8 个调试工具（check-detour / debug-cav-mirror / debug-detour-behavior / debug-pike-cav / debug-pike-square / debug-detour-mirror / debug-first-diverge / debug-detour-internals 中删废存精）
   - 不 push（用户未要求）
5. 提交完回到主线：D 侧翼反冲（tactics.js updateGroundGuard 加战线咬合计时→一翼守骑冲击敌线侧后，得手/失败均返锚）→ F 战线连贯（剑士邻兵凝聚+溃口补位轻量起步）→ 批次3调参

## 五、快查命令

```bash
node --test tests/ai-discipline.test.js                    # AI 纪律 14 测试
node --test tests/combat-balance.test.js                  # 两个挂掉的测试
node --test "tests/*.test.js"                              # 全量（引号必须）
node tools/debug-cav-mirror.js                             # 镜像发散检查（本战场）
node tools/debug-first-diverge.js                          # 高精度首发分歧帧
node tools/debug-detour-internals.js                       # 两座位 detour 内部值对比（依赖调试钩子）
node tools/debug-pike-square.js                            # 矛阵 vs 骑兵战场过程
git stash push js/units.js js/game.js -m wip && git stash pop   # 基线对比
```

## 六、未提交工作区状态

- 已修改：`js/game.js`（+3 行快照）、`js/units.js`（detourPikes 重写+探边门控+临时钩子）、`tests/ai-discipline.test.js`（+102 行）
- 未跟踪：`tools/check-detour.js`、`tools/debug-cav-mirror.js`、`tools/debug-detour-behavior.js`、`tools/debug-pike-cav.js`、`tools/debug-pike-square.js`、`tools/debug-detour-mirror.js`、`tools/debug-first-diverge.js`、`tools/debug-detour-internals.js`
- 追击溃兵维持现状（合法目标）；性能与地图约束见项目记忆

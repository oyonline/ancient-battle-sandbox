# F11 观察项排查笔记：营卡条溢出与"点 2 选 1"坐标漂移（F12）

> 排查人：ui-writer（task-18/F12）。结论：**产品点击映射无缺陷；QA 观察项是 playwright
> 裸坐标派发跨帧陈旧的测试学边角**。顺带修复了一个真实的滚动位置微缺陷。
> 本文档替代"为迁就探针改布局"的任何产品改动。

## 1. 布局实况（1440×900，4-6+ 己方营）

实测（领土局，营卡条 `#battalion-picker`）：

| 项 | 值 |
|---|---|
| 条内尺寸 | clientWidth ≈ 386px（随 `#battalion-bar` 右停靠 min(410px,…)） |
| 内容尺寸 | scrollWidth ≈ 1378px（7 营时；每卡 157-243px） |
| 溢出处理 | `overflow-x: auto`（css `#battalion-picker`），单行不换行 |
| 可见性 | 第 1 卡完整可见；第 2 卡起被右缘裁剪（QA 观测的第 3/4 卡 rect.x=1421/1669 即此） |
| 可达性 | 卡片为 `<button>`：横向滚动可达、Tab 聚焦 + Enter 可激活；playwright `locator.click()` 自动滚动 + actionability 后正确点中（实测深居 x=2250 的卡命中其营） |

即：**溢出是设计内行为**（窄条 + 横滚），右侧卡对真人可达可点，无需改布局。

## 2. 产品映射一致性（无"显示 A 卡、点击选 B 营"）

`js/ui.js renderBattalionPicker` 的两条路径都以 `dataset.bid` 为锚：

- 增量刷新分支的进入条件要求**逐位** `chip.dataset.bid === list[i].id` 且
  `chip.dataset.slot === 当前槽位`；不满足即整体重建。卡面文字（`[N] X营`）与
  `dataset.bid`、`onclick` 闭包捕获的 `battalion.id` 三者同源同帧生成。
- 重建分支 `replaceChildren()` 后全部重绑，不存在新旧混合的中间态（单线程，
  事件不可能在同步重建中途派发）。

回归测试 `tests/ui-chip-consistency.test.js`「营卡映射时序矩阵」在以下时序交错下
断言每张卡的三方一致（dataset.bid ≡ 卡面营号 ≡ 点击选中的营）：
选中切换（走增量刷新、节点不重建）、营亡解散、新营入列领取空槽、选中切换后再营亡。
全部通过——产品逻辑不存在 QA 栈指向的错选路径。

## 3. QA 观察项的机制复现（测试学边角）

QA 栈：坐标点击 `.battalion-chip[data-bid="2"]` → `selectBattalionById(1)`。
实机复现（`docs` 本笔记同轮探针，探针不在仓库内）：

1. 探针把卡条 `scrollLeft` 滚到 260，采样 `data-bid=2` 卡中心屏幕坐标 (1129, 754)；
2. 一帧后尾部新营入列触发卡片重建，且（修复前行为）`replaceChildren()` 清空内容使
   浏览器把 `scrollLeft` 塌缩回 0——前两张卡整体右移回初始位置；
3. 探针按**陈旧坐标**裸 `mouse.click(1129, 754)` 派发：该坐标下方此刻是
   `data-bid=1` 的卡 → `selectBattalionById(1)` 被调用、84ms 内选中变 1——
   **与 QA 调用栈逐字吻合**；
4. 对照组：同卡 `evaluate(el => el.click())` 与 `locator.click()`
   （自带 actionability 检查 + 自动滚动）都正确调 `selectBattalionById(2)`——
   与 QA"最小复刻不复现、evaluate 派发正确"一致。

结论：错选发生在**采样与派发之间的 DOM 漂移**（滚动塌缩 + 卡位右移），不是
元素到营的映射错误。真人不受影响：真人看哪点哪，坐标即所见，不存在跨帧陈旧。

**给 QA 探针的规约**（后续脚本请遵循）：
- 溢出条上的卡一律用 `locator.click()`（actionability + 自动滚动），不要
  `getBoundingClientRect()` 采样后再 `mouse.click(x, y)` 裸派发；
- 若必须坐标派发（如测 canvas 战场），采样与派发之间不得让游戏推进帧
  （暂停 `scene.paused = true`），或派发前重新采样。

## 4. 顺带真修：重建分支的滚动位置保持

排查中确认一个真实微缺陷（非 QA 栈根因，但同机制且影响真人）：
用户把卡条滚到右侧看 4-6 号营卡时，任何触发重建的列表变化（营亡/新营）
会把 `scrollLeft` 塌缩回 0，视口被拽回左端。

修复：`renderBattalionPicker` 重建分支在 `replaceChildren()` 前保存 `scrollLeft`、
重建完成后恢复（浏览器按新内容宽度自动夹紧）。三行改动，不改布局。
测试：`tests/ui-chip-consistency.test.js`「营卡条重建保持横向滚动位置」——
DOM 桩按浏览器语义建模（清空内容即夹回 0），先红后绿。

该修复同时收窄了第 3 节探针边角的失效窗口（重建后卡位不再跳变），
但定位仍是 UX 加固，不是为探针改产品。

## 5. 交付物清单

- `tests/ui-chip-consistency.test.js`：映射时序矩阵 + 滚动保持（2 测试）
- `js/ui.js`：renderBattalionPicker 重建分支滚动保存/恢复（3 行）
- 本笔记：`docs/ui-f11-chip-overflow-note.md`
- 布局无改动、无 css 改动（溢出为设计内行为）

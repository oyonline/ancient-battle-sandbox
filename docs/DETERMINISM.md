# 确定性约定（Determinism Conventions）

> 2026-09-29 第 0 批地基确立。所有战斗模拟 / AI 代码必须遵守。
> 背景：HANDOFF.md 记录的 09-28 镜像发散案例——1e-15 量级的浮点算术噪声
> （`16-2.4` vs `54+2.4`）在格子边界翻转离散决策，单帧 6e-3 偏差混沌放大到 0.75。

## 为什么需要

- **镜像对称回归**：`tools/debug-cav-mirror.js`、`tools/debug-seat-mirror.js` 要求红蓝换座（x→GRID_W−x）后战斗逐步一致；combat-balance 测试断言两座位存活数相等。
- **未来锁步联网**（路线图第 4 批）：双方模拟必须逐帧一致，浮点噪声同样致命。

## 三条规则

1. **离散决策输入先量化**：凡进入"比较后走不同分支"的值（距离比较、阈值判断、
   采样点坐标、格子索引），先用 `quantizeDecision()`（`js/battle/determinism.js`，
   量子 0.05）量化再比较。1e-15 噪声 << 量子 0.05，量化后两座位输入相同。
2. **连续量不得量化**：渲染插值、速度估计、动画等连续量保持原始精度。
3. **读帧首快照**：规划循环内单位按数组序更新，后手不得读先手刚写的新值——
   冲锋视图（`chargeView*`）、矛兵 moving（`pikeViewMoving`）等统一读帧首快照
   （`stepBattle` 帧首循环负责打快照）。

## 镜像换算备忘（调试极易搞错）

x 镜像（x→GRID_W−x）下：`centerX→GRID_W−x`；**axisX 不变、axisY 取反**
（axis=(−faceY,faceX)，faceX 取反 faceY 不变）；riderAxis 取反；
detourSign 取反（红 +1 / 蓝 −1）；落点直接镜像。

## 回归门

改任何模拟 / AI 代码后必须：

```bash
node --test "tests/*.test.js"        # 全量（引号必须）
node tools/debug-cav-mirror.js       # 镜像发散检查（本战场）
node tools/debug-seat-mirror.js      # 换座镜像检查
```

三者全绿才算过。

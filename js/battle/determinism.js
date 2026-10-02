// ==================== 确定性量化工具 ====================
// 战场要求镜像对称（红蓝换座 x→board.W-x 后逐步一致）与将来锁步联网一致。
// 浮点算术噪声（~1e-15，如 16-2.4 与 54+2.4 的不对称）在格子/阈值边界上
// 会翻转离散决策，单帧 1e-3 偏差经混沌放大成宏观分歧（见 HANDOFF.md 09-28 案例）。
// 约定：凡进入【离散决策】的比较值先量化——量子 0.05 远大于噪声、
// 远小于任何游戏尺度，量化后两座位的输入相同，决策必相同。

export const DECISION_QUANTUM = 0.05;

// 半量子边界的浮点噪声吸收：输入坐标/距离是浮点运算结果，"恰好落在半量子点"
//（如 0.925 = 18.5 量子）的值在镜像两侧会得到 18.499999…943 与 18.500000…228
// 两种表示，四舍五入后落到不同档位，造成一侧攻击一侧不攻击的分裂。
// 约定（与 Math.round 的半进位契约一致）：半量子点统一归属【上一档】。
// 实现是在商上叠加 1e-9（相当于原值 ~5e-11 的偏移）：只吸收 1e-14 量级的
// 表示噪声，不改变任何真实间隔 ≥1e-6 的判定（见 tests/worker-defense.test.js
// 的 0.924999 / 0.925001 阶梯断言）。IEEE754 双精度下确定性不变。
const HALF_QUANTUM_EPSILON = 1e-9;

// 量化到 0.05 网格：round(v*20)/20。用于离散决策输入（距离比较、阈值判断、
// 采样点坐标），不得用于连续量（渲染插值、速度估计等）。
export function quantizeDecision(value) {
    return Math.round(value / DECISION_QUANTUM + HALF_QUANTUM_EPSILON) * DECISION_QUANTUM;
}

// 空间哈希桶坐标：先量化查询坐标再取整，落在格边的采样点两座位查同一组桶。
export function quantizeBucketCoord(value, cell) {
    return Math.floor(quantizeDecision(value) / cell);
}

// 带容差的对称比较：a 明显小于 b（容差内视为相等）。容差按量子取。
export function lessByQuantum(a, b) {
    return a < b - DECISION_QUANTUM / 2;
}

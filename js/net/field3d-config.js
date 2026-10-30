// 对冲联机只接受预设名；不开放任意配兵。纯逻辑，浏览器与服务器共用。
// main.js CLASSIC = 300/60/80/60；CAP 为两队共用的表现池容量。
const CAP = Object.freeze({ infantry: 700, pikeman: 160, archer: 200, cavalry: 160 });
export const FIELD3D_PRESETS = Object.freeze({
    small: Object.freeze({ infantry: 150, pikeman: 30, archer: 40, cavalry: 30 }), // 250
    standard: Object.freeze({ infantry: 300, pikeman: 60, archer: 80, cavalry: 60 }), // 500
    large: Object.freeze({ infantry: 350, pikeman: 80, archer: 100, cavalry: 70 }) // 600
});
// units.js FORMATIONS / game.js deployUnits 的既有枚举子集，无隐式 fallback。
const FORMATIONS = ['custom', 'square', 'wedge', 'mixed', 'line'];
const TACTICS = ['advance', 'assault', 'flank', 'hold', 'hold_ground'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateField3dConfig(cfg) {
    if (!record(cfg) || Object.keys(cfg).length !== 3 ||
        !Object.keys(cfg).every(key => ['preset', 'formation', 'tactic'].includes(key))) {
        return { ok: false, error: '配置只允许 preset、formation、tactic 三个字段。' };
    }
    if (typeof cfg.preset !== 'string' || !Object.hasOwn(FIELD3D_PRESETS, cfg.preset) ||
        !FORMATIONS.includes(cfg.formation) || !TACTICS.includes(cfg.tactic)) {
        return { ok: false, error: '未知兵力预设、阵型或战术，请刷新配置。' };
    }
    return { ok: true, value: { preset: cfg.preset, formation: cfg.formation, tactic: cfg.tactic } };
}

// 缺座或非法配置抛错；调用者不得在未收齐配置时部署。返回副本，避免污染共享预设。
export function resolveArmies(configs) {
    if (!record(configs) || Object.keys(configs).length !== 2 ||
        !Object.keys(configs).every(key => ['red', 'blue'].includes(key))) {
        throw new Error('需要红蓝双方配置。');
    }
    const armies = {};
    for (const side of ['red', 'blue']) {
        const checked = validateField3dConfig(configs[side]);
        if (!checked.ok) throw new Error(checked.error);
        armies[side] = { ...FIELD3D_PRESETS[checked.value.preset] };
    }
    assertField3dCapacity(armies);
    return armies;
}

// 与预设白名单分开，直接检验两队展开后的实际兵力。
export function assertField3dCapacity(armies) {
    for (const side of ['red', 'blue']) {
        for (const [type, count] of Object.entries(armies[side])) {
            if (!Object.hasOwn(CAP, type) || !Number.isSafeInteger(count) || count < 0) {
                throw new Error('兵种或数量非法。');
            }
        }
    }
    for (const [type, capacity] of Object.entries(CAP)) {
        if (armies.red[type] + armies.blue[type] > capacity) throw new Error(`${type} 超过两队共用容量。`);
    }
}

// 固定字段序与座位序；rev 也入摘要，防止用旧部署确认新修订。
export function configDigest(configs, rev) {
    resolveArmies(configs);
    if (!Number.isSafeInteger(rev) || rev < 0) throw new Error('配置修订号非法。');
    const canonical = JSON.stringify([rev, ...['red', 'blue'].map(side => {
        const { preset, formation, tactic } = configs[side];
        return [preset, formation, tactic];
    })]);
    let hash = 5381;
    for (let i = 0; i < canonical.length; i++) hash = ((hash << 5) + hash + canonical.charCodeAt(i)) >>> 0;
    return hash.toString(36);
}

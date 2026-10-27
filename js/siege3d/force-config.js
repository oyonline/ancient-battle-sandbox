import { CAMP_LAYOUT } from './layout.js';

export const FORCE_LIMIT = 750;
export const FORCE_STORAGE_KEY = 'siege3d-force-config-v1';
export const FORCE_FIELDS = Object.freeze({
    attackers: Object.freeze({
        infantry: Object.freeze({ label: '剑士', min: 0, max: 400, step: 10 }),
        pikeman: Object.freeze({ label: '长枪', min: 0, max: 100, step: 5 }),
        archer: Object.freeze({ label: '弓手', min: 0, max: 60, step: 5 })
    }),
    defenders: Object.freeze({
        infantry: Object.freeze({ label: '步兵', min: 10, max: 150, step: 5 }),
        archer: Object.freeze({ label: '弓手', min: 0, max: 40, step: 2 })
    })
});
const freezeConfig = config => Object.freeze({
    attackers: Object.freeze({ ...config.attackers }), defenders: Object.freeze({ ...config.defenders })
});
export const DEFAULT_FORCE_CONFIG = freezeConfig(CAMP_LAYOUT);
export const FORCE_PRESETS = Object.freeze({
    standard: DEFAULT_FORCE_CONFIG,
    gentle: freezeConfig({ attackers: DEFAULT_FORCE_CONFIG.attackers, defenders: { infantry: 40, archer: 10 } }),
    grand: freezeConfig({ attackers: { infantry: 400, pikeman: 100, archer: 60 }, defenders: { infantry: 150, archer: 40 } })
});
export const totalTroops = army => Object.values(army).reduce((sum, count) => sum + count, 0);
const copy = config => ({ attackers: { ...config.attackers }, defenders: { ...config.defenders } });
const hasOnlyKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validateForceConfig(config) {
    if (!hasOnlyKeys(config, Object.keys(FORCE_FIELDS))) return false;
    for (const [side, fields] of Object.entries(FORCE_FIELDS)) {
        if (!hasOnlyKeys(config[side], Object.keys(fields))) return false;
        for (const [kind, { min, max }] of Object.entries(fields)) {
            const count = config[side][kind];
            if (!Number.isInteger(count) || count < min || count > max) return false;
        }
        if (totalTroops(config[side]) < 10) return false;
    }
    return totalTroops(config.attackers) + totalTroops(config.defenders) <= FORCE_LIMIT;
}

export function clampForceCount(side, kind, value) {
    const field = FORCE_FIELDS[side]?.[kind];
    if (!field) throw new Error('Unknown force field');
    return Number.isFinite(value) ? Math.max(field.min, Math.min(field.max, Math.trunc(value)))
        : DEFAULT_FORCE_CONFIG[side][kind];
}

export function editForceConfig(config, side, kind, value) {
    const next = copy(config);
    next[side][kind] = clampForceCount(side, kind, value);
    return validateForceConfig(next) ? next : config;
}

export function loadForceConfig(storage) {
    try {
        const stored = JSON.parse((storage ?? globalThis.localStorage).getItem(FORCE_STORAGE_KEY));
        if (validateForceConfig(stored)) return copy(stored);
    } catch { /* Storage can be unavailable, denied, or contain malformed data. */ }
    return copy(DEFAULT_FORCE_CONFIG);
}

export function saveForceConfig(config, storage) {
    try {
        if (!validateForceConfig(config)) return false;
        (storage ?? globalThis.localStorage).setItem(FORCE_STORAGE_KEY, JSON.stringify(config));
        return true;
    } catch { return false; }
}

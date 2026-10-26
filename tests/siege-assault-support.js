import { createHash } from 'node:crypto';

// Exact numbers, array order and every data field of the existing siege state.
// New command metadata is intentionally outside the legacy golden contract.
export function stateSummary(s) {
    const data = value => JSON.parse(JSON.stringify(value, (key, v) =>
        typeof v === 'function' ? undefined : v instanceof Set ? [...v] : v));
    return {
        units: s.units.map(u => [u.id, u.gx, u.gy, u.hp, u.morale, u.moraleState,
            u.dead, u.withdrawn, u.lastAttack, u.siegeRole]),
        ladders: s.siege.ladders.map(({ face, ...legacy }) => data(legacy)),
        ram: data(s.siege.ram), gate: data(s.siege.gate), rules: data(s.siege.rules),
        landedCount: s.siege.landedCount, battleOver: s.battleOver,
        winner: s.winner, endReason: s.endReason
    };
}
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

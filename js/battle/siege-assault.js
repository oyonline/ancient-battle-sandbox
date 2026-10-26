import { CombatRules } from '../combat.js';
import { moveToward } from '../units.js';
import { isHostile } from '../factions.js';
import { quantizeDecision as q, DECISION_QUANTUM } from './determinism.js';

export const ASSAULT_FACES = ['north', 'east', 'south', 'west'];
// Match the ram's four crew slots; reserves walk here through waiting assault AI.
const RAM_RESERVE_SLOTS = [[-.88, -.5], [.88, -.5], [-.88, .5], [.88, .5]];

export function clearSiegeArcherPost(unit) {
    if (!unit.siegeArcherPost) return;
    delete unit.siegeArcherPost;
    delete unit.guardRadius;
    unit.groundGuardReturning = false;
    unit.groundGuardTarget = null;
}

// Camp-only command ownership. Waiting archers use the ordinary ranged chain;
// melee soldiers retain their existing movement/contact and delayed hits.
export function installPlayerAssault(layer, {
    attackerControl = 'auto', stagingClearance = 11, battleDeadlineSeconds = null,
    attackerTeam = 'red', archerLineClearance
}) {
    const player = attackerControl === 'player';
    if (player && (!Number.isFinite(archerLineClearance) || !Number.isFinite(stagingClearance) ||
        !(archerLineClearance < stagingClearance)))
        throw new Error('player assault requires finite archerLineClearance < stagingClearance');
    const keys = [...ASSAULT_FACES, 'ram'];
    const assault = layer.assault = {
        player, attackerControl, stagingClearance, battleDeadlineSeconds, attackerTeam, archerLineClearance,
        released: Object.fromEntries(keys.map(k => [k, !player])),
        releasedAt: Object.fromEntries(keys.map(k => [k, player ? null : 0])),
        apply(scene, command) {
            if (!player || scene.battleOver || scene.resolvingOutcome || command?.side !== attackerTeam) return false;
            const key = command.k === 'siegeRam' ? 'ram' : command.k === 'siegeAssault' ? command.face : null;
            if (!keys.includes(key) || (command.k === 'siegeAssault' && !ASSAULT_FACES.includes(key)) || assault.released[key]) return false;
            assault.released[key] = true;
            assault.releasedAt[key] = scene.simulationTime;
            if (key === 'south' && !assault.released.ram && layer.ram) {
                const ram = layer.ram;
                const distance = u => q(Math.hypot(u.gx - ram.gx, u.gy - ram.gy));
                const reserves = scene.units.filter(u => u.team === attackerTeam && u.team === ram.team &&
                    u.siegeWing === 'south' && u.type === 'infantry' && !u.dead && !u.withdrawn &&
                    u.moraleState !== 'routing' && !u.siegeRole && !u.siegeAnchor)
                    .sort((a, b) => distance(a) - distance(b) || a.id - b.id)
                    .slice(0, RAM_RESERVE_SLOTS.length);
                reserves.forEach((unit, i) => {
                    const [dx, dy] = RAM_RESERVE_SLOTS[i];
                    unit.siegeRamReserve = true;
                    unit.siegeStaging = { gx: ram.gx + dx, gy: ram.gy + dy };
                });
            }
            for (const unit of scene.units) if (unit.team === attackerTeam && unit.siegeWing === key)
                clearSiegeArcherPost(unit);
            return true;
        },
        act(scene, unit, now, dt) {
            if (!player) return false;
            if (unit.team !== attackerTeam) return false;
            if (assault.released[unit.siegeWing] && !unit.siegeRamReserve) { clearSiegeArcherPost(unit); return false; }
            if (unit.siegeRole || unit.siegeClimb ||
                unit.dead || unit.withdrawn || unit.moraleState === 'routing') return false;
            if (unit.type === 'archer' && unit.siegeArcherPost) {
                unit.guardRadius = 1.25;
                scene.updateNormalUnit(unit, now, dt, unit.siegeArcherPost);
                return true;
            }
            // Core fallback excludes archers; wavering archers still need their post.
            if (unit.moraleState === 'wavering' && unit.moraleFallBackUntil > now) return false;
            if (!['infantry', 'pikeman'].includes(unit.type) || !unit.siegeStaging) return false;
            let target = null, nearest = Infinity;
            scene.forEachNear(unit.gx, unit.gy, unit.typeData.range + DECISION_QUANTUM, enemy => {
                if (!CombatRules.canBeHit(enemy) || !isHostile(scene, unit.team, enemy.team)) return;
                const distance = q(Math.hypot(enemy.gx - unit.gx, enemy.gy - unit.gy));
                if (distance > q(unit.typeData.range)) return;
                if (distance < nearest || (distance === nearest && enemy.id < target.id)) {
                    target = enemy; nearest = distance;
                }
            });
            unit.target = unit.meleeTarget = target;
            unit.strafeUntil = 0;
            if (target) CombatRules.attack(scene, unit, target, now, unit.typeData.range, DECISION_QUANTUM / 2);
            else if (q(Math.hypot(unit.gx - unit.siegeStaging.gx, unit.gy - unit.siegeStaging.gy)) > .1)
                moveToward(unit, unit.siegeStaging.gx, unit.siegeStaging.gy, unit.typeData.speed, dt);
            return true;
        }
    };
}

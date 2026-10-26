import { CombatRules } from '../combat.js';
import { moveToward } from '../units.js';
import { isHostile } from '../factions.js';
import { quantizeDecision as q, DECISION_QUANTUM } from './determinism.js';

export const ASSAULT_FACES = ['north', 'east', 'south', 'west'];

// Camp-only command ownership. No anchors: ordinary movement/contact and delayed
// CombatRules hits remain responsible for every waiting soldier.
export function installPlayerAssault(layer, {
    attackerControl = 'auto', stagingClearance = 11, battleDeadlineSeconds = null,
    attackerTeam = 'red'
}) {
    const player = attackerControl === 'player';
    const keys = [...ASSAULT_FACES, 'ram'];
    const assault = layer.assault = {
        player, attackerControl, stagingClearance, battleDeadlineSeconds, attackerTeam,
        released: Object.fromEntries(keys.map(k => [k, !player])),
        releasedAt: Object.fromEntries(keys.map(k => [k, player ? null : 0])),
        apply(scene, command) {
            if (!player || scene.battleOver || scene.resolvingOutcome || command?.side !== attackerTeam) return false;
            const key = command.k === 'siegeRam' ? 'ram' : command.k === 'siegeAssault' ? command.face : null;
            if (!keys.includes(key) || (command.k === 'siegeAssault' && !ASSAULT_FACES.includes(key)) || assault.released[key]) return false;
            assault.released[key] = true;
            assault.releasedAt[key] = scene.simulationTime;
            return true;
        },
        act(scene, unit, now, dt) {
            if (!player) return false;
            if (unit.team !== attackerTeam || !['infantry', 'pikeman'].includes(unit.type) ||
                !unit.siegeStaging || assault.released[unit.siegeWing] || unit.siegeRole || unit.siegeClimb ||
                unit.dead || unit.withdrawn || unit.moraleState === 'routing' ||
                (unit.moraleState === 'wavering' && unit.moraleFallBackUntil > now)) return false;
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

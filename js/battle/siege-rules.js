// Camp-only rules; installed explicitly by createCampSiege, never by field modes.
import { moveToward } from '../units.js';
import { withdrawUnit } from './morale-bridge.js';
import { UI } from '../ui.js';

export function installSiegeRules(layer, b, config) {
    const alive = u => !u.dead && !u.withdrawn && u.hp > 0;
    const inside = u => u.gx >= b.x1 && u.gx <= b.x2 && u.gy >= b.y1 && u.gy <= b.y2;
    const distance = u => Math.hypot(u.gx - b.cx, u.gy - b.cy);
    const rules = layer.rules = {
        config, bounds: b, captureSeconds: 0, attackersAtTent: false, attackerLossRate: 0,
        defender: u => u.team === config.defenderTeam,
        sheltered: u => rules.defender(u) && inside(u) && distance(u) <= config.retreatRadius,
        moraleLoss(u, loss) { return rules.defender(u) ? loss / (1 + config.defenderMoraleBonus) : loss; },
        moraleRecovery(u, recovery) { return rules.defender(u) ? recovery * (1 + config.defenderMoraleBonus) : recovery; },
        route(scene, u, dt) {
            if (!rules.defender(u)) return false;
            // Tower anchors must release before core's anchored-AI branch.
            delete u.siegeAnchor;
            u.strafeUntil = 0;
            u.target = u.meleeTarget = null;
            if (inside(u) && distance(u) <= config.retreatRadius) { u.moving = false; return true; }
            const goal = inside(u) ? { gx: b.cx, gy: b.cy }
                : { gx: b.cx, gy: b.y2 - 1 };
            // moveToward navigates dynamic walls; unreachable goals use clipped wall sliding.
            moveToward(u, goal.gx, goal.gy, u.typeData.speed, dt);
            return true;
        },
        constrainRouts(scene) {
            // Separation/knockback may push a rout outwards after its movement order.
            for (const u of scene.units) {
                if (!alive(u) || !rules.defender(u) || u.moraleState !== 'routing') continue;
                const previous = { gx: u.pgx, gy: u.pgy };
                if (!inside(previous)) continue;
                u.gx = Math.max(b.x1 + .36, Math.min(b.x2 - .36, u.gx));
                u.gy = Math.max(b.y1 + .36, Math.min(b.y2 - .36, u.gy));
                if (distance(u) > distance(previous) || distance(previous) <= config.retreatRadius) {
                    u.gx = previous.gx; u.gy = previous.gy;
                }
            }
        },
        scaleImpacts(impacts) {
            // Scale the complete batch before deaths apply: simultaneous return hits
            // keep the same bonus even if the guard dies earlier in the batch.
            for (const hit of impacts) if (hit.from && rules.defender(hit.from) && !hit.from.typeData.ranged &&
                hit.target.siegeClimb?.waiting && layer.meleeBypass(hit.from, hit.target)) hit.damage *= config.ladderGuardDamage;
        },
        archerPrefers(unit, candidate, current) {
            const rank = e => e.siegeClimb?.waiting ? 0 : e.siegeRole === 'ram' ? 1 :
                !inside(e) && Math.hypot(Math.max(b.x1 - e.gx, 0, e.gx - b.x2),
                    Math.max(b.y1 - e.gy, 0, e.gy - b.y2)) <= config.wallFootRadius ? 2 : 3;
            if (!current) return true;
            const delta = rank(candidate) - rank(current) ||
                Math.hypot(candidate.gx - unit.gx, candidate.gy - unit.gy) - Math.hypot(current.gx - unit.gx, current.gy - unit.gy);
            return delta < 0 || (delta === 0 && candidate.id < current.id);
        },
        checkWin(scene) {
            const attackers = scene.units.filter(u => alive(u) && u.team === config.attackerTeam);
            const defenders = scene.units.filter(u => alive(u) && rules.defender(u));
            const stats = scene.battleStats;
            const routed = attackers.filter(u => u.moraleState === 'routing').length;
            rules.attackerLossRate = (stats[config.attackerTeam].lost + routed) / Math.max(1, stats[config.attackerTeam].initial);
            rules.attackersAtTent = attackers.some(u => distance(u) <= config.captureRadius);
            const uncontested = rules.attackersAtTent && !defenders.some(u => distance(u) <= config.captureRadius);
            const now = scene.simulationTime;
            if (!uncontested) rules.captureSince = null;
            else if (rules.captureSince == null) rules.captureSince = now;
            rules.captureSeconds = uncontested ? (now - rules.captureSince) / 1000 : 0;
            let winner, reason, withdraw;
            if (!attackers.length || !defenders.length) {
                winner = !attackers.length && !defenders.length ? 'draw' : attackers.length ? config.attackerTeam : config.defenderTeam;
                reason = '一方全灭';
            } else if (rules.captureSeconds + 1e-9 >= config.captureSeconds) {
                winner = config.attackerTeam; reason = '攻方夺寨';
            } else if ((attackers.some(u => distance(u) <= config.surrenderRadius) &&
                !defenders.some(u => inside(u) && ['steady', 'wavering'].includes(u.moraleState))) ||
                defenders.length <= stats[config.defenderTeam].initial * config.surrenderFraction) {
                winner = config.attackerTeam; reason = '守军投降'; withdraw = defenders;
            } else if (rules.attackerLossRate + 1e-12 >= config.attackerRetreatFraction) {
                winner = config.defenderTeam; reason = '攻方受挫撤退'; withdraw = attackers;
            }
            if (!winner) return;
            rules.routedAtOutcome = { [config.attackerTeam]: routed,
                [config.defenderTeam]: defenders.filter(u => u.moraleState === 'routing').length };
            for (const u of withdraw || []) {
                // Siege withdrawal is unconditional even if a caller enabled deathmatch.
                u.moraleState = 'routing';
                withdrawUnit(scene, u, { force: true });
            }
            scene.battleOver = true;
            scene.battleQueue = [];
            scene.endReason = reason;
            scene.addBattleEvent('siege-end', reason, winner);
            scene.showVictory(winner);
            UI.onBattleEnd(winner, scene.getBattleReport());
        }
    };
}

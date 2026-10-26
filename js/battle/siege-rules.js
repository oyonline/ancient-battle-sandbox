// Camp-only rules; installed explicitly by createCampSiege, never by field modes.
import { moveToward } from '../units.js';
import { withdrawUnit } from './morale-bridge.js';
import { UI } from '../ui.js';
import { quantizeDecision as q } from './determinism.js';

export function installSiegeRules(layer, b, config, wallThickness = 0) {
    const alive = u => !u.dead && !u.withdrawn && u.hp > 0;
    const inside = u => u.gx >= b.x1 && u.gx <= b.x2 && u.gy >= b.y1 && u.gy <= b.y2;
    const distance = u => Math.hypot(u.gx - b.cx, u.gy - b.cy);
    // Bounds are the inner edge; walls extend outwards by wallThickness.
    const wallDistance = u => Math.hypot(Math.max(b.x1 - wallThickness - u.gx, 0, u.gx - b.x2 - wallThickness),
        Math.max(b.y1 - wallThickness - u.gy, 0, u.gy - b.y2 - wallThickness));
    const outsideWall = u => u.gx < b.x1 - wallThickness || u.gx > b.x2 + wallThickness ||
        u.gy < b.y1 - wallThickness || u.gy > b.y2 + wallThickness;
    const rules = layer.rules = {
        config, bounds: b, captureSeconds: 0, attackersAtTent: false, attackerLossRate: 0,
        contactAt: null, lastProgressAt: null, attackerStallSeconds: 0, everInside: new Set(), landedCount: 0, ramHits: 0,
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
            for (const hit of impacts) {
                if (config.interiorMeleeCover !== undefined && hit.from && !hit.from.typeData.ranged &&
                    rules.defender(hit.target) && inside(hit.target)) hit.damage *= config.interiorMeleeCover;
                if (hit.from && rules.defender(hit.from) && !hit.from.typeData.ranged &&
                    hit.target.siegeClimb?.waiting && layer.meleeBypass(hit.from, hit.target)) hit.damage *= config.ladderGuardDamage;
                // Apply after armor and the existing height/cover/roll calculation so
                // roof damage is exactly the uncovered hit x cover (no extra rounding).
                if (layer.ram && hit.from?.typeData.ranged && hit.target.siegeRole === 'ram')
                    hit.damage *= config.ramRoofCover ?? 1;
            }
        },
        inDeadZone(u) {
            return config.deadZone !== undefined && u.team === config.attackerTeam &&
                !u.siegeClimb && u.siegeRole !== 'ram' && outsideWall(u) && wallDistance(u) <= config.deadZone;
        },
        canShoot(unit, target) {
            return !rules.defender(unit) || layer.heightAt(unit.gx, unit.gy) > 0 || !rules.inDeadZone(target);
        },
        rangedTarget(scene, unit) {
            let target = null;
            for (const e of scene.units) {
                if (!alive(e) || e.team !== config.attackerTeam || !rules.canShoot(unit, e)) continue;
                const d = Math.hypot(e.gx - unit.gx, e.gy - unit.gy);
                const previous = target ? Math.hypot(target.gx - unit.gx, target.gy - unit.gy) : Infinity;
                if (d < previous || (d === previous && e.id < target.id)) target = e;
            }
            return target;
        },
        rangeScale(unit) {
            if (!rules.defender(unit) || unit.type !== 'archer') return 1;
            const height = layer.heightAt(unit.gx, unit.gy);
            if (height === 0) return 1;
            const tower = layer.platforms.some(p => p.kind === 'tower' && p.height === height &&
                unit.gx >= p.x1 && unit.gx <= p.x2 && unit.gy >= p.y1 && unit.gy <= p.y2);
            return (tower ? config.towerRangeScale : config.walkwayRangeScale) ?? 1;
        },
        archerPrefers(unit, candidate, current) {
            if (config.deadZone !== undefined) {
                const elevated = layer.heightAt(unit.gx, unit.gy) > 0;
                const advancing = e => outsideWall(e) && wallDistance(e) > config.deadZone &&
                    wallDistance(e) <= config.advanceRadius &&
                    // Frame-start velocity, unaffected by planning order or facing animation.
                    (Math.max(b.x1 - wallThickness, Math.min(b.x2 + wallThickness, e.gx)) - e.gx) * (e.velX ?? 0) +
                    (Math.max(b.y1 - wallThickness, Math.min(b.y2 + wallThickness, e.gy)) - e.gy) * (e.velY ?? 0) > 0;
                const rank = e => e.siegeClimb?.waiting ? 0 :
                    elevated && rules.inDeadZone(e) ? 1 : e.type === 'archer' ? 2 :
                    !elevated && advancing(e) ? 3 : 4;
                if (!current) return true;
                const delta = rank(candidate) - rank(current) ||
                    Math.hypot(candidate.gx - unit.gx, candidate.gy - unit.gy) - Math.hypot(current.gx - unit.gx, current.gy - unit.gy);
                return delta < 0 || (delta === 0 && candidate.id < current.id);
            }
            // Legacy layers without the new configuration retain P3's original discipline.
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
            // Contact is historical: disengaging never restarts the stall clock.
            if (rules.contactAt === null && ((layer.ram?.hits ?? 0) > 0 || attackers.some(u =>
                u.siegeClimb || (u.moraleState !== 'routing' && !inside({ gx: q(u.gx), gy: q(u.gy) }) &&
                    q(wallDistance(u)) <= q(config.wallFootRadius))))) {
                rules.contactAt = now;
                rules.lastProgressAt = rules.contactAt;
            }
            const previousCaptureSeconds = rules.captureSeconds;
            if (!uncontested) rules.captureSince = null;
            else if (rules.captureSince == null) rules.captureSince = now;
            rules.captureSeconds = uncontested ? (now - rules.captureSince) / 1000 : 0;
            // Only a unit's first entry counts, even if it later leaves and returns.
            let newEntry = false;
            for (const u of attackers) if (inside(u) && !u.siegeClimb && !rules.everInside.has(u.id)) {
                rules.everInside.add(u.id);
                newEntry = true;
            }
            const landedCount = layer.landedCount ?? 0, ramHits = layer.ram?.hits ?? 0;
            if (rules.contactAt !== null && (newEntry || landedCount > rules.landedCount || ramHits > rules.ramHits ||
                rules.captureSeconds > previousCaptureSeconds)) rules.lastProgressAt = now;
            rules.landedCount = landedCount;
            rules.ramHits = ramHits;
            rules.attackerStallSeconds = rules.contactAt === null ? 0 : (now - rules.lastProgressAt) / 1000;
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
            } else if (rules.contactAt !== null && rules.attackerLossRate + 1e-12 >= config.attackerRetreatFraction &&
                rules.attackerStallSeconds + 1e-9 >= (config.attackerStallSeconds ?? 20)) {
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
    if (config.deadZone !== undefined) {
        const meleeBypass = layer.meleeBypass;
        layer.meleeBypass = (from, target) => meleeBypass(from, target) ||
            (rules.defender(from) && !from.typeData.ranged && layer.heightAt(from.gx, from.gy) > 0 &&
                rules.inDeadZone(target));
    }
}

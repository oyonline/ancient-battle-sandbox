// 溃兵收拢与预备队波次（原 TacticsSystem 集结组，调用面不变）。
import { dist } from '../units.js';

export const RallyMethods = {
    reserveSupport(unit) {
        const group = this.groups[unit.team];
        return !!group && this.safeAt(unit.team, unit.gx, unit.gy) &&
            group.safeReserve.filter(other => other !== unit && this.active(other) && other.moraleState === 'steady' &&
                !other.reserveCommitted && dist(unit, other) <= 5 && this.safeAt(other.team, other.gx, other.gy)).length >= 3;
    },

    rallyPoint(unit) {
        const group = this.groups[unit.team];
        const reserves = group?.safeReserve.filter(other => this.active(other) && !other.reserveCommitted &&
            other.moraleState === 'steady' && this.safeAt(other.team, other.gx, other.gy)) || [];
        if (reserves.length < 3) return null;
        const anchors = reserves.filter(candidate => reserves.filter(other => dist(candidate, other) <= 4).length >= 3);
        anchors.sort((a, b) => {
            const delta = dist(unit, a) - dist(unit, b);
            return Math.abs(delta) > 1e-9 ? delta : a.id - b.id;
        });
        if (!anchors.length) return null;
        const center = { gx: anchors[0].gx, gy: anchors[0].gy };
        return this.outsideRoute(unit, center, group, 2.6);
    },

    updateReception(group, routed) {
        const waiting = group.reserve.filter(unit => this.active(unit) && !unit.reserveCommitted);
        const wing = routed.filter(unit => unit.tacticalRole === 'flank' &&
            (unit.gx - group.cx) * this.forward(unit.team) > -group.half - 3);
        const candidate = wing.sort((a, b) => a.id - b.id)[0];
        const helpers = candidate && waiting.length >= 6 ? waiting.slice(-Math.min(5, waiting.length - 3)) : [];
        const sign = candidate?.gy <= group.cy ? -1 : 1;
        const center = { gx: group.cx - this.forward(group.team) * group.half * 0.25,
            gy: group.cy + sign * (group.half + 7.5) };
        for (const unit of group.reserve) unit.receptionSlot = null;
        if (!candidate || !this.safeAt(group.team, center.gx, center.gy)) return;
        helpers.forEach((unit, index) => {
            const point = { gx: center.gx + this.forward(group.team) * (index - (helpers.length - 1) / 2) * 0.82,
                gy: center.gy };
            const legal = this.legalPoint(unit, point);
            if (this.safeAt(group.team, legal.gx, legal.gy)) unit.receptionSlot = legal;
        });
    },

    onRallied(unit) {
        if (unit.type !== 'infantry' || !this.groups[unit.team] || !this.active(unit)) return false;
        unit.rallyWaiting = true; unit.rallyReadyAt = this.scene.simulationTime;
        unit.moralePhase = 'forming'; unit.tacticalRejoined = false;
        return true;
    },

    releaseRally(group, units) {
        if (!units.length) return;
        for (const unit of units) {
            unit.rallyWaiting = false; unit.moralePhase = 'returning';
            unit.tacticalRejoined = true; unit.tacticalContact = true;
            if (unit.route) unit.routeIndex = unit.route.length;
            if (unit.tacticalRole === 'reserve' && !unit.reserveCommitted) {
                unit.reserveCommitted = true; group.committed++;
            }
        }
        group.lastRallyWave = { count: units.length, at: this.scene.simulationTime };
        group.rallyWave = (group.rallyWave || 0) + 1;
        this.scene.addBattleEvent(`tactic-rally-${group.team}-${group.rallyWave}`,
            `${group.team === 'red' ? '红方' : '蓝方'}${units.length}名重整士兵结队返场`, group.team);
    },

    updateRallyWaves(group, now) {
        const members = [...group.main, ...group.flank, ...group.reserve];
        for (const unit of members) if (unit.moraleState === 'routing') {
            unit.rallyWaiting = false; unit.tacticalRejoined = false;
            if (unit.moralePhase === 'forming' || unit.moralePhase === 'returning') unit.moralePhase = 'retreating';
        }
        const waiting = members.filter(unit => unit.rallyWaiting && this.active(unit));
        const released = new Set();
        for (const unit of waiting) {
            if (released.has(unit)) continue;
            const neighbors = waiting.filter(other => !released.has(other) && dist(unit, other) <= 3);
            if (!this.safeAt(unit.team, unit.gx, unit.gy) || neighbors.length >= 3 || now - unit.rallyReadyAt >= 1500) {
                const batch = neighbors.filter(other => this.safeAt(other.team, other.gx, other.gy) || other === unit);
                this.releaseRally(group, batch);
                batch.forEach(other => released.add(other));
            }
        }
    },

    updateReserves(group, now) {
        if (!group.reserve.length) return;
        group.safeReserve = group.reserve.filter(unit => this.active(unit) && !unit.reserveCommitted &&
            unit.moraleState === 'steady' && this.safeAt(unit.team, unit.gx, unit.gy));
        const front = [...group.main, ...group.flank, ...group.reserve.filter(unit => unit.reserveCommitted)];
        const ready = front.filter(unit => this.active(unit));
        const routing = front.filter(unit => !unit.dead && !unit.withdrawn && unit.moraleState === 'routing').length;
        this.updateReception(group, front.filter(unit => !unit.dead && !unit.withdrawn && unit.moraleState === 'routing'));
        if (group.engagedAt == null && (front.some(unit => unit.dead || unit.everRouted) || ready.some(unit => {
            const enemy = this.scene.nearestEnemy(unit);
            return enemy && dist(unit, enemy) < 2.5;
        }))) group.engagedAt = now;
        if (group.engagedAt == null) return;
        const waiting = group.reserve.filter(unit => this.active(unit) && !unit.reserveCommitted);
        if (!waiting.length || now - group.lastCommit < 8000) return;
        const initial = group.main.length + group.flank.length;
        const elapsed = now - group.engagedAt;
        let commit = false;
        if (group.reserveWave === 0) commit = routing >= 8 || ready.length <= initial * 0.82 || elapsed >= 18000;
        else if (group.reserveWave === 1) commit = routing >= 15 || ready.length <= initial * 0.6 || now - group.lastCommit >= 30000;
        else commit = ready.length <= Math.max(4, waiting.length * 0.8) || (elapsed >= 90000 && routing === 0);
        if (!commit) return;
        const amount = group.reserveWave < 2 ? Math.max(1, Math.ceil(group.reserve.length * 0.4)) : waiting.length;
        for (const unit of waiting.slice(0, amount)) unit.reserveCommitted = true;
        group.committed += Math.min(amount, waiting.length);
        group.reserveWave++; group.lastCommit = now;
        group.phase = group.reserveWave < 3 ? '预备队分批增援 · 后队收拢溃兵' : '最后预备队投入 · 全军再战';
        this.scene.addBattleEvent(`tactic-reserve-${group.team}-${group.reserveWave}`,
            `${group.team === 'red' ? '红方' : '蓝方'}投入${Math.min(amount, waiting.length)}名预备队`, group.team);
    }
};

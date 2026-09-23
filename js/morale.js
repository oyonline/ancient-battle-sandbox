// 士气只读帧首快照，所有状态在伤害结算后一起提交；不移动单位、不操作画面。
class MoraleSystem {
    constructor(scene) {
        this.scene = scene;
        this.reset();
    }

    reset() {
        this.battleId = this.scene.battleId;
        this.records = new Map();
        this.snapshots = new Map();
        this.cells = new Map();
        this.damage = new Map();
        this.deaths = [];
        this.recentDeaths = [];
        this.knownDeaths = new Set();
        this.charges = [];
        this.chargeAttackers = new Set();
        this.routs = [];
        this.now = this.scene.simulationTime || 0;
        this.lastUpdate = this.now;
        this.nextLocalUpdate = -Infinity;
    }

    ensureBattle() {
        if (this.battleId !== this.scene.battleId) this.reset();
    }

    belongs(unit) {
        return unit && (unit.battleId === undefined || unit.battleId === this.battleId);
    }

    initUnit(unit) {
        this.ensureBattle();
        if (!this.belongs(unit)) return;
        unit.morale = 100;
        unit.moraleState = 'steady';
        unit.moraleReason = '阵线稳定';
        unit.moraleFacingX = unit.team === 'blue' ? -1 : 1;
        unit.moraleFacingY = 0;
        unit.moraleSheltered = false;
        this.records.set(unit, {
            casualty: [], charge: [], contagion: [], lowTime: 0,
            canSpread: false, spread: false, safeTime: 0,
            pressureTime: 0, pressure: 0, pressureReason: '', sheltered: false
        });
    }

    // 有限转速保留冲撞前的方向：碰撞当帧换目标不能瞬间消除背袭。
    updateFacing(unit, dt) {
        if (unit.moraleState === 'routing') return;
        let x = 0, y = 0;
        if (unit.moving && Math.hypot(unit.velX || 0, unit.velY || 0) > 0.15) {
            x = unit.velX || 0; y = unit.velY || 0;
        } else if (unit.target && !unit.target.dead && !unit.target.withdrawn && this.belongs(unit.target)) {
            x = unit.target.gx - unit.gx; y = unit.target.gy - unit.gy;
        }
        const length = Math.hypot(x, y);
        if (length < 0.001) return;
        x /= length; y /= length;
        const fx = unit.moraleFacingX, fy = unit.moraleFacingY;
        let angle = Math.atan2(fx * y - fy * x, fx * x + fy * y);
        // 完全反向时也保持换边镜像，不依赖数组先后或随机数。
        if (Math.abs(Math.abs(angle) - Math.PI) < 1e-9) angle = Math.PI * (fx >= 0 ? 1 : -1);
        angle = Math.max(-Math.PI * dt / 2, Math.min(Math.PI * dt / 2, angle));
        unit.moraleFacingX = fx * Math.cos(angle) - fy * Math.sin(angle);
        unit.moraleFacingY = fx * Math.sin(angle) + fy * Math.cos(angle);
    }

    capture(unit) {
        return {
            unit, gx: unit.gx, gy: unit.gy, team: unit.team, type: unit.type,
            state: unit.moraleState, facingX: unit.moraleFacingX, facingY: unit.moraleFacingY
        };
    }

    beginStep(dt) {
        this.ensureBattle();
        this.now = this.scene.simulationTime || 0;
        this.snapshots.clear();
        this.cells.clear();
        this.chargeAttackers.clear();
        for (const unit of this.scene.units) {
            if (!this.belongs(unit) || unit.dead || unit.withdrawn) continue;
            if (!this.records.has(unit)) this.initUnit(unit);
            this.updateFacing(unit, Math.max(0, dt));
            const snap = this.capture(unit);
            this.snapshots.set(unit, snap);
            const key = `${Math.floor(snap.gx / 3)},${Math.floor(snap.gy / 3)}`;
            if (!this.cells.has(key)) this.cells.set(key, []);
            this.cells.get(key).push(snap);
        }
        if (this.now + 1e-7 >= this.nextLocalUpdate) {
            for (const snap of this.snapshots.values()) this.refreshLocal(snap);
            this.nextLocalUpdate = this.now + 200;
        }
    }

    near(x, y, radius, visit) {
        const r2 = radius * radius;
        for (let cx = Math.floor((x - radius) / 3); cx <= Math.floor((x + radius) / 3); cx++) {
            for (let cy = Math.floor((y - radius) / 3); cy <= Math.floor((y + radius) / 3); cy++) {
                const cell = this.cells.get(`${cx},${cy}`);
                if (!cell) continue;
                for (const snap of cell) {
                    const dx = snap.gx - x, dy = snap.gy - y;
                    if (dx * dx + dy * dy <= r2 + 1e-9) visit(snap, dx, dy);
                }
            }
        }
    }

    refreshLocal(snap) {
        let friends = 0, enemies = 0, support = 0, threatened = false;
        const angles = [];
        const weight = type => type === 'cavalry' ? 2 : type === 'archer' ? 0.5 : 1;
        this.near(snap.gx, snap.gy, 6, (other, dx, dy) => {
            const d2 = dx * dx + dy * dy;
            if (other.team === snap.team) {
                if (d2 <= 9 + 1e-9 && other.state !== 'routing') friends += weight(other.type);
                if (other !== snap && d2 <= 25 + 1e-9 && other.state === 'steady') support++;
            } else if (other.state !== 'routing') {
                threatened = true;
                if (d2 <= 9 + 1e-9) {
                    enemies += weight(other.type);
                    if (d2 > 0.01) angles.push(Math.atan2(dy, dx));
                }
            }
        });
        let pressure = 2 * Math.max(0, Math.min(1, enemies / Math.max(1, friends) - 1));
        let reason = pressure > 0 ? '近处敌军占优' : '';
        // 最大空隙小于半圆，才能认定敌军从三面封住；正面密集人群不算包围。
        angles.sort((a, b) => a - b);
        let maxGap = 0, pinched = false;
        for (let i = 0; i < angles.length; i++) {
            const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
            maxGap = Math.max(maxGap, next - angles[i]);
            for (let j = i + 1; j < angles.length && !pinched; j++) {
                if (Math.cos(angles[j] - angles[i]) <= -0.5 + 1e-9) pinched = true;
            }
        }
        if (angles.length >= 3 && maxGap < Math.PI - 0.05) {
            pressure = 3; reason = '三面受敌';
        } else if (pinched && pressure <= 2) {
            pressure = 2; reason = '两面夹击';
        }
        const record = this.records.get(snap.unit);
        record.pressure = pressure;
        record.pressureReason = reason;
        // 死斗仍会溃散；失去接应点的残兵可在脱离敌军后自行重整，避免永远逃在边界。
        const aloneInDeathmatch = this.scene.battleOptions?.deathmatch === true && snap.state === 'routing' &&
            !this.scene.tactics?.rallyPoint(snap.unit);
        record.sheltered = !threatened && (support >= 3 || aloneInDeathmatch);
    }

    queueDamage(unit, amount) {
        this.ensureBattle();
        if (!this.belongs(unit) || unit.withdrawn || !Number.isFinite(amount) || amount <= 0) return;
        this.damage.set(unit, (this.damage.get(unit) || 0) + amount);
    }

    queueDeath(unit) {
        this.ensureBattle();
        if (!this.belongs(unit) || unit.withdrawn || this.knownDeaths.has(unit)) return;
        this.knownDeaths.add(unit);
        this.deaths.push({ ...(this.snapshots.get(unit) || this.capture(unit)), at: this.scene.simulationTime || 0 });
    }

    queueCharge(attacker, target, braced) {
        this.ensureBattle();
        if (!this.belongs(attacker) || !this.belongs(target) || attacker.withdrawn || target.withdrawn ||
            this.chargeAttackers.has(attacker)) return;
        this.chargeAttackers.add(attacker);
        const source = this.snapshots.get(attacker) || this.capture(attacker);
        const recipient = this.snapshots.get(target) || this.capture(target);
        const dx = source.gx - recipient.gx, dy = source.gy - recipient.gy;
        const distance = Math.hypot(dx, dy);
        const dot = distance > 0.001 ? (dx * recipient.facingX + dy * recipient.facingY) / distance : 1;
        const amount = braced ? 0 : dot >= 0.5 ? 8 : dot <= -0.5 ? 24 : 16;
        if (amount) this.charges.push({ target, snap: recipient, amount,
            reason: dot >= 0.5 ? '正面受到冲锋' : dot <= -0.5 ? '背面受到冲锋' : '侧翼受到冲锋' });
    }

    capped(record, key, amount, cap) {
        const window = record[key];
        while (window.length && window[0].at <= this.now - 3000 + 1e-7) window.shift();
        if (amount <= 0) return 0;
        let used = 0;
        for (const entry of window) used += entry.amount;
        const accepted = Math.min(amount, Math.max(0, cap - used));
        if (accepted > 0) window.push({ at: this.now, amount: accepted });
        return accepted;
    }

    update(dt) {
        this.ensureBattle();
        this.now = this.scene.simulationTime || 0;
        const elapsed = Math.min(Math.max(0, dt), Math.max(0, this.now - this.lastUpdate) / 1000);
        if (elapsed <= 0) return; // 暂停或同一个模拟时刻重复调用，不消耗事件、不累积计时。
        this.lastUpdate = this.now;
        this.recentDeaths = this.recentDeaths.filter(event => event.at > this.now - 3000);
        this.recentDeaths.push(...this.deaths);
        const losses = new Map();
        for (const snap of this.snapshots.values()) {
            losses.set(snap.unit, { deaths: 0, charge: 0, contagion: 0, reason: '', strongest: 0 });
        }
        const addAround = (event, radius, apply) => {
            this.near(event.gx, event.gy, radius, snap => {
                if (snap.team === event.team) apply(snap, losses.get(snap.unit));
            });
        };
        for (const death of this.deaths) addAround(death, 5, (_snap, loss) => { loss.deaths++; });
        for (const charge of this.charges) {
            addAround(charge.snap, 2, (snap, loss) => {
                const amount = charge.amount * (snap.unit === charge.target ? 1 : 0.5);
                loss.charge += amount;
                if (amount > loss.strongest) { loss.strongest = amount; loss.reason = charge.reason; }
            });
        }
        for (const rout of this.routs) addAround(rout, 5, (snap, loss) => {
            if (snap.unit !== rout.unit) loss.contagion++;
        });
        this.routs = [];
        const results = [], nextRouts = [];
        for (const snap of this.snapshots.values()) {
            const unit = snap.unit;
            if (unit.dead || unit.withdrawn) continue;
            const record = this.records.get(unit), loss = losses.get(unit);
            const ownDamage = this.damage.get(unit) || 0;
            let reference = 10;
            if (loss.deaths || loss.contagion) {
                let living = 0, recentDead = 0;
                this.near(snap.gx, snap.gy, 5, other => {
                    if (other.team === snap.team && !other.unit.dead && !other.unit.withdrawn) living++;
                });
                for (const death of this.recentDeaths) {
                    if (death.team === snap.team && Math.hypot(death.gx - snap.gx, death.gy - snap.gy) <= 5 + 1e-9) recentDead++;
                }
                reference = Math.max(10, living + recentDead);
            }
            const casualty = this.capped(record, 'casualty',
                24 * ownDamage / Math.max(1, unit.maxHp || unit.typeData?.hp || 100) + 48 * loss.deaths / reference, 30);
            const charge = this.capped(record, 'charge', loss.charge, 24);
            const contagion = this.capped(record, 'contagion', 20 * loss.contagion / reference, 8);
            const previousPressureTime = record.pressureTime;
            record.pressureTime = record.pressure > 0 ? record.pressureTime + elapsed : 0;
            const pressureSeconds = Math.max(0, record.pressureTime - 1) - Math.max(0, previousPressureTime - 1);
            const pressure = record.pressure * Math.max(0, pressureSeconds);
            const impactLoss = casualty + charge;
            const realLoss = impactLoss + pressure;
            let reason = loss.reason;
            if (casualty > Math.max(charge, contagion, pressure)) reason = loss.deaths ? '附近友军伤亡惨重' : '持续遭到打击';
            else if (contagion > Math.max(casualty, charge, pressure)) reason = '附近友军溃逃';
            else if (pressure > Math.max(casualty, charge, contagion)) reason = record.pressureReason;
            unit.moraleSheltered = record.sheltered && ownDamage === 0;
            record.safeTime = unit.moraleSheltered ? record.safeTime + elapsed : 0;
            const recoveredSeconds = Math.max(0, record.safeTime - 3) - Math.max(0, record.safeTime - elapsed - 3);
            const reserveSupport = unit.moraleSheltered && this.scene.tactics?.reserveSupport(unit);
            const recovery = realLoss + contagion > 0 ? 0 : (reserveSupport ? 6 : 3) * recoveredSeconds;
            const value = Math.max(0, Math.min(100, unit.morale - realLoss - contagion + recovery));
            let state = snap.state;
            if (state === 'routing') {
                const rallyThreshold = this.scene.battleOptions?.deathmatch ? 60 : 45;
                if (value >= rallyThreshold && unit.moraleSheltered && record.safeTime >= 3) {
                    state = value >= 50 ? 'steady' : 'wavering';
                    record.lowTime = 0; record.spread = false;
                    reason = '友军接应，重新集结';
                } else if (!record.spread && impactLoss > 0) {
                    // 纯传播造成的溃逃不会立即接力；遭到新的真实打击后才可能扩散。
                    nextRouts.push(snap); record.spread = true;
                }
            } else {
                state = value < 50 ? 'wavering' : 'steady';
                if (value < 25) {
                    if (record.lowTime === 0) record.canSpread = unit.morale - realLoss < 25;
                    else if (impactLoss > 0) record.canSpread = true;
                    record.lowTime += elapsed;
                    if (record.lowTime >= 0.5 - 1e-9) {
                        state = 'routing';
                        if (record.canSpread) { nextRouts.push(snap); record.spread = true; }
                    }
                } else {
                    record.lowTime = 0; record.canSpread = false;
                }
            }
            if (!reason && recovery > 0) reason = '安全接应，士气恢复';
            results.push({ unit, value, state, previous: snap.state, reason: reason || unit.moraleReason });
        }
        // 先提交所有人的结果，再通知外部；回调不能改变同一步其他人的判断。
        for (const result of results) {
            result.unit.morale = result.value;
            result.unit.moraleState = result.state;
            result.unit.moraleReason = result.reason;
        }
        this.routs = nextRouts;
        this.damage.clear(); this.deaths = []; this.charges = [];
        for (const result of results) {
            if (result.state !== result.previous) this.scene.onMoraleStateChange?.(result.unit, result.previous, result.reason);
        }
        for (const [unit] of this.records) {
            if (unit.dead || unit.withdrawn || !this.belongs(unit)) this.records.delete(unit);
        }
    }
}

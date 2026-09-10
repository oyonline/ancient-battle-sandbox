// ==================== 音效（WebAudio 合成，无外部文件） ====================
const Snd = {
    ctx: null, muted: false,
    ensure() {
        if (!this.ctx) {
            try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
            catch (e) { this.ctx = null; }
        }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
    },
    tone(freq, dur, type = 'sine', vol = 0.12, slide = 0) {
        if (this.muted || !this.ensure()) return;
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type; o.frequency.setValueAtTime(freq, t);
        if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g).connect(this.ctx.destination);
        o.start(t); o.stop(t + dur);
    },
    play(name) {
        switch (name) {
            case 'buy':   this.tone(660, 0.07, 'triangle', 0.1); break;
            case 'tick':  this.tone(520, 0.09, 'square', 0.08); break;
            case 'go':    this.tone(880, 0.25, 'square', 0.12); break;
            case 'arrow': this.tone(900, 0.12, 'triangle', 0.05, -500); break;
            case 'hit':   this.tone(160, 0.08, 'square', 0.07); break;
            case 'die':   this.tone(300, 0.25, 'sawtooth', 0.05, -180); break;
            case 'lock':  this.tone(523, 0.09, 'triangle', 0.1); this.tone && setTimeout(() => this.tone(784, 0.12, 'triangle', 0.1), 90); break;
            case 'win':   [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.22, 'triangle', 0.13), i * 130)); break;
        }
    }
};

// ==================== UI 控制器 ====================
const UI = {
    scene: null,
    phase: 'buy-red',            // buy-red | buy-blue | ready | battle | result
    configs: { red: {}, blue: {} },
    formations: { red: 'custom', blue: 'custom' },
    locked: { red: false, blue: false },

    init() {
        this.buildBuyPanel('red');
        this.bindControls();
        this.showOverlay('red');
    },

    onSceneReady(scene) { this.scene = scene; },

    // ---------------- 买兵面板 ----------------
    buildBuyPanel(team) {
        const panel = document.getElementById('buy-panel');
        const isRed = team === 'red';
        panel.className = 'buy-panel ' + team;
        document.getElementById('buy-team-title').textContent = isRed ? '🔴 红方队长，请配兵！' : '🔵 蓝方队长，请配兵！';
        document.getElementById('buy-team-title').className = 'team-title ' + team;

        const list = document.getElementById('unit-list');
        list.innerHTML = '';
        Object.entries(UNIT_TYPES).forEach(([key, t]) => {
            const row = document.createElement('div');
            row.className = 'unit-row';
            row.innerHTML = `
                <img class="unit-thumb" src="assets/units/${team}_${key}.png" alt="${t.name}">
                <div class="unit-info">
                    <div class="unit-name">${t.icon} ${t.name} <span class="cost">🪙${t.cost}</span></div>
                    <div class="unit-tip">${t.tip}</div>
                </div>
                <div class="stepper">
                    <button class="step-btn minus" data-team="${team}" data-type="${key}">－</button>
                    <span class="step-num" id="num-${team}-${key}">0</span>
                    <button class="step-btn plus" data-team="${team}" data-type="${key}">＋</button>
                </div>`;
            list.appendChild(row);
        });

        // 阵型选择
        const fRow = document.getElementById('formation-row');
        fRow.innerHTML = '<span class="f-label">阵型：</span>';
        Object.entries(FORMATIONS).forEach(([key, f]) => {
            const chip = document.createElement('button');
            chip.className = 'chip' + (this.formations[team] === key ? ' active' : '');
            chip.textContent = f.name;
            chip.onclick = () => {
                this.formations[team] = key;
                fRow.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                Snd.play('buy');
            };
            fRow.appendChild(chip);
        });

        // 恢复已选数量（蓝方回合时红方已锁）
        document.querySelectorAll(`.step-num[id^="num-${team}-"]`).forEach(el => {
            const type = el.id.split('-')[2];
            el.textContent = this.configs[team][type] || 0;
        });
        this.updateBudget(team);
    },

    bindControls() {
        document.addEventListener('click', e => {
            const btn = e.target.closest('.step-btn');
            if (!btn || this.phase !== 'buy-red' && this.phase !== 'buy-blue') return;
            const team = this.phase.split('-')[1];
            const type = btn.dataset.type;
            const delta = btn.classList.contains('plus') ? 1 : -1;
            this.changeCount(team, type, delta);
        });

        document.getElementById('btn-lock').onclick = () => this.lockTeam();
        document.getElementById('btn-start').onclick = () => this.startBattle();
        document.getElementById('btn-pause').onclick = () => { if (this.scene) { this.scene.togglePause(); } };
        document.querySelectorAll('.speed-btn').forEach(b => b.onclick = () => {
            if (this.scene) this.scene.setSpeed(parseFloat(b.dataset.speed));
            document.querySelectorAll('.speed-btn').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
        });
        document.getElementById('btn-restart').onclick = () => this.resetAll();
        document.getElementById('btn-again').onclick = () => this.resetAll();
        document.getElementById('btn-mute').onclick = () => {
            Snd.muted = !Snd.muted;
            document.getElementById('btn-mute').textContent = Snd.muted ? '🔇' : '🔊';
        };
        document.getElementById('btn-panel').onclick = () => {
            document.getElementById('side').classList.toggle('hidden-panel');
        };
    },

    showPanel(show) {
        document.getElementById('side').classList.toggle('hidden-panel', !show);
    },

    changeCount(team, type, delta) {
        const t = UNIT_TYPES[type];
        const cur = this.configs[team][type] || 0;
        const spent = this.spent(team);
        if (delta > 0) {
            if (spent + t.cost > BUDGET) { this.flashBudget(); return; }
            if (cur >= t.maxCount) return;
        }
        const next = Math.max(0, cur + delta);
        this.configs[team][type] = next;
        document.getElementById(`num-${team}-${type}`).textContent = next;
        Snd.play('buy');
        this.updateBudget(team);
    },

    spent(team) {
        return Object.entries(this.configs[team]).reduce(
            (s, [k, n]) => s + UNIT_TYPES[k].cost * n, 0);
    },

    updateBudget(team) {
        const left = BUDGET - this.spent(team);
        const el = document.getElementById('budget-text');
        el.textContent = `🪙 剩余金币：${left}`;
        document.getElementById('budget-bar-fill').style.width = (left / BUDGET * 100) + '%';
    },

    flashBudget() {
        const el = document.getElementById('budget-text');
        el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    },

    lockTeam() {
        const team = this.phase.split('-')[1];
        const total = Object.values(this.configs[team]).reduce((a, b) => a + b, 0);
        if (total === 0) { alert('至少要买 1 个兵哦！'); return; }
        this.locked[team] = true;
        Snd.play('lock');

        if (team === 'red') {
            this.phase = 'buy-blue';
            this.buildBuyPanel('blue');
            this.showOverlay('blue');
        } else {
            this.phase = 'ready';
            this.deployArmies();
        }
    },

    // ---------------- 轮流配兵遮罩 ----------------
    showOverlay(team) {
        const ov = document.getElementById('overlay');
        const isRed = team === 'red';
        ov.className = 'overlay show ' + team;
        ov.innerHTML = `
            <div class="overlay-card">
                <div class="overlay-emoji">${isRed ? '🔴' : '🔵'}</div>
                <div class="overlay-title">轮到${isRed ? '红方' : '蓝方'}队长！</div>
                <div class="overlay-sub">另一边请闭上眼睛，别偷看哦～</div>
                <button class="big-btn ${team}" id="btn-reveal">我要配兵！</button>
            </div>`;
        document.getElementById('btn-reveal').onclick = () => {
            ov.className = 'overlay';
            Snd.play('tick');
        };
    },

    // ---------------- 部署与开战 ----------------
    deployArmies() {
        document.getElementById('buy-panel').style.display = 'none';
        document.getElementById('battle-panel').style.display = 'flex';
        document.getElementById('phase-hint').textContent = '两军就位！点「开战」一决胜负 ⚔️';
        this.scene.deployUnits(this.configs.red, this.configs.blue, this.formations.red, this.formations.blue);
        this.updateCounts();
    },

    startBattle() {
        this.phase = 'battle';
        document.getElementById('btn-start').style.display = 'none';
        document.getElementById('phase-hint').textContent = '战斗中！拖动画面、滚轮缩放，📜 可唤回面板';
        this.showPanel(false);   // 开战观战：自动收起面板
        this.scene.startCountdown(() => {});
    },

    onBattleEnd(winner, stats) {
        this.phase = 'result';
        document.getElementById('battle-panel').style.display = 'none';
        this.showPanel(true);   // 结算时唤回面板
        const isRed = winner === 'red';
        const panel = document.getElementById('result-panel');
        panel.style.display = 'flex';
        document.getElementById('result-title').textContent = isRed ? '🔴 红方胜利！' : '🔵 蓝方胜利！';
        document.getElementById('result-title').className = 'result-title ' + winner;
        document.getElementById('result-detail').textContent =
            `存活兵力 — 红方 ${stats.red} 人 · 蓝方 ${stats.blue} 人`;
    },

    updateCounts() {
        if (!this.scene) return;
        const r = this.scene.units.filter(u => u.team === 'red' && !u.dead).length;
        const b = this.scene.units.filter(u => u.team === 'blue' && !u.dead).length;
        document.getElementById('red-count').textContent = r;
        document.getElementById('blue-count').textContent = b;
    },

    resetAll() {
        this.phase = 'buy-red';
        this.configs = { red: {}, blue: {} };
        this.formations = { red: 'custom', blue: 'custom' };
        this.locked = { red: false, blue: false };
        if (this.scene) this.scene.clearUnits();
        document.getElementById('battle-panel').style.display = 'none';
        document.getElementById('result-panel').style.display = 'none';
        document.getElementById('btn-start').style.display = '';
        document.getElementById('buy-panel').style.display = 'flex';
        this.showPanel(true);
        document.getElementById('phase-hint').textContent = '配兵阶段：用金币组建你的军队';
        this.buildBuyPanel('red');
        this.showOverlay('red');
    }
};

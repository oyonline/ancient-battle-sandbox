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
            case 'lock':  this.tone(523, 0.09, 'triangle', 0.1); setTimeout(() => this.tone(784, 0.12, 'triangle', 0.1), 90); break;
            case 'win':   [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.22, 'triangle', 0.13), i * 130)); break;
        }
    }
};

// ==================== 一键预设配兵（预算 100） ====================
const PRESETS = {
    balance: { name: '均衡军团', config: { infantry: 10, pikeman: 2, archer: 3, cavalry: 1 } },
    ranged:  { name: '远程火力', config: { infantry: 2, pikeman: 4, archer: 8, cavalry: 0 } },
    rush:    { name: '铁骑洪流', config: { infantry: 3, pikeman: 0, archer: 0, cavalry: 7 } }
};

// ==================== UI 控制器（底部抽屉 + 三步流程） ====================
const UI = {
    scene: null,
    phase: 'buy-red',            // buy-red | buy-blue | ready | battle | result
    configs: { red: {}, blue: {} },
    formations: { red: 'custom', blue: 'custom' },

    init() {
        this.bindControls();
        this.buildBuy('red');
        this.showOverlay('red');
        this.setStep(1);
    },

    onSceneReady(scene) { this.scene = scene; },

    // ---------------- 流程控制 ----------------
    setStep(n) {
        document.querySelectorAll('#steps .step').forEach(el => {
            const k = +el.dataset.step;
            el.classList.toggle('on', k === n);
            el.classList.toggle('done', k < n);
        });
        const hints = {
            1: '第 1 步：红方队长配兵',
            2: '第 2 步：蓝方队长配兵',
            3: '第 3 步：开战！'
        };
        document.getElementById('phase-hint').textContent = hints[n] || '';
    },

    showSection(name) {
        document.querySelectorAll('.sheet-body .sec').forEach(s => s.classList.remove('on'));
        document.getElementById('sec-' + name).classList.add('on');
        this.openSheet(true);
    },

    openSheet(open) {
        document.getElementById('sheet').classList.toggle('open', open);
        document.getElementById('btn-fold').textContent = open ? '▾' : '▴';
    },

    // ---------------- 配兵面板 ----------------
    buildBuy(team) {
        const isRed = team === 'red';
        this.phase = 'buy-' + team;

        // 队伍横幅 + 锁定按钮
        const banner = document.getElementById('team-banner');
        banner.textContent = isRed ? '🔴 红方队长，组建你的军队！' : '🔵 蓝方队长，组建你的军队！';
        banner.className = 'team-banner ' + team;
        const lock = document.getElementById('btn-lock');
        lock.textContent = isRed ? '🔒 配好了，换蓝方队长！' : '🔒 配好了，准备开战！';
        lock.className = 'big-btn ' + team;

        // 兵种卡片
        const wrap = document.getElementById('unit-cards');
        wrap.innerHTML = '';
        Object.entries(UNIT_TYPES).forEach(([key, t]) => {
            const card = document.createElement('div');
            card.className = 'ucard';
            card.innerHTML = `
                <img class="uc-img" src="assets/units/${team}_${key}.png" alt="${t.name}">
                <div class="uc-body">
                    <div class="uc-top"><span class="uc-name">${t.icon} ${t.name}</span><span class="uc-cost">🪙${t.cost}</span></div>
                    <div class="uc-stats">⚔️${t.atk} · 🛡️${t.def} · ❤️${t.hp}</div>
                    <div class="uc-tip">${t.tip}</div>
                </div>
                <div class="uc-step">
                    <button class="step-btn minus" data-type="${key}">－</button>
                    <b class="uc-num" id="num-${key}">0</b>
                    <button class="step-btn plus" data-type="${key}">＋</button>
                </div>`;
            wrap.appendChild(card);

            // 按住连点
            this.bindHold(card.querySelector('.step-btn.minus'), () => this.changeCount(team, key, -1));
            this.bindHold(card.querySelector('.step-btn.plus'), () => this.changeCount(team, key, +1));
        });

        // 阵型
        const fRow = document.getElementById('formation-row');
        fRow.innerHTML = '';
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

        // 恢复数量显示
        Object.keys(UNIT_TYPES).forEach(k => this.renderNum(team, k));
        this.updateBudget(team);
    },

    // 按下立即执行一次，长按 380ms 后进入每 90ms 连发
    bindHold(el, fn) {
        let timer = null, rep = null;
        const stop = () => { clearTimeout(timer); clearInterval(rep); timer = rep = null; };
        el.addEventListener('pointerdown', e => {
            e.preventDefault();
            fn();
            timer = setTimeout(() => { rep = setInterval(fn, 90); }, 380);
        });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => el.addEventListener(ev, stop));
    },

    changeCount(team, type, delta) {
        if (this.phase !== 'buy-' + team) return;
        const t = UNIT_TYPES[type];
        const cur = this.configs[team][type] || 0;
        if (delta > 0) {
            if (this.spent(team) + t.cost > BUDGET) { this.flashBudget(); return; }
            if (cur >= t.maxCount) return;
        }
        this.configs[team][type] = Math.max(0, cur + delta);
        this.renderNum(team, type);
        Snd.play('buy');
        this.updateBudget(team);
    },

    renderNum(team, type) {
        const n = this.configs[team][type] || 0;
        const el = document.getElementById('num-' + type);
        if (el) el.textContent = n;
        const card = el && el.closest('.ucard');
        if (card) card.classList.toggle('dim', n === 0);
    },

    applyPreset(name) {
        if (this.phase !== 'buy-red' && this.phase !== 'buy-blue') return;
        const team = this.phase.split('-')[1];
        const cfg = PRESETS[name].config;
        this.configs[team] = {};
        Object.entries(cfg).forEach(([k, n]) => {
            if (n > 0) this.configs[team][k] = Math.min(n, UNIT_TYPES[k].maxCount);
        });
        Object.keys(UNIT_TYPES).forEach(k => this.renderNum(team, k));
        Snd.play('lock');
        this.updateBudget(team);
    },

    clearArmy() {
        if (this.phase !== 'buy-red' && this.phase !== 'buy-blue') return;
        const team = this.phase.split('-')[1];
        this.configs[team] = {};
        Object.keys(UNIT_TYPES).forEach(k => this.renderNum(team, k));
        this.updateBudget(team);
    },

    spent(team) {
        return Object.entries(this.configs[team]).reduce(
            (s, [k, n]) => s + UNIT_TYPES[k].cost * n, 0);
    },

    troops(team) {
        return Object.values(this.configs[team]).reduce((a, b) => a + b, 0);
    },

    updateBudget(team) {
        const left = BUDGET - this.spent(team);
        document.getElementById('budget-left').textContent = left;
        document.getElementById('budget-fill').style.width = (left / BUDGET * 100) + '%';
        document.getElementById('troop-total').textContent = '兵力 ' + this.troops(team);
    },

    flashBudget() {
        const el = document.getElementById('budget-left');
        el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
        if (navigator.vibrate) navigator.vibrate(60);
    },

    lockTeam() {
        const team = this.phase.split('-')[1];
        if (this.troops(team) === 0) { alert('至少要买 1 个兵哦！'); return; }
        Snd.play('lock');

        if (team === 'red') {
            this.buildBuy('blue');
            this.setStep(2);
            this.showOverlay('blue');
        } else {
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
                <div class="overlay-sub">${isRed ? '蓝方' : '红方'}请先闭上眼睛，别偷看阵容哦～</div>
                <button class="big-btn ${team}" id="btn-reveal">我要配兵！</button>
            </div>`;
        document.getElementById('btn-reveal').onclick = () => {
            ov.className = 'overlay';
            Snd.play('tick');
        };
    },

    // ---------------- 部署与开战 ----------------
    deployArmies() {
        this.phase = 'ready';
        this.setStep(3);

        // 双方阵容摘要
        const summarize = team => {
            const parts = Object.entries(this.configs[team])
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${UNIT_TYPES[k].icon}${UNIT_TYPES[k].name}×${n}`);
            return parts.length ? parts.join('　') : '（空军队）';
        };
        document.getElementById('army-summary').innerHTML = `
            <div class="sum red"><b>🔴 红方</b> ${summarize('red')}<span class="sum-f">${FORMATIONS[this.formations.red].name}</span></div>
            <div class="sum blue"><b>🔵 蓝方</b> ${summarize('blue')}<span class="sum-f">${FORMATIONS[this.formations.blue].name}</span></div>`;

        this.scene.deployUnits(this.configs.red, this.configs.blue, this.formations.red, this.formations.blue);
        this.updateCounts();
        this.showSection('ready');
    },

    startBattle() {
        if (this.phase === 'battle' || !this.scene) return;
        this.phase = 'battle';
        document.getElementById('phase-hint').textContent = '战斗中！拖动画面查看战况';
        this.openSheet(false);   // 开战观战：自动收起面板
        this.scene.startCountdown(() => {});
    },

    onBattleEnd(winner, stats) {
        this.phase = 'result';
        const isRed = winner === 'red';
        const title = document.getElementById('result-title');
        title.textContent = isRed ? '🔴 红方胜利！' : '🔵 蓝方胜利！';
        title.className = 'result-title ' + winner;
        document.getElementById('result-detail').innerHTML =
            `存活兵力 — 红方 <b>${stats.red}</b> 人 · 蓝方 <b>${stats.blue}</b> 人`;
        this.showSection('result');
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
        if (this.scene) this.scene.clearUnits();
        this.buildBuy('red');
        this.setStep(1);
        this.showSection('buy');
        this.showOverlay('red');
    },

    // ---------------- 事件绑定 ----------------
    bindControls() {
        document.getElementById('btn-lock').onclick = () => this.lockTeam();
        document.getElementById('btn-start').onclick = () => this.startBattle();
        document.getElementById('btn-again').onclick = () => this.resetAll();
        document.getElementById('btn-restart').onclick = () => this.resetAll();

        document.getElementById('btn-pause').onclick = () => { if (this.scene) this.scene.togglePause(); };
        document.querySelectorAll('.speed-btn').forEach(b => b.onclick = () => {
            if (this.scene) this.scene.setSpeed(parseFloat(b.dataset.speed));
            document.querySelectorAll('.speed-btn').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
        });

        document.getElementById('btn-mute').onclick = () => {
            Snd.muted = !Snd.muted;
            document.getElementById('btn-mute').textContent = Snd.muted ? '🔇' : '🔊';
        };
        document.getElementById('btn-panel').onclick = () =>
            this.openSheet(!document.getElementById('sheet').classList.contains('open'));
        document.getElementById('btn-fold').onclick = () =>
            this.openSheet(!document.getElementById('sheet').classList.contains('open'));
        // 点击面板头部（非按钮区域）也可折叠/展开
        document.querySelector('.sheet-head').addEventListener('click', e => {
            if (e.target.closest('#btn-fold')) return;
            this.openSheet(!document.getElementById('sheet').classList.contains('open'));
        });

        document.querySelectorAll('.preset-btn[data-preset]').forEach(b =>
            b.onclick = () => this.applyPreset(b.dataset.preset));
        document.getElementById('btn-clear').onclick = () => this.clearArmy();
    }
};

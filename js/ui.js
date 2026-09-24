// ==================== 音效（WebAudio 合成，无外部文件） ====================
const Snd = {
    ctx: null, muted: false, _last: {},
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
        // 千人混战时同名音效可能每秒上百次：按类型限频，保护音频线程
        const minGap = { hit: 70, die: 90, arrow: 90, buy: 80 }[name];
        if (minGap) {
            const now = performance.now();
            if (now - (this._last[name] || 0) < minGap) return;
            this._last[name] = now;
        }
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

// ==================== 一键预设配兵（预算 4000） ====================
const PRESETS = {
    balance: { name: '均衡军团', config: { infantry: 150, pikeman: 30, archer: 40, cavalry: 30 } },
    ranged:  { name: '远程火力', config: { infantry: 60, pikeman: 60, archer: 150, cavalry: 0 } },
    rush:    { name: '铁骑洪流', config: { infantry: 80, pikeman: 0, archer: 0, cavalry: 120 } },
    thousand:{ name: '千人军团', config: { infantry: 300, pikeman: 60, archer: 80, cavalry: 60 } }
};

const UI_TACTIC_OPTIONS = {
    advance: { name: '标准推进', description: '所有兵种按原有方式接近敌人并交战。' },
    assault: { name: '正面强攻', requires: 'infantry', description: '剑士集中向敌阵正面推进，争夺突破口；其他兵种照常作战。' },
    flank: { name: '单翼迂回', requires: 'infantry', description: '剑士约一半在正面牵制，一半沿敌阵外缘寻找侧后方的接敌机会；其他兵种照常作战。' },
    hold: { name: '枪阵守位', requires: 'pikeman', description: '长枪兵布成四面方阵，近敌转身、小步迎击，内排支援缺口；威胁退去后归位架枪。其他兵种照常作战。' },
    hold_ground: { name: '高地守位', description: '己方高地上，弓兵守山顶、剑士和长枪兵护坡口；没有己方高地时守出发区，不夺取敌方山丘。骑兵就近反击后归位。' }
};

const UI_CAVALRY_OPTIONS = {
    auto: { name: '自由突击（原逻辑）', description: '沿用原有突击判断；全军高地守位时，骑兵只在守区附近反击。' },
    direct: { name: '正面强冲', description: '直接迎击前方敌军，争取助跑冲锋；可能撞上完整枪阵。' },
    flank_archers: { name: '侧翼袭弓', description: '先沿侧翼绕向敌军弓兵，付出绕行时间；途中被截住仍要正常交战，无弓兵时攻击其他敌军。' }
};

// ==================== 战役、配兵与战报 ====================
const UI = {
    scene: null,
    phase: 'home',
    mode: 'sandbox',
    challenge: null,
    configs: { red: {}, blue: {} },
    formations: { red: 'custom', blue: 'custom' },
    orders: { red: 'advance', blue: 'advance' },
    battleOptions: { deathmatch: false, reserves: { red: 0, blue: 0 }, terrain: 'flat', cavalryOrders: { red: 'auto', blue: 'auto' } },
    editing: false,
    countdown: false,
    pendingDeploy: false,
    pendingAutoplay: false,
    progress: {},
    holdStops: [],

    init() {
        this.loadProgress();
        this.bindControls();
        const params = new URLSearchParams(location.search);
        const tactics = params.get('tactics');
        if (['assault', 'flank', 'reserve'].includes(tactics)) { this.startTactics(tactics); return; }
        const terrain = params.get('terrain');
        if (terrain && Object.hasOwn(Terrain.maps, terrain)) { this.startTerrain(terrain); return; }
        const auto = params.get('auto');
        if (auto && PRESETS[auto]) { this.autoplay(auto); return; }
        this.showHome();
    },

    onSceneReady(scene) {
        this.scene = scene;
        if (this.pendingDeploy) {
            const autoplay = this.pendingAutoplay;
            this.pendingDeploy = this.pendingAutoplay = false;
            this.deployArmies();
            if (autoplay) this.startBattle();
            return;
        }
        this.syncControls();
    },

    autoplay(preset) {
        this.clearBattle();
        this.mode = 'sandbox';
        this.challenge = null;
        this.configs = { red: { ...PRESETS[preset].config }, blue: { ...PRESETS[preset].config } };
        this.formations = { red: 'custom', blue: 'custom' };
        this.orders = { red: 'advance', blue: 'advance' };
        this.resetBattleOptions();
        this.deployArmies();
        if (this.scene) this.startBattle();
        else this.pendingAutoplay = true;
    },

    loadProgress() {
        try {
            const saved = JSON.parse(localStorage.getItem('battle-challenges-v1') || '{}');
            for (const c of CHALLENGES) {
                if (Number.isInteger(saved?.[c.id]?.wins) && saved[c.id].wins > 0) {
                    this.progress[c.id] = { wins: saved[c.id].wins };
                }
            }
        } catch (_) { /* 浏览器禁用存储时仍可正常游玩。 */ }
    },

    saveWin() {
        const id = this.challenge.id;
        this.progress[id] = { wins: (this.progress[id]?.wins || 0) + 1 };
        try { localStorage.setItem('battle-challenges-v1', JSON.stringify(this.progress)); }
        catch (_) { /* 通关仍保留在本次会话。 */ }
    },

    setPhase(phase) {
        this.phase = phase;
        document.body.dataset.phase = phase;
        this.syncControls();
    },

    syncControls() {
        const fighting = this.phase === 'battle';
        document.getElementById('controlbar').hidden = !fighting;
        document.getElementById('deathmatch-hud-rule').hidden = !fighting || !this.battleOptions.deathmatch;
        this.updateMorale();
        this.updateTactics();
        this.updateTerrainControls();
        this.updateCommandControls();
        document.getElementById('btn-pause').disabled = !fighting || this.countdown;
        document.getElementById('btn-pause').textContent = this.scene?.paused ? '▶ 继续' : '⏸ 暂停';
        document.getElementById('btn-lock').disabled = !this.scene;
        document.getElementById('btn-start').disabled = !this.scene || this.phase !== 'ready';
        document.getElementById('btn-start').textContent = fighting ? '两军交战中…' : '🚀 开战！';
        document.getElementById('ready-edit-actions').hidden = fighting;
        document.querySelectorAll('.speed-btn').forEach(b => {
            b.classList.toggle('active', Number(b.dataset.speed) === (this.scene?.gameSpeed || 1));
        });
    },

    setStep(n) {
        const challenge = this.mode === 'challenge';
        document.getElementById('steps').hidden = n === 0;
        document.getElementById('sheet-label').hidden = n !== 0;
        document.getElementById('sheet-label').textContent = this.phase === 'result' ? '⚑ 战后复盘' : this.mode === 'terrain' ? '⛰ 高地演练' : this.mode === 'tactics' ? '⚑ 战阵演练' : '⚑ 统帅试炼';
        document.querySelectorAll('#steps .step').forEach(el => {
            const k = Number(el.dataset.step);
            el.hidden = challenge && k === 2;
            el.classList.toggle('on', k === n);
            el.classList.toggle('done', k < n);
            el.querySelector('span').textContent = k === 1 ? (challenge ? '我的军队' : '红方配兵') : k === 2 ? '蓝方配兵' : '准备开战';
            el.querySelector('i').textContent = challenge && k === 3 ? '2' : String(k);
        });
        const hint = n === 0 ? '观察敌阵，找到你的解法' : n === 3 ? (this.mode === 'terrain' ? '高地演练 · 同阵容换图对照' : this.mode === 'tactics' ? '战阵演练 · 观察枪阵与迂回路线' : '两军就位，准备开战') : challenge ? this.challenge.title + ' · 为红方配兵' : (n === 1 ? '红方' : '蓝方') + '队长正在配兵';
        document.getElementById('phase-hint').textContent = hint;
    },

    showSection(name) {
        document.querySelectorAll('.sheet-body .sec').forEach(s => s.classList.remove('on'));
        document.getElementById('sec-' + name).classList.add('on');
        document.querySelector('.sheet-body').scrollTop = 0;
        this.openSheet(true);
    },

    openSheet(open) {
        document.getElementById('sheet').classList.toggle('open', open);
        document.getElementById('btn-fold').textContent = open ? '▾' : '▴';
        document.getElementById('btn-fold').setAttribute('aria-expanded', String(open));
    },

    clearBattle() {
        this.stopHolds();
        this.countdown = false;
        this.pendingDeploy = this.pendingAutoplay = false;
        if (this.scene) this.scene.clearUnits();
        document.getElementById('overlay').className = 'overlay';
        this.updateCounts();
    },

    resetBattleOptions() {
        this.battleOptions = { deathmatch: false, reserves: { red: 0, blue: 0 }, terrain: 'flat', cavalryOrders: { red: 'auto', blue: 'auto' } };
    },

    startTerrain(terrain = 'blue_hill') {
        this.clearBattle();
        this.mode = 'terrain';
        this.challenge = null;
        this.editing = false;
        const army = { infantry: 36, pikeman: 12, archer: 16, cavalry: 12 };
        this.configs = { red: { ...army }, blue: { ...army } };
        this.formations = { red: 'custom', blue: 'custom' };
        this.orders = { red: 'advance', blue: 'advance' };
        this.resetBattleOptions();
        this.battleOptions.terrain = Terrain.normalize(terrain);
        if (this.battleOptions.terrain !== 'flat') {
            this.orders[this.battleOptions.terrain === 'red_hill' ? 'red' : 'blue'] = 'hold_ground';
        }
        this.deployArmies();
    },

    selectTerrain(terrain) {
        if (!['sandbox', 'terrain'].includes(this.mode) || !['ready', 'result'].includes(this.phase) || this.countdown) return;
        if (!Object.hasOwn(Terrain.maps, terrain)) return;
        this.battleOptions.terrain = terrain;
        // 部署会重绘地形并清空旧战况；只换地图，保留双方阵容与指令。
        this.deployArmies();
    },

    updateTerrainControls() {
        const selectable = ['sandbox', 'terrain'].includes(this.mode);
        const terrain = Terrain.normalize(this.battleOptions.terrain);
        const map = Terrain.maps[terrain];
        for (const phase of ['ready', 'result']) {
            document.getElementById('terrain-' + phase).hidden = !selectable;
            document.getElementById('terrain-' + phase + '-description').textContent = map.description;
        }
        document.querySelectorAll('[data-terrain]').forEach(button => {
            const selected = button.dataset.terrain === terrain;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-pressed', String(selected));
            button.disabled = !selectable || !['ready', 'result'].includes(this.phase) || this.countdown;
        });
        const hud = document.getElementById('terrain-hud');
        hud.hidden = this.phase === 'home';
        hud.textContent = '⛰ ' + map.name;
        hud.title = map.description;
    },

    cavalryOrder(team) {
        const selected = this.battleOptions.cavalryOrders?.[team];
        return Object.hasOwn(UI_CAVALRY_OPTIONS, selected) ? selected : 'auto';
    },

    selectCommand(team, kind, selected) {
        if (!['red', 'blue'].includes(team) || !['sandbox', 'terrain'].includes(this.mode) || this.countdown) return;
        const buying = this.phase === 'buy-' + team;
        if (!buying && !['ready', 'result'].includes(this.phase)) return;
        const choices = kind === 'army' ? UI_TACTIC_OPTIONS : kind === 'cavalry' ? UI_CAVALRY_OPTIONS : null;
        if (!choices || !Object.hasOwn(choices, selected)) return;
        if (kind === 'army') this.orders[team] = selected;
        else {
            this.battleOptions.cavalryOrders ||= { red: 'auto', blue: 'auto' };
            this.battleOptions.cavalryOrders[team] = selected;
        }
        if (buying) this.renderOrders(team);
        else this.deployArmies();
        Snd.play('tick');
    },

    commandSummary(team, orders = this.orders, cavalryOrders = this.battleOptions.cavalryOrders) {
        const army = UI_TACTIC_OPTIONS[orders?.[team]] || UI_TACTIC_OPTIONS.advance;
        const cavalry = UI_CAVALRY_OPTIONS[cavalryOrders?.[team]] || UI_CAVALRY_OPTIONS.auto;
        return `${army.name}${this.configs[team].cavalry ? ' · 骑兵：' + cavalry.name : ''}`;
    },

    commandDescription(team) {
        const { effective, missing } = this.orderAvailability(team);
        const cavalry = this.cavalryOrder(team);
        return (missing ? `暂无${missing}，全军改用标准推进。` : '') + UI_TACTIC_OPTIONS[effective].description
            + (this.configs[team].cavalry > 0 ? ' 骑兵：' + UI_CAVALRY_OPTIONS[cavalry].description
                + (effective === 'hold_ground' && cavalry !== 'auto' ? ' 此骑兵指令优先于守位：骑兵离开守区执行，其他兵种继续守位。' : '') : ' 本队暂无骑兵。');
    },

    updateCommandControls() {
        const selectable = ['sandbox', 'terrain'].includes(this.mode);
        const disabled = !selectable || !['ready', 'result'].includes(this.phase) || this.countdown;
        for (const phase of ['ready', 'result']) {
            document.getElementById('commands-' + phase).hidden = !selectable;
            for (const team of ['red', 'blue']) {
                for (const [kind, choices] of [['army', UI_TACTIC_OPTIONS], ['cavalry', UI_CAVALRY_OPTIONS]]) {
                    const control = document.getElementById(`${phase}-${team}-${kind}`);
                    control.innerHTML = Object.entries(choices).map(([value, choice]) => `<option value="${value}">${choice.name}</option>`).join('');
                    control.value = kind === 'army' ? this.orders[team] : this.cavalryOrder(team);
                    control.disabled = disabled || (kind === 'cavalry' && !this.configs[team].cavalry);
                }
                document.getElementById(`${phase}-${team}-command-description`).textContent = this.commandDescription(team);
            }
        }
        const hud = document.getElementById('commands-hud');
        hud.hidden = !selectable || this.phase !== 'battle';
        hud.textContent = ['red', 'blue'].map(team => (team === 'red' ? '红方：' : '蓝方：')
            + this.commandSummary(team, { [team]: this.orderAvailability(team).effective })).join(' ｜ ');
    },

    showHome() {
        this.clearBattle();
        this.mode = 'sandbox';
        this.challenge = null;
        this.editing = false;
        this.orders = { red: 'advance', blue: 'advance' };
        this.resetBattleOptions();
        this.setPhase('home');
        this.setStep(0);
        this.renderChallenges();
        this.showSection('home');
    },

    renderChallenges() {
        const completed = CHALLENGES.filter(c => this.progress[c.id]).length;
        document.getElementById('campaign-progress').textContent = completed + ' / 5 已通过';
        document.getElementById('challenge-list').innerHTML = CHALLENGES.map((c, i) => `
            <button class="challenge-card ${this.progress[c.id] ? 'completed' : ''}" data-challenge="${c.id}">
                <span class="challenge-number">0${i + 1}</span>
                <img src="assets/units/blue_${c.unit}.png" alt="" class="challenge-unit">
                <span class="challenge-copy"><small>${c.subtitle}</small><strong>${c.title}</strong><span>${c.description}</span>
                <span class="challenge-meta"><b>🪙 ${c.budget}</b><span>${this.progress[c.id] ? '✓ 已通过' : c.difficulty}</span></span></span>
                <span class="challenge-arrow" aria-hidden="true">↗</span>
            </button>`).join('');
        document.querySelectorAll('[data-challenge]').forEach(b => {
            b.onclick = () => this.startChallenge(b.dataset.challenge);
        });
    },

    startChallenge(id) {
        const challenge = CHALLENGES.find(c => c.id === id);
        if (!challenge) return;
        this.clearBattle();
        this.mode = 'challenge';
        this.challenge = challenge;
        this.editing = false;
        this.configs = { red: {}, blue: { ...challenge.enemy } };
        this.formations = { red: 'custom', blue: challenge.enemyFormation };
        this.orders = { red: 'advance', blue: 'advance' };
        this.resetBattleOptions();
        this.buildBuy('red');
        this.setStep(1);
        this.showSection('buy');
        Snd.play('tick');
    },

    resetAll() {
        this.clearBattle();
        this.mode = 'sandbox';
        this.challenge = null;
        this.editing = false;
        this.configs = { red: {}, blue: {} };
        this.formations = { red: 'custom', blue: 'custom' };
        this.orders = { red: 'advance', blue: 'advance' };
        this.resetBattleOptions();
        this.buildBuy('red');
        this.setStep(1);
        this.showSection('buy');
        this.showOverlay('red');
    },

    startTactics(order = 'flank') {
        if (!['assault', 'flank', 'reserve'].includes(order)) return;
        this.clearBattle();
        this.mode = 'tactics';
        this.challenge = null;
        this.editing = false;
        const reserve = order === 'reserve';
        this.configs = { red: { infantry: reserve ? 150 : 100 }, blue: { pikeman: 100 } };
        this.formations = { red: 'custom', blue: 'square' };
        this.orders = { red: reserve ? 'flank' : order, blue: 'hold' };
        this.battleOptions = { deathmatch: reserve, reserves: { red: reserve ? 50 : 0, blue: 0 }, terrain: 'flat', cavalryOrders: { red: 'auto', blue: 'auto' } };
        this.deployArmies();
    },

    alternateTactics() {
        return Object.values(this.orders).includes('flank') ? 'assault' : 'flank';
    },

    budget(team) { return this.mode === 'challenge' && team === 'red' ? this.challenge.budget : BUDGET; },
    spent(team) { return armyCost(this.configs[team]); },
    troops(team) { return Object.values(this.configs[team]).reduce((sum, n) => sum + n, 0); },
    armyText(config) {
        return Object.entries(config).filter(([, n]) => n > 0).map(([key, n]) => `${UNIT_TYPES[key].icon}${UNIT_TYPES[key].name} × ${n}`).join(' · ');
    },

    buildBuy(team) {
        this.stopHolds();
        this.setPhase('buy-' + team);
        const isRed = team === 'red';
        const banner = document.getElementById('team-banner');
        banner.textContent = this.mode === 'challenge' ? '🔴 我的军队 · 你来决定怎么赢' : (isRed ? '🔴 红方' : '🔵 蓝方') + '队长，组建你的军队！';
        banner.className = 'team-banner ' + team;
        const lock = document.getElementById('btn-lock');
        lock.textContent = this.editing || this.mode === 'challenge' || !isRed ? '⚑ 阵容就绪，检阅军队' : '🔒 配好了，换蓝方队长！';
        lock.className = 'big-btn ' + team;
        const brief = document.getElementById('challenge-brief');
        brief.hidden = this.mode !== 'challenge';
        if (this.challenge) {
            brief.innerHTML = `<div class="brief-heading"><b>${this.challenge.icon} ${this.challenge.title}</b><span>目标：击败蓝方敌军</span></div>
                <p>敌阵：${this.armyText(this.challenge.enemy)}</p>
                <details><summary>需要一点战术提示？</summary><p>${this.challenge.hint}</p></details>`;
        }
        document.getElementById('buy-message').textContent = '按住 ＋ 连续加兵 · 挑战中预设会按预算缩减';
        const wrap = document.getElementById('unit-cards');
        wrap.innerHTML = '';
        for (const [key, t] of Object.entries(UNIT_TYPES)) {
            const card = document.createElement('div');
            card.className = 'ucard';
            card.innerHTML = `<img class="uc-img" src="assets/units/${team}_${key}.png" alt="${t.name}">
                <div class="uc-body"><div class="uc-top"><span class="uc-name">${t.name}</span><span class="uc-cost">🪙${t.cost}</span></div>
                <div class="uc-stats">⚔️${t.atk} · 🛡️${t.def} · ❤️${t.hp}</div><div class="uc-tip">${t.tip}</div></div>
                <div class="uc-step"><button class="step-btn minus" aria-label="减少${t.name}">－</button>
                <b class="uc-num" id="num-${key}">0</b><button class="step-btn plus" aria-label="增加${t.name}">＋</button></div>`;
            wrap.appendChild(card);
            this.bindHold(card.querySelector('.minus'), () => this.changeCount(team, key, -1));
            this.bindHold(card.querySelector('.plus'), () => this.changeCount(team, key, 1));
        }
        const row = document.getElementById('formation-row');
        row.innerHTML = '';
        for (const [key, f] of Object.entries(FORMATIONS)) {
            const button = document.createElement('button');
            button.className = 'chip' + (this.formations[team] === key ? ' active' : '');
            button.textContent = f.name;
            button.setAttribute('aria-pressed', String(this.formations[team] === key));
            button.onclick = () => {
                if (this.phase !== 'buy-' + team) return;
                this.formations[team] = key;
                row.querySelectorAll('.chip').forEach(c => {
                    c.classList.toggle('active', c === button);
                    c.setAttribute('aria-pressed', String(c === button));
                });
                Snd.play('buy');
            };
            row.appendChild(button);
        }
        this.renderOrders(team);
        Object.keys(UNIT_TYPES).forEach(k => this.renderNum(team, k));
        this.updateBudget(team);
    },

    renderOrders(team) {
        document.getElementById('order-options').hidden = this.mode === 'challenge';
        const row = document.getElementById('order-row');
        row.replaceChildren();
        for (const [key, order] of Object.entries(UI_TACTIC_OPTIONS)) {
            if (key === 'hold_ground' && !['sandbox', 'terrain'].includes(this.mode)) continue;
            const button = document.createElement('button');
            button.className = 'chip' + (this.orders[team] === key ? ' active' : '');
            button.textContent = order.name;
            button.setAttribute('aria-pressed', String(this.orders[team] === key));
            button.onclick = () => {
                if (this.phase !== 'buy-' + team) return;
                this.orders[team] = key;
                row.querySelectorAll('.chip').forEach(chip => {
                    chip.classList.toggle('active', chip === button);
                    chip.setAttribute('aria-pressed', String(chip === button));
                });
                this.updateOrderDescription(team);
                Snd.play('buy');
            };
            row.appendChild(button);
        }
        this.updateOrderDescription(team);
        this.renderCavalryOrders(team);
    },

    renderCavalryOrders(team) {
        document.getElementById('cavalry-options').hidden = !['sandbox', 'terrain'].includes(this.mode);
        const row = document.getElementById('cavalry-order-row');
        row.replaceChildren();
        for (const [key, order] of Object.entries(UI_CAVALRY_OPTIONS)) {
            const button = document.createElement('button');
            button.className = 'chip' + (this.cavalryOrder(team) === key ? ' active' : '');
            button.textContent = order.name;
            button.setAttribute('aria-pressed', String(this.cavalryOrder(team) === key));
            button.onclick = () => this.selectCommand(team, 'cavalry', key);
            row.appendChild(button);
        }
    },

    orderAvailability(team) {
        const selected = this.orders[team];
        const required = UI_TACTIC_OPTIONS[selected].requires;
        const missing = selected === 'hold_ground' && !this.troops(team) ? '士兵'
            : required && !(this.configs[team][required] > 0) ? UNIT_TYPES[required].name : null;
        return { effective: missing ? 'advance' : selected, missing };
    },

    updateOrderDescription(team) {
        const order = UI_TACTIC_OPTIONS[this.orders[team]];
        const { missing } = this.orderAvailability(team);
        document.getElementById('order-description').textContent = (missing ? `本队暂无${missing}，开战时改用标准推进。` : '') + order.description;
        const cavalry = this.cavalryOrder(team);
        document.getElementById('cavalry-description').textContent = (this.configs[team].cavalry ? '' : '本队暂无骑兵；招募后才会执行。')
            + UI_CAVALRY_OPTIONS[cavalry].description
            + (this.orders[team] === 'hold_ground' && cavalry !== 'auto' ? ' 此指令允许骑兵离开守区，其他兵种仍守位。' : '');
    },

    stopHolds() {
        this.holdStops.forEach(stop => stop());
        this.holdStops = [];
    },

    bindHold(el, fn) {
        let timer, repeat, held = 0;
        const stop = () => { clearTimeout(timer); clearInterval(repeat); held = 0; };
        this.holdStops.push(stop);
        el.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            el.setPointerCapture(e.pointerId);
            fn();
            timer = setTimeout(() => {
                repeat = setInterval(() => {
                    held++;
                    const step = held < 10 ? 1 : held < 30 ? 8 : 25;
                    for (let i = 0; i < step; i++) fn();
                }, 60);
            }, 380);
        });
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => el.addEventListener(ev, stop));
        el.addEventListener('click', e => { if (e.detail === 0) fn(); });
    },

    changeCount(team, type, delta) {
        if (this.phase !== 'buy-' + team) return;
        const t = UNIT_TYPES[type], current = this.configs[team][type] || 0;
        if (delta > 0 && this.spent(team) + t.cost > this.budget(team)) { this.flashBudget(); return; }
        if (delta > 0 && current >= t.maxCount) return;
        this.configs[team][type] = Math.max(0, current + delta);
        this.renderNum(team, type);
        this.updateBudget(team);
        Snd.play('buy');
    },

    renderNum(team, type) {
        const n = this.configs[team][type] || 0;
        const el = document.getElementById('num-' + type);
        el.textContent = n;
        el.closest('.ucard').classList.toggle('dim', n === 0);
    },

    applyPreset(name) {
        if (!this.phase.startsWith('buy-')) return;
        const team = this.phase.split('-')[1];
        this.configs[team] = fitArmyToBudget(PRESETS[name].config, this.budget(team));
        Object.keys(UNIT_TYPES).forEach(k => this.renderNum(team, k));
        this.updateBudget(team);
        document.getElementById('buy-message').textContent = this.mode === 'challenge' ? '已按本关预算缩减预设；你还可以微调兵种和数量。' : '预设已就绪，继续微调或直接检阅军队。';
        Snd.play('lock');
    },

    clearArmy() {
        if (!this.phase.startsWith('buy-')) return;
        const team = this.phase.split('-')[1];
        this.configs[team] = {};
        Object.keys(UNIT_TYPES).forEach(k => this.renderNum(team, k));
        this.updateBudget(team);
    },

    updateBudget(team) {
        const budget = this.budget(team), left = budget - this.spent(team);
        document.getElementById('budget-left').textContent = left;
        document.getElementById('budget-fill').style.width = Math.max(0, left / budget * 100) + '%';
        document.getElementById('budget-total').textContent = '预算 ' + budget + ' 金币';
        document.getElementById('troop-total').textContent = '兵力 ' + this.troops(team);
        this.updateOrderDescription(team);
    },

    flashBudget() {
        const el = document.getElementById('budget-left');
        el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
        document.getElementById('buy-message').textContent = '金币不够了，先减少一些士兵再调整。';
    },

    lockTeam() {
        if (!this.phase.startsWith('buy-') || !this.scene) return;
        const team = this.phase.split('-')[1];
        if (!this.troops(team)) {
            document.getElementById('buy-message').textContent = '先招募至少一名士兵，或选择一个预设阵容。';
            return;
        }
        if (this.spent(team) > this.budget(team)) { this.flashBudget(); return; }
        this.stopHolds();
        Snd.play('lock');
        if (team === 'red' && this.mode === 'sandbox' && !this.editing) {
            this.buildBuy('blue');
            this.setStep(2);
            this.showOverlay('blue');
        } else {
            this.editing = false;
            this.deployArmies();
        }
    },

    showOverlay(team) {
        const ov = document.getElementById('overlay');
        const name = team === 'red' ? '红方' : '蓝方';
        ov.className = 'overlay show ' + team;
        ov.innerHTML = `<div class="overlay-card"><div class="overlay-emoji">${team === 'red' ? '🔴' : '🔵'}</div>
            <div class="overlay-title">轮到${name}队长！</div><div class="overlay-sub">另一位队长请先闭上眼睛，别偷看阵容哦～</div>
            <button class="big-btn ${team}" id="btn-reveal">我要配兵！</button></div>`;
        document.getElementById('btn-reveal').onclick = () => { ov.className = 'overlay'; Snd.play('tick'); };
    },

    deployArmies() {
        if (!this.troops('red') || !this.troops('blue')) return;
        this.countdown = false;
        this.pendingDeploy = !this.scene;
        const deathmatch = this.battleOptions.deathmatch;
        const reserves = Object.fromEntries(['red', 'blue'].map(team => [team,
            Math.min(this.battleOptions.reserves[team] || 0, Math.max(0, (this.configs[team].infantry || 0) - 1))]));
        const terrain = ['sandbox', 'terrain'].includes(this.mode) ? Terrain.normalize(this.battleOptions.terrain) : 'flat';
        const cavalryOrders = Object.fromEntries(['red', 'blue'].map(team => [team,
            ['sandbox', 'terrain'].includes(this.mode) ? this.cavalryOrder(team) : 'auto']));
        this.battleOptions = { deathmatch, reserves, terrain, cavalryOrders };
        this.scene?.deployUnits(this.configs.red, this.configs.blue, this.formations.red, this.formations.blue,
            { ...this.orders }, { ...this.battleOptions, reserves: { ...reserves }, cavalryOrders: { ...cavalryOrders } });
        this.setPhase('ready');
        this.setStep(3);
        document.getElementById('army-summary').innerHTML = ['red', 'blue'].map(team => {
            const { effective, missing } = this.orderAvailability(team);
            const fallback = missing ? `<small>未启用${UI_TACTIC_OPTIONS[this.orders[team]].name}：本队暂无${missing}</small>` : '';
            const reserveNote = reserves[team] || (deathmatch && this.configs[team].infantry)
                ? `<small class="reserve-note">剑士 ${this.configs[team].infantry - reserves[team]} 进攻 + ${reserves[team]} 预备${reserves[team] ? ' · 接应溃兵，分批投入' : ''}</small>` : '';
            return `
            <div class="sum ${team}"><b>${team === 'red' ? '🔴 红方' : '🔵 蓝方'}</b> ${this.armyText(this.configs[team])}
            <span class="sum-f">${FORMATIONS[this.formations[team]].name} · ${this.commandSummary(team, { [team]: effective })}</span>${reserveNote}${fallback}</div>`;
        }).join('');
        document.getElementById('tactics-ready-guide').hidden = this.mode !== 'tactics';
        document.getElementById('tactics-ready-title').textContent = deathmatch
            ? '预备队接应 · 收拢溃兵后继续进攻' : '观察：正面能否守住，迂回队何时到位？';
        document.getElementById('tactics-ready-copy').textContent = deathmatch
            ? '观察黄标后撤、橙标逃离、绿标恢复整队、蓝箭头返场。集结旗旁是真实接应队，侧翼也会派人收拢；重整不回血。枪阵仍会转身迎敌、内排补位。'
            : '枪阵会转身迎敌、小步调整，内排反击入阵者并补位；绕行队沿外缘寻找机会，剑士不一定能攻破完整方阵。';
        document.getElementById('deathmatch-ready-rule').hidden = !deathmatch;
        document.getElementById('ready-morale-title').textContent = deathmatch
            ? '溃逃不会直接判负，稳住后还能继续打。' : '稳住军心，也能赢下战斗。';
        document.querySelectorAll('#tactics-ready-guide [data-tactics-entry]').forEach(button => {
            const selected = deathmatch ? button.dataset.tacticsEntry === 'reserve'
                : Object.values(this.orders).includes(button.dataset.tacticsEntry);
            button.classList.toggle('active', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
        document.getElementById('btn-ready-red').textContent = this.mode === 'challenge' ? '调整我的阵容' : '调整红方';
        document.getElementById('btn-ready-blue').hidden = this.mode === 'challenge';
        this.updateCounts();
        this.showSection('ready');
    },

    startBattle() {
        if (this.phase !== 'ready' || !this.scene) return;
        this.countdown = true;
        this.setPhase('battle');
        document.getElementById('phase-hint').textContent = this.battleOptions.deathmatch
            ? '死斗 · 溃兵可重整，直到一方全灭'
            : (this.challenge ? this.challenge.title + ' · ' : this.mode === 'tactics' ? '战阵演练 · ' : '') + '拖动看战况 · 点击士兵看地形';
        this.openSheet(false);
        this.scene.startCountdown(() => { this.countdown = false; this.syncControls(); });
    },

    editArmy(team) {
        if (!['result', 'ready', 'battle'].includes(this.phase)) return;
        if (this.mode === 'challenge' && team !== 'red') return;
        this.clearBattle();
        this.editing = true;
        this.buildBuy(team);
        this.setStep(team === 'red' ? 1 : 2);
        this.showSection('buy');
    },

    rematch(swap = false) {
        if (this.phase !== 'result') return;
        if (swap && this.mode === 'challenge') return;
        if (swap) {
            [this.configs.red, this.configs.blue] = [this.configs.blue, this.configs.red];
            [this.formations.red, this.formations.blue] = [this.formations.blue, this.formations.red];
            [this.orders.red, this.orders.blue] = [this.orders.blue, this.orders.red];
            [this.battleOptions.reserves.red, this.battleOptions.reserves.blue] =
                [this.battleOptions.reserves.blue, this.battleOptions.reserves.red];
            const redCavalry = this.cavalryOrder('red'), blueCavalry = this.cavalryOrder('blue');
            this.battleOptions.cavalryOrders = { red: blueCavalry, blue: redCavalry };
        }
        this.deployArmies();
        this.startBattle();
    },

    formatTime(ms) {
        const seconds = Math.floor(ms / 1000);
        return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    },

    renderTeamReport(team, data) {
        const name = team === 'red' ? '红方' : '蓝方';
        const rows = Object.entries(data.byType).filter(([, s]) => s.initial > 0).map(([key, s]) => `
            <tr><th scope="row">${UNIT_TYPES[key].icon} ${UNIT_TYPES[key].name}</th><td>${s.initial}</td><td>${s.alive}</td><td>${s.lost}</td><td>${s.withdrawn ?? 0}</td><td>${s.kills}</td></tr>`).join('');
        return `<div class="report-team ${team}"><div class="report-team-title"><b>${team === 'red' ? '🔴' : '🔵'} ${name}</b><span>有效伤害 ${Math.round(data.damage).toLocaleString()}</span></div>
            <table><caption class="sr-only">${name}各兵种战报，在场包含当前溃逃人数</caption><thead><tr><th scope="col">兵种</th><th scope="col">出战</th><th scope="col">在场</th><th scope="col">阵亡</th><th scope="col">撤离</th><th scope="col">击杀</th></tr></thead><tbody>${rows}</tbody></table>
            <div class="report-morale"><span>曾溃逃 <b>${data.routed ?? 0}</b> 人</span><span>重整 <b>${data.rallied ?? 0}</b> 人</span><span>当前溃逃 <b>${data.routing ?? 0}</b> 人</span><span>重整后命中 <b>${data.reengaged ?? 0}</b> 人</span><span>返场伤害 <b>${Math.round(data.postRallyDamage ?? 0).toLocaleString()}</b></span></div></div>`;
    },

    onBattleEnd(winner, report) {
        if (this.phase !== 'battle') return;
        this.countdown = false;
        this.setPhase('result');
        this.setStep(0);
        this.updateCounts();
        const wonChallenge = this.mode === 'challenge' && winner === 'red';
        if (wonChallenge) this.saveWin();
        document.getElementById('result-eyebrow').textContent = this.challenge ? this.challenge.title + ' · 本局战报'
            : (report.deathmatch ? '预备队死斗' : this.mode === 'terrain' ? '高地演练' : this.mode === 'tactics' ? '战阵演练' : '自由对战') + ' · 本局战报';
        const title = document.getElementById('result-title');
        title.className = 'result-title ' + winner;
        title.textContent = winner === 'draw' ? '势均力敌 · 平局' : this.challenge ? (wonChallenge ? '挑战成功！' : '再试一种解法') : (winner === 'red' ? '🔴 红方胜利！' : '🔵 蓝方胜利！');
        document.getElementById('phase-hint').textContent = '读一读战报，准备下一次出击';
        const endReason = report.deathmatch && winner !== 'draw'
            ? (winner === 'red' ? '蓝方' : '红方') + '已全灭，死斗结束。 '
            : report.endReason === 'stalemate' ? '双方持续固守、无人推进，本局相持结束。试着让一方改为进攻。 ' : report.endReason === 'rout' && winner !== 'draw'
            ? (winner === 'red' ? '蓝方' : '红方') + '军心瓦解，失去继续作战能力。 '
            : winner === 'draw' && report.red + report.blue > 0 && report.morale &&
                report.morale.red.steady + report.morale.red.wavering + report.morale.blue.steady + report.morale.blue.wavering === 0
                ? '双方均已失去继续作战能力。 ' : '';
        document.getElementById('result-detail').textContent = endReason + '在场兵力：红方 ' + report.red + ' 人 · 蓝方 ' + report.blue + ' 人';
        const leaders = Object.entries(report.teams.red.byType).filter(([, s]) => s.initial > 0).sort((a, b) => b[1].kills - a[1].kills);
        const leader = leaders[0];
        document.getElementById('result-metrics').innerHTML = `
            <div><small>战斗用时</small><b>${this.formatTime(report.durationMs)}</b></div>
            <div><small>红方在场 / 出战</small><b>${report.red} <em>/ ${report.teams.red.initial}</em></b></div>
            <div><small>红方击杀最多</small><b>${leader && leader[1].kills > 0 ? UNIT_TYPES[leader[0]].name : '暂无击杀'}</b></div>`;
        const terrainReport = document.getElementById('terrain-report');
        terrainReport.hidden = !['sandbox', 'terrain'].includes(this.mode);
        const map = Terrain.maps[Terrain.normalize(report.terrain || this.battleOptions.terrain)];
        const contact = Number.isFinite(report.firstContactMs) ? (report.firstContactMs / 1000).toFixed(1) + ' 秒' : '未接敌';
        terrainReport.textContent = '本局地图：' + map.name + ' · 首次交锋：' + contact + '（首次有效伤害，不含倒计时）';
        const commandsReport = document.getElementById('commands-report');
        commandsReport.hidden = !['sandbox', 'terrain'].includes(this.mode);
        commandsReport.textContent = ['red', 'blue'].map(team => (team === 'red' ? '红方：' : '蓝方：')
            + this.commandSummary(team, report.orders || { [team]: this.orderAvailability(team).effective },
                report.cavalryOrders || this.battleOptions.cavalryOrders)).join(' ｜ ');
        document.getElementById('report-tables').innerHTML = ['red', 'blue'].map(team => this.renderTeamReport(team, report.teams[team])).join('');
        const events = document.getElementById('battle-events');
        events.replaceChildren();
        for (const event of report.events) {
            const li = document.createElement('li');
            li.textContent = this.formatTime(event.atMs) + '　' + event.text;
            events.appendChild(li);
        }
        if (!report.events.length) { const li = document.createElement('li'); li.textContent = '本局暂无关键交战记录'; events.appendChild(li); }
        document.querySelector('.battle-events').open = false;
        document.getElementById('btn-edit-red').textContent = this.challenge ? '✎ 调整阵容再挑战' : '✎ 调整红方再战';
        document.getElementById('btn-edit-blue').hidden = !!this.challenge;
        document.getElementById('btn-swap').hidden = !!this.challenge;
        document.getElementById('btn-swap').textContent = this.battleOptions.terrain === 'flat' ? '⇄ 交换双方再战' : '⇄ 交换军队再战（高地不动）';
        const switchTactics = document.getElementById('btn-switch-tactics');
        switchTactics.hidden = this.mode !== 'tactics';
        document.getElementById('btn-reserve-tactics').hidden = this.mode !== 'tactics' || report.deathmatch;
        switchTactics.textContent = (report.deathmatch ? '切回 100 对 100 · ' : '换用') + UI_TACTIC_OPTIONS[this.alternateTactics()].name
            + (report.deathmatch ? '（普通胜负）' : '（100 对 100）');
        const next = document.getElementById('btn-next');
        const index = CHALLENGES.indexOf(this.challenge);
        next.hidden = !wonChallenge || index >= CHALLENGES.length - 1;
        next.onclick = () => this.startChallenge(CHALLENGES[index + 1].id);
        this.showSection('result');
    },

    updateCounts() {
        document.getElementById('red-count').textContent = this.scene?.redAlive || 0;
        document.getElementById('blue-count').textContent = this.scene?.blueAlive || 0;
        this.updateMorale();
        this.updateTactics();
    },

    updateTactics() {
        const summary = this.phase === 'battle' ? this.scene?.getTacticsSummary?.() : null;
        document.getElementById('tactics-hud').hidden = !summary;
        for (const team of ['red', 'blue']) {
            const data = summary?.[team];
            document.getElementById('tactics-' + team).hidden = !data;
            if (!data) continue;
            document.getElementById(`tactics-${team}-label`).textContent = (team === 'red' ? '红方 · ' : '蓝方 · ') + data.label;
            const stage = document.getElementById(`tactics-${team}-stage`);
            stage.textContent = data.stage;
            stage.title = data.stage;
            let strength = data.order === 'hold'
                ? `架枪 ${data.ready} · 应战 ${data.engaging ?? 0} · 调整位置 ${data.repositioning ?? 0} · 曾失守 ${data.breaches} 位`
                : data.order === 'flank' ? `正面 ${data.main} 人 · 迂回 ${data.flank} 人可战` : `主队 ${data.main} 人可战`;
            if (this.battleOptions.reserves[team]) {
                strength += ` · 预备待命 ${data.reserve ?? 0} · 已投入 ${data.committed ?? 0}`;
                strength += ` · 撤回重整 ${data.regrouping ?? 0} · 已重整 ${data.rallied ?? 0}`;
            }
            document.getElementById(`tactics-${team}-strength`).textContent = strength;
        }
    },

    updateMorale() {
        const summary = this.phase === 'battle' ? this.scene?.getMoraleSummary?.() : null;
        document.getElementById('morale-hud').hidden = !summary;
        const cue = this.scene?.moraleCue;
        const cueEl = document.getElementById('morale-cue');
        cueEl.hidden = !summary || !cue || this.scene.simulationTime - cue.atMs > 4500;
        cueEl.textContent = cueEl.hidden ? '' : cue.text;
        for (const team of ['red', 'blue']) {
            const data = summary?.[team];
            const present = (data?.steady || 0) + (data?.wavering || 0) + (data?.routing || 0);
            for (const state of ['steady', 'wavering', 'routing']) {
                document.getElementById(`morale-${team}-${state}`).textContent = data?.[state] ?? 0;
            }
            const average = present && Number.isFinite(data?.average) ? Math.round(data.average) : '—';
            document.getElementById(`morale-${team}-average`).textContent = average;
            const reason = data?.lastReason || (present ? '阵线稳定' : '暂无在场士兵');
            const reasonEl = document.getElementById(`morale-${team}-reason`);
            reasonEl.textContent = reason;
            reasonEl.title = reason;
            const flow = document.getElementById(`morale-${team}-flow`);
            flow.textContent = !present ? '' : `后撤 ${data.fallingBack ?? 0} · 逃离 ${data.escaping ?? data.routing ?? 0} · 恢复 ${data.recovering ?? 0} · 整队 ${data.forming ?? 0} · 返场 ${data.returning ?? 0} · 重整后命中 ${data.reengaged ?? 0}人`;
        }
    },

    bindControls() {
        document.getElementById('btn-home').onclick = () => this.showHome();
        document.getElementById('btn-sandbox').onclick = () => this.resetAll();
        document.getElementById('btn-terrain').onclick = () => this.startTerrain();
        document.querySelectorAll('[data-terrain]').forEach(button => {
            button.onclick = () => this.selectTerrain(button.dataset.terrain);
        });
        for (const phase of ['ready', 'result']) {
            for (const team of ['red', 'blue']) {
                for (const kind of ['army', 'cavalry']) {
                    const control = document.getElementById(`${phase}-${team}-${kind}`);
                    control.onchange = () => this.selectCommand(team, kind, control.value);
                }
            }
        }
        document.querySelectorAll('[data-tactics-entry]').forEach(button => {
            button.onclick = () => { this.startTactics(button.dataset.tacticsEntry); Snd.play('tick'); };
        });
        document.getElementById('btn-switch-tactics').onclick = () => this.startTactics(this.alternateTactics());
        document.getElementById('btn-lock').onclick = () => this.lockTeam();
        document.getElementById('btn-start').onclick = () => this.startBattle();
        document.getElementById('btn-again').onclick = () => this.showHome();
        document.getElementById('btn-edit-red').onclick = () => this.editArmy('red');
        document.getElementById('btn-edit-blue').onclick = () => this.editArmy('blue');
        document.getElementById('btn-ready-red').onclick = () => this.editArmy('red');
        document.getElementById('btn-ready-blue').onclick = () => this.editArmy('blue');
        document.getElementById('btn-rematch').onclick = () => this.rematch();
        document.getElementById('btn-swap').onclick = () => this.rematch(true);
        document.getElementById('btn-restart').onclick = () => this.editArmy('red');
        document.getElementById('btn-pause').onclick = () => {
            if (this.phase !== 'battle' || this.countdown || !this.scene) return;
            this.scene.togglePause(); this.syncControls();
        };
        document.querySelectorAll('.speed-btn').forEach(b => b.onclick = () => {
            if (!this.scene || this.phase !== 'battle') return;
            this.scene.setSpeed(Number(b.dataset.speed)); this.syncControls();
        });
        document.getElementById('btn-mute').onclick = () => {
            Snd.muted = !Snd.muted;
            document.getElementById('btn-mute').textContent = Snd.muted ? '🔇' : '🔊';
            document.getElementById('btn-mute').setAttribute('aria-label', Snd.muted ? '开启声音' : '关闭声音');
        };
        const toggleSheet = () => this.openSheet(!document.getElementById('sheet').classList.contains('open'));
        document.getElementById('btn-panel').onclick = toggleSheet;
        document.getElementById('btn-fold').onclick = toggleSheet;
        document.querySelector('.sheet-head').addEventListener('click', e => {
            if (!e.target.closest('button')) toggleSheet();
        });
        document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => this.applyPreset(b.dataset.preset));
        document.getElementById('btn-clear').onclick = () => this.clearArmy();
        window.addEventListener('blur', () => this.holdStops.forEach(stop => stop()));
    }
};

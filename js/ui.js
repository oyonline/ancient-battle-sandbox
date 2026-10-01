// ==================== 音效（WebAudio 合成，无外部文件） ====================
import { Snd } from './snd.js';
import { lobbyMethods } from './lobby.js';
import { Terrain } from './terrain.js';
import { UNIT_TYPES, FORMATIONS, BUDGET } from './units.js';
import { CHALLENGES, armyCost, fitArmyToBudget } from './challenges.js';
import { TERRITORY, makeTerritoryFlags } from './battle/economy.js';
import { setBoardSize, resetBoardSize } from './board.js';
import { ArenaClient } from './net/arena-client.js';
import { NetBattle } from './net/lockstep.js';
import { CampControls } from './camp-controls.js';


// ==================== 一键预设配兵（预算 4000） ====================
export const PRESETS = {
    balance: { name: '均衡军团', config: { infantry: 150, pikeman: 30, archer: 40, cavalry: 30 } },
    ranged:  { name: '远程火力', config: { infantry: 60, pikeman: 60, archer: 150, cavalry: 0 } },
    rush:    { name: '铁骑洪流', config: { infantry: 80, pikeman: 0, archer: 0, cavalry: 120 } },
    thousand:{ name: '千人军团', config: { infantry: 300, pikeman: 60, archer: 80, cavalry: 60 } }
};

export const UI_TACTIC_OPTIONS = {
    advance: { name: '标准推进', description: '所有兵种按原有方式接近敌人并交战。' },
    assault: { name: '正面强攻', requires: 'infantry', description: '剑士集中向敌阵正面推进，争夺突破口；其他兵种照常作战。' },
    flank: { name: '单翼迂回', requires: 'infantry', description: '剑士约一半在正面牵制，一半沿敌阵外缘寻找侧后方的接敌机会；其他兵种照常作战。' },
    hold: { name: '枪阵守位', requires: 'pikeman', description: '长枪兵布成四面方阵，近敌转身、小步迎击，内排支援缺口；威胁退去后归位架枪。其他兵种照常作战。' },
    hold_ground: { name: '高地守位', description: '己方高地上，弓兵守山顶、剑士和长枪兵护坡口；没有己方高地时守出发区，不夺取敌方山丘。骑兵就近反击后归位。' }
};

export const UI_CAVALRY_OPTIONS = {
    auto: { name: '自由突击（原逻辑）', description: '沿用原有突击判断；全军高地守位时，骑兵只在守区附近反击。' },
    direct: { name: '正面强冲', description: '直接迎击前方敌军，争取助跑冲锋；可能撞上完整枪阵。' },
    flank_archers: { name: '侧翼袭弓', description: '先沿侧翼绕向敌军弓兵，付出绕行时间；途中被截住仍要正常交战，无弓兵时攻击其他敌军。' }
};

// ==================== 战役、配兵与战报 ====================
export const UI = {
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
        this.net = { client: null, side: null, code: null, myReady: false, peerReady: false, inBattle: false };
        this.mySide = 'red';
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
        this.campControls = new CampControls(this);
        // 左下「🧰 建设」入口：固定展开/收起前线建设面板（无选择时列出民夫）
        document.getElementById('btn-camp-open')?.addEventListener('click', () => {
            this.campControls?.togglePin();
        });
        scene.groundClick = (world, picked) => this.onGroundClick(world, picked);
        if (this.pendingNetStart) {
            this.pendingNetStart = false;
            this.launchNetBattle();
            return;
        }
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
        try {
            const last = JSON.parse(localStorage.getItem('battle-last-mode-v1') || 'null');
            if (last && typeof last.kind === 'string') this.lastMode = last;
        } catch (_) { /* 同上：存储被禁时仅本次会话内有效 */ }
    },

    saveWin() {
        const id = this.challenge.id;
        this.progress[id] = { wins: (this.progress[id]?.wins || 0) + 1 };
        try { localStorage.setItem('battle-challenges-v1', JSON.stringify(this.progress)); }
        catch (_) { /* 通关仍保留在本次会话。 */ }
    },

    setPhase(phase) {
        if (phase === 'battle' && this.phase !== 'battle' && this.battleOptions.territory) {
            document.getElementById('controlbar').classList.add('collapsed');
            document.getElementById('btn-hud-collapse').textContent = '⌄ 展开信息';
        }
        this.phase = phase;
        document.body.dataset.phase = phase;
        this.syncControls();
    },

    syncControls() {
        const fighting = this.phase === 'battle';
        document.getElementById('controlbar').hidden = !fighting;
        document.getElementById('deathmatch-hud-rule').hidden = !fighting || !this.battleOptions.deathmatch;
        document.getElementById('control-hud-rule').hidden = !fighting || !this.battleOptions.control;
        const convoyHud = document.getElementById('convoy-hud-rule');
        convoyHud.hidden = !fighting || !this.battleOptions.convoy;
        if (this.battleOptions.convoy && this.scene?.convoy) {
            const c = this.scene.convoy;
            convoyHud.textContent = `🛒 护送：送抵 ${c.delivered}/${c.need} · 被劫 ${c.hijacked || 0}/${c.need} —— 车队需要护卫随行才前进；车身被蓝方独占约 6 秒即遭劫走（人越多越快），护卫在场即冻结`;
        }
        document.getElementById('territory-hud-rule').hidden = !fighting || !this.battleOptions.territory;
        this.updateTerritoryHUD();
        this.updateMorale();
        this.updateTactics();
        this.updateTerrainControls();
        this.updateCommandControls();
        const netLock = this.battleOptions.net && fighting;
        document.getElementById('btn-pause').disabled = !fighting || this.countdown || netLock;
        document.querySelectorAll('.speed-btn').forEach(b => { b.disabled = netLock; });
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
        document.getElementById('sheet-label').textContent = this.phase === 'result' ? '⚑ 战后复盘' : this.mode === 'terrain' ? '⛰ 地形演练' : this.mode === 'tactics' ? '⚑ 战阵演练' : '⚑ 统帅试炼';
        document.querySelectorAll('#steps .step').forEach(el => {
            const k = Number(el.dataset.step);
            el.hidden = challenge && k === 2;
            el.classList.toggle('on', k === n);
            el.classList.toggle('done', k < n);
            el.querySelector('span').textContent = k === 1 ? (challenge ? '我的军队' : '红方配兵') : k === 2 ? '蓝方配兵' : '准备开战';
            el.querySelector('i').textContent = challenge && k === 3 ? '2' : String(k);
        });
        const hint = n === 0 ? '观察敌阵，找到你的解法' : n === 3 ? (this.mode === 'terrain' ? '地形演练 · 同阵容换图对照' : this.mode === 'tactics' ? '战阵演练 · 观察枪阵与迂回路线' : '两军就位，准备开战') : challenge ? this.challenge.title + ' · 为红方配兵' : (n === 1 ? '红方' : '蓝方') + '队长正在配兵';
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
        this.campControls?.reset();
        this.stopHolds();
        this.countdown = false;
        this.pendingDeploy = this.pendingAutoplay = false;
        // 领土分区 HUD 收场：卸 body 态类并隐藏容器（updateTerritoryHUD 不会被被动调用）
        document.body.classList.remove('territory-battle');
        document.getElementById('territory-strip')?.setAttribute('hidden', '');
        document.getElementById('recruit-dock')?.setAttribute('hidden', '');
        // 营队条拆出大条后自管显隐：离场必须收起（旧布局由 #controlbar 整体隐藏掩蔽）
        document.getElementById('battalion-bar')?.setAttribute('hidden', '');
        if (this.scene) this.scene.clearUnits();
        document.getElementById('overlay').className = 'overlay';
        this.updateCounts();
    },

    resetBattleOptions() {
        this.battleOptions = { deathmatch: false, control: false, convoy: false, territory: false,
            reserves: { red: 0, blue: 0 }, terrain: 'flat', cavalryOrders: { red: 'auto', blue: 'auto' } };
    },

    startTerrain(terrain = 'blue_pass') {
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
        const defender = Terrain.maps[this.battleOptions.terrain].defender;
        if (['red', 'blue'].includes(defender)) this.orders[defender] = 'hold_ground';
        this.rememberMode('⛰ ' + Terrain.maps[this.battleOptions.terrain].name, 'terrain', this.battleOptions.terrain);
        this.deployArmies();
    },

    startControl() {
        this.clearBattle();
        this.mode = 'sandbox';
        this.challenge = null;
        this.editing = false;
        const army = { infantry: 24, pikeman: 14, archer: 18, cavalry: 8 };
        this.configs = { red: { ...army }, blue: { ...army } };
        this.formations = { red: 'custom', blue: 'custom' };
        this.orders = { red: 'advance', blue: 'advance' };
        this.resetBattleOptions();
        this.battleOptions.control = true;
        this.rememberMode('⚑ 占点三旗', 'control');
        this.deployArmies();
    },

    startConvoy() {
        this.clearBattle();
        this.mode = 'sandbox';
        this.challenge = null;
        this.editing = false;
        // 护送军偏步矛弓（护得住），劫掠军带机动骑兵（截得住）；护送更难，红方预算略厚
        this.configs = {
            red: { infantry: 20, pikeman: 14, archer: 14 },
            blue: { cavalry: 9, infantry: 16, archer: 8 }
        };
        this.formations = { red: 'custom', blue: 'custom' };
        this.orders = { red: 'advance', blue: 'advance' };
        this.resetBattleOptions();
        this.battleOptions.convoy = true;
        this.rememberMode('🛒 辎重护送', 'convoy');
        this.deployArmies();
    },

    // 领土征服：十一据点经济、民夫建设与老家征兵。双方各带常备军和民夫。
    // 与启动军费开局（不进配兵界面）；红方手动征兵（战斗中大按钮），蓝方 AI 自动运营。
    startTerritory() {
        this.clearBattle();
        this.mode = 'territory';
        this.challenge = null;
        this.editing = false;
        this.configs = { red: { ...TERRITORY.OPENING }, blue: { ...TERRITORY.OPENING } };
        this.formations = { red: 'custom', blue: 'custom' };
        this.orders = { red: 'advance', blue: 'advance' };
        this.resetBattleOptions();
        this.battleOptions.territory = true;
        this.battleOptions.terrain = 'territory';   // 山河领土图：上翼河桥/中央高地/下翼林带
        this.rememberMode('🚩 领土征服 · 山河会战', 'territory');
        this.deployArmies();
    },

    // 占点/护送的自定义配兵：预填推荐阵容进配兵界面，兵数阵容随意改
    startControlCustom() {
        this.rememberMode('⚑ 占点 · 自定义配兵', 'controlCustom');
        this.clearBattle();
        this.mode = 'sandbox';
        this.challenge = null;
        this.editing = true;
        this.configs = {
            red: { infantry: 24, pikeman: 14, archer: 18, cavalry: 8 },
            blue: { infantry: 24, pikeman: 14, archer: 18, cavalry: 8 }
        };
        this.formations = { red: 'custom', blue: 'custom' };
        this.orders = { red: 'advance', blue: 'advance' };
        this.resetBattleOptions();
        this.battleOptions.control = true;
        this.buildBuy('red');
        this.setStep(1);
        this.showSection('buy');
    },

    startConvoyCustom() {
        this.rememberMode('🛒 护送 · 自定义配兵', 'convoyCustom');
        this.clearBattle();
        this.mode = 'sandbox';
        this.challenge = null;
        this.editing = true;
        this.configs = {
            red: { infantry: 20, pikeman: 14, archer: 14 },
            blue: { cavalry: 9, infantry: 16, archer: 8 }
        };
        this.formations = { red: 'custom', blue: 'custom' };
        this.orders = { red: 'advance', blue: 'advance' };
        this.resetBattleOptions();
        this.battleOptions.convoy = true;
        this.buildBuy('red');
        this.setStep(1);
        this.showSection('buy');
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
            document.getElementById('terrain-' + phase + '-rules').textContent = this.terrainRules(terrain);
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

    terrainRules(terrain) {
        if (terrain === 'forest') return '树林可穿行：骑兵地表移速 55%，其他兵种 85%。入林打断冲锋和穿透，林中不能蓄力；出林后重新助跑。道路不受林地限速。';
        if (terrain === 'river') return '河上有中央桥与两座侧桥；桥外水域不可走，推挤和击退也不能穿水。近战不能隔河打人，箭矢可以跨河；可观察哪座桥更拥堵。';
        if (Terrain.isNaturalSlope(terrain)) return '整片草坡都可通行，没有固定入口。步兵沿宽正面仰攻，弓兵据山脊俯射；上坡慢、下坡快。骑兵可选择正面强冲或沿侧坡绕后，守位自由骑兵会就近护弓。';
        return '上坡减速 · 下坡助冲 · 高差影响远射。坡顶恢复正常移速；高地不是永久攻击加成，优势随双方位置变化。';
    },

    guardDescription(team) {
        const terrain = Terrain.normalize(this.battleOptions.terrain);
        if (Terrain.defenseLayout(terrain, team)) {
            return '弓兵守山脊后列，剑士和长枪兵沿坡面组成连续宽正面；自由突击的守位骑兵会就近支援存活弓兵，不会无限追敌。';
        }
        return UI_TACTIC_OPTIONS.hold_ground.description;
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
        return (missing ? `暂无${missing}，全军改用标准推进。` : '')
            + (effective === 'hold_ground' ? this.guardDescription(team) : UI_TACTIC_OPTIONS[effective].description)
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
        this.updateContinueButton();
        this.drawTerritoryThumb();
        this.showSection('home');
    },

    // ---------------- 首页看板：继续上次 + 山河图缩略 ----------------
    rememberMode(label, kind, arg = null) {
        this.lastMode = { label, kind, arg };
        try { localStorage.setItem('battle-last-mode-v1', JSON.stringify(this.lastMode)); }
        catch (_) { /* 浏览器禁用存储时仅本次会话内有效 */ }
    },

    resumeLast() {
        const last = this.lastMode;
        if (!last) return;
        const { kind, arg } = last;
        if (kind === 'territory') this.startTerritory();
        else if (kind === 'control') this.startControl();
        else if (kind === 'controlCustom') this.startControlCustom();
        else if (kind === 'convoy') this.startConvoy();
        else if (kind === 'convoyCustom') this.startConvoyCustom();
        else if (kind === 'tactics') this.startTactics(arg);
        else if (kind === 'terrain') this.startTerrain(arg);
        else if (kind === 'challenge') this.startChallenge(arg);
        else if (kind === 'sandbox') this.resetAll();
        else if (kind === 'net') this.openNetLobby();
    },

    updateContinueButton() {
        const button = document.getElementById('btn-continue');
        if (!this.lastMode) { button.hidden = true; return; }
        button.hidden = false;
        document.getElementById('continue-label').textContent = this.lastMode.label;
    },

    // 局域网房间流程已拆至 js/lobby.js，经 spread 并入
    ...lobbyMethods,
    // ---------------- 领土征服 HUD：经济读数 + 征兵大按钮 ----------------
    buildRecruitBar() {
        const bar = document.getElementById('recruit-bar');
        bar.replaceChildren();
        for (const [key, t] of Object.entries(UNIT_TYPES)) {
            if (t.hidden && !t.territoryOnly) continue;
            const cost = t.cost * TERRITORY.COST_MULT;
            const btn = document.createElement('button');
            btn.className = 'recruit-btn';
            btn.id = 'recruit-' + key;
            btn.title = t.tip + ` · 训练 ${TERRITORY.TRAIN_MS[key] / 1000} 秒`;
            btn.innerHTML = `<span class="rc-icon">${t.icon}</span><span class="rc-name">${t.name}</span><span class="rc-cost">🪙${cost}</span>`;
            // 大按钮长按连买（亲子手感）：按下立即买一个，按住每 60ms 继续。
            // 联机对战：操作进锁步命令队列（经服务器回环后在本回合确定性执行）。
            this.bindHold(btn, () => {
                if (this.phase !== 'battle' || this.countdown || !this.scene?.territory) return;
                const side = this.mySide || 'red';
                if (this.battleOptions.net && this.scene.net) {
                    this.scene.net.lockstep.act({ k: 'buy', side, type: key });
                    Snd.play('buy');
                    this.updateTerritoryHUD();
                    return;
                }
                if (this.scene.territory.recruit.enqueue(side, key)) {
                    Snd.play('buy');
                    this.updateTerritoryHUD();
                }
            });
            bar.appendChild(btn);
        }
    },

    updateTerritoryHUD() {
        const strip = document.getElementById('territory-strip');
        const dock = document.getElementById('recruit-dock');
        const active = this.phase === 'battle' && this.battleOptions.territory && this.scene?.territory;
        document.body.classList.toggle('territory-battle', active);
        if (strip) strip.hidden = !active;
        if (dock) dock.hidden = !active;
        // 战斗控制按钮（暂停/倍速/调整阵容）随布局迁移：领土进顶条，其它模式回大控制条。
        // DOM 原件搬移不加副本，按钮状态与事件绑定不丢。
        const ctl = document.getElementById('battle-ctl');
        if (ctl) {
            const host = active ? document.getElementById('territory-ctl') : document.getElementById('controlbar');
            if (host && ctl.parentElement !== host) host.appendChild(ctl);
        }
        this.campControls?.update();
        if (!active) return;
        if (!document.getElementById('recruit-infantry')) this.buildRecruitBar();
        const territory = this.scene.territory;
        const mine = this.mySide || 'red';
        const owned = { red: 0, blue: 0 };
        for (const flag of this.scene.flags || []) if (flag.owner) owned[flag.owner]++;
        document.getElementById('territory-treasury').textContent = Math.floor(territory.econ.treasury[mine]);
        document.getElementById('territory-income').textContent = '+' + territory.econ.incomeRate(owned[mine]) + '/秒';
        document.getElementById('territory-tickets-red').textContent = Math.ceil(territory.tickets.tickets.red);
        document.getElementById('territory-tickets-blue').textContent = Math.ceil(territory.tickets.tickets.blue);
        document.getElementById('territory-flags-red').textContent = owned.red;
        document.getElementById('territory-flags-blue').textContent = owned.blue;
        document.getElementById('territory-army-red').textContent = this.scene.redAlive;
        document.getElementById('territory-army-blue').textContent = this.scene.blueAlive;
        document.getElementById('territory-queue').textContent =
            territory.recruit.queues[mine].length ? ` · 训练中 ${territory.recruit.queues[mine].length}` : '';
        const rallyBtn = document.getElementById('btn-rally');
        rallyBtn.classList.toggle('active', !!this.rallyTargeting);
        rallyBtn.hidden = !active;
        for (const [key, t] of Object.entries(UNIT_TYPES)) {
            if (t.hidden && !t.territoryOnly) continue;
            const btn = document.getElementById('recruit-' + key);
            if (btn) btn.disabled = this.countdown || !territory.econ.canAfford(mine, key) ||
                territory.recruit.queues[mine].length >= TERRITORY.QUEUE_CAP;
        }
        this.updateBattalionBar();
    },

    // ---------------- 营队指挥条：选中营后出现，点旗下令/回防 ----------------
    renderBattalionPicker() {
        const row = document.getElementById('battalion-orders');
        const label = document.getElementById('battalion-label');
        const list = this.myBattalions();
        label.textContent = '👆 选择营队下令（或直接点战场上的士兵 · 数字键 1-9）';
        if (!row.querySelector('.battalion-chip')) row.replaceChildren();
        if (row.querySelector('.battalion-chip') && row.childElementCount === list.length &&
            [...row.children].every((chip, i) => chip.dataset.bid === String(list[i]?.id))) {
            // 只刷新数字，不重建（保持点击稳定）
            [...row.children].forEach((chip, i) => {
                const b = list[i];
                const state = b.gathering ? '集结中' : b.retreat ? '回防' : b.orderPoint ? '驻守'
                    : b.orderFlag != null ? '进军' : '作战';
                chip.querySelector('.bc-count').textContent = `${b.aliveMembers().length}人·${state}`;
            });
            return;
        }
        row.replaceChildren();
        for (const battalion of list) {
            const chip = document.createElement('button');
            chip.className = 'order-btn battalion-chip';
            chip.dataset.bid = String(battalion.id);
            const state = battalion.gathering ? '集结中' : battalion.retreat ? '回防' : battalion.orderPoint ? '驻守'
                : battalion.orderFlag != null ? '进军' : '作战';
            chip.innerHTML = `<b>${battalion.id}营</b> <span class="bc-count">${battalion.aliveMembers().length}人·${state}</span>`;
            chip.onclick = () => {
                this.scene.selectedBattalion = battalion;
                Snd.play('tick');
                this.updateBattalionBar();
            };
            row.appendChild(chip);
        }
    },

    buildBattalionBar() {
        const row = document.getElementById('battalion-orders');
        row.replaceChildren();
        const flags = this.scene?.flags || [];
        flags.forEach((flag, index) => {
            const btn = document.createElement('button');
            btn.className = 'order-btn';
            btn.dataset.flagOrder = index;
            btn.innerHTML = `<span class="ob-dot"></span>⚑ ${flag.name}`;
            btn.onclick = () => { this.giveBattalionOrder(index); };
            row.appendChild(btn);
        });
        const home = document.createElement('button');
        home.className = 'order-btn';
        home.dataset.orderHome = '';
        home.textContent = '🏠 回防集结';
        home.onclick = () => { this.giveBattalionOrder('home'); };
        row.appendChild(home);
        const hold = document.createElement('button');
        hold.className = 'order-btn';
        hold.id = 'order-hold';
        hold.textContent = '📍 驻守此处';
        hold.title = '点击后到地图上选一个点，全营开过去驻守（桥头/林缘/高地均可设防）';
        hold.onclick = () => this.beginHoldTargeting();
        row.appendChild(hold);
        const charge = document.createElement('button');
        charge.className = 'order-btn order-charge';
        charge.id = 'order-charge';
        charge.textContent = '⚡ 冲锋！';
        charge.title = '本营骑兵自由冲锋 6 秒（15 秒冷却）';
        charge.onclick = () => this.giveChargeOrder();
        row.appendChild(charge);
        const stanceBtn = document.createElement('button');
        stanceBtn.className = 'order-btn';
        stanceBtn.id = 'order-stance';
        stanceBtn.textContent = '🛡 稳健';
        stanceBtn.title = '稳健=驻守兵 7 格缰绳回位；好战=追到 14 格才回位';
        stanceBtn.onclick = () => this.toggleStance();
        row.appendChild(stanceBtn);
        const clearBtn = document.createElement('button');
        clearBtn.className = 'order-btn';
        clearBtn.id = 'order-clear';
        clearBtn.textContent = '⭕ 解除命令';
        clearBtn.title = '清除本营旗令/驻点/回防，交还 AI 调度';
        clearBtn.onclick = () => this.giveClearOrder();
        row.appendChild(clearBtn);
        const nextBtn = document.createElement('button');
        nextBtn.className = 'order-btn';
        nextBtn.id = 'order-next';
        nextBtn.textContent = '🔄 下一营';
        nextBtn.title = '循环选择本方营队（快捷键 Tab / 数字键 1-9）';
        nextBtn.onclick = () => this.selectNextBattalion();
        row.appendChild(nextBtn);
        const deselect = document.createElement('button');
        deselect.className = 'order-btn';
        deselect.textContent = '✖';
        deselect.title = '取消选择';
        deselect.onclick = () => { this.scene?.selectBattalionByUnit(null); this.updateBattalionBar(); };
        row.appendChild(deselect);
    },

    // ---------------- 驻守目标模式 / 冲锋令 / 快捷选营 ----------------
    beginHoldTargeting() {
        this.campControls?.cancel();
        const selected = this.scene?.selectedBattalion;
        if (!selected || selected.team !== (this.mySide || 'red')) return;
        this.holdTargeting = true;
        document.body.classList.add('targeting');
        this.showNetToast('📍 点击地图选择驻守位置（按 Esc 取消）');
    },

    cancelHoldTargeting() {
        this.holdTargeting = false;
        document.body.classList.remove('targeting');
        const cue = document.getElementById('morale-cue');
        if (cue) cue.hidden = true;
    },

    // 地面点击回调（inspection 上抛）：目标模式下视为选点下令
    onGroundClick(world, picked) {
        if (this.campControls?.handleGroundClick(world, picked)) return;
        if (this.rallyTargeting) {
            this.applyGroundOrder(world, (gx, gy) => {
                this.giveRallyOrder(gx, gy);
                this.cancelRallyTargeting();
            });
            return;
        }
        if (!this.holdTargeting) return;
        const selected = this.scene?.selectedBattalion;
        if (!selected) { this.cancelHoldTargeting(); return; }
        this.applyGroundOrder(world, (gx, gy) => {
            this.giveHoldOrder(gx, gy);
            this.cancelHoldTargeting();
        });
    },

    // 世界坐标 → 网格（两次迭代补偿地形高度；0.1 格量化保联机一致），可走则执行
    applyGroundOrder(world, apply) {
        const scene = this.scene;
        if (!scene || !scene.board_W) return;
        const W = scene.board_W(), H = scene.board_H();
        const origin = scene.worldOrigin ? scene.worldOrigin() : { ox: H * 32, oy: 120, tw: 64, th: 32 };
        const TW = origin.tw, TH = origin.th, OX = origin.ox, OY = origin.oy;
        const key = scene.battleOptions.terrain;
        let gx = W / 2, gy = H / 2;
        for (let pass = 0; pass < 2; pass++) {
            const lift = Terrain.height(key, gx, gy) * Terrain.HEIGHT_SCALE;
            const dx = (world.x - OX) / (TW / 2), dy = (world.y + lift - OY) / (TH / 2);
            gx = (dx + dy) / 2; gy = (dy - dx) / 2;
        }
        gx = Math.round(Math.max(2, Math.min(W - 2, gx)) * 10) / 10;
        gy = Math.round(Math.max(2, Math.min(H - 2, gy)) * 10) / 10;
        if (!Terrain.walkable(key, gx, gy)) {
            this.showNetToast('⚠ 那里不能去（水面/出界）——换一个点');
            return;
        }
        apply(gx, gy);
    },

    giveHoldOrder(gx, gy) {
        const selected = this.scene?.selectedBattalion;
        if (!selected) return;
        const side = this.mySide || 'red';
        if (this.battleOptions.net && this.scene.net) {
            this.scene.net.lockstep.act({ k: 'hold', side, id: selected.id, gx, gy });
        } else {
            this.scene.applyNetCommand({ k: 'hold', side, id: selected.id, gx, gy });
        }
        Snd.play('lock');
        this.updateBattalionBar();
    },

    giveChargeOrder() {
        const selected = this.scene?.selectedBattalion;
        if (!selected || !this.scene) return;
        const now = this.scene.simulationTime;
        if (now < (selected.chargeReadyAt || 0)) return;
        const hasCavalry = selected.aliveMembers().some(u => u.type === 'cavalry');
        if (!hasCavalry) { this.showNetToast('本营没有骑兵——把骑兵编进来再冲锋'); return; }
        const side = this.mySide || 'red';
        if (this.battleOptions.net && this.scene.net) {
            this.scene.net.lockstep.act({ k: 'charge', side, id: selected.id });
        } else {
            this.scene.applyNetCommand({ k: 'charge', side, id: selected.id });
        }
        Snd.play('go');
        this.updateBattalionBar();
    },

    myBattalions() {
        const side = this.mySide || 'red';
        return (this.scene?.battalions?.battalions || []).filter(b => b.team === side && b.members.length);
    },

    selectBattalionByIndex(index) {
        const list = this.myBattalions();
        if (!list.length) return;
        this.scene.selectedBattalion = list[Math.max(0, Math.min(list.length - 1, index))];
        Snd.play('tick');
        this.updateBattalionBar();
    },

    toggleStance() {
        const selected = this.scene?.selectedBattalion;
        if (!selected || selected.team !== (this.mySide || 'red')) return;
        const side = this.mySide || 'red';
        const stance = selected.stance === 'aggressive' ? 'steady' : 'aggressive';
        if (this.battleOptions.net && this.scene.net) {
            this.scene.net.lockstep.act({ k: 'stance', side, id: selected.id, stance });
        } else {
            this.scene.applyNetCommand({ k: 'stance', side, id: selected.id, stance });
        }
        Snd.play('tick');
        this.updateBattalionBar();
    },

    giveClearOrder() {
        const selected = this.scene?.selectedBattalion;
        if (!selected || selected.team !== (this.mySide || 'red')) return;
        const side = this.mySide || 'red';
        if (this.battleOptions.net && this.scene.net) {
            this.scene.net.lockstep.act({ k: 'clear', side, id: selected.id });
        } else {
            this.scene.applyNetCommand({ k: 'clear', side, id: selected.id });
        }
        Snd.play('tick');
        this.updateBattalionBar();
    },

    beginRallyTargeting() {
        this.campControls?.cancel();
        if (this.phase !== 'battle' || !this.battleOptions.territory || !this.scene?.territory) return;
        this.rallyTargeting = true;
        document.body.classList.add('targeting');
        this.showNetToast('📍 点击地图设置本方集结点——新兵与集结营将在此聚兵（Esc 取消）');
    },

    cancelRallyTargeting() {
        this.rallyTargeting = false;
        document.body.classList.remove('targeting');
        const cue = document.getElementById('morale-cue');
        if (cue) cue.hidden = true;
    },

    giveRallyOrder(gx, gy) {
        const side = this.mySide || 'red';
        if (this.battleOptions.net && this.scene.net) {
            this.scene.net.lockstep.act({ k: 'rally', side, gx, gy });
        } else {
            this.scene.applyNetCommand({ k: 'rally', side, gx, gy });
        }
        Snd.play('lock');
    },

    selectNextBattalion() {
        const list = this.myBattalions();
        if (!list.length) return;
        const current = this.scene.selectedBattalion;
        const index = list.indexOf(current);
        this.scene.selectedBattalion = list[(index + 1) % list.length];
        Snd.play('tick');
        this.updateBattalionBar();
    },

    // 下营令：联机进命令队列，单机直接执行
    giveBattalionOrder(order) {
        const selected = this.scene?.selectedBattalion;
        if (!selected) return;
        const side = this.mySide || 'red';
        if (this.battleOptions.net && this.scene.net) {
            this.scene.net.lockstep.act({ k: 'order', side, id: selected.id, flag: order });
        } else {
            this.scene.applyNetCommand({ k: 'order', side, id: selected.id, flag: order });
        }
        Snd.play('lock');
        this.updateBattalionBar();
    },

    updateBattalionBar() {
        this.campControls?.update();
        const bar = document.getElementById('battalion-bar');
        const selected = this.phase === 'battle' && this.battleOptions.territory ? this.scene?.selectedBattalion : null;
        bar.hidden = !(this.phase === 'battle' && this.battleOptions.territory);
        if (!selected) { this.renderBattalionPicker(); return; }   // 未选营：常驻营队选择条（入口可发现）
        if (!document.querySelector('#order-hold')) this.buildBattalionBar();   // 以驻守按钮为准（营选择 chip 同类名会误判）
        const flags = this.scene.flags || [];
        const own = selected.team === (this.mySide || 'red');
        const now = this.scene.simulationTime || 0;
        const state = selected.gathering ? '集结中'
            : now < (selected.chargeUntil || 0) ? '⚡ 冲锋中'
            : selected.retreat ? '回防'
            : selected.orderPoint ? '📍 驻守'
            : selected.orderFlag != null && flags[selected.orderFlag] ? '目标 · ' + flags[selected.orderFlag].name
            : '自主作战';
        document.getElementById('battalion-label').textContent =
            (own ? '🔴' : '🔵') + `${selected.id}营 · ${selected.aliveMembers().length}人 · ${state}` + (own ? '' : ' · 敌营不可指挥');
        document.querySelectorAll('#battalion-orders .order-btn').forEach(btn => {
            btn.disabled = !own;
            if (btn.dataset.flagOrder != null) {
                const flag = flags[Number(btn.dataset.flagOrder)];
                const dot = btn.querySelector('.ob-dot');
                const ownerColor = flag?.owner === 'red' ? '#ff5b5b' : flag?.owner === 'blue' ? '#57a0ff' : '#d8d2c0';
                if (dot) dot.style.background = ownerColor;
                btn.classList.toggle('active', own && selected.orderFlag === Number(btn.dataset.flagOrder));
            } else if (btn.dataset.orderHome !== undefined) {
                btn.classList.toggle('active', own && selected.retreat);
            } else if (btn.id === 'order-hold') {
                btn.disabled = !own || this.holdTargeting;
                btn.classList.toggle('active', this.holdTargeting);
            } else if (btn.id === 'order-stance') {
                btn.disabled = !own;
                const aggressive = selected.stance === 'aggressive';
                btn.textContent = aggressive ? '🔥 好战' : '🛡 稳健';
                btn.classList.toggle('active', aggressive);
            } else if (btn.id === 'order-clear') {
                btn.disabled = !own || !(selected.orderFlag != null || selected.orderPoint || selected.retreat);
            } else if (btn.id === 'order-charge') {
                const hasCavalry = own && selected.aliveMembers().some(u => u.type === 'cavalry');
                const cooldown = Math.max(0, (selected.chargeReadyAt || 0) - now);
                btn.disabled = !hasCavalry || cooldown > 0;
                btn.textContent = cooldown > 0 ? `⚡ ${(cooldown / 1000).toFixed(1)}s` : '⚡ 冲锋！';
                btn.classList.toggle('active', now < (selected.chargeUntil || 0));
            }
        });
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
        document.getElementById('btn-continue').onclick = () => { this.resumeLast(); Snd.play('tick'); };
        document.getElementById('btn-sandbox').onclick = () => this.resetAll();
        document.getElementById('btn-terrain').onclick = () => this.startTerrain();
        document.querySelectorAll('[data-terrain-entry]').forEach(button => {
            button.onclick = () => this.startTerrain(button.dataset.terrainEntry);
        });
        document.querySelectorAll('[data-control-entry]').forEach(button => {
            button.onclick = () => { this.startControl(); Snd.play('tick'); };
        });
        document.querySelectorAll('[data-convoy-entry]').forEach(button => {
            button.onclick = () => { this.startConvoy(); Snd.play('tick'); };
        });
        document.querySelectorAll('[data-control-custom]').forEach(button => {
            button.onclick = () => { this.startControlCustom(); Snd.play('tick'); };
        });
        document.querySelectorAll('[data-convoy-custom]').forEach(button => {
            button.onclick = () => { this.startConvoyCustom(); Snd.play('tick'); };
        });
        document.querySelectorAll('[data-territory-entry]').forEach(button => {
            button.onclick = () => { this.startTerritory(); Snd.play('tick'); };
        });
        document.querySelectorAll('[data-net-entry]').forEach(button => {
            button.onclick = () => { this.openNetLobby(); Snd.play('tick'); };
        });
        document.getElementById('btn-net-create').onclick = () => this.netCreate();
        document.getElementById('btn-net-join').onclick = () => this.netJoin();
        document.getElementById('btn-net-ready').onclick = () => this.netReady();
        document.getElementById('btn-net-quit').onclick = () => this.netQuit();
        document.getElementById('btn-rally').onclick = () => this.beginRallyTargeting();
        document.getElementById('net-code-input').addEventListener('keydown', e => {
            if (e.key === 'Enter') this.netJoin();
        });
        window.addEventListener('beforeunload', () => this.net.client?.bye());
        window.addEventListener('keydown', e => {
            if (this.phase !== 'battle' || !this.battleOptions.territory) return;
            if (e.key === 'Escape') { this.cancelHoldTargeting(); this.cancelRallyTargeting(); this.campControls?.cancel(); return; }
            if (e.key === 'r' || e.key === 'R') { this.beginRallyTargeting(); return; }
            if (e.key === 'Tab') { e.preventDefault(); this.selectNextBattalion(); return; }
            const digit = Number(e.key);
            if (Number.isInteger(digit) && digit >= 1 && digit <= 9) this.selectBattalionByIndex(digit - 1);
        });
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
        // 战斗信息面板折叠：隐藏 .hud-info 信息行只留操作件，战场视野让位（状态留在 DOM，不跨局记忆）
        document.getElementById('btn-hud-collapse').onclick = () => {
            const bar = document.getElementById('controlbar');
            const collapsed = bar.classList.toggle('collapsed');
            document.getElementById('btn-hud-collapse').textContent = collapsed ? '⌄ 展开信息' : '⌃ 收起信息';
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

// game.js 在模块加载序上先于本文件，但它只在运行时（战斗结束/音效）引用 UI/Snd——
// 挂到全局对象完成对接；node 测试环境无 window，跳过。
export { Snd };

if (typeof window !== 'undefined') {
    window.UI = UI;
    window.Snd = Snd;
}

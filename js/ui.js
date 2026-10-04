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
import { traitOf } from './battle/site-traits.js';
import { flagSiteSignature, traitSiteRow } from './render/overlay.js';
import { ownsFlag, ownerDisplayCss } from './factions.js';

function textIfChanged(element, value) {
    if (element && element.textContent !== String(value)) element.textContent = String(value);
}

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

// ---------------- 据点特色：一次性提示文案 ----------------
// 名称 / 奖励 / 生效条件都读 js/battle/site-traits.js（模拟与文案同一份来源），
// 这里只补一句"玩家该做什么"，避免各处再抄一套数字或另写一套说法。
const SITE_TIP_ACTIONS = {
    forest: '占下它，',
    bridge: '占下它，',
    hill: '占下它，再给营队下「移动并驻守」，',
    ford: '占下任一渡口，',
    crossroad: '占下它，'
};
function siteTraitTip(role) {
    const trait = traitOf(role);
    if (!trait) return '';
    return `${trait.icon}${trait.name}：${SITE_TIP_ACTIONS[role] ?? ''}${trait.reward}。生效条件：${trait.condition}。`;
}

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
        scene.groundClick = (world, picked, markerBattalion) => this.onGroundClick(world, picked, markerBattalion);
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
        if (phase !== 'battle') {
            this.cancelTargeting();
            const tip = document.getElementById('territory-tip');
            if (tip) tip.hidden = true;
        }
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
        document.getElementById('btn-start').disabled = !this.scene || this.phase !== 'ready' || !!this.scene?.terrainLoading;
        document.getElementById('btn-start').textContent = this.scene?.terrainLoading ? '准备战场…' : fighting ? '两军交战中…' : '🚀 开战！';
        const ready = document.getElementById('btn-net-ready');
        if (ready) ready.disabled = !!this.scene?.terrainLoading || !!this.net?.myReady;
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
        this.cancelTargeting();
        this._pendingBuys = [];
        this._shownTraitEvents = 0;                 // 新局重新计数据点播报
        this._battalionSlots = null;                 // 新局营号从头编起，快捷键槽位一并清空
        clearTimeout(this._toastTimer);
        for (const id of ['action-toast', 'territory-tip']) {
            const element = document.getElementById(id);
            if (element) element.hidden = true;
        }
        this.campControls?.reset();
        this.stopHolds();
        this.countdown = false;
        this.pendingDeploy = this.pendingAutoplay = false;
        // 领土分区 HUD 收场：卸 body 态类并隐藏容器（updateTerritoryHUD 不会被被动调用）
        document.body?.classList?.remove('territory-battle');
        document.getElementById('territory-strip')?.setAttribute('hidden', '');
        document.getElementById('recruit-dock')?.setAttribute('hidden', '');
        // 营队条拆出大条后自管显隐：离场必须收起（旧布局由 #controlbar 整体隐藏掩蔽）
        document.getElementById('battalion-bar')?.setAttribute('hidden', '');
        if (this.scene) {
            this.scene.commandPreview = null;
            this.scene.clearUnits(this.scene.battleOptions?.terrain);
        }
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
    // 仅用于本地按钮反馈的待执行购买估算；真正扣费/出兵仍只由模拟执行。
    pendingRecruitOrders() {
        const lockstep = this.scene?.net?.lockstep;
        if (!this.battleOptions.net || !lockstep) return [];
        this._pendingBuys = (this._pendingBuys || []).filter(item => item.turn >= lockstep.execTurn);
        return this._pendingBuys;
    },

    recruitBlockReason(type) {
        if (this.phase !== 'battle' || this.countdown || !this.scene?.territory || this.scene.battleOver) return '等待开战';
        const mine = this.mySide || 'red';
        const { recruit, econ } = this.scene.territory;
        if (type === 'cavalry' && !(this.scene.flags || []).some(f => f.role === 'ranch' && ownsFlag(this.scene, mine, f))) return '需先占马场';
        const pending = this.pendingRecruitOrders();
        if (recruit.queues[mine].length + pending.length >= TERRITORY.QUEUE_CAP) return '训练队列已满';
        const reserved = pending.reduce((sum, item) => sum + UNIT_TYPES[item.type].cost * TERRITORY.COST_MULT, 0);
        if (econ.treasury[mine] - reserved < UNIT_TYPES[type].cost * TERRITORY.COST_MULT) return '军费不足';
        const queued = recruit.queues[mine].filter(item => item.type === type).length + pending.filter(item => item.type === type).length;
        if ((this.scene.aliveCount?.(mine, type) || 0) + queued >= UNIT_TYPES[type].maxCount) return '兵种人数已满';
        return '';
    },

    buyRecruit(type) {
        if (this.recruitBlockReason(type)) return false;
        const side = this.mySide || 'red';
        const lockstep = this.battleOptions.net && this.scene.net?.lockstep;
        if (lockstep) {
            // act 按原有顺序逐条排入同一回合，批处理只合并界面刷新。
            lockstep.act({ k: 'buy', side, type });
            (this._pendingBuys ??= []).push({ type, turn: lockstep.execTurn + lockstep.lookahead });
            return true;
        }
        return this.scene.territory.recruit.enqueue(side, type);
    },

    buildRecruitBar() {
        const bar = document.getElementById('recruit-bar');
        bar.replaceChildren();
        for (const [key, t] of Object.entries(UNIT_TYPES)) {
            if (t.hidden && !t.territoryOnly) continue;
            const cost = t.cost * TERRITORY.COST_MULT;
            const btn = document.createElement('button');
            btn.className = 'recruit-btn';
            btn.id = 'recruit-' + key;
            btn.innerHTML = `<span class="rc-icon">${t.icon}</span><span class="rc-name">${t.name}</span><span class="rc-cost">🪙${cost}</span><small class="rc-reason"></small>`;
            btn.addEventListener('pointerenter', () => { if (key === 'cavalry') this.showTerritoryTip('ranch'); });
            btn.addEventListener('focus', () => { if (key === 'cavalry') this.showTerritoryTip('ranch'); });
            this.bindHold(btn, () => this.buyRecruit(key), () => {
                Snd.play('buy');
                this.updateTerritoryHUD();
            });
            bar.appendChild(btn);
        }
    },

    updateTerritoryHUD() {
        const strip = document.getElementById('territory-strip');
        const dock = document.getElementById('recruit-dock');
        const active = this.phase === 'battle' && this.battleOptions.territory && this.scene?.territory;
        document.body?.classList?.toggle('territory-battle', active);
        if (strip) strip.hidden = !active;
        if (dock) dock.hidden = !active;
        // 战斗控制按钮（暂停/倍速/调整阵容）随布局迁移：领土进顶条，其它模式回大控制条。
        // DOM 原件搬移不加副本，按钮状态与事件绑定不丢。
        const ctl = document.getElementById('battle-ctl');
        if (ctl) {
            const host = active ? document.getElementById('territory-ctl') : document.getElementById('controlbar');
            if (host?.appendChild && ctl.parentElement !== host) host.appendChild(ctl);
        }
        if (!active) { this.campControls?.update(); return; }
        if (!document.getElementById('recruit-infantry')) this.buildRecruitBar();
        const territory = this.scene.territory;
        const mine = this.mySide || 'red';
        const owned = { red: 0, blue: 0 };
        // 归属按同盟共享：红蓝联军下盟友占下的据点同时计入双方（既有二元模式结果不变）。
        for (const flag of this.scene.flags || []) {
            if (ownsFlag(this.scene, 'red', flag)) owned.red++;
            if (ownsFlag(this.scene, 'blue', flag)) owned.blue++;
        }
        const readouts = {
            'territory-treasury': Math.floor(territory.econ.treasury[mine]),
            'territory-income': '+' + territory.econ.incomeRate(owned[mine]) + '/秒',
            'territory-tickets-red': Math.ceil(territory.tickets.tickets.red),
            'territory-tickets-blue': Math.ceil(territory.tickets.tickets.blue),
            'territory-flags-red': owned.red, 'territory-flags-blue': owned.blue,
            'territory-army-red': this.scene.redAlive, 'territory-army-blue': this.scene.blueAlive
        };
        for (const [id, value] of Object.entries(readouts)) textIfChanged(document.getElementById(id), value);
        const queue = territory.recruit.queues[mine];
        const pending = this.pendingRecruitOrders().length;
        const first = queue[0];
        const remaining = first ? Math.max(0, (first.readyAt - this.scene.simulationTime) / 1000) : 0;
        const queueText = first ? `${UNIT_TYPES[first.type].name} · ${remaining > 0 ? remaining.toFixed(1) + '秒' : '等待出营空位'} · 共${queue.length}人`
            : '训练队列空闲';
        textIfChanged(document.getElementById('territory-queue'), queueText + (pending ? ` · ${pending}道征兵令待执行` : ''));
        const enemy = mine === 'red' ? 'blue' : 'red';
        const difference = owned[mine] - owned[enemy];
        textIfChanged(document.getElementById('territory-ticket-status'), difference < 0
            ? `少控${-difference}处据点 · 我方持续失分` : difference > 0 ? `多控${difference}处据点 · 敌方持续失分` : '控点相同 · 暂无控点失分');
        const rallyBtn = document.getElementById('btn-rally');
        rallyBtn.classList.toggle('active', !!this.rallyTargeting);
        rallyBtn.hidden = !active;
        for (const [key, t] of Object.entries(UNIT_TYPES)) {
            if (t.hidden && !t.territoryOnly) continue;
            const btn = document.getElementById('recruit-' + key);
            if (!btn) continue;
            const reason = this.recruitBlockReason(key);
            btn.disabled = !!reason;
            btn.title = reason ? `${t.name}：${reason}${key === 'cavalry' ? '（地图北上翼）' : ''}` : t.tip + ` · 训练 ${TERRITORY.TRAIN_MS[key] / 1000} 秒 · 可长按连续征兵`;
            textIfChanged(btn.querySelector('.rc-reason'), reason || `训练 ${TERRITORY.TRAIN_MS[key] / 1000}秒`);
            btn.classList.toggle('ranch-locked', reason === '需先占马场');
        }
        this.updateBattalionBar();
        this.maybeShowTerritoryTips();
        this.pollSiteTraitEvents();
    },

    // 首次相关选择时才提示；操作提示、教程、战况通知各有自己的区域。
    // 每种只讲一次，返回值告诉调用方"这次是不是刚讲过"。
    showTerritoryTip(kind) {
        this._seenTerritoryTips ??= new Set();
        if (this._seenTerritoryTips.has(kind) || this.phase !== 'battle' || !this.battleOptions.territory) return false;
        const tips = {
            worker: '建设：选择民夫 → 筑营寨 → 点己方据点。民夫到场施工，记得派兵护卫。',
            archer: '弓手可驻塔：点「建筑行动」→ 驻入箭塔 → 选择己方完工箭塔。',
            medic: '医师可驻帐：点「建筑行动」→ 驻入医帐，帮助溃兵疗伤归队。',
            ranch: '骑兵需要马场。北上翼有两座马场，先派一营夺下其中一座。',
            command: '夺旗后营队恢复自主作战。要守住桥头或据点，请用「移动并驻守」。',
            hill: siteTraitTip('hill'),
            ford: siteTraitTip('ford'),
            crossroad: siteTraitTip('crossroad'),
            bridge: siteTraitTip('bridge'),
            forest: siteTraitTip('forest')
        };
        const panel = document.getElementById('territory-tip');
        if (!panel || !tips[kind]) return false;
        this._seenTerritoryTips.add(kind);
        textIfChanged(document.getElementById('territory-tip-text'), tips[kind]);
        panel.hidden = false;
        return true;
    },

    maybeShowTerritoryTips() {
        if (this.holdTargeting || this.rallyTargeting || this.campControls?.targeting) return;
        const selected = this.scene?.selectedBattalion;
        if (selected?.team !== (this.mySide || 'red')) return;
        const members = selected.aliveMembers();
        const basic = members.some(u => u.type === 'archer') ? 'archer'
            : members.some(u => u.type === 'medic') ? 'medic' : 'command';
        if (this.showTerritoryTip(basic)) return;    // 基础操作先讲一次
        this.showSiteTraitTip(selected);             // 再讲正在打交道的据点特色
    },

    // 选中营与特色据点相关时讲一次：先看这个营正在夺的据点，
    // 没有明确目标时才看被争夺的己方特色据点（一次只讲一个，不连播）。
    showSiteTraitTip(battalion) {
        const flags = this.scene?.flags || [];
        const mine = this.mySide || 'red';
        const seen = this._seenTerritoryTips;
        const target = battalion.orderFlag != null ? flags[battalion.orderFlag] : null;
        const flag = target?.role ? target : flags.find(candidate => ownsFlag(this.scene, mine, candidate) && candidate.contested);
        if (!flag?.role || seen?.has(flag.role)) return false;
        return this.showTerritoryTip(flag.role);
    },

    // 据点特色播报：只认"新出现的"占领/易主事件，游标按事件条数推进（与时间无关），
    // 所以每条只播一次，也不会因为界面刷新频率而重复播报。
    pollSiteTraitEvents() {
        const events = this.scene?.ledger?.events;
        if (!events?.length) { this._shownTraitEvents = 0; return; }
        if (!(this._shownTraitEvents >= 0) || this._shownTraitEvents > events.length) this._shownTraitEvents = 0;
        const inBattle = this.phase === 'battle';
        for (let i = this._shownTraitEvents; i < events.length; i++) {
            const event = events[i];
            if (!inBattle) continue;                       // 非战斗阶段只推进游标，不打扰
            if (/^(trait|ranch)-/.test(event?.key ?? '')) this.showNetToast(event.text);
        }
        this._shownTraitEvents = events.length;
    },

    // ---------------- 营队指挥条：选中营后出现，点旗下令/回防 ----------------
    // 兵种组成只读自营数据（公共 API aliveMembers + UNIT_TYPES 名称），展示序沿用 UNIT_TYPES 键序。
    battalionComposition(battalion) {
        if (!battalion?.aliveMembers) return '';
        const counts = new Map();
        for (const unit of battalion.aliveMembers()) {
            if (unit.dead || unit.withdrawn) continue;
            counts.set(unit.type, (counts.get(unit.type) || 0) + 1);
        }
        const parts = [];
        for (const [type, info] of Object.entries(UNIT_TYPES)) {
            const count = counts.get(type);
            if (count) parts.push(`${info.name}${count}`);
        }
        return parts.join('／');
    },

    // 稳定快捷键槽位：营亡解散释放槽位、新营领最低空槽，幸存营键号不漂移。
    // 数字键与营卡显示共用这份映射，卡片上标的 [N] 就是真实的按键。
    battalionSlots() {
        const list = this.myBattalions();
        const slots = this._battalionSlots ?? (this._battalionSlots = new Map());
        for (const id of [...slots.keys()]) {
            if (!list.some(b => b.id === id)) slots.delete(id);
        }
        const used = new Set(slots.values());
        for (const battalion of list) {
            if (slots.has(battalion.id) || used.size >= 9) continue;
            let slot = 1;
            while (used.has(slot)) slot++;
            slots.set(battalion.id, slot);
            used.add(slot);
        }
        return slots;
    },

    renderBattalionPicker() {
        const row = document.getElementById('battalion-picker');
        if (!row) return;
        const label = document.getElementById('battalion-label');
        const list = this.myBattalions();
        const slots = this.battalionSlots();
        if (!this.scene?.selectedBattalion) label.textContent = '选择营队下令 · 数字键 1–9 / Tab 切换';
        if (row.querySelector('.battalion-chip') && row.childElementCount === list.length &&
            [...row.children].every((chip, i) => chip.dataset.bid === String(list[i]?.id) &&
                chip.dataset.slot === String(slots.get(list[i]?.id) ?? ''))) {
            // 只刷新数字，不重建（保持点击稳定）
            [...row.children].forEach((chip, i) => {
                const b = list[i];
                const state = b.gathering ? '集结中' : b.retreat ? '回防' : b.orderPoint ? '驻守'
                    : b.orderFlag != null ? '进军' : '作战';
                textIfChanged(chip.querySelector('.bc-count'),
                    `${this.battalionComposition(b)} · ${b.aliveMembers().length}人 · ${state}`);
                chip.classList.toggle('active', this.scene.selectedBattalion === b);
                chip.setAttribute('aria-pressed', String(this.scene.selectedBattalion === b));
            });
            return;
        }
        // 重建分支：replaceChildren 清空内容会把横向滚动位置夹回 0——用户滚到右侧
        // 看 4-6 号营卡时，一次营亡/新营重建不应把视口拽回左端（F12 顺带加固）。
        const keepScroll = row.scrollLeft;
        row.replaceChildren();
        for (const battalion of list) {
            const slot = slots.get(battalion.id);
            const chip = document.createElement('button');
            chip.className = 'order-btn battalion-chip';
            chip.dataset.bid = String(battalion.id);
            chip.dataset.slot = String(slot ?? '');
            const state = battalion.gathering ? '集结中' : battalion.retreat ? '回防' : battalion.orderPoint ? '驻守'
                : battalion.orderFlag != null ? '进军' : '作战';
            chip.innerHTML = `<b>${slot ? `[${slot}] ` : ''}${battalion.id}营</b> ` +
                `<span class="bc-count">${this.battalionComposition(battalion)} · ${battalion.aliveMembers().length}人 · ${state}</span>`;
            chip.classList.toggle('active', this.scene.selectedBattalion === battalion);
            chip.setAttribute('aria-pressed', String(this.scene.selectedBattalion === battalion));
            // 按确定营ID选中：列表增删后不因索引漂移选错营。
            chip.onclick = () => this.selectBattalionById(battalion.id);
            row.appendChild(chip);
        }
        row.scrollLeft = keepScroll;   // 浏览器按新内容宽度自动夹紧
    },

    buildBattalionBar() {
        const row = document.getElementById('battalion-orders');
        row.replaceChildren();
        const flagRow = document.getElementById('battalion-flags');
        flagRow.replaceChildren();
        const flags = this.scene?.flags || [];
        flags.forEach((flag, index) => {
            const btn = document.createElement('button');
            btn.className = 'order-btn';
            btn.dataset.flagOrder = index;
            const dot = document.createElement('span');
            dot.className = 'ob-dot';
            const label = document.createElement('span');
            label.className = 'of-text';    // 折行样式在 css/style.css 的 #battalion-flags 规则里
            btn.appendChild(dot);
            btn.appendChild(label);
            const info = traitSiteRow(this.scene, flag);
            textIfChanged(label, info.text);
            btn.title = info.title;
            btn.siteSig = info.sig;                 // 归属/角色没变就不再动 DOM
            btn.onclick = () => { this.giveBattalionOrder(index); };
            flagRow.appendChild(btn);
        });
        const home = document.createElement('button');
        home.className = 'order-btn';
        home.dataset.orderHome = '';
        home.textContent = '🏠 回防集结';
        home.title = '回到大本营集结：补充新兵、重整败兵；大本营是老家，没有据点特色加成';
        home.onclick = () => { this.giveBattalionOrder('home'); };
        row.appendChild(home);
        const hold = document.createElement('button');
        hold.className = 'order-btn';
        hold.id = 'order-hold';
        hold.textContent = '📍 移动并驻守';
        hold.title = '点击后到地图上选一个点，全营开过去驻守（桥头/林缘/高地均可设防）';
        hold.onclick = () => this.beginHoldTargeting();
        row.appendChild(hold);
        // 手动冲锋按钮已移除：骑兵接敌自动助跑冲锋（U1）。这里只读真实状态，
        // 不再提供需要玩家反复点击的冲锋入口；net 'charge' 兼容路径归模拟侧。
        const chargeNote = document.createElement('span');
        chargeNote.className = 'order-note';
        chargeNote.id = 'order-charge-note';
        chargeNote.title = '骑兵接敌后自动助跑冲锋，无需手动下令';
        row.appendChild(chargeNote);
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
        clearBtn.textContent = '自主作战';
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
        const locate = document.createElement('button');
        locate.className = 'order-btn';
        locate.id = 'order-locate';
        locate.textContent = '定位本营';
        locate.title = '镜头定位所选营（F）';
        locate.onclick = () => this.locateSelectedBattalion();
        row.appendChild(locate);
        const building = document.createElement('button');
        building.className = 'order-btn';
        building.id = 'order-building';
        building.textContent = '建筑行动';
        building.title = '驻入箭塔 / 医帐，或攻击敌方建筑';
        building.onclick = () => { this.campControls.pinned = true; this.campControls.update(); };
        row.appendChild(building);
        const deselect = document.createElement('button');
        deselect.className = 'order-btn';
        deselect.id = 'order-deselect';
        deselect.textContent = '取消选择';
        deselect.title = '取消选择';
        deselect.onclick = () => {
            this.cancelTargeting();
            this.scene?.selectBattalionByUnit(null);
            if (this.scene?.unitInspector) this.scene.unitInspector.selected = null;
            this.updateBattalionBar();
        };
        row.appendChild(deselect);
    },

    // ---------------- 驻守目标模式 / 冲锋令 / 快捷选营 ----------------
    beginHoldTargeting() {
        const selected = this.scene?.selectedBattalion;
        if (this.phase !== 'battle' || this.countdown || !selected || selected.team !== (this.mySide || 'red')) return;
        this.cancelTargeting();
        this.holdTargeting = selected;
        this.updateTargetingPrompt();
        this.updateBattalionBar();
    },

    cancelHoldTargeting() {
        this.holdTargeting = null;
        this.updateTargetingPrompt();
    },

    cancelTargeting() {
        this.holdTargeting = null;
        this.rallyTargeting = false;
        this.campControls?.cancel();
        this.updateTargetingPrompt();
    },

    updateTargetingPrompt() {
        const prompt = this.campControls?.targeting?.prompt || (this.holdTargeting
            ? `${this.holdTargeting.id}营 · 点地图选择移动并驻守的位置`
            : this.rallyTargeting ? '点地图设置集结点 · 新兵与集结营将在此聚兵' : '');
        document.body.classList.toggle('targeting', !!(this.holdTargeting || this.rallyTargeting));
        document.getElementById('btn-rally')?.classList.toggle('active', !!this.rallyTargeting);
        const panel = document.getElementById('command-prompt');
        if (panel) panel.hidden = !prompt;
        textIfChanged(document.getElementById('command-prompt-text'), prompt);
        const tip = document.getElementById('territory-tip');
        if (prompt && tip) tip.hidden = true;
    },

    // 返回 true 表示该次点击已用于命令/建筑，观察层必须保留原选择。
    // markerBattalion：观察层透传的营旗命中（普通态拾取优先的判据之一，F2）。
    onGroundClick(world, picked, markerBattalion) {
        // 普通态（未开任何选点/下令模式）：营旗与部队画在建筑之上，是玩家看到的可点目标——
        // 拾取命中优先选营/选兵，不被脚下建筑吞掉；己方民夫仍交建设面板选择。
        // 驻守/集结/施工等选点模式保持命令优先消费（既有测试守护）。
        if (!this.campControls?.targeting && !this.holdTargeting && !this.rallyTargeting) {
            const unit = picked ?? null;
            const ownWorker = unit?.type === 'worker' && unit.team === (this.mySide || 'red');
            if (markerBattalion || (unit && !ownWorker)) {
                if (this.campControls) {
                    this.campControls.workerId = this.campControls.buildingId = null;
                    this.campControls.update();
                }
                return false;
            }
        }
        if (this.campControls?.handleGroundClick(world, picked)) return true;
        if (this.rallyTargeting) {
            this.applyGroundOrder(world, (gx, gy) => {
                this.giveRallyOrder(gx, gy);
                this.cancelRallyTargeting();
            });
            return true;
        }
        if (!this.holdTargeting) return false;
        const selected = this.holdTargeting;
        if (!selected.aliveMembers().length) { this.cancelHoldTargeting(); return true; }
        this.applyGroundOrder(world, (gx, gy) => {
            this.giveHoldOrder(gx, gy, selected);
            this.cancelHoldTargeting();
            this.updateBattalionBar();
        });
        return true;
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

    giveHoldOrder(gx, gy, selected = this.scene?.selectedBattalion) {
        if (!selected || selected.team !== (this.mySide || 'red')) return;
        this.scene.commandPreview = { kind: 'hold', gx, gy, battalionId: selected.id,
            at: performance.now(), durationMs: 900 };
        const side = this.mySide || 'red';
        if (this.battleOptions.net && this.scene.net) {
            this.scene.net.lockstep.act({ k: 'hold', side, id: selected.id, gx, gy });
        } else {
            this.scene.applyNetCommand({ k: 'hold', side, id: selected.id, gx, gy });
        }
        Snd.play('lock');
        this.showNetToast(`${selected.id}营 · ${this.battleOptions.net ? '驻守令已接收，等待执行' : '正在前往驻守位置'}`);
    },

    myBattalions() {
        const side = this.mySide || 'red';
        return (this.scene?.battalions?.battalions || []).filter(b => b.team === side && b.members.length);
    },

    // 营选择统一入口：数字键、营卡点击、Tab 循环都走这里，互不漂移。
    applyBattalionSelection(battalion) {
        if (!battalion) return;
        this.cancelTargeting();
        this.scene.selectedBattalion = battalion;
        if (this.scene.unitInspector) this.scene.unitInspector.selected = battalion.aliveMembers()[0] || null;
        if (this.campControls) this.campControls.workerId = this.campControls.buildingId = null;
        Snd.play('tick');
        this.updateBattalionBar();
    },

    // 按确定营ID选中：营卡点击入口，列表增删后不因索引漂移选错营。
    selectBattalionById(id) {
        this.applyBattalionSelection(this.myBattalions().find(b => b.id === id));
    },

    // 数字键按营卡显示的真实快捷键选营：槽位空缺时不改变当前选择。
    selectBattalionSlot(slot) {
        const slots = this.battalionSlots();
        this.applyBattalionSelection(this.myBattalions().find(b => slots.get(b.id) === slot));
    },

    selectBattalionByIndex(index) {
        const list = this.myBattalions();
        if (!list.length) return;
        this.applyBattalionSelection(list[Math.max(0, Math.min(list.length - 1, index))]);
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
        this.cancelTargeting();
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
        if (this.phase !== 'battle' || this.countdown || !this.battleOptions.territory || !this.scene?.territory) return;
        this.cancelTargeting();
        this.rallyTargeting = true;
        this.updateTargetingPrompt();
    },

    cancelRallyTargeting() {
        this.rallyTargeting = false;
        this.updateTargetingPrompt();
    },

    giveRallyOrder(gx, gy) {
        this.scene.commandPreview = { kind: 'rally', gx, gy, at: performance.now(), durationMs: 900 };
        const side = this.mySide || 'red';
        if (this.battleOptions.net && this.scene.net) {
            this.scene.net.lockstep.act({ k: 'rally', side, gx, gy });
        } else {
            this.scene.applyNetCommand({ k: 'rally', side, gx, gy });
        }
        Snd.play('lock');
        this.showNetToast(this.battleOptions.net ? '集结令已接收，等待执行' : '集结点已更新');
    },

    selectNextBattalion() {
        const list = this.myBattalions();
        if (!list.length) return;
        const current = this.scene.selectedBattalion;
        const index = list.indexOf(current);
        this.selectBattalionByIndex((index + 1) % list.length);
    },

    locateSelectedBattalion() {
        const selected = this.scene?.selectedBattalion;
        if (!selected?.aliveMembers().length) return;
        const center = selected.center();
        const point = this.scene.groundPoint(center.gx ?? center.x, center.gy ?? center.y);
        this.scene.cameras.main.centerOn(point.x, point.y);
    },

    // 下营令：联机进命令队列，单机直接执行
    giveBattalionOrder(order) {
        const selected = this.scene?.selectedBattalion;
        if (!selected || selected.team !== (this.mySide || 'red')) return;
        this.cancelTargeting();
        const side = this.mySide || 'red';
        if (this.battleOptions.net && this.scene.net) {
            this.scene.net.lockstep.act({ k: 'order', side, id: selected.id, flag: order });
        } else {
            this.scene.applyNetCommand({ k: 'order', side, id: selected.id, flag: order });
        }
        Snd.play('lock');
        this.showNetToast(`${selected.id}营 · ${order === 'home' ? '回防令已接收' : '夺旗令已接收，夺旗后恢复自主作战'}`);
        this.updateBattalionBar();
    },

    updateBattalionBar() {
        this.campControls?.update();
        const bar = document.getElementById('battalion-bar');
        const selected = this.phase === 'battle' && this.battleOptions.territory ? this.scene?.selectedBattalion : null;
        bar.hidden = !(this.phase === 'battle' && this.battleOptions.territory);
        if (bar.hidden) return;
        this.renderBattalionPicker();
        document.getElementById('battalion-orders').hidden = !selected;
        document.getElementById('battalion-targets').hidden = !selected;
        if (!selected) return;   // 未选营：常驻营队选择条（入口可发现）
        if (!document.querySelector('#order-hold')) this.buildBattalionBar();   // 以驻守按钮为准（营选择 chip 同类名会误判）
        const flags = this.scene.flags || [];
        const own = selected.team === (this.mySide || 'red');
        const state = selected.gathering ? '集结中'
            : selected.retreat ? '回防'
            : selected.orderPoint ? '📍 驻守'
            : selected.orderFlag != null && flags[selected.orderFlag] ? '目标 · ' + flags[selected.orderFlag].name
            : '自主作战';
        document.getElementById('battalion-label').textContent =
            (selected.team === 'red' ? '🔴' : '🔵') + `${selected.id}营 · ${selected.aliveMembers().length}人 · ${state}` + (own ? '' : ' · 敌营不可指挥');
        document.querySelectorAll('#battalion-orders .order-btn, #battalion-flags .order-btn').forEach(btn => {
            btn.disabled = !own && !['order-next', 'order-deselect', 'order-locate'].includes(btn.id);
            if (btn.dataset.flagOrder != null) {
                const flag = flags[Number(btn.dataset.flagOrder)];
                const sig = flagSiteSignature(flag);
                if (btn.siteSig !== sig) {                    // 只在归属/角色变化时改文字
                    const info = traitSiteRow(this.scene, flag);
                    btn.siteSig = sig;
                    textIfChanged(btn.querySelector('.of-text'), info.text);
                    btn.title = info.title;
                }
                const dot = btn.querySelector('.ob-dot');
                const ownerColor = flag?.owner == null ? '#d8d2c0' : (ownerDisplayCss(this.scene, flag.owner) || '#d8d2c0');
                if (dot) dot.style.background = ownerColor;
                btn.classList.toggle('active', own && selected.orderFlag === Number(btn.dataset.flagOrder));
            } else if (btn.dataset.orderHome !== undefined) {
                btn.classList.toggle('active', own && selected.retreat);
            } else if (btn.id === 'order-hold') {
                btn.disabled = !own || !!this.holdTargeting;
                btn.classList.toggle('active', !!this.holdTargeting);
            } else if (btn.id === 'order-stance') {
                btn.disabled = !own;
                const aggressive = selected.stance === 'aggressive';
                btn.textContent = aggressive ? '🔥 好战' : '🛡 稳健';
                btn.classList.toggle('active', aggressive);
            } else if (btn.id === 'order-clear') {
                btn.disabled = !own || !(selected.orderFlag != null || selected.orderPoint || selected.retreat);
            }
        });
        // 自动冲锋真实读数（只读模拟字段）：有骑营显示状态，无骑营不占位。
        // 助跑 ≥3 格即视为冲击中（与骑兵"助跑3格双倍冲锋"规则同口径）。
        const chargeNote = document.getElementById('order-charge-note');
        if (chargeNote) {
            const riders = own ? selected.aliveMembers().filter(u => u.type === 'cavalry') : [];
            const charging = riders.filter(u => (u.chargeDistance ?? 0) >= 3).length;
            textIfChanged(chargeNote, riders.length
                ? (charging ? `⚡ 自动冲锋 · ${charging}骑冲击中` : '⚡ 骑兵自动冲锋') : '');
            chargeNote.hidden = !riders.length;
        }
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
        document.getElementById('btn-net-coop').onclick = () => this.netCreateCoop();
        document.getElementById('btn-net-join').onclick = () => this.netJoin();
        document.getElementById('btn-net-ready').onclick = () => this.netReady();
        document.getElementById('btn-net-quit').onclick = () => this.netQuit();
        document.getElementById('btn-rally').onclick = () => this.beginRallyTargeting();
        document.getElementById('btn-cancel-command').onclick = () => { this.cancelTargeting(); this.updateBattalionBar(); };
        document.getElementById('btn-dismiss-tip').onclick = () => { document.getElementById('territory-tip').hidden = true; };
        document.getElementById('net-code-input').addEventListener('keydown', e => {
            if (e.key === 'Enter') this.netJoin();
        });
        window.addEventListener('beforeunload', () => this.net.client?.bye());
        window.addEventListener('keydown', e => {
            if (this.phase !== 'battle' || e.repeat || e.altKey || e.ctrlKey || e.metaKey ||
                e.target?.isContentEditable || e.target?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
            if (e.code === 'Space' || e.key === ' ') {
                // 保留焦点按钮、链接和展开控件原生的空格操作。
                if (e.target?.closest?.('button, a, [role="button"], summary, [contenteditable]')) return;
                e.preventDefault();
                if (!this.battleOptions.net && !this.countdown && this.scene) {
                    this.scene.togglePause(); this.syncControls();
                }
                return;
            }
            if (!this.battleOptions.territory) return;
            if (e.key === 'Escape') { this.cancelTargeting(); this.updateBattalionBar(); return; }
            if (e.key === 'f' || e.key === 'F') { this.locateSelectedBattalion(); return; }
            if (e.key === 'r' || e.key === 'R') { this.beginRallyTargeting(); return; }
            if (e.key === 'Tab') { e.preventDefault(); this.selectNextBattalion(); return; }
            const digit = Number(e.key);
            // 数字键按营卡标注的真实快捷键（稳定槽位）选营，而非列表位置。
            if (Number.isInteger(digit) && digit >= 1 && digit <= 9) this.selectBattalionSlot(digit);
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
            if (this.phase !== 'battle' || this.countdown || !this.scene || this.battleOptions.net) return;
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

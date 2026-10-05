// ==================== 局域网对战：房间流程（并入 UI，this 即 UI） ====================
import { TERRITORY, makeTerritoryFlags } from './battle/economy.js';
import { board, setBoardSize } from './board.js';
import { CHALLENGES, armyCost, fitArmyToBudget } from './challenges.js';
import { ArenaClient } from './net/arena-client.js';
import { NetBattle } from './net/lockstep.js';
import { Terrain } from './terrain.js';
import { UNIT_TYPES, FORMATIONS, BUDGET } from './units.js';

import { Snd } from './snd.js';
import { UI_TACTIC_OPTIONS, UI_CAVALRY_OPTIONS, PRESETS } from './ui.js';

export const lobbyMethods = {
    // ---------------- 局域网对战：房间流程 ----------------
    openNetLobby() {
        this.clearBattle();
        this.setPhase('home');
        this.setStep(0);
        this.showSection('net');
        document.getElementById('net-lobby').hidden = true;
        document.getElementById('net-join-step').hidden = false;
        this.netStatus('正在连接对战服务器…');
        if (!this.net.client) {
            this.net.client = new ArenaClient(message => this.onNetMessage(message));
        }
        if (!this.net.client.connected) {
            this.net.serverIdentity = null;
            this.net.client.connect()
                .then(() => this.updateNetConnectionStatus())
                .catch(() => this.netStatus('连不上对战服务器——请先在房主电脑运行 npm run arena（并确认本页来自对战服务器地址 :5300）。'));
        } else this.updateNetConnectionStatus();
    },

    netStatus(text) { document.getElementById('net-status').textContent = text; },

    updateNetConnectionStatus() {
        if (this.net.code || this.net.inBattle || this.phase === 'battle') return;
        const identity = Object.hasOwn(this.net, 'serverIdentity')
            ? this.net.serverIdentity : this.net.client?.isArena ? true : null;
        this.netStatus(identity === true
            ? '已连接对战服务器。创建房间，或输入房间码加入。'
            : identity === false
                ? '已连接，但对方不是对战服务器（若是 vite 开发页请改用 arena 地址 :5300）。'
                : '已建立连接，正在确认对战服务器…');
    },

    // 发房间请求并带超时守望：没连上/连的不是对战服务器/服务器不应答，都给出明确提示
    netRequest(action, label) {
        const client = this.net.client;
        if (!client?.connected) {
            this.netStatus('⚠ 尚未连上对战服务器——请确认页面地址是 npm run arena 打印的那个（通常端口 5300），刷新后重试。');
            return;
        }
        if (!client.isArena) {
            this.netStatus(this.net.serverIdentity === false
                ? '⚠ 当前页面连的不是对战服务器（可能开着 vite 开发页 5301）。请改用房主 arena 地址后再试。'
                : '正在确认对战服务器，请稍后再创建或加入房间。');
            return;
        }
        this.netStatus(label + '…');
        action();
        clearTimeout(this.net.expectTimer);
        this.net.expectTimer = setTimeout(() => {
            if (!this.net.code) this.netStatus('⚠ 服务器没有响应' + label + '——请确认两端打开的都是对战服务器地址，或重启 npm run arena。');
        }, 4000);
    },

    netCreate() {
        this.netRequest(() => this.net.client.createRoom(), '正在创建房间');
    },

    netJoin() {
        const code = document.getElementById('net-code-input').value.trim().toUpperCase();
        if (code.length !== 4) { this.netStatus('请输入 4 位房间码。'); return; }
        this.netRequest(() => this.net.client.joinRoom(code), '正在加入房间 ' + code);
    },

    netReady() {
        if (this.scene?.terrainLoading) return;
        if (!this.net.client?.connected) return;
        this.net.myReady = true;
        this.net.client.sendReady();
        document.getElementById('btn-net-ready').disabled = true;
        document.getElementById('btn-net-ready').textContent = this.net.peerReady ? '开战中…' : '已就绪，等对方…';
    },

    netQuit() {
        this.net.client?.bye();
        this.net = { client: null, side: null, code: null, myReady: false, peerReady: false, inBattle: false };
        this.mySide = 'red';
        this.showHome();
    },

    onNetMessage(message) {
        switch (message.t) {
            case 'welcome':
                this.net.serverIdentity = message.arena === true;
                this.updateNetConnectionStatus();
                break;
            case 'room':
                this.net.side = message.side;
                this.net.code = message.code;
                this.net.myReady = this.net.peerReady = false;
                document.getElementById('net-join-step').hidden = true;
                document.getElementById('net-lobby').hidden = false;
                document.getElementById('net-my-side').textContent = message.side === 'red' ? '🔴 红方（你）' : '🔵 蓝方（你）';
                document.getElementById('net-room-code').textContent = message.code;
                document.getElementById('net-peer-state').textContent = message.side === 'red' ? '等待蓝方加入…' : '已连接红方房主';
                document.getElementById('btn-net-ready').disabled = false;
                document.getElementById('btn-net-ready').textContent = '✅ 就绪开战';
                this.netStatus('房间就绪：' + message.code);
                break;
            case 'peer':
                this.net.peerReady = false;
                document.getElementById('net-peer-state').textContent = message.side === 'red' ? '🔴 红方已加入' : '🔵 蓝方已加入';
                break;
            case 'peer-ready':
                this.net.peerReady = true;
                document.getElementById('net-peer-state').textContent = (message.side === 'red' ? '🔴 红方' : '🔵 蓝方') + '已就绪';
                if (this.net.myReady) document.getElementById('btn-net-ready').textContent = '开战中…';
                break;
            case 'start':
                this.launchNetBattle();
                break;
            case 'turn':
            case 'hash':
                if (this.scene?.net) this.scene.net.handle(message);
                else (this.net.packets ??= []).push(message);   // 场景未就绪先缓冲，建网后回放
                break;
            case 'peer-left':
                this.onPeerLeft();
                break;
            case 'error':
                this.netStatus(message.text || '房间操作失败。');
                break;
            case 'info':
                this.netStatus(message.text || '');
                break;
            case 'closed':
                if (this.net.inBattle || this.net.code) this.netStatus('与服务器的连接已断开。');
                break;
            default: break;
        }
    },

    launchNetBattle() {
        this.clearBattle();
        this.mode = 'territory';
        this.challenge = null;
        this.editing = false;
        this.mySide = this.net.side === 'blue' ? 'blue' : 'red';
        this.configs = { red: { ...TERRITORY.OPENING }, blue: { ...TERRITORY.OPENING } };
        this.formations = { red: 'custom', blue: 'custom' };
        this.orders = { red: 'advance', blue: 'advance' };
        this.resetBattleOptions();
        this.battleOptions.territory = true;
        this.battleOptions.terrain = 'territory';
        this.battleOptions.net = true;
        this.battleOptions.mySide = this.mySide;
        this.net.inBattle = true;
        this.rememberMode('🌐 局域网对战', 'net');
        if (!this.scene) { this.pendingNetStart = true; return; }
        this.scene.netClient = { send: packet => this.net.client.send(packet) };
        this.deployArmies();
        // 关键：网络层在部署后立即创建（早于倒计时）——对端先到的命令包才不会被丢
        this.scene.net = new NetBattle(this.scene, this.scene.netClient,
            { onDesync: turn => this.onNetDesync(turn) });
        (this.net.packets || []).forEach(packet => this.scene.net.handle(packet));
        this.net.packets = [];
        this.startBattle();
    },

    onPeerLeft() {
        if (this.net.inBattle) {
            this.showNetToast('对手已离开——可退出房间或等待对方重连重开。');
            document.getElementById('btn-net-quit')?.focus?.();
        } else if (this.net.code) {
            document.getElementById('net-peer-state').textContent = '对手已离开，等待新对手…';
        }
    },

    onNetDesync(turn) {
        this.showNetToast('⚠ 两端战斗不同步（约第 ' + Math.round(turn / 60) + ' 秒）——请双方退出房间重新开局。');
    },

    showNetToast(text) {
        const cue = document.getElementById('action-toast');
        if (!cue) return;
        clearTimeout(this._toastTimer);
        cue.hidden = false;
        cue.textContent = text;
        this._toastTimer = setTimeout(() => { cue.hidden = true; }, 5000);
    },

    // 山河图缩略：临时切到大地图尺寸，读真实地形几何与旗点画进小画布——
    // 地图改了缩略图自动跟着变，不养第二份示意图。
    drawTerritoryThumb() {
        const canvas = document.getElementById('territory-thumb');
        if (!canvas || !canvas.getContext) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const originalBoard = { ...board };
        // 缩略图同步绘制后必须恢复当前地图（包括画外余量）；异步地形任务
        // 下一帧仍要读取同一套全局尺寸，不能把它重置为默认小棋盘。
        try {
            setBoardSize(TERRITORY.W, TERRITORY.H);
            const W = TERRITORY.W, H = TERRITORY.H;
            const sx = canvas.width / W, sy = canvas.height / H;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#7fae62';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            // 草地杂色
            for (let i = 0; i < 130; i++) {
                const x = (i * 61.8) % W, y = (i * 37.3) % H;
                ctx.fillStyle = i % 2 ? 'rgba(120,160,88,0.5)' : 'rgba(96,138,72,0.5)';
                ctx.fillRect(x * sx, y * sy, 2.4, 2.4);
            }
            const geometry = Terrain.geometry('territory');
            // 林斑（噪声 blob 逐点采样，边缘与游戏一致）
            for (const zone of geometry.zones) {
                if (zone.kind !== 'forest') continue;
                for (let y = zone.y1; y < zone.y2; y += 0.55) for (let x = zone.x1; x < zone.x2; x += 0.55) {
                    if (!Terrain.contains(zone, x + 0.28, y + 0.28)) continue;
                    ctx.fillStyle = (x * 7 + y * 3) % 3 < 1 ? '#3d6a38' : '#335c30';
                    ctx.fillRect(x * sx, y * sy, sx * 0.6, sy * 0.6);
                }
            }
            // 中央高地等高圈
            ctx.beginPath();
            ctx.ellipse(W / 2 * sx, H / 2 * sy, 9 * sx, 6.5 * sy, 0, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(233,221,172,0.22)';
            ctx.fill();
            ctx.lineWidth = 1.8;
            ctx.strokeStyle = 'rgba(240,225,170,0.85)';
            ctx.stroke();
            // 河与桥
            for (const block of geometry.blockers) {
                ctx.fillStyle = '#3f7fb2';
                ctx.fillRect(block.x1 * sx, block.y1 * sy, (block.x2 - block.x1) * sx, (block.y2 - block.y1) * sy);
            }
            for (const zone of geometry.zones) {
                if (zone.kind !== 'bridge') continue;
                ctx.fillStyle = '#c9a063';
                ctx.fillRect(zone.x1 * sx, zone.y1 * sy, (zone.x2 - zone.x1) * sx, (zone.y2 - zone.y1) * sy);
            }
            // 五面旗
            for (const flag of makeTerritoryFlags()) {
                ctx.beginPath();
                ctx.arc(flag.gx * sx, flag.gy * sy, 4.6, 0, Math.PI * 2);
                ctx.fillStyle = flag.owner === 'red' ? '#ff5b5b' : flag.owner === 'blue' ? '#57a0ff' : '#ece6d4';
                ctx.fill();
                ctx.lineWidth = 1.4;
                ctx.strokeStyle = 'rgba(20,20,20,0.8)';
                ctx.stroke();
            }
        } finally {
            setBoardSize(originalBoard.W, originalBoard.H, originalBoard.MARGIN);
        }
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
        this.rememberMode('🎖 ' + challenge.title, 'challenge', id);
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
        this.rememberMode('⚔️ 自由对战', 'sandbox');
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
        this.rememberMode({ assault: '⚔️ 战阵 · 正面强攻', flank: '⚔️ 战阵 · 单翼迂回', reserve: '⚔️ 战阵 · 预备队死斗' }[order], 'tactics', order);
        this.clearBattle();
        this.mode = 'tactics';
        this.challenge = null;
        this.editing = false;
        const reserve = order === 'reserve';
        this.configs = { red: { infantry: reserve ? 150 : 100 }, blue: { pikeman: 100 } };
        this.formations = { red: 'custom', blue: 'square' };
        this.orders = { red: reserve ? 'flank' : order, blue: 'hold' };
        this.battleOptions = { deathmatch: reserve, control: false, convoy: false, territory: false, reserves: { red: reserve ? 50 : 0, blue: 0 }, terrain: 'flat', cavalryOrders: { red: 'auto', blue: 'auto' } };
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
        document.getElementById('buy-message').textContent = this.battleOptions.convoy
            ? '🛒 护送模式 · 部署后红方自动获得 4 辆辎重车（不可购买、不可被摧毁），送抵 3 辆获胜；车身被蓝方独占约 6 秒即遭劫走（人越多越快），劫走 3 辆蓝胜'
            : this.battleOptions.control
            ? '⚑ 占点征服 · 部署后中场自动立三面旗，占旗积分先到 60 获胜'
            : this.battleOptions.deathmatch
            ? '💀 死斗 · 溃兵可重整，直到一方全灭'
            : '按住 ＋ 连续加兵 · 挑战中预设会按预算缩减';
        const wrap = document.getElementById('unit-cards');
        wrap.innerHTML = '';
        for (const [key, t] of Object.entries(UNIT_TYPES)) {
            if (t.hidden) continue;   // 辎重车等系统单位不进入配兵界面
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
        document.getElementById('order-description').textContent = (missing ? `本队暂无${missing}，开战时改用标准推进。` : '')
            + (this.orders[team] === 'hold_ground' ? this.guardDescription(team) : order.description);
        const cavalry = this.cavalryOrder(team);
        document.getElementById('cavalry-description').textContent = (this.configs[team].cavalry ? '' : '本队暂无骑兵；招募后才会执行。')
            + UI_CAVALRY_OPTIONS[cavalry].description
            + (this.orders[team] === 'hold_ground' && cavalry !== 'auto' ? ' 此指令允许骑兵离开守区，其他兵种仍守位。' : '');
    },

    stopHolds() {
        this.holdStops.forEach(stop => stop());
        this.holdStops = [];
    },

    bindHold(el, fn, afterBatch) {
        let timer, repeat, held = 0;
        const stop = () => { clearTimeout(timer); clearInterval(repeat); held = 0; };
        const batch = count => {
            let changed = false;
            let accepted = true;
            for (let i = 0; i < count; i++) {
                if (el.disabled) { accepted = false; stop(); break; }
                if (fn() === false) { accepted = false; stop(); break; }
                changed = true;
            }
            if (changed) afterBatch?.();
            if (el.disabled) stop();
            return accepted && !el.disabled;
        };
        this.holdStops.push(stop);
        el.addEventListener('pointerdown', e => {
            if (e.button !== 0 || el.disabled) return;
            e.preventDefault();
            stop();
            el.setPointerCapture(e.pointerId);
            if (!batch(1)) return;
            timer = setTimeout(() => {
                repeat = setInterval(() => {
                    held++;
                    const step = held < 10 ? 1 : held < 30 ? 8 : 25;
                    batch(step);
                }, 60);
            }, 380);
        });
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => el.addEventListener(ev, stop));
        el.addEventListener('click', e => { if (e.detail === 0 && !el.disabled) batch(1); });
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
        const control = this.battleOptions.control === true;
        const convoy = this.battleOptions.convoy === true;
        const territory = this.battleOptions.territory === true;
        const net = this.battleOptions.net === true;
        const mySide = this.battleOptions.mySide || 'red';
        const reserves = Object.fromEntries(['red', 'blue'].map(team => [team,
            Math.min(this.battleOptions.reserves[team] || 0, Math.max(0, (this.configs[team].infantry || 0) - 1))]));
        const terrain = ['sandbox', 'terrain'].includes(this.mode) ? Terrain.normalize(this.battleOptions.terrain)
            : this.mode === 'territory' ? 'territory' : 'flat';
        const cavalryOrders = Object.fromEntries(['red', 'blue'].map(team => [team,
            ['sandbox', 'terrain'].includes(this.mode) ? this.cavalryOrder(team) : 'auto']));
        this.battleOptions = { deathmatch, control, convoy, territory, net, mySide, reserves, terrain, cavalryOrders };
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
            : this.battleOptions.control
            ? '⚑ 占点征服 · 占旗攒分，先到 60 分者胜（全歼对手同样获胜）'
            : this.battleOptions.convoy
            ? '🛒 护送 · 送抵 3 辆辎重车获胜；蓝方劫走 3 辆即得手'
            : this.battleOptions.net
            ? '🌐 局域网对战 · 夺旗、筑寨、驻塔；耗尽敌方票数或攻破大本营获胜'
            : this.battleOptions.territory
            ? '🚩 领土征服 · 十一据点、民夫筑寨、弓手驻塔；耗尽敌方票数或攻破大本营获胜'
            : (this.challenge ? this.challenge.title + ' · ' : this.mode === 'tactics' ? '战阵演练 · ' : '') + '拖动看战况 · 点击士兵看地形';
        this.openSheet(false);
        this.scene.startCountdown(() => { this.countdown = false; this.syncControls(); });
    },

    editArmy(team) {
        if (!['result', 'ready', 'battle'].includes(this.phase)) return;
        if (this.mode === 'challenge' && team !== 'red') return;
        if (this.mode === 'territory') return;   // 常备军固定，无配兵环节
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
            : this.battleOptions.territory ? '领土征服 · 本局战报'
            : (report.deathmatch ? '预备队死斗' : this.mode === 'terrain' ? '地形演练' : this.mode === 'tactics' ? '战阵演练' : '自由对战') + ' · 本局战报';
        const title = document.getElementById('result-title');
        title.className = 'result-title ' + winner;
        title.textContent = winner === 'draw' ? '势均力敌 · 平局' : this.challenge ? (wonChallenge ? '挑战成功！' : '再试一种解法') : (winner === 'red' ? '🔴 红方胜利！' : '🔵 蓝方胜利！');
        document.getElementById('phase-hint').textContent = '读一读战报，准备下一次出击';
        const endReason = report.deathmatch && winner !== 'draw'
            ? (winner === 'red' ? '蓝方' : '红方') + '已全灭，死斗结束。 '
            : report.endReason === 'control' ? (winner === 'red' ? '红方' : '蓝方') + '掌控旗帜积分达标，占点获胜。 '
            : report.endReason === 'tickets' ? (winner === 'red' ? '红方' : '蓝方') + '掌控多数领土，对方票数耗尽，领土征服获胜。 '
            : report.endReason === 'camp' ? (winner === 'draw' ? '双方大本营同时被摧毁。 ' : (winner === 'red' ? '红方' : '蓝方') + '摧毁敌方大本营，攻寨获胜。 ')
            : report.endReason === 'convoy' ? (winner === 'red' ? '红方辎重车队突破封锁，护送获胜。' : '蓝方劫掠得手，辎重车队尽数被劫。')
            : report.endReason === 'stalemate' ? '双方持续固守、无人推进，本局相持结束。试着让一方改为进攻。 ' : report.endReason === 'rout' && winner !== 'draw'
            ? (winner === 'red' ? '蓝方' : '红方') + '军心瓦解，失去继续作战能力。 '
            : winner === 'draw' && report.red + report.blue > 0 && report.morale &&
                report.morale.red.steady + report.morale.red.wavering + report.morale.blue.steady + report.morale.blue.wavering === 0
                ? '双方均已失去继续作战能力。 ' : '';
        const territoryLine = report.territory
            ? ` 终局票数 ${report.territory.tickets.red}:${report.territory.tickets.blue} · 征兵 红${report.territory.recruited.red}/蓝${report.territory.recruited.blue} · 军费入账 红${report.territory.earned.red}/蓝${report.territory.earned.blue}`
            : '';
        document.getElementById('result-detail').textContent = endReason + '在场兵力：红方 ' + report.red + ' 人 · 蓝方 ' + report.blue + ' 人' + territoryLine;
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
        document.getElementById('btn-edit-blue').hidden = !!this.challenge || this.mode === 'territory';
        document.getElementById('btn-swap').hidden = !!this.challenge || this.mode === 'territory';
        document.getElementById('btn-edit-red').hidden = this.mode === 'territory';   // 领土征服阵容固定，重开即重置
        if (this.battleOptions.net) {
            document.getElementById('btn-edit-red').hidden = true;
            const rematchButton = document.getElementById('btn-rematch');
            rematchButton.textContent = '↻ 再战一局（双方确认）';
            rematchButton.onclick = () => this.netReady();
        }
        document.getElementById('btn-swap').textContent = this.battleOptions.terrain === 'flat' ? '⇄ 交换双方再战' : '⇄ 交换军队再战（地形不动）';
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
        this.updateTerritoryHUD();
    },
};

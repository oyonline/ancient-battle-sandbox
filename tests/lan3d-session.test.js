import test from 'node:test';
import assert from 'node:assert/strict';
import { LanSession } from '../js/three-spike/lan-session.js';
import { configDigest } from '../js/net/field3d-config.js';

const cfg = (preset = 'standard', formation = 'square', tactic = 'assault') => ({ preset, formation, tactic });
const configs = () => ({ red: cfg(), blue: cfg('small', 'wedge', 'flank') });
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function harness(extra = {}) {
    const calls = [], events = [], warnings = [], timers = new Map();
    let time = 0, nextTimer = 0, netOptions;
    const scene = { simulationTime: 0, simulationAccumulator: 0, battleOver: false, battleStarted: false,
        gameSpeed: 1, paused: false, units: [], deadCount: 0, arrows: [] };
    const client = {
        connect() { calls.push(['connect', typeof this.onEvent]); return Promise.resolve(); },
        createRoom(...args) { calls.push(['create', ...args]); }, joinRoom(...args) { calls.push(['join', ...args]); },
        sendConfig(value) { calls.push(['config', value]); }, sendReady(rev) { calls.push(['ready', rev]); },
        send(packet) { calls.push(['send', packet]); }, bye() { calls.push(['bye']); }
    };
    const net = {
        lockstep: { execTurn: 0, canStep() { events.push('canStep'); return true; },
            takeCommands() { events.push('takeCommands'); return []; } },
        handle(packet) { events.push(packet); }, start() { events.push('start'); },
        onTurnDone() { events.push('onTurnDone'); this.lockstep.execTurn++; },
        noteProgress() { events.push('noteProgress'); }, noteBuffer() { events.push('noteBuffer'); },
        noteStall(delta) { events.push(['stall', delta]); },
        reportResult(result) { events.push(['result', result]); this.myResult = result; }
    };
    const session = new LanSession({ client, deploy: async (value, context) => { calls.push(['deploy', value, context]); return scene; },
        stepMs: 1000 / 60, stepBattle() { events.push(['step', scene.simulationTime]); },
        makeNet(s, transport, options) { netOptions = options; assert.equal(s, scene); return net; },
        now: () => time, schedule(fn, ms) { const id = ++nextTimer; timers.set(id, { at: time + ms, fn }); return id; },
        cancel(id) { timers.delete(id); }, warn(message) { warnings.push(message); }, ...extra });
    const advanceClock = ms => {
        const end = time + ms;
        while (true) {
            const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            timers.delete(due[0]); time = due[1].at; due[1].fn();
        }
        time = end;
    };
    const room = (side = 'red') => {
        client.onEvent({ t: 'welcome', arena: true });
        client.onEvent({ t: 'room', mode: 'field3d', code: 'ABCD', side });
    };
    const broadcast = (rev = 3, value = configs()) => client.onEvent({ t: 'config', rev, configs: value });
    return { session, client, calls, events, warnings, timers, scene, net, room, broadcast, advanceClock,
        get netOptions() { return netOptions; } };
}

async function started(extra) {
    const h = harness(extra);
    h.room(); h.broadcast(); await flush(); h.session.handle({ t: 'start', rev: 3 });
    h.advanceClock(3000);
    return h;
}

test('连接前安装接收器；arena welcome 严格准入，建房/加入锁定 field3d 与房间座位', async () => {
    const h = harness();
    await h.session.connect();
    assert.deepEqual(h.calls, [['connect', 'function']]);
    assert.equal(h.session.requestRoom(), false);
    h.client.onEvent({ t: 'welcome', arena: false });
    assert.equal(h.session.status, '请用对战服务器地址打开（npm run arena）');
    assert.equal(h.session.requestRoom(), false);
    h.client.onEvent({ t: 'welcome', arena: true });
    assert.equal(h.session.requestRoom('ab12'), true);
    assert.deepEqual(h.calls.at(-1), ['join', 'AB12', 'field3d']);
    assert.equal(h.session.requestRoom(), false);
    h.client.onEvent({ t: 'error', text: '<literal error>' });
    assert.equal(h.session.status, '<literal error>');
    assert.equal(h.session.requestRoom(), true);
    assert.deepEqual(h.calls.at(-1), ['create', 'field3d']);
    h.client.onEvent({ t: 'room', mode: 'field3d', code: 'ABCD', side: 'blue' });
    assert.equal(h.session.room.side, 'blue');
    assert.equal(h.session.requestRoom(), false);
});

test('未收到 welcome 的连接提示 arena 地址，绝不能建房', async () => {
    const h = harness(); await h.session.connect(); h.advanceClock(5000);
    assert.equal(h.session.status, '请用对战服务器地址打开（npm run arena）');
    assert.equal(h.session.requestRoom(), false);
    const closed = harness(); await closed.session.connect();
    closed.session.handle({ t: 'closed' });
    assert.equal(closed.session.status, '请用对战服务器地址打开（npm run arena）');
    assert.equal(closed.session.banner, '与服务器断开');
    assert.equal(closed.session.requestRoom(), false);
});

test('从连接起缓存四类早到包，start 时按序回放、摘要带 rev；只铺底一次且倒计时持续收包', async () => {
    const h = harness(); await h.session.connect();
    const early = ['turn', 'hash', 'cfg-hash', 'result'].map(t => ({ t, early: true }));
    early.forEach(packet => h.client.onEvent(packet));
    h.room(); h.broadcast(); await flush();
    assert.equal(h.session.net, null);
    h.session.handle({ t: 'start', rev: 3 });
    assert.deepEqual(h.events, [...early, 'start']);
    assert.equal(h.netOptions.configDigest, configDigest(configs(), 3));
    h.session.handle({ t: 'start', rev: 3 });
    h.session.handle({ t: 'turn', countdown: true });
    assert.deepEqual(h.events.at(-1), { t: 'turn', countdown: true });
    h.session.advance(50); assert.equal(h.scene.simulationTime, 0);
    assert.equal(h.session.countdown, '3');
    h.advanceClock(1000); assert.equal(h.session.countdown, '2');
    h.advanceClock(1000); assert.equal(h.session.countdown, '1');
    h.advanceClock(1000); assert.equal(h.session.countdown, '开战！');
    assert.equal(h.session.running, true);
    h.advanceClock(600); assert.equal(h.session.countdown, '');
    assert.equal(h.events.filter(e => e === 'start').length, 1);
});

test('只用广播 configs 部署；确认后不能再提交；部署加载全部完成前不 ready', async () => {
    const load = deferred(), deployments = [];
    const h = harness({ deploy(value, context) { deployments.push([value, context]); return load.promise; } });
    h.room('blue');
    assert.equal(h.session.confirm(cfg('small')), true);
    assert.equal(h.session.confirm(cfg('large')), false);
    h.broadcast(); await flush();
    assert.deepEqual(deployments[0][0], configs());
    assert.equal(deployments[0][1].mySide, 'blue');
    assert.equal(deployments[0][1].rev, 3);
    assert.equal(h.calls.some(call => call[0] === 'ready'), false);
    h.session.handle({ t: 'start', rev: 3 });
    assert.equal(h.session.started, false);
    load.resolve(h.scene); await flush();
    assert.deepEqual(h.calls.at(-1), ['ready', 3]);
});

test('已部署新 rev 同配置重新 ready；键顺序不影响比较；异阵型/战术即使兵力相同也停止', async () => {
    for (const change of [{ formation: 'line' }, { tactic: 'hold' }, { preset: 'large' }]) {
        const h = harness(); h.room(); h.broadcast(); await flush();
        const reordered = Object.fromEntries(['blue', 'red'].map(side => [side, Object.fromEntries(Object.entries(configs()[side]).reverse())]));
        h.broadcast(4, reordered);
        assert.deepEqual(h.calls.filter(call => call[0] === 'ready'), [['ready', 3], ['ready', 4]]);
        h.broadcast(5, { ...configs(), blue: { ...configs().blue, ...change } });
        assert.equal(h.session.stopped, true);
        assert.equal(h.session.banner, '对方配置已变化，请双方退出重新建房');
        assert.equal(h.calls.filter(call => call[0] === 'ready').length, 2);
    }
});

test('部署中途同配置新 rev 完成后仅 ready 最新；异配置中止且旧异步完成不能 ready', async () => {
    for (const same of [true, false]) {
        const load = deferred();
        const h = harness({ deploy: () => load.promise }); h.room(); h.broadcast(); await flush();
        h.broadcast(4, same ? configs() : { ...configs(), red: cfg('large') });
        assert.equal(h.calls.some(call => call[0] === 'ready'), false);
        load.resolve(h.scene); await flush();
        assert.deepEqual(h.calls.filter(call => call[0] === 'ready'), same ? [['ready', 4]] : []);
        assert.equal(h.session.stopped, !same);
    }
});

test('start rev 不匹配忽略并提示；匹配最后 ready 才能开局', async () => {
    const h = harness(); h.room(); h.broadcast(); await flush(); h.broadcast(4);
    h.session.handle({ t: 'start', rev: 3 });
    assert.equal(h.session.started, false);
    assert.match(h.session.status, /修订号.*忽略/);
    h.session.handle({ t: 'start', rev: 4 });
    assert.equal(h.session.started, true);
});

test('固定 1×、250ms 累积与每帧三步；顺序正确；停等不丢累计，未知命令只警告一次', async () => {
    const h = await started(); h.events.length = 0;
    h.net.lockstep.takeCommands = () => { h.events.push('takeCommands'); return [{ k: 'unknown' }, { k: 'buy' }]; };
    h.scene.simulationAccumulator = 240;
    h.scene.gameSpeed = 4; // 不读取本地倍速。
    h.session.advance(1000);
    assert.equal(h.net.lockstep.execTurn, 3);
    assert.ok(Math.abs(h.scene.simulationAccumulator - 200) < 1e-6);
    assert.equal(h.scene.simulationTime, 50);
    assert.deepEqual(h.events.slice(0, 6), ['canStep', 'takeCommands', ['step', 1000 / 60], 'onTurnDone', 'noteProgress', 'noteBuffer']);
    assert.equal(h.warnings.length, 1);
    h.net.lockstep.canStep = () => false;
    h.session.advance(50);
    assert.equal(h.scene.simulationAccumulator, 250);
    assert.deepEqual(h.events.at(-1), ['stall', 50]);
    h.session.handle({ t: 'turn', arrivedWhileStalled: true });
    assert.deepEqual(h.events.at(-1), { t: 'turn', arrivedWhileStalled: true });
});

test('胜负钩子捕获 winner；最后 onTurnDone 之后上报 execTurn-1，仅一次，终局仍接收 result', async () => {
    const h = await started();
    h.session.stepBattle = () => { h.scene.battleOver = true; h.session.recordWinner('blue'); h.events.push('victory'); };
    h.session.advance(50); h.session.advance(50);
    const resultIndex = h.events.findIndex(event => Array.isArray(event) && event[0] === 'result');
    assert.ok(resultIndex > h.events.indexOf('onTurnDone'));
    assert.deepEqual(h.events[resultIndex][1], { turn: 0, winner: 'blue' });
    assert.equal(h.events.filter(event => Array.isArray(event) && event[0] === 'result').length, 1);
    h.session.handle({ t: 'result', side: 'red', winner: 'blue' });
    assert.equal(h.events.at(-1).t, 'result');
    assert.equal(h.session.state, 'finished');
});

test('配置/周期/终局 desync 立即停止推进，离开与断开同样停止并清理倒计时和缓冲', async () => {
    for (const kind of [-1, 120, 'peer-left', 'closed']) {
        const h = await started();
        if (typeof kind === 'number') h.netOptions.onDesync(kind, 'mine', 'theirs');
        else h.session.handle({ t: kind });
        h.session.advance(50);
        assert.equal(h.scene.simulationTime, 0);
        assert.equal(h.session.net, null);
        assert.equal(h.timers.size, 0);
        assert.equal(h.session.abort.signal.aborted, true);
        assert.equal(h.calls.filter(call => call[0] === 'bye').length, typeof kind === 'number' ? 1 : 0);
        assert.equal(h.session.banner, kind === -1 ? '双方开局配置不一致' : kind === 120 ? '第 2 秒两端战斗不同步' : kind === 'peer-left' ? '对手已离开' : '与服务器断开');
    }
    const h = harness(); h.room(); h.broadcast(); await flush(); h.session.handle({ t: 'start', rev: 3 });
    h.session.handle({ t: 'peer-left' }); h.advanceClock(10000);
    assert.equal(h.session.running, false);
    assert.equal(h.scene.battleStarted, false);
});

test('早到配置摘要不同通过真实 NetBattle 回调阻止倒计时/铺底；dispose 取消未完成部署', async () => {
    const { NetBattle } = await import('../js/net/lockstep.js');
    const h = harness({ makeNet: (scene, transport, options) => { scene.netMySide = 'red'; return new NetBattle(scene, transport, options); } });
    h.session.handle({ t: 'cfg-hash', side: 'blue', hash: 'wrong' });
    h.room(); h.broadcast(); await flush(); h.session.handle({ t: 'start', rev: 3 });
    assert.equal(h.session.banner, '双方开局配置不一致');
    assert.equal(h.session.running, false);
    assert.equal(h.session.state, 'stopped');
    assert.equal(h.calls.filter(call => call[0] === 'bye').length, 1);
    h.session.dispose();
    assert.equal(h.calls.filter(call => call[0] === 'bye').length, 1);
    assert.equal(h.calls.some(call => call[0] === 'send'), false);
    const load = deferred(), late = harness({ deploy: () => load.promise });
    late.room(); late.broadcast(); await flush(); late.session.dispose(); load.resolve(late.scene); await flush();
    assert.equal(late.calls.some(call => call[0] === 'ready'), false);
    assert.equal(late.session.packets.length, 0);
    assert.deepEqual(late.calls.at(-1), ['bye']);
});


test('步内 stepBattle 异常停止、显示原因并仅通知对端一次', async t => {
    const logged = t.mock.method(console, 'error', () => {});
    const h = await started({ stepBattle() { throw new Error('injected failure'); } });
    h.session.advance(50);
    assert.equal(h.session.state, 'stopped');
    assert.equal(h.session.banner, '本端模拟异常：injected failure');
    assert.equal(h.session.running, false);
    assert.equal(h.net.lockstep.execTurn, 0);
    assert.equal(logged.mock.callCount(), 1);
    h.session.advance(50); h.session.dispose();
    assert.equal(h.calls.filter(call => call[0] === 'bye').length, 1);
});

test('终局等待对端结果、一致后刷新结束条；离开/断开保留正常终局；不一致仍红色停止', async () => {
    const { NetBattle } = await import('../js/net/lockstep.js');
    for (const kind of ['peer-left', 'closed', 'mismatch']) {
        let updates = 0;
        const h = await started({ onChange() { updates++; },
            makeNet(scene, transport, options) { scene.netMySide = 'red'; return new NetBattle(scene, transport, options); } });
        // 真实锁步必须收到双方第 0 回合铺底包才能执行终局步。
        for (const side of ['red', 'blue']) h.session.handle({ t: 'turn', exec: 0, side, cmds: [] });
        h.session.stepBattle = () => { h.scene.battleOver = true; h.session.recordWinner('red'); };
        h.session.advance(50);
        assert.equal(h.session.state, 'finished');
        assert.equal(h.session.finishMessage, '本局结束：红方胜 · 等待对方结果…');
        const before = updates;
        h.session.handle({ t: 'result', side: 'blue', ...h.session.net.myResult,
            ...(kind === 'mismatch' ? { hash: 'wrong' } : {}) });
        assert.ok(updates > before);
        if (kind === 'mismatch') {
            assert.equal(h.session.state, 'stopped');
            assert.match(h.session.banner, /不同步/);
            assert.equal(h.session.finishMessage, '');
            assert.equal(h.calls.filter(call => call[0] === 'bye').length, 1);
        } else {
            assert.equal(h.session.finishMessage, '本局结束：红方胜 · 双方结果一致');
            h.session.handle({ t: kind });
            assert.equal(h.session.state, 'finished');
            assert.equal(h.session.banner, '');
            assert.equal(h.session.finishMessage, '本局结束：红方胜 · 双方结果一致 · 对手已离开');
            assert.equal(h.calls.filter(call => call[0] === 'bye').length, 0);
            h.session.dispose();
            assert.equal(h.calls.filter(call => call[0] === 'bye').length, 1);
        }
    }
});

test('结束条复用退出按钮和横幅布局，正常终局使用非红色样式', async t => {
    const { createLanUI } = await import('../js/three-spike/lan-ui.js');
    const elements = new Map();
    const element = () => ({ style: {}, classList: { add() {}, toggle() {} },
        setAttribute() {}, append(...children) { this.children = children; } });
    const body = element(), created = [];
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
    globalThis.document = { getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
    }, createElement() { const el = element(); created.push(el); return el; }, body };
    let exits = 0;
    const ui = createLanUI({ gate: element(), exit() { exits++; } });
    const h = await started();
    h.session.stepBattle = () => { h.scene.battleOver = true; h.session.recordWinner('blue'); };
    h.session.advance(50);
    ui.render(h.session);
    const banner = created.find(el => el.id === 'lan-banner');
    assert.equal(banner.hidden, false);
    assert.equal(banner.style.background, 'rgba(20,24,18,.88)');
    assert.equal(banner.style.color, '#ffe3a0');
    assert.equal(banner.children[0].textContent, '本局结束：蓝方胜 · 等待对方结果…');
    banner.children[1].onclick(); assert.equal(exits, 1);
    h.session.stop('不同步'); ui.render(h.session);
    assert.equal(banner.style.background, '');
    assert.equal(banner.children[0].textContent, '不同步');
});

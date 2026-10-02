import test from 'node:test';
import assert from 'node:assert/strict';
import { UI } from '../js/ui.js';

function lobby(t) {
    const original = globalThis.document;
    const elements = new Map();
    globalThis.document = { getElementById(id) {
        if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '' });
        return elements.get(id);
    } };
    t.after(() => { globalThis.document = original; });
    const ui = { ...UI, phase: 'home', net: { client: {
        connected: false, isArena: false,
        connect() { this.connected = true; return Promise.resolve(); }
    } }, clearBattle() {}, setPhase(phase) { this.phase = phase; }, setStep() {}, showSection() {} };
    return { ui, status: () => globalThis.document.getElementById('net-status').textContent };
}

test('socket open shows identity pending and later arena welcome replaces it with connected status', async t => {
    const { ui, status } = lobby(t);
    ui.openNetLobby();
    await Promise.resolve();
    assert.match(status(), /正在确认对战服务器/);
    assert.doesNotMatch(status(), /不是|不像/);
    ui.net.client.isArena = true; // ArenaClient sets this before forwarding the welcome event.
    ui.onNetMessage({ t: 'welcome', arena: true });
    assert.match(status(), /已连接对战服务器。创建房间/);
});

test('explicit non-arena welcome reports incorrect server identity', async t => {
    const { ui, status } = lobby(t);
    ui.openNetLobby();
    await Promise.resolve();
    ui.onNetMessage({ t: 'welcome', arena: false });
    assert.match(status(), /对方不是对战服务器/);
});

test('late welcome does not overwrite an existing room or battle status', t => {
    const { ui, status } = lobby(t);
    ui.net.code = 'TEST';
    ui.netStatus('房间就绪：TEST');
    ui.onNetMessage({ t: 'welcome', arena: true });
    assert.equal(status(), '房间就绪：TEST');
    ui.net.code = null;
    ui.net.inBattle = true;
    ui.netStatus('两军交战中');
    ui.onNetMessage({ t: 'welcome', arena: false });
    assert.equal(status(), '两军交战中');
});

test('welcome received before the connect continuation remains confirmed', async t => {
    const { ui, status } = lobby(t);
    ui.openNetLobby();
    ui.net.client.isArena = true;
    ui.onNetMessage({ t: 'welcome', arena: true });
    await Promise.resolve();
    assert.match(status(), /已连接对战服务器。创建房间/);
});

test('room request during identity handshake waits without claiming the server is incorrect', async t => {
    const { ui, status } = lobby(t);
    ui.openNetLobby();
    await Promise.resolve();
    let requests = 0;
    ui.netRequest(() => { requests++; }, '正在创建房间');
    assert.equal(requests, 0);
    assert.match(status(), /正在确认对战服务器/);
    assert.doesNotMatch(status(), /不是|不像/);
});

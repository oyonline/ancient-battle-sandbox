const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeUI() {
    const elements = new Map();
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, { textContent: '', title: '', hidden: false });
            return elements.get(id);
        }
    };
    const UI = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js/ui.js'), 'utf8') + '\nUI;', {
        document,
        UNIT_TYPES: { infantry: { icon: '⚔️', name: '剑士' }, cavalry: { icon: '🐴', name: '骑兵' } }
    });
    return { UI, el: id => document.getElementById(id) };
}

test('battle HUD separates current states from cumulative withdrawal and rally counts', () => {
    const { UI, el } = makeUI();
    UI.phase = 'battle';
    UI.scene = {
        redAlive: 15, blueAlive: 9,
        getMoraleSummary: () => ({
            red: { steady: 7, wavering: 5, routing: 3, withdrawn: 4, rallied: 6, average: 48.6, lastReason: '侧翼受冲击' },
            blue: { steady: 9, wavering: 0, routing: 0, withdrawn: 0, rallied: 0, average: 96 }
        })
    };
    UI.updateCounts();
    assert.equal(el('red-count').textContent, 15, 'top count is in-field soldiers, not cumulative experiences');
    assert.equal(el('morale-hud').hidden, false);
    assert.equal(el('morale-red-steady').textContent, 7);
    assert.equal(el('morale-red-wavering').textContent, 5);
    assert.equal(el('morale-red-routing').textContent, 3);
    assert.equal(el('morale-red-average').textContent, 49);
    assert.equal(el('morale-red-reason').textContent, '侧翼受冲击');
    assert.equal(el('morale-red-reason').title, '侧翼受冲击');
    assert.equal(el('morale-blue-reason').textContent, '阵线稳定');
});

test('leaving battle clears its morale HUD and a new battle renders fresh state', () => {
    const { UI, el } = makeUI();
    let reads = 0;
    UI.phase = 'battle';
    UI.scene = { getMoraleSummary: () => {
        reads++;
        return { red: { steady: 0, wavering: 1, routing: 8, average: 18, lastReason: '附近友军溃逃' } };
    } };
    UI.updateMorale();
    for (const phase of ['result', 'ready', 'buy-red', 'home']) {
        UI.phase = phase;
        UI.updateMorale();
        assert.equal(el('morale-hud').hidden, true);
        assert.equal(el('morale-red-routing').textContent, 0);
        assert.equal(el('morale-red-average').textContent, '—');
        assert.equal(el('morale-red-reason').textContent, '暂无在场士兵');
    }
    assert.equal(reads, 1, 'non-battle phases cannot display stale scene morale');
    UI.phase = 'battle';
    UI.scene = { getMoraleSummary: () => ({ red: { steady: 20, wavering: 0, routing: 0, average: 100 } }) };
    UI.updateMorale();
    assert.equal(el('morale-hud').hidden, false);
    assert.equal(el('morale-red-steady').textContent, 20);
    assert.equal(el('morale-red-routing').textContent, 0);
    assert.equal(el('morale-red-reason').title, '阵线稳定');
});

test('legacy scenes and empty teams do not show invalid morale averages', () => {
    const { UI, el } = makeUI();
    UI.phase = 'battle';
    UI.scene = {};
    assert.doesNotThrow(() => UI.updateMorale());
    assert.equal(el('morale-hud').hidden, true);
    UI.scene = { getMoraleSummary: () => ({ red: { steady: 0, wavering: 0, routing: 0, average: 100 } }) };
    UI.updateMorale();
    assert.equal(el('morale-red-average').textContent, '—');
    assert.equal(el('morale-blue-average').textContent, '—');
    assert.equal(el('morale-blue-routing').textContent, 0);
});

test('report keeps casualties, survivors and withdrawals separate from morale experiences', () => {
    const { UI } = makeUI();
    const html = UI.renderTeamReport('red', {
        damage: 250, routed: 7, rallied: 3, routing: 2,
        byType: { infantry: { initial: 20, alive: 10, lost: 6, withdrawn: 4, kills: 5 } }
    });
    assert.match(html, /在场<\/th>.*阵亡<\/th>.*撤离<\/th>/s);
    assert.match(html, /剑士<\/th><td>20<\/td><td>10<\/td><td>6<\/td><td>4<\/td><td>5<\/td>/);
    assert.match(html, /曾溃逃 <b>7<\/b> 人/);
    assert.match(html, /重整 <b>3<\/b> 人/);
    assert.match(html, /当前溃逃 <b>2<\/b> 人/);
    assert.doesNotMatch(html, /损失|undefined|NaN/);
});

test('legacy reports render zero withdrawals and morale experiences', () => {
    const { UI } = makeUI();
    const html = UI.renderTeamReport('blue', {
        damage: 80,
        byType: { cavalry: { initial: 5, alive: 2, lost: 3, kills: 1 } }
    });
    assert.match(html, /骑兵<\/th><td>5<\/td><td>2<\/td><td>3<\/td><td>0<\/td><td>1<\/td>/);
    assert.match(html, /曾溃逃 <b>0<\/b> 人/);
    assert.match(html, /重整 <b>0<\/b> 人/);
    assert.match(html, /当前溃逃 <b>0<\/b> 人/);
    assert.doesNotMatch(html, /undefined|NaN/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CAMP_LAYOUT } from '../js/siege3d/layout.js';
import { DEFAULT_FORCE_CONFIG as standard, FORCE_FIELDS, FORCE_PRESETS, FORCE_LIMIT,
    FORCE_STORAGE_KEY, totalTroops, clampForceCount, validateForceConfig, editForceConfig,
    loadForceConfig, saveForceConfig } from '../js/siege3d/force-config.js';
import { createForceDeployment } from '../js/siege3d/force-deployment.js';
import { deployCampArmies, configureCampArmies, installSiegeArrows } from '../js/siege3d/deployment.js';
import { makeScene } from './battle-harness.js';
import { step } from '../tools/siege-balance.mjs';
import { digest, stateSummary } from './siege-assault-support.js';

const clone = value => structuredClone(value);
const source = readFileSync(new URL('../js/siege3d/main.js', import.meta.url), 'utf8');

test('force config: defaults and all presets retain exact integers, fields and limits', () => {
    assert.deepEqual(standard, { attackers: CAMP_LAYOUT.attackers, defenders: CAMP_LAYOUT.defenders });
    assert.equal(standard.attackers.infantry, 235);
    assert.equal(clampForceCount('attackers', 'infantry', 235), 235);
    assert.deepEqual(FORCE_PRESETS.gentle, { attackers: standard.attackers, defenders: { infantry: 40, archer: 10 } });
    assert.deepEqual(FORCE_PRESETS.grand, { attackers: { infantry: 400, pikeman: 100, archer: 60 }, defenders: { infantry: 150, archer: 40 } });
    for (const preset of Object.values(FORCE_PRESETS)) assert.ok(validateForceConfig(preset));
    assert.equal(totalTroops(FORCE_PRESETS.grand.attackers) + totalTroops(FORCE_PRESETS.grand.defenders), FORCE_LIMIT);
    assert.deepEqual(Object.values(FORCE_FIELDS).flatMap(fields => Object.values(fields).map(f => f.step)), [10, 5, 5, 5, 2]);
});

test('force config: clamp without step snapping; reject non-whitelisted, invalid and over-limit values', () => {
    for (const [side, fields] of Object.entries(FORCE_FIELDS)) for (const [kind, field] of Object.entries(fields)) {
        assert.equal(clampForceCount(side, kind, -100), field.min);
        assert.equal(clampForceCount(side, kind, 900), field.max);
        assert.equal(clampForceCount(side, kind, field.min + 1), field.min + 1);
        for (const count of [field.min - 1, field.max + 1, NaN, Infinity, 1.5, '10', null]) {
            const config = clone(standard); config[side][kind] = count;
            assert.equal(validateForceConfig(config), false, `${side}/${kind}/${count}`);
        }
    }
    for (const invalid of [null, [], {}, { ...standard, extra: 1 }, { ...standard, defenders: { infantry: 80, archer: 20, cavalry: 1 } },
        { ...standard, attackers: { infantry: 0, pikeman: 0, archer: 9 } }]) assert.equal(validateForceConfig(invalid), false);
    const grand = clone(FORCE_PRESETS.grand);
    assert.deepEqual(editForceConfig(grand, 'attackers', 'infantry', 410), grand);
    const tooMany = clone(grand); tooMany.attackers.infantry++;
    assert.equal(validateForceConfig(tooMany), false);
    const tiny = { attackers: { infantry: 10, pikeman: 0, archer: 0 }, defenders: { infantry: 10, archer: 0 } };
    assert.ok(validateForceConfig(tiny));
    assert.equal(editForceConfig(tiny, 'attackers', 'infantry', 0), tiny);
    const minimumDefence = editForceConfig(standard, 'defenders', 'infantry', 0);
    assert.equal(minimumDefence.defenders.infantry, 10);
});

test('force config: storage exceptions, malformed JSON, unknown fields and invalid bounds fall back to standard', () => {
    const throwing = { getItem() { throw new Error('denied'); } };
    assert.deepEqual(loadForceConfig(throwing), standard);
    for (const raw of [null, '{oops', 'null', '[]', '{}', JSON.stringify({ ...standard, unknown: true }),
        JSON.stringify({ ...standard, attackers: { ...standard.attackers, infantry: 401 } }),
        JSON.stringify({ ...standard, attackers: { infantry: 0, pikeman: 0, archer: 0 } })]) {
        assert.deepEqual(loadForceConfig({ getItem: () => raw }), standard);
    }
    let saved;
    const store = { setItem(key, value) { assert.equal(key, FORCE_STORAGE_KEY); saved = value; }, getItem: () => saved };
    assert.equal(saveForceConfig(FORCE_PRESETS.grand, store), true);
    assert.deepEqual(loadForceConfig(store), FORCE_PRESETS.grand);
    const current = clone(FORCE_PRESETS.gentle), before = clone(current);
    assert.equal(saveForceConfig(current, { setItem() { throw new Error('quota'); } }), false);
    assert.deepEqual(current, before, 'saving failure must preserve the in-memory choice');
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('getter denied'); } });
        assert.deepEqual(loadForceConfig(), standard); assert.equal(saveForceConfig(current), false);
        assert.deepEqual(current, before);
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
        else delete globalThis.localStorage;
    }
});

function scheduler(deploy) {
    const jobs = new Map(), states = [];
    let id = 0;
    const controller = createForceDeployment({ deploy, onState: state => states.push(state),
        schedule(fn) { jobs.set(++id, fn); return id; }, cancel(key) { jobs.delete(key); } });
    return { controller, states, jobs, async flush() {
        const pending = [...jobs.values()]; jobs.clear(); pending.forEach(fn => fn());
        await new Promise(resolve => setImmediate(resolve));
    } };
}

test('force interlock: rapid edits coalesce; immediate start rejects; completed start uses newest config once', async () => {
    const deployed = [], h = scheduler(async config => deployed.push(config));
    for (const preset of Object.values(FORCE_PRESETS)) {
        h.controller.request(preset);
        assert.equal(h.controller.state.canStart, false);
        assert.equal(h.controller.start(), false);
    }
    assert.equal(h.jobs.size, 1); await h.flush();
    assert.deepEqual(deployed, [FORCE_PRESETS.grand]);
    assert.equal(h.controller.state.canStart, true);
    assert.deepEqual(h.controller.start(), FORCE_PRESETS.grand);
    assert.equal(h.controller.start(), false);
    assert.equal(h.jobs.size, 0);
    assert.equal(h.controller.request(standard), false);
    await h.flush(); assert.equal(deployed.length, 1);
});

test('force interlock: edits during first asynchronous boot never publish stale config or unlock start', async () => {
    let finish;
    const committed = [], h = scheduler(async (config, isCurrent) => {
        if (!finish) await new Promise(resolve => { finish = resolve; });
        if (isCurrent()) committed.push(config);
    });
    h.controller.request(standard); await h.flush();
    assert.equal(h.controller.state.phase, 'deploying');
    h.controller.request(FORCE_PRESETS.gentle); h.controller.request(FORCE_PRESETS.grand);
    assert.equal(h.controller.start(), false);
    finish(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(committed, []); assert.equal(h.controller.state.canStart, false);
    await h.flush(); assert.deepEqual(committed, [FORCE_PRESETS.grand]);
    assert.deepEqual(h.controller.start(), FORCE_PRESETS.grand);
});

test('force interlock: failure stays locked, retry succeeds; stale failures cannot discard the latest request', async () => {
    let fail = true;
    const h = scheduler(async () => { if (fail) throw new Error('deployment failed'); });
    h.controller.request(standard); await h.flush();
    assert.equal(h.controller.state.phase, 'error'); assert.equal(h.controller.state.canStart, false);
    assert.equal(h.controller.start(), false); assert.equal(h.controller.state.error.message, 'deployment failed');
    fail = false; assert.equal(h.controller.retry(), true); await h.flush();
    assert.equal(h.controller.state.phase, 'ready'); assert.deepEqual(h.controller.start(), standard);
    let reject;
    const stale = scheduler(async () => { if (!reject) await new Promise((resolve, failure) => { reject = failure; }); });
    stale.controller.request(standard); await stale.flush();
    stale.controller.request(FORCE_PRESETS.grand); reject(new Error('stale failure'));
    await new Promise(resolve => setImmediate(resolve)); await stale.flush();
    assert.equal(stale.controller.state.phase, 'ready'); assert.deepEqual(stale.controller.start(), FORCE_PRESETS.grand);
});

test('force interlock: started battle ignores queued callbacks and explicit redeploy opens a fresh round', async () => {
    const deployed = [], callbacks = [], h = scheduler(async config => deployed.push(config));
    h.controller.request(standard); callbacks.push(...h.jobs.values()); await h.flush();
    h.controller.start(); callbacks.forEach(fn => fn()); await h.flush();
    assert.equal(deployed.length, 1);
    h.controller.reset(FORCE_PRESETS.gentle); assert.equal(h.controller.state.canStart, false);
    await h.flush(); assert.equal(deployed.length, 2); assert.deepEqual(h.controller.start(), FORCE_PRESETS.gentle);
});

function pageStart(s, deploying = false) {
    const context = { scene: s, deploying, configureCampArmies, refreshCampVisuals() {}, syncAssaultControls() {}, sync3D() {},
        $: () => ({}), Snd: { play() {} }, campVersion: 0 };
    vm.runInNewContext(source.match(/function positionArmies\([^]*?\n}/)[0] + '\n' +
        source.match(/function startBattle\([^]*?\n}/)[0] + "\nstartBattle('player'); startBattle('player');", context);
}

test('force page integration: pending edits block actual start function; latest deployment starts without regeneration', async () => {
    const s = makeScene(); deployCampArmies(s); s.battleStarted = false;
    const initial = [...s.units]; pageStart(s, true);
    assert.equal(s.battleStarted, false); assert.deepEqual(s.units, initial);
    const h = scheduler(async config => { deployCampArmies(s, config); s.battleStarted = false; });
    h.controller.request(FORCE_PRESETS.grand); await h.flush();
    const units = [...s.units], nextId = s.nextId;
    s.deployUnits = () => assert.fail('player start must not regenerate units');
    let started = 0; s.onSiegeStart = () => { started++; h.controller.start(); };
    pageStart(s);
    assert.equal(started, 1); assert.equal(s.battleStarted, true); assert.equal(s.units.length, 750);
    assert.equal(s.nextId, nextId); assert.ok(s.units.every((u, i) => u === units[i]));
    assert.equal(h.controller.state.phase, 'started');
});

test('force deployment: explicit standard override is identical to the original default through 120 steps', () => {
    const run = options => {
        const s = makeScene(); installSiegeArrows(s); deployCampArmies(s, { scatterSeed: 173, ...options });
        const snapshots = [digest(stateSummary(s))];
        step(s, 120); snapshots.push(digest(stateSummary(s))); return snapshots;
    };
    assert.deepEqual(run(standard), run({}));
    assert.equal(CAMP_LAYOUT.attackers.infantry, 235);
});

const cases = {
    'no archers': { attackers: { infantry: 235, pikeman: 40, archer: 0 }, defenders: { infantry: 80, archer: 0 } },
    '14 defenders': { attackers: standard.attackers, defenders: { infantry: 10, archer: 4 } },
    '560 attackers / 190 defenders': FORCE_PRESETS.grand,
    '10 attackers, south infantry < 4': { attackers: { infantry: 5, pikeman: 5, archer: 0 }, defenders: standard.defenders },
    'no swordsmen': { attackers: { infantry: 0, pikeman: 40, archer: 25 }, defenders: standard.defenders }
};
for (const [name, config] of Object.entries(cases)) for (const mode of ['auto', 'player']) {
    test(`force boundary: ${name} / ${mode}, 120 seconds complete steps`, t => {
        assert.ok(validateForceConfig(config));
        const s = makeScene(); installSiegeArrows(s); deployCampArmies(s, { ...config, scatterSeed: 173 });
        for (const [side, team] of [['attackers', 'red'], ['defenders', 'blue']]) {
            for (const [kind, count] of Object.entries(config[side]))
                assert.equal(s.units.filter(u => u.team === team && u.type === kind).length, count);
        }
        const units = [...s.units], nextId = s.nextId;
        if (mode === 'player') {
            s.battleStarted = false;
            s.deployUnits = () => assert.fail('must reuse generated units');
            pageStart(s); assert.equal(s.nextId, nextId); assert.ok(s.units.every((u, i) => u === units[i]));
            // Release south before the ram, exercising short reserve lists on real troops.
            assert.equal(s.applyNetCommand({ k: 'siegeAssault', side: 'red', face: 'south' }), true);
            if (name.includes('< 4')) assert.ok(s.units.filter(u => u.siegeRamReserve).length < 4);
            for (const face of ['north', 'east', 'west']) s.applyNetCommand({ k: 'siegeAssault', side: 'red', face });
            s.applyNetCommand({ k: 'siegeRam', side: 'red' });
            if (config.attackers.archer) s.applyNetCommand({ k: 'siegeArchers', side: 'red' });
        }
        // Keep advancing the requested 120s even if a win is reached earlier.
        s.checkWin = () => {};
        for (let frame = 0; frame < 7200; frame++) step(s);
        assert.ok(Math.abs(s.simulationTime - 120000) < 1e-6);
        for (const u of s.units) assert.ok(Number.isFinite(u.gx) && Number.isFinite(u.gy), `finite coordinates: ${u.id}`);
        if (config.attackers.infantry === 0) {
            assert.ok(s.siege.ram.crew.every(id => id === null));
            assert.ok(s.siege.ladders.every(l => l.crew.every(id => id === null)));
        }
        t.diagnostic(`steps=7200; initial=${units.length}; simulated=${s.simulationTime.toFixed(1)}ms; nextIdAtStart=${nextId}`);
    });
}

test('force UI: zero attacker archers disable suppression and remove the archer HUD status', () => {
    const s = makeScene(); deployCampArmies(s, { ...cases['no archers'], attackerControl: 'player' });
    s.battleStarted = true;
    const buttons = new Map();
    const get = id => {
        if (!buttons.has(id)) buttons.set(id, { dataset: { label: id } });
        return buttons.get(id);
    };
    const context = { scene: s, forceConfig: cases['no archers'], $: get,
        faceNames: { north: '北', east: '东', south: '南', west: '西', ram: '冲车', archers: '弓手' },
        localCommands: { pending: () => false } };
    vm.runInNewContext(source.match(/function syncAssaultControls\([^]*?\n}/)[0] + '\nsyncAssaultControls();', context);
    assert.equal(get('assault-archers').disabled, true); assert.equal(get('assault-north').disabled, false);
    const line = source.split('\n').find(line => line.includes("'弓手压制中'"));
    const expression = line.trim().replace(/ \+$/, '');
    const hud = vm.runInNewContext(expression, { siege: s.siege, faceNames: context.faceNames, forceConfig: cases['no archers'] });
    assert.ok(!hud.includes('弓手'));
});

test('force UI: limits, warning, editable values and loaded presets use current config', () => {
    const nodes = new Map(), presets = Object.keys(FORCE_PRESETS).map(preset => ({ dataset: { preset },
        setAttribute(name, value) { this[name] = value; } }));
    const rows = Object.entries(FORCE_FIELDS).flatMap(([side, fields]) => Object.keys(fields).map(kind => {
        const input = { value: '' }, buttons = [-1, 1].map(direction => ({ dataset: { direction } }));
        return { dataset: { side, kind }, input, buttons, querySelector: () => input, querySelectorAll: () => buttons };
    }));
    const get = id => { if (!nodes.has(id)) nodes.set(id, { style: {} }); return nodes.get(id); };
    const context = vm.createContext({ forceConfig: clone(FORCE_PRESETS.grand), FORCE_FIELDS, FORCE_PRESETS, FORCE_LIMIT,
        totalTroops, editForceConfig, $: get, document: { querySelectorAll: selector => selector === '.force-row' ? rows : presets } });
    vm.runInContext(source.match(/function renderForcePanel\([^]*?\n}/)[0] + '\nrenderForcePanel();', context);
    assert.ok(rows.every(row => row.buttons[1].disabled));
    assert.equal(get('force-size').textContent, '全场 750/750 人 · 可能变卡');
    assert.equal(get('gate-description').textContent, '攻方 560 人围攻木栅营寨，守方 190 人据寨死守');
    assert.equal(get('force-warning').hidden, true);
    assert.ok(get('force-info').textContent.includes('上墙约 97 人 · 上塔弓手 12 人'));
    context.forceConfig = clone(cases['no swordsmen']);
    vm.runInContext('renderForcePanel();', context); assert.equal(get('force-warning').hidden, false);
    // During typing, keep the raw partial input until change/blur; other controls still reflect clamped counts.
    const defender = rows.find(row => row.dataset.side === 'defenders' && row.dataset.kind === 'infantry');
    defender.input.value = '4'; context.editingInput = defender.input;
    vm.runInContext('renderForcePanel(editingInput);', context); assert.equal(defender.input.value, '4');
    vm.runInContext('renderForcePanel();', context); assert.equal(defender.input.value, 80);
    context.forceConfig = { defenders: { archer: 20, infantry: 80 }, attackers: { archer: 25, pikeman: 40, infantry: 235 } };
    vm.runInContext('renderForcePanel();', context);
    assert.equal(presets[0]['aria-pressed'], true, 'stored key order does not change the selected preset');
});

test('force UI: page state callback locks both start buttons synchronously, shows retry, and preserves edits on save failure', async () => {
    const nodes = new Map();
    const get = id => { if (!nodes.has(id)) nodes.set(id, { style: {} }); return nodes.get(id); };
    let finish;
    const h = scheduler(async () => { await new Promise(resolve => { finish = resolve; }); });
    const context = vm.createContext({ forceConfig: clone(standard), forceSaved: true, deploying: false,
        FORCE_FIELDS, FORCE_PRESETS, FORCE_LIMIT, totalTroops, editForceConfig, scene: { battleStarted: false },
        saveForceConfig: () => false, $: get, console: { error() {} }, syncAssaultControls() {},
        document: { querySelectorAll: () => [] } });
    const onState = source.match(/    onState: (\(\{ phase, canStart, error \}\) => \{[^]*?\n    \})\n\}\);/)[1];
    context.update = vm.runInContext(`(${onState})`, context);
    context.forceDeployment = { get state() { return h.controller.state; }, request(config) {
        h.controller.request(config); context.update(h.controller.state);
    } };
    vm.runInContext(source.match(/function renderForcePanel\([^]*?\n}/)[0] + '\n' +
        source.match(/function selectForces\([^]*?\n}/)[0], context);
    context.next = clone(FORCE_PRESETS.gentle);
    vm.runInContext('selectForces(next);', context);
    for (const id of ['btn-start', 'btn-watch']) {
        assert.equal(get(id).disabled, true); assert.equal(get(id).textContent, '部署中…');
    }
    assert.equal(context.deploying, true); assert.deepEqual(context.forceConfig, FORCE_PRESETS.gentle);
    assert.ok(get('force-status').textContent.includes('当前选择已保留'));
    context.update({ phase: 'error', canStart: false, error: new Error('test') });
    assert.equal(get('force-retry').hidden, false); assert.equal(get('btn-start').disabled, true);
    await h.flush(); finish(); await new Promise(resolve => setImmediate(resolve));
    context.update(h.controller.state);
    assert.equal(get('btn-start').disabled, false); assert.equal(get('btn-watch').disabled, false);
    assert.equal(get('force-retry').hidden, true);
});

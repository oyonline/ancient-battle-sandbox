const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const snapshot = value => JSON.parse(JSON.stringify(value));

class Element {
    constructor(dataset = {}) {
        this.dataset = dataset;
        this.children = [];
        this.queries = new Map();
        this.attributes = {};
        this.style = {};
        this.hidden = false;
        this.textContent = '';
        const classes = new Set();
        this.classList = {
            add: name => classes.add(name), remove: name => classes.delete(name),
            contains: name => classes.has(name),
            toggle(name, enabled = !classes.has(name)) { enabled ? classes.add(name) : classes.delete(name); }
        };
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    appendChild(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    addEventListener() {}
    closest() { return this; }
    querySelector(selector) {
        if (!this.queries.has(selector)) this.queries.set(selector, new Element());
        return this.queries.get(selector);
    }
    querySelectorAll() { return this.children; }
}

function setup({ readyScene = true, query = '' } = {}) {
    const elements = new Map([...page.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
    const terrainButtons = [...page.matchAll(/<button[^>]+data-terrain="([^"]+)"/g)]
        .map(([, terrain]) => new Element({ terrain }));
    const terrainEntries = [...page.matchAll(/<button[^>]+data-terrain-entry="([^"]+)"/g)]
        .map(([, terrainEntry]) => new Element({ terrainEntry }));
    const tacticsButtons = [...page.matchAll(/<button[^>]+data-tactics-entry="([^"]+)"/g)]
        .map(([, tacticsEntry]) => new Element({ tacticsEntry }));
    const selectors = new Map([
        ['[data-terrain]', terrainButtons], ['[data-terrain-entry]', terrainEntries], ['[data-tactics-entry]', tacticsButtons],
        ['#tactics-ready-guide [data-tactics-entry]', tacticsButtons],
        ['#steps .step', [1, 2, 3].map(step => new Element({ step }))],
        ['.sheet-body .sec', ['home', 'buy', 'ready', 'result'].map(name => elements.get('sec-' + name))]
    ]);
    const el = id => {
        if (!elements.has(id)) {
            assert.match(id, /^(num-|btn-reveal$)/, 'UI references an ID present in the actual page');
            elements.set(id, new Element());
        }
        return elements.get(id);
    };
    const document = {
        body: new Element(), getElementById: el, createElement: () => new Element(),
        querySelectorAll: selector => selectors.get(selector) || [],
        querySelector(selector) {
            if (!selectors.has(selector)) selectors.set(selector, new Element());
            return selectors.get(selector);
        }
    };
    const context = vm.createContext({
        document, location: { search: query }, URLSearchParams, performance: { now: () => 1000 },
        window: { addEventListener() {} }, localStorage: { getItem: () => null },
        clearTimeout() {}, clearInterval() {}, setTimeout() {}, setInterval() {}
    });
    for (const file of ['terrain.js', 'units.js', 'challenges.js', 'ui.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, 'js', file), 'utf8'), context);
    }
    const { UI, CHALLENGES } = vm.runInContext('Snd.muted = true; ({ UI, CHALLENGES });', context);
    const scene = {
        deployments: [], starts: 0, terrain: 'flat', redAlive: 76, blueAlive: 76,
        clearUnits() { this.terrain = 'flat'; },
        deployUnits(...args) { this.deployments.push(snapshot(args)); this.terrain = args[5].terrain; },
        startCountdown(callback) { this.starts++; this.finishCountdown = callback; }
    };
    if (readyScene) UI.onSceneReady(scene);
    UI.init();
    return { UI, scene, el, terrainButtons, terrainEntries, challenges: CHALLENGES };
}

function finishBattle(UI) {
    UI.startBattle();
    const team = {
        initial: 76, damage: 20,
        byType: { infantry: { initial: 36, alive: 20, lost: 16, kills: 1 } }
    };
    UI.onBattleEnd('red', {
        red: 20, blue: 0, durationMs: 18000, firstContactMs: 4500,
        terrain: UI.battleOptions.terrain, teams: { red: team, blue: team }, events: []
    });
}

test('terrain entry deploys identical mixed armies without starting the battle', () => {
    const { UI, scene, el } = setup();
    el('btn-terrain').onclick();
    assert.equal(UI.phase, 'ready');
    assert.equal(UI.mode, 'terrain');
    assert.equal(UI.troops('red'), 76);
    assert.deepEqual(snapshot(UI.configs.red), snapshot(UI.configs.blue));
    assert.notEqual(UI.configs.red, UI.configs.blue, 'editing one side cannot modify the other');
    assert.equal(scene.terrain, 'blue_pass');
    assert.equal(scene.starts, 0);
    assert.equal(el('terrain-ready').hidden, false);
    assert.match(el('terrain-hud').textContent, /蓝方.*坡口/);
    assert.deepEqual(snapshot(UI.orders), { red: 'advance', blue: 'hold_ground' });
    assert.deepEqual(snapshot(UI.battleOptions.cavalryOrders), { red: 'auto', blue: 'auto' });
    assert.equal(el('ready-blue-army').value, 'hold_ground');
});

test('all three map buttons redeploy immediately, keep armies and update selected controls', () => {
    const { UI, scene, terrainButtons, el } = setup({ query: '?terrain=blue_hill' });
    const armies = snapshot(UI.configs);
    const orders = snapshot(UI.orders);
    for (const terrain of ['flat', 'red_hill', 'blue_hill']) {
        const before = scene.deployments.length;
        terrainButtons.find(button => button.dataset.terrain === terrain).onclick();
        assert.equal(scene.deployments.length, before + 1);
        assert.equal(scene.terrain, terrain);
        assert.deepEqual(snapshot(UI.configs), armies);
        assert.deepEqual(snapshot(UI.orders), orders, 'map changes preserve the chosen defender rather than silently swapping tactics');
        assert.equal(UI.phase, 'ready');
        assert.equal(scene.starts, 0);
        for (const button of terrainButtons) {
            assert.equal(button.attributes['aria-pressed'], String(button.dataset.terrain === terrain));
        }
    }
    assert.match(el('terrain-ready-description').textContent, /高地|山丘/);
});

test('terrain deep link and selection survive a pending scene without autoplay', () => {
    const { UI, scene } = setup({ readyScene: false, query: '?terrain=blue_hill' });
    assert.equal(UI.pendingDeploy, true);
    assert.equal(UI.pendingAutoplay, false);
    UI.selectTerrain('red_hill');
    UI.onSceneReady(scene);
    assert.equal(UI.pendingDeploy, false);
    assert.equal(scene.deployments.length, 1);
    assert.equal(scene.terrain, 'red_hill');
    assert.equal(UI.phase, 'ready');
    assert.equal(scene.starts, 0);
});

test('battle and countdown reject map changes even through direct calls', () => {
    const { UI, scene, terrainButtons } = setup({ query: '?terrain=blue_hill' });
    UI.startBattle();
    const count = scene.deployments.length;
    for (const button of terrainButtons) assert.equal(button.disabled, true);
    UI.selectTerrain('flat');
    assert.equal(scene.terrain, 'blue_hill');
    scene.finishCountdown();
    UI.selectTerrain('red_hill');
    assert.equal(scene.terrain, 'blue_hill');
    assert.equal(scene.deployments.length, count);
    UI.phase = 'ready'; UI.countdown = true;
    UI.selectTerrain('flat');
    assert.equal(scene.terrain, 'blue_hill');
});

test('report shows map and first damage time; map selection returns to ready without changing armies', () => {
    const { UI, scene, terrainButtons, el } = setup({ query: '?terrain=blue_hill' });
    const armies = snapshot(UI.configs);
    finishBattle(UI);
    assert.equal(UI.phase, 'result');
    assert.equal(el('terrain-result').hidden, false);
    assert.match(el('terrain-report').textContent, /蓝方高地.*4\.5 秒/);
    const starts = scene.starts;
    terrainButtons.find(button => button.dataset.terrain === 'flat').onclick();
    assert.equal(UI.phase, 'ready');
    assert.equal(scene.terrain, 'flat');
    assert.equal(scene.starts, starts);
    assert.deepEqual(snapshot(UI.configs), armies);
});

test('original rematch preserves terrain and swaps armies, formations, both orders, and reserves', () => {
    const { UI, scene, el } = setup({ query: '?terrain=blue_hill' });
    finishBattle(UI);
    el('btn-rematch').onclick();
    assert.equal(scene.terrain, 'blue_hill');
    assert.equal(UI.phase, 'battle');
    assert.equal(scene.starts, 2);
    UI.phase = 'result';
    UI.configs = { red: { infantry: 11 }, blue: { infantry: 27 } };
    UI.orders = { red: 'assault', blue: 'flank' };
    UI.battleOptions.reserves = { red: 4, blue: 0 };
    UI.battleOptions.cavalryOrders = { red: 'direct', blue: 'flank_archers' };
    el('btn-swap').onclick();
    assert.equal(UI.configs.red.infantry, 27);
    assert.equal(UI.configs.blue.infantry, 11);
    assert.equal(UI.orders.red, 'flank');
    assert.equal(UI.battleOptions.reserves.blue, 4);
    assert.deepEqual(snapshot(UI.battleOptions.cavalryOrders), { red: 'flank_archers', blue: 'direct' });
    assert.equal(scene.terrain, 'blue_hill', 'swapping armies cannot mirror the hill');
});

test('adjusting either army retains terrain after clearUnits resets the scene to flat', () => {
    const { UI, scene, el } = setup({ query: '?terrain=red_hill' });
    for (const side of ['red', 'blue']) {
        el('btn-ready-' + side).onclick();
        assert.equal(UI.phase, 'buy-' + side);
        assert.equal(scene.terrain, 'flat', 'mock enforces real clearUnits terrain reset');
        assert.equal(UI.battleOptions.terrain, 'red_hill');
        UI.changeCount(side, 'infantry', 1);
        el('btn-lock').onclick();
        assert.equal(UI.phase, 'ready');
        assert.equal(scene.terrain, 'red_hill');
        assert.equal(UI.configs[side].infantry, 37);
    }
});

test('home, new sandbox, challenge and tactics reset terrain; legacy modes never expose map controls', () => {
    const { UI, scene, el, challenges } = setup();
    for (const reset of [
        () => UI.showHome(), () => UI.resetAll(),
        () => UI.startChallenge(challenges[0].id), () => UI.startTactics('reserve'), () => UI.autoplay('rush')
    ]) {
        UI.startTerrain();
        UI.selectCommand('red', 'cavalry', 'flank_archers');
        reset();
        assert.equal(UI.battleOptions.terrain, 'flat');
        assert.deepEqual(snapshot(UI.battleOptions.cavalryOrders), { red: 'auto', blue: 'auto' });
        assert.equal(scene.terrain, 'flat');
        if (['challenge', 'tactics'].includes(UI.mode)) {
            assert.equal(el('terrain-ready').hidden, true);
            assert.equal(el('terrain-result').hidden, true);
            assert.equal(el('commands-ready').hidden, true);
            assert.equal(el('commands-result').hidden, true);
            UI.selectTerrain('red_hill');
            UI.selectCommand('red', 'cavalry', 'direct');
            assert.equal(UI.battleOptions.terrain, 'flat');
            assert.equal(UI.cavalryOrder('red'), 'auto');
        }
    }
    UI.resetAll();
    UI.configs = { red: { infantry: 2 }, blue: { infantry: 2 } };
    UI.deployArmies();
    assert.equal(el('terrain-ready').hidden, false, 'free battle also supports terrain');
    UI.selectTerrain('red_hill');
    assert.equal(scene.terrain, 'red_hill');
});

test('unknown terrain deep link is ignored and invalid map input cannot alter a ready battle', () => {
    const { UI, scene } = setup({ query: '?terrain=unknown' });
    assert.equal(UI.phase, 'home');
    UI.startTerrain();
    const count = scene.deployments.length;
    UI.selectTerrain('unknown');
    assert.equal(scene.deployments.length, count);
    assert.equal(scene.terrain, 'blue_pass');
});

test('terrain code loads before consumers, but reading UI presets does not require scene globals', () => {
    const terrainScript = page.indexOf('src="js/terrain.js');
    assert.ok(terrainScript >= 0);
    for (const file of ['units', 'game', 'ui']) assert.ok(page.indexOf('src="js/' + file + '.js') > terrainScript);
    assert.ok(page.indexOf('src="js/inspection.js') > page.indexOf('src="js/units.js'));
    assert.ok(page.indexOf('src="js/inspection.js') < page.indexOf('src="js/game.js'));
    assert.ok(page.indexOf('src="js/navigation.js') > terrainScript);
    assert.ok(page.indexOf('src="js/navigation.js') < page.indexOf('src="js/units.js'));
    const presets = vm.runInNewContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\nPRESETS;');
    assert.equal(presets.balance.config.infantry, 150);
});

test('all seven terrain deep links use the map defender and keep neutral terrain symmetric', () => {
    for (const terrain of ['flat', 'red_hill', 'blue_hill', 'red_pass', 'blue_pass', 'forest', 'river']) {
        const { UI, scene, el } = setup({ query: '?terrain=' + terrain });
        assert.equal(UI.mode, 'terrain');
        assert.equal(UI.phase, 'ready');
        assert.equal(scene.terrain, terrain);
        assert.equal(UI.troops('red'), 76);
        assert.deepEqual(snapshot(UI.configs.red), snapshot(UI.configs.blue));
        const defender = terrain.startsWith('red_') ? 'red' : terrain.startsWith('blue_') ? 'blue' : null;
        assert.deepEqual(snapshot(UI.orders), {
            red: defender === 'red' ? 'hold_ground' : 'advance',
            blue: defender === 'blue' ? 'hold_ground' : 'advance'
        });
        assert.deepEqual(snapshot(UI.battleOptions.cavalryOrders), { red: 'auto', blue: 'auto' });
        assert.equal(scene.starts, 0);
        assert.doesNotMatch(el('terrain-ready-description').textContent, /undefined/);
    }
});

test('home entries directly open new maps, with both neutral-map armies advancing', () => {
    const { UI, scene, terrainEntries, el } = setup();
    for (const terrain of ['red_pass', 'forest', 'river']) {
        UI.showHome();
        terrainEntries.find(button => button.dataset.terrainEntry === terrain).onclick();
        assert.equal(scene.terrain, terrain);
        assert.equal(UI.phase, 'ready');
        assert.equal(scene.starts, 0);
        if (terrain === 'red_pass') assert.equal(UI.orders.red, 'hold_ground');
        else assert.deepEqual(snapshot(UI.orders), { red: 'advance', blue: 'advance' });
    }
    assert.match(el('terrain-ready-rules').textContent, /中央桥.*侧桥.*不可走/);
});

test('new map switches preserve armies and commands, expose selected state, and keep terrain fixed on exchange', () => {
    const { UI, scene, terrainButtons, el } = setup({ query: '?terrain=blue_pass' });
    UI.selectCommand('red', 'cavalry', 'flank_archers');
    const armies = snapshot(UI.configs), orders = snapshot(UI.orders);
    for (const terrain of ['forest', 'river', 'red_pass', 'blue_pass']) {
        const button = terrainButtons.find(item => item.dataset.terrain === terrain);
        button.onclick();
        assert.equal(scene.terrain, terrain);
        assert.equal(UI.phase, 'ready');
        assert.deepEqual(snapshot(UI.configs), armies);
        assert.deepEqual(snapshot(UI.orders), orders);
        assert.equal(UI.cavalryOrder('red'), 'flank_archers');
        assert.equal(button.attributes['aria-pressed'], 'true');
        assert.equal(scene.starts, 0);
    }
    assert.match(el('ready-blue-command-description').textContent, /中央坡口.*侧路.*支援.*弓兵/);
    assert.match(el('terrain-ready-rules').textContent, /岩壁不可穿越/);
    UI.selectTerrain('forest');
    assert.match(el('terrain-ready-rules').textContent, /55%.*85%.*林中不能蓄力/);
    assert.doesNotMatch(el('ready-blue-command-description').textContent, /支援存活弓兵/);
    finishBattle(UI);
    assert.match(el('terrain-result-rules').textContent, /林中不能蓄力/);
    UI.rematch(true);
    assert.equal(scene.terrain, 'forest');
    assert.equal(UI.cavalryOrder('blue'), 'flank_archers');
});

test('new terrain remains pending without a scene and cannot change during countdown or battle', () => {
    const { UI, scene, terrainButtons } = setup({ readyScene: false, query: '?terrain=river' });
    UI.selectTerrain('red_pass');
    UI.onSceneReady(scene);
    assert.equal(scene.terrain, 'red_pass');
    assert.deepEqual(snapshot(UI.orders), { red: 'advance', blue: 'advance' }, 'changing a pending map still preserves commands');
    UI.startBattle();
    for (const terrain of ['forest', 'river', 'blue_pass']) {
        const button = terrainButtons.find(item => item.dataset.terrain === terrain);
        assert.equal(button.disabled, true);
        button.onclick();
        assert.equal(scene.terrain, 'red_pass');
    }
    scene.finishCountdown();
    UI.selectTerrain('forest');
    assert.equal(scene.terrain, 'red_pass');
});

test('ready controls independently change either team, preserve armies, and pass copied cavalry options to the engine', () => {
    const { UI, scene, el } = setup({ query: '?terrain=blue_hill' });
    const armies = snapshot(UI.configs);
    const choose = (team, kind, value) => {
        const control = el(`ready-${team}-${kind}`);
        control.value = value;
        control.onchange();
    };
    choose('red', 'cavalry', 'flank_archers');
    choose('blue', 'cavalry', 'direct');
    choose('red', 'army', 'hold_ground');
    assert.equal(UI.phase, 'ready');
    assert.equal(scene.starts, 0);
    assert.deepEqual(snapshot(UI.configs), armies);
    assert.deepEqual(snapshot(UI.orders), { red: 'hold_ground', blue: 'hold_ground' });
    assert.deepEqual(snapshot(UI.battleOptions.cavalryOrders), { red: 'flank_archers', blue: 'direct' });
    assert.deepEqual(scene.deployments.at(-1)[5].cavalryOrders, { red: 'flank_archers', blue: 'direct' });
    assert.match(el('ready-red-command-description').textContent, /侧翼|绕/);
    assert.match(el('ready-red-command-description').textContent, /优先于守位.*其他兵种继续守位/);
    assert.match(el('army-summary').innerHTML, /侧翼袭弓/);
    assert.match(el('army-summary').innerHTML, /正面强冲/);
});

test('buying cavalry commands survive army edits, map changes and rematches', () => {
    const { UI, scene, el } = setup({ query: '?terrain=red_hill' });
    for (const team of ['red', 'blue']) {
        UI.editArmy(team);
        assert.equal(el('cavalry-options').hidden, false);
        const button = el('cavalry-order-row').children.find(child => child.textContent === '侧翼袭弓');
        button.onclick();
        assert.equal(UI.cavalryOrder(team), 'flank_archers');
        assert.match(el('cavalry-description').textContent, /侧翼/);
        UI.changeCount(team, 'cavalry', 1);
        UI.lockTeam();
        assert.equal(UI.phase, 'ready');
    }
    UI.selectTerrain('flat');
    finishBattle(UI);
    UI.rematch();
    assert.deepEqual(snapshot(UI.battleOptions.cavalryOrders), { red: 'flank_archers', blue: 'flank_archers' });
    assert.deepEqual(scene.deployments.at(-1)[5].cavalryOrders, { red: 'flank_archers', blue: 'flank_archers' });
});

test('countdown, battle, wrong-team buying and invalid inputs cannot change commands', () => {
    const { UI, scene, el } = setup({ query: '?terrain=blue_hill' });
    const orders = snapshot(UI.orders);
    const cavalry = snapshot(UI.battleOptions.cavalryOrders);
    for (const [team, kind, value] of [['other', 'army', 'hold_ground'], ['red', 'other', 'direct'], ['red', 'cavalry', 'unknown']]) {
        UI.selectCommand(team, kind, value);
    }
    UI.editArmy('red');
    UI.selectCommand('blue', 'cavalry', 'direct');
    UI.lockTeam();
    UI.startBattle();
    assert.equal(el('ready-red-cavalry').disabled, true);
    assert.equal(el('result-blue-army').disabled, true);
    assert.equal(el('commands-hud').hidden, false);
    assert.match(el('commands-hud').textContent, /红方.*蓝方.*高地守位/);
    UI.selectCommand('red', 'army', 'hold_ground');
    scene.finishCountdown();
    UI.selectCommand('red', 'cavalry', 'direct');
    UI.phase = 'ready'; UI.countdown = true;
    UI.selectCommand('blue', 'cavalry', 'flank_archers');
    assert.deepEqual(snapshot(UI.orders), orders);
    assert.deepEqual(snapshot(UI.battleOptions.cavalryOrders), cavalry);
});

test('result controls show the played commands and changing one returns to ready without autoplay', () => {
    const { UI, scene, el } = setup({ query: '?terrain=blue_hill' });
    UI.selectCommand('red', 'cavalry', 'flank_archers');
    finishBattle(UI);
    assert.equal(el('commands-hud').hidden, true);
    assert.equal(el('commands-result').hidden, false);
    assert.match(el('commands-report').textContent, /侧翼袭弓/);
    const starts = scene.starts;
    el('result-red-cavalry').value = 'direct';
    el('result-red-cavalry').onchange();
    assert.equal(UI.phase, 'ready');
    assert.equal(scene.starts, starts);
    assert.equal(UI.cavalryOrder('red'), 'direct');
    assert.equal(scene.terrain, 'blue_hill');
});

test('guard accepts any nonempty army and cavalry controls explain when the army has no cavalry', () => {
    const { UI, el } = setup({ query: '?terrain=red_hill' });
    assert.deepEqual(snapshot(UI.orders), { red: 'hold_ground', blue: 'advance' });
    UI.configs.red = { archer: 5 };
    UI.deployArmies();
    assert.equal(UI.orderAvailability('red').effective, 'hold_ground');
    assert.equal(el('ready-red-cavalry').disabled, true);
    assert.match(el('ready-red-command-description').textContent, /暂无骑兵/);
    UI.editArmy('red');
    UI.clearArmy();
    assert.equal(UI.orderAvailability('red').effective, 'advance');
    assert.match(el('order-description').textContent, /暂无士兵/);
});

test('zero first-contact time renders a valid time while an absent event renders no contact', () => {
    const { UI, el } = setup({ query: '?terrain=flat' });
    const team = { initial: 1, damage: 0, byType: {} };
    for (const [firstContactMs, expected] of [[0, /0\.0 秒/], [null, /未接敌/]]) {
        UI.phase = 'battle';
        UI.onBattleEnd('draw', {
            red: 0, blue: 0, durationMs: 1000, firstContactMs, terrain: 'flat',
            teams: { red: team, blue: team }, events: []
        });
        assert.match(el('terrain-report').textContent, expected);
        assert.doesNotMatch(el('terrain-report').textContent, /NaN|undefined/);
    }
});

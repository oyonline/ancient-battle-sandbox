import test from 'node:test';
import assert from 'node:assert/strict';
import { board } from '../js/board.js';
import { Terrain } from '../js/terrain.js';
import { TerrainNavigation } from '../js/navigation.js';
import { territoryLayout } from '../js/territory-map.js';
import { TERRITORY } from '../js/battle/economy.js';
import { buildBankField } from '../js/render/terrain-naturalness.js';
import { riverFlowMark } from '../js/render/territory-map.js';
import { OverlayRenderer } from '../js/render/overlay.js';

const radius = 0.36;
const CX = () => TERRITORY.W / 2, CY = () => TERRITORY.H / 2;
const BRIDGE_Y = () => Math.round(TERRITORY.H * 2 / 9);
const FORD_Y = () => territoryLayout(TERRITORY.W, TERRITORY.H).fordY;
function onMap(run) {
    const before = { ...board }; board.W = TERRITORY.W; board.H = TERRITORY.H;
    try { run(); } finally { Object.assign(board, before); }
}
function navigation() { return new TerrainNavigation({ battleOptions: { terrain: 'territory' } }); }
function route(nav, from, to, team = 'red') {
    if (Terrain.segmentClear('territory', ...from, ...to, radius)) return [{ gx: to[0], gy: to[1] }];
    return nav.plan({ gx: from[0], gy: from[1], team }, { gx: to[0], gy: to[1] }, radius);
}
function length(from, path) {
    let cost = 0, a = { gx: from[0], gy: from[1] };
    for (const b of path) { cost += Math.hypot(a.gx - b.gx, a.gy - b.gy); a = b; }
    return cost;
}

test('upper objectives face each other across a real bridge; the north cannot be bypassed', () => onMap(() => {
    const { sites, bridge } = territoryLayout(TERRITORY.W, TERRITORY.H), west = sites[0], east = sites[3];
    assert.ok(west.gx < bridge.x1 && east.gx > bridge.x2);
    assert.equal(west.gy, (bridge.y1 + bridge.y2) / 2);
    for (const r of [0.25, 0.36, 0.54, 0.7]) {
        assert.equal(Terrain.segmentClear('territory', west.gx, west.gy, east.gx, east.gy, r), true);
        // 探针 y 全部取水带行：桥区以北、桥区以南到浅滩前
        for (const y of [0.8, BRIDGE_Y() - 8, BRIDGE_Y() - 4, bridge.y2 + 3, FORD_Y() - 4]) {
            assert.equal(Terrain.segmentClear('territory', CX() - 12, y, CX() + 12, y, r), false);
        }
    }
    assert.equal(Terrain.walkable('territory', TERRITORY.W / 2, 0.7), false, 'river closes the north board edge');
}));

test('bridge is the fast upper route; closing it preserves a substantially longer southern detour', () => onMap(() => {
    const a = [CX() - 12, BRIDGE_Y()], b = [CX() + 12, BRIDGE_Y()], direct = length(a, route(navigation(), a, b));
    const geometry = Terrain.geometry('territory'), { bridge } = territoryLayout(TERRITORY.W, TERRITORY.H);
    geometry.blockers.push({ ...bridge, kind: 'water' });
    try {
        const path = route(navigation(), a, b);
        assert.ok(path.length > 1, 'a legal detour remains');
        let last = a;
        for (const point of path) {
            assert.equal(Terrain.walkable('territory', point.gx, point.gy, radius), true);
            assert.equal(Terrain.segmentClear('territory', ...last, point.gx, point.gy, radius), true);
            last = [point.gx, point.gy];
        }
        assert.ok(path.some(p => p.gy >= FORD_Y() - 3), 'detour uses southern ford');
        assert.ok(length(a, path) > direct * 1.35, 'bridge confers an actual distance advantage');
    } finally { geometry.blockers.pop(); }
}));

test('all three objective routes remain accessible and mirrored, including goals behind the river', () => onMap(() => {
    const nav = navigation();
    const pairs = [
        [[CX() - 12, BRIDGE_Y() - 6], [CX() + 12, BRIDGE_Y() - 6]],
        [[CX() - 12, BRIDGE_Y() + 6], [CX() + 12, BRIDGE_Y() + 6]],
        [[7, CY()], [CX() + 12, BRIDGE_Y()]], [[7, CY()], [CX(), CY()]], [[7, CY()], [CX() + 10, CY() + 16]]
    ];
    for (const [a, b] of pairs) {
        const red = route(nav, a, b), blue = route(nav, [TERRITORY.W - a[0], a[1]], [TERRITORY.W - b[0], b[1]], 'blue');
        assert.ok(red.length);
        assert.equal(red.length, blue.length);
        let last = a;
        red.forEach((p, i) => {
            assert.equal(Terrain.segmentClear('territory', ...last, p.gx, p.gy, radius), true);
            assert.ok(Math.abs(p.gx + blue[i].gx - TERRITORY.W) < 1e-9);
            assert.ok(Math.abs(p.gy - blue[i].gy) < 1e-9);
            last = [p.gx, p.gy];
        });
    }
    for (const site of territoryLayout(TERRITORY.W, TERRITORY.H).sites.filter(s => s.role === 'forest')) {
        const surroundings = new Set();
        for (let x=-3;x<=3;x++) for (let y=-3;y<=3;y++) surroundings.add(Terrain.surface('territory',site.gx+x,site.gy+y));
        assert.ok(surroundings.has('grass') && surroundings.has('forest'), 'forest objective sits at the woodland entrance');
    }
}));

test('flow glints stay entirely in real water and leave bridge and simulation untouched', () => onMap(() => {
    const geometry = Terrain.geometry('territory'), before = JSON.stringify(geometry);
    const field = buildBankField(geometry); let visible = 0;
    for (const now of [0, 800, 14000, 60000]) for (let i=0;i<56;i++) {
        const mark = riverFlowMark(field, i, now);
        if (!mark) continue;
        visible++;
        for (let d=0;d<=mark.length;d+=0.025) {
            assert.ok(['water','shallow'].includes(Terrain.surface('territory',mark.gx,mark.gy-d)));
        }
    }
    assert.ok(visible > 50, 'effect is present, not a vacuous mask');
    assert.equal(JSON.stringify(geometry), before);
}));

test('territory benefits appear once and clear on redeploy or switching to score-only control', () => onMap(() => {
    const labels = [];
    const scene = {
        battleOptions: { territory: true }, flags: territoryLayout(TERRITORY.W,TERRITORY.H).sites,
        groundPoint: (x,y) => ({ x,y }), cameras: { main: { zoom: 0.4 } },
        add: { text(_x,_y,text) {
            const label = { text, destroyed: false,
                setOrigin() { return this; }, setDepth() { return this; }, setScale() { return this; },
                destroy() { this.destroyed = true; } };
            labels.push(label); return label;
        } }
    };
    const overlay = new OverlayRenderer(scene);
    overlay.updateFlagLabels(); overlay.updateFlagLabels();
    assert.equal(labels.length, 11, 'no per-frame label creation');
    assert.ok(labels.every(l => l.text.includes('军费 +4/秒')));
    // 本轮起旗标分「地形原有 / 占领奖励」两段：高地地形效果仍然上屏，文案取自 site-traits.js。
    assert.ok(labels.some(l => l.text.includes('地形：') && l.text.includes('居高射程加成')));
    assert.ok(labels.some(l => l.text.includes('占领：')), '占领奖励单独成段');
    scene.flags = territoryLayout(TERRITORY.W,TERRITORY.H).sites;
    overlay.updateFlagLabels();
    assert.equal(labels.filter(l => !l.destroyed).length, 11, 'redeploy replaces old labels');
    scene.battleOptions = { control: true };
    overlay.updateFlagLabels();
    assert.equal(labels.filter(l => !l.destroyed).length, 0, 'score-only mode never claims an income benefit');
}));

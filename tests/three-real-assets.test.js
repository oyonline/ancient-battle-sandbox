import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';

const root = new URL('../', import.meta.url);
const skin = await readFile(new URL('js/three-spike/model-skin.js', root), 'utf8');
const main = await readFile(new URL('js/three-spike/main.js', root), 'utf8');
const expected = [
    'october/sword-standard/infantry-rigged.glb', 'october/pike-standard/spear-rigged.glb',
    'october/archer-standard/archer-rigged.glb', 'october/cavalry-standard/cavalry-rigged.glb',
    'horse/Horse.gltf', 'horse/Horse_White.gltf'
];
for (const file of ['model-skin.js', 'static-probe.js']) {
    const source = await readFile(new URL(`js/three-spike/${file}`, root), 'utf8');
    const constants = source.slice(source.indexOf('const BASE ='), source.indexOf('\n};', source.indexOf('const PATHS =')) + 3);
    const resolve = Function('env', constants.replaceAll('import.meta.env', 'env') + '; return { BASE, PATHS };');
    test(`${file}: BASE respects Vite root and subdirectory deployment`, () => {
        for (const base of ['/', '/sandbox/']) assert.equal(resolve({ BASE_URL: base }).BASE, base + 'assets/units/real/');
        assert.equal(resolve(undefined).BASE, '/assets/units/real/');
    });
    test(`${file}: every PATHS entry is a shipped real asset`, async () => {
        const { PATHS } = resolve({ BASE_URL: '/' });
        assert.deepEqual(Object.values(PATHS), expected);
        for (const path of Object.values(PATHS)) assert.ok((await stat(new URL(`public/assets/units/real/${path}`, root))).isFile());
    });
}
test('ASSETS.md inventories all six files with accurate bytes and sha256', async () => {
    const manifest = await readFile(new URL('public/assets/units/real/ASSETS.md', root), 'utf8');
    const rows = manifest.split('\n').filter(line => /^\| (october|horse)\//.test(line));
    assert.equal(rows.length, 6);
    assert.deepEqual(rows.map(row => row.split('|')[1].trim()), expected);
    for (const row of rows) {
        const [path, source, bytes, hash] = row.split('|').slice(1).map(value => value.trim());
        const actual = await readFile(new URL(`public/assets/units/real/${path}`, root));
        assert.equal(actual.length, Number(bytes));
        assert.equal(createHash('sha256').update(actual).digest('hex'), hash);
        assert.equal(source, `prototypes/model-gallery/assets/${path}`);
    }
});
test('horse glTF files have no uncopied external buffers or images', async () => {
    for (const path of expected.slice(-2)) {
        const gltf = JSON.parse(await readFile(new URL(`public/assets/units/real/${path}`, root)));
        for (const entry of [...(gltf.buffers || []), ...(gltf.images || [])]) {
            assert.ok(!entry.uri || entry.uri.startsWith('data:'));
        }
    }
});
test('production has no Ranger resource fallback and propagates GPU failures to boot', () => {
    assert.doesNotMatch(skin, /rangerFallback|outfits\/|ual[12]\/|props\//i);
    assert.match(skin, /if \(options\.fallbackToLegacy === false\) throw error;/);
    assert.match(main, /fallbackToLegacy: false/);
});

// Execute the production boot branch with a failing facade and real scene objects.
// The rest of boot and its outer error handler are deliberately outside this seam.
const start = main.indexOf("        hud.innerHTML = '加载真模型与动作…'");
const end = main.indexOf('\n}\n', start);
const branch = main.slice(start, end).replace("const { createModelFacade } = await import('./model-skin.js');", 'const { createModelFacade } = injected;');
const bootBranch = new (Object.getPrototypeOf(async function () {}).constructor)('context', `
    const { scene3d, scene, injected, document, console, unitMeshes, corpseMeshes, buildGround } = context;
    const camera = {}, renderer = {}, GPU = true, CAP = {}, TEAM_COLOR = {}, groundH = () => 0, SHADOWS = true;
    const board = { W: 70, H: 70 }, hud = {}, modelToggle = '';
    let modelSkin = null, modelLoadNotice = '';
    if (true) { ${branch}
    return { modelSkin, hud, modelLoadNotice };
`);
for (const reason of ['404 infantry-rigged.glb', '骑手拆分比例异常', 'GPU 初始化抛错']) {
    test(`boot F2: ${reason} removes partial objects, keeps blocks, and completes startup`, async () => {
        const scene3d = new THREE.Scene(), existing = new THREE.Group(); scene3d.add(existing);
        const partial = new THREE.Group(), geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial();
        partial.add(new THREE.Mesh(geometry, material));
        let disposed = 0, groundBuilt = false;
        geometry.addEventListener('dispose', () => disposed++); material.addEventListener('dispose', () => disposed++);
        const warnings = [], block = { visible: false }, corpse = { visible: false }, scene = { units: [], battleStarted: false };
        const result = await bootBranch({ scene3d, scene, unitMeshes: { block }, corpseMeshes: { corpse },
            injected: { async createModelFacade() { scene3d.add(partial); throw new Error(reason); } },
            document: { createElement: () => ({ textContent: '', get outerHTML() { return `<span>${this.textContent}</span>`; } }) },
            console: { warn: (...args) => warnings.push(args) }, buildGround: () => { groundBuilt = true; } });
        assert.equal(result.modelSkin, null);
        assert.deepEqual(scene3d.children, [existing]); assert.equal(disposed, 2);
        assert.equal(block.visible, true); assert.equal(corpse.visible, true);
        assert.equal(scene.battleStarted, true); assert.equal(groundBuilt, true);
        assert.ok(result.hud.innerHTML.includes(`真模型加载失败，已切换方块兵：${reason}`));
        assert.equal(warnings.length, 1);
    });
}

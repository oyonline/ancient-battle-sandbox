import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameStats } from '../js/frame-stats.js';
import { FrameJob, prioritizeChunks } from '../js/render/frame-job.js';
import { TerrainMaterialsRenderer } from '../js/render/terrain-materials.js';
import { NetBattle } from '../js/net/lockstep.js';
import { makeScene } from './battle-harness.js';

test('map work yields within the cooperative budget and cancellation prevents old work', () => {
    let clock = 0, count = 0, cleaned = false;
    function* work() {
        try {
            for (let i = 0; i < 20; i++) { count++; clock += 3; yield i; }
        } finally { cleaned = true; }
    }
    const job = new FrameJob(work(), { budgetMs: 8, now: () => clock });
    assert.equal(count, 0, 'construction does not synchronously build the map');
    job.update();
    assert.equal(count, 3);
    assert.equal(job.workMs, 9);
    job.cancel(); job.update();
    assert.equal(count, 3);
    assert.equal(cleaned, true);
});

test('chunk scheduling starts at the camera and covers the map exactly once', () => {
    const chunks = prioritizeChunks(1200, 750, 512, { x: 1100, y: 700 });
    assert.deepEqual(chunks[0], { x: 1024, y: 512, width: 176, height: 238 });
    assert.equal(new Set(chunks.map(c => `${c.x}:${c.y}`)).size, chunks.length);
    assert.equal(chunks.reduce((n, c) => n + c.width * c.height, 0), 1200 * 750);
});

test('terrain can be abandoned before the first bake without touching textures or canvas', () => {
    const scene = { textures: { exists() { throw new Error('synchronous bake'); } } };
    const renderer = new TerrainMaterialsRenderer(scene);
    renderer.draw();
    assert.equal(scene.terrainLoading, true);
    assert.equal(renderer.bakeJob.done, false);
    renderer.clearGround();
    renderer.updateBake();
    assert.equal(scene.terrainLoading, false);
    assert.equal(renderer.bakeJob, null);
});

test('countdown requested during terrain loading is deferred and cancels with the battle', () => {
    const scene = makeScene();
    scene.terrainLoading = true;
    const done = () => {};
    scene.startCountdown(done);
    assert.deepEqual(scene.pendingCountdown, { battleId: scene.battleId, onDone: done });
    assert.equal(scene.countdownTimers.length, 0);
    scene.cancelCountdown();
    assert.equal(scene.pendingCountdown, null);
});

test('switching terrain or board rebuilds even before the first ground chunk exists', () => {
    const scene = makeScene();
    scene.terrainLoading = true;
    scene._groundTerrain = 'territory';
    let rebuilt = 0;
    scene.render.world.drawGround = () => { rebuilt++; };
    scene.setTerrain('flat');
    assert.equal(rebuilt, 1);
    scene.applyBoardSize();
    assert.equal(rebuilt, 2);
});

test('frame diagnostics are bounded and separate frame latency from simulation cost', () => {
    const stats = new FrameStats(4);
    for (let i = 0; i < 4; i++) stats.record(16, 5, 2);
    stats.record(80, 20, 10);
    const snapshot = stats.snapshot();
    assert.equal(snapshot.samples, 4);
    assert.equal(snapshot.maxMs, 80);
    assert.equal(snapshot.longFrames, 1);
    assert.equal(snapshot.simulationMs, 4);
    assert.equal(snapshot.updateMs, 8.75);
});

test('network buffer counts only consecutive turns with both sides and reports wait duration', () => {
    const net = new NetBattle({ netMySide: 'red' }, { send() {} });
    for (const exec of [0, 47]) net.handle({ t: 'turn', side: 'red', exec, cmds: [] });
    net.noteBuffer();
    assert.equal(net.peerLead, 0);
    net.handle({ t: 'turn', side: 'blue', exec: 0, cmds: [] });
    net.noteBuffer();
    assert.equal(net.peerLead, 1, 'a far-future packet cannot conceal the gap');
    net.noteStall(16); net.noteStall(24);
    assert.equal(net.stallEvents, 1);
    assert.equal(net.waitMs, 40);
    assert.equal(net.longestWaitMs, 40);
    net.noteProgress(); net.noteStall(10);
    assert.equal(net.stallEvents, 2);
    assert.equal(net.waitMs, 50);
    assert.equal(net.longestWaitMs, 40);
});

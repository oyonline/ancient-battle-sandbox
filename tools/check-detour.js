// 行为级验证：绕枪墙全流程
import { makeScene, addUnit } from '../tests/battle-harness.js';

const STEP = 1000 / 60;

function behavior(riderX, wallX, targetX, frames = 360) {
    const scene = makeScene();
    const rider = addUnit(scene, 'red', 'cavalry', riderX, 30);
    const archer = addUnit(scene, 'blue', 'archer', targetX, 30);
    for (const gy of [29.3, 30, 30.7]) addUnit(scene, 'blue', 'pikeman', wallX, gy);
    scene.rebuildSpatial();
    let maxDev = 0;
    for (let i = 0; i < frames; i++) {
        scene.advanceBattle(STEP);
        maxDev = Math.max(maxDev, Math.abs(rider.gy - 30));
        if (rider.dead || archer.dead) break;
    }
    const events = scene.getBattleReport().events.map(e => e.text);
    console.log(`骑${riderX}墙${wallX}弓${targetX}: 骑兵${rider.dead ? '亡' : '存'}(HP=${rider.hp.toFixed(0)}) 弓手${archer.dead ? '亡' : '存'}(HP=${archer.hp.toFixed(0)}) 最大侧偏=${maxDev.toFixed(2)} 枪阵迎击=${events.some(t => t.includes('枪阵迎击'))}`);
}
behavior(19, 24, 30);
behavior(19, 28, 33);
behavior(15, 24, 30);
behavior(19, 26, 30);
behavior(25, 28, 33);

// 斜向冲锋
function diagonal() {
    const scene = makeScene();
    const rider = addUnit(scene, 'red', 'cavalry', 20, 26);
    const archer = addUnit(scene, 'blue', 'archer', 30, 34);
    for (const [x, y] of [[24.5, 29.6], [25.2, 30.3], [24.9, 30.0]]) addUnit(scene, 'blue', 'pikeman', x, y);
    scene.rebuildSpatial();
    let maxDev = 0;
    for (let i = 0; i < 420; i++) {
        scene.advanceBattle(STEP);
        maxDev = Math.max(maxDev, Math.hypot(rider.gx - (20 + i * 0.027), rider.gy - (26 + i * 0.027)));
        if (rider.dead || archer.dead) break;
    }
    const events = scene.getBattleReport().events.map(e => e.text);
    console.log(`斜冲: 骑兵${rider.dead ? '亡' : '存'}(HP=${rider.hp.toFixed(0)}) 弓手${archer.dead ? '亡' : '存'}(HP=${archer.hp.toFixed(0)}) 枪阵迎击=${events.some(t => t.includes('枪阵迎击'))}`);
}
diagonal();

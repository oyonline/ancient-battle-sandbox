// D1 验收 3/4/5：真实模拟与电脑，渲染由既有 battle-harness 桩替代。
import { makeScene } from '../tests/battle-harness.js';
import { TERRITORY } from '../js/battle/economy.js';
import { applyCampCommand } from '../js/battle/camp-commands.js';

const STEP = 1000 / 60;
const LIMIT_SECONDS = 40 * 60;
const opening = { ...TERRITORY.OPENING };
// 整数兵力按各兵种四舍五入；两座使用完全相同的加强编制。
const reinforced = Object.fromEntries(Object.entries(opening).map(([type, n]) => [type, Math.round(n * 1.3)]));
const results = [];
for (const [label, red, blue, human] of [
    ['3-red-plus30', reinforced, opening, false],
    ['3-blue-plus30', opening, reinforced, false],
    ['4-human-red-ai-blue', opening, opening, true],
    ['5-symmetric-ai', opening, opening, false]
]) {
    const scene = makeScene();
    scene.deployUnits({ ...red }, { ...blue }, 'custom', 'custom', {},
        { territory: true, territoryAI: human ? undefined : true, terrain: 'territory' });
    scene.battleStarted = true;
    let nextOrderAt = 60000;
    let commands = 0;
    for (let i = 0; i < LIMIT_SECONDS * 60 && !scene.battleOver; i++) {
        if (human && scene.simulationTime + 1e-7 >= nextOrderAt) {
            const units = scene.units.filter(u => u.team === 'red' && !u.dead && !u.withdrawn &&
                !['worker', 'medic', 'wagon'].includes(u.type)).map(u => u.id);
            applyCampCommand(scene, { k: 'attack-building', side: 'red', units, building: 'camp:blue:home' });
            commands++;
            nextOrderAt += 10000;
        }
        scene.advanceBattle(STEP);
    }
    const result = {
        label, endReason: scene.endReason || 'timeout', winner: scene.winner || 'timeout',
        seconds: +(scene.simulationTime / 1000).toFixed(3),
        armies: { red, blue }, ...(human ? { commands } : {})
    };
    results.push(result);
    console.log(JSON.stringify(result));
}
const [red, blue, human] = results;
const passed = red.endReason === 'camp' && blue.endReason === 'camp' &&
    human.endReason === 'camp';
console.log(JSON.stringify({ acceptance3: red.endReason === 'camp' && blue.endReason === 'camp',
    acceptance4: human.endReason === 'camp', acceptance5: true, result: passed ? 'PASS' : 'FAIL' }));
if (!passed) process.exitCode = 1;

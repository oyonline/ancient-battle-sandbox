// 枪阵守位（hold）的守区中心必须随棋盘宽度镜像。
// 旧代码把它写死成"红 22 / 蓝 48"——那组数字只在小棋盘（70 格宽）成立，
// 换到领土图（260 格宽）蓝方就被扔到红方半场，一路横穿整张地图。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit, TacticsSystem } from './battle-harness.js';
import { setBoardSize, resetBoardSize, board } from '../js/board.js';
import { TERRITORY } from '../js/battle/economy.js';

function guardsAt(terrain, boardSpec) {
    setBoardSize(boardSpec[0], boardSpec[1], 5);
    const scene = makeScene();
    scene.battleOptions.terrain = terrain;
    const red = addUnit(scene, 'red', 'pikeman', 20, board.H / 2);
    const blue = addUnit(scene, 'blue', 'pikeman', board.W - 20, board.H / 2);
    new TacticsSystem(scene, { red: 'hold', blue: 'hold' });
    return { red: red.gx, blue: blue.gx, width: board.W };
}

test('领土大图：蓝方枪阵守位留在东半场，不会横穿到红方那边', () => {
    const { red, blue, width } = guardsAt('territory', [TERRITORY.W, TERRITORY.H]);
    assert.equal(width, 260);
    assert.ok(red < width / 2, `红方守区应在西半场，实际 gx=${red}`);
    assert.ok(blue > width / 2, `蓝方守区应在东半场，实际 gx=${blue}`);
    assert.equal(width - red, blue, '两侧守区关于棋盘中线镜像');
    resetBoardSize();
});

test('小棋盘：守区中心与历史值一致（红 22 / 蓝 48），改动不改变既有手感', () => {
    const { red, blue, width } = guardsAt('flat', [70, 70]);
    assert.equal(width, 70);
    assert.equal(red, 22);
    assert.equal(blue, 48);
    resetBoardSize();
});

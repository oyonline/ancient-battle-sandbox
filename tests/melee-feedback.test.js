// 兵种出手反馈分流回归：剑士挥砍斩弧 / 枪兵短直刺 / 骑兵冲锋撞击与贴身砍击分开。
// 反馈只随真实命中事件（meleeImpact 由模拟命中结算调用），音效按类分流且同档限频。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
const { Snd } = await import('../js/snd.js');

function fxScene() {
    const scene = makeScene();
    scene._fxBudget = 46;
    scene.lowFX = false;
    scene.groundFX = { add() {} };
    scene.airFX = { add() {} };
    const calls = { slash: 0, thrust: 0, wave: 0, blood: [], snd: [] };
    const fx = scene.render.fx;
    fx.slashArc = () => { calls.slash++; };
    fx.thrustStreak = () => { calls.thrust++; };
    fx.sparkBurst = () => {};
    scene.bloodBurst = (x, y, n) => { calls.blood.push(n); };   // meleeImpact 走场景钩子
    globalThis.Snd = { muted: true, play(name) { calls.snd.push(name); } };
    return { scene, calls, restore() { globalThis.Snd = null; } };
}

function pair(scene, type) {
    const attacker = addUnit(scene, 'red', type);
    const victim = addUnit(scene, 'blue', 'infantry', attacker.gx + 0.8, attacker.gy);
    return { attacker, victim };
}

test('剑士命中走斩弧与 hit 音（默认分流）', () => {
    const { scene, calls, restore } = fxScene();
    try {
        const { attacker, victim } = pair(scene, 'infantry');
        scene.render.fx.meleeImpact(attacker, victim);
        assert.equal(calls.slash, 1, '剑士保留斩弧');
        assert.equal(calls.thrust, 0, '剑士不走直刺');
        assert.equal(calls.wave, 0);
        assert.deepEqual(calls.snd, ['hit']);
        assert.equal(calls.blood[0], 9, '普通近战喷溅量级');
    } finally { restore(); }
});

test('枪兵命中走短直刺与 stab 音（默认分流 + 迎击显式 thrust）', () => {
    const { scene, calls, restore } = fxScene();
    try {
        const { attacker, victim } = pair(scene, 'pikeman');
        scene.render.fx.meleeImpact(attacker, victim);
        assert.equal(calls.thrust, 1, '枪兵默认直刺');
        assert.equal(calls.slash, 0, '枪兵不再冒充斩弧');
        assert.deepEqual(calls.snd, ['stab']);

        scene.render.fx.meleeImpact(attacker, victim, 'thrust');   // 枪阵迎击显式 thrust
        assert.equal(calls.thrust, 2);
        assert.equal(calls.slash, 0);
        assert.deepEqual(calls.snd, ['stab', 'stab']);
    } finally { restore(); }
});

test('骑兵：贴身砍击走斩弧与 hit 音，冲锋撞击才有冲击波与 charge 音', () => {
    const { scene, calls, restore } = fxScene();
    try {
        const { attacker, victim } = pair(scene, 'cavalry');
        const fx = scene.render.fx;
        // 贴身砍击（CombatRules.attack 路径，不传 kind）
        fx.meleeImpact(attacker, victim);
        assert.equal(calls.slash, 1, '贴身砍击是挥砍不是冲撞');
        assert.equal(calls.wave, 0, '贴身砍击不放冲击波');
        assert.deepEqual(calls.snd, ['hit']);

        // 真实冲锋撞击（CavalryAI.impact 路径，显式 charge）
        scene.groundFX.add = () => { calls.wave++; };
        fx.meleeImpact(attacker, victim, 'charge');
        assert.equal(calls.wave, 1, '冲锋撞击保留地面冲击波');
        assert.equal(calls.snd[1], 'charge', '冲锋撞击用重击音');
        assert.equal(calls.blood[1], 14, '冲锋撞击喷溅更重');
    } finally { restore(); }
});

test('近战声部共享预算：混合兵种密集流的总放行不高于旧版单一 hit 水平（真实 Snd 模块）', () => {
    // node 无 AudioContext：tone 会被 ensure() 短路，但仍可数其被调用次数＝放行次数
    const wasMuted = Snd.muted;
    const origTone = Snd.tone;
    const played = [];
    Snd.muted = false;
    Snd.tone = (freq) => { played.push(freq); };
    try {
        // 进程刚启动时 performance.now() 很小，先把上次播放视作很久以前，越过 0 时刻门限
        Snd._last = { melee: -1e9 };
        // 同一秒的密集混合事件流：三轮 hit/stab/charge 交替共 90 次
        for (let i = 0; i < 90; i++) Snd.play(['hit', 'stab', 'charge'][i % 3]);
        assert.ok(played.length <= 2,
            `70ms 共享预算内 90 次混合近战事件至多放行 2 次（旧版单一 hit 同水平），实际 ${played.length}`);
        assert.ok(Snd._last.melee > 0, '近战族应登记共享预算时间戳');

        // 预算窗口过后各音色仍可达：分流不得把某一声部饿死
        Snd._last.melee = performance.now() - 100;
        played.length = 0;
        Snd.play('stab');
        assert.equal(played.length, 1, '窗口过后 stab 正常放行');
        Snd._last.melee = performance.now() - 100;
        played.length = 0;
        Snd.play('charge');
        assert.equal(played.length, 1, '窗口过后 charge 正常放行（单声部）');

        // 非近战音效不占近战预算
        Snd._last = { melee: performance.now(), die: -1e9 };   // 近战预算刚被占用；die 视作久未播放
        played.length = 0;
        Snd.play('die');
        assert.equal(played.length, 1, 'die 有独立预算，不被近战声部挡下');
    } finally {
        Snd.tone = origTone;
        Snd.muted = wasMuted;
        Snd._last = {};
    }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, Group, Bone, Vector3 } from 'three';
import { CombatFeedback } from '../js/three-demo/combat-feedback.js';
import { createFighter, stepSkirmish, separateBodies } from '../js/three-demo/combat-model.js';
import { BattleLine } from '../js/three-demo/battle-line.js';

function visual(unit) {
 const root = new Group(), model = new Group(), chest = new Bone();
 chest.name = unit.kind === 'cavalry' ? 'HorseBody' : 'Chest'; chest.position.y = 1.6;
 model.add(chest); root.add(model); root.position.set(unit.x, .15, unit.z); root.updateMatrixWorld(true);
 return Object.assign(unit, { root, model });
}
const state = units => units.map(({ model, root, ...unit }) => ({ ...unit, pierceHits: [...unit.pierceHits] }));

test('only resolved events emit contact bursts, sampled after the final target pose', () => {
 const scene = new Scene(), effects = new CombatFeedback(scene, () => .15);
 const from = visual(createFighter(0, 'red', 'infantry', -1, 0));
 const target = visual(createFighter(1, 'blue', 'infantry', 1, 0));
 for (const type of ['attack', 'draw', 'shoot', 'cancel-shot', 'cancel-attack']) effects.queue({ type, from, target });
 effects.flush([from, target], 1 / 60); assert.equal(scene.children.length, 0);
 const before = state([from, target]); effects.queue({ type: 'hit', from, target });
 target.root.position.y += .7; target.root.updateMatrixWorld(true);
 effects.flush([from, target], 1 / 60);
 assert.deepEqual(state([from, target]), before);
 assert.ok(effects.inspect().particles.every(p => Math.abs(p.position[1] - 2.45) < 1e-9));
 assert.equal(effects.inspect().created.hit, 4);
 effects.dispose();
});

test('fixed W1 combat state and actual event sequence are unchanged by feedback', () => {
 function army() {
  const units = [];
  for (const [team, side] of [['red', -1], ['blue', 1]]) for (let i = 0; i < 4; i++) {
   const u = createFighter(units.length, team, i === 3 ? 'archer' : 'infantry', side * (4 + Math.floor(i / 2) * 2.2), (i % 2 - .5) * 2.2);
   u.locomotion = true; u.crowd = true; units.push(visual(u));
  }
  separateBodies(units); return units;
 }
 const baseline = army(), candidate = army(), a = new BattleLine(baseline), b = new BattleLine(candidate);
 const scene = new Scene(), effects = new CombatFeedback(scene, () => .15);
 let realHits = 0;
 for (let i = 0; i < 1800; i++) {
  a.update(baseline, 1 / 60, true); b.update(candidate, 1 / 60, true);
  const eventsA = stepSkirmish(baseline, 1 / 60, true, (u, e) => a.intent(u, e));
  const eventsB = stepSkirmish(candidate, 1 / 60, true, (u, e) => b.intent(u, e));
  const summarize = events => events.map(e => ({ type: e.type, from: e.from?.id, target: e.target?.id, unit: e.unit?.id, x: e.x, z: e.z, first: e.first }));
  assert.deepEqual(summarize(eventsB), summarize(eventsA));
  for (const event of eventsB) { effects.queue(event); if (event.type === 'hit' || event.type === 'arrow-hit') realHits++; }
  for (const u of candidate) { u.root.position.set(u.x, .15, u.z); u.root.updateMatrixWorld(true); }
  effects.update(1 / 60); effects.flush(candidate, 1 / 60);
  assert.deepEqual(state(candidate), state(baseline));
 }
 assert.ok(realHits > 0); assert.ok(candidate.some(u => u.hp <= 0));
 assert.ok(effects.inspect().created['arrow-hit'] > 0);
 effects.dispose();
});

test('pause freezes TTL and reset drops queued events before reused fighter IDs', () => {
 const scene = new Scene(), effects = new CombatFeedback(scene, () => 0);
 const from = visual(createFighter(0, 'red', 'infantry', -1, 0)), target = visual(createFighter(1, 'blue', 'infantry', 1, 0));
 effects.queue({ type: 'arrow-hit', from, target }); effects.flush([from, target], 1 / 60);
 const frozen = effects.inspect(); effects.update(0); effects.flush([from, target], 0); assert.deepEqual(effects.inspect(), frozen);
 effects.queue({ type: 'hit', from, target }); effects.clear();
 const replacement = visual(createFighter(1, 'blue', 'infantry', 1, 0)); effects.flush([from, replacement], 1 / 60);
 assert.equal(effects.inspect().active, 0); assert.equal(scene.children.length, 0); assert.equal(effects.inspect().queued, 0);
 effects.dispose();
});

test('particles are capped, finite, expire, and dispose owned materials only', () => {
 const scene = new Scene(), effects = new CombatFeedback(scene, () => 0, { maxParticles: 12, maxEvents: 5 });
 const from = visual(createFighter(0, 'red', 'infantry', -1, 0)), target = visual(createFighter(1, 'blue', 'infantry', 1, 0));
 for (let i = 0; i < 20; i++) effects.queue({ type: 'hit', from, target }); effects.flush([from, target], 1 / 60);
 assert.equal(effects.inspect().active, 12); assert.ok(effects.inspect().dropped > 0);
 assert.ok(effects.inspect().particles.every(p => p.position.every(Number.isFinite)));
 let disposed = 0; for (const mesh of scene.children) mesh.material.addEventListener('dispose', () => disposed++);
 effects.update(1); assert.equal(scene.children.length, 0); assert.equal(disposed, 12);
 const modelChildren = target.model.children.length; effects.dispose(); effects.dispose(); assert.equal(target.model.children.length, modelChildren);
});

test('charge continuation is smaller and a real death emits only one late settling cue', () => {
 const scene = new Scene(), effects = new CombatFeedback(scene, () => 0);
 const from = visual(createFighter(0, 'red', 'cavalry', -1, 0)), target = visual(createFighter(1, 'blue', 'infantry', 1, 0));
 effects.queue({ type: 'charge', from, target, x: 1, z: 0, nx: 1, nz: 0, first: true });
 effects.queue({ type: 'charge', from, target, x: 1, z: 0, nx: 1, nz: 0, first: false });
 effects.flush([from, target], 1 / 60);
 assert.equal(effects.inspect().created['charge-first'], 6); assert.equal(effects.inspect().created['charge-follow'], 3);
 target.hp = -1; target.deathTime = .4; effects.queue({ type: 'death', unit: target }); effects.flush([from, target], 1 / 60);
 assert.equal(effects.inspect().created.death, undefined);
 target.deathTime = .9; effects.flush([from, target], 1 / 60); effects.flush([from, target], 1 / 60);
 assert.equal(effects.inspect().created.death, 3); effects.dispose();
});

test('hoof dust requires real displacement and a skinned sole near the terrain', async () => {
 const { readFile } = await import('node:fs/promises');
 const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
 const { updateSkinMatrices } = await import('../js/three-demo/animation-controller.js');
 const bytes = await readFile(new URL('../public/assets/3d-sample/cavalry-standard/cavalry-rigged.glb', import.meta.url));
 const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
 const unit = createFighter(0, 'red', 'cavalry', 0, 0); unit.model = gltf.scene; unit.root = new Group(); unit.root.add(unit.model);
 unit.root.position.y = .15; unit.moving = true; updateSkinMatrices(unit.model);
 const scene = new Scene(), effects = new CombatFeedback(scene, () => .15);
 effects.flush([unit], 1 / 60); effects.flush([unit], 1 / 60); assert.equal(effects.inspect().created.hoof, undefined);
 unit.x += .08; unit.root.position.x = unit.x; updateSkinMatrices(unit.model); effects.flush([unit], 1 / 60);
 assert.ok(effects.inspect().created.hoof > 0);
 effects.clear(); unit.model.position.y = 1; updateSkinMatrices(unit.model); effects.flush([unit], 1 / 60);
 unit.x += .08; unit.root.position.x = unit.x; updateSkinMatrices(unit.model); effects.flush([unit], 1 / 60);
 assert.equal(effects.inspect().created.hoof, undefined); effects.dispose();
});

test('F2 uses the final victim footprint after event knockback/separation and keeps terrain sources low', () => {
 const terrain = (x, z) => .15 + x * .02 - z * .01;
 const viewer = new Vector3(21, 26, 32), viewerBefore = viewer.toArray();
 const effects = new CombatFeedback(new Scene(), terrain, { chargeCandidate: true, chargeView: viewer });
 const from = visual(createFighter(0, 'red', 'cavalry', -4, 0)), target = visual(createFighter(1, 'blue', 'cavalry', 1, 0));
 const event = { type: 'charge', from, target, x: 1, z: 0, nx: 1, nz: 0, first: true };
 effects.queue(event);
 target.x = 1.84; target.z = .15; target.root.position.set(target.x, terrain(target.x, target.z), target.z); target.root.updateMatrixWorld(true);
 const before = state([from, target]); effects.flush([from, target], 1 / 60);
 const record = effects.inspect().recent.find(e => e.type === 'charge-first');
 assert.deepEqual(record.position, [1.84, terrain(1.84, .15), .15]); assert.deepEqual(record.eventXZ, [1, 0]);
 const dust = effects.inspect().particles.filter(p => p.type === 'charge-first');
 assert.equal(dust.length, 6); assert.ok(dust.some(p => p.position[2] > .15) && dust.some(p => p.position[2] < .15));
 assert.ok(dust.every(p => Math.abs(p.position[1] - terrain(p.position[0], p.position[2]) - .12) < 1e-9));
 assert.deepEqual(state([from, target]), before); assert.deepEqual(viewer.toArray(), viewerBefore);
 assert.ok(effects.particles.every(p => p.mesh.material.depthTest)); effects.dispose();
});

test('F2 first contact exceeds continuation and same-frame death keeps its native state', () => {
 const from = visual(createFighter(0, 'red', 'cavalry', -4, 0)), target = visual(createFighter(1, 'blue', 'infantry', 1, 0));
 target.hp = -1; target.deathTime = 0; target.animation = { state: 'death', actions: new Map() };
 const scene = new Scene(), effects = new CombatFeedback(scene, () => .15, { chargeCandidate: true });
 effects.queue({ type: 'charge', from, target, x: 1, z: 0, nx: 1, nz: 0, first: true });
 effects.queue({ type: 'death', unit: target }); effects.flush([from, target], 1 / 60);
 const first = effects.inspect(); assert.equal(target.animation.state, 'death'); assert.equal(first.created['charge-cue'], 4);
 effects.update(0); assert.deepEqual(effects.inspect(), first);
 effects.update(.5); assert.equal(scene.children.length, 0);
 effects.clear(); effects.queue({ type: 'charge', from, target, x: 1, z: 0, nx: 1, nz: 0, first: false }); effects.flush([from, target], 1 / 60);
 const follow = effects.inspect(); assert.equal(follow.created['charge-follow'], 3); assert.equal(follow.created['charge-cue'], 2);
 assert.ok(Math.max(...first.particles.map(p => p.opacity)) > Math.max(...follow.particles.map(p => p.opacity)));
 effects.clear(); assert.equal(effects.inspect().active, 0); assert.equal(effects.inspect().queued, 0); effects.dispose();
});

test('F2 disabled retains F1 event-position charge and linear particle lifetime', () => {
 const from = visual(createFighter(0, 'red', 'cavalry', -4, 0)), target = visual(createFighter(1, 'blue', 'cavalry', 1.84, .15));
 const effects = new CombatFeedback(new Scene(), () => .15);
 effects.queue({ type: 'charge', from, target, x: 1, z: 0, nx: 1, nz: 0, first: true }); effects.flush([from, target], 1 / 60);
 const born = effects.inspect(); assert.deepEqual(born.recent[0].position, [1, 0, 0]); assert.equal(born.created.hit, 4); assert.equal(born.created['charge-cue'], undefined);
 effects.update(.1); const dust = effects.inspect().particles.find(p => p.type === 'charge-first');
 assert.ok(Math.abs(dust.opacity - .32 * (1 - .1 / .48)) < 1e-9); effects.dispose();
});

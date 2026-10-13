import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, Group, Bone } from 'three';
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

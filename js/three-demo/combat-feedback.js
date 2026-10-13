import * as THREE from 'three';

const HIT_TYPES = new Set(['hit', 'arrow-hit', 'charge', 'death']);
const UP = new THREE.Vector3(0, 1, 0);
const finite = v => Number.isFinite(v.x + v.y + v.z);

// Visuals consume resolved events and final world poses. No fighter or material
// belonging to a soldier is changed here; all rendered resources are owned.
export class CombatFeedback {
 constructor(scene, heightAt, { maxParticles = 128, maxEvents = 64 } = {}) {
  this.scene = scene; this.heightAt = heightAt;
  this.maxParticles = maxParticles; this.maxEvents = maxEvents;
  this.events = []; this.particles = []; this.deaths = new Map();
  this.horses = new Map(); this.hoofVertices = new WeakMap();
  this.shardGeometry = new THREE.ConeGeometry(1, 1, 3);
  this.dustGeometry = new THREE.IcosahedronGeometry(1, 0);
  this.created = {}; this.received = {}; this.dropped = 0; this.sequence = 0;
  this.recent = []; this.disposed = false;
 }
 queue(event) {
  if (this.disposed || !HIT_TYPES.has(event.type)) return;
  this.received[event.type] = (this.received[event.type] ?? 0) + 1;
  if (this.events.length >= this.maxEvents) { this.dropped++; return; }
  this.events.push({ type: event.type, from: event.from, target: event.target,
   unit: event.unit, x: event.x, z: event.z, nx: event.nx, nz: event.nz, first: event.first });
 }
 anchor(unit) {
  if (!unit?.model) return null;
  const bone = unit.model.getObjectByName(unit.kind === 'cavalry' ? 'HorseBody' : 'Chest')
   ?? unit.model.getObjectByName('Spine');
  const point = bone ? bone.getWorldPosition(new THREE.Vector3())
   : unit.root.getWorldPosition(new THREE.Vector3()).addScaledVector(UP, 1.4);
  return finite(point) ? point : null;
 }
 direction(event) {
  const x = event.nx ?? ((event.target?.x ?? event.x) - (event.from?.x ?? event.x));
  const z = event.nz ?? ((event.target?.z ?? event.z) - (event.from?.z ?? event.z));
  const result = new THREE.Vector3(x, 0, z);
  if (!finite(result) || result.lengthSq() < 1e-8)
   result.set(Math.sin(event.from?.heading ?? 0), 0, Math.cos(event.from?.heading ?? 0));
  return result.normalize();
 }
 spawn(type, point, velocity, size, life, color, opacity, shard = false) {
  if (!finite(point) || !finite(velocity) || !Number.isFinite(size + life)) return;
  if (this.particles.length >= this.maxParticles) { this.dropped++; return; }
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity,
   depthWrite: false, fog: true });
  const mesh = new THREE.Mesh(shard ? this.shardGeometry : this.dustGeometry, material);
  mesh.position.copy(point);
  mesh.scale.set(size * (shard ? .22 : 1), size, size * (shard ? .22 : .8));
  if (shard) mesh.quaternion.setFromUnitVectors(UP, velocity.clone().normalize());
  mesh.renderOrder = 2;
  this.scene.add(mesh);
  this.particles.push({ mesh, velocity, life, remaining: life, opacity, shard,
   initialScale: mesh.scale.clone(), type });
  this.created[type] = (this.created[type] ?? 0) + 1;
 }
 impact(event) {
  const point = this.anchor(event.target); if (!point) return;
  const direction = this.direction(event);
  // A resolved hit is displayed on the facing side of the victim. This is a
  // presentation anchor, not a claim of mesh/arrow collision at this bone.
  point.addScaledVector(direction, event.target.kind === 'cavalry' ? -1.05 : -.43);
  const lateral = new THREE.Vector3(direction.z, 0, -direction.x);
  const count = event.type === 'arrow-hit' ? 3 : 4;
  for (let i = 0; i < count; i++) {
   const side = (i - (count - 1) / 2) * .52;
   const velocity = direction.clone().multiplyScalar(-1.0)
    .addScaledVector(lateral, side).addScaledVector(UP, .55 + i * .16);
   this.spawn(event.type, point.clone(), velocity, .28 + (i % 2) * .12,
    event.type === 'arrow-hit' ? .22 : .19, i % 2 ? '#c8b083' : '#e4dfce', .9, true);
  }
  this.record(event.type, point, { target: event.target.id });
 }
 dust(type, point, direction, count, strength = 1) {
  const lateral = new THREE.Vector3(direction.z, 0, -direction.x);
  for (let i = 0; i < count; i++) {
   const side = (i - (count - 1) / 2) / Math.max(1, count - 1);
   const origin = point.clone().addScaledVector(lateral, side * .6 * strength);
   origin.y = this.heightAt(origin.x, origin.z) + .11;
   const velocity = direction.clone().multiplyScalar(.65 * strength)
    .addScaledVector(lateral, side * .65).addScaledVector(UP, .45 + (i % 3) * .15);
   this.spawn(type, origin, velocity, (.18 + (i % 3) * .08) * strength,
    .48 + (i % 2) * .1, '#9b947c', .32);
  }
  this.record(type, point, { count, strength });
 }
 record(type, point, detail) {
  this.recent.push({ sequence: ++this.sequence, type, position: point.toArray(), ...detail });
  if (this.recent.length > 32) this.recent.shift();
 }
 // Hoof bone origins are above the sole. Cache actual skinned hoof vertices
 // instead of treating a bone origin as a ground-contact point.
 hoofCatalog(model) {
  if (this.hoofVertices.has(model)) return this.hoofVertices.get(model);
  const catalog = new Map();
  model.traverse(mesh => {
   if (!mesh.isSkinnedMesh) return;
   const indices = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
   for (let i = 0; i < indices.count; i++) {
    let component = 0;
    for (let j = 1; j < 4; j++) if (weights.getComponent(i, j) > weights.getComponent(i, component)) component = j;
    const name = mesh.skeleton.bones[indices.getComponent(i, component)].name;
    if (!/^HorseHoof/.test(name)) continue;
    if (!catalog.has(name)) catalog.set(name, []);
    catalog.get(name).push({ mesh, index: i });
   }
  });
  this.hoofVertices.set(model, catalog); return catalog;
 }
 horseDust(unit, dt) {
  const previous = this.horses.get(unit);
  this.horses.set(unit, { x: unit.x, z: unit.z, cooldown: Math.max(0, (previous?.cooldown ?? 0) - dt) });
  if (!previous || unit.hp <= 0) return;
  const dx = unit.x - previous.x, dz = unit.z - previous.z, distance = Math.hypot(dx, dz);
  if (!unit.moving || distance < .002 || distance / dt < 1.4 || previous.cooldown > 0) return;
  const contacts = [], vertex = new THREE.Vector3();
  for (const vertices of this.hoofCatalog(unit.model).values()) {
   let lowest = Infinity, contact = null;
   for (const { mesh, index } of vertices) {
    mesh.getVertexPosition(index, vertex).applyMatrix4(mesh.matrixWorld);
    const gap = vertex.y - this.heightAt(vertex.x, vertex.z);
    if (gap < lowest) { lowest = gap; contact = vertex.clone(); }
   }
   if (lowest >= -.015 && lowest <= .075 && contact) contacts.push(contact);
  }
  if (!contacts.length) return;
  const direction = new THREE.Vector3(-dx, 0, -dz).normalize();
  // At most two small puffs per horse per .14 seconds, only at a low hoof.
  for (const point of contacts.slice(0, 2)) this.dust('hoof', point, direction, 1, .65);
  this.horses.get(unit).cooldown = .14;
 }
 flush(units, dt) {
  if (this.disposed || !(dt > 0)) return;
  const present = new Set(units);
  for (const unit of this.horses.keys()) if (!present.has(unit)) this.horses.delete(unit);
  for (const event of this.events) {
   const actor = event.type === 'death' ? event.unit : event.target;
   if (!present.has(actor)) continue;
   if (event.type === 'death') this.deaths.set(actor, { emitted: false });
   else if (event.type === 'charge') {
    const point = new THREE.Vector3(event.x, 0, event.z), direction = this.direction(event);
    this.dust(event.first ? 'charge-first' : 'charge-follow', point, direction,
     event.first ? 6 : 3, event.first ? 1.3 : .8);
    this.impact({ ...event, type: 'hit' });
   } else this.impact(event);
  }
  this.events.length = 0;
  for (const [unit, state] of this.deaths) {
   if (!present.has(unit) || unit.hp > 0) { this.deaths.delete(unit); continue; }
   const phase = unit.animation?.actions.get('death')?.time ?? unit.deathTime ?? 0;
   if (state.emitted || phase < .85) continue;
   const point = this.anchor(unit);
   if (point) this.dust('death', point, new THREE.Vector3(Math.sin(unit.heading), 0, Math.cos(unit.heading)), 3, .8);
   state.emitted = true;
  }
  for (const unit of units) if (unit.kind === 'cavalry') this.horseDust(unit, dt);
 }
 update(dt) {
  if (this.disposed || !(dt > 0)) return;
  for (let i = this.particles.length - 1; i >= 0; i--) {
   const particle = this.particles[i]; particle.remaining -= dt;
   if (particle.remaining <= 0) { this.remove(i); continue; }
   particle.mesh.position.addScaledVector(particle.velocity, dt);
   const progress = 1 - particle.remaining / particle.life;
   particle.mesh.material.opacity = particle.opacity * (1 - progress);
   if (!particle.shard) particle.mesh.scale.copy(particle.initialScale).multiplyScalar(1 + progress * .9);
  }
 }
 remove(index) {
  const { mesh } = this.particles[index]; this.scene.remove(mesh); mesh.material.dispose(); this.particles.splice(index, 1);
 }
 clear() {
  for (let i = this.particles.length - 1; i >= 0; i--) this.remove(i);
  this.events.length = 0; this.deaths.clear(); this.horses.clear(); this.hoofVertices = new WeakMap();
  this.created = {}; this.received = {}; this.recent.length = 0; this.dropped = 0; this.sequence = 0;
 }
 inspect() {
  return { active: this.particles.length, queued: this.events.length, trackedDeaths: this.deaths.size,
   trackedHorses: this.horses.size, created: { ...this.created }, received: { ...this.received }, dropped: this.dropped,
   recent: this.recent.map(event => ({ ...event, position: [...event.position] })),
   particles: this.particles.map(p => ({ type: p.type, remaining: p.remaining, position: p.mesh.position.toArray(), opacity: p.mesh.material.opacity })) };
 }
 dispose() {
  if (this.disposed) return; this.clear(); this.shardGeometry.dispose(); this.dustGeometry.dispose(); this.disposed = true;
 }
}

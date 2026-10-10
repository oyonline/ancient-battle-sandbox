import { AnimationMixer, LoopOnce, LoopRepeat, Box3, Vector3, Sphere } from 'three';

function refreshSkinWorld(model) {
 // updateWorldMatrix alone does not refresh SkinnedMesh attached bind inverses.
 model.parent?.updateWorldMatrix(true, false);
 model.updateMatrixWorld(true);
}

const boundsCache = new WeakMap();
const REQUIRED = ['idle', 'walk', 'attack', 'hit', 'death'];

// Sample every exported key and midpoint once, with extra padding for the
// rotational arc between keys. Instance raycasts still use actual skin vertices.
export function prepareClipBounds(model, clips) {
 let cached = boundsCache.get(clips);
 const meshes=[];model.traverse(object=>{if(object.isSkinnedMesh)meshes.push(object);});
 if (!cached) {
  cached = new Map(meshes.map(mesh=>[mesh.geometry,new Box3()]));
  const saved=[];model.traverse(object=>saved.push([object,object.position.clone(),object.quaternion.clone(),object.scale.clone()]));
  const mixer=new AnimationMixer(model),vertex=new Vector3();
  for(const clip of clips){
   const action=mixer.clipAction(clip);action.setLoop(LoopOnce,1);action.clampWhenFinished=true;action.play();
   const keys=new Set([0,clip.duration]);for(const track of clip.tracks)for(const t of track.times)keys.add(t);
   const times=[...keys].sort((a,b)=>a-b);const samples=[...times];for(let i=1;i<times.length;i++)samples.push((times[i-1]+times[i])/2);
   for(const time of samples){mixer.setTime(time);refreshSkinWorld(model);for(const mesh of meshes){mesh.skeleton.update();const box=cached.get(mesh.geometry);for(let i=0;i<mesh.geometry.attributes.position.count;i++){mesh.getVertexPosition(i,vertex);box.expandByPoint(vertex);}}}
   action.stop();
  }
  mixer.stopAllAction();mixer.uncacheRoot(model);
  for(const [object,position,quaternion,scale]of saved){object.position.copy(position);object.quaternion.copy(quaternion);object.scale.copy(scale);}
  refreshSkinWorld(model);
  // A padded union covers all five actions, including lying corpses and sword arcs.
  cached=new Map([...cached].map(([geometry,box])=>[geometry,box.expandByScalar(.5).getBoundingSphere(new Sphere() )]));
  boundsCache.set(clips,cached);
 }
 for(const mesh of meshes)mesh.boundingSphere=cached.get(mesh.geometry).clone();
 return cached;
}

// One controller and mixer per cloned skeleton. Shared clips remain immutable.
export class AnimationController {
 constructor(model, clips) {
  this.model = model;
  let skinned = false;
  model.traverse(object => { if (object.isSkinnedMesh) skinned = true; });
  if (!skinned) throw new Error('Rigged soldier must contain a skinned mesh');
  const available = new Map(clips.map(clip => [clip.name.toLowerCase(), clip]));
  for (const name of REQUIRED) if (!available.has(name)) throw new Error(`Missing soldier animation: ${name}`);
  prepareClipBounds(model, clips);
  this.mixer = new AnimationMixer(model);
  this.actions = new Map([...available].map(([name, clip]) => [name, this.mixer.clipAction(clip)]));
  this.state = null;
  this.oneShot = null;
  this.dead = false;
  this.deathComplete = false;
  this.disposed = false;
  this.onFinished = event => {
   if (event.action !== this.actions.get(this.state)) return;
   if (this.state === 'death') this.deathComplete = true;
   else this.oneShot = null;
  };
  this.mixer.addEventListener('finished', this.onFinished);
  this.play('idle');
 }
 play(name, restart = false) {
  if (this.state === name && !restart) return;
  const previous = this.actions.get(this.state), next = this.actions.get(name);
  next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1);
  const loop=['idle','walk','charge'].includes(name);
  next.setLoop(loop?LoopRepeat:LoopOnce,loop?Infinity:1);
  next.clampWhenFinished=!loop;
  next.play();
  if (previous && previous !== next) next.crossFadeFrom(previous, name === 'death' ? .08 : .12, false);
  this.state = name;
 }
 trigger(name) {
  name = name.toLowerCase();
  if (this.dead || this.disposed) return;
  if (name === 'attack' && this.oneShot === 'hit') return;
  if (!['attack', 'hit', 'death'].includes(name)) throw new Error(`Invalid animation event: ${name}`);
  if (name === 'death') this.dead = true;
  this.oneShot = name;
  this.play(name, true);
 }
 cancelAttack(moving=false) {
  if(this.dead||this.disposed||this.oneShot!=='attack')return;
  this.actions.get('attack').stop();this.oneShot=null;this.play(moving?'walk':'idle');
 }
 update(dt, moving, charging=false) {
  if (this.disposed) return;
  if (!this.dead && !this.oneShot) this.play(moving?(charging&&this.actions.has('charge')?'charge':'walk'):'idle');
  this.mixer.update(dt);
 }
 dispose() {
  if (this.disposed) return;
  this.disposed = true;
  this.mixer.removeEventListener('finished', this.onFinished);
  this.mixer.stopAllAction();
  this.mixer.uncacheRoot(this.model);
  const skeletons = new Set();
  this.model.traverse(object => { if (object.isSkinnedMesh) skeletons.add(object.skeleton); });
  skeletons.forEach(skeleton => skeleton.dispose());
 }
}

export function updateSkinMatrices(model) {
 refreshSkinWorld(model);
 model.traverse(object => { if (object.isSkinnedMesh) { object.skeleton.update(); } });
}

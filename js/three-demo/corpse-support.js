import { Quaternion, Vector3 } from 'three';
import { updateSkinMatrices } from './animation-controller.js';

const up=new Vector3(0,1,0);
const smooth=(value)=>{const t=Math.max(0,Math.min(1,value));return t*t*(3-2*t);};

// Rotate the presentation model, keeping the entity root in its simulation yaw
// frame. Its model.position.y remains world-up because that parent is pure yaw.
export class CorpseSupport {
 constructor(heightAt,{maxAngle=.45}={}){this.heightAt=heightAt;this.maxAngle=maxAngle;this.states=new WeakMap();}
 register(model){
  let state=this.states.get(model);
  if(!state){const bones=[];model.traverse(o=>{if(o.isBone)bones.push(o);});state={base:model.quaternion.clone(),bones,cache:null,last:null};this.states.set(model,state);}
  return state;
 }
 restore(model){const state=this.register(model);model.quaternion.copy(state.base);model.position.y=0;}
 clear(model){const state=this.register(model);this.restore(model);state.cache=null;state.last=null;}
 invalidate(model){this.register(model).cache=null;}
 inspect(model){return this.states.get(model)?.last??null;}
 apply(unit,time,duration,settle){
  const {model,root}=unit,state=this.register(model);
  updateSkinMatrices(model);
  // Finished clips may still receive Q1 corrections. Include their local pose
  // in the cache identity, as well as location/yaw and a manually changed sample.
  const pose=state.bones.flatMap(b=>[...b.position,...b.quaternion,...b.scale]);
  const key=[...root.position,...root.quaternion,...model.scale,time,duration,...pose].join(',');
  if(time>=duration&&state.cache?.key===key){
   model.quaternion.copy(state.cache.quaternion);model.position.y=state.cache.offset;
   updateSkinMatrices(model);return state.last;
  }
  const names=unit.kind==='cavalry'?['HorseBody']:['Hips','Chest'];
  const center=new Vector3();let count=0;
  for(const name of names){const bone=model.getObjectByName(name);if(bone){center.add(bone.getWorldPosition(new Vector3()));count++;}}
  if(count)center.divideScalar(count);else root.getWorldPosition(center);
  const dx=(this.heightAt(center.x+.1,center.z)-this.heightAt(center.x-.1,center.z))/.2;
  const dz=(this.heightAt(center.x,center.z+.1)-this.heightAt(center.x,center.z-.1))/.2;
  const normal=new Vector3(-dx,1,-dz).normalize();
  const fullAngle=Math.atan(Math.hypot(dx,dz));
  const weight=smooth((time-.45)/Math.max(.001,duration-.45));
  const worldTilt=new Quaternion().setFromUnitVectors(up,normal);
  if(fullAngle>this.maxAngle)worldTilt.slerp(new Quaternion(),1-this.maxAngle/fullAngle);
  worldTilt.slerp(new Quaternion(),1-weight);
  const yaw=root.quaternion.clone();
  const local=yaw.clone().invert().multiply(worldTilt).multiply(yaw);
  // The exactly flat case takes the original quaternion and vertical settle.
  model.quaternion.copy(state.base);
  if(fullAngle>1e-8)model.quaternion.premultiply(local);
  updateSkinMatrices(model);settle(unit);updateSkinMatrices(model);
  state.last={center:center.toArray(),normal:normal.toArray(),slopeAngle:fullAngle,
   tiltAngle:Math.min(fullAngle,this.maxAngle)*weight,weight,offset:model.position.y};
  if(time>=duration)state.cache={key,quaternion:model.quaternion.clone(),offset:model.position.y};
  else state.cache=null;
  return state.last;
 }
}

// Dominant-bone/material minima are diagnostics, not an anatomical contact
// proof: brown Chest/Spine geometry can include the archer quiver and strap.
export function corpseRegions(model,heightAt){
 updateSkinMatrices(model);
 const zones={},contacts={},point=new Vector3();let gap=Infinity,finite=true;
 model.traverse(mesh=>{
  if(!mesh.isSkinnedMesh)return;
  const positions=mesh.geometry.attributes.position,weights=mesh.geometry.attributes.skinWeight,indices=mesh.geometry.attributes.skinIndex;
  for(let i=0;i<positions.count;i++){
   mesh.getVertexPosition(i,point).applyMatrix4(mesh.matrixWorld);
   const d=point.y-heightAt(point.x,point.z);gap=Math.min(gap,d);finite=finite&&Number.isFinite(d);
   let k=0;for(let j=1;j<4;j++)if(weights.getComponent(i,j)>weights.getComponent(i,k))k=j;
   const bone=mesh.skeleton.bones[indices.getComponent(i,k)].name;
   const material=mesh.material.name;
   const add=zone=>{if(!zones[zone]||d<zones[zone].gap)zones[zone]={gap:d,bone,material,vertex:i,point:point.toArray()};};
   if(/^(Chest|Spine)$/.test(bone)){
    add('torsoIncludingEquipment');
    if(material==='team_cloth'||material==='ivory linen tabard')add('torsoCloth');
    if(material==='dark forged armour'||material==='charcoal steel mail')add('torsoArmour');
    if(material==='brown leather')add('torsoLeatherIncludingEquipment');
   }
   if(bone==='Hips')add('hips');
   if(/^(Thigh|Shin|Foot)/.test(bone))add('riderOrInfantryLegs');
   if(/^(Head|Neck)$/.test(bone))add('riderOrInfantryHead');
   if(bone==='HorseBody')add('horseBodyIncludingTack');
   if(/^Horse(Upper|Lower|Hoof)/.test(bone))add('horseLegs');
   if(/^Horse(Head|Neck)/.test(bone))add('horseHeadNeck');
   const label=bone+' / '+material;
   if(!contacts[label]||d<contacts[label].gap)contacts[label]={gap:d,vertex:i,point:point.toArray()};
  }
 });
 return {gap,finite,zones,contacts};
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {clone} from 'three/addons/utils/SkeletonUtils.js';
import {AnimationController,updateSkinMatrices} from '../js/three-demo/animation-controller.js';
const slope=(x,z)=>.15+2.5*Math.exp(-((x+5)**2/42+(z+5)**2/50))+.65*Math.exp(-((x-8)**2/55+(z-6)**2/30));
async function fixture(asset,heading,heightAt,contact=true){
 const bytes=await readFile(new URL('../public/assets/3d-sample/'+asset+'.glb',import.meta.url));
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const model=clone(gltf.scene),root=new THREE.Group();root.position.set(-3,heightAt(-3,-1),-1);root.rotation.y=heading;root.add(model);
 const controller=new AnimationController(model,gltf.animations,{locomotion:true,terrainHeight:contact?heightAt:null});return{model,root,controller};
}
for(const asset of ['locomotion1/infantry-rigged','pikeman1/spear-rigged','archer1/archer-rigged']){
 test(`${asset} actual sole contact improves on four terrain orientations without moving the root`,async()=>{
  for(const heading of [0,Math.PI/2,Math.PI,Math.PI*1.5]){
   const f=await fixture(asset,heading,slope),before=f.root.position.clone();f.controller.update(.1,false);updateSkinMatrices(f.model);
   const gaps=f.controller.terrain.inspect().map(x=>x.gap);assert.ok(gaps.every(g=>g>=-.012&&g<=.025),JSON.stringify({heading,gaps}));assert.ok(f.root.position.equals(before));f.controller.dispose();
  }
 });
}
test('flat terrain overlay preserves native/M1 pose exactly and never changes exported clips',async()=>{
 const a=await fixture('locomotion1/infantry-rigged',.8,()=>.15),b=await fixture('locomotion1/infantry-rigged',.8,()=>.15,false);
 for(let i=0;i<180;i++){
  const moving=i>40&&i<120,motion={speed:moving?1.8:0,turnRate:0};a.controller.update(1/60,moving,false,motion);b.controller.update(1/60,moving,false,motion);
  for(const leg of a.controller.feet.legs)for(const bone of [leg.hip,leg.knee,leg.foot])assert.ok(bone.quaternion.equals(b.model.getObjectByName(bone.name).quaternion));
 }
 a.controller.dispose();b.controller.dispose();
});
test('repeated fixed Idle samples restore native constant tracks instead of accumulating slope correction',async()=>{
 const f=await fixture('archer1/archer-rigged',Math.PI,slope);f.controller.update(0,false);const quats=f.controller.feet.legs.flatMap(l=>[l.hip,l.knee,l.foot].map(b=>b.quaternion.clone()));
 for(let i=0;i<150;i++){f.controller.update(0,false);let k=0;for(const l of f.controller.feet.legs)for(const b of [l.hip,l.knee,l.foot]){assert.ok(b.quaternion.toArray().every((v,j)=>Math.abs(v-quats[k].toArray()[j])<1e-8));k++;}}
 f.controller.trigger('death');f.controller.update(2,false);assert.equal(f.controller.terrain.saved.length,0);assert.equal(f.controller.deathComplete,true);f.controller.dispose();
});
test('slope Walk retains swing clearance while limiting ankle correction and pelvis stays authored',async()=>{
 const a=await fixture('pikeman1/spear-rigged',0,slope),b=await fixture('pikeman1/spear-rigged',0,slope,false);let raised=false;
 for(let i=0;i<180;i++){
  a.controller.update(1/60,true,false,{speed:1.8,turnRate:0});b.controller.update(1/60,true,false,{speed:1.8,turnRate:0});updateSkinMatrices(a.model);updateSkinMatrices(b.model);
  for(const leg of a.controller.feet.legs){const native=b.model.getObjectByName(leg.foot.name).getWorldPosition(new THREE.Vector3()),corrected=leg.foot.getWorldPosition(new THREE.Vector3());assert.ok(Math.abs(corrected.y-native.y)<.181);}
  raised ||= a.controller.terrain.inspect().some(f=>f.gap>.025);
  assert.ok(a.model.getObjectByName('Hips').position.equals(b.model.getObjectByName('Hips').position));
 }
 assert.ok(raised,'the swing foot should keep clearance instead of both soles being forced flat');a.controller.dispose();b.controller.dispose();
});

test('moving uphill and downhill does not apply root-height change twice to M1 support anchors',async()=>{
 for(const sign of [-1,1]){
  const f=await fixture('locomotion1/infantry-rigged',sign*Math.PI/2,slope);let support=0;
  for(let i=0;i<120;i++){
   f.root.position.x=-3+sign*i/60*1.8;f.root.position.y=slope(f.root.position.x,f.root.position.z);
   f.controller.update(1/60,true,false,{speed:1.8,turnRate:0});updateSkinMatrices(f.model);
   const action=f.controller.actions.get('walk'),phase=action.time/action.getClip().duration;
   for(const foot of f.controller.terrain.inspect()){const p=(phase+(foot.side==='L'?.5:0))%1;if(p>.1&&p<.4){assert.ok(foot.gap>-.012&&foot.gap<.03,JSON.stringify({sign,i,gap:foot.gap}));support++;}}
  }
  assert.ok(support>40);f.controller.dispose();
 }
});

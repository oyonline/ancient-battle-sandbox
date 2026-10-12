import test from 'node:test';
import assert from 'node:assert/strict';
import { Group, Bone, Vector3 } from 'three';
import { coordinateEvent, syncHeldArrow, flightPose, syncChargeImpact } from '../js/three-demo/action-coordination.js';

test('held arrow follows resolved release and death, not the clip scale interpolation',()=>{
 const model=new Group(),arrow=new Bone();arrow.name='Arrow';model.add(arrow);
 const unit={model,hp:100};coordinateEvent({type:'draw',from:unit});arrow.scale.setScalar(.001);syncHeldArrow(unit);assert.equal(arrow.scale.x,1);
 coordinateEvent({type:'shoot',from:unit});arrow.scale.setScalar(1);syncHeldArrow(unit);assert.equal(arrow.scale.x,.001);
 coordinateEvent({type:'draw',from:unit});syncHeldArrow(unit);assert.equal(arrow.scale.x,1);
 unit.hp=0;syncHeldArrow(unit);assert.equal(arrow.scale.x,.001);
});
test('flight starts at the sampled release point and keeps simulation inputs immutable',()=>{
 const shot={x:1.25,z:0,startX:0,startZ:0,endX:6,endZ:0,vx:12,vz:0,age:0,duration:.5};
 const before=JSON.stringify(shot),origin=new Vector3(.8,2.1,.1),launch={x:shot.x,z:shot.z};
 const first=flightPose(shot,origin,()=>0,launch);assert.ok(first.position.distanceTo(origin)<1e-9);assert.ok(first.tangent.y>0);assert.equal(JSON.stringify(shot),before);
 const final=flightPose({...shot,x:6,z:0,age:.5},origin,()=>0,launch);assert.deepEqual(final.position.toArray(),[6,1.5,0]);assert.ok(final.tangent.y<0);
});
test('resolved charge cancels ordinary thrust but does not replace hit or death',()=>{
 for(const state of ['attack','hit','death']){
  const calls=[],animation={state,dead:state==='death',oneShot:state,cancelAttack(){calls.push('cancel');if(this.oneShot==='attack')this.oneShot=null;},play(name){calls.push(name);}};
  coordinateEvent({type:'charge',from:{animation}});assert.deepEqual(calls,state==='attack'?['cancel','charge']:state==='hit'?['cancel']:[]);
 }
});
test('charge impact remains a small presentation response and skips hit/death',()=>{
 for(const state of ['charge','hit','death']){
  const model=new Group(),chest=new Bone();chest.name='Chest';model.add(chest);const original=chest.quaternion.clone();
  syncChargeImpact({model,kind:'cavalry',chargeFlash:.7,animation:{state,dead:state==='death'}});
  assert.equal(chest.quaternion.equals(original),state!=='charge');if(state==='charge')assert.ok(chest.quaternion.angleTo(original)<=.100001);
 }
});

test('bow-side corpse stays corrected and at its settled height after clamped mixer updates',async()=>{
 const {readFile}=await import('node:fs/promises'),{GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
 const {AnimationController,updateSkinMatrices}=await import('../js/three-demo/animation-controller.js');
 const {restBowArm,restoreBowArm}=await import('../js/three-demo/action-coordination.js');
 const bytes=await readFile(new URL('../public/assets/3d-sample/archer1/archer-rigged.glb',import.meta.url));const g=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const root=new Group();root.add(g.scene);const c=new AnimationController(g.scene,g.animations),u={kind:'archer',model:g.scene,root,animation:c,deathTime:0};c.trigger('death');
 for(let i=0;i<80;i++){u.deathTime+=1/60;restoreBowArm(u);c.update(1/60,false);restBowArm(u);}
 assert.equal(c.deathComplete,true);u.corpseSettled=true;g.scene.position.y=.24;const upper=g.scene.getObjectByName('UpperArmL').quaternion.clone(),hand=g.scene.getObjectByName('HandL').quaternion.clone();
 for(let i=0;i<180;i++){restoreBowArm(u);c.update(1/60,false);restBowArm(u);updateSkinMatrices(g.scene);assert.deepEqual(g.scene.getObjectByName('UpperArmL').quaternion.toArray(),upper.toArray());assert.deepEqual(g.scene.getObjectByName('HandL').quaternion.toArray(),hand.toArray());assert.equal(g.scene.position.y,.24);assert.equal(c.state,'death');}
 c.dispose();
});

test('charge feedback does not accumulate through constant chest keys or leak into hit/death',async()=>{
 const {readFile}=await import('node:fs/promises'),{GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');const {AnimationController}=await import('../js/three-demo/animation-controller.js');const {restoreChargeImpact}=await import('../js/three-demo/action-coordination.js');
 const b=await readFile(new URL('../public/assets/3d-sample/cavalry1/cavalry-rigged.glb',import.meta.url)),g=await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');const c=new AnimationController(g.scene,g.animations),u={model:g.scene,kind:'cavalry',animation:c,chargeFlash:.7},chest=g.scene.getObjectByName('Chest');
 for(let i=0;i<60;i++){restoreChargeImpact(u);c.update(1/60,true,true);u.chargeFlash=Math.max(0,.7-i/60);syncChargeImpact(u);assert.ok(Math.abs(chest.rotation.x)<.30,'impact accumulated beyond native Charge plus 0.10 rad');}
 for(const event of ['hit','death']){restoreChargeImpact(u);c.trigger(event);c.update(.1,false);const native=chest.quaternion.clone();syncChargeImpact(u);assert.deepEqual(chest.quaternion.toArray(),native.toArray());}
 c.dispose();
});

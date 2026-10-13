import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Group, Bone, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AnimationController, updateSkinMatrices } from '../js/three-demo/animation-controller.js';
import { syncHeldArrow, restBowArm, restoreBowArm } from '../js/three-demo/action-coordination.js';
import { CorpseSupport, corpseRegions } from '../js/three-demo/corpse-support.js';

const assets={infantry:'sword-standard/infantry-rigged',pikeman:'pike-standard/spear-rigged',archer:'archer-standard/archer-rigged',cavalry:'cavalry-standard/cavalry-rigged'};
function settle(unit,heightAt){
 unit.model.position.y=0;updateSkinMatrices(unit.model);let lift=-Infinity;
 unit.model.traverse(mesh=>{if(!mesh.isMesh)return;for(let i=0;i<mesh.geometry.attributes.position.count;i++){const p=mesh.getVertexPosition(i,new Vector3()).applyMatrix4(mesh.matrixWorld);lift=Math.max(lift,heightAt(p.x,p.z)+.025-p.y);}});
 unit.model.position.y=lift;updateSkinMatrices(unit.model);
}
async function dead(kind,heightAt){
 const bytes=await readFile(new URL('../public/assets/3d-sample/'+assets[kind]+'.glb',import.meta.url));
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const model=gltf.scene,root=new Group();root.add(model);root.position.set(-3,heightAt(-3,-1),-1);root.rotation.y=.6435011088;
 const animation=new AnimationController(model,gltf.animations),unit={kind,root,model,animation,hp:0,deathTime:0,x:-3,z:-1,heading:.6435011088};
 animation.trigger('death');
 for(let i=0;i<80;i++){unit.deathTime+=1/60;restoreBowArm(unit);animation.update(1/60,false);syncHeldArrow(unit);restBowArm(unit);}
 updateSkinMatrices(model);return unit;
}

test('terrain support normal is correct in world space for four entity yaws',()=>{
 const height=(x,z)=>.2*x+.3*z,normal=new Vector3(-.2,1,-.3).normalize();
 for(const yaw of [0,.6435,Math.PI,3.785]){
  const root=new Group(),model=new Group(),hips=new Bone();hips.name='Hips';model.add(hips);root.add(model);root.rotation.y=yaw;
  const original=root.quaternion.toArray(),support=new CorpseSupport(height);support.register(model);support.restore(model);
  support.apply(Object.freeze({root,model,kind:'infantry',x:0,z:0,heading:yaw}),1.25,1.25,()=>{});
  const actual=new Vector3(0,1,0).applyQuaternion(model.quaternion).applyQuaternion(root.quaternion);
  assert.ok(actual.distanceTo(normal)<1e-12);assert.deepEqual(root.quaternion.toArray(),original);
 }
});

test('four actual models retain the exact original flat corpse quaternion and lift',async()=>{
 for(const kind of Object.keys(assets)){
  const height=()=>.15,u=await dead(kind,height),support=new CorpseSupport(height);support.register(u.model);
  settle(u,height);const old={q:u.model.quaternion.toArray(),y:u.model.position.y,contact:corpseRegions(u.model,height)};
  support.restore(u.model);support.apply(u,1.25,1.25,v=>settle(v,height));
  assert.deepEqual(u.model.quaternion.toArray(),old.q);assert.equal(u.model.position.y,old.y);assert.deepEqual(corpseRegions(u.model,height),old.contact);
  u.animation.dispose();
 }
});

test('finished Q1 corpse support does not accumulate and sample changes invalidate its cache',async()=>{
 const height=(x,z)=>.15+.15*x+.12*z,u=await dead('archer',height),support=new CorpseSupport(height);support.register(u.model);
 const fields={x:u.x,z:u.z,heading:u.heading,hp:u.hp},duration=u.animation.actions.get('death').getClip().duration;
 support.restore(u.model);support.apply(u,duration,duration,v=>settle(v,height));const q=u.model.quaternion.toArray(),y=u.model.position.y;
 for(let i=0;i<30;i++){support.restore(u.model);restoreBowArm(u);u.animation.update(1/60,false);restBowArm(u);support.apply(u,duration,duration,v=>settle(v,height));assert.deepEqual(u.model.quaternion.toArray(),q);assert.equal(u.model.position.y,y);}
 assert.deepEqual({x:u.x,z:u.z,heading:u.heading,hp:u.hp},fields);
 support.clear(u.model);assert.deepEqual(u.model.quaternion.toArray(),[0,0,0,1]);assert.equal(u.model.position.y,0);assert.equal(support.inspect(u.model),null);
 u.root.rotation.y=3.785;u.root.position.x=2;u.root.position.y=height(2,-1);
 support.restore(u.model);support.apply(u,duration,duration,v=>settle(v,height));assert.notDeepEqual(u.model.quaternion.toArray(),q);assert.ok(Math.abs(corpseRegions(u.model,height).gap-.025)<1e-6);
 u.animation.dispose();
});

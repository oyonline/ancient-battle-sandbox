import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { AnimationController, updateSkinMatrices } from '../js/three-demo/animation-controller.js';

function fixture() {
 const root=new THREE.Group(), bone=new THREE.Bone();bone.name='hips';root.add(bone);
 const geometry=new THREE.BufferGeometry();
 geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0],3));
 geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute([0,0,0,0],4));
 geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute([1,0,0,0],4));
 const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshBasicMaterial());root.add(mesh);root.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton([bone]));
 const clips=['Idle','Walk','Attack','Hit','Death'].map((name,i)=>new THREE.AnimationClip(name,1,[new THREE.NumberKeyframeTrack('hips.position[y]',[0,1],[0,i+1])]));
 return {root,clips};
}
test('cloned troops share geometry but have independent skeletons, mixers and poses',()=>{
 const {root,clips}=fixture(),a=clone(root),b=clone(root),ca=new AnimationController(a,clips),cb=new AnimationController(b,clips);
 assert.notEqual(a.children[1].skeleton,b.children[1].skeleton);assert.notEqual(a.children[0],b.children[0]);assert.equal(a.children[1].geometry,b.children[1].geometry);
 ca.update(.3,true);cb.update(.1,false);assert.equal(ca.state,'walk');assert.equal(cb.state,'idle');assert.notEqual(a.children[0].position.y,b.children[0].position.y);
 ca.dispose();cb.dispose();root.children[1].geometry.dispose();root.children[1].material.dispose();
});
test('movement loops do not restart each frame; events play once and return to movement',()=>{
 const {root,clips}=fixture(),c=new AnimationController(root,clips);c.update(.2,true);const t=c.actions.get('walk').time;c.update(.2,true);assert.ok(c.actions.get('walk').time>t);
 c.trigger('attack');c.update(.25,true);const attackTime=c.actions.get('attack').time;c.update(.25,true);assert.equal(c.state,'attack');assert.ok(c.actions.get('attack').time>attackTime);
 c.trigger('hit');assert.equal(c.state,'hit');c.update(1.1,false);c.update(.01,false);assert.equal(c.state,'idle');c.dispose();
});
test('death overrides hit, clamps the final pose and cannot be revived by later events',()=>{
 const {root,clips}=fixture(),c=new AnimationController(root,clips);c.trigger('hit');c.trigger('death');c.update(1.2,false);assert.equal(c.deathComplete,true);assert.equal(c.state,'death');assert.equal(root.children[0].position.y,5);
 c.trigger('attack');c.update(.5,true);assert.equal(c.state,'death');assert.equal(root.children[0].position.y,5);updateSkinMatrices(root);const vertex=new THREE.Vector3();root.children[1].getVertexPosition(0,vertex);assert.equal(vertex.y,5);c.dispose();
});
test('dispose stops actions, uncaches mixer bindings and disposes each shared skeleton once',()=>{
 const {root,clips}=fixture(),c=new AnimationController(root,clips),mesh=root.children[1];root.add(new THREE.SkinnedMesh(mesh.geometry,mesh.material));root.children[2].bind(mesh.skeleton);let disposed=0;mesh.skeleton.dispose=()=>disposed++;
 c.trigger('attack');c.update(.2,false);c.dispose();c.dispose();assert.equal(disposed,1);assert.equal(c.mixer._actions.length,0);assert.equal(c.mixer._bindings.length,0);assert.equal(c.disposed,true);
});
test('missing action contract fails instead of silently faking bone animation',()=>{const {root,clips}=fixture();assert.throws(()=>new AnimationController(root,clips.slice(0,4)),/Missing soldier animation: death/);});

test('mutual attack event order cannot overwrite the active hit reaction',()=>{const {root,clips}=fixture(),c=new AnimationController(root,clips);c.trigger('hit');c.trigger('attack');assert.equal(c.state,'hit');c.update(.2,false);assert.equal(c.state,'hit');c.trigger('death');assert.equal(c.state,'death');c.dispose();});
test('animation clips on an unskinned model do not satisfy the soldier contract',()=>{const {clips}=fixture();assert.throws(()=>new AnimationController(new THREE.Group(),clips),/must contain a skinned mesh/);});

test('shipping infantry GLB supplies independent skinned troops and five real bone clips',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
 const bytes=await readFile(new URL('../public/assets/3d-sample/infantry-rigged.glb',import.meta.url));
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 assert.deepEqual(gltf.animations.map(clip=>clip.name).sort(),['Attack','Death','Hit','Idle','Walk']);
 const a=clone(gltf.scene),b=clone(gltf.scene),ca=new AnimationController(a,gltf.animations),cb=new AnimationController(b,gltf.animations);
 let skinA,skinB;a.traverse(o=>{if(o.isSkinnedMesh&&!skinA)skinA=o;});b.traverse(o=>{if(o.isSkinnedMesh&&!skinB)skinB=o;});
 assert.ok(skinA.skeleton.bones.length>=12);assert.notEqual(skinA.skeleton.bones[0],skinB.skeleton.bones[0]);
 ca.update(.3,true);cb.update(.3,false);updateSkinMatrices(a);updateSkinMatrices(b);
 assert.ok(skinA.skeleton.bones.some((bone,i)=>!bone.quaternion.equals(skinB.skeleton.bones[i].quaternion)));
 ca.trigger('death');ca.update(2,false);updateSkinMatrices(a);assert.equal(ca.deathComplete,true);
 const box=new THREE.Box3();a.traverse(o=>{if(o.isSkinnedMesh){o.computeBoundingBox();box.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld));}});
 assert.ok(box.max.y<1,'death clip must lower the whole soldier instead of retaining a standing body');
 ca.dispose();cb.dispose();
});

test('cached skin spheres cover intermediate frames in all five clips and cross-fades',async()=>{
 const {readFile}=await import('node:fs/promises'),{GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
 const bytes=await readFile(new URL('../public/assets/3d-sample/infantry-rigged.glb',import.meta.url));
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const model=clone(gltf.scene),c=new AnimationController(model,gltf.animations),vertex=new THREE.Vector3();
 const covered=()=>{updateSkinMatrices(model);model.traverse(o=>{if(!o.isSkinnedMesh)return;for(let i=0;i<o.geometry.attributes.position.count;i++){o.getVertexPosition(i,vertex);assert.ok(o.boundingSphere.containsPoint(vertex),'animated vertex escaped cached sphere');}});};
 for(const clip of gltf.animations){c.mixer.stopAllAction();const action=c.actions.get(clip.name.toLowerCase());action.reset().play();for(let i=0;i<=17;i++){c.mixer.setTime(clip.duration*i/17);covered();}}
 c.mixer.stopAllAction();c.oneShot=null;c.state=null;c.play('idle');c.update(.15,true);covered();c.trigger('attack');c.update(.04,true);covered();c.trigger('hit');c.update(.04,false);covered();c.trigger('death');c.update(.04,false);covered();c.dispose();
});

test('cached local skin bounds remain valid under a translated and rotated parent',async()=>{
 const {readFile}=await import('node:fs/promises'),{GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');const bytes=await readFile(new URL('../public/assets/3d-sample/infantry-rigged.glb',import.meta.url));const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const model=clone(gltf.scene),parent=new THREE.Group();parent.position.set(-8,1.5,0);parent.rotation.y=Math.PI/2;parent.add(model);
 const c=new AnimationController(model,gltf.animations),v=new THREE.Vector3();
 const check=()=>{updateSkinMatrices(model);model.traverse(o=>{if(o.isSkinnedMesh)for(let i=0;i<o.geometry.attributes.position.count;i++){o.getVertexPosition(i,v);assert.ok(o.boundingSphere.containsPoint(v),'parent world transform contaminated local bounds');}});};
 c.update(.3,true);check();parent.position.set(6,3,7);parent.rotation.y=-.8;c.update(.2,true);check();c.trigger('death');c.update(2,false);check();c.dispose();
});

test('animated soldier remains pickable after a world translation and turn',async()=>{
 const {readFile}=await import('node:fs/promises'),{GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');const bytes=await readFile(new URL('../public/assets/3d-sample/infantry-rigged.glb',import.meta.url));const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const model=clone(gltf.scene),root=new THREE.Group();root.position.set(-8,1.5,0);root.rotation.y=Math.PI/2;root.add(model);const c=new AnimationController(model,gltf.animations);c.update(.3,true);updateSkinMatrices(model);
 const chest=model.getObjectByName('Chest').getWorldPosition(new THREE.Vector3()),origin=chest.clone().add(new THREE.Vector3(4,2,4));const ray=new THREE.Raycaster(origin,chest.clone().sub(origin).normalize());assert.ok(ray.intersectObject(model,true).length>0);c.dispose();
});

for(const asset of ['spear','archer','cavalry'])test(`${asset} shipping rig supplies all five clips and cached bounds under a transformed parent`,async()=>{
 const {readFile}=await import('node:fs/promises'),{GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');const bytes=await readFile(new URL(`../public/assets/3d-sample/${asset}-rigged.glb`,import.meta.url));const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const model=clone(gltf.scene),root=new THREE.Group();root.position.set(8,2,-4);root.rotation.y=-1.1;root.add(model);const c=new AnimationController(model,gltf.animations),v=new THREE.Vector3();
 assert.deepEqual([...c.actions.keys()].sort(),asset==='cavalry'?['attack','charge','death','hit','idle','walk']:['attack','death','hit','idle','walk']);
 for(const clip of gltf.animations){c.mixer.stopAllAction();c.actions.get(clip.name.toLowerCase()).reset().play();for(const progress of [.15,.48,.83,1]){c.mixer.setTime(clip.duration*progress);updateSkinMatrices(model);model.traverse(o=>{if(o.isSkinnedMesh)for(let i=0;i<o.geometry.attributes.position.count;i++){o.getVertexPosition(i,v);assert.ok(o.boundingSphere.containsPoint(v));}});}}
 if(asset==='cavalry'){c.mixer.stopAllAction();c.state=null;c.oneShot=null;c.update(.2,true,false);assert.equal(c.state,'walk');c.update(1,true,true);assert.equal(c.state,'charge');assert.ok(c.actions.get('charge').isRunning());c.trigger('hit');c.update(.1,true,true);assert.equal(c.state,'hit');c.trigger('death');c.update(2,false);assert.equal(c.deathComplete,true);}
 if(asset==='archer'){c.mixer.stopAllAction();c.actions.get('attack').reset().play();c.mixer.setTime(11/24);assert.ok(model.getObjectByName('Arrow').scale.length()<.01,'bow-held arrow must hide when projectile takes over');}
 c.dispose();
});

test('moving cancels the attack action but cannot interrupt hit or death reactions',()=>{
 const {root,clips}=fixture();const c=new AnimationController(root,clips);c.trigger('attack');c.update(.2,false);c.cancelAttack(true);assert.equal(c.state,'walk');assert.equal(c.oneShot,null);assert.equal(c.actions.get('attack').isRunning(),false);
 c.trigger('hit');c.cancelAttack(true);assert.equal(c.state,'hit');c.trigger('death');c.cancelAttack(true);assert.equal(c.state,'death');c.dispose();
});

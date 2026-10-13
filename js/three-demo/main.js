import * as THREE from 'three';
import { BattleLine } from './battle-line.js';
import { CorpseSupport, corpseRegions } from './corpse-support.js';
import { coordinateEvent, syncHeldArrow, arrowReleasePoint, flightPose, syncChargeImpact, restBowArm, restoreBowArm, restoreChargeImpact } from './action-coordination.js';
import { createMotionQA, createDuelQA, createCrowdQA } from './motion-qa.js';
import { createFighter, stepSkirmish, separateBodies, BODY_RADIUS } from './combat-model.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { AnimationController, updateSkinMatrices } from './animation-controller.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const $ = id => document.getElementById(id);
function showFailure(message) {
 const loading = $('loading'); loading.hidden = false; loading.replaceChildren();
 const text = document.createElement('p'); text.textContent = message; loading.append(text);
 for (const [href, label] of [['battle3d.html', '重新加载'], ['index.html', '返回首页'], ['classic.html', '进入 2D 经典版']]) {
  const link = document.createElement('a'); link.href = href; link.textContent = label; link.style.margin = '0 8px'; loading.append(link);
 }
 $('battle-status').textContent = '3D 战场暂时不可用';
 document.querySelectorAll('.demo-controls button').forEach(button => button.disabled = true);
}
try {
const preview=new URLSearchParams(location.search);
const corpseCandidate=preview.get('corpse')==='candidate';
const corpseComparing=preview.has('corpse');
const modelR2=preview.get('model')==='r2';
const modelBaseline=preview.get('model')==='baseline';
const pikeStandard=preview.get('pike')==='standard';
const bowStandard=preview.get('bow')==='standard';
const rideStandard=preview.get('ride')==='standard';
const qaMode=['single','small','duel','four','sixteen'].includes(preview.get('qa'))?preview.get('qa'):null;
const qaKind=['pikeman','archer','cavalry'].includes(preview.get('unit'))?preview.get('unit'):'infantry';
const frontCandidate=preview.get('front')==='candidate';
const frontApplicable=!['single','duel'].includes(qaMode);
// QA creates only the requested kind: comparison controls describe that actor.
const modelControlRole=qaMode?qaKind:['infantry','pikeman','archer','cavalry'].includes(preview.get('modelRole'))?preview.get('modelRole'):rideStandard?'cavalry':bowStandard?'archer':pikeStandard?'pikeman':'infantry';
const modelControlsActive=preview.has('model')||pikeStandard||bowStandard||rideStandard||preview.has('modelRole')||corpseComparing;
const modelComparing=modelControlsActive&&(preview.get('still')==='1'||preview.has('view'))&&(!qaMode||qaKind===modelControlRole);
const lightCandidate=preview.get('light')==='candidate';
const buildingCandidate=preview.get('building')==='candidate';
const buildingComparing=!modelComparing&&preview.has('building')&&preview.get('still')==='1'&&!preview.has('qa');
const towers=[];
const terrainCandidate=preview.get('terrain')==='candidate';
const terrainComparing=!modelComparing&&!buildingComparing&&preview.has('terrain')&&(preview.get('still')==='1'||preview.has('view'));
const coordinationCandidate=preview.get('coordination')==='candidate';
const rideCandidate=rideStandard||preview.get('ride')==='candidate';
const rideComparing=!modelComparing&&!buildingComparing&&(!qaMode||qaKind==='cavalry')&&preview.has('ride')&&(preview.get('still')==='1'||(!qaMode&&preview.has('view')));
const bowCandidate=bowStandard||preview.get('bow')==='candidate';
const bowComparing=!modelComparing&&!buildingComparing&&(!qaMode||qaKind==='archer')&&preview.has('bow')&&(preview.get('still')==='1'||(!qaMode&&preview.has('view')));
const pikeCandidate=pikeStandard||preview.get('pike')==='candidate';
const pikeComparing=!modelComparing&&!buildingComparing&&(!qaMode||qaKind==='pikeman')&&preview.has('pike')&&(preview.get('still')==='1'||(!qaMode&&preview.has('view')));
const motionCandidate=preview.get('motion')==='candidate';
const duelCandidate=preview.get('duel')==='candidate';
let motionQA,duelQA,crowdQA;
const crowdCandidate=preview.get('crowd')==='candidate';
const comparing=modelComparing||terrainComparing||preview.has('soldier')||pikeComparing||bowComparing||rideComparing;
const r11=comparing&&preview.get('soldier')==='r11';
const candidate=comparing&&(preview.get('soldier')==='candidate'||r11);
const candidateLabel=r11?'候选 R1.1':'候选 R1';
const infantryAssetName=modelR2?'sword-standard/infantry-rigged':modelBaseline||duelCandidate?'duel1/infantry-rigged':motionCandidate?'locomotion1/infantry-rigged':qaMode||r11?'round1-1/infantry-rigged':candidate?'round1/infantry-rigged':'infantry-rigged';
const infantryBaselineLabel='剑盾 D1 基准';
const pikeAssetName=pikeStandard?'pike-standard/spear-rigged':pikeCandidate?'pikeman1/spear-rigged':'spear-rigged';
const bowAssetName=bowStandard?'archer-standard/archer-rigged':bowCandidate?'archer1/archer-rigged':'archer-rigged';
const cavalryAssetName=rideStandard?'cavalry-standard/cavalry-rigged':rideCandidate?'cavalry1/cavalry-rigged':'cavalry-rigged';
const modelRoleLabel={infantry:'剑盾',pikeman:'长矛',archer:'弓兵',cavalry:'骑兵'}[modelControlRole];
const modelAssetName={infantry:infantryAssetName,pikeman:pikeAssetName,archer:bowAssetName,cavalry:cavalryAssetName}[modelControlRole];
const modelControlParam={infantry:'model',pikeman:'pike',archer:'bow',cavalry:'ride'}[modelControlRole];
const modelVariants=modelControlRole==='infantry'?[['baseline',infantryBaselineLabel],['r2','剑盾造型 R2']]:modelControlRole==='pikeman'?[['candidate','长矛 P1 基准'],['standard','长矛造型 P2']]:modelControlRole==='archer'?[['candidate','弓兵 A1 基准'],['standard','弓兵造型 A2']]:[['candidate','骑兵 V1 基准'],['standard','骑兵造型 V2']];
const modelComparisonLabel=modelControlRole==='infantry'?(modelR2?'剑盾造型 R2':infantryAssetName.startsWith('duel1/')?'剑盾 D1 基准':infantryAssetName.startsWith('locomotion1/')?'剑盾 M1 基准':infantryAssetName.startsWith('round1-1/')?'剑盾 R1.1 基准':infantryAssetName.startsWith('round1/')?'剑盾 R1 基准':'剑盾原始基准'):modelControlRole==='pikeman'?(pikeStandard?'长矛造型 P2':pikeCandidate?'长矛 P1 基准':'长矛原始基准'):modelControlRole==='archer'?(bowStandard?'弓兵造型 A2':bowCandidate?'弓兵 A1 基准':'弓兵原始基准'):(rideStandard?'骑兵造型 V2':rideCandidate?'骑兵 V1 基准':'骑兵原始基准');
// C2 is opt-in for the normal battlefield only. Existing fixed comparisons and QA retain their original cameras.
const cameraApplicable=!qaMode&&!comparing&&!buildingComparing&&!preview.has('view')&&preview.get('still')!=='1';
const cameraCandidate=cameraApplicable&&preview.get('camera')==='candidate';
const viewport = $('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#b9c5ab');
scene.fog = new THREE.Fog('#b9c5ab', 110, 200);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.append(renderer.domElement);
const camera = new THREE.PerspectiveCamera(38, 1, .1, 160);
let distance = 43;
const focus = new THREE.Vector3(0, 0, 0);
const direction = new THREE.Vector3(.75, .95, 1).normalize();
function updateCamera() { camera.position.copy(focus).addScaledVector(direction, distance * Math.max(1, 1.35 / camera.aspect)); camera.lookAt(focus); }
function resize() { const { width, height } = viewport.getBoundingClientRect(); renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); updateCamera(); }
const observer = new ResizeObserver(resize); observer.observe(viewport);
// L1 changes only the existing two light sources. Assets, camera and shadow geometry stay fixed.
const hemisphere = new THREE.HemisphereLight(lightCandidate?'#f4f6ff':'#fff5da', lightCandidate?'#62695b':'#556547', lightCandidate?1.45:1.7);
scene.add(hemisphere);
const sun = new THREE.DirectionalLight(lightCandidate?'#fff5e8':'#fff0cb', lightCandidate?1.8:2.0);
sun.position.set(-16, 28, 16); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -26; sun.shadow.camera.right = 26;
sun.shadow.camera.top = 26; sun.shadow.camera.bottom = -26; sun.shadow.normalBias = .04;
scene.add(sun);

function heightAt(x, z) { if(qaMode&&preview.get('terrainScene')!=='slope')return .15;return .15 + 2.5 * Math.exp(-((x + 5) ** 2 / 42 + (z + 5) ** 2 / 50)) + .65 * Math.exp(-((x - 8) ** 2 / 55 + (z - 6) ** 2 / 30)); }
const corpseSupport=corpseCandidate?new CorpseSupport(heightAt):null;
const geometry = new THREE.PlaneGeometry(38, 30, 76, 60); geometry.rotateX(-Math.PI / 2);
const positions = geometry.attributes.position;
const colors = [];
for (let i = 0; i < positions.count; i++) { const x = positions.getX(i), z = positions.getZ(i), y = heightAt(x,z); positions.setY(i,y); const c = new THREE.Color().setHSL(.23 + y*.009,.22,.38+y*.037 + Math.sin(x*.7+z*.4)*.018); colors.push(c.r,c.g,c.b); }
geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors,3)); geometry.computeVertexNormals();
const ground = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({vertexColors:true,roughness:1,flatShading:true})); ground.receiveShadow=true; scene.add(ground);
const base = new THREE.Mesh(new THREE.BoxGeometry(38,1.6,30),new THREE.MeshStandardMaterial({color:'#756d4c',roughness:1}));base.position.y=-.67; scene.add(base);
const rockMaterial = new THREE.MeshStandardMaterial({color:'#8d9277',flatShading:true});
for(let i=0;i<14;i++){ const x=-17+(i*11.7)%34, z=i%2?13:-13; const rock=new THREE.Mesh(new THREE.DodecahedronGeometry(.4+i%3*.12),rockMaterial); rock.position.set(x,heightAt(x,z),z); rock.scale.set(1.5,.7,1); rock.castShadow=true;scene.add(rock); }
const markerGeometry = new THREE.RingGeometry(.55,.64,32); markerGeometry.rotateX(-Math.PI/2);
const bodyRingGeometry=Object.fromEntries(Object.entries(BODY_RADIUS).map(([kind,radius])=>{const g=new THREE.RingGeometry(radius+.04,radius+.11,32);g.rotateX(-Math.PI/2);return [kind,g];}));
const marker = new THREE.Mesh(markerGeometry,new THREE.MeshBasicMaterial({color:'#f5df9d',side:THREE.DoubleSide})); marker.visible=false;scene.add(marker);
const loader = new GLTFLoader();
const units=[]; let templates, team='red', selected=[], fighting=false, paused=false, ready=false, elapsed=0, winner=null,battleLine=null;
const healthStatus = () => ['red','blue'].map(t => `${t==='red'?'红':'蓝'}方 ${units.filter(u=>u.team===t&&u.hp>0).length}`).join(' · ');
function teamColor(t){return t==='red'?'#b84c38':'#487c9c';}
function select(list){ selected=list.filter(u=>u.hp>0); $('selection').textContent = `已选${team==='red'?'红':'蓝'}方 ${selected.length} 名 · 点击地面移动`; for(const u of units)u.ring.visible=selected.includes(u)&&u.hp>0; }
function cloneModel(template,t){const model=cloneSkeleton(template.scene);model.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;const tint=m=>{if(m.name!=='team_cloth')return m;const owned=m.clone();owned.color.set(teamColor(t));return owned;};o.material=Array.isArray(o.material)?o.material.map(tint):tint(o.material);}});return model;}
function createUnit(t,kind,x,z,index){const model=cloneModel(templates[kind],t); const root=new THREE.Group();root.add(model);scene.add(root);root.position.set(x,heightAt(x,z),z);root.rotation.y=t==='red'?Math.PI/2:-Math.PI/2;
 const ring=new THREE.Mesh(bodyRingGeometry[kind],new THREE.MeshBasicMaterial({color:'#f5df9d',side:THREE.DoubleSide}));scene.add(ring);const joints=[];model.traverse(o=>{if(!o.isMesh&&/^(arm_|leg_|horse_leg_|rider$)/.test(o.name))joints.push({object:o,base:o.quaternion.clone(),name:o.name});});
 const u={...createFighter(units.length,t,kind,x,z),root,model,ring,joints,index};u.locomotion=(motionCandidate&&kind==='infantry')||(pikeCandidate&&kind==='pikeman')||(bowCandidate&&kind==='archer');u.crowd=crowdCandidate&&u.locomotion;u.root.rotation.y=u.heading;u.animation=new AnimationController(model,templates[kind].animations,{locomotion:u.locomotion,terrainHeight:terrainCandidate&&u.locomotion?heightAt:null});if(kind==='cavalry'&&!u.animation.actions.has('charge'))throw new Error('Missing cavalry Charge animation');corpseSupport?.register(model);root.userData.unit=u;units.push(u);}
function reset(){
 if(motionQA){motionQA.frames=[];motionQA.captureTick=-1;}for(const u of units){u.animation?.dispose();scene.remove(u.root,u.ring);u.model.traverse(o=>{if(o.isMesh)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{if(m.name==='team_cloth')m.dispose();});});u.ring.material.dispose();}clearBattleMarks();clearArrows();units.length=0;fighting=false;winner=null;paused=false;elapsed=0;distance=qaMode==='duel'?10:qaMode==='sixteen'?31:qaMode==='four'?21:qaMode?18:cameraCandidate?44:43;focus.set(0,qaMode?1.1:0,cameraCandidate?4:0);updateCamera(); marker.visible=false;$('pause').textContent='暂停';$('fight').textContent='开始交战';
 if(qaMode==='duel'){const separation=qaKind==='cavalry'?8:3;createUnit('red',qaKind,-separation,0,0);createUnit('blue',qaKind,separation,0,1);}else if(qaMode==='four'||qaMode==='sixteen'){const count=qaMode==='four'?4:16,rows=qaMode==='four'?2:4;for(const t of ['red','blue'])for(let i=0;i<count;i++){const side=t==='red'?-1:1;createUnit(t,qaKind,side*(4.5+Math.floor(i/rows)*2.2),(i%rows-(rows-1)/2)*2.2+(t==='blue'?.7:0),i);}}else if(qaMode){for(let i=0;i<(qaMode==='small'?4:1);i++)createUnit('red',qaKind,-3,(i-((qaMode==='small'?4:1)-1)/2)*2.2-1,i);}else for(const t of ['red','blue']){const side=t==='red'?-1:1;for(let i=0;i<6;i++)createUnit(t,'infantry',side*(8+Math.floor(i/4)*2.1),(i%4-1.5)*2.1,i);for(let i=0;i<4;i++)createUnit(t,'pikeman',side*12.2,(i-1.5)*2.1,i+6);for(let i=0;i<2;i++)createUnit(t,'archer',side*15,(i-.5)*3,i+10);for(let i=0;i<4;i++)createUnit(t,'cavalry',side*(10.8+i%2*4.2),6+Math.floor(i/2)*4.2,i+12);}
 separateBodies(units);battleLine=frontCandidate&&frontApplicable?new BattleLine(units):null;select(units.filter(u=>u.team===team));$('battle-status').textContent=`自由布阵 · ${healthStatus()}`;}
const localX = new THREE.Vector3(1,0,0);
const strideRotation = new THREE.Quaternion();
function animateUnit(u,time,moving,attacking){const walk=Math.sin(time*(u.kind==='cavalry'?10:8)+u.index*.7);for(const joint of u.joints){let angle=0;if(joint.name.startsWith('horse_leg_'))angle=moving?walk*(joint.name.split('_').slice(-2).reduce((phase, value) => phase * Number(value), 1))*.45:0;else if(joint.name.startsWith('leg_'))angle=moving?walk*(joint.name.startsWith('leg_left')?1:-1)*.43:0;else if(joint.name==='rider')angle=u.runup>=3.2||u.chargeFlash>0?.10:0;else if(joint.name.startsWith('arm_right'))angle=u.kind==='cavalry'?(u.runup>=3.2||u.chargeFlash>0?1.15+Math.sin(time*11)*.06:attacking?.55+Math.sin(time*11+u.index)*.13:moving?walk*.06:0):attacking?-.8+Math.sin(time*11+u.index)*.65:moving?walk*.12:0;else angle=moving?walk*.08:0;
 // Blender exports Z-up joints into a Y-up scene. Local X remains the stride axis.
 joint.object.quaternion.copy(joint.base).multiply(strideRotation.setFromAxisAngle(localX,angle));}
 u.model.position.y=moving?Math.abs(walk)*(u.kind==='cavalry'?.09:.035):0;}
const bloodMarks=[], impactMarks=[];
const bloodMaterial=new THREE.MeshBasicMaterial({color:'#691b19',transparent:true,opacity:.75,depthWrite:false,side:THREE.DoubleSide});
function clearBattleMarks(){for(const mark of [...bloodMarks,...impactMarks]){scene.remove(mark);mark.geometry.dispose();if(mark.material!==bloodMaterial)mark.material.dispose();}bloodMarks.length=0;impactMarks.length=0;}
function addBlood(x,z,size=.35){
 const g=new THREE.CircleGeometry(size,12);g.rotateX(-Math.PI/2);const p=g.attributes.position;
 for(let i=0;i<p.count;i++){const dx=p.getX(i),dz=p.getZ(i);p.setY(i,heightAt(x+dx,z+dz)-heightAt(x,z)+.035);}g.computeVertexNormals();
 const mark=new THREE.Mesh(g,bloodMaterial);mark.position.set(x,heightAt(x,z),z);mark.renderOrder=1;scene.add(mark);bloodMarks.push(mark);
 if(bloodMarks.length>96){const old=bloodMarks.shift();scene.remove(old);old.geometry.dispose();}
}
function impactRing(x,z,charge){const geometry=new THREE.RingGeometry(.25,.35,20);geometry.rotateX(-Math.PI/2);const material=new THREE.MeshBasicMaterial({color:charge?'#ffd77b':'#d7ae91',transparent:true,opacity:.85,side:THREE.DoubleSide,depthWrite:false});const ring=new THREE.Mesh(geometry,material);ring.position.set(x,heightAt(x,z)+.09,z);ring.userData.life=.6;scene.add(ring);impactMarks.push(ring);if(impactMarks.length>32){const old=impactMarks.shift();scene.remove(old);old.geometry.dispose();old.material.dispose();}}
const arrowGeometry=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,-.6),new THREE.Vector3(0,0,.15),new THREE.Vector3(0,0,.15),new THREE.Vector3(-.10,0,-.02),new THREE.Vector3(0,0,.15),new THREE.Vector3(.10,0,-.02)]);
const arrowMaterial=new THREE.LineBasicMaterial({color:'#e8d7a1'}),arrowMarks=new Map();
function clearArrows(){for(const mark of arrowMarks.values())scene.remove(mark);arrowMarks.clear();}
function addArrow(shot,from){if(arrowMarks.size>=64)return;const mark=new THREE.LineSegments(arrowGeometry,arrowMaterial);mark.userData.shot=shot;if(coordinationCandidate){mark.userData.origin=arrowReleasePoint(from);mark.userData.launch={x:shot.x,z:shot.z};}scene.add(mark);arrowMarks.set(shot.id,mark);}
function updateArrows(){const active=new Set(units.flatMap(u=>u.projectiles.map(shot=>shot.id)));for(const [id,mark] of arrowMarks){if(!active.has(id)){scene.remove(mark);arrowMarks.delete(id);continue;}const shot=mark.userData.shot;if(coordinationCandidate){const pose=flightPose(shot,mark.userData.origin,heightAt,mark.userData.launch);mark.position.copy(pose.position);mark.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),pose.tangent);continue;}const progress=Math.min(1,shot.age/shot.duration);mark.position.set(shot.x,THREE.MathUtils.lerp(heightAt(shot.startX,shot.startZ),heightAt(shot.endX,shot.endZ),progress)+1.5+Math.sin(progress*Math.PI)*.45,shot.z);mark.rotation.y=Math.atan2(shot.vx,shot.vz);}}
const corpseVertex=new THREE.Vector3();
function settleCorpse(u){
 u.model.position.y=0;u.root.updateMatrixWorld(true);updateSkinMatrices(u.model);let lift=-Infinity;
 u.model.traverse(o=>{if(!o.isMesh)return;const p=o.geometry.attributes.position;for(let i=0;i<p.count;i++){o.getVertexPosition(i,corpseVertex).applyMatrix4(o.matrixWorld);lift=Math.max(lift,heightAt(corpseVertex.x,corpseVertex.z)+.025-corpseVertex.y);}});
 u.model.position.y=Number.isFinite(lift)?lift:0;
}
function sampleCorpseContact(u){
 if(u.hp>0)return null;updateSkinMatrices(u.model);let gap=Infinity,bodyGap=Infinity,finite=true;
 u.model.traverse(o=>{if(!o.isSkinnedMesh)return;const p=o.geometry.attributes.position,indices=o.geometry.attributes.skinIndex,weights=o.geometry.attributes.skinWeight;
 for(let i=0;i<p.count;i++){o.getVertexPosition(i,corpseVertex).applyMatrix4(o.matrixWorld);const d=corpseVertex.y-heightAt(corpseVertex.x,corpseVertex.z);finite=finite&&Number.isFinite(d);gap=Math.min(gap,d);let k=0;for(let j=1;j<4;j++)if(weights.getComponent(i,j)>weights.getComponent(i,k))k=j;const n=o.skeleton.bones[indices.getComponent(i,k)].name;if(/^(Hips|Spine|Chest|Head|Thigh|Shin|Foot|HorseBody)/.test(n))bodyGap=Math.min(bodyGap,d);}});
 return {gap,bodyGap,finite};
}
function update(dt){
 elapsed+=dt;motionQA?.beforeStep(elapsed);
 battleLine?.update(units,dt,fighting);
 const events=stepSkirmish(units,dt,fighting,battleLine?(u,enemy)=>battleLine.intent(u,enemy):null);duelQA?.recordEvents(elapsed,events);crowdQA?.recordEvents(elapsed,events);
 for(const event of events){
  if(coordinationCandidate)coordinateEvent(event);
  if(event.type==='death'){event.unit.animation?.trigger('death');event.unit.ring.visible=false;addBlood(event.x,event.z,event.unit.kind==='cavalry'?.65:.4);}
  else if(event.type==='charge'){event.target.animation?.trigger('hit');impactRing(event.x,event.z,true);addBlood(event.x,event.z,.24);}
  else if(event.type==='attack'){event.from.animation?.trigger('attack');}
  else if(event.type==='cancel-shot'||event.type==='cancel-attack'){event.from.animation?.cancelAttack(event.from.moving);}
  else if(event.type==='draw'){event.from.animation?.trigger('attack');}
  else if(event.type==='shoot'){addArrow(event.shot,event.from);}
  else {event.target.animation?.trigger('hit');impactRing(event.x,event.z,false);if(event.target.hp%24<12)addBlood(event.x,event.z,.12);}
 }
 for(const u of units){
  u.root.position.set(u.x,heightAt(u.x,u.z),u.z);u.root.rotation.y=u.heading;
  if(corpseSupport){if(u.hp<=0)corpseSupport.restore(u.model);else corpseSupport.clear(u.model);}
  if(u.hp<=0){u.deathTime=(u.deathTime??0)+dt;const t=Math.min(1,u.deathTime/.65);if(u.animation){if(coordinationCandidate){restoreBowArm(u);restoreChargeImpact(u);}u.animation.update(dt,false);if(coordinationCandidate){syncHeldArrow(u);restBowArm(u);}u.model.rotation.z=0;}else u.model.rotation.z=(u.id%2?1:-1)*Math.PI/2*(1-Math.pow(1-t,3));if(corpseSupport){const action=u.animation?.actions.get('death');corpseSupport.apply(u,action?.time??u.deathTime,action?.getClip().duration??.65,settleCorpse);u.corpseSettled=u.animation?u.animation.deathComplete:t===1;}else if(!u.corpseSettled){settleCorpse(u);u.corpseSettled=u.animation?u.animation.deathComplete:t===1;}u.ring.visible=false;continue;}
  if(u.animation){u.model.position.y=0;u.model.rotation.z=0;const actualSpeed=Math.hypot(u.x-(u.animationX??u.x),u.z-(u.animationZ??u.z))/Math.max(dt,.001);const turnRate=Math.atan2(Math.sin(u.heading-(u.animationHeading??u.heading)),Math.cos(u.heading-(u.animationHeading??u.heading)))/Math.max(dt,.001);u.animationX=u.x;u.animationZ=u.z;u.animationHeading=u.heading;if(coordinationCandidate)restoreChargeImpact(u);u.animation.update(dt,u.locomotion?actualSpeed>.04:u.moving,u.kind==='cavalry'&&u.speed>=1.5&&(u.runup>=3.2||u.pierceTime>0||u.chargeFlash>0),{speed:actualSpeed,turnRate});if(coordinationCandidate){syncHeldArrow(u);syncChargeImpact(u);}updateSkinMatrices(u.model);}else animateUnit(u,elapsed,u.moving,u.attacking);u.ring.position.set(u.x,heightAt(u.x,u.z)+.04,u.z);
  if(!u.animation)u.model.rotation.z=Math.sin(elapsed*45+u.id)*.06*Math.min(1,u.hitFlash*5);
  if(u.kind==='cavalry'&&u.moving&&u.speed>=3.4&&Math.floor(elapsed*10)!==u.dustTick){u.dustTick=Math.floor(elapsed*10);impactRing(u.x-Math.sin(u.heading)*.55,u.z-Math.cos(u.heading)*.55,false);}
 }
 updateArrows();
 if(preview.get('capture')==='1')for(const u of units){const a=u.model.getObjectByName('Arrow');if(u.contactTick!==Math.floor(elapsed*10)){u.contactTick=Math.floor(elapsed*10);u.corpseContact=sampleCorpseContact(u);}u.effectSample={contact:u.corpseContact,chestX:u.model.getObjectByName('Chest')?.rotation.x,heldArrowScale:a?.scale.x,soleContact:u.kind==='cavalry'?null:sampleSoleContact(u),modelY:u.model.position.y,rootY:u.root.position.y,arrowReleased:!!u.arrowReleased,projectiles:u.projectiles.map(s=>({id:s.id,x:s.x,z:s.z,age:s.age})),flight:[...arrowMarks.values()].filter(m=>m.userData.shot.id.startsWith(u.id+':')).map(m=>({id:m.userData.shot.id,origin:m.userData.origin?.toArray(),position:m.position.toArray(),quaternion:m.quaternion.toArray()}))};}
 motionQA?.afterStep(elapsed,dt);duelQA?.afterStep(elapsed);crowdQA?.afterStep(elapsed,dt);
 for(let i=impactMarks.length-1;i>=0;i--){const ring=impactMarks[i];ring.userData.life-=dt;ring.scale.setScalar(1+(1-ring.userData.life/.6)*2);ring.material.opacity=Math.max(0,ring.userData.life/.6)*.5;if(ring.userData.life<=0){scene.remove(ring);ring.geometry.dispose();ring.material.dispose();impactMarks.splice(i,1);}}
 const aliveRed=units.some(u=>u.team==='red'&&u.hp>0),aliveBlue=units.some(u=>u.team==='blue'&&u.hp>0);
 if(fighting&&(!aliveRed||!aliveBlue)){fighting=false;winner=aliveRed?'红':'蓝';select(selected);}
 const charges=units.filter(u=>u.hp>0&&u.kind==='cavalry'&&u.runup>=3.2&&u.speed>=3.4).length;
 $('battle-status').textContent=winner?`${winner}方胜出 · 战场遗骸保留 · 重置可再演练`:`${paused?'已暂停':fighting?'交战中':'自由布阵'} · ${healthStatus()}${charges?' · 骑兵冲锋 '+charges:''}${motionQA?' · '+motionQA.version+' '+motionQA.label+' t='+elapsed.toFixed(3):duelQA?' · 双兵 t='+elapsed.toFixed(3):''}`;
}
function setTeam(t){team=t;$('team-red').setAttribute('aria-pressed',String(t==='red'));$('team-blue').setAttribute('aria-pressed',String(t==='blue'));select(units.filter(u=>u.team===t));}
const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
renderer.domElement.addEventListener('pointerdown',event=>{if(!ready)return;const r=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-r.left)/r.width*2-1,-(event.clientY-r.top)/r.height*2+1);raycaster.setFromCamera(pointer,camera);
 const hits=raycaster.intersectObjects(units.filter(u=>u.hp>0).map(u=>u.root),true);if(hits.length){let node=hits[0].object;while(node&&!node.userData.unit)node=node.parent;const u=node?.userData.unit;if(u?.team===team){select([u]);return;}}
 const hit=raycaster.intersectObject(ground)[0];if(hit&&selected.length){const count=selected.length,gap=Math.max(3.1,...selected.map(u=>u.radius*2+.15));selected=selected.filter(u=>u.hp>0);selected.forEach((u,i)=>{const columns=Math.ceil(Math.sqrt(count));const x=THREE.MathUtils.clamp(hit.point.x+(i%columns-(columns-1)/2)*gap,-17,17);const z=THREE.MathUtils.clamp(hit.point.z+(Math.floor(i/columns)-Math.floor((count-1)/columns)/2)*gap,-13,13);u.target={x,z};u.pendingShot=null;u.pendingStrike=null;u.animation?.cancelAttack(true);u.runup=0;u.pierceTime=0;});marker.position.copy(hit.point);marker.position.y+=.05;marker.visible=true;$('selection').textContent=`已下令 ${selected.length} 名士兵前往标记位置${paused?' · 恢复后执行':''}`;}});
function zoom(amount){distance=THREE.MathUtils.clamp(distance+amount,10,65);updateCamera();}
renderer.domElement.addEventListener('wheel',event=>{event.preventDefault();zoom(Math.sign(event.deltaY)*2.3);},{passive:false});
$('zoom-in').onclick=()=>zoom(-4);$('zoom-out').onclick=()=>zoom(4);$('overview').onclick=()=>{distance=cameraCandidate?44:43;focus.set(0,0,cameraCandidate?4:0);updateCamera();};$('focus').onclick=()=>{const living=selected.filter(u=>u.hp>0);if(!living.length)return;focus.set(0,0,0);for(const u of living)focus.add(u.root.position);focus.divideScalar(living.length);distance=18;updateCamera();};
if(preview.has('coordination')){const g=document.createElement('div');g.className='control-group';for(const v of ['baseline','candidate']){const b=document.createElement('button');b.textContent=v==='baseline'?'动作协调基准':'动作协调候选 Q1';b.onclick=()=>{const p=new URLSearchParams(location.search);p.set('coordination',v);location.search=p.toString();};g.append(b);}document.querySelector('.demo-controls').prepend(g);}
if(preview.has('front')){
 const group=document.createElement('div');group.className='control-group';group.append('战线组织 ');
 const control=document.createElement('select');control.setAttribute('aria-label','战线组织');
 for(const [value,label]of [['baseline','原自主接敌'],['candidate','战线候选 W1']]){const option=document.createElement('option');option.value=value;option.textContent=label;option.selected=preview.get('front')===value;control.append(option);}
 control.onchange=()=>{const p=new URLSearchParams(location.search);p.set('front',control.value);location.search=p.toString();};group.append(control);document.querySelector('.demo-controls').prepend(group);
 window.frontPreview={version:frontCandidate?'candidate':'baseline',applicable:frontApplicable,inspect:()=>({elapsed,fighting,paused,formation:battleLine?.inspect()??null,units:units.map(u=>({id:u.id,team:u.team,kind:u.kind,x:u.x,z:u.z,heading:u.heading,hp:u.hp,radius:u.radius,moving:u.moving,speed:u.speed,state:u.animation?.state,target:u.target,combatTargetId:u.combatTargetId,blockedBy:u.blockedBy,pendingStrike:u.pendingStrike,pendingShot:u.pendingShot,runup:u.runup,pierceTime:u.pierceTime}))})};
}
if(modelControlsActive)window.modelPreview={clearSelection:()=>{select([]);renderer.render(scene,camera);},inspectPoint:(x,y)=>{const r=renderer.domElement.getBoundingClientRect();pointer.set((x-r.left)/r.width*2-1,-(y-r.top)/r.height*2+1);raycaster.setFromCamera(pointer,camera);return raycaster.intersectObjects(units.filter(u=>u.root.visible).map(u=>u.root),true).slice(0,4).map(hit=>({material:(Array.isArray(hit.object.material)?hit.object.material[hit.face.materialIndex]:hit.object.material).name,point:hit.point.toArray()}));}};
if(modelControlsActive)window.modelPreview.inspectShaft=()=>{
 const unit=units.find(u=>u.team==='red'&&u.kind==='pikeman');if(!unit)return null;updateSkinMatrices(unit.model);
 const vertex=new THREE.Vector3(),ends=[];
 function dominant(mesh,index){const weights=mesh.geometry.attributes.skinWeight,indices=mesh.geometry.attributes.skinIndex;let component=0;for(let j=1;j<4;j++)if(weights.getComponent(index,j)>weights.getComponent(index,component))component=j;return mesh.skeleton.bones[indices.getComponent(index,component)].name.replaceAll('.','');}
 unit.model.traverse(mesh=>{if(!mesh.isSkinnedMesh||mesh.material.name!=='brown leather')return;const positions=mesh.geometry.attributes.position,candidates=[];for(let i=0;i<positions.count;i++)if(dominant(mesh,i)==='HandR')candidates.push(i);if(!candidates.length)return;
 const depths=candidates.map(i=>positions.getZ(i));for(const depth of [Math.min(...depths),Math.max(...depths)]){const points=candidates.filter(i=>Math.abs(positions.getZ(i)-depth)<1e-5);const center=new THREE.Vector3();for(const i of points)center.add(mesh.getVertexPosition(i,vertex).applyMatrix4(mesh.matrixWorld));ends.push(center.divideScalar(points.length));}});
 if(ends.length!==2)return null;const direction=ends[1].clone().sub(ends[0]),length=direction.length();const probe=new THREE.Raycaster(ends[0],direction.normalize(),0,length);
 const body=probe.intersectObject(unit.root,true).filter(hit=>{const mesh=hit.object;if(!mesh.isSkinnedMesh||mesh.material.name==='brown leather')return false;return [hit.face.a,hit.face.b,hit.face.c].every(i=>/^(Chest|Spine|Hips)$/.test(dominant(mesh,i)));}).map(hit=>({distance:hit.distance,point:hit.point.toArray(),material:hit.object.material.name}));
 let bodyGap=Infinity;const contacts={};unit.model.traverse(mesh=>{if(!mesh.isSkinnedMesh)return;for(let i=0;i<mesh.geometry.attributes.position.count;i++){const bone=dominant(mesh,i);mesh.getVertexPosition(i,vertex).applyMatrix4(mesh.matrixWorld);const gap=vertex.y-heightAt(vertex.x,vertex.z);if(/^(Hips|Spine|Chest|Head|Thigh|Shin|Foot)/.test(bone))bodyGap=Math.min(bodyGap,gap);const key=bone+' / '+mesh.material.name;if(!contacts[key]||gap<contacts[key].gap)contacts[key]={gap,vertex:i,point:vertex.toArray()};}});
 return {ends:ends.map(v=>v.toArray()),length,body,bodyGap,contacts};
};
function appendModelControls(group){
 const selector=document.createElement('select');selector.setAttribute('aria-label','造型对照兵种');
 Object.assign(selector.style,{border:'1px solid #5d7058',background:'#283d30',color:'#dbe4d1',borderRadius:'5px',padding:'8px',font:'inherit'});
 for(const [value,label]of [['infantry','剑盾'],['pikeman','长矛'],['archer','弓兵'],['cavalry','骑兵']]){const option=document.createElement('option');option.value=value;option.textContent=label;option.selected=value===modelControlRole;selector.append(option);}
 selector.onchange=()=>{const params=new URLSearchParams(location.search);params.set('modelRole',selector.value);if(qaMode)params.set('unit',selector.value);location.search=params.toString();};group.append(selector);
 for(const [value,label]of modelVariants){const button=document.createElement('button');button.textContent=label;button.setAttribute('aria-pressed',String(preview.get(modelControlParam)===value));button.onclick=()=>{const params=new URLSearchParams(location.search);params.set('modelRole',modelControlRole);params.set(modelControlParam,value);location.search=params.toString();};group.append(button);}
}
if(modelControlsActive&&!comparing&&!buildingComparing){const group=document.createElement('div');group.className='control-group';appendModelControls(group);document.querySelector('.demo-controls').prepend(group);}

const roleControls=document.createElement('div');roleControls.className='control-group';roleControls.setAttribute('aria-label','选择兵种');$('select-all').parentElement.insertAdjacentElement('afterend',roleControls);
for(const [kind,label] of [['infantry','剑盾'],['pikeman','长矛'],['archer','弓兵'],['cavalry','骑兵']]){const button=document.createElement('button');button.textContent=label;button.onclick=()=>{select(units.filter(u=>u.team===team&&u.kind===kind));$('focus').click();};roleControls.append(button);}
$('team-red').onclick=()=>setTeam('red');$('team-blue').onclick=()=>setTeam('blue');$('select-all').onclick=()=>select(units.filter(u=>u.team===team));$('fight').onclick=()=>{if(!ready)return;if(fighting || winner) reset();for(const u of units)u.target=null;winner=null;fighting=true;paused=false;$('pause').textContent='暂停';marker.visible=false;$('fight').textContent='重新交战';};$('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'继续':'暂停';$('battle-status').textContent=`${paused?'已暂停':fighting?'交战中':'自由布阵'} · ${healthStatus()}`;};$('reset').onclick=reset;
function sampleCorpsePresentation(u,clip,time){
 if(!corpseComparing||clip!=='death')return;
 if(coordinationCandidate){const action=u.animation.actions.get('death');const view=Object.create(u);view.hp=-1;view.deathTime=time;view.corpseSettled=false;view.bowDeathBase=null;view.bowDeathFinal=null;view.animation={actions:u.animation.actions,deathComplete:time>=action.getClip().duration};syncHeldArrow(view);restBowArm(view);}
 updateSkinMatrices(u.model);
 if(corpseSupport)corpseSupport.apply(u,Math.min(time,u.animation.actions.get('death').getClip().duration),u.animation.actions.get('death').getClip().duration,settleCorpse);
 else settleCorpse(u);
 updateSkinMatrices(u.model);
}
if(corpseComparing){const group=document.createElement('div');group.className='control-group';const label=document.createElement('label');label.textContent='尸体支撑 ';const selector=document.createElement('select');selector.setAttribute('aria-label','尸体坡面支撑');Object.assign(selector.style,{border:'1px solid #5d7058',background:'#283d30',color:'#dbe4d1',borderRadius:'5px',padding:'8px',font:'inherit'});for(const [value,text]of [['baseline','原接地'],['candidate','坡面接地']]){const option=document.createElement('option');option.value=value;option.textContent=text;option.selected=(corpseCandidate?'candidate':'baseline')===value;selector.append(option);}selector.onchange=()=>{const params=new URLSearchParams(location.search);params.set('corpse',selector.value);location.search=params.toString();};label.append(selector);group.append(label);document.querySelector('.demo-controls').prepend(group);window.corpsePreview={version:corpseCandidate?'candidate':'baseline',inspect:()=>units.filter(u=>u.root.visible).map(u=>({id:u.id,kind:u.kind,hp:u.hp,position:u.root.position.toArray(),heading:u.heading,renderYaw:u.root.rotation.y,rootQuaternion:u.root.quaternion.toArray(),modelQuaternion:u.model.quaternion.toArray(),modelY:u.model.position.y,tilt:corpseSupport?.inspect(u.model),...corpseRegions(u.model,heightAt)}))};}
function sampleSoleContact(u){
 const feet={};u.model.traverse(mesh=>{if(!mesh.isSkinnedMesh)return;const indices=mesh.geometry.attributes.skinIndex,weights=mesh.geometry.attributes.skinWeight;
 for(let i=0;i<indices.count;i++){let j=0;for(let k=1;k<4;k++)if(weights.getComponent(i,k)>weights.getComponent(i,j))j=k;const name=mesh.skeleton.bones[indices.getComponent(i,j)].name.replaceAll('.','');if(!/^Foot[LR]$/.test(name))continue;
 const v=mesh.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);feet[name]=Math.min(feet[name]??Infinity,v.y-heightAt(v.x,v.z));}});return feet;
}
function setupComparison(){
 paused=true;const previewTime=Number(preview.get('time')||0);const sample=Number.isFinite(previewTime)?Math.max(0,Math.min(2,previewTime)):0;const clip=(preview.get('clip')||'idle').toLowerCase();
 for(const u of units){corpseSupport?.clear(u.model);u.animation.terrain?.restore();u.animation.mixer.stopAllAction();const action=u.animation.actions.get(clip)||u.animation.actions.get('idle');action.reset().play();action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;u.animation.mixer.setTime(Math.min(sample,action.getClip().duration));updateSkinMatrices(u.model);if(clip==='death'&&!corpseComparing)settleCorpse(u);}
 const target=modelComparing?units.find(u=>u.team==='red'&&u.kind===modelControlRole&&u.index===(qaMode?0:{infantry:3,pikeman:6,archer:10,cavalry:12}[modelControlRole])):terrainComparing?units.find(u=>u.team==='red'&&u.kind===qaKind):units.find(u=>u.team==='red'&&u.kind===(rideComparing?'cavalry':bowComparing?'archer':pikeComparing?'pikeman':'infantry')&&((pikeComparing||bowComparing||rideComparing)?(qaMode?u.index===0:u.index===(rideComparing?12:bowComparing?10:6)):u.index===3));
 if(!target)throw new Error('No actor for the requested comparison');
 if(preview.get('view')==='near'){focus.copy(target.root.position);focus.y+=1.1;distance=10;updateCamera();}
 if(preview.has('angle')){const angle=Number(preview.get('angle'));if(Number.isFinite(angle))target.root.rotation.y=angle;}
 for(const u of units){sampleCorpsePresentation(u,clip,sample);updateSkinMatrices(u.model);u.animation.terrain?.apply(clip,sample/(u.animation.actions.get(clip)?.getClip().duration||1));updateSkinMatrices(u.model);}
 if(preview.get('solo')==='1')for(const u of units){u.root.visible=u===target;u.ring.visible=false;}
 const group=document.createElement('div');group.className='control-group';
 if(modelComparing)appendModelControls(group);
 else for(const [value,label]of (terrainComparing?[['baseline','地形接地基准'],['candidate','地形接地候选 T1']]:rideComparing?[['baseline','骑兵基准'],['candidate','骑兵候选 V1']]:bowComparing?[['baseline','弓兵基准'],['candidate','弓兵候选 A1']]:pikeComparing?[['baseline','长矛基准'],['candidate','长矛候选 P1']]:[['old','旧版'],['candidate','候选 R1'],['r11','候选 R1.1']])){const b=document.createElement('button');b.textContent=label;b.setAttribute('aria-pressed',String(preview.get(modelComparing?'model':terrainComparing?'terrain':rideComparing?'ride':bowComparing?'bow':pikeComparing?'pike':'soldier')===value));b.onclick=()=>{const params=new URLSearchParams(location.search);params.set(modelComparing?'model':terrainComparing?'terrain':rideComparing?'ride':bowComparing?'bow':pikeComparing?'pike':'soldier',value);location.search=params.toString();};group.append(b);}
 for(const [value,label]of [['default','默认机位'],['near','最近机位']]){const b=document.createElement('button');b.textContent=label;b.onclick=()=>{const params=new URLSearchParams(location.search);params.set('view',value);location.search=params.toString();};group.append(b);}
 document.querySelector('.demo-controls').prepend(group);$('battle-status').textContent=`${modelComparing?modelRoleLabel+'对照':rideComparing?'骑兵对照':bowComparing?'弓兵对照':pikeComparing?'长矛对照':'剑盾对照'} · ${rideComparing?(rideCandidate?'候选 V1':'基准'):bowComparing?(bowCandidate?'候选 A1':'基准'):pikeComparing?(pikeStandard?'造型 P2':pikeCandidate?'候选 P1':'基准'):modelComparing?modelComparisonLabel:candidate?candidateLabel:'旧版'} · ${clip} ${sample.toFixed(3)}s · 冻结采样`;window.soldierPreview={asset:modelComparing?modelAssetName+'.glb':rideComparing?cavalryAssetName+'.glb':bowComparing?(bowAssetName+'.glb'):pikeComparing?pikeAssetName+'.glb':r11?'round1-1/infantry-rigged.glb':candidate?'round1/infantry-rigged.glb':'infantry-rigged.glb',clip,sampleTime:sample,units:units.length};
 window.soldierPreview.sample=(clip,time,angle)=>{for(const u of units){corpseSupport?.clear(u.model);u.model.position.y=0;u.animation.terrain?.restore();u.animation.mixer.stopAllAction();const a=u.animation.actions.get(clip)||u.animation.actions.get('idle');a.reset().setLoop(THREE.LoopOnce,1);a.clampWhenFinished=true;a.play();u.animation.mixer.setTime(Math.min(time,a.getClip().duration));updateSkinMatrices(u.model);if(clip==='death'&&!corpseComparing)settleCorpse(u);}if(angle!==undefined)target.root.rotation.y=angle;for(const u of units){sampleCorpsePresentation(u,clip,time);updateSkinMatrices(u.model);u.animation.terrain?.apply(clip,time/(u.animation.actions.get(clip)?.getClip().duration||1));updateSkinMatrices(u.model);}window.soldierPreview.clip=clip;window.soldierPreview.sampleTime=time;$('battle-status').textContent=`${modelComparing?modelRoleLabel+'对照':rideComparing?'骑兵对照':bowComparing?'弓兵对照':pikeComparing?'长矛对照':'剑盾对照'} · ${rideComparing?(rideCandidate?'候选 V1':'基准'):bowComparing?(bowCandidate?'候选 A1':'基准'):pikeComparing?(pikeStandard?'造型 P2':pikeCandidate?'候选 P1':'基准'):modelComparing?modelComparisonLabel:candidate?candidateLabel:'旧版'} · ${clip} ${time.toFixed(3)}s · 冻结采样`;if(terrainComparing)$('battle-status').textContent=`地形接地 T1 · ${target.kind} · ${terrainCandidate?'候选':'基准'} · ${clip} ${time.toFixed(3)}s`;renderer.render(scene,camera);};
 window.soldierPreview.inspect=()=>{const positions=[];target.model.traverse(o=>{if(o.isSkinnedMesh){const p=o.geometry.attributes.position;const v=new THREE.Vector3();for(let i=0;i<p.count;i++){o.getVertexPosition(i,v).applyMatrix4(o.matrixWorld);positions.push([v.x,v.y,v.z]);}}});return {finite:positions.every(p=>p.every(Number.isFinite)),bounds: [0,1,2].map(k=>[Math.min(...positions.map(p=>p[k])),Math.max(...positions.map(p=>p[k]))]),feet:[...['L','R'].map(side=>{let bone;target.model.traverse(o=>{if(o.isSkinnedMesh)bone=o.skeleton.bones.find(b=>b.name.replaceAll('.','')==='Foot'+side);});return {side,position:bone?.getWorldPosition(new THREE.Vector3()).toArray(),quaternion:bone?.getWorldQuaternion(new THREE.Quaternion()).toArray()};})],kind:target.kind,soleContact:sampleSoleContact(target),ground:target.root.position.y,terrainGap:Math.min(...positions.map(p=>p[1]-heightAt(p[0],p[2])))};};
 if(terrainComparing){window.soldierPreview.kind=target.kind;window.soldierPreview.asset={infantry:duelCandidate?'duel1/infantry-rigged.glb':motionCandidate?'locomotion1/infantry-rigged.glb':'round1-1/infantry-rigged.glb',pikeman:pikeAssetName+'.glb',archer:bowAssetName+'.glb',cavalry:cavalryAssetName+'.glb'}[target.kind];$('battle-status').textContent=`地形接地 T1 · ${target.kind} · ${terrainCandidate?'候选':'基准'} · ${clip} ${sample.toFixed(3)}s`;}
}
let last=performance.now();
function setupBuildingComparison(){
 paused=true;
 const tower=towers[0];
 // Existing actor GLB, unchanged world scale. The two comparison versions use
 // the exact same position and Idle sample beside the tower front.
 const soldier=units.find(u=>u.team==='red'&&u.kind==='infantry');
 for(const u of units){u.root.visible=u===soldier;u.ring.visible=false;}
 soldier.x=tower.position.x-2.20;soldier.z=tower.position.z+2.05;
 soldier.root.position.set(soldier.x,heightAt(soldier.x,soldier.z),soldier.z);soldier.root.rotation.y=0;
 soldier.animation.terrain?.restore();soldier.animation.mixer.stopAllAction();soldier.animation.actions.get('idle').reset().play();soldier.animation.mixer.setTime(0);updateSkinMatrices(soldier.model);soldier.animation.terrain?.rememberLift();soldier.animation.terrain?.apply('idle',0);updateSkinMatrices(soldier.model);
 if(preview.get('view')==='near'){focus.copy(tower.position);focus.y+=3.3;distance=18;updateCamera();}
 // Inspection turns only the tower/actor pair; the camera, lights and terrain
 // remain fixed between baseline and candidate.
 const angle=Number(preview.get('buildingAngle')||0);
 if(Number.isFinite(angle)){tower.rotation.y=angle;soldier.root.rotation.y=angle;}
 window.buildingPreview={asset:buildingCandidate?'building1/tower.glb':'tower.glb',inspect:()=>{
  scene.updateMatrixWorld(true);const b=new THREE.Box3().setFromObject(tower),actor=new THREE.Box3().setFromObject(soldier.model);
  return {tower:{min:b.min.toArray(),max:b.max.toArray(),scale:tower.scale.toArray(),position:tower.position.toArray()},actor:{min:actor.min.toArray(),max:actor.max.toArray(),scale:soldier.model.scale.toArray(),position:soldier.root.position.toArray()},camera:{position:camera.position.toArray(),focus:focus.toArray(),fov:camera.fov},canvas:[renderer.domElement.width,renderer.domElement.height],units:units.length,sampleTime:0};
 }};
 $('reset').onclick=()=>{reset();setupBuildingComparison();};
 $('fight').disabled=true;$('pause').disabled=true;
 $('battle-status').textContent=`建筑比例 ${buildingCandidate?'候选 B1':'基准'} · 当前剑盾兵同尺度 · Idle 0s`;
}
if(preview.has('building')){const g=document.createElement('div');g.className='control-group';for(const v of ['baseline','candidate']){const b=document.createElement('button');b.textContent=v==='baseline'?'建筑比例基准':'建筑比例候选 B1';b.onclick=()=>{const p=new URLSearchParams(location.search);p.set('building',v);location.search=p.toString();};g.append(b);}document.querySelector('.demo-controls').prepend(g);}

renderer.setAnimationLoop(now=>{const dt=Math.min((now-last)/1000,.05);last=now;if(ready&&!paused)update(dt);renderer.render(scene,camera);if(crowdQA?.running&&preview.get('capture')==='1'&&Math.floor(elapsed*10)!==crowdQA.captureTick){crowdQA.captureTick=Math.floor(elapsed*10);crowdQA.frames.push({time:elapsed,trace:crowdQA.trace.at(-1),image:renderer.domElement.toDataURL('image/png')});}if(duelQA?.running&&preview.get('capture')==='1'&&elapsed<18&&Math.floor(elapsed*10)!==duelQA.captureTick){duelQA.captureTick=Math.floor(elapsed*10);duelQA.frames.push({time:elapsed,trace:duelQA.trace.at(-1),image:renderer.domElement.toDataURL('image/png')});}if(motionQA?.running&&preview.get('capture')==='1'&&Math.floor(elapsed*10)!==motionQA.captureTick){motionQA.captureTick=Math.floor(elapsed*10);motionQA.frames??=[];const u=units[0],v=new THREE.Vector3(u.x,heightAt(u.x,u.z)+1.3,u.z).project(camera);motionQA.frames.push({time:elapsed,trace:motionQA.trace.at(-1),width:renderer.domElement.width,height:renderer.domElement.height,center:[(v.x+1)*renderer.domElement.width/2,(1-v.y)*renderer.domElement.height/2],image:renderer.domElement.toDataURL('image/png')});}});
async function start(){try{const paths={infantry:infantryAssetName,pikeman:pikeAssetName,archer:bowAssetName,cavalry:cavalryAssetName,tower:buildingCandidate?'building1/tower':'tower'};templates=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([kind,name])=>[kind,await loader.loadAsync(`${import.meta.env.BASE_URL}assets/3d-sample/${name}.glb`)])));for(const [t,x,z] of [['red',-12,-7],['blue',12,-7]]){const tower=cloneModel(templates.tower,t);tower.position.set(x,heightAt(x,z),z);scene.add(tower);towers.push(tower);}reset();if(qaMode==='four'||qaMode==='sixteen')crowdQA=createCrowdQA({reset,startFight:()=>{fighting=true;},getUnits:()=>units,mode:qaMode,version:crowdCandidate?'candidate':'baseline'});else if(qaMode==='duel')duelQA=createDuelQA({reset,startFight:()=>{fighting=true;},getUnits:()=>units});else if(qaMode)motionQA=createMotionQA({reset,getUnits:()=>units,getElapsed:()=>elapsed,controllerVersion:(qaKind==='cavalry'?rideCandidate:qaKind==='archer'?bowCandidate:qaKind==='pikeman'?pikeCandidate:motionCandidate)?'candidate':'baseline',onTarget:target=>{marker.visible=!!target;if(target)marker.position.set(target[0],.2,target[1]);}});if(buildingComparing)setupBuildingComparison();else if(comparing)setupComparison();if(qaMode&&['pikeman','archer','cavalry'].includes(qaKind)&&!(modelControlsActive&&qaKind===modelControlRole)){const group=document.createElement('div');group.className='control-group';for(const [value,label] of (qaKind==='cavalry'?[['baseline','骑兵基准'],['candidate','骑兵候选 V1']]:qaKind==='archer'?[['baseline','弓兵基准'],['candidate','弓兵候选 A1']]:[['baseline','长矛基准'],['candidate','长矛候选 P1']])){const b=document.createElement('button');b.textContent=label;b.onclick=()=>{const p=new URLSearchParams(location.search);p.set(qaKind==='cavalry'?'ride':qaKind==='archer'?'bow':'pike',value);location.search=p.toString();};group.append(b);}document.querySelector('.demo-controls').prepend(group);}ready=true;$('loading').hidden=true;for(const id of ['fight','pause','reset'])$(id).disabled=buildingComparing&&id!=='reset';}catch(error){showFailure('战场模型未能加载，请重新加载，或进入 2D 经典版。');console.error(error);}}
window.addEventListener('pagehide',()=>{renderer.setAnimationLoop(null);observer.disconnect();for(const u of units)u.animation?.dispose();const geometries=new Set(),materials=new Set();scene.traverse(o=>{if(o.geometry)geometries.add(o.geometry);if(o.material)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>materials.add(m));});geometries.add(arrowGeometry);geometries.forEach(g=>g.dispose());materials.add(arrowMaterial);materials.add(bloodMaterial);materials.forEach(m=>m.dispose());renderer.dispose();},{once:true});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

if(preview.has('camera')){
 if(cameraApplicable){for(const [value,label] of [['baseline','取景基准'],['candidate','取景候选 C2']]){const b=document.createElement('button');b.textContent=label;b.setAttribute('aria-pressed',String(preview.get('camera')===value));b.onclick=()=>{const p=new URLSearchParams(location.search);p.set('camera',value);location.search=p.toString();};document.querySelector('.zoom').append(b);}}
 // On-demand inspection uses the same deformed vertices that Three.js renders, not bind-pose boxes.
 window.cameraPreview={inspect:()=>{
  const point=new THREE.Vector3();
  function bounds(objects){const min=[Infinity,Infinity],max=[-Infinity,-Infinity];let finite=true;for(const root of objects){root.updateMatrixWorld(true);updateSkinMatrices(root);root.traverse(o=>{if(!o.isMesh||!o.visible)return;const positions=o.geometry.attributes.position;for(let i=0;i<positions.count;i++){o.getVertexPosition(i,point).applyMatrix4(o.matrixWorld).project(camera);finite=finite&&Number.isFinite(point.x)&&Number.isFinite(point.y)&&Number.isFinite(point.z);const x=(point.x+1)*renderer.domElement.width/2,y=(1-point.y)*renderer.domElement.height/2;min[0]=Math.min(min[0],x);min[1]=Math.min(min[1],y);max[0]=Math.max(max[0],x);max[1]=Math.max(max[1],y);}});}return {min,max,finite};}
  return {active:cameraCandidate,applicable:cameraApplicable,camera:{position:camera.position.toArray(),focus:focus.toArray(),distance,fov:camera.fov,direction:direction.toArray()},canvas:[renderer.domElement.width,renderer.domElement.height],elapsed,paused,fighting,selected:selected.map(u=>u.id),groundPick:(()=>{const p=new THREE.Vector3(0,heightAt(0,0),0).project(camera);return [(p.x+1)*renderer.domElement.width/2,(1-p.y)*renderer.domElement.height/2];})(),units:units.map(u=>{const p=u.root.position.clone();p.y+=1.4;p.project(camera);return {id:u.id,kind:u.kind,team:u.team,hp:u.hp,position:u.root.position.toArray(),pick:[(p.x+1)*renderer.domElement.width/2,(1-p.y)*renderer.domElement.height/2],target:u.target,bounds:bounds([u.root])};}),towers:bounds(towers),rings:bounds(units.filter(u=>u.ring.visible).map(u=>u.ring))};
 }};
}

if(preview.has('light')){
 for(const [value,label] of [['baseline','光照基准'],['candidate','光照候选 L1']]){const b=document.createElement('button');b.textContent=label;b.setAttribute('aria-pressed',String(preview.get('light')===value));b.onclick=()=>{const p=new URLSearchParams(location.search);p.set('light',value);location.search=p.toString();};document.querySelector('.zoom').append(b);}
 // Explicit capture sampling; normal gameplay never calls this helper.
 window.lightingPreview={near:()=>{const actor=units.find(u=>u.team==='red'&&u.kind==='infantry'&&u.index===3);for(const u of units){u.root.visible=u===actor;u.ring.visible=false;}for(const t of towers)t.visible=false;focus.copy(actor.root.position);focus.y+=1.1;distance=10;updateCamera();renderer.render(scene,camera);},freeze:()=>{paused=true;$('pause').textContent='继续';for(const u of units){corpseSupport?.clear(u.model);u.model.position.y=0;u.animation.terrain?.restore();u.animation.mixer.stopAllAction();const a=u.animation.actions.get('idle');a.reset().play();u.animation.mixer.setTime(0);updateSkinMatrices(u.model);u.animation.terrain?.rememberLift();u.animation.terrain?.apply('idle',0);updateSkinMatrices(u.model);}renderer.render(scene,camera);},inspect:()=>({candidate:lightCandidate,materials:units.map(u=>{const m=[];u.model.traverse(o=>{if(o.isMesh)for(const a of(Array.isArray(o.material)?o.material:[o.material]))m.push({name:a.name,color:a.color?.getHexString(),roughness:a.roughness,metalness:a.metalness});});return {id:u.id,materials:m};}),background:scene.background.getHexString(),toneMapping:renderer.toneMapping,outputColorSpace:renderer.outputColorSpace,hemisphere:{sky:hemisphere.color.getHexString(),ground:hemisphere.groundColor.getHexString(),intensity:hemisphere.intensity},sun:{color:sun.color.getHexString(),intensity:sun.intensity,position:sun.position.toArray(),normalBias:sun.shadow.normalBias,mapSize:sun.shadow.mapSize.toArray(),bounds:[sun.shadow.camera.left,sun.shadow.camera.right,sun.shadow.camera.top,sun.shadow.camera.bottom]},camera:{position:camera.position.toArray(),focus:focus.toArray(),distance,fov:camera.fov},canvas:[renderer.domElement.width,renderer.domElement.height],paused,units:units.map(u=>({id:u.id,kind:u.kind,hp:u.hp,position:u.root.position.toArray(),scale:u.model.scale.toArray()}))})};
}

start();

} catch (error) { showFailure('无法创建 3D 画面：浏览器可能未启用 WebGL。可重新加载，或进入 2D 经典版。'); console.error(error); }

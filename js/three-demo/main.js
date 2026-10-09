import * as THREE from 'three';
import { createFighter, stepSkirmish, separateBodies, BODY_RADIUS } from './combat-model.js';
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
scene.add(new THREE.HemisphereLight('#fff5da', '#556547', 1.7));
const sun = new THREE.DirectionalLight('#fff0cb', 2.0);
sun.position.set(-16, 28, 16); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -26; sun.shadow.camera.right = 26;
sun.shadow.camera.top = 26; sun.shadow.camera.bottom = -26; sun.shadow.normalBias = .04;
scene.add(sun);

function heightAt(x, z) { return .15 + 2.5 * Math.exp(-((x + 5) ** 2 / 42 + (z + 5) ** 2 / 50)) + .65 * Math.exp(-((x - 8) ** 2 / 55 + (z - 6) ** 2 / 30)); }
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
const units=[]; let templates, team='red', selected=[], fighting=false, paused=false, ready=false, elapsed=0, winner=null;
const healthStatus = () => ['red','blue'].map(t => `${t==='red'?'红':'蓝'}方 ${units.filter(u=>u.team===t&&u.hp>0).length}`).join(' · ');
function teamColor(t){return t==='red'?'#b84c38':'#487c9c';}
function select(list){ selected=list.filter(u=>u.hp>0); $('selection').textContent = `已选${team==='red'?'红':'蓝'}方 ${selected.length} 名 · 点击地面移动`; for(const u of units)u.ring.visible=selected.includes(u)&&u.hp>0; }
function cloneModel(template,t){const model=template.clone(true);model.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;const tint=m=>{if(m.name!=='team_cloth')return m;const owned=m.clone();owned.color.set(teamColor(t));return owned;};o.material=Array.isArray(o.material)?o.material.map(tint):tint(o.material);}});return model;}
function createUnit(t,kind,x,z,index){const model=cloneModel(templates[kind],t); const root=new THREE.Group();root.add(model);scene.add(root);root.position.set(x,heightAt(x,z),z);root.rotation.y=t==='red'?Math.PI/2:-Math.PI/2;
 const ring=new THREE.Mesh(bodyRingGeometry[kind],new THREE.MeshBasicMaterial({color:'#f5df9d',side:THREE.DoubleSide}));scene.add(ring);const joints=[];model.traverse(o=>{if(!o.isMesh&&/^(arm_|leg_|horse_leg_|rider$)/.test(o.name))joints.push({object:o,base:o.quaternion.clone(),name:o.name});});
 const u={...createFighter(units.length,t,kind,x,z),root,model,ring,joints,index};u.root.rotation.y=u.heading;root.userData.unit=u;units.push(u);}
function reset(){for(const u of units){scene.remove(u.root,u.ring);u.model.traverse(o=>{if(o.isMesh)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{if(m.name==='team_cloth')m.dispose();});});u.ring.material.dispose();}clearBattleMarks();units.length=0;fighting=false;winner=null;paused=false;elapsed=0;distance=43;focus.set(0,0,0);updateCamera(); marker.visible=false;$('pause').textContent='暂停';$('fight').textContent='开始交战';
 for(const t of ['red','blue']){const side=t==='red'?-1:1;for(let i=0;i<12;i++)createUnit(t,'infantry',side*(8+Math.floor(i/4)*1.2),(i%4-1.5)*1.35,i);for(let i=0;i<4;i++)createUnit(t,'cavalry',side*(10.8+i%2*3.1),5.5+Math.floor(i/2)*3.1,i+12);}
 separateBodies(units);select(units.filter(u=>u.team===team));$('battle-status').textContent=`自由布阵 · ${healthStatus()}`;}
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
const corpseVertex=new THREE.Vector3();
function settleCorpse(u){
 u.model.position.y=0;u.root.updateMatrixWorld(true);let lift=-Infinity;
 u.model.traverse(o=>{if(!o.isMesh)return;const p=o.geometry.attributes.position;for(let i=0;i<p.count;i++){corpseVertex.fromBufferAttribute(p,i).applyMatrix4(o.matrixWorld);lift=Math.max(lift,heightAt(corpseVertex.x,corpseVertex.z)+.025-corpseVertex.y);}});
 u.model.position.y=Number.isFinite(lift)?lift:0;
}
function update(dt){
 elapsed+=dt;
 const events=stepSkirmish(units,dt,fighting);
 for(const event of events){
  if(event.type==='death'){event.unit.ring.visible=false;addBlood(event.x,event.z,event.unit.kind==='cavalry'?.65:.4);}
  else if(event.type==='charge'){impactRing(event.x,event.z,true);addBlood(event.x,event.z,.24);}
  else {impactRing(event.x,event.z,false);if(event.target.hp%24<12)addBlood(event.x,event.z,.12);}
 }
 for(const u of units){
  u.root.position.set(u.x,heightAt(u.x,u.z),u.z);u.root.rotation.y=u.heading;
  if(u.hp<=0){u.deathTime=(u.deathTime??0)+dt;const t=Math.min(1,u.deathTime/.65);u.model.rotation.z=(u.id%2?1:-1)*Math.PI/2*(1-Math.pow(1-t,3));if(!u.corpseSettled){settleCorpse(u);u.corpseSettled=t===1;}u.ring.visible=false;continue;}
  animateUnit(u,elapsed,u.moving,u.attacking);u.ring.position.set(u.x,heightAt(u.x,u.z)+.04,u.z);
  u.model.rotation.z=Math.sin(elapsed*45+u.id)*.06*Math.min(1,u.hitFlash*5);
  if(u.kind==='cavalry'&&u.moving&&u.speed>=3.4&&Math.floor(elapsed*10)!==u.dustTick){u.dustTick=Math.floor(elapsed*10);impactRing(u.x-Math.sin(u.heading)*.55,u.z-Math.cos(u.heading)*.55,false);}
 }
 for(let i=impactMarks.length-1;i>=0;i--){const ring=impactMarks[i];ring.userData.life-=dt;ring.scale.setScalar(1+(1-ring.userData.life/.6)*2);ring.material.opacity=Math.max(0,ring.userData.life/.6)*.5;if(ring.userData.life<=0){scene.remove(ring);ring.geometry.dispose();ring.material.dispose();impactMarks.splice(i,1);}}
 const aliveRed=units.some(u=>u.team==='red'&&u.hp>0),aliveBlue=units.some(u=>u.team==='blue'&&u.hp>0);
 if(fighting&&(!aliveRed||!aliveBlue)){fighting=false;winner=aliveRed?'红':'蓝';select(selected);}
 const charges=units.filter(u=>u.hp>0&&u.kind==='cavalry'&&u.runup>=3.2&&u.speed>=3.4).length;
 $('battle-status').textContent=winner?`${winner}方胜出 · 战场遗骸保留 · 重置可再演练`:`${paused?'已暂停':fighting?'交战中':'自由布阵'} · ${healthStatus()}${charges?' · 骑兵冲锋 '+charges:''}`;
}
function setTeam(t){team=t;$('team-red').setAttribute('aria-pressed',String(t==='red'));$('team-blue').setAttribute('aria-pressed',String(t==='blue'));select(units.filter(u=>u.team===t));}
const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
renderer.domElement.addEventListener('pointerdown',event=>{if(!ready)return;const r=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-r.left)/r.width*2-1,-(event.clientY-r.top)/r.height*2+1);raycaster.setFromCamera(pointer,camera);
 const hits=raycaster.intersectObjects(units.filter(u=>u.hp>0).map(u=>u.root),true);if(hits.length){let node=hits[0].object;while(node&&!node.userData.unit)node=node.parent;const u=node?.userData.unit;if(u?.team===team){select([u]);return;}}
 const hit=raycaster.intersectObject(ground)[0];if(hit&&selected.length){const count=selected.length;selected=selected.filter(u=>u.hp>0);selected.forEach((u,i)=>{const columns=Math.ceil(Math.sqrt(count));const x=THREE.MathUtils.clamp(hit.point.x+(i%columns-(columns-1)/2)*3.1,-17,17);const z=THREE.MathUtils.clamp(hit.point.z+(Math.floor(i/columns)-Math.floor((count-1)/columns)/2)*3.1,-13,13);u.target={x,z};u.runup=0;u.pierceTime=0;});marker.position.copy(hit.point);marker.position.y+=.05;marker.visible=true;$('selection').textContent=`已下令 ${selected.length} 名士兵前往标记位置${paused?' · 恢复后执行':''}`;}});
function zoom(amount){distance=THREE.MathUtils.clamp(distance+amount,10,65);updateCamera();}
renderer.domElement.addEventListener('wheel',event=>{event.preventDefault();zoom(Math.sign(event.deltaY)*2.3);},{passive:false});
$('zoom-in').onclick=()=>zoom(-4);$('zoom-out').onclick=()=>zoom(4);$('overview').onclick=()=>{distance=43;focus.set(0,0,0);updateCamera();};$('focus').onclick=()=>{const living=selected.filter(u=>u.hp>0);if(!living.length)return;focus.set(0,0,0);for(const u of living)focus.add(u.root.position);focus.divideScalar(living.length);distance=18;updateCamera();};
$('team-red').onclick=()=>setTeam('red');$('team-blue').onclick=()=>setTeam('blue');$('select-all').onclick=()=>select(units.filter(u=>u.team===team));$('fight').onclick=()=>{if(!ready)return;if(fighting || winner) reset();for(const u of units)u.target=null;winner=null;fighting=true;paused=false;$('pause').textContent='暂停';marker.visible=false;$('fight').textContent='重新交战';};$('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'继续':'暂停';$('battle-status').textContent=`${paused?'已暂停':fighting?'交战中':'自由布阵'} · ${healthStatus()}`;};$('reset').onclick=reset;
let last=performance.now();
renderer.setAnimationLoop(now=>{const dt=Math.min((now-last)/1000,.05);last=now;if(ready&&!paused)update(dt);renderer.render(scene,camera);});
async function start(){try{const assets=await Promise.all(['infantry','cavalry','tower'].map(name=>loader.loadAsync(`${import.meta.env.BASE_URL}assets/3d-sample/${name}.glb`)));templates={infantry:assets[0].scene,cavalry:assets[1].scene,tower:assets[2].scene};for(const [t,x,z] of [['red',-12,-7],['blue',12,-7]]){const tower=cloneModel(templates.tower,t);tower.position.set(x,heightAt(x,z),z);scene.add(tower);}ready=true;reset();$('loading').hidden=true;for(const id of ['fight','pause','reset'])$(id).disabled=false;}catch(error){showFailure('战场模型未能加载，请重新加载，或进入 2D 经典版。');console.error(error);}}
window.addEventListener('pagehide',()=>{renderer.setAnimationLoop(null);observer.disconnect();const geometries=new Set(),materials=new Set();scene.traverse(o=>{if(o.geometry)geometries.add(o.geometry);if(o.material)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>materials.add(m));});geometries.forEach(g=>g.dispose());materials.add(bloodMaterial);materials.forEach(m=>m.dispose());renderer.dispose();},{once:true});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
start();

} catch (error) { showFailure('无法创建 3D 画面：浏览器可能未启用 WebGL。可重新加载，或进入 2D 经典版。'); console.error(error); }

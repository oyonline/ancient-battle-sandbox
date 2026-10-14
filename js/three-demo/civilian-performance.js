import * as T from 'three';
import {CivilianAnimation} from './civilian-animation.js';
import {STRIKES,canBlock} from './sword-duel.js';
import {worldRotate,worldShift} from './impact-performance.js';
import {solveCivilianLimb,prepareCivilianLimb,projectCivilianFoot} from './civilian-ik.js';
import {CivilianFootwork} from './civilian-footwork.js';
const UP=new T.Vector3(0,1,0),clamp=x=>Math.max(0,Math.min(1,x));
export const smoothWeight=x=>{x=clamp(x);return x*x*(3-2*x);};
export const contactWeight=(age,contact)=>{const x=Math.abs(age-contact)/.18;return x>=1?0:.5+.5*Math.cos(Math.PI*x);};
// Independent adult Mixamo presentation. Original KayKit/Quaternius paths
// remain available. No random draws, damage or authoritative phases are written.
export class CivilianPerformance extends CivilianAnimation{
 constructor(u,template,meta){super(u,template,meta);this.enabled=true;this.brace=null;this.rebound=null;this.transition=null;this.previousState='idle';this.guardWeight=0;this.lastPose=null;this.deathYaw=0;this.allBones=[];u.model.traverse(o=>{if(o.isBone)this.allBones.push(o);});const find=n=>u.model.getObjectByName(n);this.hips=find(meta.bones.hips);this.leftArm={hip:find(meta.bones.arml),knee:find(meta.bones.forearml),foot:find(meta.bones.handl)};this.legs=['l','r'].map(s=>({hip:find(meta.bones['thigh'+s]),knee:find(meta.bones['shin'+s]),foot:find(meta.bones['foot'+s])}));this.shield=find('BucklerWood');this.specs=STRIKES;this.guardActivation=0;this.guardKey=null;this.deathEntry=null;this.deathBaseYaw=0;this.surfaces=[];this.surfaceMeshes=[];
  u.model.traverse(o=>{if(!o.isSkinnedMesh)return;this.surfaceMeshes.push(o);const g=o.geometry,w=g.attributes.skinWeight,idx=g.attributes.skinIndex;for(let i=0;i<g.attributes.position.count;i++){let slot=0;for(let j=1;j<4;j++)if(w.getComponent(i,j)>w.getComponent(i,slot))slot=j;const name=o.skeleton.bones[idx.getComponent(i,slot)].name,foot=['l','r'].find(side=>name===meta.bones['foot'+side]||name===meta.bones['toes'+side]);const hand=['l','r'].find(side=>name.startsWith(meta.bones['hand'+side].replace(/_\d+$/,'')));if(foot||hand||this.supportBones.has(name))this.surfaces.push({o,i,foot:foot?['l','r'].indexOf(foot):null,hand:hand?['l','r'].indexOf(hand):null,name});}});
  this.torsoTriangles=[];for(const o of this.surfaceMeshes){const g=o.geometry,w=g.attributes.skinWeight,idx=g.attributes.skinIndex,index=g.index,torso=Array.from({length:g.attributes.position.count},(_,i)=>{let slot=0;for(let j=1;j<4;j++)if(w.getComponent(i,j)>w.getComponent(i,slot))slot=j;const name=o.skeleton.bones[idx.getComponent(i,slot)].name;return this.supportBones.has(name)&&name!==meta.bones.hips&&name!==meta.bones.head;});for(let i=0;i<(index?.count??torso.length);i+=3){const ids=[0,1,2].map(j=>index?index.getX(i+j):i+j);if(ids.filter(j=>torso[j]).length>=2)this.torsoTriangles.push({o,ids});}}
  for(const limb of [this.arm,this.leftArm,...this.legs])prepareCivilianLimb(limb);this.footwork=new CivilianFootwork(this);
 }
 event(e){this.footwork?.event(e);if(e.from===this.u&&['hit','block'].includes(e.type))this.contact={age:0,type:e.type,target:e.target};if(e.type==='death'&&e.unit===this.u){this.deathEntry=this.allBones.map(b=>[b,b.position.clone(),b.quaternion.clone()]);this.deathFeet=this.legs.map(l=>({p:l.foot.getWorldPosition(new T.Vector3()),q:l.foot.getWorldQuaternion(new T.Quaternion())}));this.deathBaseYaw=this.model.rotation.y;}super.event(e);if(e.type==='death'&&e.unit===this.u){this.brace=null;this.rebound=null;this.contact=null;this.guardWeight=0;this.transition=null;const enemy=this.opponent;const dx=enemy?enemy.x-this.u.x:0,dz=enemy?enemy.z-this.u.z:0;const side=Math.cos(this.u.heading)*dx-Math.sin(this.u.heading)*dz;this.deathYaw=(side>0?-1:1)*1.18;}else if(e.type==='block'){if(e.target===this.u&&this.u.hp>0)this.brace={age:0,startReady:this.guardWeight,direction:new T.Vector3(e.nx,0,e.nz),heavy:e.strike==='cleave'};if(e.from===this.u&&this.u.hp>0)this.rebound={age:0,strike:e.strike,target:e.target};}else if(e.type==='hit'&&e.target===this.u&&e.interrupt){this.brace=null;this.rebound=null;}else if(e.type==='cancel-attack'&&e.from===this.u)this.rebound=null;}
 sample(name,time){
  if(this.enabled&&name==='block'){super.sample('idle',this.time%this.actions.get('idle').getClip().duration);this.state='block';return;}
  super.sample(name,time);
 }
 update(dt){
  this.renderDt=dt;if(dt===0&&this.lastPose&&this.lastModelPose){for(const [b,p,q]of this.lastPose){b.position.copy(p);b.quaternion.copy(q);}this.model.position.copy(this.lastModelPose.position);this.model.quaternion.copy(this.lastModelPose.rotation);this.u.root.updateMatrixWorld(true);return;}
  if(this.contact){this.contact.age+=dt;if(this.contact.age>.18)this.contact=null;}
  for(const key of ['brace','rebound'])if(this[key]){this[key].age+=dt;if(this[key].age>(key==='brace'?.42:.25))this[key]=null;}
  // Choose open space once at death, then pivot during the native knee-softening
  // phase. This is a bounded presentation yaw, never a simulation displacement.
  this.model.rotation.y=this.u.hp<=0?this.deathBaseYaw+this.deathYaw*smoothWeight((this.deathAge+dt-.10)/.95):this.footwork.yaw;
  const before=this.lastBasePose??this.lastPose;super.update(dt);this.lastBasePose=this.allBones.map(b=>[b,b.position.clone(),b.quaternion.clone()]);
  if(this.state!==this.previousState){this.transition=before&&this.state!=='death'?{from:before,age:0,duration:this.state==='death'?.36:(this.state==='walk'||this.previousState==='walk')?.24:.14}:null;this.previousState=this.state;}
  if(this.transition){const t=this.transition;t.age+=dt;const w=smoothWeight(t.age/t.duration);for(const [b,p,q]of t.from){this.save(b);b.position.lerpVectors(p,b.position,w);b.quaternion.slerpQuaternions(q,b.quaternion.clone(),w);}this.u.root.updateMatrixWorld(true);if(w===1)this.transition=null;}
  if(this.u.hp<=0){
   if(this.deathEntry&&this.deathAge<.44){const w=smoothWeight(this.deathAge/.44);for(const [b,p,q]of this.deathEntry){this.save(b);b.position.lerpVectors(p,b.position,w);b.quaternion.slerpQuaternions(q,b.quaternion.clone(),w);}this.u.root.updateMatrixWorld(true);
    for(let i=0;i<2;i++){const l=this.legs[i];for(const b of Object.values(l))this.save(b);const p=l.foot.getWorldPosition(new T.Vector3()).lerp(this.deathFeet[i].p,1-smoothWeight((this.deathAge-.16)/.28));projectCivilianFoot(l,p,l.foot.getWorldQuaternion(new T.Quaternion()));}}
   this.settleDeath();return;
  }
  this.footwork.update(dt);
  for(const limb of [this.arm,this.leftArm]){for(const b of Object.values(limb))if(b?.isBone)this.save(b);this.solve(limb,limb.foot.getWorldPosition(new T.Vector3()),limb.foot.getWorldQuaternion(new T.Quaternion()));}
  if(this.rebound){const w=Math.sin(Math.PI*clamp(this.rebound.age/.30))*Math.exp(-this.rebound.age*3);this.save(this.bones.chest);worldRotate(this.bones.chest,UP,-.045*w);for(const b of Object.values(this.arm))this.save(b);const p=this.arm.foot.getWorldPosition(new T.Vector3()),back=new T.Vector3(0,0,-.012*w).applyQuaternion(this.model.getWorldQuaternion(new T.Quaternion()));this.solve(this.arm,p.add(back),this.arm.foot.getWorldQuaternion(new T.Quaternion()));}

  const enemy=this.opponent,action=enemy?.duel.action,eligible=enemy&&canBlock(this.u,enemy);const anticipating=eligible&&action&&action.age<STRIKES[action.strike].contact;
  if(this.guardKey!==action||!anticipating){this.guardActivation=0;this.guardKey=action;}
  if(anticipating)this.guardActivation+=dt;
  const desired=anticipating?smoothWeight(this.guardActivation/.18)*smoothWeight((action.age-(STRIKES[action.strike].contact-.24))/.19):0;
  this.guardWeight=T.MathUtils.lerp(this.guardWeight,desired,dt===0?0:1-Math.exp(-dt*12));
  const brace=this.brace,force=brace?Math.sin(Math.PI*clamp(brace.age/.42))*Math.exp(-brace.age*2):0;
  const ready=Math.max(this.guardWeight,brace?brace.startReady*(1-smoothWeight((brace.age-.19)/.23)):0);
  if(ready<=.00001&&force<=.00001){this.footwork.apply();return;}
  const forward=new T.Vector3(Math.sin(this.u.heading),0,Math.cos(this.u.heading)),right=new T.Vector3(Math.cos(this.u.heading),0,-Math.sin(this.u.heading));
  for(const b of [this.hips,this.bones.chest,...Object.values(this.leftArm),...this.legs.flatMap(l=>Object.values(l))])this.save(b);
  worldShift(this.hips,new T.Vector3(0,-.018*force,0).addScaledVector(forward,-.025*force));worldRotate(this.bones.chest,right,-.16*force);
  const center=this.shieldPoint(),goal=this.bones.chest.getWorldPosition(new T.Vector3()).addScaledVector(forward,.135-.035*force).addScaledVector(right,.035);goal.y+=.018;
  const hand=this.leftArm.foot,wrist=hand.getWorldPosition(new T.Vector3()),shift=goal.sub(center);if(shift.length()>.155)shift.setLength(.155);const target=wrist.clone().addScaledVector(shift,ready);const q=hand.getWorldQuaternion(new T.Quaternion());this.solve(this.leftArm,target,q);
  const grip=this.model.getObjectByName(this.meta.weapons.shieldGrip);const normal=this.shieldPoint().sub(grip?grip.getWorldPosition(new T.Vector3()):this.shield.getWorldPosition(new T.Vector3())).normalize(),turn=new T.Quaternion().setFromUnitVectors(normal,forward),angle=turn.angleTo(new T.Quaternion());if(angle>.30)turn.slerpQuaternions(new T.Quaternion(),turn,.30/angle);const rotation=turn.multiply(hand.getWorldQuaternion(new T.Quaternion())),current=hand.getWorldQuaternion(new T.Quaternion()).slerp(rotation,ready);hand.quaternion.copy(hand.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(current));hand.updateWorldMatrix(false,true);
  this.footwork.apply();
 }
 // Resolve the final pose, after transition blending. Hip contact alone is
 // insufficient for adult torsos; relax spine/neck toward their own support.
 support(){
  this.u.root.updateMatrixWorld(true);for(const o of this.surfaceMeshes)o.skeleton.update();const result={hips:Infinity,chest:Infinity,head:Infinity,footl:Infinity,footr:Infinity,handl:Infinity,handr:Infinity,core:Infinity},p=new T.Vector3();
  for(const {o,i,foot,hand,name}of this.surfaces){o.getVertexPosition(i,p).applyMatrix4(o.matrixWorld);if(foot!==null){const key=foot===0?'footl':'footr';result[key]=Math.min(result[key],p.y);continue;}if(hand!==null){const key=hand===0?'handl':'handr';result[key]=Math.min(result[key],p.y);continue;}result.core=Math.min(result.core,p.y);const key=name===this.meta.bones.hips?'hips':name===this.meta.bones.head?'head':name===this.meta.bones.chest?'chest':null;if(key)result[key]=Math.min(result[key],p.y);}return result;
 }
 shoeSupport(){this.u.root.updateMatrixWorld(true);for(const o of this.surfaceMeshes)o.skeleton.update();const result=[Infinity,Infinity],p=new T.Vector3();for(const {o,i,foot}of this.surfaces){if(foot===null)continue;o.getVertexPosition(i,p).applyMatrix4(o.matrixWorld);result[foot]=Math.min(result[foot],p.y);}return result;}
 shift(b,delta){worldShift(b,delta);}
 solve(limb,target,orientation,preferred){const side=limb===this.arm?-1:limb===this.leftArm?1:limb===this.legs[0]?1:-1,isLeg=this.legs.includes(limb),pole=new T.Vector3(isLeg?side*.1:side,isLeg?0:-.35,isLeg?1:-.2).applyQuaternion(this.model.getWorldQuaternion(new T.Quaternion()));return solveCivilianLimb(limb,target,orientation,preferred??pole,isLeg?.18:.25);}
 settleDeath(){
  // The exported collapse owns joint motion and contact order. Presentation
  // corrects only small support residuals, never 50–100 degree joint bends.
  let support=this.support();if(support.core<0)this.model.position.y-=support.core;
  for(let pass=0;pass<2;pass++){support=this.support();for(let i=0;i<2;i++){const y=support[i===0?'footl':'footr'];if(y>=.0003)continue;const l=this.legs[i],goal=l.foot.getWorldPosition(new T.Vector3());goal.y+=Math.min(.012,.0003-y);for(const b of Object.values(l))this.save(b);projectCivilianFoot(l,goal,l.foot.getWorldQuaternion(new T.Quaternion()));}}

  this.settleEquipment();
  this.u.root.updateMatrixWorld(true);this.model.traverse(o=>{if(o.isSkinnedMesh)o.skeleton.update();});
 }
 equipmentFloor(prefix){let lowest=Infinity;const p=new T.Vector3();this.model.traverse(o=>{if(!o.isMesh||!o.name.startsWith(prefix))return;const positions=o.geometry.attributes.position;for(let i=0;i<positions.count;i++)lowest=Math.min(lowest,p.fromBufferAttribute(positions,i).applyMatrix4(o.matrixWorld).y);});return lowest;}
 settleEquipment(){
  // The left grip transfers weight through the buckler before the torso lands.
  // The sword arm relaxes afterward; native bend planes and skin stay intact.
  const left=this.leftArm,leftFloor=this.equipmentFloor('Buckler'),leftWeight=smoothWeight((this.deathAge-.65)/.65),p=left.foot.getWorldPosition(new T.Vector3());p.y+=leftFloor<.001?.001-leftFloor:Math.max(-.05,.001-leftFloor)*leftWeight;for(const b of Object.values(left))this.save(b);projectCivilianFoot(left,p,left.foot.getWorldQuaternion(new T.Quaternion()));
  const right=this.arm,w=smoothWeight((this.deathAge-.90)/.95),floor=this.support().handr,goal=right.foot.getWorldPosition(new T.Vector3());goal.y-=Math.min(.055,Math.max(0,floor-.002))*w;for(const b of Object.values(right))this.save(b);projectCivilianFoot(right,goal,right.foot.getWorldQuaternion(new T.Quaternion()));
  const wrist=right.foot.getWorldPosition(new T.Vector3()),tip=this.tip(),wanted=tip.clone();wanted.y=.002;const turn=new T.Quaternion().setFromUnitVectors(tip.clone().sub(wrist).normalize(),wanted.sub(wrist).normalize()).slerp(new T.Quaternion(),1-w),q=turn.multiply(right.foot.getWorldQuaternion(new T.Quaternion()).normalize());right.foot.quaternion.copy(right.foot.parent.getWorldQuaternion(new T.Quaternion()).normalize().invert().multiply(q)).normalize();right.foot.updateWorldMatrix(false,true);
  for(const [limb,prefix,hand]of [[left,'Buckler','handl'],[right,'Sword','handr']]){const low=Math.min(this.equipmentFloor(prefix),this.support()[hand]);if(low<.0003){const position=limb.foot.getWorldPosition(new T.Vector3());position.y+=Math.min(.018,.0003-low);projectCivilianFoot(limb,position,limb.foot.getWorldQuaternion(new T.Quaternion()));}}
 }
 bodyContact(origin){
  const center=this.bones.chest.getWorldPosition(new T.Vector3()).add(new T.Vector3(0,.025,0)),direction=center.clone().sub(origin),ray=new T.Ray(origin,direction.clone().normalize()),hit=new T.Vector3(),vertices=new Map();let nearest=Infinity,result=null;
  const vertex=(o,i)=>{let cache=vertices.get(o);if(!cache){cache=new Map();vertices.set(o,cache);}if(!cache.has(i))cache.set(i,o.getVertexPosition(i,new T.Vector3()).applyMatrix4(o.matrixWorld));return cache.get(i);};
  for(const {o,ids}of this.torsoTriangles){const [a,b,c]=ids.map(i=>vertex(o,i));if(ray.intersectTriangle(a,b,c,false,hit)){const distance=origin.distanceTo(hit);if(distance<nearest&&distance<direction.length()+.06){nearest=distance;result=hit.clone();}}}
  return result??center;
 }
 bladeShieldContact(target){
  const blade=this.model.getObjectByName('SwordBlade');blade.geometry.computeBoundingBox();const box=blade.geometry.boundingBox,size=box.getSize(new T.Vector3()),axis=['x','y','z'].sort((a,b)=>size[b]-size[a])[0],start=box.getCenter(new T.Vector3()),end=start.clone();start[axis]=box.min[axis];end[axis]=box.max[axis];start.applyMatrix4(blade.matrixWorld);end.applyMatrix4(blade.matrixWorld);const dir=end.clone().sub(start),ray=new T.Ray(start,dir.clone().normalize()),triangle=new T.Triangle(),closest=new T.Vector3(),hit=new T.Vector3();let best={gap:Infinity,from:start.clone(),to:start.clone()};
  const test=(from,to)=>{const gap=from.distanceTo(to);if(gap<best.gap)best={gap,from:from.clone(),to:to.clone()};};
  const edge=(a,b)=>{const u=dir,v=b.clone().sub(a),r=start.clone().sub(a),aa=u.dot(u),bb=u.dot(v),cc=v.dot(v),dd=u.dot(r),ee=v.dot(r),den=aa*cc-bb*bb;let t=T.MathUtils.clamp(den?(bb*ee-cc*dd)/den:0,0,1),w=cc?T.MathUtils.clamp((bb*t+ee)/cc,0,1):0;t=T.MathUtils.clamp((bb*w-dd)/aa,0,1);test(start.clone().addScaledVector(u,t),a.clone().addScaledVector(v,w));};
  for(const name of ['BucklerWood','BucklerRim','BucklerBoss']){const object=target.model.getObjectByName(name),g=object.geometry,pos=g.attributes.position,index=g.index;for(let i=0;i<(index?.count??pos.count);i+=3){const points=[0,1,2].map(j=>new T.Vector3().fromBufferAttribute(pos,index?index.getX(i+j):i+j).applyMatrix4(object.matrixWorld));const [a,b,c]=points;if(ray.intersectTriangle(a,b,c,false,hit)&&hit.distanceTo(start)<=dir.length()){test(hit,hit);return best;}triangle.set(a,b,c);test(start,triangle.closestPointToPoint(start,closest));test(end,triangle.closestPointToPoint(end,closest));edge(a,b);edge(b,c);edge(c,a);}}
  return best;
 }
 shieldPoint(){return this.model.getObjectByName(this.meta.weapons.shieldContact).getWorldPosition(new T.Vector3());}
 aim(target){
  if(this.renderDt===0&&this.lastModelPose)return;
  const action=this.u.duel.action;
  if(action&&this.u.hp>0){const spec=STRIKES[action.strike];let weight=contactWeight(action.age,spec.contact);if(this.contact)weight=Math.max(weight,1-smoothWeight((this.contact.age-.025)/.13));
   if(weight>0){const origin=this.arm.hip.getWorldPosition(new T.Vector3()),point=target.animation.bodyContact(origin);if(this.contact&&target.hp<=0){this.contact.point??=point.clone();point.copy(this.contact.point);}
    const hand=this.bones.right,wrist=hand.getWorldPosition(new T.Vector3()),shoulder=this.arm.hip.getWorldPosition(new T.Vector3()),tip=this.tip(),length=tip.distanceTo(wrist),ray=point.clone().sub(shoulder),distance=ray.length();ray.normalize();
    // Solve for a reachable wrist along the shoulder-to-contact ray, accounting
    // for the actual blade length before moving the arm. No 1.6x reach demand.
    const desired=shoulder.clone().addScaledVector(ray,Math.max(.035,distance-length)),goal=wrist.clone().lerp(desired,weight);for(const b of Object.values(this.arm))this.save(b);this.lastReach=this.solve(this.arm,goal,hand.getWorldQuaternion(new T.Quaternion()));this.lastAim={point:point.toArray(),shield:target.animation.shieldPoint?.().toArray(),weight,contactType:this.contact?.type??null,reach:{...this.lastReach},shoulder:shoulder.toArray(),requested:goal.toArray(),bladeLength:length,presentedOffset:this.footwork.offset.toArray(),targetOffset:target.animation.footwork?.offset.toArray()};
    const now=hand.getWorldPosition(new T.Vector3()),currentTip=this.tip(),wanted=currentTip.clone().lerp(point,weight).sub(now).normalize(),current=currentTip.sub(now).normalize(),rotation=new T.Quaternion().setFromUnitVectors(current,wanted).multiply(hand.getWorldQuaternion(new T.Quaternion()));hand.quaternion.copy(hand.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(rotation));hand.updateWorldMatrix(false,true);

   }
  }
  if(this.contact?.type==='block'&&this.contact.target.hp>0){const target=this.contact.target;for(let pass=0;pass<2;pass++){const pair=this.bladeShieldContact(target);this.lastContactSurface={gap:pair.gap,point:pair.to.toArray(),bladePoint:pair.from.toArray()};if(pair.gap<.002)break;const hand=this.arm.foot,wrist=hand.getWorldPosition(new T.Vector3()),delta=pair.to.clone().sub(pair.from);if(delta.length()>.018)delta.setLength(.018);this.solve(this.arm,wrist.clone().add(delta),hand.getWorldQuaternion(new T.Quaternion()));const from=pair.from.clone().sub(wrist).normalize(),to=pair.to.clone().sub(wrist).normalize(),turn=new T.Quaternion().setFromUnitVectors(from,to),angle=turn.angleTo(new T.Quaternion());if(angle>.14)turn.slerpQuaternions(new T.Quaternion(),turn,.14/angle);hand.quaternion.copy(hand.parent.getWorldQuaternion(new T.Quaternion()).normalize().invert().multiply(turn.multiply(hand.getWorldQuaternion(new T.Quaternion()).normalize()))).normalize();hand.updateWorldMatrix(false,true);}}
  this.lastPose=this.allBones.map(b=>[b,b.position.clone(),b.quaternion.clone()]);this.lastModelPose={position:this.model.position.clone(),rotation:this.model.quaternion.clone()};
 }
}

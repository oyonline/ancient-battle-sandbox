import * as T from 'three';
import {CivilianAnimation} from './civilian-animation.js';
import {STRIKES,canBlock} from './sword-duel.js';
import {worldRotate,worldShift} from './impact-performance.js';
import {solveCivilianLimb} from './civilian-ik.js';
const UP=new T.Vector3(0,1,0),clamp=x=>Math.max(0,Math.min(1,x));
export const smoothWeight=x=>{x=clamp(x);return x*x*(3-2*x);};
export const contactWeight=(age,contact)=>{const x=Math.abs(age-contact)/.18;return x>=1?0:.5+.5*Math.cos(Math.PI*x);};
// Independent adult Mixamo presentation. Original KayKit/Quaternius paths
// remain available. No random draws, damage or authoritative phases are written.
export class CivilianPerformance extends CivilianAnimation{
 constructor(u,template,meta){super(u,template,meta);this.enabled=true;this.brace=null;this.rebound=null;this.transition=null;this.previousState='idle';this.guardWeight=0;this.lastPose=null;this.deathYaw=0;this.allBones=[];u.model.traverse(o=>{if(o.isBone)this.allBones.push(o);});const find=n=>u.model.getObjectByName(n);this.hips=find(meta.bones.hips);this.leftArm={hip:find(meta.bones.arml),knee:find(meta.bones.forearml),foot:find(meta.bones.handl)};this.legs=['l','r'].map(s=>({hip:find(meta.bones['thigh'+s]),knee:find(meta.bones['shin'+s]),foot:find(meta.bones['foot'+s])}));this.shield=find('BucklerWood');this.shield.geometry.computeBoundingBox();this.shieldLocal=this.shield.geometry.boundingBox.getCenter(new T.Vector3());const size=this.shield.geometry.boundingBox.getSize(new T.Vector3());this.normalLocal=new T.Vector3(...[size.x,size.y,size.z].map((v,i)=>i===[size.x,size.y,size.z].indexOf(Math.min(size.x,size.y,size.z))?1:0));}
 event(e){super.event(e);if(e.type==='death'&&e.unit===this.u){this.brace=null;this.rebound=null;this.guardWeight=0;this.transition=null;const enemy=this.opponent;const dx=enemy?enemy.x-this.u.x:0,dz=enemy?enemy.z-this.u.z:0;const side=Math.cos(this.u.heading)*dx-Math.sin(this.u.heading)*dz;this.deathYaw=(side>0?-1:1)*1.18;}else if(e.type==='block'){if(e.target===this.u&&this.u.hp>0)this.brace={age:0,direction:new T.Vector3(e.nx,0,e.nz),heavy:e.strike==='cleave'};if(e.from===this.u&&this.u.hp>0)this.rebound={age:0,strike:e.strike,target:e.target};}else if(e.type==='hit'&&e.target===this.u&&e.interrupt){this.brace=null;this.rebound=null;}else if(e.type==='cancel-attack'&&e.from===this.u)this.rebound=null;}
 sample(name,time){
  if(this.enabled&&name==='block'){super.sample('idle',this.time%this.actions.get('idle').getClip().duration);this.state='block';return;}
  if(this.enabled&&this.rebound&&name===this.rebound.strike){const r=this.rebound,contact=this.clipContacts[name];if(r.age<.045)time=contact;else if(r.age<.14)time=contact-.045*smoothWeight((r.age-.045)/.095);else if(r.age<.25)time=T.MathUtils.lerp(contact-.045,time,smoothWeight((r.age-.14)/.11));}
  super.sample(name,time);
 }
 update(dt){
  for(const key of ['brace','rebound'])if(this[key]){this[key].age+=dt;if(this[key].age>(key==='brace'?.42:.25))this[key]=null;}
  // Choose open space once at death, then pivot during the native knee-softening
  // phase. This is a bounded presentation yaw, never a simulation displacement.
  this.model.rotation.y=this.u.hp<=0?this.deathYaw*smoothWeight((this.deathAge+dt-.08)/.85):0;
  const before=this.lastPose;super.update(dt);
  if(this.state!==this.previousState){this.transition=before?{from:before,age:0,duration:this.state==='death'?.22:(this.state==='walk'||this.previousState==='walk')?.24:.14}:null;this.previousState=this.state;}
  if(this.transition){const t=this.transition;t.age+=dt;const w=smoothWeight(t.age/t.duration);for(const [b,p,q]of t.from){this.save(b);b.position.lerpVectors(p,b.position,w);b.quaternion.slerpQuaternions(q,b.quaternion.clone(),w);}this.u.root.updateMatrixWorld(true);if(w===1)this.transition=null;}
  if(this.u.hp<=0){this.settleDeath();return;}
  const enemy=this.opponent,action=enemy?.duel.action,eligible=enemy&&canBlock(this.u,enemy);const desired=eligible&&action?smoothWeight((action.age-(STRIKES[action.strike].contact-.24))/.19):0;
  // Preparing a legal guard never predicts the random block result. Both failed
  // and successful guards can raise their shield; only a real block adds load.
  this.guardWeight=T.MathUtils.lerp(this.guardWeight,desired,dt===0?0:1-Math.exp(-dt*22));
  const brace=this.brace,force=brace?Math.sin(Math.PI*clamp(brace.age/.42))*Math.exp(-brace.age*2):0;
  const ready=Math.max(this.guardWeight,brace?1-smoothWeight((brace.age-.19)/.23):0);
  if(ready<=.00001)return;
  const forward=new T.Vector3(Math.sin(this.u.heading),0,Math.cos(this.u.heading)),right=new T.Vector3(Math.cos(this.u.heading),0,-Math.sin(this.u.heading));
  const anchors=this.legs.map(l=>l.foot.getWorldPosition(new T.Vector3())),orientations=this.legs.map(l=>l.foot.getWorldQuaternion(new T.Quaternion()));
  for(const b of [this.hips,this.bones.chest,...Object.values(this.leftArm),...this.legs.flatMap(l=>Object.values(l))])this.save(b);
  worldShift(this.hips,new T.Vector3(0,-.018*force,0).addScaledVector(forward,-.025*force));worldRotate(this.bones.chest,right,-.16*force);
  const center=this.shieldPoint(),goal=this.bones.chest.getWorldPosition(new T.Vector3()).addScaledVector(forward,.135-.035*force).addScaledVector(right,.035);goal.y+=.018;
  const hand=this.leftArm.foot,wrist=hand.getWorldPosition(new T.Vector3()),target=wrist.clone().addScaledVector(goal.sub(center),ready);const q=hand.getWorldQuaternion(new T.Quaternion());this.solve(this.leftArm,target,q);
  let normal=this.normalLocal.clone().transformDirection(this.shield.matrixWorld);if(normal.dot(forward)<0)normal.negate();const rotation=new T.Quaternion().setFromUnitVectors(normal,forward).multiply(hand.getWorldQuaternion(new T.Quaternion()));const current=hand.getWorldQuaternion(new T.Quaternion()).slerp(rotation,ready);hand.quaternion.copy(hand.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(current));hand.updateWorldMatrix(false,true);
  for(let i=0;i<2;i++)this.solve(this.legs[i],anchors[i],orientations[i]);
 }
 // Resolve the final pose, after transition blending. Hip contact alone is
 // insufficient for adult torsos; relax spine/neck toward their own support.
 support(){
  this.u.root.updateMatrixWorld(true);const result={hips:Infinity,chest:Infinity,head:Infinity,footl:Infinity,footr:Infinity,core:Infinity},p=new T.Vector3();
  this.model.traverse(o=>{if(!o.isSkinnedMesh)return;o.skeleton.update();const g=o.geometry,weights=g.attributes.skinWeight,indices=g.attributes.skinIndex;for(let i=0;i<g.attributes.position.count;i++){let slot=0;for(let j=1;j<4;j++)if(weights.getComponent(i,j)>weights.getComponent(i,slot))slot=j;const name=o.skeleton.bones[indices.getComponent(i,slot)].name;const foot=['l','r'].find(side=>name===this.meta.bones['foot'+side]||name===this.meta.bones['toes'+side]);if(!this.supportBones.has(name)&&!foot)continue;o.getVertexPosition(i,p).applyMatrix4(o.matrixWorld);if(foot){result['foot'+foot]=Math.min(result['foot'+foot],p.y);continue;}result.core=Math.min(result.core,p.y);const key=name===this.meta.bones.hips?'hips':name===this.meta.bones.head?'head':name===this.meta.bones.chest?'chest':null;if(key)result[key]=Math.min(result[key],p.y);}});return result;
 }
 solve(limb,target,orientation){const side=limb===this.arm?-1:limb===this.leftArm?1:limb===this.legs[0]?1:-1,isLeg=this.legs.includes(limb),pole=new T.Vector3(isLeg?side*.1:side,isLeg?0:-.35,isLeg?1:-.2).applyQuaternion(this.model.getWorldQuaternion(new T.Quaternion()));return solveCivilianLimb(limb,target,orientation,pole,isLeg?.10:.18);}
 settleDeath(){
  // The exported collapse owns joint motion and contact order. Presentation
  // corrects only small support residuals, never 50–100 degree joint bends.
  const support=this.support();if(support.core<0)this.model.position.y-=support.core;
  this.u.root.updateMatrixWorld(true);this.model.traverse(o=>{if(o.isSkinnedMesh)o.skeleton.update();});
 }
 shieldPoint(){return this.model.getObjectByName(this.meta.weapons.shieldContact).getWorldPosition(new T.Vector3());}
 aim(target){
  const action=this.u.duel.action;
  if(action&&this.u.hp>0){const spec=STRIKES[action.strike];let weight=contactWeight(action.age,spec.contact);if(this.rebound)weight=1-smoothWeight((this.rebound.age-.045)/.10);
   if(weight>0){const point=target.animation.bones.chest.getWorldPosition(new T.Vector3());point.addScaledVector(new T.Vector3(Math.sin(this.u.heading),0,Math.cos(this.u.heading)),-.075);point.y+=target.asset==='kaykit'?.015:.025;if(target.animation.shieldPoint){const guard=target.animation.guardWeight??0,rebound=this.rebound?smoothWeight(this.rebound.age/.035):0;point.lerp(target.animation.shieldPoint(),Math.max(guard,rebound));}
    const hand=this.bones.right,wrist=hand.getWorldPosition(new T.Vector3()),shoulder=this.arm.hip.getWorldPosition(new T.Vector3()),tip=this.tip(),length=tip.distanceTo(wrist),ray=point.clone().sub(shoulder),distance=ray.length();ray.normalize();
    // Solve for a reachable wrist along the shoulder-to-contact ray, accounting
    // for the actual blade length before moving the arm. No 1.6x reach demand.
    const desired=shoulder.clone().addScaledVector(ray,Math.max(.035,distance-length)),goal=wrist.clone().lerp(desired,weight);for(const b of Object.values(this.arm))this.save(b);this.lastReach=this.solve(this.arm,goal,hand.getWorldQuaternion(new T.Quaternion()));
    const now=hand.getWorldPosition(new T.Vector3()),currentTip=this.tip(),wanted=currentTip.clone().lerp(point,weight).sub(now).normalize(),current=currentTip.sub(now).normalize(),rotation=new T.Quaternion().setFromUnitVectors(current,wanted).multiply(hand.getWorldQuaternion(new T.Quaternion()));hand.quaternion.copy(hand.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(rotation));hand.updateWorldMatrix(false,true);

   }
  }
  this.lastPose=this.allBones.map(b=>[b,b.position.clone(),b.quaternion.clone()]);
 }
}

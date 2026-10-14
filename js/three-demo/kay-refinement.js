import * as T from 'three';
import {LibraryAnimation} from './library-animation.js';
import {STRIKES,canBlock} from './sword-duel.js';
import {legTo,worldRotate,worldShift} from './impact-performance.js';
const UP=new T.Vector3(0,1,0),clamp=x=>Math.max(0,Math.min(1,x));
export const smoothWeight=x=>{x=clamp(x);return x*x*(3-2*x);};
export const contactWeight=(age,contact)=>{const x=Math.abs(age-contact)/.18;return x>=1?0:.5+.5*Math.cos(Math.PI*x);};
// Kay-only presentation. The original LibraryAnimation and Quaternius path
// remain available. No random draws, damage or authoritative phases are written.
export class KayRefinement extends LibraryAnimation{
 constructor(u,template,meta){super(u,template,meta);this.enabled=true;this.brace=null;this.rebound=null;this.transition=null;this.previousState='idle';this.guardWeight=0;this.lastPose=null;this.deathYaw=0;this.allBones=[];u.model.traverse(o=>{if(o.isBone)this.allBones.push(o);});const find=n=>u.model.getObjectByName(n);this.hips=find('hips');this.leftArm={hip:find('upperarml'),knee:find('lowerarml'),foot:find('handl')};this.legs=['l','r'].map(s=>({hip:find('upperleg'+s),knee:find('lowerleg'+s),foot:find('foot'+s)}));this.shield=find('Badge_Shield');this.shield.geometry.computeBoundingBox();this.shieldLocal=this.shield.geometry.boundingBox.getCenter(new T.Vector3());const size=this.shield.geometry.boundingBox.getSize(new T.Vector3());this.normalLocal=new T.Vector3(...[size.x,size.y,size.z].map((v,i)=>i===[size.x,size.y,size.z].indexOf(Math.min(size.x,size.y,size.z))?1:0));}
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
  if(this.state!==this.previousState){this.transition=before?{from:before,age:0,duration:this.state==='death'?.10:.085}:null;this.previousState=this.state;}
  if(this.transition){const t=this.transition;t.age+=dt;const w=smoothWeight(t.age/t.duration);for(const [b,p,q]of t.from){this.save(b);b.position.lerpVectors(p,b.position,w);b.quaternion.slerpQuaternions(q,b.quaternion.clone(),w);}this.u.root.updateMatrixWorld(true);if(w===1)this.transition=null;}
  if(this.u.hp<=0)return;
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
  const hand=this.leftArm.foot,wrist=hand.getWorldPosition(new T.Vector3()),target=wrist.clone().addScaledVector(goal.sub(center),ready);const q=hand.getWorldQuaternion(new T.Quaternion());legTo(this.leftArm,target,q);
  let normal=this.normalLocal.clone().transformDirection(this.shield.matrixWorld);if(normal.dot(forward)<0)normal.negate();const rotation=new T.Quaternion().setFromUnitVectors(normal,forward).multiply(hand.getWorldQuaternion(new T.Quaternion()));const current=hand.getWorldQuaternion(new T.Quaternion()).slerp(rotation,ready);hand.quaternion.copy(hand.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(current));hand.updateWorldMatrix(false,true);
  for(let i=0;i<2;i++)legTo(this.legs[i],anchors[i],orientations[i]);
 }
 shieldPoint(){return this.shield.localToWorld(this.shieldLocal.clone());}
 aim(target){
  const action=this.u.duel.action;
  if(action&&this.u.hp>0){const spec=STRIKES[action.strike];let weight=contactWeight(action.age,spec.contact);if(this.rebound)weight=1-smoothWeight((this.rebound.age-.045)/.10);
   if(weight>0){const point=target.animation.bones.chest.getWorldPosition(new T.Vector3());point.addScaledVector(new T.Vector3(Math.sin(this.u.heading),0,Math.cos(this.u.heading)),-.075);point.y+=target.asset==='kaykit'?.015:.025;if(target.animation.shieldPoint){const guard=target.animation.guardWeight??0,rebound=this.rebound?smoothWeight(this.rebound.age/.035):0;point.lerp(target.animation.shieldPoint(),Math.max(guard,rebound));}
    const hand=this.bones.right,wrist=hand.getWorldPosition(new T.Vector3()),tip=this.tip(),goal=wrist.clone().addScaledVector(point.clone().sub(tip),weight);for(const b of Object.values(this.arm))this.save(b);legTo(this.arm,goal,hand.getWorldQuaternion(new T.Quaternion()));
    const now=hand.getWorldPosition(new T.Vector3()),currentTip=this.tip(),wanted=currentTip.clone().lerp(point,weight).sub(now).normalize(),current=currentTip.sub(now).normalize();const rotation=new T.Quaternion().setFromUnitVectors(current,wanted).multiply(hand.getWorldQuaternion(new T.Quaternion()));hand.quaternion.copy(hand.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(rotation));hand.updateWorldMatrix(false,true);
   }
  }
  this.lastPose=this.allBones.map(b=>[b,b.position.clone(),b.quaternion.clone()]);
 }
}

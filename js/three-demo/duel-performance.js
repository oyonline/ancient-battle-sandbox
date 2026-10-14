import {Vector3,Quaternion} from 'three';
import {ImpactPerformance,worldRotate,worldShift,legTo,reactionEnvelope} from './impact-performance.js';
import {STRIKES} from './sword-duel.js';
const UP=new Vector3(0,1,0),smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
// Wrist and blade directions in unscaled actor-local coordinates. Each strike
// has a different silhouette, a fast contact segment, and a slower return.
const SHAPES={
 slash:{load:[.83,2.03,.05],axis:[.86,.20,.42],contact:[.42,1.83,.71],end:[-.02,1.73,.62],endAxis:[-.80,-.12,.55]},
 cleave:{load:[.34,2.55,.03],axis:[.04,.99,.12],contact:[.40,1.92,.70],end:[.39,1.55,.62],endAxis:[.02,-.55,.84]},
 thrust:{load:[.46,1.85,.10],axis:[.05,.08,1],contact:[.43,1.85,.83],end:[.46,1.85,.58],endAxis:[.05,.05,1]},
};
export class DuelPerformance extends ImpactPerformance{
 register(u){super.register(u);const s=this.actors.get(u);s.arm={hip:u.model.getObjectByName('UpperArmR'),knee:u.model.getObjectByName('ForearmR'),foot:u.model.getObjectByName('HandR')};u.root.updateMatrixWorld(true);s.bladeLocal=new Vector3(.44,.86,.26).normalize().applyQuaternion(u.root.getWorldQuaternion(new Quaternion())).applyQuaternion(s.arm.foot.getWorldQuaternion(new Quaternion()).invert());s.block=null;s.rebound=null;}
 event(e){
  if(e.type==='attack'){super.event(e);const s=this.actors.get(e.from);if(s){s.reaction=null;s.block=null;}return;}
  if(e.type==='block'){const s=this.actors.get(e.target),a=this.actors.get(e.from);if(s&&e.target.hp>0){s.block={age:0,direction:new Vector3(e.nx,0,e.nz),heavy:e.strike==='cleave'};s.reaction=null;}if(a)a.rebound={age:0};this.events.push({time:this.time,type:'block',from:e.from.id,target:e.target.id,strike:e.strike});return;}
  super.event(e);if(e.type==='hit'){const s=this.actors.get(e.target);if(s?.reaction)s.reaction.strength=.7+e.damage/31*.8;}if(e.type==='death'){const s=this.actors.get(e.unit);if(s){s.block=null;s.rebound=null;}}
 }
 tick(dt){super.tick(dt);for(const s of this.actors.values()){if(s.block){s.block.age+=dt;if(s.block.age>.38)s.block=null;}if(s.rebound){s.rebound.age+=dt;if(s.rebound.age>.24)s.rebound=null;}}}
 prepare(u,dt){const result=super.prepare(u,dt);return{...result,attackTime:u.duel?.action?0:undefined};}
 apply(u){
  const s=this.actors.get(u);if(!s||u.hp<=0)return;const action=u.duel?.action;
  // The duel's authoritative action owns its pose. A protected committed strike
  // continues, while an actual cancelled windup yields to Hit immediately.
  const oldAttack=s.attack,reaction=s.reaction;s.attack=null;if(action)s.reaction=null;super.apply(u);s.attack=oldAttack;s.reaction=reaction;
  const save=bone=>{if(bone&&!s.saved.some(([b])=>b===bone))s.saved.push([bone,bone.position.clone(),bone.quaternion.clone()]);};Object.values(s.arm).forEach(save);
  const forward=new Vector3(Math.sin(u.heading),0,Math.cos(u.heading)),right=new Vector3(Math.cos(u.heading),0,-Math.sin(u.heading)),axis=new Vector3().crossVectors(UP,forward),scale=u.presentationScale;
  const anchors=s.legs.map(l=>l.foot.getWorldPosition(new Vector3())),orientations=s.legs.map(l=>l.foot.getWorldQuaternion(new Quaternion()));
  if(action){
   const spec=STRIKES[action.strike],shape=SHAPES[action.strike],t=action.age,release=action.strike==='thrust'?.075:.11,start=spec.contact-release;
   const neutral=new Vector3(.55,1.83,.28),neutralAxis=new Vector3(.44,.86,.26).normalize();let wrist,blade;
   if(t<start){const v=smooth(t/Math.max(.1,start*.75));wrist=neutral.clone().lerp(new Vector3(...shape.load),v);blade=neutralAxis.clone().lerp(new Vector3(...shape.axis),v);}
   else if(t<spec.contact){const v=smooth((t-start)/release);wrist=new Vector3(...shape.load).lerp(new Vector3(...shape.contact),v);blade=new Vector3(...shape.axis).lerp(new Vector3(.10,-.06,1),v);}
   else if(t<spec.contact+.13){const v=smooth((t-spec.contact)/.13);wrist=new Vector3(...shape.contact).lerp(new Vector3(...shape.end),v);blade=new Vector3(.10,-.06,1).lerp(new Vector3(...shape.endAxis),v);}
   else{const v=smooth((t-spec.contact-.13)/(spec.duration-spec.contact-.13));wrist=new Vector3(...shape.end).lerp(neutral,v);blade=new Vector3(...shape.endAxis).lerp(neutralAxis,v);}
   const load=smooth(t/Math.max(.1,start))*(1-smooth((t-start)/release)),drive=smooth((t-start)/release)*(1-smooth((t-spec.contact-.10)/(spec.duration-spec.contact-.10)));
   worldShift(s.bones.hips,new Vector3(0,-(.08*load+.05*drive)*scale,0).addScaledVector(forward,.08*drive*scale));worldRotate(s.bones.spine,axis,-.10*load+.18*drive);worldRotate(s.bones.chest,UP,(action.strike==='slash'?-.38:.10)*load+(action.strike==='slash'?.38:.06)*drive);
   if(s.rebound){const back=reactionEnvelope(s.rebound.age)*.12;wrist.z-=back;blade.y+=back*2;}
   const desired=u.root.localToWorld(wrist.multiplyScalar(scale));const handQ=s.arm.foot.getWorldQuaternion(new Quaternion());legTo(s.arm,desired,handQ);
   const current=s.bladeLocal.clone().applyQuaternion(s.arm.foot.getWorldQuaternion(new Quaternion())),wanted=right.clone().multiplyScalar(blade.x).addScaledVector(UP,blade.y).addScaledVector(forward,blade.z).normalize();const q=new Quaternion().setFromUnitVectors(current.normalize(),wanted).multiply(s.arm.foot.getWorldQuaternion(new Quaternion()));s.arm.foot.quaternion.copy(s.arm.foot.parent.getWorldQuaternion(new Quaternion()).invert().multiply(q));s.arm.foot.updateWorldMatrix(false,true);
   for(let i=0;i<s.legs.length;i++){if(i===1){anchors[i].addScaledVector(forward,.18*scale*drive);}legTo(s.legs[i],anchors[i],orientations[i]);}
  }else if(s.block){const force=reactionEnvelope(s.block.age),a=new Vector3().crossVectors(UP,s.block.direction);worldRotate(s.bones.chest,a,.10*force);worldRotate(s.bones.shield,axis,-.48*force);worldRotate(s.bones.forearm,UP,-.28*force);worldShift(s.bones.hips,new Vector3(0,-.06*scale*force,0));for(let i=0;i<s.legs.length;i++)legTo(s.legs[i],anchors[i],orientations[i]);}
 }
}

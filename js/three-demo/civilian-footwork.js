import {Vector3,Quaternion,MathUtils} from 'three';
const smooth=x=>{x=MathUtils.clamp(x,0,1);return x*x*(3-2*x);};
const UP=new Vector3(0,1,0);

// Presentation feet keep their world contacts while the rule actor moves.
// Planning is driven by travel, a committed attack or an actual impact.
export class CivilianFootwork{
 constructor(a){
  this.a=a;this.time=0;this.offset=new Vector3();this.yaw=0;this.lastAction=null;this.impact=null;this.next=0;this.lead=0;
  a.u.root.updateMatrixWorld(true);const center=a.model.getWorldPosition(new Vector3()),q=a.u.root.getWorldQuaternion(new Quaternion());
  this.feet=a.legs.map(l=>{const p=l.foot.getWorldPosition(new Vector3()),rotation=l.foot.getWorldQuaternion(new Quaternion());return {anchor:p.clone(),rotation,rest:p.clone().sub(center).applyQuaternion(q.clone().invert()),restRotation:q.clone().invert().multiply(rotation),swing:null};});
 }
 event(e){if(e.target===this.a.u&&['hit','block'].includes(e.type))this.impact={age:0,heavy:e.damage>=20};}
 frame(){const q=this.a.u.root.getWorldQuaternion(new Quaternion());return {q,forward:new Vector3(0,0,1).applyQuaternion(q),side:new Vector3(1,0,0).applyQuaternion(q)};}
 step(index,target,duration){const f=this.feet[index];if(f.swing||this.feet.some(x=>x.swing))return;const delta=target.clone().sub(f.anchor);delta.y=0;if(delta.length()<.012)return;if(delta.length()>.17)target=f.anchor.clone().addScaledVector(delta,.17/delta.length());target.y=f.anchor.y;f.swing={from:f.anchor.clone(),to:target,age:0,duration,fromQ:f.rotation.clone(),toQ:this.frame().q.multiply(f.restRotation)};this.next=1-index;}
 update(dt){
  if(this.a.u.hp<=0)return;
  this.time+=dt;if(this.impact){this.impact.age+=dt;if(this.impact.age>.55)this.impact=null;}
  const {q,forward,side}=this.frame(),action=this.a.u.duel.action,spec=action&&this.a.specs[action.strike];
  let fore=0,lateral=0,load=0;
  if(action){const prepare=smooth(action.age/Math.max(.12,spec.contact-.08)),release=1-smooth((action.age-spec.contact-.10)/(spec.duration-spec.contact-.10));load=prepare*release;fore=.065*load;lateral=(action.strike==='slash'?.042:action.strike==='thrust'?-.018:.014)*load;}
  if(this.impact){const w=Math.sin(Math.PI*MathUtils.clamp(this.impact.age/.38,0,1));fore-=.023*w;}
  const desired=forward.clone().multiplyScalar(fore).addScaledVector(side,lateral),local=desired.applyQuaternion(q.clone().invert());
  // Exponential convergence is time based and exactly inert on paused renders.
  this.offset.lerp(local,dt===0?0:1-Math.exp(-dt*18));this.yaw=MathUtils.lerp(this.yaw,lateral*.9,dt===0?0:1-Math.exp(-dt*14));
  this.a.model.position.x=this.offset.x;this.a.model.position.z=this.offset.z;this.a.model.rotation.y=this.yaw;this.a.u.root.updateMatrixWorld(true);
  const center=this.a.model.getWorldPosition(new Vector3());
  if(action!==this.lastAction){this.lastAction=action;if(action){const lead=action.strike==='thrust'?1:0;this.lead=lead;const target=center.clone().add(this.feet[lead].rest.clone().applyQuaternion(q)).addScaledVector(forward,.065).addScaledVector(side,action.strike==='slash'?.027:0);this.step(lead,target,Math.min(.24,spec.contact*.65));}}
  if(this.a.u.moving&&!this.feet.some(f=>f.swing)){const f=this.feet[this.next],target=center.clone().add(f.rest.clone().applyQuaternion(q)).addScaledVector(forward,.062);if(target.distanceTo(f.anchor)>.066)this.step(this.next,target,.28);}
  if(!this.a.u.moving&&!action&&!this.feet.some(f=>f.swing)){const choices=this.feet.map((f,i)=>({i,target:center.clone().add(f.rest.clone().applyQuaternion(q))})).sort((a,b)=>b.target.distanceTo(this.feet[b.i].anchor)-a.target.distanceTo(this.feet[a.i].anchor));const c=choices[0];if(c.target.distanceTo(this.feet[c.i].anchor)>.043)this.step(c.i,c.target,.32);}
  for(const f of this.feet){if(!f.swing)continue;const s=f.swing;s.age+=dt;const t=MathUtils.clamp(s.age/s.duration,0,1),w=smooth(t);f.anchor.lerpVectors(s.from,s.to,w);f.anchor.y=s.from.y+.024*Math.sin(Math.PI*t)**2;f.rotation.slerpQuaternions(s.fromQ,s.toQ,w);if(t===1){f.anchor.copy(s.to);f.rotation.copy(s.toQ);f.swing=null;}}
  this.load=load;
 }
 apply(){
  const a=this.a,{forward,side}=this.frame();
  const center=this.feet[0].anchor.clone().add(this.feet[1].anchor).multiplyScalar(.5).lerp(this.feet[this.lead].anchor,.45*(this.load??0)),hips=a.hips.getWorldPosition(new Vector3());
  const delta=center.sub(hips);delta.y=0;if(delta.length()>.028)delta.setLength(.028);
  a.save(a.hips);a.shift(a.hips,delta.multiplyScalar(.45).addScaledVector(forward,.028*(this.load??0)).addScaledVector(UP,-.006*(this.load??0)));
  for(let i=0;i<2;i++){const l=a.legs[i],f=this.feet[i];for(const b of Object.values(l))a.save(b);a.solve(l,f.anchor,f.rotation,forward.clone().addScaledVector(side,i===0?.045:-.045));}
  // Skin near the ankle can have shin weights; use the actual shoe surface.
  for(let pass=0;pass<2;pass++){const floor=a.shoeSupport();for(let i=0;i<2;i++){const y=floor[i],f=this.feet[i];if(y>=.0003||f.swing)continue;const goal=f.anchor.clone();goal.y+=Math.min(.012,.0003-y);a.solve(a.legs[i],goal,f.rotation,forward.clone().addScaledVector(side,i===0?.045:-.045));}}
 }
 inspect(){return {time:this.time,offset:this.offset.toArray(),yaw:this.yaw,feet:this.feet.map(f=>({anchor:f.anchor.toArray(),planted:!f.swing,swingAge:f.swing?.age??null}))};}
}

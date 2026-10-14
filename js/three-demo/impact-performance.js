import {Vector3,Quaternion} from 'three';
const UP=new Vector3(0,1,0),clamp=n=>Math.max(0,Math.min(1,n));
const smooth=n=>{n=clamp(n);return n*n*(3-2*n);};
// Real attack time -> authored pose time. Last 68ms carries the release into
// the original 11/24 hit. Recovery still finishes at the native .875 seconds.
export function attackPoseTime(age){
 const keys=[[0,0],[.22,.18],[.39,.30],[11/24,11/24],[.53,.65],[.875,.875]];
 for(let i=1;i<keys.length;i++)if(age<=keys[i][0]){const[a,x]=keys[i-1],[b,y]=keys[i];return x+(y-x)*clamp((age-a)/(b-a));}
 return .875;
}
export function reactionEnvelope(age,charge=false){
 const peak=charge?.055:.035,settle=charge?.70:.48;
 if(age<peak)return smooth(age/peak);
 return Math.pow(Math.max(0,1-(age-peak)/(settle-peak)),1.8);
}
export function worldRotate(bone,axis,angle){if(!bone||Math.abs(angle)<1e-8)return;const q=new Quaternion().setFromAxisAngle(axis,angle).multiply(bone.getWorldQuaternion(new Quaternion()));bone.quaternion.copy(bone.parent.getWorldQuaternion(new Quaternion()).invert().multiply(q));bone.updateWorldMatrix(false,true);}
export function worldShift(bone,delta){if(!bone)return;const p=bone.getWorldPosition(new Vector3()).add(delta);bone.position.copy(bone.parent.worldToLocal(p));bone.updateWorldMatrix(false,true);}
export function legTo(leg,target,footOrientation){
 const {hip,knee,foot}=leg;if(!hip||!knee||!foot)return;
 const h=hip.getWorldPosition(new Vector3()),k=knee.getWorldPosition(new Vector3()),f=foot.getWorldPosition(new Vector3());
 const l1=h.distanceTo(k),l2=k.distanceTo(f),d=target.clone().sub(h),distance=Math.max(.0001,Math.min(d.length(),l1+l2-.0003)),axis=d.normalize();
 target=h.clone().addScaledVector(axis,distance);const along=(l1*l1-l2*l2+distance*distance)/(2*distance),bend=Math.sqrt(Math.max(0,l1*l1-along*along));
 const pole=k.clone().sub(h);pole.addScaledVector(axis,-pole.dot(axis));if(pole.lengthSq()<1e-10)return;
 const joint=h.clone().addScaledVector(axis,along).addScaledVector(pole.normalize(),bend);
 const rotate=(bone,from,to)=>{const q=new Quaternion().setFromUnitVectors(from.normalize(),to.normalize()).multiply(bone.getWorldQuaternion(new Quaternion()));bone.quaternion.copy(bone.parent.getWorldQuaternion(new Quaternion()).invert().multiply(q));bone.updateWorldMatrix(false,true);};
 rotate(hip,k.clone().sub(h),joint.sub(h));const now=knee.getWorldPosition(new Vector3());rotate(knee,foot.getWorldPosition(new Vector3()).sub(now),target.sub(now));
 foot.quaternion.copy(foot.parent.getWorldQuaternion(new Quaternion()).invert().multiply(footOrientation));foot.updateWorldMatrix(false,true);
}
export class ImpactPerformance{
 constructor(){this.actors=new Map();this.time=0;this.events=[];}
 register(u){const find=n=>u.model.getObjectByName(n);const state={age:0,attack:null,reaction:null,hold:0,saved:[],bones:{hips:find('Hips'),spine:find('Spine'),chest:find('Chest'),head:find('Head'),shield:find('UpperArmL'),forearm:find('ForearmL')},legs:['L','R'].map(side=>({side,hip:find('Thigh'+side),knee:find('Shin'+side),foot:find('Foot'+side)}))};this.actors.set(u,state);}
 restore(u){const s=this.actors.get(u);if(!s)return;for(const [bone,p,q]of s.saved){bone.position.copy(p);bone.quaternion.copy(q);}s.saved=[];}
 event(e){
 const s=this.actors.get(e.from),target=this.actors.get(e.target);
 if(e.type==='death'){const dead=this.actors.get(e.unit);if(dead){dead.attack=null;dead.reaction=null;dead.hold=0;this.restore(e.unit);}return;}
 if(e.type==='attack'&&s&&e.from.hp>0)s.attack={age:0,hold:0};
 if(e.type==='cancel-attack'&&s)s.attack=null;
 if(!['hit','charge'].includes(e.type)||!target||e.target.hp<=0)return;
 const dx=e.nx??e.target.x-e.from.x,dz=e.nz??e.target.z-e.from.z;
 const direction=new Vector3(dx,0,dz);if(direction.lengthSq()<1e-8)direction.set(Math.sin(e.from.heading),0,Math.cos(e.from.heading));direction.normalize();
 // Capture world direction at impact. No subsequent target tracking.
 const charge=e.type==='charge';if(!target.reaction||target.reaction.age>.12)target.reaction={age:0,direction,charge,offset:charge?new Vector3(e.target.root.position.x-e.target.x,0,e.target.root.position.z-e.target.z):new Vector3()};
 else if(charge)target.reaction.charge=true;
 target.attack=null;target.hold=charge?.045:.032;
 if(s?.attack)s.attack.hold=.038;
 this.events.push({time:this.time,type:e.type,from:e.from.id,target:e.target.id,direction:direction.toArray()});if(this.events.length>48)this.events.shift();
 }
 tick(dt){this.time+=dt;for(const s of this.actors.values()){s.age+=dt;if(s.attack){s.attack.age+=dt;if(s.attack.age>.90)s.attack=null;}if(s.reaction){s.reaction.age+=dt;if(s.reaction.age>.72)s.reaction=null;}}}
 place(u){
  const r=this.actors.get(u)?.reaction;if(!r?.charge||u.hp<=0)return;
  // Core knockback resolves immediately. Render its actual displacement over
  // 180ms so the body begins at contact instead of teleporting before recoil.
  u.root.position.addScaledVector(r.offset,1-smooth(r.age/.18));
 }
 prepare(u,dt){
 const s=this.actors.get(u);if(!s)return {dt};this.restore(u);
 if(u.hp<=0){s.attack=null;s.reaction=null;s.hold=0;return {dt};}
 let poseDt=dt;if(s.hold>0){const used=Math.min(dt,s.hold);poseDt-=used;s.hold-=used;}
 let attackTime;
 if(s.attack){if(s.attack.hold>0){s.attack.hold=Math.max(0,s.attack.hold-dt);attackTime=11/24;}else attackTime=attackPoseTime(s.attack.age);}
 return {dt:poseDt,attackTime};
 }
 apply(u){
 const s=this.actors.get(u);if(!s||u.hp<=0)return;
 const {bones:b,legs}=s;const saved=new Set();const save=bone=>{if(bone&&!saved.has(bone)){s.saved.push([bone,bone.position.clone(),bone.quaternion.clone()]);saved.add(bone);}};
 for(const bone of Object.values(b))save(bone);for(const leg of legs)for(const bone of [leg.hip,leg.knee,leg.foot])save(bone);
 u.root.updateMatrixWorld(true);const scale=u.presentationScale??.3,forward=new Vector3(Math.sin(u.heading),0,Math.cos(u.heading)),axis=new Vector3().crossVectors(UP,forward);
 const anchors=legs.map(leg=>leg.foot?.getWorldPosition(new Vector3())),orientations=legs.map(leg=>leg.foot?.getWorldQuaternion(new Quaternion()));
 if(s.reaction){
  const r=s.reaction,force=reactionEnvelope(r.age,r.charge),awayAxis=new Vector3().crossVectors(UP,r.direction).normalize();
  const lean=(r.charge?.70:.38)*(r.strength??1)*force;
  worldRotate(b.hips,awayAxis,lean*.28);worldRotate(b.spine,awayAxis,lean*.48);worldRotate(b.chest,awayAxis,lean*.40);worldRotate(b.head,awayAxis,-lean*.12);
  worldRotate(b.shield,awayAxis,-lean*.42);worldRotate(b.forearm,UP,.14*force);
  worldShift(b.hips,new Vector3(0,-(r.charge?.15:.065)*scale*force,0));
  if(u.kind==='infantry')for(let i=0;i<legs.length;i++){const target=anchors[i];if(!target)continue;if(r.charge&&i===1){target.addScaledVector(r.direction,.28*scale*force);target.y+=.10*scale*Math.sin(Math.PI*clamp(r.age/.30));}legTo(legs[i],target,orientations[i]);}
 }else if(s.attack&&u.animation.state==='attack'&&u.kind==='infantry'){
  const age=s.attack.age,load=smooth(age/.25)*(1-smooth((age-.39)/.07));
  const thrust=smooth((age-.39)/.068)*(1-smooth((age-.52)/.355));
  worldShift(b.hips,new Vector3(0,-(.11*load+.045*thrust)*scale,0).addScaledVector(forward,.10*scale*thrust));
  worldRotate(b.spine,axis,-.12*load+.24*thrust);worldRotate(b.chest,UP,-.22*load+.30*thrust);worldRotate(b.head,UP,.08*load-.10*thrust);
  worldRotate(b.shield,axis,-.10*load+.10*thrust);
  const step=smooth((age-.15)/.20)*(1-smooth((age-.60)/.275));
  for(let i=0;i<legs.length;i++){const target=anchors[i];if(!target)continue;if(i===1){target.addScaledVector(forward,.24*scale*step);target.y+=.07*scale*Math.sin(Math.PI*clamp((age-.15)/.20))*(age<.35?1:0);}legTo(legs[i],target,orientations[i]);}
 }else if(u.kind==='cavalry'&&u.moving){
  const speed=clamp(u.speed/scale/4.8);worldRotate(b.chest,axis,.22*speed);worldRotate(b.spine,axis,.08*speed);worldRotate(b.head,axis,-.13*speed);
 }
 }
 inspect(){return{time:this.time,events:this.events.map(e=>({...e})),actors:[...this.actors].map(([u,s])=>({id:u.id,attackAge:s.attack?.age,reactionAge:s.reaction?.age,hold:s.hold}))};}
 clear(){for(const u of this.actors.keys())this.restore(u);this.actors.clear();this.events=[];this.time=0;}
}

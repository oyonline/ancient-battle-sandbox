import { meleeReach } from './combat-model.js';

const foot=u=>u.kind==='infantry'||u.kind==='pikeman';
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const inside=p=>Math.abs(p.x)<=16.8&&Math.abs(p.z)<=12.8;
const arcRadius=(u,b)=>u.radius+b.radius+.31;
const local=(u,b)=>distance(u,b)<=arcRadius(u,b)+.8;

// This checks the same body clearance as the existing movement sweep. It
// produces a goal only; the real sweep, separation and bounds still move units.
function obstructs(a,end,b){
 const dx=end.x-a.x,dz=end.z-a.z,len2=dx*dx+dz*dz;
 if(len2<1e-10)return false;
 const t=((b.x-a.x)*dx+(b.z-a.z)*dz)/len2;
 if(t<=0||t>=1)return false;
 return Math.hypot(a.x+dx*t-b.x,a.z+dz*t-b.z)<a.radius+b.radius+.055;
}

export class LateCrowd {
 constructor(){this.time=0;this.routes=new Map();this.cooldowns=new Map();this.events=[];this.units=[];}
 note(type,u,route,reason){
  this.events.push({time:this.time,type,id:u.id,blocker:route.blocker,side:route.side,reason});
  if(this.events.length>256)this.events.shift();
 }
 finish(u,route,reason,cooldown=false){
  this.routes.delete(u.id);this.note('exit',u,route,reason);
  if(cooldown)this.cooldowns.set(`${u.id}:${route.blocker}`,this.time+1);
 }
 eligible(u,enemy){
  if(!this.fighting||!enemy||u.hp<=0||enemy.hp<=0||u.kind==='archer'||u.target||u.pendingStrike||u.pendingShot||u.hitFlash>0||u.pierceTime>0)return false;
  if(distance(u,enemy)<=meleeReach(u,enemy)+.25)return false;
  const opponents=this.units.filter(v=>v.hp>0&&v.team!==u.team);
  const allies=this.units.filter(v=>v.hp>0&&v.team===u.team);
  return opponents.length>0&&opponents.length<=2&&opponents.filter(foot).length<=1&&allies.length>=Math.max(3,opponents.length*2+1);
 }
 update(units,dt,fighting){
  this.time+=dt;this.units=units;this.fighting=fighting;
  for(const [key,until]of this.cooldowns)if(until<=this.time)this.cooldowns.delete(key);
  for(const [id,route]of this.routes){
   const u=units.find(v=>v.id===id);
   if(!u){this.routes.delete(id);continue;}
   const enemy=units.filter(v=>v.hp>0&&v.team!==u.team).sort((a,b)=>distance(u,a)-a.radius-(distance(u,b)-b.radius))[0];
   if(!this.eligible(u,enemy)){this.finish(u,route,'priority-or-phase');continue;}
   // The native seam is not called at legal contact. Recheck its real nearest
   // enemy here as well, so an unused old route cannot survive that priority.
   if(enemy.id!==route.enemy){this.finish(u,route,'target-changed',true);continue;}
   if(this.time-route.progressTime>=.75){
    const blocker=units.find(v=>v.id===route.blocker&&v.hp>0);
    const moved=distance(u,route.progressPoint)>=.08;
    const approaching=route.enemyDistance-distance(u,enemy)>=.08;
    const clearing=blocker&&distance(u,blocker)-route.blockerDistance>=.08;
    // One short entry window permits the initial radial step/turn. Later
    // motion must approach the enemy or improve the current body's clearance.
    if(!moved||!route.entryWindow&&!approaching&&!clearing){this.finish(u,route,'no-progress',true);continue;}
    route.entryWindow=false;route.enemyDistance=distance(u,enemy);route.blockerDistance=blocker?distance(u,blocker):0;
    route.progressPoint={x:u.x,z:u.z};route.progressTime=this.time;
   }
  }
 }
 waypoint(u,b,side){
  const radius=arcRadius(u,b);
  const angle=Math.atan2(u.z-b.z,u.x-b.x)+side*.22;
  return {x:b.x+Math.cos(angle)*radius,z:b.z+Math.sin(angle)*radius,stop:.04,hold:false};
 }
 chooseSide(u,b,allies){
  let best=null;
  for(const side of [-1,1]){
   const point=this.waypoint(u,b,side);
   if(!inside(point)||allies.some(v=>v!==u&&obstructs(u,point,v)))continue;
   const angle=Math.atan2(u.z-b.z,u.x-b.x),radius=arcRadius(u,b);
   let space=Infinity;
   for(const advance of [.22,.66,1.1]){
    const p={x:b.x+Math.cos(angle+side*advance)*radius,z:b.z+Math.sin(angle+side*advance)*radius};
    space=Math.min(space,16.8-Math.abs(p.x),12.8-Math.abs(p.z));
    for(const other of allies)if(other!==u&&other!==b)space=Math.min(space,distance(p,other)-u.radius-other.radius-.06);
   }
   if(!best||space>best.space)best={side,space};
  }
  return best?.side??null;
 }
 intent(u,enemy){
  let route=this.routes.get(u.id);
  if(!this.eligible(u,enemy)){if(route)this.finish(u,route,'priority-or-phase');return null;}
  const allies=this.units.filter(v=>v.hp>0&&v.team===u.team);
  const blockers=allies.filter(v=>v!==u&&obstructs(u,enemy,v)).sort((a,b)=>distance(u,a)-distance(u,b)||a.id-b.id);
  if(!blockers.length){if(route)this.finish(u,route,'clear-approach');return null;}
  if(route){
   const b=allies.find(v=>v.id===route.blocker);
   if(!b){this.finish(u,route,'blocker-gone');route=null;}
   else if(route.enemy!==enemy.id||!local(u,b)){
    this.finish(u,route,route.enemy!==enemy.id?'target-changed':'blocker-nonlocal',true);route=null;
   }else if(!blockers.includes(b)){
    // Edge crossings may fluctuate for a few frames. Suspend our goal during
    // that bounded grace instead of steering around a no-longer-blocking body.
    route.invalidSince??=this.time;
    if(this.time-route.invalidSince<.12)return null;
    this.finish(u,route,'blocker-cleared',true);route=null;
   }
   else{
    route.invalidSince=null;
    const angle=Math.atan2(u.z-b.z,u.x-b.x);route.travel+=Math.abs(wrap(angle-route.angle));route.angle=angle;
    if(route.travel>=Math.PI){this.finish(u,route,'arc-limit',true);return null;}
    let point=this.waypoint(u,b,route.side);
    if(!inside(point)||allies.some(v=>v!==u&&obstructs(u,point,v))){
     if(route.reconsidered){this.finish(u,route,'no-space',true);return null;}
     route.reconsidered=true;const side=this.chooseSide(u,b,allies);
     if(side===null){this.finish(u,route,'no-space',true);return null;}
     route.side=side;this.note('reconsider',u,route,'space');point=this.waypoint(u,b,side);
    }
    return point;
   }
  }
  const b=blockers.find(v=>local(u,v)&&(this.cooldowns.get(`${u.id}:${v.id}`)??0)<=this.time);
  if(!b)return null;
  const side=this.chooseSide(u,b,allies);
  if(side===null){this.cooldowns.set(`${u.id}:${b.id}`,this.time+1);return null;}
  route={blocker:b.id,enemy:enemy.id,side,angle:Math.atan2(u.z-b.z,u.x-b.x),travel:0,reconsidered:false,invalidSince:null,progressTime:this.time,progressPoint:{x:u.x,z:u.z},enemyDistance:distance(u,enemy),blockerDistance:distance(u,b),entryWindow:true};
  this.routes.set(u.id,route);this.note('enter',u,route,'ally-blocked');return this.waypoint(u,b,side);
 }
 inspect(){return {time:this.time,routes:[...this.routes].map(([id,r])=>({id,...r})),events:this.events.map(e=>({...e})),cooldowns:[...this.cooldowns]};}
}

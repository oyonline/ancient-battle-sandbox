// Isolated two-sword rules. Animation and combat share these exact timings.
export const DUEL_HP=140;
export function duelOutcome(units){const red=units.some(u=>u.team==='red'&&u.hp>0),blue=units.some(u=>u.team==='blue'&&u.hp>0);return red&&blue?null:red?'红':blue?'蓝':'平局';}
export const STRIKES=Object.freeze({
 slash:Object.freeze({label:'横斩',min:12,max:19,contact:.48,duration:1.05,weight:4,blockChance:.32,blockedFraction:.20}),
 cleave:Object.freeze({label:'劈砍',min:20,max:31,contact:.72,duration:1.38,weight:3,blockChance:.22,blockedFraction:.45}),
 thrust:Object.freeze({label:'刺击',min:8,max:14,contact:.30,duration:.78,weight:3,blockChance:.32,blockedFraction:.20}),
});
export const blockedDamage=(damage,strike)=>Math.max(1,Math.round(damage*STRIKES[strike].blockedFraction));
export function canBlock(defender,attacker){const d=defender.duel;if(defender.hp<=0||!d||d.phase!=='guard'||d.stun>0)return false;const dx=attacker.x-defender.x,dz=attacker.z-defender.z,length=Math.hypot(dx,dz);return length>1e-8&&(Math.sin(defender.heading)*dx+Math.cos(defender.heading)*dz)/length>=.65;}
export class SwordDuel{
 constructor(seed=728){this.seed=seed>>>0;this.reset([]);}
 random(){this.randomState=(this.randomState+0x6D2B79F5)>>>0;let t=this.randomState;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);this.draws++;return((t^(t>>>14))>>>0)/4294967296;}
 reset(units){this.randomState=this.seed;this.draws=0;this.time=0;this.accumulator=0;this.sequence=0;this.history=[];this.units=units;for(const u of units){u.hp=DUEL_HP;u.pendingStrike=null;u.attackCooldown=0;u.hitFlash=0;u.deathTime=null;u.duel={phase:'guard',action:null,decision:.12+this.random()*.52,stun:0,interruptProtection:0,last:null,repeats:0};}}
 choose(u){let entries=Object.entries(STRIKES).filter(([key])=>!(u.duel.repeats>=2&&u.duel.last===key));let pick=this.random()*entries.reduce((n,[,s])=>n+s.weight,0);let key=entries.at(-1)[0];for(const [k,s]of entries){pick-=s.weight;if(pick<0){key=k;break;}}u.duel.repeats=u.duel.last===key?u.duel.repeats+1:1;u.duel.last=key;return key;}
 emit(events,event){event.time=this.time;event.sequence=++this.sequence;events.push(event);this.history.push({time:this.time,type:event.type,from:event.from?.id,target:event.target?.id,unit:event.unit?.id,strike:event.strike,damage:event.damage,rawDamage:event.rawDamage});if(this.history.length>80)this.history.shift();}
 step(dt,fighting=true){if(dt<=0)return[];if(!fighting){if(this.units.filter(u=>u.hp>0).length<2)this.recoverSurvivors(dt);return[];}this.accumulator+=Math.min(dt,.05);const events=[];while(this.accumulator>=1/120-1e-10){this.accumulator-=1/120;this.advance(1/120,events);}return events;}
 recoverSurvivors(dt){for(const u of this.units){if(u.hp<=0)continue;u.moving=false;u.speed=0;const d=u.duel;if(d.action){d.action.age+=dt;if(d.action.age>=STRIKES[d.action.strike].duration){d.action=null;d.phase='guard';}}}}
 advance(dt,events){
  this.time+=dt;const alive=this.units.filter(u=>u.hp>0);if(alive.length<2){this.recoverSurvivors(dt);return;}
  for(const u of alive){const d=u.duel,e=alive.find(v=>v!==u);u.moving=false;u.attacking=false;u.hitFlash=Math.max(0,u.hitFlash-dt);d.stun=Math.max(0,d.stun-dt);d.interruptProtection=Math.max(0,d.interruptProtection-dt);const dx=e.x-u.x,dz=e.z-u.z,range=u.radius+e.radius+.045,distance=Math.hypot(dx,dz);const desired=Math.atan2(dx,dz),turn=Math.atan2(Math.sin(desired-u.heading),Math.cos(desired-u.heading));u.heading+=Math.max(-dt*3,Math.min(dt*3,turn));
   if(d.phase==='attack'){d.action.age+=dt;u.attacking=true;if(d.action.age>=STRIKES[d.action.strike].duration){d.phase='guard';d.action=null;d.decision=.22+this.random()*.43;}}
   if(d.phase==='hurt'&&d.stun<=0){d.phase='guard';d.decision=.08+this.random()*.18;}
   if(d.phase==='guard'&&distance>range){u.speed=Math.min(.54,u.speed+dt*1.5);const move=Math.min((distance-range)*.5,u.speed*dt);u.x+=dx/distance*move;u.z+=dz/distance*move;u.moving=move>.00001;}else u.speed=Math.max(0,u.speed-dt*2.4);
   if(d.phase==='guard'&&distance<=range+.012){d.decision-=dt;if(d.decision<=0){const strike=this.choose(u);d.phase='attack';d.action={strike,age:0,resolved:false,targetId:e.id};this.emit(events,{type:'attack',from:u,target:e,strike});}}
  }
  // Capture simultaneous contacts before applying damage; neither array order
  // nor a same-tick hit may silently erase an already committed opposing strike.
  const contacts=alive.filter(u=>u.duel.action&&!u.duel.action.resolved&&u.duel.action.age>=STRIKES[u.duel.action.strike].contact-1e-9).map(u=>({from:u,target:alive.find(v=>v.id===u.duel.action.targetId),strike:u.duel.action.strike}));
  const results=[];for(const {from,target,strike}of contacts){from.duel.action.resolved=true;const dx=target?.x-from.x,dz=target?.z-from.z,distance=Math.hypot(dx,dz);if(!target||target.hp<=0||distance>from.radius+target.radius+.075||(Math.sin(from.heading)*dx+Math.cos(from.heading)*dz)/distance<.75){this.emit(events,{type:'cancel-attack',from,target,strike});continue;}const spec=STRIKES[strike],rawDamage=spec.min+Math.floor(this.random()*(spec.max-spec.min+1));const blocked=canBlock(target,from)&&this.random()<spec.blockChance;results.push({type:blocked?'block':'hit',from,target,strike,rawDamage,damage:blocked?blockedDamage(rawDamage,strike):rawDamage,x:target.x,z:target.z,nx:dx/distance,nz:dz/distance});}
  for(const e of results){e.target.hp-=e.damage;this.emit(events,e);const d=e.target.duel;if(e.type==='block'){d.decision=Math.max(d.decision,.16);continue;}e.target.hitFlash=.24;const action=d.action;const committed=action&&action.age>=STRIKES[action.strike].contact-.10;const interrupt=d.interruptProtection<=0&&!committed;if(interrupt){if(action&&!action.resolved)this.emit(events,{type:'cancel-attack',from:e.target,strike:action.strike});d.action=null;d.phase='hurt';d.stun=e.damage>=20?.25:.16;d.interruptProtection=.85;}e.interrupt=interrupt;}
  for(const u of alive)if(u.hp<=0){u.duel.phase='dead';u.duel.action=null;u.duel.stun=0;u.pendingStrike=null;u.deathTime=0;this.emit(events,{type:'death',unit:u,x:u.x,z:u.z});}
 }
 inspect(){return{seed:this.seed,time:this.time,draws:this.draws,history:this.history.map(e=>({...e}))};}
}

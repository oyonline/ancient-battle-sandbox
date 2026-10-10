// Rules for the bounded 3D skirmish. Positions and contact stay on the ground plane.
export const BODY_RADIUS = { infantry: 1.0, pikeman: .95, archer: 1.1, cavalry: 2.0 };
export const CHARGE = { runup: 3.2, speed: 3.4, alignment: .94, cooldown: 5.5, damage: 36, knockback: 1.6 };
export const ARCHER={range:8,windup:11/24,cooldown:1.8,speed:12,damage:14,maxDistance:11};
export function meleeReach(a,b){return a.radius+b.radius+(a.kind==='pikeman'?.9:.22);}
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export function createFighter(id,team,kind,x,z){return {id,team,kind,x,z,radius:BODY_RADIUS[kind],hp:100,heading:team==='red'?Math.PI/2:-Math.PI/2,speed:0,runup:0,chargeCooldown:0,pierceTime:0,momentum:0,pierceHits:new Set(),attackCooldown:id%5*.09,target:null,moving:false,attacking:false,chargeFlash:0,hitFlash:0,deathTime:null,pendingShot:null,pendingStrike:null,projectiles:[],shotSequence:0};}
export function separateBodies(units,iterations=10){
 const alive=units.filter(u=>u.hp>0);
 for(let pass=0;pass<iterations;pass++)for(let i=0;i<alive.length;i++)for(let j=i+1;j<alive.length;j++){
  const a=alive[i],b=alive[j],dx=b.x-a.x,dz=b.z-a.z,d=Math.hypot(dx,dz),contact=a.radius+b.radius+.06;
  if(d>=contact)continue;
  const angle=((a.id*17+b.id*31)%360)*Math.PI/180;
  const nx=d>1e-8?dx/d:Math.cos(angle),nz=d>1e-8?dz/d:Math.sin(angle),push=(contact-d)*.51;
  a.x=clamp(a.x-nx*push,-17,17);a.z=clamp(a.z-nz*push,-13,13);b.x=clamp(b.x+nx*push,-17,17);b.z=clamp(b.z+nz*push,-13,13);
 }
}
export function chargeReady(u,enemy){const dx=enemy.x-u.x,dz=enemy.z-u.z,d=Math.hypot(dx,dz);return u.kind==='cavalry'&&u.chargeCooldown<=0&&u.runup>=CHARGE.runup&&u.speed>=CHARGE.speed&&d>1e-8&&(Math.sin(u.heading)*dx+Math.cos(u.heading)*dz)/d>=CHARGE.alignment;}
function launchArrow(u,target,events){
 const dx=target.x-u.x,dz=target.z-u.z,d=Math.hypot(dx,dz);if(d>ARCHER.range+.5||d<1e-8||(Math.sin(u.heading)*dx+Math.cos(u.heading)*dz)/d<.985){events.push({type:'cancel-shot',from:u});return;}
 const nx=dx/d,nz=dz/d,shot={id:`${u.id}:${u.shotSequence++}`,x:u.x+nx*(u.radius+.15),z:u.z+nz*(u.radius+.15),startX:u.x,startZ:u.z,endX:target.x,endZ:target.z,vx:nx*ARCHER.speed,vz:nz*ARCHER.speed,age:0,duration:d/ARCHER.speed,life:ARCHER.maxDistance/ARCHER.speed};
 u.projectiles.push(shot);events.push({type:'shoot',from:u,shot});
}
function advanceArrows(units,dt,events){
 for(const owner of units){
  for(const shot of owner.projectiles){
   const mx=shot.vx*dt,mz=shot.vz*dt,len2=mx*mx+mz*mz;let hit=null,fraction=1;
   for(const target of units){if(target.hp<=0||target.team===owner.team)continue;const dx=shot.x-target.x,dz=shot.z-target.z,r=target.radius+.08,c=dx*dx+dz*dz-r*r,dot=dx*mx+dz*mz;
    if(c<=0){hit=target;fraction=0;break;}if(len2<1e-10||dot>=0)continue;const discriminant=dot*dot-len2*c;if(discriminant<0)continue;const t=(-dot-Math.sqrt(discriminant))/len2;if(t>=0&&t<=fraction){fraction=t;hit=target;}
   }
   shot.x+=mx*fraction;shot.z+=mz*fraction;shot.age+=dt;shot.life-=dt;
   if(hit){hit.hp-=ARCHER.damage;hit.hitFlash=.45;hit.pendingShot=null;hit.pendingStrike=null;shot.life=0;events.push({type:'arrow-hit',from:owner,target:hit,x:shot.x,z:shot.z});}
  }
  owner.projectiles=owner.projectiles.filter(shot=>shot.life>0);
 }
}
export function stepSkirmish(units,dt,fighting){
 dt=clamp(dt,0,.05);const events=[];advanceArrows(units,dt,events);const alive=units.filter(u=>u.hp>0),plans=[];
 for(const u of alive){
  u.attackCooldown=Math.max(0,u.attackCooldown-dt);u.chargeCooldown=Math.max(0,u.chargeCooldown-dt);u.chargeFlash=Math.max(0,u.chargeFlash-dt);u.hitFlash=Math.max(0,u.hitFlash-dt);u.moving=false;u.attacking=false;if(u.pendingStrike)u.pendingStrike.time-=dt;u.pierceTime=Math.max(0,u.pierceTime-dt);if(u.pierceTime===0)u.momentum=0;
  if(u.pendingShot){if(u.target){u.pendingShot=null;events.push({type:'cancel-shot',from:u});}else{u.pendingShot.time-=dt;if(u.pendingShot.time<=1e-8){const aimed=units.find(other=>other.id===u.pendingShot.targetId&&other.hp>0);if(aimed)launchArrow(u,aimed,events);else events.push({type:'cancel-shot',from:u});u.pendingShot=null;}}}
  let enemy=null,target=u.target;
  if(u.pierceTime>0)target={x:u.x+Math.sin(u.heading)*4,z:u.z+Math.cos(u.heading)*4};
  else if(fighting&&!target){let best=Infinity;for(const other of alive){if(other.team===u.team)continue;const d=Math.hypot(other.x-u.x,other.z-u.z)-other.radius;if(d<best){best=d;enemy=other;}}target=enemy;}
  const plan={u,enemy,mx:0,mz:0,oldX:u.x,oldZ:u.z};
  if(target){const dx=target.x-u.x,dz=target.z-u.z,d=Math.hypot(dx,dz),stop=enemy?(u.kind==='archer'?7.2:meleeReach(u,enemy)-.08):.1;
   const desired=Math.atan2(dx,dz),turn=Math.atan2(Math.sin(desired-u.heading),Math.cos(desired-u.heading));
   if(Math.abs(turn)>.55)u.runup=0;
   u.heading+=clamp(turn,-dt*5,dt*5);
   const aligned=d>1e-8&&(Math.sin(u.heading)*dx+Math.cos(u.heading)*dz)/d>=.985;
   if(u.kind==='archer'&&enemy&&d<=ARCHER.range&&aligned&&u.hitFlash<=0&&u.attackCooldown<=1e-8&&!u.pendingShot){u.pendingShot={time:ARCHER.windup,targetId:enemy.id};u.attackCooldown=ARCHER.cooldown;events.push({type:'draw',from:u,target:enemy});}
   if(u.kind==='archer'&&enemy&&d<3&&!u.pendingShot){const advance=Math.min(3-d,dt*1.7);plan.mx=-dx/Math.max(d,1e-6)*advance;plan.mz=-dz/Math.max(d,1e-6)*advance;}
   else if(d>stop&&!u.pendingShot){const top=u.kind==='cavalry'?(u.pierceTime>0?3.8*(.5+u.momentum*.5):u.chargeCooldown>0?2.8:4.8):(u.kind==='pikeman'?1.65:1.8);u.speed=Math.min(top,u.speed+dt*(u.kind==='cavalry'?3.8:6));const advance=Math.min(d-stop,u.speed*dt);plan.mx=dx/d*advance;plan.mz=dz/d*advance;}
   else if(enemy)u.attacking=true;else u.target=null;
  }
  if(u.pendingStrike&&u.target){u.pendingStrike=null;events.push({type:'cancel-attack',from:u});}
  plans.push(plan);
 }
 // Limit a planned segment against actual bodies, so high speed cannot tunnel through a front rank.
 for(const p of plans){const u=p.u,len=Math.hypot(p.mx,p.mz);if(len<1e-8)continue;let fraction=1;
  for(const b of alive){if(b===u)continue;const dx=u.x-b.x,dz=u.z-b.z,r=u.radius+b.radius+.055,c=dx*dx+dz*dz-r*r,dot=dx*p.mx+dz*p.mz;
   if(dot>=0)continue;if(c<=0){fraction=0;p.blocker=b;continue;}const disc=dot*dot-len*len*c;if(disc<0)continue;const t=(-dot-Math.sqrt(disc))/(len*len);if(t>=0&&t<fraction){fraction=Math.max(0,t-.001);p.blocker=b;}
  }
  p.mx*=fraction;p.mz*=fraction;
 }
 for(const p of plans){const u=p.u;const nextX=u.x+p.mx,nextZ=u.z+p.mz;u.x=clamp(nextX,-17,17);u.z=clamp(nextZ,-13,13);p.mx=u.x-p.oldX;p.mz=u.z-p.oldZ;if(u.x!==nextX||u.z!==nextZ){u.pierceTime=0;u.momentum=0;u.runup=0;u.speed=0;}const actual=Math.hypot(p.mx,p.mz);u.moving=actual>.001;const forward=p.mx*Math.sin(u.heading)+p.mz*Math.cos(u.heading);if(u.moving&&forward>actual*.94&&u.speed>=CHARGE.speed)u.runup+=forward;}
 // Resolve contact while speed/run-up still describe the approach, then brake for ordinary melee.
 for(const p of plans){const u=p.u,e=p.blocker&&p.blocker.team!==u.team?p.blocker:p.enemy;if(!e||u.hp<=0||e.hp<=0||u.kind==='archer')continue;const d=Math.hypot(e.x-u.x,e.z-u.z),reach=meleeReach(u,e);if(d>reach)continue;
  u.attacking=true;
  const approach=(Math.sin(u.heading)*(e.x-u.x)+Math.cos(u.heading)*(e.z-u.z))/Math.max(d,1e-6);
  const continuation=u.pierceTime>0&&u.speed>=1.5&&approach>=.9&&(u.moving||p.blocker===e)&&!u.pierceHits.has(e.id)&&u.pierceHits.size<4&&u.momentum>.1;
  if(chargeReady(u,e)||continuation){const nx=(e.x-u.x)/Math.max(d,1e-6),nz=(e.z-u.z)/Math.max(d,1e-6);const first=!continuation;if(first){u.momentum=1;u.pierceTime=.9;u.pierceHits.clear();}u.pierceHits.add(e.id);e.hp-=first?CHARGE.damage:10*u.momentum;e.pendingShot=null;e.pendingStrike=null;e.x=clamp(e.x+nx*CHARGE.knockback*(first?1:.35),-17,17);e.z=clamp(e.z+nz*CHARGE.knockback*(first?1:.35),-13,13);u.chargeCooldown=CHARGE.cooldown;u.attackCooldown=1;u.chargeFlash=.7;u.runup=0;u.momentum=Math.max(0,u.momentum-(e.kind==='cavalry'?.4:.26));if(u.pierceHits.size>=4||u.momentum<=.1)u.pierceTime=0;e.hitFlash=.45;events.push({type:'charge',from:u,target:e,x:e.x,z:e.z,nx,nz,first});}
  else if(u.pierceTime===0&&u.attackCooldown<=0&&!u.pendingStrike&&u.hitFlash<=0&&approach>=.9){u.pendingStrike={time:11/24,targetId:e.id};u.attackCooldown=u.kind==='cavalry'?1.15:u.kind==='pikeman'?1.3:1;events.push({type:'attack',from:u,target:e});}
 }
 for(const u of units){if(!u.pendingStrike||u.pendingStrike.time>1e-8)continue;const aimed=units.find(e=>e.id===u.pendingStrike.targetId&&e.hp>0);u.pendingStrike=null;
  if(u.hp<=0||u.target||u.hitFlash>0||!aimed||Math.hypot(aimed.x-u.x,aimed.z-u.z)>meleeReach(u,aimed)||(Math.sin(u.heading)*(aimed.x-u.x)+Math.cos(u.heading)*(aimed.z-u.z))/Math.max(.001,Math.hypot(aimed.x-u.x,aimed.z-u.z))<.9){events.push({type:'cancel-attack',from:u});continue;}
  aimed.hp-=u.kind==='cavalry'?14:u.kind==='pikeman'?16:12;aimed.pendingShot=null;aimed.pendingStrike=null;aimed.hitFlash=.45;u.attackFlash=.24;events.push({type:'hit',from:u,target:aimed,x:aimed.x,z:aimed.z});
 }
 separateBodies(units);
 for(const p of plans){const u=p.u;if(!u.moving){u.runup=0;u.speed=Math.max(0,u.speed-dt*10);}}
 for(const u of units)if(u.hp<=0&&u.deathTime===null){u.pendingShot=null;u.pendingStrike=null;u.deathTime=0;events.push({type:'death',unit:u,x:u.x,z:u.z});}
 return events;
}

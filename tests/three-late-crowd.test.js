import test from 'node:test';
import assert from 'node:assert/strict';
import { createFighter, stepSkirmish, separateBodies } from '../js/three-demo/combat-model.js';
import { BattleLine } from '../js/three-demo/battle-line.js';
import { LateCrowd } from '../js/three-demo/late-crowd.js';

function tail(z=0){
 const u=createFighter(0,'red','cavalry',-4.06,z),b=createFighter(1,'red','cavalry',0,z);
 const rear=createFighter(2,'red','pikeman',-10,z-5),enemy=createFighter(3,'blue','archer',8,z);
 u.heading=Math.PI/2;return [u,b,rear,enemy];
}
function step(units,planner,dt=1/60,line=null){
 line?.update(units,dt,true);planner?.update(units,dt,true);
 return stepSkirmish(units,dt,true,planner?(u,e)=>line?.intent(u,e)??planner.intent(u,e):line?(u,e)=>line.intent(u,e):null);
}
const state=units=>JSON.stringify(units,(_,v)=>v instanceof Set?[...v]:v);

test('a tailing horse first moves outward around the real body circle without a teleport',()=>{
 const units=tail(),[u,b,,enemy]=units,planner=new LateCrowd();planner.update(units,1/60,true);
 const before=state(units),goal=planner.intent(u,enemy);assert(goal);assert.equal(state(units),before);
 assert(goal.x<u.x);assert(Math.abs(goal.z-u.z)>.9);
 const old={x:u.x,z:u.z};step(units,planner);assert(Math.hypot(u.x-old.x,u.z-old.z)>0);
 assert(Math.hypot(u.x-old.x,u.z-old.z)<.1);assert(Math.hypot(u.x-b.x,u.z-b.z)>=4.055);
});

test('the upper boundary chooses the available inward side and holds it while the blocker moves slightly',()=>{
 const units=tail(12.7),[u,b,,enemy]=units,planner=new LateCrowd();planner.update(units,.01,true);
 const goal=planner.intent(u,enemy);assert(goal.z<12.7);const side=planner.inspect().routes[0].side;
 b.x+=.025;b.z-=.015;const next=planner.intent(u,enemy);assert(next&&next.z<12.7);assert.equal(planner.inspect().routes[0].side,side);
});

test('an early fight and an archer keep the current W1 movement and exact state/events',()=>{
 const units=[];for(const team of ['red','blue'])for(let i=0;i<6;i++){const u=createFighter(units.length,team,i<4?'infantry':'archer',(team==='red'?-1:1)*(7+Math.floor(i/3)*2.3),(i%3-1)*2.3);u.locomotion=true;u.crowd=true;units.push(u);}separateBodies(units);
 const baseline=structuredClone(units),candidate=structuredClone(units),oldLine=new BattleLine(baseline),newLine=new BattleLine(candidate),planner=new LateCrowd();
 for(let i=0;i<450;i++){assert.equal(JSON.stringify(step(baseline,null,1/60,oldLine)),JSON.stringify(step(candidate,planner,1/60,newLine)));assert.equal(state(baseline),state(candidate));}
 const late=tail(),archer=createFighter(4,'red','archer',-12,0);late.push(archer);planner.update(late,.01,true);assert.equal(planner.intent(archer,late[3]),null);
});

test('manual commands, pending windups, hit, piercing and legal contact immediately return to native movement',()=>{
 for(const field of ['target','pendingStrike','pendingShot','hitFlash','pierceTime','contact']){
  const units=tail(),[u,,,enemy]=units,planner=new LateCrowd();planner.update(units,.01,true);assert(planner.intent(u,enemy));
  if(field==='contact')enemy.x=u.x+3;else u[field]=field==='target'?{x:-8,z:0}:field.startsWith('pending')?{time:.4,targetId:enemy.id}:.5;
  const before=state(units);assert.equal(planner.intent(u,enemy),null);assert.equal(state(units),before);assert.equal(planner.inspect().routes.length,0);
 }
});

test('no progress has a finite exit/cooldown, and reset or death cannot keep an old route',()=>{
 const units=tail(),[u,,,enemy]=units,planner=new LateCrowd();planner.update(units,.01,true);assert(planner.intent(u,enemy));
 for(let i=0;i<16;i++)planner.update(units,.05,true);
 assert.equal(planner.inspect().routes.length,0);assert.equal(planner.intent(u,enemy),null);assert(planner.inspect().events.some(e=>e.reason==='no-progress'));
 planner.update(units,1.01,true);assert(planner.intent(u,enemy));u.hp=0;planner.update(units,.01,true);assert.equal(planner.inspect().routes.length,0);
 assert.deepEqual(new LateCrowd().inspect(),{time:0,routes:[],events:[],cooldowns:[]});
});

test('a route remains until the actual approach segment is clear, then releases native attack',()=>{
 const units=tail(),[u,,,enemy]=units,planner=new LateCrowd();planner.update(units,.01,true);assert(planner.intent(u,enemy));
 // This is a measurement fixture, not a teleport in the movement implementation.
 u.x=-.5;u.z=-4.31;planner.update(units,.01,true);assert(planner.intent(u,enemy),'shoulder is still obstructed toward the enemy');
 u.x=3;u.z=-4.31;planner.update(units,.01,true);assert.equal(planner.intent(u,enemy),null);assert(planner.inspect().events.some(e=>e.reason==='clear-approach'));
});

test('30/60Hz physical endgames remain finite, separated and finish through real combat',()=>{
 for(const dt of [1/30,1/60]){
  const units=tail(),planner=new LateCrowd();let attacks=0,time=0;
  for(;time<40;time+=dt){const events=step(units,planner,dt);attacks+=events.filter(e=>['attack','charge','hit','arrow-hit'].includes(e.type)).length;
   assert(units.every(u=>Number.isFinite(u.x+u.z+u.hp)&&Math.abs(u.x)<=17.00001&&Math.abs(u.z)<=13.00001));
   const alive=units.filter(u=>u.hp>0);for(let i=0;i<alive.length;i++)for(let j=i+1;j<alive.length;j++)assert(Math.hypot(alive[i].x-alive[j].x,alive[i].z-alive[j].z)-alive[i].radius-alive[j].radius>=-.006);
   if(!units.some(u=>u.team==='blue'&&u.hp>0))break;
  }
  assert(time<40);assert(attacks>0);assert(planner.inspect().events.some(e=>e.type==='enter'));
 }
});

test('a former buddy moving off the approach cannot keep a route when another buddy still blocks',()=>{
 const units=tail(),[u,b,,enemy]=units,planner=new LateCrowd();planner.update(units,.01,true);assert(planner.intent(u,enemy));
 const next=createFighter(4,'red','cavalry',1,0);units.push(next);b.z=6;
 planner.update(units,.01,true);const goal=planner.intent(u,enemy);
 assert.equal(planner.inspect().routes.some(r=>r.blocker===b.id),false);
 assert(goal);assert.equal(planner.inspect().routes[0].blocker,next.id);
 assert(Math.abs(Math.hypot(goal.x-next.x,goal.z-next.z)-u.radius-next.radius-.31)<1e-9);
 assert(planner.inspect().events.some(e=>e.reason==='blocker-nonlocal'));
});

test('changing the real target suspends an irrelevant nearby buddy and distant blockers never enlarge an arc',()=>{
 const units=tail(),[u,b,,enemy]=units,planner=new LateCrowd();planner.update(units,.01,true);assert(planner.intent(u,enemy));
 const target=createFighter(4,'blue','archer',-8,-5);units.push(target,createFighter(5,'red','infantry',-14,-8),createFighter(6,'red','infantry',-14,8));
 assert.equal(planner.intent(u,target),null);assert.equal(planner.inspect().routes.length,0);
 b.x=8;enemy.x=16;planner.update(units,.01,true);assert.equal(planner.intent(u,enemy),null);
});

test('the actual 54.7202s stale-body geometry releases old13 instead of a 14m circle',()=>{
 const u=createFighter(6,'red','pikeman',5.442,-6.840),old=createFighter(13,'red','cavalry',7.795,7.424),enemy=createFighter(26,'blue','archer',17,11.048);
 const b7=createFighter(7,'red','pikeman',9,-1.5),b15=createFighter(15,'red','cavalry',12,3.3),units=[u,old,b7,b15,enemy],planner=new LateCrowd();
 planner.update(units,.01,true);
 // Replay an existing route from the former valid local encounter.
 planner.routes.set(u.id,{blocker:old.id,enemy:enemy.id,side:-1,angle:0,travel:0,reconsidered:false,invalidSince:null,progressTime:planner.time,progressPoint:{x:u.x,z:u.z},enemyDistance:21.3,blockerDistance:14.46,entryWindow:false});
 assert.equal(planner.intent(u,enemy),null);assert.equal(planner.inspect().routes.length,0);assert(planner.inspect().events.some(e=>e.reason==='blocker-nonlocal'));
});

test('motion away from the enemy cannot repeatedly reset no-progress after the short entry window',()=>{
 const units=tail(),[u,,,enemy]=units,planner=new LateCrowd();planner.update(units,.01,true);assert(planner.intent(u,enemy));
 u.x-=.1;planner.update(units,.76,true);assert.equal(planner.inspect().routes.length,1);
 // Maintain body distance but move farther from the real foe.
 const r=Math.hypot(u.x,u.z);u.x=-r*.995;u.z=-r*.1;planner.update(units,.76,true);
 assert.equal(planner.inspect().routes.length,0);assert(planner.inspect().events.some(e=>e.reason==='no-progress'));
});

test('a newly nearest enemy at contact clears the route even when the native seam is not invoked',()=>{
 const units=tail(),[u,,,enemy]=units,planner=new LateCrowd();units.push(createFighter(4,'red','infantry',-12,-8),createFighter(5,'red','infantry',-12,8));
 planner.update(units,.01,true);assert(planner.intent(u,enemy));
 units.push(createFighter(6,'blue','archer',-1,0));planner.update(units,.01,true);
 assert.equal(planner.inspect().routes.length,0);assert(planner.inspect().events.some(e=>e.reason==='priority-or-phase'));
});

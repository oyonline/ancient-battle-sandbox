import test from 'node:test';
import assert from 'node:assert/strict';
import { createFighter, separateBodies, stepSkirmish } from '../js/three-demo/combat-model.js';
import { BattleLine } from '../js/three-demo/battle-line.js';

function formation(count=4,offset=.7){
 const units=[],rows=count===4?2:4;
 for(const team of ['red','blue'])for(let i=0;i<count;i++){
  const side=team==='red'?-1:1,u=createFighter(units.length,team,'infantry',side*(4.5+Math.floor(i/rows)*2.2),(i%rows-(rows-1)/2)*2.2+(team==='blue'?offset:0));
  u.locomotion=true;u.crowd=true;units.push(u);
 }
 separateBodies(units);return units;
}
const eventView=events=>events.map(e=>[e.type,e.from?.id,e.target?.id,e.unit?.id]);
const unitView=units=>units.map(u=>({x:u.x,z:u.z,heading:u.heading,hp:u.hp,speed:u.speed,moving:u.moving,pendingStrike:u.pendingStrike,pendingShot:u.pendingShot,projectiles:u.projectiles}));

test('disabled movement-intent seam preserves C1 trajectories, damage and event order exactly',()=>{
 const a=formation(),b=formation();
 for(let i=0;i<1500;i++){
  assert.deepEqual(eventView(stepSkirmish(a,1/60,true)),eventView(stepSkirmish(b,1/60,true,()=>null)));
  assert.deepEqual(unitView(a),unitView(b));
 }
});

test('front identities stay stable; a casualty promotes a reserve without stealing its neighbour',()=>{
 const units=formation(),line=new BattleLine(units),initial=line.inspect().teams[0].columns;
 for(let i=0;i<30;i++)line.update(units,1/60,true);
 assert.deepEqual(line.inspect().teams[0].columns,initial);
 const dead=units.find(u=>u.id===initial[0][0]),next=initial[0][1];dead.hp=0;
 line.update(units,1/60,true);const now=line.inspect();
 assert.equal(now.teams[0].columns[0][0],next);assert.equal(now.teams[0].columns[1][0],initial[1][0]);assert.equal(now.refills.length,1);
 const fresh=new BattleLine(formation());assert.deepEqual(fresh.inspect().teams[0].columns,initial);assert.equal(fresh.refills.length,0);
});

test('manual intent keeps an occupied slot; only physical departure promotes its reserve and completion rejoins the rear',()=>{
 const units=formation(),line=new BattleLine(units),before=line.inspect().teams[0].columns;
 const actor=units.find(u=>u.id===before[0][0]);actor.target={x:actor.x,z:actor.z};
 line.update(units,1/60,true);assert.deepEqual(line.inspect().teams[0].columns,before);assert.equal(line.refills.length,0);
 assert.deepEqual(actor.target,{x:actor.x,z:actor.z});
 actor.target={x:-12,z:actor.z};actor.x-=3;
 line.update(units,1/60,true);assert.equal(line.inspect().teams[0].columns[0][0],before[0][1]);assert.equal(line.refills.length,1);
 assert.deepEqual(actor.target,{x:-12,z:actor.z});assert.equal(line.intent(actor,units[4]),null);
 actor.target=null;line.update(units,1/60,true);assert.deepEqual(line.inspect().teams[0].columns[0],[before[0][1],actor.id]);
 const reset=new BattleLine(formation());assert.deepEqual(reset.inspect().teams[0].columns,before);assert.equal(reset.refills.length,0);
});

test('self-position commands preserve occupied front IDs throughout an uneven mixed fight',()=>{
 const units=[];
 for(const team of ['red','blue']){
  const side=team==='red'?-1:1;
  for(let i=0;i<6;i++)units.push(createFighter(units.length,team,'infantry',side*(8+Math.floor(i/4)*2.1),(i%4-1.5)*2.1));
  for(let i=0;i<4;i++)units.push(createFighter(units.length,team,'pikeman',side*12.2,(i-1.5)*2.1));
  for(let i=0;i<2;i++)units.push(createFighter(units.length,team,'archer',side*15,(i-.5)*3));
  for(let i=0;i<4;i++)units.push(createFighter(units.length,team,'cavalry',side*(10.8+i%2*4.2),6+Math.floor(i/2)*4.2));
 }
 for(const u of units){u.locomotion=u.kind!=='cavalry';u.crowd=u.locomotion;}separateBodies(units);
 const line=new BattleLine(units);let probes=0;
 for(let frame=0;frame<2400;frame++){
  line.update(units,1/60,true);stepSkirmish(units,1/60,true,(u,e)=>line.intent(u,e));
  if(frame%30!==0)continue;
  for(const team of line.teams.values())for(let col=0;col<team.columns.length;col++){
   const id=team.columns[col][0],actor=units.find(u=>u.id===id);if(!actor||actor.hp<=0)continue;
   // Preserve the shared graph between the planner's Map and its real fighters.
   const copy=structuredClone({line,units});Object.setPrototypeOf(copy.line,BattleLine.prototype);
   const selected=copy.units.find(u=>u.id===id),x=selected.x,z=selected.z;
   selected.target={x,z};const prior=copy.line.refills.length;copy.line.update(copy.units,1/60,true);
   assert.equal(copy.line.teams.get(team.team).columns[col][0],id);
   assert(!copy.line.refills.slice(prior).some(r=>r.previous===id));
   assert.equal(selected.x,x);assert.equal(selected.z,z);probes++;
  }
 }
 assert(probes>200,'cover occupied fronts before and after real charge damage, vacancies and uneven contact');
});

test('manual commands and pending contact retain priority over automatic motion goals',()=>{
 const sword=createFighter(0,'red','infantry',0,0),enemy=createFighter(1,'blue','infantry',2.1,0);enemy.target={x:2.1,z:0};
 stepSkirmish([sword,enemy],1/60,true);assert(sword.pendingStrike);
 sword.target={x:-8,z:0};let calls=0;const types=[];
 for(let i=0;i<36;i++)types.push(...stepSkirmish([sword,enemy],1/60,true,()=>{calls++;return {x:8,z:0,stop:0,hold:false};}).map(e=>e.type));
 assert.equal(calls,0);assert(types.includes('cancel-attack'));assert.equal(enemy.hp,100);assert(sword.x<0);
 const pike=createFighter(2,'red','pikeman',0,0),foot=createFighter(3,'blue','infantry',2.7,0);foot.target={x:2.7,z:0};
 // id2 has its native .18s stagger before the 11/24s windup; .6s is too short.
 const events=[];for(let i=0;i<48;i++)events.push(...stepSkirmish([pike,foot],1/60,true,()=>({x:-9,z:0,stop:0,hold:true})));
 assert(events.some(e=>e.type==='hit'&&e.from===pike));assert.equal(foot.hp,84);
});

test('rear rank waits and refills while real 4v4 contact finishes at 30 and 60 Hz',()=>{
 for(const dt of [1/30,1/60]){
  const units=formation(),line=new BattleLine(units),rear=new Set(line.inspect().teams.flatMap(f=>f.columns.flatMap(q=>q.slice(1))));
  let firstDeath=Infinity,winner=false;const attacks=[];
  for(let t=0;t<90;t+=dt){
   line.update(units,dt,true);for(const e of stepSkirmish(units,dt,true,(u,enemy)=>line.intent(u,enemy))){if(e.type==='death')firstDeath=Math.min(firstDeath,t);if(e.type==='attack')attacks.push({id:e.from.id,t});}
   const living=units.filter(u=>u.hp>0);for(let i=0;i<living.length;i++)for(let j=i+1;j<living.length;j++)assert(Math.hypot(living[i].x-living[j].x,living[i].z-living[j].z)>=living[i].radius+living[j].radius-.006);
   if(!living.some(u=>u.team==='red')||!living.some(u=>u.team==='blue')){winner=true;break;}
  }
  assert(winner);assert(line.refills.length>0);assert(attacks.some(a=>rear.has(a.id)&&a.t>=firstDeath));
 }
});

test('a laterally shifted opposing line remains reachable rather than deadlocking at original slots',()=>{
 const units=formation(4,5),line=new BattleLine(units);let winner=false;
 for(let i=0;i<9000;i++){
  line.update(units,1/60,true);stepSkirmish(units,1/60,true,(u,enemy)=>line.intent(u,enemy));
  assert(units.every(u=>Number.isFinite(u.x+u.z+u.heading)&&Math.abs(u.x)<=17&&Math.abs(u.z)<=13));
  const alive=units.filter(u=>u.hp>0);if(!alive.some(u=>u.team==='red')||!alive.some(u=>u.team==='blue')){winner=true;break;}
 }
 assert(winner);
});

test('bow and cavalry autonomy resumes when friendly or opposing foot lines no longer exist',()=>{
 const units=formation(),bow=createFighter(8,'red','archer',-8,0),horse=createFighter(9,'blue','cavalry',8,0);units.push(bow,horse);
 const line=new BattleLine(units);line.update(units,1/60,true);assert.equal(line.intent(horse,bow),null);
 units.filter(u=>u.kind==='infantry'&&u.team==='red').forEach(u=>u.hp=0);line.update(units,1/60,true);assert.equal(line.intent(bow,horse),null);
 const original=[createFighter(0,'red','cavalry',-8,0),createFighter(1,'blue','cavalry',8,0)],candidate=original.map(u=>createFighter(u.id,u.team,u.kind,u.x,u.z));const onlyHorse=new BattleLine(candidate);
 for(let i=0;i<1200;i++){onlyHorse.update(candidate,1/60,true);assert.deepEqual(eventView(stepSkirmish(original,1/60,true)),eventView(stepSkirmish(candidate,1/60,true,(u,e)=>onlyHorse.intent(u,e))));assert.deepEqual(unitView(original),unitView(candidate));}
});

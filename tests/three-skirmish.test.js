import test from 'node:test';
import assert from 'node:assert/strict';
import {createFighter,separateBodies,stepSkirmish,chargeReady,CHARGE} from '../js/three-demo/combat-model.js';
const run=(units,seconds,dt=1/60)=>{const events=[];for(let t=0;t<seconds-1e-8;t+=dt)events.push(...stepSkirmish(units,dt,true));return events;};
test('coincident infantry and horses separate by their real body radii and stay separated',()=>{const units=Array.from({length:16},(_,i)=>createFighter(i,i%2?'red':'blue',i%4?'infantry':'cavalry',0,0));separateBodies(units,100);for(let i=0;i<units.length;i++)for(let j=i+1;j<units.length;j++)assert.ok(Math.hypot(units[i].x-units[j].x,units[i].z-units[j].z)>=units[i].radius+units[j].radius-.005);});
test('stationary cavalry touching infantry cannot produce charge impacts',()=>{const horse=createFighter(0,'red','cavalry',0,0),foot=createFighter(1,'blue','infantry',2.2,0);const events=run([horse,foot],2);assert.equal(events.filter(e=>e.type==='charge').length,0);assert.ok(foot.hp<100);});
test('actual long forward run causes one first impact, knockback, cooldown and visible charge event',()=>{const horse=createFighter(0,'red','cavalry',-8,0),foot=createFighter(1,'blue','infantry',4,0);foot.target={x:4,z:0};const events=run([horse,foot],4);const hits=events.filter(e=>e.type==='charge'&&e.first);assert.equal(hits.length,1);assert.ok(horse.chargeCooldown>0);assert.ok(foot.hp<=100-CHARGE.damage);assert.ok(hits[0].nx>.9);});
test('heading reversal and separation displacement cannot manufacture run-up',()=>{const horse=createFighter(0,'red','cavalry',0,0),foot=createFighter(1,'blue','infantry',-2.2,0);horse.runup=5;horse.speed=4.8;const events=stepSkirmish([horse,foot],1/60,true);assert.equal(events.filter(e=>e.type==='charge').length,0);assert.equal(horse.runup,0);horse.runup=0;separateBodies([horse,foot]);assert.equal(horse.runup,0);assert.equal(chargeReady(horse,foot),false);});
test('dead bodies no longer constrain live bodies and death event happens once',()=>{const a=createFighter(0,'red','infantry',0,0),b=createFighter(1,'blue','infantry',1.25,0);b.hp=1;const events=run([a,b],3);assert.equal(events.filter(e=>e.type==='death'&&e.unit===b).length,1);const before={x:a.x,z:a.z};b.x=a.x;b.z=a.z;separateBodies([a,b]);assert.deepEqual({x:a.x,z:a.z},before);});
test('30 and 60 Hz both consume the run-up once and never reuse first impact in melee',()=>{for(const dt of [1/30,1/60]){const horse=createFighter(0,'red','cavalry',-8,0),foot=createFighter(1,'blue','infantry',4,0);foot.target={x:4,z:0};const events=run([horse,foot],5,dt);assert.equal(events.filter(e=>e.type==='charge'&&e.first).length,1);assert.equal(foot.hp,50);assert.equal(events.filter(e=>e.type==='hit'&&e.from===horse).length,1);}});

test('default mixed 32-fighter battle has impacts, a winner, and no body penetration',()=>{
 const units=[];for(const team of ['red','blue']){const side=team==='red'?-1:1;for(let i=0;i<12;i++)units.push(createFighter(units.length,team,'infantry',side*(8+Math.floor(i/4)*2.1),(i%4-1.5)*2.1));for(let i=0;i<4;i++)units.push(createFighter(units.length,team,'cavalry',side*(10.8+i%2*4.2),6+Math.floor(i/2)*4.2));}
 separateBodies(units);let charges=0,winner=false;for(let frame=0;frame<3600;frame++){charges+=stepSkirmish(units,1/60,true).filter(e=>e.type==='charge').length;const alive=units.filter(u=>u.hp>0);for(let i=0;i<alive.length;i++)for(let j=i+1;j<alive.length;j++)assert.ok(Math.hypot(alive[i].x-alive[j].x,alive[i].z-alive[j].z)>=alive[i].radius+alive[j].radius-.005);if(!alive.some(u=>u.team==='red')||!alive.some(u=>u.team==='blue')){winner=true;break;}}assert.ok(charges>0);assert.ok(winner);
});

test('spent charge momentum cannot damage a stationary side contact as another impact',()=>{const horse=createFighter(0,'red','cavalry',0,0),foot=createFighter(1,'blue','infantry',.1,1.2);Object.assign(horse,{heading:Math.PI/2,pierceTime:.7,momentum:.5,chargeCooldown:5,speed:0});const events=stepSkirmish([horse,foot],1/60,true);assert.equal(events.filter(e=>e.type==='charge').length,0);assert.equal(foot.hp,100);});

test('an edge kill cannot carry a lone horse off the battlefield',()=>{const horse=createFighter(0,'red','cavalry',16,0),foot=createFighter(1,'blue','infantry',17,0);Object.assign(horse,{runup:5,speed:4.8});foot.hp=1;run([horse,foot],2);assert.ok(horse.x<=17&&horse.x>=-17&&horse.z<=13&&horse.z>=-13);assert.equal(horse.pierceTime,0);assert.equal(horse.runup,0);});

test('pikeman can thrust at spear distance while sword infantry is still out of reach',()=>{const pike=createFighter(0,'red','pikeman',0,0),foot=createFighter(1,'blue','infantry',2.7,0);foot.target={x:2.7,z:0};const events=run([pike,foot],.6);assert.ok(events.some(e=>e.type==='hit'&&e.from===pike));assert.equal(pike.hp,100);assert.equal(foot.hp,84);});
test('archer draws before release and hurts a remote enemy only after arrow flight',()=>{const bow=createFighter(0,'red','archer',0,0),foot=createFighter(1,'blue','infantry',6,0);foot.target={x:6,z:0};const events=run([bow,foot],.6);assert.ok(events.some(e=>e.type==='draw'));assert.ok(events.some(e=>e.type==='shoot'));assert.equal(foot.hp,100);const hits=run([bow,foot],.6);assert.ok(hits.some(e=>e.type==='arrow-hit'));assert.equal(foot.hp,86);assert.ok(Math.hypot(bow.x-foot.x,bow.z-foot.z)>4);});
test('death cancels an arrow still on the bowstring',()=>{const bow=createFighter(0,'red','archer',0,0),foot=createFighter(1,'blue','infantry',6,0);foot.target={x:6,z:0};stepSkirmish([bow,foot],1/60,true);bow.hp=0;const events=run([bow,foot],1);assert.equal(events.filter(e=>e.type==='shoot').length,0);assert.equal(bow.pendingShot,null);assert.equal(events.filter(e=>e.type==='death'&&e.unit===bow).length,1);});
test('an arrow already in flight survives its shooter and cannot hit twice',()=>{const bow=createFighter(0,'red','archer',0,0),foot=createFighter(1,'blue','infantry',6,0);foot.target={x:6,z:0};run([bow,foot],.6);bow.hp=0;const events=run([bow,foot],2);assert.equal(events.filter(e=>e.type==='arrow-hit').length,1);assert.equal(foot.hp,86);assert.equal(bow.projectiles.length,0);});

test('four-role 32-fighter formation fires real arrows, charges, ends battle and preserves body separation',()=>{
 const units=[];for(const team of ['red','blue']){const side=team==='red'?-1:1;for(let i=0;i<6;i++)units.push(createFighter(units.length,team,'infantry',side*(8+Math.floor(i/4)*2.1),(i%4-1.5)*2.1));for(let i=0;i<4;i++)units.push(createFighter(units.length,team,'pikeman',side*12.2,(i-1.5)*2.1));for(let i=0;i<2;i++)units.push(createFighter(units.length,team,'archer',side*15,(i-.5)*3));for(let i=0;i<4;i++)units.push(createFighter(units.length,team,'cavalry',side*(10.8+i%2*4.2),6+Math.floor(i/2)*4.2));}
 separateBodies(units);const types=new Set();let winner=false;
 for(let frame=0;frame<7200;frame++){for(const e of stepSkirmish(units,1/60,true))types.add(e.type);const alive=units.filter(u=>u.hp>0);for(let i=0;i<alive.length;i++)for(let j=i+1;j<alive.length;j++)assert.ok(Math.hypot(alive[i].x-alive[j].x,alive[i].z-alive[j].z)>=alive[i].radius+alive[j].radius-.005);if(!alive.some(u=>u.team==='red')||!alive.some(u=>u.team==='blue')){winner=true;break;}}
 for(const type of ['draw','shoot','arrow-hit','charge','death'])assert.ok(types.has(type),type);assert.ok(winner);
});

test('an archer must face the enemy before drawing, and a release cannot turn away from the bow',()=>{
 const bow=createFighter(0,'red','archer',0,0),foot=createFighter(1,'blue','infantry',-6,0);foot.target={x:-6,z:0};assert.equal(stepSkirmish([bow,foot],1/60,true).some(e=>e.type==='draw'),false);
 bow.pendingShot={time:.001,targetId:foot.id};bow.heading=Math.PI/2;assert.equal(stepSkirmish([bow,foot],1/60,true).some(e=>e.type==='shoot'),false);
 bow.pendingShot=null;bow.attackCooldown=0;bow.heading=-Math.PI/2;bow.hitFlash=.4;assert.equal(stepSkirmish([bow,foot],1/60,true).some(e=>e.type==='draw'),false);
});

test('ordinary melee begins animation before damage and rechecks range at its contact frame',()=>{
 const sword=createFighter(0,'red','infantry',0,0),enemy=createFighter(1,'blue','infantry',2.1,0);enemy.target={x:2.1,z:0};const first=stepSkirmish([sword,enemy],1/60,true);assert.ok(first.some(e=>e.type==='attack'));assert.equal(enemy.hp,100);run([sword,enemy],.3);assert.equal(enemy.hp,100);enemy.x=7;enemy.target={x:7,z:0};assert.equal(run([sword,enemy],.25).filter(e=>e.type==='hit').length,0);assert.equal(enemy.hp,100);
});
test('a movement command cancels a pending melee contact rather than damaging while walking',()=>{
 const sword=createFighter(0,'red','infantry',0,0),enemy=createFighter(1,'blue','infantry',2.1,0);enemy.target={x:2.1,z:0};stepSkirmish([sword,enemy],1/60,true);sword.target={x:-8,z:0};const events=run([sword,enemy],.6);assert.ok(events.some(e=>e.type==='cancel-attack'));assert.equal(enemy.hp,100);assert.equal(sword.pendingStrike,null);
});

test('melee cannot begin or land a forward weapon strike against a rear contact',()=>{
 const sword=createFighter(0,'red','infantry',0,0),enemy=createFighter(1,'blue','infantry',-2.1,0);enemy.target={x:-2.1,z:0};const events=stepSkirmish([sword,enemy],1/60,true);assert.equal(events.some(e=>e.type==='attack'),false);
 sword.pendingStrike={time:0,targetId:enemy.id};sword.heading=Math.PI/2;assert.equal(stepSkirmish([sword,enemy],1/60,true).some(e=>e.type==='hit'),false);assert.equal(enemy.hp,100);
});

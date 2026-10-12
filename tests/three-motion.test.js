import test from 'node:test';import assert from 'node:assert/strict';import {createFighter,stepSkirmish} from '../js/three-demo/combat-model.js';
test('opt-in infantry turns its real displacement with its heading during a reversal',()=>{const u=createFighter(0,'red','infantry',0,0);u.locomotion=true;u.target={x:-5,z:0};for(let i=0;i<180;i++){const x=u.x,z=u.z;stepSkirmish([u],1/60,false);const dx=u.x-x,dz=u.z-z;if(Math.hypot(dx,dz)>1e-5)assert.ok(Math.abs(Math.atan2(Math.sin(Math.atan2(dx,dz)-u.heading),Math.cos(Math.atan2(dx,dz)-u.heading)))<.001);}assert.ok(u.x<-2);});
test('opt-in explicit stop brakes the physical position to rest without drifting indefinitely',()=>{const u=createFighter(0,'red','infantry',0,0);u.locomotion=true;u.target={x:10,z:0};for(let i=0;i<60;i++)stepSkirmish([u],1/60,false);const start=u.x;u.target=null;u.stopRequested=true;stepSkirmish([u],1/60,false);assert.ok(u.x>start);for(let i=0;i<90;i++)stepSkirmish([u],1/60,false);const settled=u.x;for(let i=0;i<90;i++)stepSkirmish([u],1/60,false);assert.equal(u.x,settled);assert.equal(u.speed,0);});

test('crowd opt-in leaves isolated duel trajectories and combat events unchanged',()=>{
 const make=crowd=>['red','blue'].map((t,i)=>{const u=createFighter(i,t,'infantry',i?3:-3,0);u.locomotion=true;u.crowd=crowd;return u;});
 const baseline=make(false),candidate=make(true);
 for(let i=0;i<1200;i++){
  const a=stepSkirmish(baseline,1/60,true),b=stepSkirmish(candidate,1/60,true);
  const view=us=>us.map(({x,z,heading,hp,speed,moving,pendingStrike})=>({x,z,heading,hp,speed,moving,pendingStrike}));
  assert.deepEqual(view(candidate),view(baseline));
  const events=es=>es.map(e=>[e.type,e.from?.id,e.target?.id,e.unit?.id]);assert.deepEqual(events(b),events(a));
 }
});

test('offset rear rank finds contact without bypassing real body separation or waiting for a casualty',()=>{
 const units=[];for(const team of ['red','blue'])for(let i=0;i<4;i++){const side=team==='red'?-1:1;const u=createFighter(units.length,team,'infantry',side*(4.5+Math.floor(i/2)*2.2),(i%2-.5)*2.2+(team==='blue'?.7:0));u.locomotion=true;u.crowd=true;units.push(u);}
 const attackers=new Set();for(let i=0;i<420;i++){
  for(const e of stepSkirmish(units,1/60,true))if(e.type==='attack')attackers.add(e.from.id);
  assert.equal(units.filter(u=>u.hp>0).length,8);
  for(let a=0;a<units.length;a++)for(let b=a+1;b<units.length;b++)assert.ok(Math.hypot(units[a].x-units[b].x,units[a].z-units[b].z)>=2.059,'real collision gap must remain');
 }
 assert.equal(attackers.size,8,'all eight must enter actual combat before deaths open the front');
});

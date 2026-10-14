import test from 'node:test';
import assert from 'node:assert/strict';
import {createFighter,stepSkirmish} from '../js/three-demo/combat-model.js';
import {sampleSettings,sampleFormation,stepSizedSkirmish} from '../js/three-demo/vitality-sample.js';
const make=s=>sampleFormation(s).map((p,i)=>({...createFighter(i,p.team,p.kind,p.x,p.z),radius:(p.kind==='cavalry'?2:1)*s,locomotion:p.kind==='infantry',crowd:p.kind==='infantry'}));
test('30 means remaining thirty percent, scoped only to the sample',()=>{
 assert.equal(sampleSettings(new URLSearchParams('sample=vitality&size=30')).scale,.3);
 assert.equal(sampleSettings(new URLSearchParams('size=30')).scale,1);
 assert.equal(sampleSettings(new URLSearchParams('sample=vitality&size=70')).scale,1);
 assert.equal(sampleSettings(new URLSearchParams('sample=vitality&look=previous')).refined,false);
});
test('both sample armies contain six swords and two cavalry',()=>{
 for(const scale of [1,.3])for(const team of ['red','blue']){
  const a=sampleFormation(scale).filter(u=>u.team===team);assert.equal(a.length,8);
  assert.equal(a.filter(u=>u.kind==='infantry').length,6);assert.equal(a.filter(u=>u.kind==='cavalry').length,2);
 }
});
test('body-size coordinate adapter preserves event timing, HP and native contact through battle',()=>{
 const full=make(1),small=make(.3);const totals={};
 for(let frame=0;frame<2400;frame++){
  const a=stepSkirmish(full,1/60,true),b=stepSizedSkirmish(small,1/60,true,.3);
  const events=list=>list.map(e=>[e.type,e.from?.id,e.target?.id,e.unit?.id,e.first]);
  assert.deepEqual(events(b),events(a),`events at ${frame}`);
  for(let i=0;i<full.length;i++){
   assert.equal(small[i].hp,full[i].hp);assert.ok(Math.abs(small[i].x/.3-full[i].x)<1e-7);assert.ok(Math.abs(small[i].z/.3-full[i].z)<1e-7);
   assert.ok(Math.abs(small[i].radius/.3-full[i].radius)<1e-10);
  }
  for(const e of b)totals[e.type]=(totals[e.type]??0)+1;
 }
 assert.ok(totals.hit>0);assert.ok(totals.charge>0);assert.ok(totals.death>0);
});
test('small actors can obey orders beyond the small initial formation and keep world boundary',()=>{
 const u=createFighter(0,'red','infantry',12,0);u.radius*=.3;u.target={x:16,z:0};u.locomotion=true;
 for(let i=0;i<1200;i++)stepSizedSkirmish([u],1/60,false,.3);
 assert.ok(u.x>15.9&&u.x<=17);assert.ok(Math.abs(u.z)<1e-6);
});

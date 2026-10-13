import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const feedbackStage=process.env.QA_STAGE==='f1';
const chargeStage=process.env.QA_STAGE==='f2';
const lateStage=process.env.QA_STAGE==='w2';
const output=process.env.QA_OUTPUT||(lateStage?'.omc/evidence/war-feel/w2/pilot':chargeStage?'.omc/evidence/war-feel/f2/pilot':feedbackStage?'.omc/evidence/war-feel/f1/pilot':'.omc/evidence/war-feel/w1/pilot');
const modes=(process.env.QA_MODES||(lateStage?'sixteen,mixed':chargeStage?'mixed,cavalry':feedbackStage?'infantry,archer,cavalry,mixed':'four,sixteen,mixed')).split(',');
const sources=['js/three-demo/main.js','js/three-demo/combat-model.js','js/three-demo/battle-line.js',...(feedbackStage||chargeStage||lateStage?['js/three-demo/combat-feedback.js']:[]),...(lateStage?['js/three-demo/late-crowd.js']:[])];
const hashes=()=>Object.fromEntries(sources.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const before=hashes(),errors=[],requests=[],runs=[];
mkdirSync(output,{recursive:true});
const browser=await chromium.launch({executablePath:'/Users/linshen/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',headless:true});
const fixed={model:'r2',pike:'standard',bow:'standard',ride:'standard',motion:'candidate',duel:'candidate',crowd:'candidate',coordination:'candidate',terrain:'candidate',building:'candidate',camera:'candidate',light:'candidate',corpse:'candidate'};
async function run(mode,version){
 const dir=output+'/'+mode+'-'+version;mkdirSync(dir,{recursive:true});
 const context=await browser.newContext({viewport:{width:1280,height:900},recordVideo:{dir,size:{width:1280,height:900}}});
 const page=await context.newPage();
 page.on('pageerror',e=>errors.push({mode,version,error:e.message}));
 page.on('console',e=>{if(e.type()==='error')errors.push({mode,version,error:e.text()});});
 page.on('response',r=>{if(r.url().endsWith('.glb'))requests.push({mode,version,url:r.url(),status:r.status()});});
 const params=new URLSearchParams({...fixed,front:version});
 if(mode!=='mixed'){params.set('qa',mode);params.set('unit','infantry');params.set('modelRole','infantry');params.set('terrainScene','slope');params.set('capture','1');}
 const url='http://127.0.0.1:5301/battle3d.html?'+params;
 await page.goto(url);await page.waitForFunction(()=>window.frontPreview&&document.getElementById('loading').hidden);
 const initial=await page.evaluate(()=>({front:window.frontPreview.inspect(),camera:window.cameraPreview.inspect().camera,canvas:[document.querySelector('#viewport canvas').width,document.querySelector('#viewport canvas').height]}));
 await page.screenshot({path:dir+'/initial.png'});
 await page.evaluate(()=>{if(window.crowdQA)window.crowdQA.start();else document.getElementById('fight').click();});
 const seconds=Number(process.env.QA_SECONDS||({four:23,sixteen:45,mixed:55}[mode])),samples=[],pictures=[];
 const checkpoints=[4,8,12,18,seconds];let next=0;
 while(true){
  await page.waitForTimeout(700);
  const data=await page.evaluate(()=>window.frontPreview.inspect());
  assert(data.units.every(u=>Number.isFinite(u.x+u.z+u.heading+u.hp)));
  for(const u of data.units){assert(Math.abs(u.x)<=17.00001&&Math.abs(u.z)<=13.00001);}
  const living=data.units.filter(u=>u.hp>0);let minGap=Infinity;
  for(let i=0;i<living.length;i++)for(let j=i+1;j<living.length;j++)minGap=Math.min(minGap,Math.hypot(living[i].x-living[j].x,living[i].z-living[j].z)-living[i].radius-living[j].radius);
  assert(minGap>=-.006,'body separation regression');samples.push({...data,minGap});
  if(data.elapsed>=checkpoints[next]){const filename='battle-'+checkpoints[next]+'.png';await page.screenshot({path:dir+'/'+filename});pictures.push({filename,actualElapsed:data.elapsed,alive:living.length,formation:data.formation});next++;}
  if(data.elapsed>=seconds)break;
 }
 await page.click('#pause');const paused=await page.evaluate(()=>window.frontPreview.inspect());
 await page.waitForTimeout(250);assert.deepEqual(await page.evaluate(()=>window.frontPreview.inspect()),paused);
 const trace=await page.evaluate(()=>window.crowdQA?{events:window.crowdQA.events,trace:window.crowdQA.trace}:null);
 await page.click('#reset');const reset=await page.evaluate(()=>window.frontPreview.inspect());assert(reset.units.every(u=>u.hp===100));assert(!reset.formation||reset.formation.refills.length===0);
 const summary={source:'actual battle3d normal stepSkirmish and real commands/events; independent wall clocks, no bitwise battle outcome comparison',url,mode,version,initial,samples,pictures,paused,reset,trace};
 writeFileSync(dir+'/summary.json',JSON.stringify(summary,null,2));runs.push({mode,version,lastTime:paused.elapsed,alive:paused.units.filter(u=>u.hp>0).length,refills:paused.formation?.refills.length??0,files:pictures.map(p=>p.filename),camera:initial.camera,canvas:initial.canvas,events:trace?.events?.reduce((v,e)=>(v[e.type]=(v[e.type]??0)+1,v),{})});
 const record=runs.at(-1);await context.close();console.log(JSON.stringify(record));
}
try{for(const mode of modes)await Promise.all(['baseline','candidate'].map(version=>lateStage?runLate(mode,version):chargeStage?runCharge(mode,version):feedbackStage?runFeedback(mode,version):run(mode,version)));assert.deepEqual(hashes(),before);assert.equal(errors.length,0);assert(requests.every(r=>r.status===200));}
finally{writeFileSync(output+'/summary.json',JSON.stringify({sourceHashes:before,sourceAfter:hashes(),runs,errors,requests},null,2));await browser.close();}

async function runLate(mode,version){
 const dir=output+'/'+mode+'-'+version;mkdirSync(dir,{recursive:true});
 const context=await browser.newContext({viewport:{width:1280,height:900},recordVideo:{dir,size:{width:1280,height:900}}});
 const page=await context.newPage();page.on('pageerror',e=>errors.push({mode,version,error:e.message}));
 page.on('console',e=>{if(e.type()==='error')errors.push({mode,version,error:e.text()});});
 page.on('response',r=>{if(r.url().endsWith('.glb'))requests.push({mode,version,url:r.url(),status:r.status()});});
 const params=new URLSearchParams({...fixed,front:'candidate',feedback:'candidate',chargefx:'candidate',crowdlate:version});
 if(mode==='sixteen'){params.set('qa','sixteen');params.set('unit','infantry');params.set('modelRole','infantry');}
 const url='http://127.0.0.1:5301/battle3d.html?'+params;await page.goto(url);await page.waitForFunction(()=>window.lateCrowdPreview&&window.frontPreview&&document.getElementById('loading').hidden);
 const initial=await page.evaluate(()=>{document.getElementById('reset').click();window.modelPreview?.clearSelection();window.lightingPreview.freeze();return {front:window.frontPreview.inspect(),late:window.lateCrowdPreview.inspect(),camera:window.cameraPreview.inspect().camera,canvas:[document.querySelector('#viewport canvas').width,document.querySelector('#viewport canvas').height]};});
 await page.screenshot({path:dir+'/initial.png'});await page.click('#fight');
 const samples=[],pictures=[],observedEvents=new Map();let low=null,nextOffset=0;
 while(true){
  await page.waitForTimeout(300);
  const data=await page.evaluate(()=>({front:window.frontPreview.inspect(),late:window.lateCrowdPreview.inspect(),feedback:window.feedbackPreview.inspect()}));
  const alive=data.front.units.filter(u=>u.hp>0),counts=Object.fromEntries(['red','blue'].map(team=>[team,alive.filter(u=>u.team===team).length]));
  let minGap=Infinity;for(let i=0;i<alive.length;i++)for(let j=i+1;j<alive.length;j++)minGap=Math.min(minGap,Math.hypot(alive[i].x-alive[j].x,alive[i].z-alive[j].z)-alive[i].radius-alive[j].radius);
  assert(minGap>=-.006);assert(data.front.units.every(u=>Number.isFinite(u.x+u.z+u.heading+u.hp)&&Math.abs(u.x)<=17.00001&&Math.abs(u.z)<=13.00001));
  for(const event of data.feedback.events)observedEvents.set(JSON.stringify(event),event);
  const sample={...data,minGap,counts};samples.push(sample);
  if(low===null&&Math.min(counts.red,counts.blue)<=2&&Math.max(counts.red,counts.blue)>=3)low=data.front.elapsed;
  if(low!==null&&nextOffset<3&&data.front.elapsed>=low+nextOffset*2){
   const filename=`late-${nextOffset*2}.png`;await page.screenshot({path:dir+'/'+filename});pictures.push({filename,requestedOffset:nextOffset*2,actualTime:data.front.elapsed,actualOffset:data.front.elapsed-low,counts,planner:data.late.planner});nextOffset++;
  }
  if(counts.red===0||counts.blue===0)break;
  assert(data.front.elapsed<90,'native battle did not finish in the bounded window');
 }
 await page.click('#pause');const paused=await page.evaluate(()=>({front:window.frontPreview.inspect(),late:window.lateCrowdPreview.inspect(),feedback:window.feedbackPreview.inspect()}));
 await page.screenshot({path:dir+'/outcome.png'});await page.waitForTimeout(200);assert.deepEqual(await page.evaluate(()=>({front:window.frontPreview.inspect(),late:window.lateCrowdPreview.inspect(),feedback:window.feedbackPreview.inspect()})),paused);
 await page.click('#reset');const reset=await page.evaluate(()=>({front:window.frontPreview.inspect(),late:window.lateCrowdPreview.inspect(),feedback:window.feedbackPreview.inspect()}));assert(reset.front.units.every(u=>u.hp===100));assert(!reset.late.planner||reset.late.planner.routes.length===0&&reset.late.planner.events.length===0);
 const summary={source:'Normal native stepSkirmish from unchanged initial units through winner, independent wall-clock dt; observed event polling is not a guaranteed complete event total.',url,mode,version,initial,lowTime:low,samples,pictures,observedEvents:[...observedEvents.values()],paused,reset};
 writeFileSync(dir+'/summary.json',JSON.stringify(summary,null,2));runs.push({mode,version,lowTime:low,lastTime:paused.front.elapsed,living:paused.front.units.filter(u=>u.hp>0).map(u=>({id:u.id,team:u.team,hp:u.hp})),routeEvents:paused.late.planner?.events??[],camera:initial.camera,canvas:initial.canvas,finite:true});await context.close();console.log(JSON.stringify(runs.at(-1)));
}

async function runFeedback(mode,version){
 const dir=output+'/'+mode+'-'+version;mkdirSync(dir,{recursive:true});
 const context=await browser.newContext({viewport:{width:1280,height:900},recordVideo:{dir,size:{width:1280,height:900}}});
 const page=await context.newPage();
 page.on('pageerror',e=>errors.push({mode,version,error:e.message}));
 page.on('console',e=>{if(e.type()==='error')errors.push({mode,version,error:e.text()});});
 page.on('response',r=>{if(r.url().endsWith('.glb'))requests.push({mode,version,url:r.url(),status:r.status()});});
 const params=new URLSearchParams({...fixed,front:'candidate',feedback:version,capture:'1'});
 if(mode!=='mixed'){params.set('qa','duel');params.set('unit',mode);params.set('modelRole',mode);}
 const url='http://127.0.0.1:5301/battle3d.html?'+params;
 await page.goto(url);await page.waitForFunction(()=>window.feedbackPreview&&document.getElementById('loading').hidden);
 const initial=await page.evaluate(()=>{window.modelPreview?.clearSelection();return {feedback:window.feedbackPreview.inspect(),camera:window.cameraPreview.inspect().camera,canvas:[document.querySelector('#viewport canvas').width,document.querySelector('#viewport canvas').height]};});
 assert(!initial.feedback.effects||initial.feedback.effects.active===0);await page.screenshot({path:dir+'/initial.png'});
 await page.click('#fight');
 const seconds=Number(process.env.QA_SECONDS||({infantry:14,archer:20,cavalry:16,mixed:20}[mode]));
 const samples=[],pictures=[],seen=new Set();let sampleTime=0;
 while(true){
  await page.waitForTimeout(35);const data=await page.evaluate(()=>window.feedbackPreview.inspect());
  assert(data.units.every(u=>Number.isFinite(u.x+u.z+u.heading+u.hp)));
  assert(!data.effects||data.effects.active<=128);
  assert(!data.effects||data.effects.particles.every(p=>p.position.every(Number.isFinite)));
  if(data.elapsed>=sampleTime){samples.push(data);sampleTime=data.elapsed+.2;}
  const relevant=['hit','arrow-hit','charge','death'];
  for(const type of relevant)if(data.counts[type]&&!seen.has(type)){
   seen.add(type);const filename=type+'.png';await page.screenshot({path:dir+'/'+filename});
   pictures.push({filename,requestElapsed:data.elapsed,afterCapture:await page.evaluate(()=>window.feedbackPreview.inspect())});
  }
  // A representative main-view attack phase, with exactly the same fixed camera.
  if(mode==='mixed'&&data.elapsed>=8&&!seen.has('main-8')){seen.add('main-8');await page.screenshot({path:dir+'/main-8.png'});pictures.push({filename:'main-8.png',requestElapsed:data.elapsed,afterCapture:await page.evaluate(()=>window.feedbackPreview.inspect())});}
  if(data.elapsed>=seconds)break;
 }
 await page.click('#pause');const paused=await page.evaluate(()=>window.feedbackPreview.inspect());
 await page.screenshot({path:dir+'/end.png'});await page.waitForTimeout(200);assert.deepEqual(await page.evaluate(()=>window.feedbackPreview.inspect()),paused);
 await page.click('#reset');const reset=await page.evaluate(()=>window.feedbackPreview.inspect());assert(reset.units.every(u=>u.hp===100));assert.deepEqual(reset.counts,{});assert(!reset.effects||reset.effects.active===0&&reset.effects.queued===0);
 const summary={source:'actual normal stepSkirmish event summaries and post-pose presentation, independent wall-clock runs; controlled exact event/state compatibility is tested separately',url,mode,version,initial,samples,pictures,paused,reset};
 writeFileSync(dir+'/summary.json',JSON.stringify(summary,null,2));runs.push({mode,version,lastTime:paused.elapsed,alive:paused.units.filter(u=>u.hp>0).length,counts:paused.counts,created:paused.effects?.created,maximumActive:Math.max(0,...samples.map(s=>s.effects?.active??0)),files:pictures.map(p=>p.filename),camera:initial.camera,canvas:initial.canvas});
 const record=runs.at(-1);await context.close();console.log(JSON.stringify(record));
}

async function runCharge(mode,version){
 const dir=output+'/'+mode+'-'+version;mkdirSync(dir,{recursive:true});
 const context=await browser.newContext({viewport:{width:1280,height:900},recordVideo:{dir,size:{width:1280,height:900}}});
 const page=await context.newPage();
 page.on('pageerror',e=>errors.push({mode,version,error:e.message}));
 page.on('console',e=>{if(e.type()==='error')errors.push({mode,version,error:e.text()});});
 page.on('response',r=>{if(r.url().endsWith('.glb'))requests.push({mode,version,url:r.url(),status:r.status()});});
 const params=new URLSearchParams({...fixed,front:'candidate',feedback:'candidate',chargefx:version});
 if(mode==='cavalry'){params.set('qa','duel');params.set('unit','cavalry');params.set('modelRole','cavalry');}
 const url='http://127.0.0.1:5301/battle3d.html?'+params;
 await page.goto(url);await page.waitForFunction(()=>window.feedbackPreview&&window.chargefxPreview&&document.getElementById('loading').hidden);
 const initial=await page.evaluate(()=>{document.getElementById('reset').click();window.modelPreview.clearSelection();window.lightingPreview.freeze();return {feedback:window.feedbackPreview.inspect(),active:window.chargefxPreview.active,camera:window.cameraPreview.inspect().camera,canvas:[document.querySelector('#viewport canvas').width,document.querySelector('#viewport canvas').height]};});
 assert.equal(initial.active,version==='candidate');assert.equal(initial.feedback.effects.active,0);
 await page.screenshot({path:dir+'/initial.png'});
 await page.evaluate(()=>{
  window.__chargeCapture={before:[],contact:null,lastImageTime:-1};
  function observe(){
   const sample=window.feedbackPreview.inspect(),capture=window.__chargeCapture;
   if(sample.counts.charge>0){
    document.getElementById('pause').click();
    capture.contact={gameTime:sample.elapsed,wallTime:performance.now(),sample:window.feedbackPreview.inspect()};return;
   }
   if(sample.fighting&&sample.elapsed-capture.lastImageTime>=.1&&window.frontPreview.inspect().units.some(u=>u.kind==='cavalry'&&u.runup>=3.2&&u.speed>=3.4)){
    capture.before.push({gameTime:sample.elapsed,wallTime:performance.now(),sample,image:document.querySelector('#viewport canvas').toDataURL('image/png')});
    if(capture.before.length>3)capture.before.shift();capture.lastImageTime=sample.elapsed;
   }
   requestAnimationFrame(observe);
  }
  document.getElementById('fight').click();requestAnimationFrame(observe);
 });
 await page.waitForFunction(()=>window.__chargeCapture.contact,null,{timeout:45000,polling:'raf'});
 const capture=await page.evaluate(()=>window.__chargeCapture),before=capture.before.at(-1),phases=[];
 if(before){writeFileSync(dir+'/charge-before-canvas.png',Buffer.from(before.image.split(',')[1],'base64'));delete before.image;}
 const start=capture.contact.gameTime;
 for(const offset of [0,.1,.2,.4]){
  if(offset){await page.click('#pause');await page.waitForFunction(t=>window.feedbackPreview.inspect().elapsed>=t,start+offset,{polling:'raf'});await page.evaluate(()=>document.getElementById('pause').click());}
  const sample=await page.evaluate(()=>window.feedbackPreview.inspect());
  const filename='charge-'+offset.toFixed(2)+'.png';await page.screenshot({path:dir+'/'+filename});
  assert.deepEqual(await page.evaluate(()=>window.feedbackPreview.inspect()),sample);
  phases.push({filename,requestOffset:offset,actualOffset:sample.elapsed-start,actualTime:sample.elapsed,sample});
 }
 const paused=await page.evaluate(()=>window.feedbackPreview.inspect());await page.waitForTimeout(100);assert.deepEqual(await page.evaluate(()=>window.feedbackPreview.inspect()),paused);
 await page.click('#reset');const reset=await page.evaluate(()=>window.feedbackPreview.inspect());assert(reset.units.every(u=>u.hp===100));assert.equal(reset.effects.active,0);assert.equal(reset.effects.queued,0);
 const event=capture.contact.sample.events.filter(e=>e.type==='charge').at(-1);
 const summary={source:'normal resolved first charge in actual game; read-only pre-contact canvas buffer, native UI pause only after event for short lifespan samples; no synthetic combat event',url,mode,version,initial,event,before,contact:capture.contact,phases,paused,reset};
 writeFileSync(dir+'/summary.json',JSON.stringify(summary,null,2));const record={mode,version,event,beforeTime:before?.gameTime,contactTime:start,phaseOffsets:phases.map(p=>p.actualOffset),camera:initial.camera,canvas:initial.canvas,peak:Math.max(...phases.map(p=>p.sample.effects.active))};runs.push(record);await context.close();console.log(JSON.stringify(record));
}

import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const role=process.env.QA_ROLE||'infantry';
assert(['infantry','pikeman','archer','cavalry'].includes(role),'Unsupported model standard QA role');
const versions=role==='infantry'?[['baseline','baseline'],['r2','candidate']]:[['candidate','baseline'],['standard','candidate']];
const output=process.env.QA_OUTPUT || `.omc/evidence/model-standard/${role}-first-pass`;
mkdirSync(output,{recursive:true});
const executables=['chromium-1228','chromium-1208'].map(version=>join(homedir(),`Library/Caches/ms-playwright/${version}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`));
const browser=await chromium.launch({executablePath:executables.find(existsSync),headless:true});
const errors=[],network=[];
const base='http://127.0.0.1:5301/battle3d.html?motion=candidate&duel=candidate&crowd=candidate&pike=candidate&bow=candidate&ride=candidate&coordination=candidate&terrain=candidate&building=candidate&camera=candidate&light=candidate';
const queryFor=version=>{const url=new URL(base);if(role==='infantry')url.searchParams.set('model',version);else{url.searchParams.set('model','r2');url.searchParams.set('pike',role==='pikeman'?version:'standard');url.searchParams.set('modelRole',role);url.searchParams.set('unit',role);if(role==='archer')url.searchParams.set('bow',version);if(role==='cavalry'){url.searchParams.set('bow','standard');url.searchParams.set('ride',version);}}return url.href;};
const summary={role,viewport:[1280,900],source:'actual Three.js GLB loader and skinned vertices in battle3d.html',static:[],errors,network};
try {
 async function dynamicRun(model,label,mode,duration,apiName){
  const runOutput=join(output,label+'-'+mode);mkdirSync(runOutput,{recursive:true});
  const context=await browser.newContext({viewport:{width:1280,height:900},recordVideo:{dir:runOutput,size:{width:1280,height:900}}});
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push({label,mode,message:e.message}));
  page.on('console',e=>{if(e.type()==='error')errors.push({label,mode,message:e.text()});});
  page.on('response',r=>{if(r.url().endsWith('.glb'))network.push({label,mode,url:r.url(),status:r.status()});});
  await page.goto(`${queryFor(model)}${mode==='mixed'?'':`&qa=${mode}`}&capture=1`,{waitUntil:'load'});
  await page.waitForFunction(()=>document.getElementById('loading').hidden);
  const initial=await page.evaluate(()=>window.cameraPreview.inspect());
  if(apiName)await page.evaluate(name=>window[name].start(),apiName);
  else await page.click('#fight');
  const times=mode==='single'?[1,4,7,10,12,13,16,18,21,24]:mode==='duel'?[1,4,8,12,16,18]:mode==='four'?[1,4,8,12,16,24,32]:[.5,2,4,6,8,10,14];
  const captures=[];
  for(const time of times){
   await page.waitForFunction(({name,time})=>(name?window[name].trace.at(-1)?.time:window.cameraPreview.inspect().elapsed)>=time,{name:apiName,time},{timeout:90000});
   const actual=await page.evaluate(()=>window.cameraPreview.inspect());
   assert(actual.units.every(u=>u.bounds.finite),`${label} ${mode} non-finite rendered bounds`);
   await page.screenshot({path:join(runOutput,`${time}.png`)});
   captures.push({targetTime:time,actual});
  }
  await page.click('#pause');
  const replay=apiName?await page.evaluate(name=>({trace:window[name].trace,events:window[name].events||[],frames:(window[name].frames||[]).map(f=>({time:f.time,trace:f.trace}))}),apiName):null;
  const paused=await page.evaluate(()=>window.cameraPreview.inspect());
  await page.click('#reset');
  const reset=await page.evaluate(()=>window.cameraPreview.inspect());
  assert.equal(reset.units.length,initial.units.length);
  assert(reset.units.every(u=>u.hp>0));
  const result={label,mode,duration,initial,captures,paused,reset,replay};
  writeFileSync(join(runOutput,'summary.json'),JSON.stringify(result,null,2)+'\n');
  await context.close();
  summary.dynamic??=[];summary.dynamic.push({label,mode,actualTime:paused.elapsed,initial:initial.units.length,alive:paused.units.filter(u=>u.hp>0).length,resetAlive:reset.units.filter(u=>u.hp>0).length,eventCounts:(replay?.events||[]).reduce((a,e)=>(a[e.type]=(a[e.type]||0)+1,a),{})});
  console.log(JSON.stringify(summary.dynamic.at(-1)));
 }
 if(process.env.QA_PHASE==='dynamic'){
  for(const [model,label]of versions)for(const [mode,duration,api]of [['single',24,'motionQA'],['duel',18,'duelQA'],['four',32,'crowdQA'],['mixed',14,null]])await dynamicRun(model,label,mode,duration,api);
 }else{
 for(const [model,label]of versions){
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  page.on('pageerror',e=>errors.push({label,message:e.message}));
  page.on('console',e=>{if(e.type()==='error')errors.push({label,message:e.text()});});
  page.on('response',r=>{if(r.url().endsWith('.glb'))network.push({label,url:r.url(),status:r.status()});});
  await page.goto(`${queryFor(model)}&still=1&view=near&solo=1&time=0`,{waitUntil:'load'});
  await page.waitForFunction(()=>window.soldierPreview && document.getElementById('loading').hidden);
  const samples=[['near-front','idle',0,.6435011088],['near-side','idle',0,2.2142974356],['near-back','idle',0,3.7850937624],
   ['walk-1','walk',.12,.6435011088],['walk-2','walk',.25,.6435011088],['walk-3','walk',.4,.6435011088],['walk-4','walk',.60,.6435011088],
   ['attack-1','attack',.12,.6435011088],['attack-2','attack',.30,.6435011088],['attack-3','attack',.46,.6435011088],['attack-4','attack',.66,.6435011088],
   ['hit','hit',.125,.6435011088],['death','death',1.25,.6435011088]];
  if(role==='pikeman')samples.push(...[['attack-side-1','attack',.12,2.2142974356],['attack-side-2','attack',.30,2.2142974356],['attack-side-3','attack',.46,2.2142974356],['attack-side-4','attack',.66,2.2142974356],...[0,.08,.20,.54,1.25].map(t=>['death-entry-'+t,'death',t,2.2142974356])]);
  if(role==='cavalry')samples.push(...[.08,.24,.42,.64].map(t=>['charge-'+t,'charge',t,2.2142974356]),...[0,.20,.54,1.25].map(t=>['death-entry-'+t,'death',t,2.2142974356]));
  if(role==='archer')samples.push(...[['draw-side','attack',.30,2.2142974356],['release-side','attack',.46,2.2142974356],['recovery-side','attack',.66,2.2142974356],...[0,.20,.54,1.25].map(t=>['death-entry-'+t,'death',t,2.2142974356])]);
  for(const [name,clip,time,angle]of samples){
   const result=await page.evaluate(({clip,time,angle})=>{window.soldierPreview.sample(clip,time,angle);const canvas=document.querySelector('#viewport canvas');return {asset:window.soldierPreview.asset,canvas:[canvas.width,canvas.height],...window.soldierPreview.inspect()};},{clip,time,angle});
   assert(result.finite,`${label} ${name} contains invalid skinned vertices`);
   const filename=`${label}-${name}.png`;
   await page.screenshot({path:join(output,filename)});
   summary.static.push({label,name,clip,time,angle,filename,...result});
  }
  await page.goto(queryFor(model),{waitUntil:'load'});
  await page.waitForFunction(()=>window.cameraPreview && document.getElementById('loading').hidden);
  await page.evaluate(()=>{window.lightingPreview.freeze();window.modelPreview.clearSelection();});
  const camera=await page.evaluate(()=>window.cameraPreview.inspect());
  await page.screenshot({path:join(output,`${label}-main.png`)});
  summary.static.push({label,name:'main',camera});
  await page.close();
 }
 }
 assert.equal(errors.length,0,'Browser errors');
 assert(network.every(r=>r.status===200),'GLB request failure');
} finally {
 writeFileSync(join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
 await browser.close();
}
console.log(JSON.stringify({output,samples:summary.static.length,errors,glbRequests:network.length}));

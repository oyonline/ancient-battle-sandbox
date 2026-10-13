import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const output=process.env.QA_OUTPUT||'.omc/evidence/model-standard/s1/pilot';
mkdirSync(output,{recursive:true});
const browser=await chromium.launch({executablePath:'/Users/linshen/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',headless:true});
const errors=[],requests=[],samples=[];
try{
 for(const terrain of (process.env.QA_TERRAINS||'slope').split(','))
 for(const role of (process.env.QA_ROLES||'infantry,pikeman,archer,cavalry').split(','))
 for(const version of ['baseline','candidate']){
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',e=>{if(e.type()==='error')errors.push(e.text());});
  page.on('response',r=>{if(r.url().endsWith('.glb'))requests.push({url:r.url(),status:r.status()});});
  const params=new URLSearchParams({model:'r2',pike:'standard',bow:'standard',ride:'standard',motion:'candidate',duel:'candidate',crowd:'candidate',coordination:'candidate',terrain:'candidate',building:'candidate',light:'candidate',camera:'candidate',modelRole:role,unit:role,qa:'single',terrainScene:terrain,corpse:version,still:'1',view:'near',solo:'1'});
  await page.goto('http://127.0.0.1:5301/battle3d.html?'+params);
  await page.waitForFunction(()=>window.soldierPreview&&window.corpsePreview&&document.getElementById('loading').hidden);
  for(const heading of [.6435011088,3.7850937624])
  for(const time of (process.env.QA_TIMES||'.8,1.25,1.65').split(',').map(Number)){
   const data=await page.evaluate(({time,heading})=>{window.soldierPreview.sample('death',time,heading);return {asset:window.soldierPreview.asset,camera:window.cameraPreview.inspect().camera,canvas:[document.querySelector('#viewport canvas').width,document.querySelector('#viewport canvas').height],contact:window.corpsePreview.inspect()[0]};},{time,heading});
   assert(data.contact.finite,'non-finite corpse');assert(data.contact.gap>-.001,'corpse below terrain');
   const sample={terrain,role,version,heading,time,...data};
   if(time===1.25){sample.filename=`${terrain}-${role}-${version}-${heading.toFixed(3)}.png`;await page.screenshot({path:output+'/'+sample.filename});}
   samples.push(sample);
  }
  // Death -> Idle -> Death with changed heading must clear the model overlay.
  const loop=await page.evaluate(()=>{window.soldierPreview.sample('idle',0,.6435011088);const idle=window.corpsePreview.inspect()[0];window.soldierPreview.sample('death',1.25,3.7850937624);const first=window.corpsePreview.inspect()[0];window.soldierPreview.sample('death',1.25,3.7850937624);const second=window.corpsePreview.inspect()[0];return {idle:first?{q:idle.modelQuaternion,y:idle.modelY}:null,first,second};});
  assert.deepEqual(loop.idle.q,[0,0,0,1]);assert.deepEqual(loop.first.modelQuaternion,loop.second.modelQuaternion);assert.equal(loop.first.modelY,loop.second.modelY);
  writeFileSync(`${output}/${terrain}-${role}-${version}-loop.json`,JSON.stringify(loop,null,2));
  await page.close();console.log(JSON.stringify({terrain,role,version,done:true}));
 }
 assert.equal(errors.length,0);assert(requests.every(r=>r.status===200));
}finally{
 writeFileSync(output+'/summary.json',JSON.stringify({source:'actual battle3d controlled native mixer and explicit Q1 proxy; not a natural combat death',samples,errors,requests},null,2));
 await browser.close();
}

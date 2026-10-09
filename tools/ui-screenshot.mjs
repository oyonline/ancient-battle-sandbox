import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
const cand = [
    path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
];
const EXE = cand.find(existsSync);
const URL = process.env.SHOT_URL || 'http://127.0.0.1:4399/classic.html';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1200);
await page.click('[data-territory-entry]');
await page.click('#btn-start');
await page.waitForTimeout(9000);   // 倒计时+开局
await page.screenshot({ path: '/tmp/ui-shot-1-default.png' });
// 打开建设面板
await page.click('#btn-camp-open');
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/ui-shot-2-camp-open.png' });
// 选中一个己方士兵 → 营队条出现下令按钮
const picked = await page.evaluate(() => {
    const scene = window.UI?.scene;
    const u = scene?.units?.find(x => x.team === (window.UI.mySide || 'red') && !x.dead && x.type === 'infantry');
    if (!u) return null;
    scene.selectBattalionByUnit(u);
    window.UI.updateBattalionBar();
    return u.id;
});
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/ui-shot-3-battalion.png' });
// DOM 状态断言
const state = await page.evaluate(() => ({
    stripHidden: document.getElementById('territory-strip')?.hidden,
    dockHidden: document.getElementById('recruit-dock')?.hidden,
    controlbarDisplay: getComputedStyle(document.getElementById('controlbar')).display,
    campHidden: document.getElementById('camp-control-bar')?.hidden,
    ctlHost: document.getElementById('battle-ctl')?.parentElement?.id,
    recruitBtns: document.querySelectorAll('#recruit-bar .recruit-btn').length,
    battalionHidden: document.getElementById('battalion-bar')?.hidden
}));
console.log('picked unit:', picked);
console.log(JSON.stringify(state, null, 1));
console.log('pageerrors:', errors.length);
if (process.env.SHOT_GAMEPLAY === '1') {
    // Bounded rendering fixture: state preparation only; following clicks/mouse moves exercise actual UI.
    const fixture = await page.evaluate(() => {
        const ui=window.UI,scene=ui.scene;
        const options={territory:true,coop:true,black:{},territoryAI:false,terrain:'territory'};
        ui.cancelTargeting();scene.deployUnits({}, {}, 'custom','custom',{},options);
        ui.battleOptions={...ui.battleOptions,...options,net:false};ui.phase='battle';ui.countdown=false;
        scene.battleStarted=true;scene.paused=true;
        for (const [index,type] of ['infantry','pikeman','archer','cavalry'].entries()) {
            const unit=scene.spawnUnit('black',type,44+index*3,80);unit.slideOff=0;
        }
        for (const [index,team] of ['red','blue','black'].entries()) {
            const unit=scene.spawnUnit(team,'axe',44+index*3,88);unit.slideOff=0;
        }
        const worker=scene.spawnUnit('red','worker',53,87);worker.slideOff=0;
        const tower=scene.territory.camps.createBuilding('red','tower',null,true,{gx:58,gy:84});
        scene.rebuildSpatial();ui.campControls.reset();ui.campControls.pinned=true;
        scene.cameras.main.setZoom(1.25);
        const center=scene.groundPoint(50,84);scene.cameras.main.centerOn(center.x,center.y);
        ui.updateTerritoryHUD();ui.campControls.update();
        const samples=[];
        for(const team of ['red','blue','black']) for(const clip of ['walk','attack']) {
            const texture=scene.textures.get(`assets/units/anim/${team}_axe_${clip}`);
            const image=texture.getSourceImage(),ctx=image.getContext('2d');
            const frames=[];
            for(let frame=0;frame<4;frame++) {
                const pixels=ctx.getImageData(frame*158,0,158,156).data;let visible=0,bright=0;
                for(let i=0;i<pixels.length;i+=4) if(pixels[i+3]>128) {visible++;if(pixels[i]+pixels[i+1]+pixels[i+2]>600)bright++;}
                frames.push({visible,bright});
            }
            samples.push({team,clip,width:image.width,height:image.height,frames});
        }
        return {worker:worker.id,tower:tower.id,samples};
    });
    await page.waitForFunction(()=>!window.UI.scene.terrainLoading);
    await page.waitForTimeout(400);
    await page.screenshot({path:'/tmp/ui-shot-4-black-axe-entities.png'});
    await page.click(`#camp-control-bar [data-worker="${fixture.worker}"]`);
    await page.click('#camp-control-bar [data-camp-action="tower"]');
    const screenPoint=async(gx,gy)=>page.evaluate(({gx,gy})=>{
        const s=window.UI.scene,c=s.cameras.main,p=s.groundPoint(gx,gy),a=c.getWorldPoint(0,0);
        return {x:(p.x-a.x)*c.zoom,y:(p.y-a.y)*c.zoom};
    },{gx,gy});
    const valid=await screenPoint(55,81);
    await page.mouse.move(valid.x,valid.y);await page.waitForTimeout(400);
    await page.screenshot({path:'/tmp/ui-shot-5-tower-green-preview.png'});
    const green=await page.locator('#command-prompt-text').textContent();
    const blocked=await screenPoint(58,84);
    await page.mouse.move(blocked.x,blocked.y);await page.waitForTimeout(400);
    await page.screenshot({path:'/tmp/ui-shot-6-tower-red-preview.png'});
    const red=await page.locator('#command-prompt-text').textContent();
    await page.keyboard.press('Escape');
    const canceled=await page.evaluate(()=>window.UI.campControls.targeting===null);
    await page.mouse.click(blocked.x,blocked.y-36);
    await page.waitForTimeout(400);
    await page.screenshot({path:'/tmp/ui-shot-7-tower-1200-panel.png'});
    const panel=await page.locator('#camp-control-bar').textContent();
    console.log('gameplay-fixture:',JSON.stringify({samples:fixture.samples,green,red,canceled,panel,pageerrors:errors}));
    if (!green.includes('可建') || !red.includes('距离太近') || !canceled || !panel.includes('1200/1200') || errors.length) process.exitCode=1;
}
await browser.close();

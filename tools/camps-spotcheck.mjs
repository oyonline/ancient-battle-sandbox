// Reproducible browser acceptance: real controls, canvas picks and fixed-step simulation.
// Start npm run arena, then VERIFY_URL=http://127.0.0.1:5300/ node tools/camps-spotcheck.mjs.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const executablePath = [1228, 1208].map(version => path.join(homedir(),
    `Library/Caches/ms-playwright/chromium-${version}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)).find(existsSync);
assert.ok(executablePath, '未找到本机缓存 Chromium');
const url = process.env.VERIFY_URL || 'http://127.0.0.1:5300/';
const evidence = path.resolve('.omc/evidence/camps-development');
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
function check(name, ok, detail) {
    checks.push({ name, ok: !!ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' · ' + JSON.stringify(detail) : ''}`);
    assert.ok(ok, name);
}

async function focus(point, zoom = 0.85) {
    await page.evaluate(({ point, zoom }) => {
        const scene = UI.scene, p = scene.groundPoint(point.gx, point.gy);
        scene.cameras.main.setZoom(zoom).centerOn(p.x, p.y + 320);
    }, { point, zoom });
    await page.waitForTimeout(150); // Allow two rendering frames and camera preRender.
}

async function clickGround(point, lift = 0) {
    const screen = await page.evaluate(({ point, lift }) => {
        const scene = UI.scene, cam = scene.cameras.main;
        const world = scene.groundPoint(point.gx, point.gy);
        const pixel = cam.matrix.transformPoint(world.x - cam.scrollX, world.y - lift - cam.scrollY);
        const rect = scene.game.canvas.getBoundingClientRect();
        return { x: rect.left + pixel.x * rect.width / scene.scale.width,
            y: rect.top + pixel.y * rect.height / scene.scale.height };
    }, { point, lift });
    await page.mouse.click(screen.x, screen.y);
    await page.waitForTimeout(80);
}

async function steps(seconds) {
    await page.evaluate(seconds => {
        const scene = UI.scene;
        for (let step = 0; step < Math.ceil(seconds * 60); step++) {
            assertRunning();
            scene.simulationTime += 1000 / 60;
            scene.stepBattle(1 / 60);
        }
        scene.render.camps.update();
        UI.updateCounts();
        UI.campControls.update();
        function assertRunning() { if (scene.battleOver) throw new Error('定点验收提前终局'); }
    }, seconds);
    await page.waitForTimeout(100);
}

try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.UI?.scene && window.UI.phase === 'home');
    await page.click('[data-territory-entry]');
    await page.waitForFunction(() => UI.phase === 'ready' && UI.scene.units.length > 0, null, { timeout: 30000 });
    await page.waitForTimeout(150);
    const initialCamp = await page.evaluate(() => {
        const scene = UI.scene, cam = scene.cameras.main;
        const camp = scene.territory.camps.getBuilding('camp:red:home');
        const p = scene.groundPoint(camp.gx, camp.gy);
        const screen = cam.matrix.transformPoint(p.x - cam.scrollX, p.y - 60 - cam.scrollY);
        return { x: screen.x, y: screen.y, width: scene.scale.width, height: scene.scale.height };
    });
    check('领土初始镜头可见己方大本营', initialCamp.x > 0 && initialCamp.x < initialCamp.width &&
        initialCamp.y > 52 && initialCamp.y < initialCamp.height, initialCamp);
    const far = await page.evaluate(() => {
        const unit = UI.scene.units.find(u => u.team === 'blue' && u.type === 'infantry');
        unit.spr.setPosition(-999, -999); // A stale offscreen visual must be repaired by rendering.
        return { id: unit.id, gx: unit.gx, gy: unit.gy };
    });
    await focus(far);
    const readyView = await page.evaluate(id => {
        const u = UI.scene.units.find(u => u.id === id);
        const p = UI.scene.groundPoint(u.gx, u.gy);
        return { visible: u.spr.visible, diffX: Math.abs(u.spr.x - p.x),
            spr: { x: u.spr.x, y: u.spr.y }, ground: p, view: UI.scene._view };
    }, far.id);
    check('准备阶段移镜头到原离屏单位后精灵刷新', readyView.visible && readyView.diffX < 160 &&
        Math.abs(readyView.spr.y - readyView.ground.y) < 40, readyView);
    await page.click('#btn-start');
    await page.waitForFunction(() => UI.phase === 'battle' && !UI.countdown && UI.scene.battleStarted,
        null, { timeout: 15000 });
    await page.click('#btn-pause');
    if (!await page.evaluate(() => document.getElementById('controlbar').classList.contains('collapsed'))) {
        await page.click('#btn-hud-collapse');
    }
    const compactHud = await page.evaluate(() => {
        const bar = document.getElementById('controlbar');
        return { collapsed: bar.classList.contains('collapsed'), height: bar.getBoundingClientRect().height,
            width: bar.getBoundingClientRect().width };
    });
    check('桌面折叠HUD保留操作且高度不超过350px', compactHud.collapsed && compactHud.height <= 350, compactHud);
    await focus({ gx: 20, gy: 90 });
    await page.evaluate(id => UI.scene.units.find(u => u.id === id).spr.setPosition(-999, -999), far.id);
    await focus(far);
    check('暂停阶段移镜头仍刷新原离屏单位', await page.evaluate(id => {
        const u = UI.scene.units.find(u => u.id === id);
        return UI.scene.paused && u.spr.visible && Math.abs(u.spr.x - UI.scene.groundPoint(u.gx, u.gy).x) < 160;
    }, far.id));
    const fixture = await page.evaluate(() => {
        const scene = UI.scene, camps = scene.territory.camps;
        scene.territory.autoBuy = { red: false, blue: false };
        scene.territory.econ.treasury.red = 1000;
        for (const b of scene.battalions.battalions) {
            const members = b.aliveMembers();
            const x = members.reduce((n, u) => n + u.gx, 0) / members.length;
            const y = members.reduce((n, u) => n + u.gy, 0) / members.length;
            scene.battalions.orderHold(b, x, y);
        }
        const site = scene.flags.findIndex(f => f.owner === 'red');
        const camp = camps.placement('red', 'camp', site), tower = camps.placement('red', 'tower', site);
        const worker = scene.units.find(u => u.team === 'red' && u.type === 'worker');
        Object.assign(worker, camp, { pgx: camp.gx, pgy: camp.gy });
        UI.updateCounts();
        return { site, worker: worker.id, camp, tower, flag: { gx: scene.flags[site].gx, gy: scene.flags[site].gy } };
    });
    await focus(fixture.flag);
    await page.click(`#camp-control-bar [data-worker="${fixture.worker}"]`);
    await page.click('#camp-control-bar [data-camp-action="camp"]');
    await clickGround(fixture.flag);
    const started = await page.evaluate(site => {
        const c = UI.scene.territory.camps.getBuilding(`camp:red:${site}`);
        return c && { progress: c.progress, complete: c.complete, worker: c.workerId, spent: UI.scene.territory.econ.spent.red };
    }, fixture.site);
    check('民夫按钮→筑寨→画布据点点击真实开工', started?.worker === fixture.worker && !started.complete && started.spent === 160, started);
    await steps(18.1);
    check('18秒真实施工流水线完成营寨', await page.evaluate(site =>
        UI.scene.territory.camps.getBuilding(`camp:red:${site}`).complete, fixture.site));
    await page.click('#camp-control-bar [data-camp-action="tower"]');
    await clickGround(fixture.camp, 70);
    check('点完工营寨实际创建箭塔施工任务', await page.evaluate(site =>
        !!UI.scene.territory.camps.getBuilding(`tower:red:${site}`)?.workerId, fixture.site));
    await steps(16.5); // Includes the worker walking from the hall to the tower.
    check('民夫走到箭塔再完成14秒施工', await page.evaluate(site => {
        const b = UI.scene.territory.camps.getBuilding(`tower:red:${site}`);
        return b.complete && UI.scene.territory.econ.spent.red === 280;
    }, fixture.site));
    const crewFixture = await page.evaluate(({ site, tower }) => {
        const scene = UI.scene;
        const battalion = scene.battalions.battalions.find(b => b.team === 'red' && b.aliveMembers().some(u => u.type === 'archer'));
        const archers = battalion.aliveMembers().filter(u => u.type === 'archer').slice(0, 4);
        for (let i = 0; i < archers.length; i++) Object.assign(archers[i], {
            gx: tower.gx - 3, gy: tower.gy + (i - 1) * 0.8,
            pgx: tower.gx - 3, pgy: tower.gy + (i - 1) * 0.8
        });
        const enemy = scene.spawnUnit('blue', 'worker', tower.gx - 10, tower.gy - 2);
        enemy.hp = enemy.maxHp = 5000;
        scene.rebuildSpatial();
        return { battalion: battalion.id, archers: archers.map(u => u.id), enemy: enemy.id, hp: enemy.hp, site };
    }, fixture);
    await page.click(`#battalion-orders [data-bid="${crewFixture.battalion}"]`);
    await page.click('#camp-control-bar [data-camp-action="garrison"]');
    await clickGround(fixture.tower, 90);
    check('营队驻塔按钮下令后真实弓手开始走向箭塔', await page.evaluate(({ site, ids }) => {
        const b = UI.scene.territory.camps.getBuilding(`tower:red:${site}`);
        return ids.every(id => UI.scene.units.find(u => u.id === id).garrisonOrderId === b.id) && b.garrisonIds.length === 0;
    }, { site: fixture.site, ids: crewFixture.archers }));
    await steps(4);
    const staffed = await page.evaluate(({ site, enemy }) => {
        const scene = UI.scene, b = scene.territory.camps.getBuilding(`tower:red:${site}`);
        const view = scene.render.camps.views.get(b.id);
        return { ids: b.garrisonIds, label: view.label.text, hp: scene.units.find(u => u.id === enemy).hp,
            aboveGround: b.garrisonIds.every(id => scene.units.find(u => u.id === id).garrisonHeight === 82) };
    }, { site: fixture.site, enemy: crewFixture.enemy });
    check('塔标签与真实驻军一致，真实箭落地伤敌', staffed.ids.length === crewFixture.archers.length &&
        staffed.aboveGround && staffed.label.includes(`${staffed.ids.length}/4`) && staffed.hp < crewFixture.hp, staffed);
    await clickGround(fixture.tower, 90);
    await page.screenshot({ path: path.join(evidence, 'camps-browser-staffed.png') });
    await page.click('#camp-control-bar [data-camp-action="exit"]');
    check('选塔出塔按钮使驻军回到地面', await page.evaluate(({ site, ids }) => {
        const scene = UI.scene, b = scene.territory.camps.getBuilding(`tower:red:${site}`);
        return b.garrisonIds.length === 0 && ids.every(id => {
            const u = scene.units.find(u => u.id === id);
            return !u.garrisonTowerId && u.garrisonHeight === 0;
        });
    }, { site: fixture.site, ids: crewFixture.archers }));
    await page.evaluate(site => {
        const scene = UI.scene, b = scene.territory.camps.getBuilding(`tower:red:${site}`);
        const source = scene.units.find(u => u.team === 'blue' && !u.dead);
        scene.territory.camps.damageBuilding(b, b.hp, source);
        scene.render.camps.update();
        scene.unitInspector.selected = null;
        scene.selectedBattalion = null;
        UI.campControls.reset(); UI.campControls.update();
    }, fixture.site);
    await page.click(`#camp-control-bar [data-worker="${fixture.worker}"]`);
    await page.click('#camp-control-bar [data-camp-action="tower"]');
    await clickGround(fixture.flag);
    await steps(14.1);
    await clickGround(fixture.tower, 90);
    const rebuilt = await page.evaluate(site => {
        const scene = UI.scene, b = scene.territory.camps.getBuilding(`tower:red:${site}`);
        const view = scene.render.camps.views.get(b.id);
        const p = scene.groundPoint(b.gx, b.gy);
        return { complete: b.complete, picked: scene.render.camps.pick(p.x, p.y - 90) === b,
            viewMatches: view.building === b, selected: UI.campControls.buildingId === b.id,
            label: view.label.text, spent: scene.territory.econ.spent.red };
    }, fixture.site);
    check('毁塔后真实重建，画布拾取与标签指向新建筑', rebuilt.complete && rebuilt.picked && rebuilt.viewMatches &&
        rebuilt.selected && rebuilt.label.includes('0/4') && rebuilt.spent === 400, rebuilt);
    await page.screenshot({ path: path.join(evidence, 'camps-browser-rebuilt.png') });
    check('零页面报错', errors.length === 0, errors);
} catch (error) {
    checks.push({ name: '验收异常', ok: false, detail: error.message });
    console.error(error.stack);
    await page.screenshot({ path: path.join(evidence, 'camps-browser-failure.png') }).catch(() => {});
} finally {
    writeFileSync(path.join(evidence, 'camps-browser.json'), JSON.stringify({ url, checks, errors }, null, 2));
    await browser.close();
}
process.exitCode = checks.every(check => check.ok) ? 0 : 1;

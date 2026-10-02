// 本轮玩法增强的桌面浏览器验收：真实 DOM 操作 + 画布点选 + 定步长模拟。
// 覆盖：民夫施工/自卫/续工、弓手驻塔发现性与全流程、据点特色的占领与失效。
// review-fixes 增补：渡口行军加速定位为【冒烟】（真实位移方向性验证；精确 0.70→0.85
// 倍率由隔离移动测试证明）、大本营施工倍率观测真实施工进度、夺旗列表在可见面板中读取、
// 渡口"丢一座仍保留"与"再次失守仍播报"的易主提示。
// 用法：npm run build 后起 node server/arena.mjs（默认 5300，可用 PORT 覆盖），
// 再 VERIFY_URL=http://127.0.0.1:5301/ node tools/site-traits-spotcheck.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const executablePath = [1228, 1208].map(version => path.join(homedir(),
    `Library/Caches/ms-playwright/chromium-${version}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)).find(existsSync);
assert.ok(executablePath, '未找到本机缓存 Chromium');
const url = process.env.VERIFY_URL || 'http://127.0.0.1:5301/';
const evidence = path.resolve('.omc/evidence/site-traits');
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

async function focus(point, zoom = 0.9) {
    await page.evaluate(({ point, zoom }) => {
        const scene = UI.scene, p = scene.groundPoint(point.gx, point.gy);
        scene.cameras.main.setZoom(zoom).centerOn(p.x, p.y + 260);
    }, { point, zoom });
    await page.waitForTimeout(150);
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

// 定步长推进（暂停真实循环，保证验收可复现），结束后刷新 UI 面板。

// 定步长验收会跳过真实渲染帧：短暂恢复真实循环，让旗标/列表按正常帧路径刷新，
// 再暂停继续定点测量（"界面与真实效果对应"这条要求必须走真实刷新路径验证）。
async function liveFrames(ms = 600) {
    await page.click('#btn-pause');
    await page.waitForTimeout(ms);
    await page.click('#btn-pause');
    await page.waitForTimeout(80);
}

async function steps(seconds, refresh = true) {
    await page.evaluate(({ seconds, refresh }) => {
        const scene = UI.scene;
        for (let step = 0; step < Math.ceil(seconds * 60); step++) {
            if (scene.battleOver) throw new Error('定点验收提前终局');
            scene.simulationTime += 1000 / 60;
            scene.stepBattle(1 / 60);
        }
        if (refresh) { scene.render.camps.update(); UI.updateCounts(); UI.campControls.update(); }
    }, { seconds, refresh });
    await page.waitForTimeout(80);
}

try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.UI?.scene && UI.phase === 'home', null, { timeout: 30000 });
    await page.click('[data-territory-entry]');
    await page.waitForFunction(() => UI.phase === 'ready' && UI.scene.units.length > 0, null, { timeout: 30000 });
    await page.click('#btn-start');
    await page.waitForFunction(() => UI.phase === 'battle' && !UI.countdown && UI.scene.battleStarted, null, { timeout: 20000 });
    await page.click('#btn-pause');
    check('桌面窗口进入领土战斗且无报错', errors.length === 0, errors[0] || '');

    // ---------------- 1. 民夫：施工 → 敌军贴身 → 自卫 + 停工 → 脱战续工 ----------------
    const fixture = await page.evaluate(() => {
        const scene = UI.scene, camps = scene.territory.camps;
        scene.territory.autoBuy = { red: false, blue: false };
        scene.territory.econ.treasury.red = 2000;
        for (const b of scene.battalions.battalions) {
            const members = b.aliveMembers();
            if (!members.length) continue;
            scene.battalions.orderHold(b, members.reduce((n, u) => n + u.gx, 0) / members.length,
                members.reduce((n, u) => n + u.gy, 0) / members.length);
        }
        // 用没有营建奖励的西桥头做基线：施工速度不受林口影响。
        const site = scene.flags.findIndex(f => f.role === 'bridge' && f.owner === 'red');
        const place = camps.placement('red', 'camp', site);
        const worker = scene.units.find(u => u.team === 'red' && u.type === 'worker');
        Object.assign(worker, place, { pgx: place.gx, pgy: place.gy });
        UI.updateCounts();
        return { site, worker: worker.id, flag: { gx: scene.flags[site].gx, gy: scene.flags[site].gy } };
    });
    await focus(fixture.flag);
    await page.click('#btn-camp-open');
    await page.click(`#camp-control-bar [data-worker="${fixture.worker}"]`);
    await page.click('#camp-control-bar [data-camp-action="camp"]');
    await clickGround(fixture.flag);
    await steps(2);
    const building = await page.evaluate(site => {
        const b = UI.scene.territory.camps.getBuilding(`camp:red:${site}`);
        return { progress: b.progress, paused: b.paused, id: b.id, buildMs: UI.scene.territory.camps.buildInfo('camp').buildMs };
    }, fixture.site);
    // 西桥头无营建奖励：真实施工进度 = 时长/工期（×1.0 基准），
    // 与 3a) 林口的 1.25/工期构成"施工倍率"的真实对照。
    check('民夫点选→筑寨→画布点据点真实开工（基础速率：2 秒推进 2/工期）',
        building.progress > 0 && !building.paused &&
        Math.abs(building.progress - 2000 / building.buildMs) < 2e-3, building);
    await page.screenshot({ path: path.join(evidence, '1-worker-building.png') });

    const brawl = await page.evaluate(({ site }) => {
        const scene = UI.scene;
        const b = scene.territory.camps.getBuilding(`camp:red:${site}`);
        const worker = scene.units.find(u => u.id === scene.territory.camps.getBuilding(`camp:red:${site}`).workerId);
        // 贴身近战敌（弓手会风筝后退，验不到"贴着打"的持续交战）；双方都给耐久，
        // 让 2 秒窗口只测量"出手 vs 施工"两件事（同 camps-spotcheck 的耐久夹具口径）。
        const enemy = scene.spawnUnit('blue', 'infantry', b.gx + 0.6, b.gy);
        enemy.hp = enemy.maxHp = 100000;
        worker.hp = worker.maxHp = 100000;
        scene.rebuildSpatial();
        scene.unitInspector.selected = worker;
        UI.updateCounts(); UI.campControls.update();
        return { worker: worker.id, enemy: enemy.id, hp: enemy.hp, progress: b.progress };
    }, fixture);
    await steps(2.2);
    const engaged = await page.evaluate(({ site, enemy }) => {
        const scene = UI.scene, b = scene.territory.camps.getBuilding(`camp:red:${site}`);
        return { hp: scene.units.find(u => u.id === enemy).hp, progress: b.progress, paused: b.paused,
            inspector: document.getElementById('unit-inspector').innerHTML };
    }, { site: fixture.site, enemy: brawl.enemy });
    check('民夫真实出手：贴身敌军掉血', engaged.hp < brawl.hp, { before: brawl.hp, after: engaged.hp });
    check('交战期间施工冻结（进度不涨、面板显示停工）',
        Math.abs(engaged.progress - brawl.progress) < 1e-9 && engaged.paused === true,
        { before: brawl.progress, after: engaged.progress, paused: engaged.paused });
    await page.screenshot({ path: path.join(evidence, '2-worker-self-defense.png') });

    await page.evaluate(enemy => {
        const u = UI.scene.units.find(x => x.id === enemy);
        Object.assign(u, { gx: u.gx + 20, pgx: u.gx + 20 });    // 远到窗口内回不来，验"脱战"
        UI.scene.rebuildSpatial();
    }, brawl.enemy);
    await steps(2.2);
    const resumed = await page.evaluate(({ site, enemy }) => {
        const scene = UI.scene, b = scene.territory.camps.getBuilding(`camp:red:${site}`);
        return { hp: scene.units.find(u => u.id === enemy).hp, progress: b.progress, paused: b.paused,
            task: scene.units.find(u => u.id === b.workerId || u.type === 'worker' && u.team === 'red')?.workerTask?.kind };
    }, { site: fixture.site, enemy: brawl.enemy });
    check('脱战续工：进度从原值继续，远处敌人不再挨打',
        resumed.progress > engaged.progress && resumed.paused === false && resumed.hp === engaged.hp,
        { resumed: resumed.progress, paused: resumed.paused, enemyHp: resumed.hp });

    // ---------------- 2. 弓手驻塔：发现性 → 入驻 → 射击 → 出塔 ----------------
    const garrisonFixture = await page.evaluate(() => {
        const scene = UI.scene, camps = scene.territory.camps;
        const site = scene.flags.findIndex(f => f.role === 'forest' && f.owner === 'red');
        const tower = camps.createBuilding('red', 'tower', site, true);
        camps.createBuilding('red', 'camp', site, true);
        // 取弓手最多的己方营，保证"整营下令"这条路径有多人可验。
        const battalion = scene.battalions.battalions.filter(b => b.team === 'red')
            .sort((a, b) => b.aliveMembers().filter(u => u.type === 'archer').length -
                a.aliveMembers().filter(u => u.type === 'archer').length)[0];
        const archers = battalion.aliveMembers().filter(u => u.type === 'archer').slice(0, 3);
        archers.forEach((u, i) => Object.assign(u, { gx: tower.gx - 2.5, gy: tower.gy + (i - 1) * 0.7,
            pgx: tower.gx - 2.5, pgy: tower.gy + (i - 1) * 0.7 }));
        scene.rebuildSpatial();
        UI.updateCounts(); UI.campControls.update();
        return { site, tower: { gx: tower.gx, gy: tower.gy }, battalion: battalion.id, archers: archers.map(u => u.id) };
    });
    await focus(garrisonFixture.tower);
    // 建设面板打开时营队条按布局被隐藏：先收起，再走"选营 → 建筑行动"的正式入口。
    await page.click('#camp-control-bar [data-camp-action="close"]').catch(() => {});
    await page.waitForTimeout(150);
    await page.click(`#battalion-picker [data-bid="${garrisonFixture.battalion}"]`);
    await page.click('#order-building');
    await steps(0.2, false);
    const armed = await page.evaluate(({ site }) => {
        const scene = UI.scene, b = scene.territory.camps.getBuilding(`tower:red:${site}`);
        const view = scene.render.camps.views.get(b.id);
        return { label: view.label.text, highlighted: /:1$/.test(view.signature || ''), side: scene.render.camps.side };
    }, garrisonFixture);
    check('选中含弓手的营后，己方完工空塔显示驻军读数并高亮',
        armed.label.includes('弓手 0/4') && armed.highlighted === true, armed);
    await page.screenshot({ path: path.join(evidence, '3-tower-highlight.png') });

    await page.click('#camp-control-bar [data-camp-action="garrison"]');
    await clickGround(garrisonFixture.tower, 90);
    await page.waitForTimeout(150);        // 让真实渲染帧刷新塔标签（驻军读数含预约）
    const ordered = await page.evaluate(({ site, archers }) => {
        const scene = UI.scene, b = scene.territory.camps.getBuilding(`tower:red:${site}`);
        scene.render.camps.update();       // 渲染入口本身就是验收对象，显式跑一帧避免读旧值
        const view = scene.render.camps.views.get(b.id);
        return { ordered: archers.every(id => scene.units.find(u => u.id === id).garrisonOrderId === b.id),
            toast: document.getElementById('action-toast').textContent, label: view.label.text };
    }, garrisonFixture);
    check('下令后提示"正在前往箭塔"并显示在途预约',
        ordered.ordered && ordered.toast.includes('正在前往箭塔') && ordered.label.includes('前往中'), ordered);
    await steps(3);
    const staffed = await page.evaluate(({ site, archers }) => {
        const scene = UI.scene, b = scene.territory.camps.getBuilding(`tower:red:${site}`);
        const view = scene.render.camps.views.get(b.id);
        const inside = b.garrisonIds.length;
        scene.unitInspector.selected = scene.units.find(u => u.id === archers[0]);
        scene.unitInspector.update(true);
        return { inside, label: view.label.text, height: scene.units.find(u => u.id === archers[0]).garrisonHeight,
            inspector: document.getElementById('unit-inspector').innerHTML };
    }, garrisonFixture);
    check('到塔后真实入驻：塔标签 N/4、单位信息显示"驻塔中"',
        staffed.inside === garrisonFixture.archers.length && staffed.inside >= 2 &&
        staffed.label.includes(`弓手 ${staffed.inside}/4`) && staffed.height === 82 &&
        staffed.inspector.includes('驻塔中'),
        { inside: staffed.inside, label: staffed.label, ordered: garrisonFixture.archers.length });
    const shooting = await page.evaluate(({ site }) => {
        const scene = UI.scene, b = scene.territory.camps.getBuilding(`tower:red:${site}`);
        const enemy = scene.spawnUnit('blue', 'infantry', b.gx + 9, b.gy);
        enemy.hp = enemy.maxHp = 100000;
        scene.rebuildSpatial();
        return { id: enemy.id, hp: enemy.hp };
    }, garrisonFixture);
    await steps(3);
    const shot = await page.evaluate(id => UI.scene.units.find(u => u.id === id).hp, shooting.id);
    check('塔上弓手按自身冷却真实射击（14 格内箭矢落地伤敌）', shot < shooting.hp, { before: shooting.hp, after: shot });
    await page.screenshot({ path: path.join(evidence, '4-tower-staffed.png') });

    await clickGround(garrisonFixture.tower, 90);
    const exitPanel = await page.evaluate(() => document.getElementById('camp-control-bar').innerHTML);
    check('选中箭塔后面板提供"弓手出塔"', exitPanel.includes('弓手出塔'));
    await page.click('#camp-control-bar [data-camp-action="exit"]');
    check('出塔后驻军回到地面', await page.evaluate(({ site, archers }) => {
        const scene = UI.scene, b = scene.territory.camps.getBuilding(`tower:red:${site}`);
        return b.garrisonIds.length === 0 && archers.every(id => {
            const u = scene.units.find(x => x.id === id);
            return !u.garrisonTowerId && u.garrisonHeight === 0;
        });
    }, garrisonFixture));

    // ---------------- 3. 据点特色：界面与真实效果同步 ----------------
    // 夺旗列表只在选中营队时可见：先走真实选择入口再读行文字（验收来自可见面板）。
    const listBattalion = await page.evaluate(() => UI.myBattalions()[0]?.id);
    await page.click(`#battalion-picker [data-bid="${listBattalion}"]`);
    await steps(0.2, false);
    const traits = await page.evaluate(() => {
        const scene = UI.scene;
        const label = id => scene.render.overlay.flagLabels?.[id]?.text || '';
        const forest = scene.flags.findIndex(f => f.role === 'forest' && f.owner === 'red');
        const bridge = scene.flags.findIndex(f => f.role === 'bridge' && f.owner === 'red');
        const rows = [...document.querySelectorAll('#battalion-flags .order-btn')].map(b => b.textContent);
        const listVisible = !document.getElementById('battalion-flags').hidden;
        return {
            forest, bridge, listVisible, rows,
            forestLabel: label(forest), bridgeLabel: label(bridge),
            hillLabel: label(scene.flags.findIndex(f => f.role === 'hill')),
            homeCapacity: scene.territory.healing.capacity('red', 'home')
        };
    });
    check('夺旗列表在可见面板中显示归属与特色奖励',
        traits.listVisible === true &&
        traits.rows.some(row => row.includes('🔴红方') && row.includes('施工时间 −20%')),
        traits.rows.filter(row => row.includes('林口')));
    check('旗标区分"地形原有"与"占领奖励"并写明归属',
        traits.forestLabel.includes('地形：') && traits.forestLabel.includes('占领：红方') &&
        traits.hillLabel.includes('地形：'), { forest: traits.forestLabel.split('\n') });
    check('大本营没有旗点奖励（伤兵收容为基础容量 8）', traits.homeCapacity === 8, traits.homeCapacity);

    // 3a-0) 大本营施工倍率的真实口径：模拟层禁止在无旗位的大本营新建任何建筑
    //（requestBuild 对 siteId='home' 直接拒绝），因此不存在"大本营施工倍率"。
    // 无特色观测：① 新建被真实拒绝；② 真实建设面板不显示任何据点特色行。
    // 基础施工速率（×1.0）由第 1 节西桥头（无营建奖励）的真实施工进度精确断言。
    const homeCheck = await page.evaluate(() => {
        const scene = UI.scene, camps = scene.territory.camps;
        scene.territory.econ.treasury.red = 2000;
        const worker = scene.units.find(u => u.team === 'red' && u.type === 'worker' && !u.workerTask);
        const place = camps.placement('red', 'tent', 'home');
        const rejected = place && worker ? !camps.requestBuild('red', worker.id, 'tent', 'home') : null;
        UI.campControls.buildingId = 'camp:red:home';
        UI.campControls.update();
        return {
            rejected, capacity: scene.territory.healing.capacity('red', 'home'),
            panel: document.getElementById('camp-control-bar').innerHTML
        };
    });
    check('大本营不可新建且无特色：requestBuild 真实拒绝、面板无特色行',
        homeCheck.rejected === true && homeCheck.capacity === 8 &&
        !/林口|渡口|马场|桥头|路口|高地/.test(homeCheck.panel),
        { rejected: homeCheck.rejected, capacity: homeCheck.capacity });

    // 3a) 林口营建：同点再起一座未完工建筑（该点营寨/箭塔此前已建成），1 秒应推进 1.25/工期。
    const forestBuild = await page.evaluate(({ site }) => {
        const scene = UI.scene, camps = scene.territory.camps;
        scene.territory.econ.treasury.red = 2000;
        const worker = scene.units.find(u => u.team === 'red' && u.type === 'worker' && !u.workerTask);
        const place = camps.placement('red', 'tent', site);
        Object.assign(worker, place, { pgx: place.gx, pgy: place.gy });
        scene.rebuildSpatial();
        camps.requestBuild('red', worker.id, 'tent', site);
        const b = camps.getBuilding(`tent:red:${site}`);
        Object.assign(worker, { gx: b.gx, gy: b.gy });
        camps.update(1);
        const seconds = camps.buildInfo('tent').buildMs / 1000;
        return { progress: b.progress, expected: 1.25 / seconds, base: 1 / seconds, id: b.id, site };
    }, { site: traits.forest });
    check('林口真实生效：1 秒推进 1.25/工期（有效施工时间 −20%）',
        Math.abs(forestBuild.progress - forestBuild.expected) < 1e-9, forestBuild);
    await page.evaluate(() => { UI.scene.render.camps.update(); UI.updateCounts(); });
    await page.screenshot({ path: path.join(evidence, '5-forest-build.png') });

    // 3b) 桥头工事：蓝方真实攻击红方桥头箭塔。剑士近战对建筑 = max(1, 16-6) = 10，
    //     桥头减伤 −10% 后取整 = 9；失去据点后恢复 10。逐击测量，避免累计误差。
    const bridgeHit = await page.evaluate(({ site }) => {
        const scene = UI.scene, camps = scene.territory.camps;
        const tower = camps.createBuilding('red', 'tower', site, true);
        // 隔离测量：把塔附近的红方单位移开，否则蓝方会先跟人打而不是拆塔。
        for (const u of scene.units) {
            if (u.team === 'red' && Math.hypot(u.gx - tower.gx, u.gy - tower.gy) < 8) {
                Object.assign(u, { gx: 20, gy: 20, pgx: 20, pgy: 20 });
            }
        }
        const raider = scene.spawnUnit('blue', 'infantry', tower.gx + 1.2, tower.gy);
        raider.lastAttack = -10000;
        scene.rebuildSpatial();
        const owner = scene.flags[site].owner;
        let before = tower.hp, loss = 0;
        for (let i = 0; i < 240 && loss === 0; i++) {
            if (scene.battleOver) break;
            scene.simulationTime += 1000 / 60; scene.stepBattle(1 / 60);
            loss = before - tower.hp;
        }
        return { owner, loss, id: tower.id, raider: raider.id };
    }, { site: traits.bridge });
    check('桥头工事真实减伤：归属方建筑每击 10 → 9（−10% 后取整）',
        bridgeHit.owner === 'red' && bridgeHit.loss === 9, bridgeHit);

    const lost = await page.evaluate(({ site }) => {
        const scene = UI.scene, camps = scene.territory.camps;
        const flag = scene.flags[site];
        const tower = camps.getBuilding(`tower:red:${site}`);
        // 真实易主：蓝方部队站进旗圈把进度拉到 -1。
        flag.progress = -0.99; flag.owner = 'red';
        const point = { gx: flag.gx, gy: flag.gy };
        for (let i = 0; i < 9; i++) {
            const u = scene.spawnUnit('blue', 'infantry', point.gx + (i % 3) * 0.3, point.gy + Math.floor(i / 3) * 0.3);
            u.moraleState = 'steady';
        }
        scene.rebuildSpatial();
        for (let i = 0; i < 240 && flag.owner !== 'blue'; i++) {
            scene.simulationTime += 1000 / 60; scene.stepBattle(1 / 60);
        }
        scene.render.camps.update(); UI.updateCounts();
        return { owner: flag.owner, towerTeam: tower.team };
    }, { site: traits.bridge });
    await liveFrames();
    const lostUi = await page.evaluate(site => ({
        label: UI.scene.render.overlay.flagLabels?.[site]?.text || '',
        row: [...document.querySelectorAll('#battalion-flags .order-btn')][site]?.textContent || '',
        toast: document.getElementById('action-toast').textContent
    }), traits.bridge);
    check('真实易主：旗帜变蓝、旧箭塔仍属红方、界面读数同步',
        lost.owner === 'blue' && lost.towerTeam === 'red' && lostUi.label.includes('🔵') &&
        lostUi.toast.includes('西桥头'), { ...lost, ...lostUi });
    const afterLoss = await page.evaluate(({ site }) => {
        const scene = UI.scene, camps = scene.territory.camps;
        const tower = camps.getBuilding(`tower:red:${site}`);
        // 只留一名攻击者，其他人退开，保证测量的是同一条伤害链。
        const raiders = scene.units.filter(u => u.team === 'blue' && u.type === 'infantry' && !u.dead);
        const raider = raiders[0];
        for (const other of raiders.slice(1)) Object.assign(other, { gx: 240, gy: 20, pgx: 240, pgy: 20 });
        Object.assign(raider, { gx: tower.gx + 1.2, gy: tower.gy, pgx: tower.gx + 1.2, pgy: tower.gy });
        raider.lastAttack = -10000;
        scene.rebuildSpatial();
        let before = tower.hp, loss = 0;
        for (let i = 0; i < 240 && loss === 0; i++) {
            if (scene.battleOver) break;
            scene.simulationTime += 1000 / 60; scene.stepBattle(1 / 60);
            loss = before - tower.hp;
        }
        return { loss };
    }, { site: traits.bridge });
    check('失去桥头后按原伤害结算（每击 10）', afterLoss.loss === 10, afterLoss);

    // 3c) 渡口行军加速【冒烟】：真实移动逻辑 + 位移观测——占领渡口前后同构两次行军，
    //     占领后明显变快即通过。这不是精确倍率验收（同一战场连续测量、且行军受
    //     战场单位/路径影响）；0.70→0.85 的精确倍率由隔离移动测试证明
    //     （tests/site-traits.test.js『渡口：浅滩里真的走得更快』——真实 moveToward
    //     链路、绝对位移断言至 1e-12）。
    const fordMarch = await page.evaluate(() => {
        const scene = UI.scene;
        const ford = scene.flags.find(f => f.role === 'ford');
        const march = () => {
            const sx = 127, sy = 68;                     // 中央浅滩带上（西渡口与河心之间）
            const u = scene.spawnUnit('red', 'infantry', sx, sy);
            scene.battalions.splitOpening([u]);
            const bat = scene.battalions.battalions.find(b => b.aliveMembers().includes(u));
            scene.battalions.orderHold(bat, sx + 7, sy); // 沿浅滩向东亚军（远处敌军让行军逻辑保持活跃）
            scene.rebuildSpatial();
            for (let i = 0; i < 60; i++) { scene.simulationTime += 1000 / 60; scene.stepBattle(1 / 60); }
            return Math.hypot(u.gx - sx, u.gy - sy);
        };
        const before = march();                          // 尚无任何渡口：蹚水基准
        for (const f of scene.flags.filter(x => x.role === 'ford')) { f.owner = 'red'; f.progress = 1; }
        const after = march();                           // 拥有渡口
        return { before, after, ratio: after / before };
    });
    check('渡口行军加速冒烟：占领后同构行军明显变快（精确 0.70→0.85 见隔离移动测试）',
        fordMarch.before > 1 && fordMarch.after > fordMarch.before * 1.05 &&
        fordMarch.ratio < 1.45, fordMarch);

    // 3c-2) 渡口易主播报：红方两座在手，真丢一座时文案必须说"仍保留"，不能说"失效"；
    //       浅滩速度同样用真实位移复测（应与仍持渡口时一致，而不是按归属抄 0.85）。
    const fordLoss = await page.evaluate(() => {
        const scene = UI.scene;
        const west = scene.flags.find(f => f.role === 'ford' && f.name.startsWith('西'));
        const east = scene.flags.find(f => f.role === 'ford' && f.name.startsWith('东'));
        west.owner = 'red'; west.progress = 1;
        east.owner = 'red'; east.progress = 1;
        // 不清空战报数组：UI 播报游标按"已读条数"推进，清数组会破坏单调契约（非真实对局操作）。
        const seen = scene.ledger.events.length;
        // 蓝方部队真实拉旗把西渡口拉过中线（东渡口仍在红方手里）。
        for (let i = 0; i < 8; i++) {
            const u = scene.spawnUnit('blue', 'infantry', west.gx + (i % 3) * 0.3, west.gy + Math.floor(i / 3) * 0.3);
            u.moraleState = 'steady'; u.hp = u.maxHp = 100000;
        }
        scene.rebuildSpatial();
        for (let i = 0; i < 480 && west.owner !== null; i++) {
            scene.simulationTime += 1000 / 60; scene.stepBattle(1 / 60);
        }
        // 撤走蓝军后再测位移：拉旗部队不能干扰行军测量。
        for (const u of scene.units) {
            if (u.team === 'blue' && !u.dead && Math.hypot(u.gx - west.gx, u.gy - west.gy) < 8) {
                Object.assign(u, { gx: 10, gy: 12 });
            }
        }
        const sx = 127, sy = 68;
        const u = scene.spawnUnit('red', 'infantry', sx, sy);
        scene.battalions.splitOpening([u]);
        const bat = scene.battalions.battalions.find(b => b.aliveMembers().includes(u));
        scene.battalions.orderHold(bat, sx + 7, sy);
        scene.rebuildSpatial();
        for (let i = 0; i < 60; i++) { scene.simulationTime += 1000 / 60; scene.stepBattle(1 / 60); }
        return { westOwner: west.owner, eastOwner: east.owner,
            displacement: Math.hypot(u.gx - sx, u.gy - sy),
            texts: scene.ledger.events.slice(seen).filter(e => e.key.startsWith('trait-lost-')).map(e => e.text) };
    });
    await liveFrames();
    // liveFrames 的 250ms 计数限频可能把刷新推迟到读数之后：显式跑一次真实
    // 每帧 UI 入口（updateTerritoryHUD 是正常帧路径调用的同一方法）再读 toast。
    const fordLossUi = await page.evaluate(() => {
        UI.updateTerritoryHUD();
        return { toast: document.getElementById('action-toast').textContent };
    });
    check('丢一座渡口仍持另一座：播报"仍保留"，浅滩行军未减速（冒烟，同战场复测）',
        fordLoss.westOwner === null && fordLoss.eastOwner === 'red' &&
        fordLoss.texts.some(t => t.includes('仍保留') && !t.includes('失效')) &&
        fordLossUi.toast.includes('仍保留') &&
        Math.abs(fordLoss.displacement - fordMarch.after) / fordMarch.after < 0.1,
        { ...fordLoss, marchWithBoth: fordMarch.after, toast: fordLossUi.toast });

    // 3c-3) 渡口占领（真实拉旗）：归属变化即时播报，界面同步。
    const ford = await page.evaluate(() => {
        const scene = UI.scene;
        const index = scene.flags.findIndex(f => f.role === 'ford' && f.owner !== 'red');
        const flag = scene.flags[index];
        flag.progress = 0.98; flag.owner = null;
        const point = { gx: flag.gx, gy: flag.gy };
        for (let i = 0; i < 4; i++) {
            const u = scene.spawnUnit('red', 'infantry', point.gx + (i % 2) * 0.3, point.gy + Math.floor(i / 2) * 0.3);
            u.moraleState = 'steady';
        }
        scene.rebuildSpatial();
        for (let i = 0; i < 120 && flag.owner !== 'red'; i++) {
            scene.simulationTime += 1000 / 60; scene.stepBattle(1 / 60);
        }
        scene.render.camps.update(); UI.updateCounts();
        return { index, owner: flag.owner };
    });
    await liveFrames();
    // 夺旗列表只在选中营队时可见（未选营时整块隐藏）：按真实操作先选一个己方营再读行。
    const redBattalion = await page.evaluate(() => UI.myBattalions()[0]?.id);
    await page.click(`#battalion-picker [data-bid="${redBattalion}"]`);
    await steps(0.2, false);
    const fordUi = await page.evaluate(index => ({
        label: UI.scene.render.overlay.flagLabels?.[index]?.text || '',
        row: [...document.querySelectorAll('#battalion-flags .order-btn')][index]?.textContent || '',
        toast: document.getElementById('action-toast').textContent
    }), ford.index);
    check('占领渡口：归属变化即时播报，界面与奖励文案同步',
        ford.owner === 'red' && fordUi.label.includes('🔴') &&
        fordUi.row.includes('🔴红方') && fordUi.toast.includes('渡口'), { ...ford, ...fordUi });
    await page.screenshot({ path: path.join(evidence, '6-trait-capture.png') });

    // 3c-4) 同一据点再次失守仍要播报（战报事件 + UI toast 双通道）。
    //       把东渡口判给蓝方，红方只握被测的这座：每次失去都是真"丢光"，文案才是"失效"。
    const refordLoss = await page.evaluate(() => {
        const scene = UI.scene;
        const flag = scene.flags.find(f => f.role === 'ford' && f.owner === 'red');
        const east = scene.flags.find(f => f.role === 'ford' && f !== flag);
        east.owner = 'blue'; east.progress = -1;
        const seen = scene.ledger.events.length;   // 不清数组：UI 播报游标按已读条数单调推进
        const flood = team => {
            for (let i = 0; i < 8; i++) {
                const u = scene.spawnUnit(team, 'infantry', flag.gx + (i % 3) * 0.3, flag.gy + Math.floor(i / 3) * 0.3);
                u.moraleState = 'steady'; u.hp = u.maxHp = 100000;
            }
        };
        const clear = team => {
            for (const u of scene.units) {
                if (u.team === team && !u.dead && Math.hypot(u.gx - flag.gx, u.gy - flag.gy) < 8) {
                    Object.assign(u, { gx: team === 'blue' ? 250 : 10, gy: 12 });
                }
            }
            scene.rebuildSpatial();
        };
        const run = (team, until) => {
            flood(team); scene.rebuildSpatial();
            for (let i = 0; i < 480 && !until(); i++) { scene.simulationTime += 1000 / 60; scene.stepBattle(1 / 60); }
            clear(team);
        };
        run('blue', () => flag.owner === null);          // 第一次失去
        run('red', () => flag.owner === 'red');          // 收复
        run('blue', () => flag.owner === null);          // 再次失去
        const fresh = scene.ledger.events.slice(seen);
        return { owner: flag.owner,
            lost: fresh.filter(e => e.key.startsWith('trait-lost-')).length,
            regained: fresh.filter(e => e.key.startsWith('trait-') && !e.key.includes('lost')).length };
    });
    await liveFrames();
    const refordToast = await page.evaluate(() => document.getElementById('action-toast').textContent);
    check('同一据点再次失守仍播报：失去→收复→再失去 = 2 次失效 + 1 次生效',
        refordLoss.owner === null && refordLoss.lost === 2 && refordLoss.regained === 1 &&
        refordToast.includes('失效'), refordLoss);

    check('全流程零页面报错', errors.length === 0, errors[0] || '');
} catch (error) {
    checks.push({ name: '验收异常', ok: false, detail: error.message });
    console.error(error.stack);
    await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
} finally {
    writeFileSync(path.join(evidence, 'browser.json'), JSON.stringify({ url, checks, errors }, null, 2));
    await browser.close();
}
process.exitCode = checks.every(c => c.ok) ? 0 : 1;

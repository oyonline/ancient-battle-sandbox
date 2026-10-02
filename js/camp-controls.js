// Selection and targeting stay local; commands always enter the simulation API.
// 据点特色的文案与参数只从 js/battle/site-traits.js 取（模拟、AI、UI 同一份来源）。
import { describeTrait, ownsRole } from './battle/site-traits.js';
export class CampControls {
    constructor(ui) {
        this.ui = ui;
        this.workerId = null;
        this.buildingId = null;
        this.targeting = null;
        this.pinned = false;    // 「🧰 建设」固定展开（上下文弹出布局的显式入口）
        this.dismissedSelection = null;
        this.lastMarkup = '';
        this.panel = null;
    }

    get scene() { return this.ui.scene; }
    get side() { return this.ui.mySide || 'red'; }
    get camps() { return this.scene?.territory?.camps; }
    get active() {
        return this.ui.phase === 'battle' && !!this.camps && !this.scene.battleOver;
    }

    reset() {
        this.cancel();
        this.workerId = this.buildingId = null;
        this.pinned = false;
        this.dismissedSelection = null;
        this.lastMarkup = '';
        document.getElementById('btn-camp-open')?.classList?.remove('active');
        document.body.classList.remove('camp-panel-open');
        if (this.panel) { this.panel.hidden = true; this.panel.replaceChildren(); }
    }

    // 「🧰 建设」固定展开/收起：无选择时展开列出民夫列表，供玩家点选开工
    togglePin() {
        if (this.panel && !this.panel.hidden) { this.close(); return; }
        this.pinned = true;
        this.dismissedSelection = null;
        this.update();
    }

    selectionKey() {
        return `${this.workerId ?? ''}/${this.buildingId ?? ''}/${this.scene?.selectedBattalion?.id ?? ''}/${this.scene?.unitInspector?.selected?.id ?? ''}`;
    }

    close() {
        this.pinned = false;
        this.cancel();
        this.dismissedSelection = this.selectionKey();
        this.update();
    }

    cancel() {
        this.targeting = null;
        document.body.classList.remove('camp-targeting');
        this.ui.updateTargetingPrompt?.();
    }

    workers() {
        return (this.scene?.units || []).filter(u => u.team === this.side && u.type === 'worker' && !u.dead && !u.withdrawn);
    }

    selectedTroops() {
        const battalion = this.scene?.selectedBattalion;
        if (battalion?.team === this.side) return battalion.aliveMembers().filter(u => !u.garrisonTowerId);
        const unit = this.scene?.unitInspector?.selected;
        return unit?.team === this.side && !unit.dead && !unit.withdrawn && unit.type !== 'worker' ? [unit] : [];
    }

    begin(kind) {
        if (!this.active || this.ui.countdown) return;
        const worker = this.workers().find(u => u.id === this.workerId);
        const units = this.selectedTroops();
        if (['camp', 'tower', 'tent', 'move'].includes(kind) && !worker) return;
        if (kind === 'garrison' && !units.some(u => u.type === 'archer')) {
            // 入口今天只在有弓手时可用；仍要给"选了兵但没弓手"一个具体原因，而不是静默返回。
            this.ui.showNetToast(this.selectionRejectReason(units) || '选中的部队里没有可入驻的弓箭手：先选中弓手再点「驻入箭塔」');
            return;
        }
        if (kind === 'medic-in' && !units.some(u => u.type === 'medic')) return;
        if (kind === 'attack' && !units.length) return;
        this.ui.cancelHoldTargeting();
        this.ui.cancelRallyTargeting();
        this.targeting = { kind, worker: worker?.id,
            units: units.filter(u => (kind === 'garrison' ? u.type === 'archer' : kind === 'medic-in' ? u.type === 'medic' : true)).map(u => u.id) };
        document.body.classList.add('camp-targeting');
        const prompt = { camp: '点己方据点建营寨', tower: '点己方营寨据点建箭塔', tent: '点己方营寨据点建医帐',
            move: '点地面让民夫前往', garrison: '点己方完工箭塔，弓手将走过去入驻',
            'medic-in': '点己方完工医帐，医师将走过去入驻', attack: '点敌方建筑，部队将前往攻寨' }[kind];
        this.targeting.prompt = prompt;
        this.ui.updateTargetingPrompt?.();
        this.update();
    }

    send(command) {
        if (!this.active || this.ui.countdown) return false;
        command = { ...command, side: this.side };
        if (this.ui.battleOptions.net && this.scene.net) {
            this.scene.net.lockstep.act(command);
            this.ui.showNetToast('命令已发送，等待部队执行');
            return true;
        }
        const ok = this.scene.applyNetCommand(command);
        if (!ok) this.ui.showNetToast('无法执行：请检查归属、军费、施工条件或箭塔空位');
        return !!ok;
    }

    // 驻军能否受理只问模拟（同一口径，UI 不另写一套判定）。返回 null 表示可以。
    garrisonRejectReason(buildingId, unitIds) {
        return this.camps?.garrisonRejectReason?.(this.side, buildingId, unitIds) ?? null;
    }

    // "选择本身"的问题：拿一座己方完工且未满的箭塔当探针，此时模拟唯一可能返回的
    // 就是"选中部队里没有弓箭手"。没有这种箭塔时返回 null，由调用方给通用文案。
    selectionRejectReason(units) {
        const usable = b => b && b.team === this.side && b.type === 'tower' && b.complete && !b.dead &&
            this.camps?.garrisonStatus?.(b)?.full !== true;
        const probe = [this.camps?.getBuilding?.(this.buildingId), ...(this.camps?.buildings || [])].find(usable);
        return probe ? this.garrisonRejectReason(probe.id, units.map(u => u.id)) : null;
    }

    selectWorker(id) {
        const worker = this.workers().find(u => u.id === id);
        if (!worker) return;
        this.cancel();
        this.ui.cancelHoldTargeting();
        this.ui.cancelRallyTargeting();
        this.dismissedSelection = null;
        this.workerId = id;
        this.buildingId = null;
        this.scene.selectedBattalion = null;
        if (this.scene.unitInspector) this.scene.unitInspector.selected = worker;
        this.ui.showTerritoryTip?.('worker');
        this.update();
    }

    handleGroundClick(world, picked) {
        if (!this.active) return false;
        const building = this.scene.render.camps.pick(world.x, world.y);
        const mode = this.targeting;
        if (mode) {
            let accepted = false;
            if (mode.kind === 'move') {
                this.ui.applyGroundOrder(world, (gx, gy) => {
                    accepted = this.send({ k: 'worker-move', worker: mode.worker, gx, gy });
                });
            } else if (mode.kind === 'camp' || mode.kind === 'tower' || mode.kind === 'tent') {
                if (building?.team === this.side) {
                    accepted = this.send({ k: 'build', worker: mode.worker, kind: mode.kind, site: building.siteId });
                } else {
                    this.ui.applyGroundOrder(world, (gx, gy) => {
                        const flag = (this.scene.flags || []).map((f, index) => ({ f, index,
                            distance: Math.hypot(f.gx - gx, f.gy - gy) }))
                            .filter(p => p.f.owner === this.side && p.distance <= 6)
                            .sort((a, b) => a.distance - b.distance || a.index - b.index)[0];
                        if (flag) accepted = this.send({ k: 'build', worker: mode.worker, kind: mode.kind, site: flag.index });
                        else this.ui.showNetToast('选择已占领的据点；箭塔和医帐需要该点先有完工营寨');
                    });
                }
            } else if (mode.kind === 'medic-in') {
                if (building?.team === this.side && building.type === 'tent') {
                    accepted = this.send({ k: 'garrison', units: mode.units, building: building.id });
                } else this.ui.showNetToast('请点己方完工医帐');
            } else if (building) {
                if (mode.kind === 'garrison') {
                    const reason = this.garrisonRejectReason(building.id, mode.units);
                    // 拒绝不结束选点：玩家可以直接改点另一座塔，不用重新进一次入口。
                    if (reason) { this.ui.showNetToast(reason); this.update(); return true; }
                    // 提示人数只来自模拟的受理口径（与 orderGarrison 同一套过滤/容量规则），
                    // 溃逃、已驻塔、已预约本塔、重复 ID 的人不会被算进"正在前往"。
                    // 必须在 send() 之前读——下单后预约已计入容量，会算出 0。
                    const willAccept = this.camps.garrisonAcceptList(this.side, mode.units, building.id);
                    const net = !!(this.ui.battleOptions?.net && this.scene.net);
                    accepted = this.send({ k: 'garrison', units: mode.units, building: building.id });
                    if (accepted) {
                        // 联机只承诺"命令已发送"：入队时不预知对端到达时的塔容量，
                        // 不能把本地现在能受理的人数说成未来一定接受的人数。
                        this.ui.showNetToast(net
                            ? '命令已发送，等待部队执行；实际入驻以箭塔剩余容量为准'
                            : `🏹 ${willAccept.length} 名弓手正在前往箭塔`);
                    }
                } else accepted = this.send({ k: 'attack-building', units: mode.units, building: building.id });
            } else this.ui.showNetToast('请点箭塔或营寨建筑');
            if (accepted) this.cancel();
            this.update();
            return true;
        }
        if (this.ui.holdTargeting || this.ui.rallyTargeting) return false;
        if (picked?.team === this.side && picked.type === 'worker') {
            this.selectWorker(picked.id);
            return true;
        }
        if (building) {
            this.workerId = null;
            this.buildingId = building.id;
            this.scene.selectedBattalion = null;
            if (this.scene.unitInspector) this.scene.unitInspector.selected = null;
            this.dismissedSelection = null;
            this.update();
            return true;
        }
        this.workerId = this.buildingId = null;
        this.update();
        return false;
    }

    // 己方完工箭塔的驻军读数：塔内人数 + 还在路上的弓手（口径只来自模拟的 garrisonStatus）。
    // 塔还空着但已有人预约时直接说"弓手正在前往"，比一串 0/4 更能说明现场。
    towerGarrisonText(building, own) {
        const garrison = own && building.complete ? this.camps.garrisonStatus?.(building) : null;
        if (!garrison) return `${building.garrisonIds.length}/${this.camps.buildInfo('tower').capacity}`;
        return garrison.inside === 0 && garrison.reserved > 0
            ? `弓手 ${garrison.inside}/${garrison.capacity} · 弓手正在前往`
            : `弓手 ${garrison.label}`;
    }

    update() {
        if (!this.panel) {
            this.panel = document.getElementById('camp-control-bar');
            if (!this.panel) return;
            this.panel.addEventListener('click', event => {
                const button = event.target.closest('button');
                if (!button || button.disabled) return;
                if (button.dataset.worker) this.selectWorker(Number(button.dataset.worker));
                else if (button.dataset.campAction === 'close') {
                    this.close();
                }
                else if (button.dataset.campAction === 'exit') {
                    this.send({ k: 'ungarrison', building: this.buildingId });
                    this.update();
                } else if (button.dataset.campAction === 'cancel') { this.cancel(); this.update(); }
                else if (button.dataset.campAction === 'locate') {
                    const worker = this.workers().find(u => u.id === this.workerId);
                    const building = this.camps.getBuilding(this.buildingId);
                    const target = worker || building;
                    if (target) {
                        const p = this.scene.groundPoint(target.gx, target.gy);
                        this.scene.cameras.main.centerOn(p.x, p.y);
                    }
                } else this.begin(button.dataset.campAction);
            });
        }
        // 选民夫/建筑才自动打开。部队的驻塔/攻寨通过显式「建筑行动」入口进入。
        // 手动关闭对当前选择持续有效；隐藏时不遍历部队和施工候选。
        const dismissed = this.dismissedSelection === this.selectionKey();
        this.panel.hidden = !this.active || (!this.pinned && !this.targeting &&
            (dismissed || (!this.workerId && !this.buildingId)));
        document.body.classList.toggle?.('camp-panel-open', !this.panel.hidden);
        document.getElementById('btn-camp-open')?.classList?.toggle('active', this.pinned);
        if (!this.active) { this.cancel(); return; }
        if (this.panel.hidden) return;
        const workers = this.workers();
        const worker = workers.find(u => u.id === this.workerId);
        const building = this.camps.getBuilding(this.buildingId);
        if (this.workerId && !worker) { this.workerId = null; this.cancel(); }
        if (this.buildingId && (!building || building.dead)) this.buildingId = null;
        const troops = this.selectedTroops();
        const button = (action, label, disabled = false, title = '') =>
            `<button data-camp-action="${action}"${disabled ? ' disabled' : ''}${title ? ` title="${title}"` : ''}>${label}</button>`;
        let heading = '前线建设';
        let details = '选民夫筑寨 · 选弓手进塔 · 选医师入帐 · 选营队攻寨';
        let actions = '';
        if (worker) {
            heading = '🧰 民夫 ' + worker.id;
            details = worker.workerTask?.kind === 'build' ? '正在赶赴或建造；可另派民夫续建未完工建筑'
                : worker.workerTask?.kind === 'move' ? '前往指定位置' : '待命 · 无占旗能力，施工需要护卫';
            for (const kind of ['camp', 'tower', 'tent']) {
                const info = this.camps.buildInfo(kind);
                const resumable = this.camps.buildings.some(b => b.team === this.side && b.type === kind &&
                    !b.dead && !b.complete && this.camps.ownsSite(this.side, b.siteId) &&
                    (b.workerId === worker.id || !workers.some(w => w.id === b.workerId && w.moraleState !== 'routing')));
                actions += button(kind, `${kind === 'camp' ? '筑/续营寨' : kind === 'tower' ? '建/续箭塔' : '筑/续医帐'} ${info.cost}军费 · 续建免费`,
                    this.ui.countdown || (!resumable && this.scene.territory.econ.treasury[this.side] < info.cost));
            }
            actions += button('move', '移动民夫') + button('locate', '定位');
        } else if (building && !building.dead) {
            const own = building.team === this.side;
            const name = building.type === 'tower' ? '箭塔' : building.type === 'tent' ? '医帐'
                : building.siteId === 'home' ? '大本营' : '野外营寨';
            heading = (own ? '我方 · ' : '敌方 · ') + name;
            const state = building.complete ? `生命 ${Math.ceil(building.hp)}/${building.maxHp}`
                : `施工 ${Math.round(building.progress * 100)}% · 需民夫留在现场`;
            // 建筑状态先组装成正文，再追加据点特色——特色与状态必须同屏，
            // 不能让后写的 details = state 把刚拼好的特色行整个覆盖掉。
            details = state + (building.type === 'tower' ? ` · 驻军 ${this.towerGarrisonText(building, own)}`
                : building.type === 'tent' ? ` · 医师 ${building.garrisonIds.length}/${this.camps.buildInfo('tent').capacity} · 据点疗伤提速扩容` : '');
            // 据点详情：写清特色、以及"按建筑与据点的真实归属"该建筑是否受益。
            // 大本营没有旗位，因此恒无特色；旧建筑留在失守据点时不能再说自己受益。
            const siteFlag = Number.isInteger(building.siteId) ? this.scene.flags?.[building.siteId] : null;
            const trait = describeTrait(siteFlag?.role);
            if (trait) {
                const teamName = building.team === 'red' ? '红方' : '蓝方';
                const holderName = siteFlag.owner === 'red' ? '红方' : siteFlag.owner === 'blue' ? '蓝方' : null;
                let holder;
                if (trait.scope === 'global') {
                    // 渡口/马场是全局奖励：看该建筑归属方是否仍拥有任一同类据点。
                    holder = this.scene && ownsRole(this.scene, building.team, siteFlag.role)
                        ? `${teamName}仍拥有${trait.name}，全局奖励生效中`
                        : holderName ? `该点已归${holderName}，${teamName}无任何${trait.name}，奖励未生效`
                            : `该点中立；${teamName}拥有任一${trait.name}即生效`;
                } else {
                    // 局部奖励按受益对象分化：林口/桥头作用于本点建筑（施工/减伤）；
                    // 高地作用于"归属方有驻守令且在旗点 8 格内的营队成员"（士气损失），
                    // 与建筑无关，也不能据此宣称附近营队已经满足条件；
                    // 路口作用于本据点的伤兵收容容量，不是建筑属性。
                    if (siteFlag.role === 'hill') {
                        holder = siteFlag.owner === building.team
                            ? `${teamName}拥有高地：有驻守令且在旗点 8 格内的营队成员士气损失 −10%（作用于营队，不作用于建筑）`
                            : holderName ? `高地已归${holderName}，其营队满足条件时享受减损（与本建筑无关）`
                                : '该点中立，占领后其营队满足条件时可享受减损（与本建筑无关）';
                    } else if (siteFlag.role === 'crossroad') {
                        holder = siteFlag.owner === building.team
                            ? `${teamName}拥有该点：本据点伤兵收容 +4（作用于据点收容容量，非建筑属性）`
                            : holderName ? `据点已归${holderName}，本据点收容提升对${holderName}生效`
                                : '该点中立，占领后本据点收容提升生效';
                    } else {
                        holder = siteFlag.owner === building.team ? `${teamName}拥有该点，奖励对此建筑生效`
                            : holderName ? `据点已归${holderName}，此建筑不再受益`
                                : '该点中立，占领后生效';
                    }
                }
                details += ` · ${trait.icon}${trait.name}：${trait.reward}（${holder}）`;
            }
            if (own && this.scene.territory.healing) {
                const healing = this.scene.territory.healing;
                details += ` · 疗伤 ${healing.healingCount(this.side, building.siteId)}/${healing.capacity(this.side, building.siteId)}`;
            }
            if (own && building.type === 'tower') actions += button('exit', '弓手出塔', !building.garrisonIds.length);
            if (own && building.type === 'tent') actions += button('exit', '医师出帐', !building.garrisonIds.length);
            actions += button('locate', '定位');
        }
        // 「驻入箭塔」始终可见：有弓手时可点，选了兵但没有弓手时置灰并在 title 里说明原因。
        const hasArcher = troops.some(u => u.type === 'archer' && !u.garrisonTowerId);
        if (hasArcher) actions += button('garrison', '🏹 驻入箭塔');
        else if (troops.length) {
            // disabled 按钮的 title 在 Chrome 上不一定弹提示：原因同时写进面板正文，保证看得见。
            details += ' · 选中部队没有弓手，先选弓手或含弓手的营队';
            actions += button('garrison', '🏹 驻入箭塔', true,
                '选中的部队里没有弓箭手：先选中至少 1 名弓手（或整营含弓手），再点这里选塔入驻');
        }
        if (troops.some(u => u.type === 'medic' && !u.garrisonTowerId)) actions += button('medic-in', '➕ 驻入医帐');
        if (troops.length) actions += button('attack', '⚔ 攻击建筑');
        if (this.targeting) actions += button('cancel', '取消选点');
        const markup = `<div class="camp-control-title"><b>${heading}</b><small>${this.targeting ? '等待选择目标' : details}</small>` +
            `<button data-camp-action="close" class="camp-close" aria-label="收起建设面板">✕</button></div>` +
            `<div class="camp-actions">${actions}</div><div class="camp-workers">` +
            workers.map(u => `<button data-worker="${u.id}" class="${u.id === this.workerId ? 'active' : ''}">🧰 民夫${u.id}${u.workerTask ? ' · 忙碌' : ' · 待命'}</button>`).join('') + '</div>';
        if (markup !== this.lastMarkup) { this.panel.innerHTML = markup; this.lastMarkup = markup; }
    }
}

// Selection and targeting stay local; commands always enter the simulation API.
export class CampControls {
    constructor(ui) {
        this.ui = ui;
        this.workerId = null;
        this.buildingId = null;
        this.targeting = null;
        this.pinned = false;    // 「🧰 建设」固定展开（上下文弹出布局的显式入口）
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
        this.lastMarkup = '';
        document.getElementById('btn-camp-open')?.classList.remove('active');
        if (this.panel) { this.panel.hidden = true; this.panel.replaceChildren(); }
    }

    // 「🧰 建设」固定展开/收起：无选择时展开列出民夫列表，供玩家点选开工
    togglePin() {
        this.pinned = !this.pinned;
        if (!this.pinned) this.cancel();
        this.update();
    }

    cancel() {
        this.targeting = null;
        document.body.classList.remove('camp-targeting');
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
        if (kind === 'garrison' && !units.some(u => u.type === 'archer')) return;
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
        this.ui.showNetToast(prompt + ' · Esc 取消');
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

    selectWorker(id) {
        const worker = this.workers().find(u => u.id === id);
        if (!worker) return;
        this.cancel();
        this.workerId = id;
        this.buildingId = null;
        this.scene.selectedBattalion = null;
        if (this.scene.unitInspector) this.scene.unitInspector.selected = worker;
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
                accepted = this.send({ k: mode.kind === 'garrison' ? 'garrison' : 'attack-building',
                    units: mode.units, building: building.id });
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
            this.update();
            return true;
        }
        this.workerId = this.buildingId = null;
        this.update();
        return false;
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
                    this.pinned = false; this.cancel();
                    this.workerId = this.buildingId = null;
                    this.update();
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
        // 上下文弹出（B）：默认不在，固定展开/正在选点/选了民夫或建筑时才出现
        this.panel.hidden = !this.active || !(this.pinned || this.targeting || this.workerId || this.buildingId);
        document.getElementById('btn-camp-open')?.classList.toggle('active', this.pinned);
        if (!this.active) { this.cancel(); return; }
        const workers = this.workers();
        const worker = workers.find(u => u.id === this.workerId);
        const building = this.camps.getBuilding(this.buildingId);
        if (this.workerId && !worker) { this.workerId = null; this.cancel(); }
        if (this.buildingId && (!building || building.dead)) this.buildingId = null;
        const troops = this.selectedTroops();
        const button = (action, label, disabled = false) =>
            `<button data-camp-action="${action}"${disabled ? ' disabled' : ''}>${label}</button>`;
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
            details = state + (building.type === 'tower' ? ` · 驻军 ${building.garrisonIds.length}/${this.camps.buildInfo('tower').capacity}`
                : building.type === 'tent' ? ` · 医师 ${building.garrisonIds.length}/${this.camps.buildInfo('tent').capacity} · 据点疗伤提速扩容` : '');
            if (own && building.type === 'tower') actions += button('exit', '弓手出塔', !building.garrisonIds.length);
            if (own && building.type === 'tent') actions += button('exit', '医师出帐', !building.garrisonIds.length);
            actions += button('locate', '定位');
        }
        if (troops.some(u => u.type === 'archer' && !u.garrisonTowerId)) actions += button('garrison', '🏹 驻入箭塔');
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

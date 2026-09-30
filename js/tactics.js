// 战术只在明确选择时启用；所有指令共用 CombatRules 的接触与命中规则。
// 阵位、路线与命中都使用模拟坐标/时钟，画面与音效不参与胜负。
import { board } from './board.js';
import { Terrain } from './terrain.js';
import { CombatRules } from './combat.js';
import { dist, clamp, moveToward } from './units.js';
const TACTIC_LABELS = { advance: '自由接敌', assault: '正面强攻', flank: '单翼迂回', hold: '枪阵守位', hold_ground: '高地守位' };

import { DeployMethods } from './tactics/deploy.js';
import { GuardsMethods } from './tactics/guards.js';
import { RallyMethods } from './tactics/rally.js';
import { StepsMethods } from './tactics/steps.js';

export class TacticsSystem {
    constructor(scene, orders) {
        this.scene = scene;
        this.orders = { red: orders.red || 'advance', blue: orders.blue || 'advance' };
        this.formations = {};
        this.groups = {};
        this.groundGuards = {};
        this.metrics = { thrusts: 0, blocked: 0, deflections: 0, replacements: 0 };
        // 先布置防阵，再按真实边界规划进攻路线。
        for (const team of ['red', 'blue']) {
            if (this.orders[team] === 'hold') this.deployGuards(team);
            if (this.orders[team] === 'hold_ground') this.deployGroundGuards(team);
        }
        for (const team of ['red', 'blue']) {
            if (this.orders[team] !== 'hold_ground' && (['assault', 'flank'].includes(this.orders[team]) || this.scene.battleOptions?.reserves?.[team] > 0)) {
                this.deployAttackers(team);
            }
        }
        const naturalSlope = Terrain.isNaturalSlope(scene.battleOptions.terrain);
        if (Terrain.hasBarriers(scene.battleOptions.terrain) || naturalSlope) this.legalizeDeployments();
        if (naturalSlope) for (const unit of scene.units) {
            if (unit.type === 'cavalry') unit.naturalFlankOrigin = { gx: unit.gx, gy: unit.gy };
            if (this.orders[unit.team] === 'advance' && !unit.tacticalRole &&
                ['infantry', 'pikeman'].includes(unit.type)) {
                unit.slopeApproach = { gy: unit.gy, released: false };
            }
        }
    }

    active(unit) { return !unit.dead && !unit.withdrawn && unit.moraleState !== 'routing'; }

    enemies(team) { return team === 'red' ? 'blue' : 'red'; }

    forward(team) { return team === 'red' ? 1 : -1; }

    summary() {
        const result = {};
        for (const team of ['red', 'blue']) {
            const formation = this.formations[team], group = this.groups[team], ground = this.groundGuards[team];
            const guards = formation?.members.filter(u => this.active(u)) || [];
            const engaging = guards.filter(u => u.guardEngaging).length;
            const repositioning = guards.filter(u => u.moving).length;
            result[team] = {
                order: this.orders[team], label: TACTIC_LABELS[this.orders[team]],
                stage: ground ? (ground.members.some(unit => this.active(unit) && unit.counterRaid) ? '守骑出击 · 冲击敌线侧后' :
                    ground.members.some(unit => this.active(unit) && unit.groundGuardReturning) ? '威胁退去 · 返回守区' :
                    ground.members.some(unit => this.active(unit) && unit.groundGuardTarget) ? '近敌入区 · 局部反击' :
                    ground.onHill ? '弓守山顶 · 剑枪护坡' : '守住出发区 · 等待接敌') : group?.phase || (formation ? (engaging ? '近敌转向 · 局部迎击' :
                    formation.breaches ? '阵线受压 · 就近补位' : repositioning ? '威胁已退 · 归位重架' :
                    formation.sparse ? '小队守位 · 阵线稀疏' : '四面守位 · 等待接敌') : '自由接敌'),
                main: group ? group.main.filter(u => this.active(u)).length :
                    this.scene.units.filter(u => u.team === team && this.active(u)).length,
                flank: group?.flank.filter(u => this.active(u)).length || 0,
                reserve: group?.reserve.filter(u => this.active(u) && !u.reserveCommitted).length || 0,
                regrouping: group ? [...group.main, ...group.flank, ...group.reserve].filter(u =>
                    !u.dead && !u.withdrawn && u.moraleState === 'routing').length : 0,
                committed: group?.committed || 0,
                rallied: group ? [...group.main, ...group.flank, ...group.reserve].filter(u => u.everRallied).length : 0,
                engaging, repositioning,
                ready: guards.filter(u => u.guardReady).length,
                slots: formation?.slots.length || 0, breaches: formation?.breaches || 0
            };
        }
        return result;
    }
    // 部署/守备/集结/步进四组实现经原型混入，方法集与调用面不变。
}
Object.assign(TacticsSystem.prototype, DeployMethods, GuardsMethods, RallyMethods, StepsMethods);

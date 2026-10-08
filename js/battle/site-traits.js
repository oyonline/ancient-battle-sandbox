// ==================== 据点特色（纯模拟规则 + 玩家文案单一来源） ====================
// 11 个据点共 6 类角色：马场 ranch / 林口 forest / 桥头 bridge / 中央高地 hill /
// 渡口 ford / 路口 crossroad。东西两侧同类据点共用本表同一份参数（镜像一致）。
//
// 统一口径（与设计约定一致，模拟 / AI / UI 都只读本表，不各自硬编码）：
// - 占领型奖励一律按"当前归属"判定：易主即刻失效，不残留、不追溯、不重复领取。
// - 局部效果只作用于该据点及其合法受益对象；大本营（siteId === 'home'）永不套用。
// - 全局解锁 / 通行效果取"是否拥有"（ranch / ford），不按据点数量叠加。
// - 派生状态（哪一方拥有哪类角色）只在归属变化时刷新，不做逐兵 × 全部据点扫描。
//
// 确定性：本模块无随机数；距离阈值比较先量化（见 docs/DETERMINISM.md）。

import { quantizeDecision as q } from './determinism.js';
import { TEAMS, sameSide } from '../factions.js';

// 地形本身的默认浅滩系数（渡口奖励未生效时的基准，与 terrain.js 一致）。
export const DEFAULT_SHALLOW_SPEED = 0.7;

export const SITE_TRAITS = {
    ranch: {
        name: '马场', icon: '🐎', scope: 'global',
        terrain: '北岭缓坡草场（地形本身无战斗加成）',
        reward: '骑兵征募权',
        condition: '拥有任一马场即可征募骑兵；两座马场不叠加',
        detail: '丢光马场只是断补充：已在场 / 已在队列的骑兵照常作战'
    },
    forest: {
        name: '林口', icon: '🌲', scope: 'local',
        terrain: '林内移速：骑兵 55% · 其他 85%',
        reward: '营建加速：本点施工时间 −20%',
        condition: '该据点当前归属己方时生效（施工速度 ×1.25）',
        detail: '只加快施工，不降费用、不提高建筑属性；续建保留已有进度',
        buildSpeed: 1.25
    },
    bridge: {
        name: '桥头', icon: '🌉', scope: 'local',
        terrain: '跨河通道与桥面地形（不可通行水域照旧）',
        reward: '工事：本点建筑受到伤害 −10%',
        condition: '该据点当前归属己方时，本点己方建筑生效',
        detail: '只保护本点建筑，不给全军加防御；易主后旧建筑立刻失去该奖励',
        damageTaken: 0.9
    },
    hill: {
        name: '中央高地', icon: '⛰️', scope: 'local',
        terrain: '高差：居高射程加成 + 俯攻加成（对双方都生效）',
        reward: '稳固军心：驻守营队士气损失 −10%',
        condition: '高地归属己方 + 该营有明确驻守令 + 在旗点 8 格内',
        detail: '只减少负向士气损失，不加生命 / 攻击 / 射程，也不加快士气恢复',
        moraleLoss: 0.9, radius: 8
    },
    ford: {
        name: '渡口', icon: '🌊', scope: 'global',
        terrain: '中央浅滩可通行，但蹚水移速 70%',
        reward: '通行：浅滩移速 70% → 85%',
        condition: '拥有任一渡口；两座渡口不叠加',
        detail: '只改浅滩系数，不改陆地速度、水域可通行性与寻路边界',
        shallowSpeed: 0.85
    },
    crossroad: {
        name: '路口', icon: '🛤️', scope: 'local',
        terrain: '下翼迂回岔路地形（无战斗修正）',
        reward: '补给：本点伤兵收容 +4 人（8→12 / 医帐 16→20）',
        condition: '该据点当前归属己方时生效',
        detail: '不乘算疗伤速度，不变动驻帐军医加成；容量变化按现有规则处理伤兵',
        healCapacity: 4
    }
};

// AI 据点权重（克制：基础夺旗分为 50，这里只做 3~28 的加减，并按当前需求折算）。
// contest = 争夺非己方据点的加权；contestHeld = 同类已拥有一处时的争夺加权；
// hold = 己方据点常驻防守加权；need/holdNeed/contestNeed = 需求系数键
// （在既有 2 秒战略节拍里每方算一次，不逐兵扫描）。
export const SITE_AI = {
    ranch: { hold: 10, contest: 28, contestHeld: 10, holdNeed: 'cavalryHold', contestNeed: 'cavalry' },
    forest: { hold: 4, contest: 12, contestHeld: 4, need: 'build' },
    bridge: { hold: 8, contest: 10, contestHeld: 6, need: 'defense' },
    hill: { hold: 8, contest: 12, contestHeld: 6, need: 'hold' },
    ford: { hold: 3, contest: 8, contestHeld: 3, need: 'crossing' },
    crossroad: { hold: 4, contest: 8, contestHeld: 4, need: 'healing' }
};

export function traitOf(role) { return SITE_TRAITS[role] ?? null; }

// 派生归属缓存：只在归属串变化时重建。11 面旗的签名是纯整数运算，
// 单帧开销可忽略；即便测试直接改写 flag.owner 也不会读到陈旧结果。
export class SiteTraitState {
    constructor(scene) {
        this.scene = scene;
        this.signature = null;
        this.flagCount = -1;
        this.roles = { red: {}, blue: {}, black: {} };
        this.index = {};
        this.revision = 0;
    }

    refresh() {
        const flags = this.scene?.flags ?? [];
        let signature = 0;
        for (let i = 0; i < flags.length; i++) {
            const owner = flags[i].owner;
            // 四进制编码（0 中立 / 1 红 / 2 蓝 / 3 黑），三方归属都能进签名。
            signature = signature * 4 + (owner === 'red' ? 1 : owner === 'blue' ? 2 : owner === 'black' ? 3 : 0);
        }
        if (signature === this.signature && flags.length === this.flagCount) return false;
        this.signature = signature;
        this.flagCount = flags.length;
        this.revision++;
        this.roles = { red: {}, blue: {}, black: {} };
        this.index = {};
        for (let i = 0; i < flags.length; i++) {
            const flag = flags[i];
            if (flag.role && this.index[flag.role] == null) this.index[flag.role] = i;
            if (flag.owner) this.roles[flag.owner][flag.role] = true;
        }
        return true;
    }

    // 是否拥有某类据点：盟友共享（合作模式下红蓝任一持有即算双方拥有）。
    // 二元模式下 sameSide 只在同队成立，结果与旧实现逐位一致。
    owns(team, role) {
        if (this.roles[team]?.[role] === true) return true;
        for (const other of TEAMS) {
            if (other !== team && sameSide(this.scene, team, other) && this.roles[other]?.[role] === true) return true;
        }
        return false;
    }

    // 角色是地图静态数据；若被就地改写（测试或未来模式），索引会自愈而不是读陈旧值。
    roleIndex(role) {
        const cached = this.index[role];
        if (cached != null && this.scene?.flags?.[cached]?.role === role) return cached;
        const flags = this.scene?.flags ?? [];
        for (let i = 0; i < flags.length; i++) {
            if (flags[i].role === role) { this.index[role] = i; return i; }
        }
        delete this.index[role];
        return -1;
    }

    invalidate() { this.signature = null; this.flagCount = -1; this.hillRef = null; }
    ownsRoleCount(team, role) {
        let count = 0;
        for (const flag of this.scene?.flags ?? []) {
            if (flag.role === role && flag.owner != null && sameSide(this.scene, team, flag.owner)) count++;
        }
        return count;
    }
}

export function traitState(scene) {
    if (!scene) return null;
    if (!scene.siteTraits) scene.siteTraits = new SiteTraitState(scene);
    scene.siteTraits.refresh();
    return scene.siteTraits;
}

// 全局效果：取"是否拥有"，不按数量叠加。
export function ownsRole(scene, team, role) {
    const state = traitState(scene);
    if (!state) return false;
    state.refresh();
    return state.owns(team, role);
}

// 据点旗（大本营没有旗位，返回 null —— 所有局部奖励因此天然不落在大本营）。
export function siteFlag(scene, siteId) {
    return Number.isInteger(siteId) ? scene?.flags?.[siteId] ?? null : null;
}

// 局部效果：仅当该据点"当前归属 team"且角色匹配时返回特色表，否则 null。
export function localTrait(scene, team, siteId) {
    const flag = siteFlag(scene, siteId);
    if (!flag || flag.owner == null || !sameSide(scene, team, flag.owner)) return null;
    return SITE_TRAITS[flag.role] ?? null;
}

// ---- 各系统的统一入口（一次判定、一处取整） ----

// 林口：施工速度倍率（有效施工时间 −20% ≡ 速度 ×1.25）。
export function buildSpeedScale(scene, building) {
    return localTrait(scene, building?.team, building?.siteId)?.buildSpeed ?? 1;
}

// 桥头：本点建筑受到的伤害系数（在 damageBuilding 里只应用一次）。
export function buildingDamageScale(scene, building) {
    return localTrait(scene, building?.team, building?.siteId)?.damageTaken ?? 1;
}

// 路口：本点伤兵收容容量加成（大本营恒为 0）。
export function healingCapacityBonus(scene, team, siteId) {
    return localTrait(scene, team, siteId)?.healCapacity ?? 0;
}

// 渡口：浅滩速度系数（拥有任一渡口取 0.85，否则地形默认 0.70）。
export function shallowSpeedFor(scene, team) {
    if (!scene?.battleOptions?.territory) return DEFAULT_SHALLOW_SPEED;
    return ownsRole(scene, team, 'ford') ? SITE_TRAITS.ford.shallowSpeed : DEFAULT_SHALLOW_SPEED;
}

// 中央高地旗位索引：角色是地图静态数据，索引只在旗数组换人时重建，
// 每单位每步只读一次归属（避免"逐兵 × 全部据点"的高频扫描）。
function hillFlag(scene) {
    const flags = scene?.flags;
    if (!flags?.length) return null;
    let state = scene.siteTraits;
    if (!state) state = scene.siteTraits = new SiteTraitState(scene);
    if (state.hillRef !== flags) {
        state.refresh();
        state.hillRef = flags;
    }
    const index = state.roleIndex('hill');
    return index >= 0 ? flags[index] : null;
}

// 中央高地：驻守营队成员在旗点 8 格内的士气损失系数。
// 只影响负向损失；离开范围 / 解除驻守 / 失去高地立刻回到 1。
export function moraleLossScale(scene, unit) {
    if (!scene?.battleOptions?.territory) return 1;      // 非领土模式没有旗点，直接短路
    const trait = SITE_TRAITS.hill;
    const flag = hillFlag(scene);
    if (!flag) return 1;
    if (flag.owner == null || !sameSide(scene, unit.team, flag.owner)) return 1;
    if (!unit.battalion?.orderPoint) return 1;
    if (q(Math.hypot(flag.gx - unit.gx, flag.gy - unit.gy)) > trait.radius) return 1;
    return trait.moraleLoss;
}

// AI 选点偏好（以"格"为单位的等效距离折扣）：AI 在同样的距离下优先把建筑放在
// 能让该建筑吃到奖励的据点上——林口加快施工、路口扩收容、桥头保护工事。
// 保守取值（4~6 格），只是同距离时的排序手段，不会让 AI 舍近求远。
export function buildSiteBonus(scene, team, siteId, kind) {
    const trait = localTrait(scene, team, siteId);
    if (!trait) return 0;
    if (trait.buildSpeed) return 5;                       // 林口：所有施工都更快
    if (trait.healCapacity && kind === 'tent') return 6;  // 路口：医帐收容 16→20
    if (trait.damageTaken && kind === 'tower') return 4;  // 桥头：箭塔更耐打
    return 0;
}

// 玩家文案：把"地形原有"与"占领后奖励"分开，避免内部字段名上屏。
export function describeTrait(role) {
    const trait = traitOf(role);
    if (!trait) return null;
    return {
        name: trait.name, icon: trait.icon, scope: trait.scope,
        terrain: trait.terrain, reward: trait.reward, condition: trait.condition, detail: trait.detail
    };
}

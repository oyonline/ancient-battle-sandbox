// ==================== 阵营注册表与敌我关系 ====================
// 单一事实来源：队名、显示元数据与「谁打谁」的判定。
//
// 关系由战场上的「同盟分组」决定：
//   RELATIONS_MUTUAL（默认，既有两方对局）= 各自为战，非我即敌；
//   RELATIONS_COOP  （合作模式）          = 红蓝联军互为友军，共同对抗黑方。
//
// 未显式指定分组时一律按「非我即敌」处理，保证既有玩法行为逐位不变
//（这一点是确定性前提：两方模式下的模拟结果不许因为引入本文件而改变）。

export const TEAMS = ['red', 'blue', 'black'];

// 本局"参与阵营"名单：既有两方模式只有红蓝（黑方不参战、不建营、不入枚举），
// 合作模式才扩展为红蓝黑。凡"逐阵营创建实体/建筑/循环"一律读这里，
// 保证既有两方对局的模拟结果与新细节零差异。
export const DEFAULT_TEAMS = ['red', 'blue'];
export function activeTeams(scene) { return scene?.activeTeams || DEFAULT_TEAMS; }
export function isActiveTeam(scene, team) { return activeTeams(scene).includes(team); }

// 同盟分组：同一分组内互为友军，跨分组互为敌人。
export const RELATIONS_MUTUAL = [['red'], ['blue'], ['black']];
export const RELATIONS_COOP = [['red', 'blue'], ['black']];

// 显示元数据：队名/图标/队色/贴图前缀。渲染与 UI 一律从这里取，避免散落字面量。
export const FACTIONS = {
    red:   { name: '红方', short: '红', icon: '🔴', color: 0xff5b5b, css: '#ff5b5b', asset: 'red' },
    blue:  { name: '蓝方', short: '蓝', icon: '🔵', color: 0x57a0ff, css: '#57a0ff', asset: 'blue' },
    black: { name: '黑方', short: '黑', icon: '⚫', color: 0x8a8a96, css: '#8a8a96', asset: 'black' }
};

export function teamName(team) { return FACTIONS[team]?.name ?? team; }
export function teamIcon(team) { return FACTIONS[team]?.icon ?? '⚪'; }
export function teamColor(team) { return FACTIONS[team]?.color ?? 0xffffff; }
export function teamCss(team) { return FACTIONS[team]?.css ?? '#ffffff'; }
export function assetPrefix(team) { return FACTIONS[team]?.asset ?? team; }

// 素材来源阵营：黑方暂无独立美术，渲染层复用蓝方贴图 + 深色染色。
export function assetTeam(team) { return team === 'black' ? 'blue' : team; }

// 阵营基色染色（null = 不染色，直接用原图）——黑方靠它在共享贴图上区分敌我。
export function teamTint(team) { return team === 'black' ? 0xb9b4a0 : null; }

// 关系表解析缓存：同一分组数组只解析一次（WeakMap 以数组身份为键）。
const GROUP_CACHE = new WeakMap();

function groupIndexMap(groups) {
    let map = GROUP_CACHE.get(groups);
    if (!map) {
        map = new Map();
        groups.forEach((group, index) => group.forEach(t => map.set(t, index)));
        GROUP_CACHE.set(groups, map);
    }
    return map;
}

function groupIndexOf(groups, team) {
    const map = groupIndexMap(groups);
    return map.has(team) ? map.get(team) : -1;
}

// 阵营所在同盟组索引（未设置关系表时按「各自为战」的三组表解析）。
export function groupOf(scene, team) {
    return groupIndexOf(scene?.relationGroups || RELATIONS_MUTUAL, team);
}

// 组代表：组内按 TEAMS 顺序第一个阵营，用作该同盟占领旗面时的归属标记
//（红蓝联军 => 'red'，保证盟友不会为同一面旗来回易主）。
export function canonicalOf(group) {
    return TEAMS.find(t => group.includes(t)) ?? group[0];
}

// 播报用阵营/联军称呼：多人同盟显示「红蓝联军」，单阵营显示队名。
export function sideLabel(scene, team) {
    const groups = scene?.relationGroups;
    if (!groups) return teamName(team);
    const group = groups[groupOf(scene, team)] ?? [team];
    if (group.length <= 1) return teamName(team);
    return group.map(t => FACTIONS[t]?.short ?? t).join('') + '联军';
}

// 联军统一色（多阵营同盟的据点归属用色，避免被误读成"红方"）。
export const ALLIANCE_COLOR = 0xc06cff;
export const ALLIANCE_CSS = '#c06cff';

// 据点归属是否属于 team 一方：owner 为阵营标识，盟友（同组）视为同属。
// 红蓝联军下，红方名下的据点对蓝方同样算"拥有"——骑兵征募、占旗行军、
// 驻守回位等一切归属判定都必须走这里，不能再用 flag.owner === team 的严格相等。
export function ownsFlag(scene, team, flag) {
    return !!flag && flag.owner != null && sameSide(scene, team, flag.owner);
}

// 归属方的显示标记/颜色：多人同盟显示联军标记与统一色，单阵营显示各自队标与队色。
export function ownerMark(scene, owner) {
    const group = allianceGroupOf(scene, owner);
    if (group && group.length > 1) return '🤝';
    return owner == null ? '⚪' : teamIcon(owner);
}
export function ownerDisplayColor(scene, owner) {
    const group = allianceGroupOf(scene, owner);
    if (group && group.length > 1) return ALLIANCE_COLOR;
    return owner == null ? null : teamColor(owner);
}
export function ownerDisplayCss(scene, owner) {
    const group = allianceGroupOf(scene, owner);
    if (group && group.length > 1) return ALLIANCE_CSS;
    return owner == null ? null : teamCss(owner);
}
function allianceGroupOf(scene, owner) {
    const groups = scene?.relationGroups;
    if (!groups || owner == null) return null;
    return groups[groupOf(scene, owner)] ?? null;
}

// 取战场关系分组；未设置时返回 null（调用方据此走「非我即敌」默认）。
export function relationGroupsOf(scene) { return scene?.relationGroups || null; }

// 敌对判定。scene 缺省 / 未设置 relationGroups 时退回「非我即敌」（既有行为）。
export function isHostile(scene, a, b) {
    if (a === b) return false;
    const groups = relationGroupsOf(scene);
    if (!groups) return true;
    return groupIndexOf(groups, a) !== groupIndexOf(groups, b);
}

// 同一同盟（同队或互为友军）。
export function sameSide(scene, a, b) { return !isHostile(scene, a, b); }

// 指定阵营的敌人阵营列表（保持 TEAMS 顺序，供重心/索敌/哈希使用）。
export function enemiesOf(scene, team) {
    return TEAMS.filter(t => isHostile(scene, team, t));
}

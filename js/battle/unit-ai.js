// ==================== 普通单位逐帧 AI（接敌/行军/放箭/走位，纯模拟） ====================
// 从 game.js IsoBattleScene 抽出（第 0 批地基遗留项：updateNormalUnit 拆分）。
// 辎重车特判、营队集结/回防/驻守/夺旗行军、护送/劫掠选车、远程风筝集火、
// 近战接战环逼近与攻击间隙走位。渲染表现经 scene 钩子（playAttackAnim/fireArrow）。
// 铁律：不 import Phaser；scene 只作数据与钩子入口，外部契约不变。

import { board } from '../board.js';
import { Terrain } from '../terrain.js';
import { CombatRules } from '../combat.js';
import { BATTALION } from './battalion.js';
import { dist, clamp, unitRand, moveToward } from '../units.js';

// 受阻接战节奏（模拟时钟）：冷却就绪却持续打不出去达 BLOCKED_ENGAGE_MS 才解困，
// 短于它的瞬时阻挡（友军路过）不打扰目标粘滞；解困尝试按 BLOCKED_SCAN_MS 节流，
// 换目标后 RETARGET_LOCK_MS 内粘滞规则不得翻回旧敌。
const BLOCKED_ENGAGE_MS = 800;
const BLOCKED_SCAN_MS = 600;
const RETARGET_LOCK_MS = 1500;

// 受阻接战的解困：优先换"当前就能打出去"的目标（不动身、不破坏站位，
// 射程/枪线/守位朝向全部按既有规则判），没有可打目标时绕接战环找合法出枪位。
// 二者都不取消友军阻挡、不加攻击距离、不穿地形；架枪中的枪兵与守阵哨位
// 目标不参与换位（架枪纪律与"墙不绕位"的既有口径）。
// 确定性：局部空间扫描（半径=射程+2.5），距离优先、平局 id 最小决胜；
// 换位角度走单位种子随机并按阵营镜像取反（与攻击间隙走位同构，换座对称）。
export function resolveBlockedEngage(scene, unit, target, now, reach) {
    let pick = null, bestD = Infinity;
    scene.forEachNear(unit.gx, unit.gy, reach + 2.5, e => {
        if (e === target || e.team === unit.team || e.dead || e.withdrawn || e.type === 'wagon') return;
        if (!CombatRules.canStrike(scene, unit, e, reach)) return;
        const d = dist(unit, e);
        if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && e.id < pick.id)) { bestD = d; pick = e; }
    });
    if (pick) {
        unit.meleeTarget = pick;
        // 回避旧目标而非整体锁定：旧目标在回避期内仍是最近敌时保持新目标
        // （否则粘滞的"近20%就切"立刻翻回打不出去的旧敌）；一旦别的敌人
        // 成为最近（或旧目标不再最近），正常粘滞规则接管，不会把单位
        // 拴在冲出范围的旧敌上拖离阵型。
        unit.avoidTargetId = target.id;
        unit.avoidUntil = now + RETARGET_LOCK_MS;
        unit.blockedEngageAt = null;
        return;
    }
    if ((unit.type === 'pikeman' && (unit.braceHold || unit.braceSupport >= 2)) || target.tacticalRole === 'guard') return;
    // 枪兵集群纪律：有 2+ 矛邻支撑的枪兵是枪墙的一部分，挪位会拆散架枪密度
    // （braceSupport/braceReady 掉线，抗骑能力崩），站桩等前排打出缺口是本分；
    // 只有落单/弱支撑的枪兵才自己找角度。架枪中（braceHold）更是钉死原地。
    // 绕接战环找合法出枪位：候选位先验"从该位到目标枪线合法"，找不到合法位
    // 也至少挪开原地（位移本身可能打开枪线）；占位检查与攻击间隙走位一致。
    const mir = unit.team === 'red' ? 1 : -1;
    const cur = Math.atan2(unit.gy - target.gy, unit.gx - target.gx);
    const nr = Math.max(0.55, reach * 0.85);
    // 候选角度：初角随机 + ±0.9、±1.8 四个互不相同的增量（mir 保证换座镜像），
    // 不来回重复同一两个方向。
    const baseAng = cur + mir * (unitRand(unit) < 0.5 ? 1 : -1) * (0.7 + unitRand(unit) * 0.7);
    let fallback = null;
    for (let t = 0; t < 4; t++) {
        const pickAng = baseAng + mir * (t % 2 === 0 ? 1 : -1) * (0.9 * Math.ceil((t + 1) / 2));
        const sx = clamp(target.gx + Math.cos(pickAng) * nr, 1.2, board.W - 1.2);
        const sy = clamp(target.gy + Math.sin(pickAng) * nr, 1.2, board.H - 1.2);
        let taken = false;
        scene.forEachNear(sx, sy, 0.42, o => {
            if (o !== unit && o.team === unit.team && !o.dead && !o.withdrawn &&
                Math.hypot(o.gx - sx, o.gy - sy) < 0.42) taken = true;
        });
        if (!taken) {
            const legal = Terrain.segmentClear(scene.battleOptions.terrain, sx, sy, target.gx, target.gy) &&
                CombatRules.clearLane(scene, unit, target, undefined, sx, sy);
            if (legal) { fallback = { sx, sy }; break; }
            fallback ??= { sx, sy };
        }
    }
    if (fallback) {
        unit.strafeX = fallback.sx; unit.strafeY = fallback.sy;
        unit.strafeUntil = now + 500 + unitRand(unit) * 400;
        unit.blockedEngageAt = null;   // 挪位后重计受阻时长；仍打不出去再解
    }
}

export function updateNormalUnit(scene, unit, now, dt, guardAnchor = null) {
        if (unit.dead || unit.withdrawn || unit.moraleState === 'routing') return;
        // 辎重车：有护卫在侧(4格内)且无敌情(3.2格内无敌)才沿路线推进——
        // 逼近的敌人没清完就停车列队，不会自己往敌阵里拱；车不还手（atk 0）。
        // 敌情闸门只挡贴脸威胁：远处胶着的战团不该让车队无限期趴窝。
        // 邻兵查询过滤界=查询界，桶毛边不泄漏。
        if (unit.type === 'wagon') {
            let escort = false, danger = false;
            scene.forEachNear(unit.gx, unit.gy, 4, u => {
                if (u === unit || u.dead || u.withdrawn || u.type === 'wagon') return;
                const d = Math.hypot(u.gx - unit.gx, u.gy - unit.gy);
                if (u.team === unit.team) {
                    if (d <= 4 && u.moraleState !== 'routing') escort = true;
                } else if (d <= 3.2 && u.moraleState !== 'routing') danger = true;
            });
            if (escort && !danger && unit.gx < scene.convoy.goalX) {
                moveToward(unit, scene.convoy.goalX + 1, unit.gy, unit.typeData.speed, dt);
            }
            return;
        }
        const nearest = scene.stickyTarget(unit);
        if (!nearest) {
            if (guardAnchor && dist(unit, guardAnchor) > 0.2) {
                unit.groundGuardReturning = true;
                moveToward(unit, guardAnchor.gx, guardAnchor.gy, unit.typeData.speed, dt);
            }
            return;
        }
        const range = unit.typeData.range;
        const minD = dist(unit, nearest);
        // 占点征服：自由近战单位在敌尚远(>12格)且不在旗圈内时，向最近的非己方旗行进；
        // 已在非己方旗圈内的单位站住守旗（见追敌分支），敌近后照常接敌不追出圈。
        // 敌军残兵(≤3)时全员清场优先——留着几个远程敌站桩，占旗得分也赢不踏实。
        // 骑兵由冲锋状态机驱动不经过这里；守位与战术组单位走各自入口，不受影响。
        const foeCount = unit.team === 'red' ? scene.blueAlive : scene.redAlive;
        // 领土征服营队：① 集结营成员驻留集结点（攒满一波整营开进，不再单兵溜达）；
        // ② 玩家回防令：全营撤回老家集结点；③ 有令营开赴目标旗（步速按营内
        // 最慢兵种同步，弓骑不脱队）；④ 无令营沿用就近争旗。
        // 占点/非营单位：在敌尚远(>12格)且不在旗圈内时向最近的非己方旗行进；
        // 已在非己方旗圈内的单位站住守旗（见追敌分支），敌近后照常接敌不追出圈。
        // 领土模式远程兵种随队行军但停在旗圈外沿（5.5格）standoff 放箭。
        // 敌军残兵(≤3)时全员清场优先；骑兵由冲锋状态机驱动不经过这里（缰绳另行接管）。
        const battalion = scene.battleOptions.territory ? unit.battalion : null;
        // 有令近战的接敌阈值降为 6 格：半路遇敌不停下对砍，顶着远程火力把旗圈
        // 推过去——夺旗优先；弓手仍按 12 格正常接敌（远程本就该边走边射）。
        const orderedMarch = battalion && !battalion.gathering && battalion.orderFlag != null;
        const engageRange = orderedMarch && !unit.typeData.ranged ? 6 : 12;
        if (battalion && battalion.gathering && !guardAnchor && minD > 12) {
            const gather = battalion.gatherPoint;
            unit.target = nearest;
            if (gather && Math.hypot(gather.gx - unit.gx, gather.gy - unit.gy) > BATTALION.GATHER_HOLD_RADIUS) {
                moveToward(unit, gather.gx, gather.gy, unit.typeData.speed, dt);
            }
            return;
        }
        if (battalion && !battalion.gathering && battalion.retreat && !guardAnchor && minD > 12) {
            const rally = scene.battalions.homeRally(unit.team);
            unit.target = nearest;
            if (Math.hypot(rally.gx - unit.gx, rally.gy - unit.gy) > BATTALION.GATHER_HOLD_RADIUS + 2) {
                moveToward(unit, rally.gx, rally.gy, battalion.pace * BATTALION.PACE_SLACK, dt);
            }
            return;
        }
        // 驻守点令（玩家长期令）：敌远归位驻守（半径 3.5 格）；敌近且离驻点 7 格内
        // 就地接敌、不追出——防线上的兵像钉子，打过就回位。
        if (battalion && !battalion.gathering && battalion.orderPoint && !guardAnchor) {
            const post = battalion.orderPoint;
            const postDistance = Math.hypot(post.gx - unit.gx, post.gy - unit.gy);
            if (minD > engageRange) {
                unit.target = nearest;
                if (postDistance > 3.5) {
                    moveToward(unit, post.gx, post.gy, unit.type === 'cavalry'
                        ? unit.typeData.speed : battalion.pace * BATTALION.PACE_SLACK, dt);
                }
                return;
            }
            const leash = battalion.stance === 'aggressive' ? 14 : 7;
            if (postDistance > leash) {
                unit.target = nearest;
                moveToward(unit, post.gx, post.gy, unit.typeData.speed, dt);
                return;
            }
            // 敌近且在缰绳内：落入正常接敌分支（好战营追得更远才回位）
        }
        const flagMarch = scene.battleOptions.control || scene.battleOptions.territory;
        if (flagMarch && !guardAnchor && minD > engageRange && foeCount > 3 &&
            (!unit.typeData.ranged || scene.battleOptions.territory) &&
            !scene.flags.some(f => f.owner !== unit.team && Math.hypot(f.gx - unit.gx, f.gy - unit.gy) <= 2.8)) {
            let flag = battalion && !battalion.gathering && battalion.orderFlag != null ? scene.flags[battalion.orderFlag] : null;
            if (!flag || flag.owner === unit.team) {
                flag = null;
                let best = Infinity;
                for (const f of scene.flags) {
                    if (f.owner === unit.team) continue;
                    const d = Math.hypot(f.gx - unit.gx, f.gy - unit.gy);
                    // 等距取 y 小者：键为镜像不变量，换座两侧选同一面旗
                    if (d < best - 1e-9 || (Math.abs(d - best) <= 1e-9 && f.gy < flag.gy - 1e-9)) { best = d; flag = f; }
                }
            }
            if (flag && (!unit.typeData.ranged || Math.hypot(flag.gx - unit.gx, flag.gy - unit.gy) > 5.5)) {
                unit.target = nearest;
                const pace = battalion && !battalion.gathering && unit.type !== 'cavalry'
                    ? Math.min(unit.typeData.speed, battalion.pace * BATTALION.PACE_SLACK)
                    : unit.typeData.speed * (unit.typeData.ranged ? 0.9 : 1);
                moveToward(unit, flag.gx, flag.gy, pace, dt);
                return;
            }
        }
        // 护送模式：护送方近战单位敌远(>12格)时向最落后的车集结——落点取车侧翼
        // （不站在车队行进路径上，护卫从后方穿队会把自己和车一起堵死）；
        // 敌近恢复正常接敌。
        if (scene.battleOptions.convoy && unit.team === scene.convoy.team && !guardAnchor &&
            !unit.typeData.ranged && minD > 12) {
            const wagons = scene.convoy.wagons.filter(w => !w.dead && !w.withdrawn);
            if (wagons.length) {
                let tail = wagons[0];
                for (const w of wagons) {
                    if (w.gx < tail.gx - 1e-9 || (Math.abs(w.gx - tail.gx) <= 1e-9 && w.gy < tail.gy - 1e-9)) tail = w;
                }
                unit.target = nearest;
                const side = unit.gy >= tail.gy ? 2.6 : -2.6;   // 就近侧翼护航
                moveToward(unit, tail.gx, tail.gy + side, unit.typeData.speed, dt);
                return;
            }
        }
        // 护送模式：劫掠方近战单位敌远(>12格)时扑向"守备最薄"的车并站进劫持圈内——
        // 车已被 nearestEnemy 过滤，蓝方不主动去占就永远没人拉劫持进度（打赢护卫
        // 也会去追下一个红兵离开车身）。选车口径：圈(3格)内非溃逃护卫数优先压倒距离
        // （×100），已拉起的进度加权吸引续偷；等距取 id 小者决胜。敌近恢复正常接敌。
        if (scene.battleOptions.convoy && unit.team !== scene.convoy.team && !guardAnchor &&
            !unit.typeData.ranged && minD > 12) {
            let pick = null, best = Infinity;
            for (const w of scene.convoy.wagons) {
                if (w.dead || w.withdrawn) continue;
                let guards = 0;
                scene.forEachNear(w.gx, w.gy, 3, u => {
                    if (u === w || u.type === 'wagon' || u.dead || u.withdrawn ||
                        u.moraleState === 'routing' || u.team !== scene.convoy.team) return;
                    if (Math.hypot(u.gx - w.gx, u.gy - w.gy) > 3) return;
                    guards++;
                });
                const score = guards * 100 + dist(unit, w) - (w.hijack || 0) * 60;
                if (score < best - 1e-9 || (Math.abs(score - best) <= 1e-9 && w.id < pick.id)) { best = score; pick = w; }
            }
            if (pick) {
                unit.target = nearest;
                const side = unit.gy >= pick.gy ? 1.2 : -1.2;   // 站进劫持圈(3格)内贴身
                moveToward(unit, pick.gx, pick.gy + side, unit.typeData.speed, dt);
                return;
            }
        }

        if (unit.typeData.ranged) {
            const terrain = scene.battleOptions.terrain;
            const targetRange = Terrain.rangedRange(terrain, unit, nearest);
            // 弓箭手：射程内集火同一残血目标（血量主导、id 决胜），保持距离放风筝
            if (guardAnchor) {
                const fromPost = dist(unit, guardAnchor);
                unit.groundGuardTarget = minD <= targetRange ? nearest : null;
                if (fromPost > unit.guardRadius || (minD >= 3.2 && fromPost > 0.2)) {
                    unit.groundGuardReturning = true;
                    moveToward(unit, guardAnchor.gx, guardAnchor.gy, unit.typeData.speed * 0.92, dt);
                } else if (minD < 3.2) {
                    const angle = Math.atan2(unit.gy - nearest.gy, unit.gx - nearest.gx);
                    moveToward(unit, unit.gx + Math.cos(angle) * 3, unit.gy + Math.sin(angle) * 3,
                        unit.typeData.speed * 0.92, dt);
                }
            } else if (minD > targetRange) {
                moveToward(unit, nearest.gx, nearest.gy, unit.typeData.speed * 0.55, dt);
            } else if (minD < 3.2) {
                // 敌人逼近：边退边让队友输出
                const a = Math.atan2(unit.gy - nearest.gy, unit.gx - nearest.gx);
                moveToward(unit, unit.gx + Math.cos(a) * 3, unit.gy + Math.sin(a) * 3, unit.typeData.speed * 0.92, dt);
            } else if (unit.strafeUntil > now) {
                // 射程内横向拉扯走位中：站桩对射是木桩，箭有散布、走位让敌方瞄准陈旧化
                if (Math.hypot(unit.strafeX - unit.gx, unit.strafeY - unit.gy) < 0.12) {
                    unit.strafeUntil = 0;
                } else {
                    moveToward(unit, unit.strafeX, unit.strafeY, unit.typeData.speed * 0.8, dt);
                }
            }
            if (now - unit.lastAttack > unit.typeData.atkSpeed) {
                let shootTarget = null, bestScore = Infinity;
                scene.forEachNear(unit.gx, unit.gy, range * Terrain.MAX_RANGE_MULTIPLIER, e => {
                    if (e.team === unit.team || e.dead || e.withdrawn) return;
                    if (dist(unit, e) > Terrain.rangedRange(terrain, unit, e)) return;
                    // 火力纪律：正在冲锋且朝己方逼近的敌骑压过残血集火——等它贴脸不如现在就射。
                    // 冲锋朝向读帧首快照，保证换座对称（见 advanceBattle 帧首注释）。
                    const incoming = e.type === 'cavalry' &&
                        (e.chargeViewState === 'charge' || e.chargeViewState === 'pierce') &&
                        (unit.gx - e.gx) * (e.chargeViewX ?? 0) + (unit.gy - e.gy) * (e.chargeViewY ?? 0) > 0;
                    const score = e.hp * 1000 + e.id - (incoming ? 1e7 : 0);
                    if (score < bestScore) { bestScore = score; shootTarget = e; }
                });
                if (shootTarget) {
                    unit.lastAttack = now;
                    scene.playAttackAnim(unit, shootTarget);
                    // 攻击间隙横向拉扯（仅自由弓手、敌在 3.2~射程的站桩区）：
                    // 复用近战 strafe 的占位检查与确定性随机（unitRand 按镜像对称位置
                    // 播种、方向 mir 取反），换座配对弓手走位严格镜像；守位弓手
                    // 以锚为令不走位，敌近后退/超界回锚的优先级都不受影响。
                    if (!guardAnchor && minD >= 3.2 && minD <= targetRange && now > (unit.nextShift ?? 0)) {
                        unit.nextShift = now + 1400 + unitRand(unit) * 2600;
                        const mir = unit.team === 'red' ? 1 : -1;   // 蓝方角度取反：与红方配对单位行为严格镜像
                        const side = unitRand(unit) < 0.5 ? 1 : -1;
                        const perp = Math.atan2(unit.gy - nearest.gy, unit.gx - nearest.gx) + mir * side * Math.PI / 2;
                        const step = 0.8 + unitRand(unit) * 0.8;
                        const sx = clamp(unit.gx + Math.cos(perp) * step, 1.2, board.W - 1.2);
                        const sy = clamp(unit.gy + Math.sin(perp) * step, 1.2, board.H - 1.2);
                        let taken = false;
                        scene.forEachNear(sx, sy, 0.42, o => {
                            if (o !== unit && o.team === unit.team && !o.dead && !o.withdrawn &&
                                Math.hypot(o.gx - sx, o.gy - sy) < 0.42) taken = true;
                        });
                        if (!taken) {
                            unit.strafeX = sx; unit.strafeY = sy;
                            unit.strafeUntil = now + 500 + unitRand(unit) * 400;
                        }
                    }
                    const victim = shootTarget;
                    const actionEpoch = unit.actionEpoch;
                    // 拉弓 → 松弦放箭（与动画同步）
                    scene.scheduleBattleAction(110, () => {
                        if (unit.dead || unit.withdrawn || unit.moraleState === 'routing' || unit.actionEpoch !== actionEpoch ||
                            victim.dead || victim.withdrawn || scene.battleOver) return;
                        if (terrain !== 'flat' && dist(unit, victim) > Terrain.rangedRange(terrain, unit, victim)) return;
                        scene.fireArrow(unit, victim);
                    });
                }
            }
        } else {
            // 微走位中：绕目标换角度，期间不攻击（找角度的节奏，不站桩）。
            // 走位/逼近都不是"冷却就绪却打不出去"的受阻现场：受阻计时随脱离
            // 接战清零，回来后重新累计，不吃离开前的旧时间戳直接换目标。
            if (unit.strafeUntil > now) {
                unit.blockedEngageAt = null;
                if (Math.hypot(unit.strafeX - unit.gx, unit.strafeY - unit.gy) < 0.12) {
                    unit.strafeUntil = 0;
                } else {
                    moveToward(unit, unit.strafeX, unit.strafeY, unit.typeData.speed * 0.8, dt);
                }
            } else if (minD > range || !Terrain.segmentClear(scene.battleOptions.terrain, unit.gx, unit.gy, nearest.gx, nearest.gy)) {
                unit.blockedEngageAt = null;
                // 遇骑结阵：矛邻成排且来骑弹道朝本队压来（±60°）时停步——
                // 停稳半秒即触发现有架枪快照，行军矛兵就地变临时枪墙。
                // 只停步不转向：行军矛枪口本来就朝着敌线，正面来骑正好迎击；
                // 侧后突袭照常行军——转向有代价，不能瞬间变正面屏障（见 battle-engine 侧后测试）。
                // 架枪中的长枪兵钉死原地迎击；其余贴"接战环"逼近——不叠目标中心，多人自然围开。
                // 守阵哨位是面墙不是点目标：贴正面硬攻不绕位——绕位会把整面墙拆成一个个被围死的哨位。
                const rider = unit.type === 'pikeman' && unit.braceSupport >= 2 ? scene.incomingCharge(unit, 7) : null;
                if (rider) {
                    // 钉死原地，保持行进朝向迎击
                } else if (!Terrain.segmentClear(scene.battleOptions.terrain, unit.gx, unit.gy, nearest.gx, nearest.gy)) {
                    moveToward(unit, nearest.gx, nearest.gy, unit.typeData.speed, dt);
                } else if (unit.type === 'pikeman' && unit.braceHold) {
                    // 钉死原地，迎击
                } else if (nearest.tacticalRole === 'guard') {
                    moveToward(unit, nearest.gx, nearest.gy, unit.typeData.speed, dt);
                } else if (scene.battleOptions.control && !guardAnchor && !unit.typeData.ranged &&
                    scene.flags.some(f => f.owner !== unit.team && Math.hypot(f.gx - unit.gx, f.gy - unit.gy) <= 2.8)) {
                    // 已在非己方旗圈内：站住守旗不追出圈，敌贴身由攻击分支结算
                } else {
                    const rr = Math.max(0.5, range * 0.82);
                    const ang = Math.atan2(unit.gy - nearest.gy, unit.gx - nearest.gx);
                    let tx = nearest.gx + Math.cos(ang) * rr, ty = nearest.gy + Math.sin(ang) * rr;
                    // F 战线连贯（轻量起步）：未接战的剑士与最近同队剑士脱节时向邻兵收拢——
                    // 各自直奔最近敌会把正面拉成散兵线，肩并肩推进才有局部人数优势；
                    // 落点取"接敌环位与邻兵位的中点"，保住前向分量不停步互等，
                    // 近于阈值即恢复正常追敌。前排溃口由同机制覆盖：缺口两侧脱节自然靠拢。
                    // 邻兵查询过滤界=查询界(4.5)，桶毛边不泄漏，无需镜像量化。
                    if (unit.type === 'infantry' && minD > 2.2) {
                        let neighbor = null, nd = Infinity;
                        scene.forEachNear(unit.gx, unit.gy, 4.5, o => {
                            if (o === unit || o.team !== unit.team || o.type !== 'infantry' ||
                                o.dead || o.withdrawn || o.moraleState === 'routing') return;
                            const d = Math.hypot(o.gx - unit.gx, o.gy - unit.gy);
                            if (d > 4.5) return;
                            if (d < nd - 1e-9 || (Math.abs(d - nd) <= 1e-9 && o.id < neighbor.id)) { nd = d; neighbor = o; }
                        });
                        if (neighbor && nd > 2.0) {
                            tx = (tx + neighbor.gx) / 2; ty = (ty + neighbor.gy) / 2;
                        }
                    }
                    moveToward(unit, tx, ty, unit.typeData.speed, dt);
                }
            } else {
                const lastAttackBefore = unit.lastAttack;
                // 受阻接战检测：冷却已就绪却打不出去（枪线被友军挡住等）即视为受阻；
                // 只在攻击分支内统计（接近分支自带移动）。骑兵有自己的近战-重整-
                // 脱离状态机（melee/reform 循环），不经此处理；守阵哨位是钉死的墙
                // 不参与；有 2+ 矛邻支撑的枪兵是枪墙的一部分，站桩等前排打出缺口
                // 是本分——换目标出手会把它们卷进攻击间隙走位、溶解阵型密度
                // （braceSupport 掉线，抗骑能力崩），集群枪兵整体不进受阻处理。
                const laneBlocked = unit.type !== 'cavalry' && unit.tacticalRole !== 'guard' &&
                    !(unit.type === 'pikeman' && unit.braceSupport >= 2) &&
                    now - unit.lastAttack > unit.typeData.atkSpeed &&
                    !CombatRules.canStrike(scene, unit, nearest, range);
                CombatRules.attack(scene, unit, nearest, now, range);
                // 攻击间隙走位：绕目标弧线换攻击角，占了的位就转下一格（抢位围杀）。
                // 架枪中的长枪兵保持枪阵不挪窝；随机量走单位种子，保住确定性重放。
                // 守阵哨位是钉死的墙，绕哨位抢位没有意义，还会把守军姿态搅散——不对其走位。
                if (unit.lastAttack !== lastAttackBefore) {
                    unit.blockedEngageAt = null;
                    if (unit.nextShift == null) unit.nextShift = now + 800 + unitRand(unit) * 2600;   // 首次命中后错峰
                    if (now > unit.nextShift && !(unit.type === 'pikeman' && unit.braceHold) && nearest.tacticalRole !== 'guard') {
                        unit.nextShift = now + 1200 + unitRand(unit) * 2200;
                        const mir = unit.team === 'red' ? 1 : -1;   // 蓝方角度取反：与红方配对单位行为严格镜像
                        const cur = Math.atan2(unit.gy - nearest.gy, unit.gx - nearest.gx);
                        const nr = Math.max(0.55, range * 0.85);
                        let pickAng = cur + mir * (unitRand(unit) < 0.5 ? 1 : -1) * (0.7 + unitRand(unit) * 0.7);
                        for (let t = 0; t < 4; t++) {
                            const sx = clamp(nearest.gx + Math.cos(pickAng) * nr, 1.2, board.W - 1.2);
                            const sy = clamp(nearest.gy + Math.sin(pickAng) * nr, 1.2, board.H - 1.2);
                            let taken = false;
                            scene.forEachNear(sx, sy, 0.42, o => {
                                if (o !== unit && o.team === unit.team && !o.dead
                                    && Math.hypot(o.gx - sx, o.gy - sy) < 0.42) taken = true;
                            });
                            if (!taken) {
                                unit.strafeX = sx; unit.strafeY = sy;
                                unit.strafeUntil = now + 500 + unitRand(unit) * 400;
                                break;
                            }
                            pickAng += mir * (t % 2 === 0 ? 0.9 : -0.9);
                        }
                    }
                } else if (laneBlocked) {
                    // 冷却就绪却打不出去：持续受阻才解困（换可打目标/挪合法出枪位），
                    // 尝试按 BLOCKED_SCAN_MS 节流，瞬时阻挡不打扰目标粘滞。
                    if (unit.blockedEngageAt == null) unit.blockedEngageAt = now;
                    else if (now - unit.blockedEngageAt >= BLOCKED_ENGAGE_MS && now >= (unit.blockedScanAt ?? 0)) {
                        unit.blockedScanAt = now + BLOCKED_SCAN_MS;
                        resolveBlockedEngage(scene, unit, nearest, now, range);
                    }
                } else unit.blockedEngageAt = null;
            }
        }
}

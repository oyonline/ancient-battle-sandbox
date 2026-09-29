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
            // 微走位中：绕目标换角度，期间不攻击（找角度的节奏，不站桩）
            if (unit.strafeUntil > now) {
                if (Math.hypot(unit.strafeX - unit.gx, unit.strafeY - unit.gy) < 0.12) {
                    unit.strafeUntil = 0;
                } else {
                    moveToward(unit, unit.strafeX, unit.strafeY, unit.typeData.speed * 0.8, dt);
                }
            } else if (minD > range || !Terrain.segmentClear(scene.battleOptions.terrain, unit.gx, unit.gy, nearest.gx, nearest.gy)) {
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
                CombatRules.attack(scene, unit, nearest, now, range);
                // 攻击间隙走位：绕目标弧线换攻击角，占了的位就转下一格（抢位围杀）。
                // 架枪中的长枪兵保持枪阵不挪窝；随机量走单位种子，保住确定性重放。
                // 守阵哨位是钉死的墙，绕哨位抢位没有意义，还会把守军姿态搅散——不对其走位。
                if (unit.lastAttack !== lastAttackBefore) {
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
                }
            }
        }
}

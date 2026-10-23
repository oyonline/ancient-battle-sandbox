import { CAMP_LAYOUT as L } from './layout.js';

// Keep shared allocation quotas and post identities; skip tower-covered positions
// only in siege3d. Ground archers use their existing line, gate ranks their arcs.
export function avoidTowerPosts(siege, bounds) {
    const defense = siege.defense, towers = siege.platforms.filter(p => p.kind === 'tower');
    defense.skippedTowerPosts = new Map();
    const blocked = p => towers.some(t => p.gx >= t.x1 - L.towerClearance && p.gx <= t.x2 + L.towerClearance &&
        p.gy >= t.y1 - L.towerClearance && p.gy <= t.y2 + L.towerClearance);
    let gatePlaced = false;
    function placePosts() {
        if (defense.gatePosts.length && !gatePlaced) {
            // Fill the existing .8-spaced ranks using .25 arc slots, skipping the
            // tower footprint. The 100-man formation still fits in three ranks.
            const slots = [];
            for (let row = 0; slots.length < defense.gatePosts.length; row++) {
                const radius = 2.5 + row * .8, count = Math.floor(Math.PI * radius / .25);
                for (let i = 0; i < count; i++) {
                    const angle = Math.PI * (i + .5) / count;
                    const p = { gx: bounds.cx + radius * Math.cos(angle), gy: bounds.y2 - radius * Math.sin(angle) };
                    if (!blocked(p)) slots.push(p);
                }
            }
            defense.gatePosts.forEach((post, i) => {
                if (blocked(post)) defense.skippedTowerPosts.set(post.id, {
                    original: { gx: post.gx, gy: post.gy }, replacement: slots[i]
                });
                Object.assign(post, slots[i]);
            });
            // Skipping slots changes rank capacity. Retain nearest-troops-first
            // allocation, then pair each rank by distance to its actual free slots.
            const members = [...defense.assignments].filter(([, a]) => a.role === 'gate');
            const distance = (u, p) => Math.hypot(u.gx - p.gx, u.gy - p.gy);
            const radiusOf = p => Math.round(distance(p, defense.gateCenter) * 10);
            for (const radius of [...new Set(defense.gatePosts.map(radiusOf))]) {
                const rank = defense.gatePosts.filter(p => radiusOf(p) === radius);
                const front = members.sort(([a], [b]) => distance(a, defense.gateCenter) - distance(b, defense.gateCenter) || a.id - b.id)
                    .splice(0, rank.length);
                const pairs = front.flatMap(([unit, assignment]) => rank.map((post, index) => ({ unit, assignment, post, index })))
                    .sort((a, b) => distance(a.unit, a.post) - distance(b.unit, b.post) || a.unit.id - b.unit.id || a.index - b.index);
                const usedUnits = new Set(), usedPosts = new Set();
                for (const { unit, assignment, post } of pairs) {
                    if (usedUnits.has(unit) || usedPosts.has(post)) continue;
                    assignment.post = post; usedUnits.add(unit); usedPosts.add(post);
                }
            }
            gatePlaced = true;
        }
        const posts = [...new Set([...defense.wallPosts, ...defense.gatePosts,
            ...[...defense.assignments.values()].map(a => a.post)])];
        for (const post of posts) {
            if (!blocked(post)) continue;
            const original = { gx: post.gx, gy: post.gy };
            const vertical = post.side === 'west' || post.side === 'east';
            let replacement;
            for (let i = 1; i <= 80 && !replacement; i++) for (const sign of [-1, 1]) {
                const offset = sign * i * .25;
                const p = { gx: post.gx + (vertical ? 0 : offset), gy: post.gy + (vertical ? offset : 0) };
                if (p.gx < bounds.x1 + .65 || p.gx > bounds.x2 - .65 ||
                    p.gy < bounds.y1 + .65 || p.gy > bounds.y2 - .65 || blocked(p)) continue;
                if (posts.some(other => other !== post && Math.hypot(p.gx - other.gx, p.gy - other.gy) < .24)) continue;
                replacement = p;
                break;
            }
            if (!replacement) throw new Error(`No free siege post outside towers: ${post.id}`);
            defense.skippedTowerPosts.set(post.id, { original, replacement });
            Object.assign(post, replacement);
        }
    }
    const deploy = defense.deploy;
    defense.deploy = function (units, placements) {
        deploy.call(this, units, placements);
        placePosts();
        for (const p of placements) {
            const assignment = defense.assignments.get(p.unit);
            if (assignment) Object.assign(p, { gx: assignment.post.gx, gy: assignment.post.gy });
        }
    };
    const step = siege.step;
    siege.step = (scene, dt) => { step(scene, dt); placePosts(); };
}

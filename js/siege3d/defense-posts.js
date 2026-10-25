import { CAMP_LAYOUT as L } from './layout.js';

// Keep shared allocation quotas and post identities; skip tower-covered positions
// only in siege3d. Ground archers use their existing line, gate ranks their arcs.
export function avoidTowerPosts(siege, bounds) {
    const defense = siege.defense, towers = siege.platforms.filter(p => p.kind === 'tower');
    defense.skippedTowerPosts = new Map();
    const blocked = p => towers.some(t => p.gx >= t.x1 - L.towerClearance && p.gx <= t.x2 + L.towerClearance &&
        p.gy >= t.y1 - L.towerClearance && p.gy <= t.y2 + L.towerClearance);
    function placePosts() {
        // Gate ranks keep their U-pocket shape from siege-defense: those posts are
        // generated with tower avoidance built in, so only wall posts move here.
        const posts = [...new Set([...defense.wallPosts,
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

import { CAMP_RULES } from './camps.js';

// Terrain height units: 1 height = HEIGHT_SCALE screen pixels = H_WORLD world units.
export function createSiegeLayer(platforms = []) {
    const rects = platforms.map(p => ({ ...p }));
    const heightAt = (gx, gy) => {
        let height = 0;
        for (const p of rects) {
            if (gx >= p.x1 && gx <= p.x2 && gy >= p.y1 && gy <= p.y2) height = Math.max(height, p.height);
        }
        return height;
    };
    return {
        platforms: rects,
        heightAt,
        damageScale(from, target) {
            const difference = heightAt(from.gx, from.gy) - heightAt(target.gx, target.gy);
            let scale = 1;
            if (difference >= .4) scale *= CAMP_RULES.WALL_GUARD_ATTACK;
            if (-difference >= .4) scale *= CAMP_RULES.WALL_GUARD_COVER;
            return scale;
        }
    };
}

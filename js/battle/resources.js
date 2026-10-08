// Deterministic single-resource economy. Supplies become military funds only
// when a living worker physically delivers them to its own surviving home.
import { board } from '../board.js';
import { homePosition } from '../territory-map.js';
import { activeTeams } from '../factions.js';
import { moveToward } from '../units.js';
import { quantizeDecision as q } from './determinism.js';

export const RESOURCE_RULES = { CAPACITY: 20, RATE: 4, STOCK: 1200, REACH: 2 };
export class ResourceSystem {
    constructor(scene) {
        this.scene = scene;
        this.nodes = activeTeams(scene).map((team, id) => {
            const home = homePosition(team, board.W, board.H, scene.battleOptions?.coop);
            return { id, gx: home.gx + (team === 'blue' ? -10 : 10),
                gy: home.gy + (team === 'black' ? -10 : 9), remaining: RESOURCE_RULES.STOCK };
        });
    }
    worker(team, id) {
        const unit = this.scene.units.find(u => u.id === id);
        return unit && unit.team === team && unit.type === 'worker' && !unit.dead &&
            !unit.withdrawn && unit.moraleState !== 'routing' ? unit : null;
    }
    home(team) {
        const b = this.scene.territory.camps.getBuilding(`camp:${team}:home`);
        return b && !b.dead && b.complete ? b : null;
    }
    orderGather(team, id, nodeId) {
        const worker = this.worker(team, id), node = this.nodes.find(n => n.id === nodeId);
        if (!worker || !node || node.remaining <= 0 || !this.home(team)) return false;
        this.scene.territory.camps.releaseWorker(worker);
        worker.workerTask = { kind: 'gather', resource: node.id, phase: (worker.cargo || 0) >= RESOURCE_RULES.CAPACITY ? 'return' : 'outbound' };
        return true;
    }
    orderDeliver(team, id) {
        const worker = this.worker(team, id);
        if (!worker || !(worker.cargo > 0) || !this.home(team)) return false;
        this.scene.territory.camps.releaseWorker(worker);
        worker.workerTask = { kind: 'deliver', phase: 'return' };
        return true;
    }
    updateWorker(worker, dt) {
        if (!this.worker(worker.team, worker.id)) return;
        const task = worker.workerTask, home = this.home(worker.team);
        if (!home) { worker.workerTask = null; return; } // Preserve cargo; never mint funds after base loss.
        const node = this.nodes.find(n => n.id === task.resource);
        if (task.phase === 'return' || task.kind === 'deliver' || !node || node.remaining <= 0) {
            task.phase = 'return';
            if (q(Math.hypot(worker.gx-home.gx,worker.gy-home.gy)) > RESOURCE_RULES.REACH) {
                moveToward(worker,home.gx,home.gy,worker.typeData.speed*.85,dt); return;
            }
            const amount = worker.cargo || 0;
            this.scene.territory.econ.treasury[worker.team] += amount;
            this.scene.territory.econ.earned[worker.team] += amount;
            worker.cargo = 0;
            if (task.kind === 'gather' && node?.remaining > 0) task.phase = 'outbound';
            else worker.workerTask = null;
            return;
        }
        if (q(Math.hypot(worker.gx-node.gx,worker.gy-node.gy)) > RESOURCE_RULES.REACH) {
            task.phase = 'outbound'; moveToward(worker,node.gx,node.gy,worker.typeData.speed,dt); return;
        }
        task.phase = 'harvest';
        const amount = Math.min(node.remaining, RESOURCE_RULES.CAPACITY-(worker.cargo || 0), node.remaining <= RESOURCE_RULES.RATE*dt+1e-9 ? node.remaining : RESOURCE_RULES.RATE*dt);
        worker.cargo = Math.min(RESOURCE_RULES.CAPACITY, (worker.cargo || 0)+amount);
        node.remaining = Math.max(0,node.remaining-amount);
        if (worker.cargo >= RESOURCE_RULES.CAPACITY-1e-9 || node.remaining <= 1e-9) task.phase = 'return';
    }
    projection() { return this.nodes.map(n => [n.id, Math.round(n.remaining*1e6)]); }
}

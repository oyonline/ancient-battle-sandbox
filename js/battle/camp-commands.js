import { activeTeams } from '../factions.js';
// Both local controls and lockstep packets enter the same ownership-checked API.
export const CAMP_COMMANDS = new Set(['build', 'worker-move', 'garrison', 'ungarrison', 'attack-building']);

export function applyCampCommand(scene, command) {
    const camps = scene.territory?.camps;
    if (!camps || scene.battleOver || !activeTeams(scene).includes(command?.side)) return false;
    const team = command.side;
    switch (command.k) {
        case 'build':
            if (command.kind === 'tower' && (command.building || command.gx != null || command.gy != null)) {
                return camps.requestBuildAt(team, command.worker, command.kind, command.gx, command.gy, command.building);
            }
            return camps.requestBuild(team, command.worker, command.kind, command.site);
        case 'worker-move':
            return camps.orderWorkerMove(team, command.worker, command.gx, command.gy);
        case 'garrison':
            return camps.orderGarrison(team, command.units, command.building);
        case 'ungarrison':
            return camps.ungarrison(team, command.building);
        case 'attack-building':
            return camps.orderAttackBuilding(team, command.units, command.building);
        default:
            return false;
    }
}

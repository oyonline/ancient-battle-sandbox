// Owned by the local page, never by DOM callbacks or the rendering clock.
// Step numbers are 1-based; commands apply against the previous simulationTime.
export function createLocalSiegeCommands() {
    const queue = [], log = [];
    let step = 0;
    return {
        enqueue(command) { queue.push({ ...command }); },
        beforeStep(scene) {
            step++;
            for (const command of queue.splice(0)) {
                scene.applyNetCommand(command);
                log.push({ step, command: { ...command } });
            }
        },
        reset() { queue.length = log.length = 0; step = 0; },
        pending(face) { return queue.some(c => face === 'archers' ? c.k === 'siegeArchers' : face === 'ram' ? c.k === 'siegeRam' : c.k === 'siegeAssault' && c.face === face); },
        get log() { return log.map(row => ({ step: row.step, command: { ...row.command } })); },
        get pendingCount() { return queue.length; }
    };
}

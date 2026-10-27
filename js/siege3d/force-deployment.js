// DOM-free, serial latest-request scheduler. A stale async boot may never publish a scene.
export function createForceDeployment({ deploy, onState = () => {}, delay = 120,
    schedule = setTimeout, cancel = clearTimeout }) {
    let revision = 0, timer = null, running = false, config = null;
    let phase = 'pending', error = null;
    const state = () => ({ phase, config, error, canStart: phase === 'ready' });
    const notify = () => onState(state());
    function queue() {
        if (timer !== null) cancel(timer);
        const ticket = revision;
        timer = schedule(() => {
            timer = null;
            if (ticket === revision && phase === 'pending') void run();
        }, delay);
    }
    async function run() {
        if (running || phase === 'started') return;
        running = true;
        const ticket = revision, snapshot = structuredClone(config);
        const isCurrent = () => ticket === revision && phase !== 'started';
        phase = 'deploying'; notify();
        try {
            await deploy(snapshot, isCurrent);
            if (isCurrent()) { phase = 'ready'; error = null; notify(); }
        } catch (failure) {
            if (isCurrent()) { phase = 'error'; error = failure; notify(); }
        } finally {
            running = false;
            if (ticket !== revision && phase === 'pending') queue();
        }
    }
    return {
        get state() { return state(); },
        request(next) {
            if (phase === 'started') return false;
            config = structuredClone(next); revision++; phase = 'pending'; error = null;
            if (timer !== null) { cancel(timer); timer = null; }
            notify();
            if (!running) queue();
            return true;
        },
        retry() {
            if (phase !== 'error') return false;
            return this.request(config);
        },
        start() {
            if (phase !== 'ready') return false;
            revision++;
            if (timer !== null) { cancel(timer); timer = null; }
            phase = 'started'; notify();
            return structuredClone(config);
        },
        reset(next) {
            if (phase === 'started') phase = 'pending';
            return this.request(next);
        }
    };
}

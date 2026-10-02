// Bounded, view-only diagnostics. Never used to advance or make simulation decisions.
export class FrameStats {
    constructor(capacity = 240) {
        this.capacity = capacity;
        this.samples = [];
        this.next = 0;
    }

    record(frameMs, updateMs, simulationMs = 0) {
        if (!Number.isFinite(frameMs) || frameMs <= 0) return;
        this.samples[this.next] = { frameMs, updateMs, simulationMs };
        this.next = (this.next + 1) % this.capacity;
    }

    // 清空采样（诊断用：基准测量想从干净窗口开始）。只重置视图统计，不触碰模拟。
    reset() {
        this.samples = [];
        this.next = 0;
    }

    snapshot() {
        const samples = this.samples;
        if (!samples.length) return null;
        const frames = samples.map(s => s.frameMs).sort((a, b) => a - b);
        const mean = key => samples.reduce((n, s) => n + s[key], 0) / samples.length;
        return {
            samples: samples.length, fps: 1000 / mean('frameMs'),
            p95Ms: frames[Math.ceil(frames.length * 0.95) - 1],
            maxMs: frames[frames.length - 1], longFrames: frames.filter(ms => ms > 50).length,
            updateMs: mean('updateMs'), simulationMs: mean('simulationMs')
        };
    }

    describe(net = null) {
        const s = this.snapshot();
        if (!s) return '正在采样';
        let text = `近 ${s.samples} 帧 · P95 ${s.p95Ms.toFixed(1)}ms · 最慢 ${s.maxMs.toFixed(1)}ms · 超过50ms ${s.longFrames}帧\n` +
            `主循环 ${s.updateMs.toFixed(1)}ms · 模拟 ${s.simulationMs.toFixed(1)}ms（不含 GPU 绘制）`;
        if (net) text += `\n连续可执行 ${net.peerLead}步 · 同步等待 ${Math.round(net.waitMs)}ms · 最长 ${Math.round(net.longestWaitMs)}ms · 等待段 ${net.stallEvents}`;
        return text;
    }
}

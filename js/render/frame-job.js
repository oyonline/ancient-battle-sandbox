// Cooperative work on the render thread. A yielded step is the cancellation boundary.
export class FrameJob {
    constructor(iterator, { budgetMs = 8, now = () => performance.now() } = {}) {
        this.iterator = iterator;
        this.budgetMs = budgetMs;
        this.now = now;
        this.done = false;
        this.value = null;
        this.workMs = 0;
    }

    update() {
        if (this.done) return;
        const start = this.now();
        do {
            const step = this.iterator.next();
            this.done = step.done;
            this.value = step.value ?? this.value;
        } while (!this.done && this.now() - start < this.budgetMs);
        this.workMs += this.now() - start;
    }

    cancel() {
        if (!this.done) this.iterator.return?.();
        this.done = true;
    }
}

export function prioritizeChunks(width, height, size, center) {
    const chunks = [];
    for (let y = 0; y < height; y += size) for (let x = 0; x < width; x += size) {
        chunks.push({ x, y, width: Math.min(size, width - x), height: Math.min(size, height - y) });
    }
    return chunks.sort((a, b) =>
        Math.hypot(a.x + a.width / 2 - center.x, a.y + a.height / 2 - center.y) -
        Math.hypot(b.x + b.width / 2 - center.x, b.y + b.height / 2 - center.y));
}

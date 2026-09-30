// ==================== 音效（WebAudio 合成，无外部文件） ====================
export const Snd = {
    ctx: null, muted: false, _last: {},
    ensure() {
        if (!this.ctx) {
            try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
            catch (e) { this.ctx = null; }
        }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
    },
    tone(freq, dur, type = 'sine', vol = 0.12, slide = 0) {
        if (this.muted || !this.ensure()) return;
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type; o.frequency.setValueAtTime(freq, t);
        if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g).connect(this.ctx.destination);
        o.start(t); o.stop(t + dur);
    },
    play(name) {
        // 千人混战时同名音效可能每秒上百次：按类型限频，保护音频线程。
        // 近战命中族（hit/stab/charge）共享同一声部预算：混合兵种混战下三类
        // 不得并发各自放行，总播放密度与旧版单一 hit 持平——分流只改音色，
        // 不加声部（charge 同理只占一个声部）。
        const melee = name === 'hit' || name === 'stab' || name === 'charge';
        const bucket = melee ? 'melee' : name;
        const minGap = { melee: 70, die: 90, arrow: 90, buy: 80 }[bucket];
        if (minGap) {
            const now = performance.now();
            if (now - (this._last[bucket] || 0) < minGap) return;
            this._last[bucket] = now;
        }
        switch (name) {
            case 'buy':   this.tone(660, 0.07, 'triangle', 0.1); break;
            case 'tick':  this.tone(520, 0.09, 'square', 0.08); break;
            case 'go':    this.tone(880, 0.25, 'square', 0.12); break;
            case 'arrow': this.tone(900, 0.12, 'triangle', 0.05, -500); break;
            case 'hit':   this.tone(160, 0.08, 'square', 0.07); break;
            // 直刺：更短更尖的破空点，与挥砍的低频斩击分开（与 hit 共享近战声部预算）
            case 'stab':  this.tone(420, 0.05, 'triangle', 0.055, -240); break;
            // 冲锋撞击：单声部低频重锤，只随真实冲锋命中出现
            case 'charge': this.tone(92, 0.16, 'square', 0.1, -34); break;
            case 'die':   this.tone(300, 0.25, 'sawtooth', 0.05, -180); break;
            case 'lock':  this.tone(523, 0.09, 'triangle', 0.1); setTimeout(() => this.tone(784, 0.12, 'triangle', 0.1), 90); break;
            case 'win':   [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.22, 'triangle', 0.13), i * 130)); break;
        }
    }
};

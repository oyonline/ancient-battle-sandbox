// 浏览器入口：Phaser 全局由 index.html 里的 vendor 脚本先行提供（经典脚本先于模块执行）。
import { IsoBattleScene } from './game.js';
import { UI } from './ui.js';

const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-container',
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: '#1c3f5c',
    pixelArt: true,          // 像素风：NEAREST 硬边采样，放大不糊
    roundPixels: true,       // 像素对齐整数格，避免抖动
    antialias: false,
    scene: IsoBattleScene,
    scale: {
        mode: Phaser.Scale.RESIZE,
        width: '100%',
        height: '100%'
    }
});
window.addEventListener('load', () => UI.init());

// 渲染门面：场景只持一个 render 入口，子渲染器按层落位（world 地貌，units/fx/overlay 后续批次）。
import { WorldRenderer } from './world.js';
import { UnitRenderer } from './units.js';
import { EffectsRenderer } from './fx.js';
import { OverlayRenderer } from './overlay.js';
import { CameraRig } from './camera.js';

export class BattleRenderer {
    constructor(scene) { this.scene = scene; this.world = new WorldRenderer(scene);
        this.units = new UnitRenderer(scene);
        this.fx = new EffectsRenderer(scene);
        this.overlay = new OverlayRenderer(scene);
        this.camera = new CameraRig(scene); }
}

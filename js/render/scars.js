// Allocate battlefield scars only where combat happened, below live units.
// The enlarged map exceeds common GPU texture limits; each independent tile stays small.
export class ScarLayer {
    constructor(scene,tileSize=1024) {this.scene=scene;this.tileSize=tileSize;this.tiles=new Map();}

    draw(renderable,bounds=null) {
        if(Array.isArray(renderable)) {for(const item of renderable)this.draw(item);return this;}
        if(!renderable)return this;
        const rectangles=Array.isArray(bounds)?bounds:[bounds||renderable.getBounds?.()||this.fallbackBounds(renderable)];
        const keys=new Set(),size=this.tileSize;
        for(const r of rectangles) {
            if(!r||!Number.isFinite(r.x)||!Number.isFinite(r.y)||!(r.width>0)||!(r.height>0))continue;
            const x0=Math.floor(r.x/size),y0=Math.floor(r.y/size);
            const x1=Math.floor((r.x+r.width-1e-6)/size),y1=Math.floor((r.y+r.height-1e-6)/size);
            for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)keys.add(`${x},${y}`);
        }
        for(const key of keys) {
            let tile=this.tiles.get(key);
            if(!tile) {
                const [tx,ty]=key.split(',').map(Number),x=tx*size,y=ty*size;
                tile=this.scene.add.renderTexture(x,y,size,size).setOrigin(0,0).setDepth(9);
                this.tiles.set(key,tile);
            }
            // Phaser draw coordinates replace the object's local position for the stamp.
            // The live sprite itself keeps its transform; crossing a tile edge stamps both halves.
            tile.draw(renderable,(renderable.x||0)-tile.x,(renderable.y||0)-tile.y);
        }
        return this;
    }

    fallbackBounds(object) {
        const width=object.displayWidth||object.width||0,height=object.displayHeight||object.height||0;
        return {x:(object.x||0)-width*(object.originX??0.5),y:(object.y||0)-height*(object.originY??0.5),width,height};
    }
    clear() {for(const tile of this.tiles.values())tile.destroy();this.tiles.clear();return this;}
    destroy() {this.clear();}
}

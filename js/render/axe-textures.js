// Original canvas art: a broad axe and cloth tunic distinguish this troop from armoured swordsmen.
const WIDTH = 158, HEIGHT = 156;
const portraits = new Map();
export function drawAxe(ctx, offset, frame, clip, team) {
    ctx.save(); ctx.translate(offset, 0);
    const step = clip === 'walk' ? [0, 6, 0, -6][frame] : 0;
    const color = team === 'red' ? '#bd5143' : team === 'black' ? '#55535b' : '#487fc0';
    const poly = (points, fill) => {
        ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
        ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = '#38362f'; ctx.lineWidth = 3; ctx.stroke();
    };
    poly([[60,98],[77,98],[72+step,135],[58+step,135]], '#857968');
    poly([[78,98],[94,96],[98-step,134],[81-step,134]], '#a2947c');
    poly([[56+step,134],[74+step,134],[76+step,142],[53+step,142]], '#514637');
    poly([[80-step,133],[97-step,133],[101-step,142],[79-step,142]], '#64533e');
    poly([[55,62],[81,56],[99,69],[95,109],[59,109],[48,78]], '#dfd3b4');
    poly([[55,62],[67,58],[77,104],[63,107]], color);
    poly([[60,99],[96,98],[94,109],[60,109]], color);
    poly([[50,72],[60,74],[65,92],[53,99],[45,86]], '#d5ac84');
    ctx.fillStyle = '#dbb58d'; ctx.beginPath(); ctx.ellipse(76,43,14,17,0,0,Math.PI*2); ctx.fill();
    poly([[60,31],[77,24],[90,31],[90,39],[62,38]], '#b5ada0');
    ctx.fillStyle = '#403a32'; ctx.fillRect(85,44,3,3);
    const angle = clip === 'attack' ? [-0.45, -0.75, 0.65, 0.15][frame] : 0.1 + step * 0.008;
    ctx.save(); ctx.translate(95,84); ctx.rotate(angle);
    ctx.strokeStyle='#47392b';ctx.lineWidth=9;ctx.beginPath();ctx.moveTo(0,23);ctx.lineTo(0,-51);ctx.stroke();
    ctx.strokeStyle='#ae875a';ctx.lineWidth=5;ctx.beginPath();ctx.moveTo(0,23);ctx.lineTo(0,-51);ctx.stroke();
    poly([[-4,-53],[19,-60],[31,-50],[29,-32],[13,-24],[-4,-34]], '#c9d0cf');
    poly([[21,-57],[31,-50],[29,-32],[20,-29]], '#eef1df');
    ctx.restore();
    poly([[90,67],[103,70],[108,85],[97,91],[87,81]], '#dbb58d');
    ctx.restore();
}
export function axePortraitDataUrl(team) {
    if (portraits.has(team)) return portraits.get(team);
    if (typeof document === 'undefined' || !document.createElement) return '';
    const canvas = document.createElement('canvas'); canvas.width=WIDTH;canvas.height=HEIGHT;
    if (typeof canvas.getContext !== 'function' || typeof canvas.toDataURL !== 'function') return '';
    const context = canvas.getContext('2d');
    if (!context) return '';
    drawAxe(context,0,0,'walk',team);
    const url=canvas.toDataURL();portraits.set(team,url);return url;
}
export function ensureAxeTextures(scene) {
    if (!scene.textures?.createCanvas) return;
    for (const team of ['red','blue','black']) {
        const staticKey=`units/${team}_axe`;
        if (!scene.textures.exists(staticKey)) {
            const texture=scene.textures.createCanvas(staticKey,WIDTH,HEIGHT);
            drawAxe(texture.getContext(),0,0,'walk',team);texture.refresh();
        }
        for (const clip of ['walk','attack']) {
            const key=`assets/units/anim/${team}_axe_${clip}`;
            if (!scene.textures.exists(key)) {
                const texture=scene.textures.createCanvas(key,WIDTH*4,HEIGHT);
                for(let frame=0;frame<4;frame++) {drawAxe(texture.getContext(),frame*WIDTH,frame,clip,team);texture.add(frame,0,frame*WIDTH,0,WIDTH,HEIGHT);}
                texture.refresh();
            }
            if(!scene.anims.exists(key)) scene.anims.create({key,frames:scene.anims.generateFrameNumbers(key,{start:0,end:3}),frameRate:clip==='walk'?9:12,repeat:clip==='walk'?-1:0});
        }
    }
}

import { defineConfig } from 'vite';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
const localNames=new Set(['civilian-a.glb','civilian-a.json','civilian-c.glb','civilian-c.json']);
const localCivilianAssets={name:'local-civilian-assets',configureServer(server){server.middlewares.use((req,res,next)=>{let path=(req.url??'').split('?')[0];try{for(let i=0;i<2;i++)path=decodeURIComponent(path);}catch{res.statusCode=400;res.end();return;}if(path.includes('/local-assets/')){res.statusCode=403;res.end();return;}const prefix='/local-models/ac/';if(!path.startsWith(prefix))return next();if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)){res.statusCode=403;res.end();return;}const name=path.slice(prefix.length);if(!localNames.has(name)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',name.endsWith('.glb')?'model/gltf-binary':'application/json');res.setHeader('Cache-Control','no-cache');const stream=createReadStream(fileURLToPath(new URL('./local-assets/ac/'+name,import.meta.url)));stream.on('error',()=>{res.statusCode=404;res.end('Local model unavailable');});stream.pipe(res);});}};

// base 用相对路径：GitHub Pages 项目页 / 本地 dist / 任意静态托管都直接可用。
export default defineConfig({
    base: './',
    plugins: [localCivilianAssets],
    // dev 端口固定 5301（2026-10-03）：不配 port 会落 Vite 默认 5173，与 EP2.0 UI 的契约端口 5173 相撞。
    // 与对战服 arena.mjs 的 5300 同族，互不冲突。
    server: {
        port: 5301,
        fs: {deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/local-assets/**']}
    },
    build: {
        outDir: 'dist',
        rollupOptions: { input: { home: 'index.html', classic: 'classic.html', battle3d: 'battle3d.html', modelDuel: 'model-duel.html', civilianDuel: 'ac-duel.html' } }
    }
});

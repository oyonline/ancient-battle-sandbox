import { FORMATIONS } from '../units.js';

const PRESETS = { small: '小规模 250 人', standard: '标准 500 人', large: '大规模 600 人' };
// js/tactics.js:7 的标签（该常量未导出，保持既有模块接口不变）。
const TACTICS = { advance: '自由接敌', assault: '正面强攻', flank: '单翼迂回', hold: '枪阵守位', hold_ground: '高地守位' };
const options = entries => Object.entries(entries).map(([key, label]) => `<option value="${key}">${label}</option>`).join('');

export function createLanUI({ gate, exit }) {
    document.getElementById('controls').hidden = true;
    gate.classList.add('lan');
    gate.innerHTML = `<h1>局域网对战 · 3D 千人对冲</h1>
      <div id="lan-panel">
        <div id="lan-entry"><button id="lan-create">创建房间</button><input id="lan-code" maxlength="4" aria-label="房间码" autocomplete="off" placeholder="房间码"><button id="lan-join">加入</button></div>
        <div id="lan-room" hidden><div id="lan-room-code"></div><div id="lan-side"></div></div>
        <div id="lan-config" hidden>
          <label>兵力<select id="lan-preset">${options(PRESETS)}</select></label>
          <label>阵型<select id="lan-formation">${options(Object.fromEntries(Object.entries(FORMATIONS).map(([k, v]) => [k, v.name])))}</select></label>
          <label>战术<select id="lan-tactic">${options(TACTICS)}</select></label>
          <button id="lan-confirm" class="lan-primary">确定配置</button>
        </div>
        <div id="lan-peer"></div><div id="lan-status" role="status" aria-live="polite"></div>
        <button id="lan-exit" hidden>退出</button>
      </div>`;
    const $ = id => document.getElementById(id);
    $('lan-preset').value = 'standard';
    $('lan-formation').value = 'square';
    $('lan-tactic').value = 'assault';
    const countdown = document.createElement('div');
    countdown.id = 'lan-countdown'; countdown.setAttribute('aria-live', 'polite');
    document.body.append(countdown);
    const banner = document.createElement('div');
    banner.id = 'lan-banner'; banner.hidden = true;
    const message = document.createElement('span'), quit = document.createElement('button');
    quit.textContent = '退出'; quit.onclick = exit;
    banner.append(message, quit); document.body.append(banner);
    $('lan-exit').onclick = exit;
    $('lan-code').oninput = () => { $('lan-code').value = $('lan-code').value.toUpperCase(); };
    return {
        bind(session, unlockSound) {
            $('lan-create').onclick = () => { unlockSound(); session.requestRoom(); };
            const join = () => {
                if ($('lan-code').value.trim().length !== 4) return;
                unlockSound(); session.requestRoom($('lan-code').value);
            };
            $('lan-join').onclick = join;
            $('lan-code').onkeydown = event => { if (event.key === 'Enter') join(); };
            $('lan-confirm').onclick = () => {
                unlockSound();
                session.confirm({ preset: $('lan-preset').value, formation: $('lan-formation').value, tactic: $('lan-tactic').value });
            };
        },
        render(session) {
            const room = session.room;
            $('lan-entry').hidden = !!room;
            $('lan-room').hidden = $('lan-config').hidden = !room;
            $('lan-create').disabled = $('lan-join').disabled = !session.arena || session.pending || session.stopped;
            $('lan-code').disabled = session.pending || session.stopped;
            for (const id of ['lan-preset', 'lan-formation', 'lan-tactic', 'lan-confirm']) {
                $(id).disabled = session.locked || session.stopped;
            }
            if (room) {
                $('lan-room-code').textContent = room.code;
                $('lan-side').textContent = `你是 ${room.side === 'red' ? '红方' : '蓝方'}`;
                $('lan-side').style.color = room.side === 'red' ? '#ff8b76' : '#7fb7e8';
            }
            const peer = room && session.configs?.[room.side === 'red' ? 'blue' : 'red'];
            $('lan-peer').textContent = peer ? `对方：${PRESETS[peer.preset].replace(' 人', '')} · ${FORMATIONS[peer.formation].name} · ${TACTICS[peer.tactic]}` : '';
            $('lan-status').textContent = session.status; // 服务器 error.text 原样，禁止 innerHTML。
            $('lan-exit').hidden = !room;
            gate.hidden = session.started;
            countdown.textContent = session.countdown;
            countdown.classList.toggle('visible', !!session.countdown);
            const finished = session.state === 'finished';
            banner.hidden = !session.banner && !finished;
            banner.style.background = finished ? 'rgba(20,24,18,.88)' : '';
            banner.style.color = finished ? '#ffe3a0' : '';
            message.textContent = finished ? session.finishMessage : session.banner;
        }
    };
}

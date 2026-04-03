// ==================== UI 控制 ====================

function getConfig() {
    return {
        red: {
            infantry: parseInt(document.getElementById('red-infantry').value) || 0,
            pikeman: parseInt(document.getElementById('red-pikeman').value) || 0,
            archer: parseInt(document.getElementById('red-archer').value) || 0,
            cavalry: parseInt(document.getElementById('red-cavalry').value) || 0
        },
        blue: {
            infantry: parseInt(document.getElementById('blue-infantry').value) || 0,
            pikeman: parseInt(document.getElementById('blue-pikeman').value) || 0,
            archer: parseInt(document.getElementById('blue-archer').value) || 0,
            cavalry: parseInt(document.getElementById('blue-cavalry').value) || 0
        }
    };
}

function getFormations() {
    return {
        red: document.getElementById('red-formation').value || 'custom',
        blue: document.getElementById('blue-formation').value || 'custom'
    };
}

// ==================== 按钮事件绑定 ====================
function initUI(game) {
    document.getElementById('btn-deploy').onclick = () => {
        const cfg = getConfig();
        const formations = getFormations();
        const scene = game.scene.getScene('BattleScene');
        const success = scene.deployUnits(cfg.red, cfg.blue, formations.red, formations.blue);
        if (success) {
            document.getElementById('btn-start').disabled = false;
            document.getElementById('btn-deploy').disabled = true;
        }
    };

    document.getElementById('btn-start').onclick = () => {
        const scene = game.scene.getScene('BattleScene');
        const success = scene.startBattle();
        if (success) {
            document.getElementById('btn-start').disabled = true;
            document.getElementById('btn-deploy').disabled = true;
        }
    };

    document.getElementById('btn-pause').onclick = () => {
        const scene = game.scene.getScene('BattleScene');
        scene.togglePause();
    };

    document.getElementById('btn-slow').onclick = () => {
        const scene = game.scene.getScene('BattleScene');
        scene.setSpeed(0.5);
    };

    document.getElementById('btn-normal').onclick = () => {
        const scene = game.scene.getScene('BattleScene');
        scene.setSpeed(1);
    };

    document.getElementById('btn-fast').onclick = () => {
        const scene = game.scene.getScene('BattleScene');
        scene.setSpeed(2);
    };

    document.getElementById('btn-restart').onclick = () => {
        const cfg = getConfig();
        const scene = game.scene.getScene('BattleScene');
        scene.restart(cfg.red, cfg.blue);
        document.getElementById('btn-start').disabled = true;
        document.getElementById('btn-deploy').disabled = false;
    };

    document.getElementById('btn-reset').onclick = () => {
        document.getElementById('red-infantry').value = 0;
        document.getElementById('red-pikeman').value = 0;
        document.getElementById('red-archer').value = 0;
        document.getElementById('red-cavalry').value = 0;
        document.getElementById('blue-infantry').value = 0;
        document.getElementById('blue-pikeman').value = 0;
        document.getElementById('blue-archer').value = 0;
        document.getElementById('blue-cavalry').value = 0;
        document.getElementById('red-formation').value = 'custom';
        document.getElementById('blue-formation').value = 'custom';
        
        const scene = game.scene.getScene('BattleScene');
        scene.restart(null, null);
        document.getElementById('btn-start').disabled = true;
        document.getElementById('btn-deploy').disabled = false;
    };
}

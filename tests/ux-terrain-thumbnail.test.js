import test from 'node:test';
import assert from 'node:assert/strict';
import { UI } from '../js/ui.js';
import { board, setBoardSize } from '../js/board.js';
import { TERRITORY } from '../js/battle/economy.js';

for (const dimensions of [
    { W: TERRITORY.W, H: TERRITORY.H, MARGIN: 5 },
    { W: 70, H: 70, MARGIN: 0 }
]) {
    for (const failDrawing of [false, true]) {
        test(`territory thumbnail restores ${dimensions.W}×${dimensions.H} board and margin${failDrawing ? ' after drawing throws' : ''}`, t => {
            const originalDocument = globalThis.document;
            const originalBoard = { ...board };
            t.after(() => {
                globalThis.document = originalDocument;
                setBoardSize(originalBoard.W, originalBoard.H, originalBoard.MARGIN);
            });
            setBoardSize(dimensions.W, dimensions.H, dimensions.MARGIN);
            let drawingSize, completedFlags = 0;
            const context = {
                clearRect() { drawingSize = { ...board }; },
                fillRect() {}, beginPath() {}, fill() {}, stroke() {},
                ellipse() { if (failDrawing) throw new Error('canvas drawing failure'); },
                arc() { completedFlags++; }
            };
            globalThis.document = { getElementById: () => ({ width: 248, height: 150, getContext: () => context }) };
            if (failDrawing) assert.throws(() => UI.drawTerritoryThumb(), /canvas drawing failure/);
            else {
                UI.drawTerritoryThumb();
                assert.equal(completedFlags, 11, 'the actual shared-geometry drawing path must complete');
            }
            assert.deepEqual(drawingSize, { W: TERRITORY.W, H: TERRITORY.H, MARGIN: 0 });
            assert.deepEqual(board, dimensions, 'next asynchronous terrain frame must observe the original board');
        });
    }
}

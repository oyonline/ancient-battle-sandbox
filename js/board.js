// ==================== 棋盘常量（最底层叶子模块） ====================
// 默认 70×70 大棋盘：模拟（部署/路线）与渲染（等距投影）共用。
// 原先定义在 game.js 顶部，units/tactics 也要用，抽成叶子模块避免与 game.js 循环依赖。
//
// 领土征服等大地图模式经 setBoardSize() 在部署前改尺寸；尺寸在整场战斗内固定，
// 所有模块统一读 board.W / board.H（不得缓存到局部常量，避免切图后读到旧值）。
export const DEFAULT_GRID_W = 70, DEFAULT_GRID_H = 70;
export const board = { W: DEFAULT_GRID_W, H: DEFAULT_GRID_H, MARGIN: 0 };

export function setBoardSize(w, h, margin = 0) {
    board.W = w;
    board.H = h;
    board.MARGIN = margin;   // 画外景深格数（领土图 5：陆地长到画面边缘外，渲染度量随之扩大）
}

export function resetBoardSize() {
    board.W = DEFAULT_GRID_W;
    board.H = DEFAULT_GRID_H;
    board.MARGIN = 0;
}

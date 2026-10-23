// Siege3d layout only. Simulation defaults remain in battle/siege.js.
const wallHeight = 2.4;
const baselineWallHeight = 1.75;
const baselineClimbSeconds = 2.5;
const towerCorners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
const towerArcherSlots = [{ x: -.38, z: -.3 }, { x: .38, z: -.3 }, { x: 0, z: .38 }];
export const CAMP_LAYOUT = {
    halfSize: 10,
    wallThickness: .3,
    wallHeight,
    braceHeights: [.75, 1.85],
    stakeTipHeight: .12 * wallHeight / baselineWallHeight,
    gateWidth: 2.4,
    gateLeafHeight: 2,
    gatePostHeight: 2.4,
    worldHeightScale: 2,
    walkwayHeight: 1.6,
    walkwayWidth: .6,
    towerHeight: 3.2,
    towerSize: 1.4,
    towerInset: 1.6,
    towerCorners,
    towerCount: towerCorners.length,
    towerArcherSlots,
    archersPerTower: towerArcherSlots.length,
    laddersPerSide: 4,
    sides: ['west', 'north', 'east', 'south'],
    ladderFootOffset: 1.3,
    ladderTopClearance: .15,
    southLadderGateClearance: 2,
    southLadderSpacing: 2,
    baselineWallHeight,
    baselineClimbSeconds,
    climbSeconds: baselineClimbSeconds * wallHeight / baselineWallHeight,
    attackers: { infantry: 450, pikeman: 80, archer: 70 },
    defenders: { infantry: 250, archer: 50 },
    attackShares: { south: .4, north: .2, east: .2, west: .2 },
    attackerWallClearance: 6,
    attackerColumns: 20,
    attackerSpacing: 1,
    attackerDepthSpacing: .85,
    defenderWallClearance: .38,
    defenderSpacing: .8,
    interiorInset: 1.3,
    towerClearance: .4
};
export const LADDER_TOP_WORLD = CAMP_LAYOUT.wallHeight + CAMP_LAYOUT.ladderTopClearance;

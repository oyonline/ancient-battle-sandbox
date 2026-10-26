// Siege3d layout only. Simulation defaults remain in battle/siege.js.
const wallHeight = 2.4;
const baselineWallHeight = 1.75;
const baselineClimbSeconds = 2.5;
const towerPositions = [
    { side: 'north', offset: 0 }, { side: 'east', offset: 0 },
    { side: 'west', offset: 0 }, { side: 'south', offset: 2.4 }
];
const towerArcherSlots = [{ x: -.38, z: -.3 }, { x: .38, z: -.3 }, { x: 0, z: .38 }];
export const CAMP_LAYOUT = {
    rules: {
        enabled: true, defenderTeam: 'blue', attackerTeam: 'red',
        defenderMoraleBonus: -.025, retreatRadius: 3, surrenderRadius: 4,
        surrenderFraction: .1, attackerRetreatFraction: .35, attackerStallSeconds: 20,
        captureRadius: 2.5, captureSeconds: 8, wallFootRadius: 2,
        ladderGuardDamage: 1.5, gateHp: 1800, fireDiscipline: true,
        interiorMeleeCover: .8, climbersPerLadder: 1,
        deadZone: 1.5, advanceRadius: 18, walkwayRangeScale: 1.1, towerRangeScale: 1.2, ramRoofCover: .3
    },
    halfSize: 10,
    wallThickness: .3,
    wallHeight,
    fenceCover: .5,
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
    towerPositions,
    towerCount: towerPositions.length,
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
    attackers: { infantry: 235, pikeman: 40, archer: 25 },
    defenders: { infantry: 80, archer: 20 },
    attackShares: { south: .4, north: .2, east: .2, west: .2 },
    attackerFrontClearance: 32,
    boardSize: { w: 100, h: 100 },
    archerRange: 20,
    stagingClearance: 27,
    archerLineClearance: 18.5,
    attackerEdgeMargin: 1.5,
    attackerSpacing: 1,
    attackerDepthSpacing: .85,
    defenderWallClearance: .38,
    defenderSpacing: .8,
    interiorInset: 1.3,
    towerClearance: .4
};
export const LADDER_TOP_WORLD = CAMP_LAYOUT.wallHeight + CAMP_LAYOUT.ladderTopClearance;

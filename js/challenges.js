// 固定敌阵、自由解法。所有关卡都可直接尝试，胜利记录只保存在本机。
const CHALLENGES = [
    {
        id: 'hold-the-charge', title: '挡住铁骑', subtitle: '第一课 · 找到克制',
        icon: '🔱', unit: 'cavalry', difficulty: '入门', budget: 300,
        enemy: { cavalry: 25 }, enemyFormation: 'wedge',
        description: '二十五名重骑士迎面而来。双方预算相同，该怎样迎击？',
        hint: '枪兵需要正面站稳、相互支撑。试试少量剑士顶在前面，减少枪阵连续受冲击；伤亡过快也会动摇军心。'
    },
    {
        id: 'break-the-volley', title: '穿过箭雨', subtitle: '第二课 · 接近远程',
        icon: '🏹', unit: 'archer', difficulty: '入门', budget: 480,
        enemy: { archer: 45 }, enemyFormation: 'line',
        description: '敌军弓手已经列阵。怎样才能尽快接近他们？',
        hint: '骑兵会优先寻找附近弓手。试试集中突进，再与纯步兵比较。'
    },
    {
        id: 'mixed-front', title: '枪林之后', subtitle: '第三课 · 组合兵种',
        icon: '⚔️', unit: 'pikeman', difficulty: '进阶', budget: 700,
        enemy: { pikeman: 40, archer: 30 }, enemyFormation: 'custom',
        description: '长枪与弓箭相互掩护，一种兵能解决所有问题吗？',
        hint: '观察哪种兵先被消耗。让近战吸引火力，给远程创造输出时间。'
    },
    {
        id: 'outnumbered', title: '以少胜多', subtitle: '第四课 · 花好每枚金币',
        icon: '🛡️', unit: 'infantry', difficulty: '进阶', budget: 800,
        enemy: { infantry: 140 }, enemyFormation: 'square',
        description: '一百四十名剑士组成战线。尝试用更精简的军队赢下这一局。',
        hint: '胜利目标仍是击败敌军。远程火力与机动兵种可能比堆人数更有效。'
    },
    {
        id: 'commanders-trial', title: '统帅试炼', subtitle: '终章 · 找到你的解法',
        icon: '👑', unit: 'cavalry', difficulty: '挑战', budget: 1400,
        enemy: { infantry: 80, pikeman: 25, archer: 45, cavalry: 25 }, enemyFormation: 'mixed',
        description: '四种兵协同出击。用前几关的经验，组建自己的精锐军团。',
        hint: '先打一局看战报，每次只调整一两种兵，比较损失和击杀的变化。'
    }
];

function armyCost(config) {
    return Object.entries(UNIT_TYPES).reduce((sum, [key, type]) => sum + (config[key] || 0) * type.cost, 0);
}

function fitArmyToBudget(config, budget) {
    const army = {};
    for (const [key, type] of Object.entries(UNIT_TYPES)) {
        const count = Number.isFinite(config[key]) ? Math.floor(config[key]) : 0;
        army[key] = Math.max(0, Math.min(type.maxCount, count));
    }
    const cost = armyCost(army);
    if (cost > budget) {
        for (const key of Object.keys(army)) army[key] = Math.floor(army[key] * budget / cost);
    }
    return army;
}

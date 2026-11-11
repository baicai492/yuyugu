// 托管参数的默认值（Chrome 插件和 Node 版共用）。用户改过的项只存差异，运行时和这份默认值合并。
export const DEFAULTS = {
  enabled: false, // 插件里的总开关；Node 版不看这个
  dry: false, // 演练：只算计划、不提交
  autoTab: true, // 插件：托管开着但没有站点标签页时，自动开一个固定标签页
  invest: { enabled: true, maxPaybackDays: 10, reserveCoins: 3000000 },
  price: { longRun: 1.3 }, // 长期资产估值：基础价 × 这个系数（择时卖出的长期平均水平，偏保守）
  farm: { water: true },
  food: { reserveE: 600, maxStockE: 2500 },
  energy: { coffee: true },
  fish: { enabled: true, windowRatio: 0.97, deadlineSec: 1200 },
  mine: { enabled: true, bomb: true },
  craft: { enabled: true, minMargin: 0.04, hoardMax: 240 },
  sell: { enabled: true, horizonIsleDays: 7, ratio: 0.97, tier2Above: 450 },
  cargo: { enabled: true, minMargin: 0.1 },
  npc: { enabled: true, maxPerVisit: 60 },
  help: { enabled: false, perDay: 10, maxPages: 5, minEnergy: 30 },
  // 防偷：成熟即收是主防线（成熟后 30 分钟内别人偷不了）；下面这些是给「没法及时收」的情况兜底
  defense: { guardItems: true, alert: 'guard1', combat: 'guard2', protect: 1800, safeAnimals: true, keepAwake: true },
  offline: { enabled: false, from: '01:00', to: '08:30' }, // 每天浏览器关着的时段（北京时间）：种地计划会避开在这段时间里成熟
  // 擂台日常（不花 D币）：打低级对手拿装备和宝箱、自动穿最好的装备 → 守家和偷菜的对战更能打
  arena: { enabled: true, battles: 30, perVisit: 5, equip: true, points: true, spend: 'auto', dailyBudget: 150000 }, // spend：花 D币 训练 / 买装备 / 强化。auto = 开了偷菜或离线时段才花
  // 自动偷菜（默认关）：盯着别人的地，保护期一结束就去偷
  steal: { enabled: false, minEV: 3000, energyValue: 300, dirEvery: 7200, dirPages: 60, visitsPerScan: 30, recheck: 1800, prep: 15, lead: 1, window: 10, items: true, itemMinV: 6000, maxEnergyCost: 600, skipMarked: true, avoid: [] },
  loop: { minSleep: 20, maxSleep: 600, maxRounds: 30, postGap: 2.3 },
}
export function mergeConfig(base, over) {
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = mergeConfig(out[k], v)
    else if (v !== undefined) out[k] = v
  }
  return out
}

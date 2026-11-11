// 配置：默认值 + 用户覆盖，全部可热改（GUI 直接改这个对象）。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT } from './rules.mjs'

export const DEFAULTS = {
  // 总开关
  enabled: false,
  dry: false,                    // 演练：只算不提交

  // 站点
  baseUrl: 'https://52dmeme.com',
  cookieFile: '../messages/cookie.txt',
  minGap: 2.15,                  // 两次 POST 最小间隔（秒）

  // 调度
  loop: {
    minSleep: 20,                // 无事可做时的最小间隔（秒）
    maxSleep: 600,               // 无事可做时的最大间隔
    postGap: 2.2,                // 提交间隔
    maxRoundsPerTick: 8,         // 单次巡视最多几轮「规划→提交」
  },

  // 投资
  invest: {
    enabled: true,
    maxPaybackDays: 10,
    reserveCoins: 3000000,
    maxPlot: 24,
    maxBarn: 8,
    maxTrap: 4,
    maxHouse: 0,                 // 小屋只加体力上限，默认不投
    maxRod: 4, maxPick: 4, maxSpr: 3,
  },

  // 农田
  farm: {
    enabled: true,
    water: true,                 // 没有洒水器的地手动浇水
    foodPlots: 4,                // 留几块地种口粮（回体力）
    preferCrop: '',              // 空=自动选当季最优
    skipRipeCutoff: 0,           // 成熟后多少秒内必须收（0=立刻）
  },

  // 体力
  energy: {
    eat: true,                   // 吃作物回体力
    coffee: true,                // 喝咖啡（可超上限）
    minEnergyToWork: 4,
    coffeeAfterRatio: 0.5,       // 体力低于上限的这个比例时开始喝
  },

  // 钓鱼/挖矿
  work: {
    fish: true,
    mine: true,
    bomb: true,
    bait: true,                  // 自动买鱼饵
    baitMin: 10,
    // 每点体力的最低收益门槛（D币）
    minFishPerEnergy: 120,
    minMinePerEnergy: 100,
    minBombPerEnergy: 120,
  },

  // 加工
  craft: { enabled: true, minMargin: 0.05, maxPerRound: 20 },

  // 卖货（核心）
  sell: {
    enabled: true,
    horizonDays: 12,             // 往后看几个岛日（择时卖出用）
    outlookDays: 3,              // 估产出价值时看几个岛日的均价（选作物/钓鱼/挖矿/加工用）
    markdownPct: 6,              // 卖线 = 峰值 × (1 - 折让)
    minGainPct: 5,               // 等到峰值能多赚这么多百分点才等
    keepRatio: 0,                // 保留多少比例的货不卖（0=全卖）
    sellRipeOnly: false,
    // 每种作物每日全价额度（阶梯价），超出部分留到明天
    respectTiers: true,
    maxSellPerRound: 40,         // 单轮最多卖几格
  },

  // 货船
  cargo: {
    enabled: true,
    minMargin: 0.08,             // 基础价买入、预期卖价高出多少才买
    reserveCoins: 3000000,
    maxItems: 12,
  },

  // 囤货仓库
  vault: { enabled: true, keepPeakAhead: 2 },  // 峰值在 2 个岛日内就先囤着

  // 52弟
  npc: {
    enabled: true,
    gomoku: true,
    gomokuLevel: 3,              // 1 简单 / 2 普通 / 3 困难（倍率 0.8/1.2/1.5）
    gomokuBudgetMs: 6000,        // 每局最多算多久
    gomokuLines: 60,             // 离线试走多少条不同路线（实测 60 条 × 抖动 0.5 三档近全胜）
    gomokuJitter: 0.5,           // 路线随机扰动幅度
    gomokuMaxGames: 10,          // 每天前 10 局计奖
    practice: false,             // 计奖局用完后是否继续打练习局（无奖励）
    rps: false, card: false, box: false,   // 期望中性，默认不打
  },

  // 擂台
  arena: {
    enabled: true,
    battles: 30,                 // 每天打多少场（前 30 场有掉落）
    openChests: true,            // 自动开宝箱（每 3 场 1 个，每天 5 个）
    autoEquip: true,
    autoPoints: true,
    pointsPlan: 'atk',           // atk 攻击流 / vit 生存流 / agi 闪避流
    train: false,                // 花钱突破训练（默认关）
    trainBudget: 0,
  },

  // 串门
  social: {
    help: { enabled: true, perDay: 10, minEnergy: 20 },  // 帮忙：200 D + 2 经验/次
    steal: {
      enabled: false,            // 偷菜默认关（风险高，需要擂台等级支撑）
      minValue: 3000,            // 一批货的市价低于这个不去
      maxEnergy: 15,             // 单批体力上限
      scanEvery: 1800,           // 多久扫一次目录（秒）
      pages: 6,                  // 扫几页（每页 20 家）
      visitsPerScan: 8,          // 每次扫完去几家
      useCloak: true,            // 买潜行斗篷
      useSack: true,             // 买折叠菜篮
      protectAware: true,        // 遵守 30 分钟保护期
    },
  },

  // 守护道具
  guard: { enabled: true, item: 'guard1', renewHours: 24 },

  // 离线时段（交给管家）
  offline: { useButler: true, from: '01:00', to: '08:30' },

  // 日志
  log: {
    maxLines: 2000,
    dir: 'logs',
    // 旧版 Chrome 插件的扩展 ID：GUI 的「旧插件记录」页会去浏览器的
    // Local Extension Settings 里读它的历史日志
    legacyExtensionId: 'memccobjoffkjbdfciconoaedglmfmbl',
    legacyStoreDir: '',          // 留空=自动扫描所有浏览器 profile；也可手动指定
  },
}

/** 深度合并（用户配置覆盖默认值） */
export function mergeConfig(base, over) {
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeConfig(out[k], v)
    } else if (v !== undefined) out[k] = v
  }
  return out
}

const CONFIG_FILE = resolve(ROOT, 'config.json')

export function loadConfig() {
  let raw = {}
  if (existsSync(CONFIG_FILE)) {
    try { raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch (e) { console.error('config.json 解析失败，使用默认值：', e.message) }
  }
  return mergeConfig(DEFAULTS, raw)
}

export function saveConfig(cfg) {
  // 只保存和默认值不同的部分，便于阅读
  const diff = {}
  const walk = (base, cur, target) => {
    for (const [k, v] of Object.entries(cur)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const sub = walk(base?.[k] || {}, v, {})
        if (Object.keys(sub).length) target[k] = sub
      } else if (JSON.stringify(v) !== JSON.stringify(base?.[k])) {
        target[k] = v
      }
    }
    return target
  }
  walk(DEFAULTS, cfg, diff)
  writeFileSync(CONFIG_FILE, JSON.stringify(diff, null, 2), 'utf8')
  return diff
}

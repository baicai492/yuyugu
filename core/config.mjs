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
    // 最长等待。榜一（yuyugu-kernel）的主循环硬上限就是 120 秒
    // （cli/live-daemon.mjs: deltaSec = min(120, nextWakeSec - now)）。
    // 等待期我们已经每 20 秒只读巡检一次，所以 120 秒不会漏掉突发。
    maxSleep: 120,
    // 退避（连续没进展时）允许睡到多久。不受 maxSleep 约束，
    // 否则退避值会被截回 120 秒，等于没退避。
    maxSleepForBackoff: 1800,
    postGap: 2.2,                // 提交间隔
    maxRoundsPerTick: 8,         // 单次巡视最多几轮「规划→提交」
    watchInterval: 20,           // 等待期巡检的最小间隔（秒）；实际按等待时长自动放大到最多 120
  },

  // 还有额度没做完时，多快回来继续做一轮（秒）。
  // 不设这些的话，会一直落到 maxSleep（10 分钟），白天有效时间被大幅浪费。
  wake: {
    help: 60,                    // 帮忙还有额度
    gomoku: 60,                  // 五子棋计奖局没打完
    arena: 300,                  // 擂台（打完会立刻返回，成本低）
    // 连续几轮都没进展时的退避（避免「没对象可帮」还每 60 秒空转）
    stallThreshold: 3,           // 连续几次没进展算「卡住」
    idleStall: 900,              // 卡住后所有额度驱动一起放宽到这个间隔（秒）
    work: 60,                    // 钓/挖/炸还有额度时的复查间隔
    // 所有额度都刷完（含帮忙/五子棋/擂台/种地）之后，睡到换岛日，
    // 但封顶这个秒数：等待期的只读巡检还要负责发现「被偷」这类外部突发。
    idleSleepCap: 1800,
  },

  // 长期资产（动物、工具）估值：基础价 × 这个系数（旧版 price.longRun）
  price: { longRun: 1.3 },

  // 投资
  invest: {
    enabled: true,
    maxPaybackDays: 10,
    reserveCoins: 3000000,
    maxPlot: 24,
    maxBarn: 8,
    maxTrap: 4,
    // 小屋只加体力上限（每级 +20）。以前默认 0，理由是「脚本从不让体力攒满，
    // 上限提升没收益」——实测恰恰相反，体力上限就是当前的硬瓶颈：
    // 野外 24 块地每块收割要 1 点，而体力只按 180 秒回 1 点，
    // 一次只能收 1 块就归零（日志里连续 231 次「体力 0/100」）。
    // 上限 100→120 相当于多攒 20 点 = 一次能多收 20 块地。
    // Lv1 只要 10 万 D，对比每天几百万的收益，回本期是以小时计的。
    maxHouse: 5,
    maxRod: 4, maxPick: 4, maxSpr: 3,
  },

  // 农田
  farm: {
    enabled: true,
    water: true,                 // 没有洒水器的地手动浇水
    // 留几块地种口粮（回体力）。这是**下限**：实际数量由 planner 按体力账算——
    // 工作额度要吃的体力 + 农务体力 − 自然回复 = 每 24 小时的缺口，
    // 再除以一块口粮地每 24 小时净回多少体力（番茄约 45 点）。
    // 线上实测这个缺口需要 20+ 块口粮地，远大于这里的 4；写死 4 的时候
    // 体力常年见底，钓鱼额度一整天 0/80。
    foodPlots: 4,
    preferCrop: '',              // 空=自动选当季最优
    skipRipeCutoff: 0,           // 成熟后多少秒内必须收（0=立刻）
  },

  // 体力
  energy: {
    eat: true,                   // 吃作物回体力
    coffee: true,                // 喝咖啡（可超上限）
    minEnergyToWork: 4,
    coffeeAfterRatio: 0.5,       // 体力低于上限的这个比例时开始喝
    // 口粮的「两条水位线」，旧版 food.reserveE / maxStockE：
    //   reserveE   —— 必须留的底线。卖货前先留出这么多体力当量的口粮，
    //                 低于它就不许再卖（否则体力 0 时没东西吃，地熟了收不了）
    //   reserveEnergy —— 攒到这个数就**不再买**（货船买口粮、种口粮地都以此为目标）
    // 以前只有一个 reserveEnergy，被当成「必须留」的底线用，
    // 结果要么留太多（加工/卖货都动不了），要么留太少（口粮被卖光）。
    reserveE: 600,
    reserveEnergy: 2500,
  },

  // 钓鱼/挖矿
  work: {
    fish: true,
    mine: true,
    bomb: true,
    bait: true,                  // 自动买鱼饵
    baitMin: 10,
    // 钓鱼时段窗口：当前时段的期望收益要达到「本岛日最好时段」的多少比例才下竿。
    //
    // 以前硬编码 0.97，实测鱼只分三档：
    //   06-11 点 = 84%（低谷，确实该等）
    //   00-05 / 20-23 点 = 95%
    //   12-19 点 = 100%（高峰）
    // 97% 卡在 95% 和 100% 之间，等于把 95% 那 12 个时段全判成「等最佳」，
    // 只剩 8 个时段能钓。线上实测一整天钓鱼额度 0/80，一竿没下。
    // 降到 0.93：能钓 95% 和 100% 的时段，仍然避开 84% 的低谷。
    windowRatio: 0.93,
    // 快到换岛日边界时，额度即将重置，别等窗口了，直接清掉
    deadlineSec: 1200,
    // 每点体力的最低收益门槛（D币）
    minFishPerEnergy: 120,
    minMinePerEnergy: 100,
    minBombPerEnergy: 120,
  },

  // 加工
  craft: { enabled: true, minMargin: 0.05, maxPerRound: 20, hoardMax: 240 },

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
    // 同种作物库存超过这个数时，允许把第二档（85%）也卖掉清库存（旧版 sell.tier2Above）
    tier2Above: 450,
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
    // 每次巡视最多打几场（旧版 perVisit）。一场要 8.5 秒，打满 30 场会阻塞
    // 4 分钟——期间偷菜的解禁时刻全错过。分成几轮打，总量不变。
    perVisit: 5,
    openChests: true,            // 自动开宝箱（每 3 场 1 个，每天 5 个）
    autoEquip: true,
    autoPoints: true,
    pointsPlan: 'atk',           // atk 攻击流 / vit 生存流 / agi 闪避流
    train: false,                // 花钱突破训练（默认关）
    trainBudget: 0,
    // 养大肥鱼：只影响守家/偷菜的对战胜负，不直接赚钱。
    // true = 总是养；false = 不养；'auto' = 偷菜开着或离线时段会被偷时才养。
    // 每天总预算包含训练、买史诗装备和强化。
    spend: 'auto',
    dailyBudget: 150000,
  },

  // 串门
  social: {
    // 帮忙：200 D + 2 经验/次，每家只要 1 点体力。
    // minEnergy 以前是 20，但线上体力长期在 5~15 徘徊（24 块地不停地熟、
    // keep 又一直预留收割体力），结果帮忙在 5/10 家就停住了，
    // 连续 29 次静默跳过——日志里连一句都没有。
    // 帮忙是全游戏性价比最高的事（1 体力换 200 D），门槛低到 5 点即可。
    help: { enabled: true, perDay: 10, minEnergy: 5 },
    steal: {
      enabled: false,            // 偷菜默认关（风险高，需要擂台等级支撑）
      minValue: 3000,            // 一批货的市价低于这个不去
      maxEnergy: 15,             // 单批体力上限
      scanEvery: 1800,           // 多久扫一次目录（秒）
      pages: 6,                  // 扫几页（每页 20 家）
      visitsPerScan: 30,         // 每次扫完/巡逻去几家上限（旧版默认 30；实际能偷的通常 0~3 家）
      // 手动排除的岛 id：目录扫描和巡逻都不会碰它们（旧版 steal.avoid）
      avoid: [],
      // 跳过被自己标记过的岛（旧版 steal.skipMarked，站点返回 marked 字段时才生效）
      skipMarked: true,
      // 「盯名单」：服务端的可偷筛选只看得到此刻已经被漏掉的货，
      // 好货都是解禁瞬间被抢走。要抢到就得提前访问、记下每块地的解禁时刻，
      // 再让 nextWake 掐那一秒醒来（旧版 v1 的做法）。
      dirEvery: 7200,            // 多久重建一次盯名单（秒）；旧版 2 小时
      // 建名单翻几页（每页 20 家）。旧版默认 60 页 = 1,200 座。
      // 新版重写时缩到 12 页 = 240 座，等于只看得到全服 1/4 的邻居——
      // 好目标可能压根没进过名单。目录请求是 GET，60 页约 40 秒，2 小时一次，成本可忽略。
      dirPages: 60,
      checkEvery: 1800,          // 某座岛多久没看过就值得再看一眼（秒）；对齐旧版 recheck
      watchEvery: 120,           // 巡逻一批的最短间隔（秒）；53 座岛约 7 分钟轮完一圈
      // 解禁时刻提前几秒醒来准备（旧版 prep+lead）。
      // 0 = 自动：按这一波有几家岛算（每家访问约 1.5 秒 + 4 秒余量）。
      // 固定值只有在想强制覆盖时才设。
      prepLeadSec: 0,
      minEV: 3000,               // 期望收益低于这个就不去偷（旧版 steal.minEV）
      useCloak: true,            // 买轻步斗篷（被发现率 −10 个百分点）
      useSack: true,             // 买折叠菜篮（每处多拿 1 个）
      protectAware: true,        // 遵守 30 分钟保护期
      // 为了偷菜吃口粮/喝咖啡补体力时，每点体力最多花多少 D。
      //
      // 这是旧版 steal.maxEnergyCost 的默认值。没有它的时候这里是一条
      // 「体力 < 5 就整轮跳过」的硬门槛——体力被钓鱼/挖矿花光是常态，
      // 于是偷菜额度一整天都是 0（11-12 全天只偷到 1 处 5,160 D）。
      // 偷一批货通常值几千 D，花几百 D 买体力去掐解禁时刻是稳赚的；
      // 600 也高于口粮的正常成本（实测番茄约 310 D/点），不会挡住正常补体力。
      maxEnergyCost: 600,
      // 体力的机会成本（D/点）。旧版默认 300，用来判断「这一趟值不值得偷」：
      // 体力拿去钓鱼能换 1,600+、挖矿 800+，偷一批货只值 3,000 却要 10 点体力，
      // 净收益就是负的。不加这条会把体力全花在低价值的目标上。
      energyValue: 300,
    },
  },

  // 守护道具
  guard: { enabled: true, item: 'guard1', renewHours: 24 },

  // 防偷：成熟即收是主防线（成熟后 30 分钟内别人偷不了），
  // 下面这些是给「没法及时收」的情况兜底——被偷过之后 24 小时内自动续道具。
  defense: {
    guardItems: true,
    alert: 'guard1',             // 潮铃：发现率 +10 个百分点
    combat: 'guard2',            // 贝壳护具：守家生命 +8%
    protect: 1800,               // 保护期（秒）
    // 离线时段开着时只买「一格一只」的动物，减少没人收时的畜产损失（旧版）
    safeAnimals: true,
  },

  // 离线时段（交给管家）
  // enabled=true 时，种地规划会避开「成熟时刻落在离线时段」的作物：
  // 那段时间没人收，超过保护期就被偷（每次只收 1 个）。
  // 站内管家在离线时段会兜底收菜，所以默认关；管家等级低/常没体力时再打开。
  offline: { enabled: false, useButler: true, from: '01:00', to: '08:30' },

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

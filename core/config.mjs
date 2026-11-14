// 配置：默认值 + 用户覆盖，全部可热改（GUI 直接改这个对象）。
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT } from './rules.mjs'

export const DEFAULTS = {
  // 总开关
  enabled: false,
  dry: false,                    // 演练：只算不提交

  // 站点
  baseUrl: 'https://52dmeme.com',
  // 项目内相对路径（相对仓库根）。cookie 不再引用仓库外的 ../messages/。
  cookieFile: 'cookie.txt',
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
    arcade: 60,                  // 游乐馆还有次数时的复查间隔
    // 所有额度都刷完（含帮忙/五子棋/擂台/种地）之后，睡到换岛日，
    // 但封顶这个秒数：等待期的只读巡检还要负责发现「被偷」这类外部突发。
    idleSleepCap: 1800,
  },

  // 长期资产（动物、工具）估值：基础价 × 这个系数（旧版 price.longRun）
  price: { longRun: 1.3 },

  // 投资
  invest: {
    enabled: true,
    // 回本上限固定 5 天，不再按闲置现金放宽。
    //
    // 之前的「闲置 ≥500 万 → 30 天」在 2026-11-12 线上一次性花了 414 万
    // 买畜栏/小屋：这些回本期是拿「当前产出和价格」估的，而站点随时可能
    // 改规则或调价，期限越长，估算失效时的亏损越大。5 天以内即使规则
    // 小幅变化也还有纠错余地；钱多不等于该放松风险敞口。
    maxPaybackDays: 5,
    // 单次规划最多投几项。配合引擎「一轮巡视只投一次」，
    // 避免同一个时机把一批候选全买掉。
    maxPerRound: 1,
    reserveCoins: 3000000,
    maxPlot: 24,
    maxBarn: 8,
    maxTrap: 4,
    // 小屋只加体力上限（每级 +20）。上限就是当前的硬瓶颈：
    // 长夜 22:00—08:00 岛钟暂停，但体力仍按现实时间回复——10 小时 = 600 分钟
    // ÷ 3 分钟/点 = 200 点，远超上限（140）。线上实测 2026-11-11 12:15
    // 脚本启动时体力 100/100，证实夜间必定回满、超出部分直接浪费。
    // 所以每级 +20 上限 ≈ 每天多回收 20 点体力，直到上限 200 才失效。
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

  // 大肥鱼修仙记（state.xs）
  //
  // 重要：灵石只在修仙内部循环（买种子、学功法、融合），**换不成 D 币**。
  // 所以这一项对「赚 D 币」没有直接贡献，是纯养成，默认关闭。
  // 打开后每轮巡视跑一批，炼丹 19 秒出炉这类短窗口会在同一轮里连做几批。
  xian: {
    enabled: false,
    maxActions: 20,              // 单批最多几条动作（站点一批上限 20~30）
    maxBatchesPerRound: 3,       // 单轮巡视最多连做几批
    // 突破策略：smart = 药园没满级前先攒培元丹喂药园，满级后才按部就班突破
    //   eager = 一到瓶颈就突破   manual = 永不自动突破
    breakMode: 'smart',
    // 融合灵根不可逆（根数 −1），默认关。开了才会在修为损耗最小的窗口融合。
    autoFuse: false,
    fuseTarget: 'auto',          // auto / ice / thunder / wind / lava / poison
    // 手动预留的灵力（0 = 不手动锁）。严格按这个数：
    // 灵力低于它就停掉所有耗灵力的动作（含收菜、炼丹），先吃回灵丹补，
    // 没丹就等自然回复。修仙 2.0 的秘境（15）和同门斗法（10）同样受它约束——
    // 以前只接在 1.0 的农事上，设了 30 灵力照样被 2.0 花到 0。
    // 0 时交给系统按秘境/斗法下一次门票自动留。
    reserveEnergy: 0,
  },

  // 修仙 2.0（人脉/机缘/宗门/配招/自动对战/秘境）
  //
  // 和 1.0 一样：灵石换不成 D 币，纯养成。默认跟随 xian.enabled 打开。
  // 能本地精确预演的部分（ab 对战、秘境整条路径）都先算好再提交；
  // evroll / tasks 是服务端随机，只能先提交再看回执。
  xian2: {
    enabled: true,
    maxActions: 24,              // 单批最多几条（和服务端 30 的上限留余量）
    maxBatchesPerRound: 3,       // 单轮巡视最多连做几批
    realm: true,                 // 自动跑秘境（每天 3 次，收益最高的一块）
    realmBeam: 6,                // 秘境路径束搜索宽度
    loadoutMs: 900,              // 配招搜索的时间上限（毫秒）
  },

  // 游乐馆：弹弹乐 / 鲸鱼桌球 / 鲸鱼保龄
  //
  // 不发 D 币，只写榜单与个人纪录，所以默认「只打有把握的两个」：
  // pool/bowl 求解器能稳定 1200/250，bounce 的搜索还没到榜首水平。
  // 每次开局要多等 MIN_PLAY（5/6/8 秒），一局约 10–15 秒，别让它拖住偷菜。
  arcade: {
    enabled: true,
    games: ['pool', 'bowl', 'bounce'],
    perTick: 2,                  // 单轮巡视最多玩几局
    solveMs: 20000,              // 单局求解时间上限
    minEnergy: 0,                // 游乐馆不吃体力，留字段备用
  },

  // 卖货（核心）
  sell: {
    enabled: true,
    horizonDays: 12,             // 往后看几个岛日（择时卖出用）
    outlookDays: 3,              // 估产出价值时看几个岛日的均价（选作物/钓鱼/挖矿/加工用）
    markdownPct: 6,              // 未来预测价打 (1 − 折让)，越大越倾向现在卖
    // 注意：minGainPct / keepRatio / sellRipeOnly 已删除。
    // 它们从未被任何代码读取（择时完全由 allocateSale 的逐件跨桶分配决定），
    // 留着只会让人以为改了有用。
    // 每种作物每日全价额度（阶梯价），超出部分留到明天
    respectTiers: true,
    // 同种作物库存超过这个数时，允许把第二档（85%）也卖掉清库存（旧版 sell.tier2Above）
    tier2Above: 450,
    // 超过这个数就放开阶梯上限，允许落到第三档（70%）清仓。
    // 产量长期压过二档额度时库存只会越堆越多，钱全压在货里；
    // 这个值是「约 2 天的二档量」，正常经营摸不到，只有真积压才会触发。
    tier3Above: 900,
    // 未来到货里按这个比例算「会拿去卖」：剩下的当口粮和加工原料。
    // 只影响「今天卖多少」的紧迫度，不会真的提前卖未来的作物。
    futureSellShare: 0.7,
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
  // upgrade：撞墙（格数快满）才升级，且现金要远超升级价。
  // b26 只扩容量、不产生收益，默认开，但不会主动为它调度。
  vault: { enabled: true, keepPeakAhead: 2, upgrade: true },

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
    // 规则里 pay() 只在胜利时发奖、输和平零成本（平局不计次），
    // 所以这些小游戏是纯白拿：抽牌 2,730 D/次、石头剪刀布 2,705 D/次。
    // 五子棋打完前 10 局后，剩下的额度默认全用来抽牌（平局率最低、请求最少）。
    rps: false, card: true, box: false,
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
    // 'auto' = 按 battle.mjs 的加点算法（攻击断点 + 零速必暴武器补速度）；
    // 也兼容旧值 atk/vit/agi/spd：全部自由点堆一项。
    pointsPlan: 'auto',
    train: false,                // 花钱突破训练（默认关）
    trainBudget: 0,
    // 养大肥鱼：只影响守家/偷菜的对战胜负，不直接赚钱。
    // true = 总是养；false = 不养；'auto' = 偷菜开着或离线时段会被偷时才养。
    // 每天总预算包含训练、买史诗装备和强化。
    spend: 'auto',
    dailyBudget: 150000,
  },

  // 站宠护理（/api/pet/state）：喂食/玩耍/休息/清洁 + 每日首见。
  // 站宠等级就是擂台等级：每级加面板（hp+5/atk+0.7/agi+0.5/spd+0.5），
  // 16/18/20/25/30/40/50 级还解锁新招式。不花 D 币、不花小岛体力，
  // 只受服务端每日经验上限约束（当前账号 1000/天，见 progress.cap）。
  // 等级越高守家越强（被偷得少）、擂台胜率越高。
  petCare: {
    enabled: true,
    maxActionsPerSave: 60,       // 单次保存最多做几个护理动作（约 500~700 经验）
    maxSavesPerTick: 2,          // 单轮巡视最多保存几次（经验刷满就停）
    retryGapSec: 900,            // 两次尝试的最小间隔（经验满/失败后的退避）
  },

  // 大肥鱼战斗策略：对手档案 + 蒙特卡洛模拟 + 战前换装。
  // 移植自榜一的 combat-engine：装备评分看被动/技能而不只是面板，
  // 加点走断点，擂台/偷菜前按对手档案临时换装，打完立刻穿回静止装。
  battle: {
    accountKey: 'main',
    profileStore: '',            // 留空 = logs/battle-profiles.json
    lockRoot: '',                // 留空 = logs/.locks
    // 换装是要发 POST 的（2.15 秒/次），只在模拟显著提高胜率时才换。
    tacticalSwap: true,          // 擂台战前换装
    stealSwap: true,             // 偷菜战前换装（还要求 arena.autoEquip=true）
    guardPosterior: true,        // 用档案模拟守家胜率算偷菜 EV（关掉退回等级差公式）
    // 增量同步战报：擂台 history（双方面板）+ 守家日志（来袭者面板）。
    // 都按 lastId 增量，平时只多两个 GET。
    profileSync: true,
    guardSync: true,
    homeSyncMax: 6,
    guardSyncMax: 8,
    trials: 800,                 // 擂台每套候选装备的模拟局数
    guardTrials: 800,            // 偷菜前每家的模拟局数（守家只有一次机会，宁可贵几十毫秒）
    minGain: 0.005,              // 换装至少提高 0.5% 期望效用
    zThreshold: 2.0,             // 且配对检验 z > 2（避免为噪音换装）
    guardBlockSec: 600,          // 打输/负期望后多久不再碰这座岛（秒）
    // 打输后先只冷几秒：等新战报进档案、重算一次 EV，仍为负才升级成 guardBlockSec。
    // 以前是「打输就封 10 分钟」，但对手可能刚换了装、我们也可能刚变强，
    // 无条件封禁会错过很快就能打赢的岛（榜一 lose 分支也是先重算再决定）。
    lossCooldownSec: 5,
    drawCooldownSec: 4,          // 打平后的冷却（没有收益也没有罚款，代价低）
    // 真实战绩（w/d/l）在守家后验里的分量，单位「场」：后验 =
    // (模拟 × recordPrior + 真实战绩) / (recordPrior + n)。
    // 模拟规则不可能完全复刻服务端，打几场就能校准；设 0 可关掉混合。
    recordPrior: 4,
    gearCacheSec: 600,           // 装备页缓存（秒）
    homeHpMult: 1.1,             // 守家方 HP 加成（arena 快照回退到 guard 时补乘）
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
      // 解禁时刻的「同一瞬间」容差（秒）。2 秒内的多处并成一组算期望，
      // 差得更远的分开——解禁时刻是精确值，合并会把第一批推迟。
      groupSpanSec: 2,
      // 为「即将解禁的偷菜」提前预留体力（榜一 computeImminentSnipeStaminaReservation）。
      // 以前是解禁那一刻才现场吃口粮（一个 POST 2.15 秒），吃完货已经被抢走；
      // 现在钓鱼/挖矿/炸矿不会把体力花到不够偷，解禁前只补一次。
      reserve: true,
      reserveHorizonSec: 900,    // 未来这么久内解禁的目标参与预留（秒）
      // 偷菜窗口内不跑五子棋/擂台/帮忙/修仙（榜一 shouldBlockBackgroundWork）。
      // 这些模块每个 POST 占 2.15 秒，插一个就可能把解禁请求推到窗口外。
      preempt: true,
      // 只把未来这么久以内的解禁记进调度表（秒）。更远的等下一轮巡逻重算，
      // 免得每座岛都堆着几天后的记录。
      horizonSec: 7200,
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
const CONFIG_BAK = CONFIG_FILE + '.bak'
const CONFIG_TMP = CONFIG_FILE + '.tmp'

// 上次 loadConfig 是否读失败（文件被写坏/读空）。重启交棒用它判断要不要用
// 旧进程带过来的 enabled 兜底，见 yuyugu2.mjs。
let lastLoadFailed = false
export function configLoadFailed() { return lastLoadFailed }

export function loadConfig() {
  lastLoadFailed = false
  let raw = null
  let err = null
  // 先读正本，读坏了再读上次成功写入的副本。
  //
  // 为什么需要副本：saveConfig 以前是直接 writeFileSync 覆盖，
  // 该调用会先把文件截断成 0 字节再写。如果重启时新进程恰好在这个窗口里
  // loadConfig，JSON.parse 会失败，旧代码静默退回 DEFAULTS —— 而
  // DEFAULTS.enabled 是 false，新进程就成了「暂停」状态，用户得再点一次
  // 启动（2026-11-14 的偶发现象）。现在写入走 tmp+rename（原子），
  // 读失败还有 .bak 兜底。
  for (const f of [CONFIG_FILE, CONFIG_BAK]) {
    if (!existsSync(f)) continue
    try {
      raw = JSON.parse(readFileSync(f, 'utf8'))
      if (f === CONFIG_BAK && err) console.error('config.json 读取失败，已回退到 config.json.bak：', err.message)
      break
    } catch (e) { err = e; raw = null }
  }
  if (raw === null) {
    lastLoadFailed = true
    if (err) console.error('config.json 及其备份都无法解析，使用默认值（enabled 会变回 false）：', err.message)
    raw = {}
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
  const text = JSON.stringify(diff, null, 2)
  // 原子写：先写 .tmp 再 rename。rename 在同一分区上是原子的，
  // 读的一方要么看到旧内容、要么看到新内容，不会读到半截。
  try {
    writeFileSync(CONFIG_TMP, text, 'utf8')
    renameSync(CONFIG_TMP, CONFIG_FILE)
  } catch (e) {
    // rename 失败（比如 Windows 上被占用）就退回直接写，至少别丢配置
    try { unlinkSync(CONFIG_TMP) } catch {}
    writeFileSync(CONFIG_FILE, text, 'utf8')
  }
  // 留一份最近一次成功写入的副本给 loadConfig 兜底
  try { writeFileSync(CONFIG_BAK, text, 'utf8') } catch {}
  return diff
}

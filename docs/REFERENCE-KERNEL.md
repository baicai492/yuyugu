# 参考项目 yuyugu-kernel 全模块详解

> 对象：`research/ref/yuyugu-kernel`（GitHub: `DracaeneSunbringer/yuyugu-kernel`）
> 版本：v1.4.6（package.json），发布日 2026-11-13
> 规模：源码 **46,485 行**（其中 `planner/solve.mjs` 单文件 10,956 行、测试 10,997 行）
> 依赖：**零第三方依赖**，只要求 Node.js ≥ 22
> 本文档基于 2026-11-14 通读的当地快照，行号为当时版本

---

## 0. 一句话定位

一个**统一滚动时域经济决策内核**（Single Brain）：把小岛上的所有经济动作——种植、养殖、加工、采购、卖货、体力分配、出访偷菜、擂台、修仙——放进**同一份跨期资源守恒账本**里竞争同一批库存、现金、体力、地块、工坊额度和阶梯税档；外挂一个**独立三层反事实审计引擎**（严禁 import 生产代码）用来验证「你赚到的钱是不是运气」。

一句话概括它的设计哲学：**宁可承认"我不知道"，也不把启发式伪装成确定性真值。**

---

## 1. 目录结构与职责映射

```
yuyugu-kernel/
├── model/            # 真值层：规则适配 + 观测 + 目标函数
│   ├── rules-adapter.mjs      1,029 行
│   ├── observations.mjs         784 行
│   └── objective.mjs          1,230 行
├── planner/          # 规划层：资源配置求解
│   ├── solve.mjs             10,956 行  ← 核心
│   ├── bounds.mjs               462 行
│   ├── resources.mjs            376 行
│   └── compile-prefix.mjs       586 行
├── execution/        # 执行层：真正发请求
│   ├── xian-cultivation.mjs   1,954 行
│   ├── snipe-scheduler.mjs    1,719 行
│   ├── combat-engine.mjs      1,383 行
│   ├── async-planner.mjs        815 行
│   ├── reconcile.mjs            742 行
│   ├── pet-and-battle.mjs       739 行
│   ├── npc-toy-stall.mjs        574 行
│   ├── http-client.mjs          438 行
│   ├── planner-worker.mjs       114 行
│   └── update-notifier.mjs      348 行
├── audit/            # 审计层：零耦合独立验证
│   ├── reference-solver.mjs   1,799 行
│   ├── replay.mjs               534 行
│   ├── journal.mjs              365 行
│   └── report.mjs               352 行
├── cli/              # 编排层
│   ├── live-daemon.mjs          988 行
│   ├── controller.mjs           806 行
│   └── shadow-daemon.mjs        449 行
├── rules/            # 站点规则原文（与线上逐字节一致）
│   ├── pet-world-rules.js     1,706 行
│   ├── xs-xian-rules.js       (修仙规则)
│   └── pet-battle-rules.json  (战斗数值表)
├── test/             # 18 个 phase 测试，10,997 行
└── fixtures/sample-snapshot.json  (1,306 行真实快照样本)
```

依赖方向是**单向**的：`cli → execution → planner → model → rules`，`audit` 只能依赖 `model`。

---

## 2. model/ —— 真值层

### 2.1 `rules-adapter.mjs`（1,029 行）

**唯一职责：把站点规则包成纯函数，且零硬编码物品 ID。**

| 导出 | 作用 |
|---|---|
| `createRulesAdapter(R)` | 从注入的 rules 对象构造适配器 |
| `loadRulesAdapterFromFile(path)` | 从文件加载并计算 SHA256 |
| `computeRulesHash(R)` | 规则源码 hash，用于审计归档 |
| `buildCatalogGraph(R)` | 从规则表**动态解析**出：物品属性、季节、成熟时长、配方输入超边、拓扑依赖链、阶梯适用性 |

核心 API 面（适配器方法）：

- `exactPlotTimings(state, now)` / `exactBarnTimings(...)` — 精确计算每块地/每个畜栏的下一个事件时刻（成熟、保护期结束、产出）
- `applyActions(state, actions, {t, day, prices, coins, rand})` — 深拷贝精确转移，**和线上规则逐字节一致**
- `isStochasticAction(a)` — 判定是否随机动作（`harvest` / `fish` / `mine` / `bomb` / `trap` / `visit`）
- `b12ConfigureClock(clockStart)` — **长夜时钟**配置。这是整个项目最容易踩的坑：所有 `isleDay` / `isleHour` / `cropStage` / `b12Season` 都依赖它，不喂 `clockStart` 会让季节/岛日整体错位
- `b12SaleQuote(wallet, paid, gross)` — 渐进售卖税
- `b12Available(state, id, q)` — 扣除 `b12.vault` 锁定库存后的可用量
- 动态目录：`WORLD.daily.{craft,fish,mine,bomb,coffee}`、`B12_SNACK.daily`、`CROP_TIERS`、`GOAL_POOL`、`PICK_FLOOR`、`QUALITY`

**关键设计**：`MODEL`/`planner`/`execution`/`audit`/`cli` 全源码**不出现** `'strawberry'`、`'corn'`、`'popcorn'`、`'crown'` 等具体 ID。把全部物品 ID 同构重命名后，规划目标值严格不变。

### 2.2 `observations.mjs`（784 行）

**唯一职责：分离「看到的」和「猜的」。**

| 导出 | 作用 |
|---|---|
| `sanitizeWorldSnapshot(raw)` | 世界快照脱敏/校验，剔除服务端多给的字段 |
| `inferSupplyBoundsFromQuote(...)` | 从报价反推供需因子**区间** `[S_min, S_max]`，而不是点估计 |
| `DEFAULT_EXTERNAL_SUPPLY_SCENARIOS` | 外部供给情景分布（默认多档） |
| `buildFutureIsleDayTimeline(...)` | 未来岛日时间轴（含季节、天气） |
| `quoteFutureItemUnderScenario(...)` | 某情景下的未来报价 |
| `normalizeUserConstraints(raw)` / `computeConstraintsHash(...)` | 用户硬约束归一化 + hash |
| `computeStaticFarmStateDigest(...)` / `computeFarmDomainDigest(...)` | 农场域静态摘要（给 PlanCache 判缓存是否失效） |
| `isFarmDomainPassiveCompatible(...)` | 判断两次观察之间农场是否只是"被动变化"（自然生长），可复用缓存 |
| `getManualArcadeStandbyInfo(world, now, opts)` | **手动游乐馆检测**：玩家自己在玩时返回 `{active, resumeAtSec}`，所有自动化让位 |
| `resolveRaidOutcomeDistribution(...)` | **偷菜守家四分支**：未发现 / 胜 / 平 / 负，输出区间而非点估计 |
| `buildVisitTargetBelief(...)` / `buildUpcomingVisitBelief(...)` | 出访目标信念（可偷数量、货值、体力成本、守家概率） |
| `recomputeVisitBeliefForVisitor(...)` | 换了偷菜者后重算信念 |
| `buildObservationEnvelope(...)` | 打包成规划器输入的信封（观测 + 信念 + 约束 + digest） |

**`resolveRaidOutcomeDistribution` 值得单独说**：

```js
// 四分支收益
1 - pDet              → lootBag            （没被发现，拿走货）
pDet * pWin           → guardWinLootBag + 1/spot  （打赢，每处多拿 1 个）
pDet * pDraw          → 0                  （平局，什么都没有）
pDet * pLoss          → -fine              （打输，按货值 1.2 倍赔）
```

关键是它输出的是**区间**：`winInterval` / `lossInterval` 来自 Wilson 置信区间；没有校准对局时 `mode='conservative'` 取悲观端。还会给出 `guaranteedLootBag`（保底能拿的）和 `worstCaseFine`（最坏罚款）。

### 2.3 `objective.mjs`（1,230 行）

**唯一职责：定义"什么叫做得好"，并给期末一个可执行的下界。**

目标函数（DESIGN.md §2.1）：

```
J(Π | s₀, I₀) = Σ_ω p_ω [ C₀ + Σ_k γ(t_k - t₀)·ΔC_k(ω) + γ(t_H - t₀)·V_tail(s_H(ω), t_H, P_H(ω)) ]
```

- `γ(Δt) = (1+ρ)^(-Δt/3600)` 显式时间折现（默认 ρ=0，即不折现）
- `ΔC_k = earn_k - spend_k` 真实现金流，含税
- **严禁在目标中二次扣影子价格 λ**——体力/原料消耗已经在状态转移里扣过了
- `V_tail` 是**可执行**的期末清算值，不是启发式残值

| 导出 | 作用 |
|---|---|
| `buildObjectiveConfig(raw)` | 配置归一化 + `objectiveHash` |
| `discountFactor(rate, elapsed)` | 折现因子 |
| `buildTerminalPrices(...)` | 期末时点的价格（同岛日就用当前价，跨岛日按保守供给因子推） |
| `projectContinuationFarmFlows(...)` | **续种流**：期末时地里的作物还没收，把"收获→再种→再收"的现金流投影出来 |
| `buildContinuationTimeline(...)` | 续种时间轴 |
| `evaluateTerminalLiquidationTail(...)` | **期末清算尾段**：把剩余库存按 `q2→q1→q0` 构造**真实合法的 sell 动作序列**，调用 `applyActions` 实证结算，受当日剩余阶梯和税基约束，绝不跨入第二个自然日骗新阶梯 |
| `evaluateTrajectoryObjective(...)` | 整条轨迹打分 |
| `detectRollingDeferral(...)` | **滚动延期检测**：如果每次重规划都把同一件事往后推，报警（这是"永远明天再卖"病的诊断器） |

**期末清算为什么重要**：大部分规划器会把「未来某天按峰值全卖」当成收益，但作物一天只有 150 件全价 / 250 件 85% / 其余 70%。`evaluateTerminalLiquidationTail` 给"一直等"一个**可执行的下界**，防止被单日全价的虚高数字骗。

---

## 3. planner/ —— 规划层

### 3.1 `resources.mjs`（376 行）

把规划窗口切成**离散事件桶**。

| 导出 | 作用 |
|---|---|
| `buildEventBuckets(ctx)` | 在自然日 00:00、岛日边界、长夜 22:00/08:00、作物成熟/浇水点、动物产出/断粮点处切桶 |
| `applyExogenousArrivals(...)` | 应用外生到货（作物成熟、动物产出） |
| `deductRecipeLowStarFirst(...)` | 加工扣料严格遵循 `q=0 → q=1 → q=2` **低星优先**语义 |
| `expectedHarvestYield(...)` / `expectedMineYieldPerHit(...)` / `expectedBombYield(...)` / `expectedFishYieldPerCast(...)` | 各动作的期望产出（从规则表推导） |

**桶内守恒约束**（DESIGN.md §2.2）：

```
I_{b+1}[i,q] = I_b[i,q]
  + harvest + barn + trap/fish/mine/bomb + buy/cargo/goal/steal + craft产出
  - craft消耗 - sell - eat - use
  ≥ 0
```

同时约束：工坊额度 `K_craft`（每天 80 次）、自然日阶梯 `sc_i`、体力 `E_b`（区分 `eat`/`tide_snack`/自然回复受 `energyMax` 截断，而 `coffee` 和 `upgrade('house')` **允许突破上限**）。

### 3.2 `solve.mjs`（10,956 行）—— 核心

这是整个项目的重量级文件。导出函数只有 9 个，内部实现极长。

| 导出 | 作用 |
|---|---|
| `solveUnifiedPlan(ctx)` | **唯一主入口**。输出 `Π* = (buckets[0..B-1], terminalTail, quality)` |
| `solveWithHorizonStability(ctx)` | 带 $H$ vs $H+ΔH$ **首动作稳定性**检查的包装：两次不同时域的解如果第一条动作不一致，降级或延长时域 |
| `collectClaimableGoalActions(...)` | 收集今日可领的每日目标奖励（含 k=4 全部完成奖励） |
| `discoverRuleUtilityTokens(...)` | 从规则表**动态发现**效用型 token（如食物、药水、增益道具），零硬编码 |
| `buildThiefBuffCombinations(...)` | 偷菜增益道具（斗篷/菜篮）的组合枚举 |
| `findCheapestRaidStaminaPrep(...)` | 为偷菜补体力找**最便宜**的口粮/咖啡组合（考虑机会成本） |
| `evaluateMarginalRaidDelta(...)` | 单次偷菜的**边际价值**（相对于不偷） |
| `packRaidsOnMarginalContext(...)` | 在边际价值排序下打包多目标出访 |
| `createUnifiedRaidEvaluator(...)` | 常驻评估器（<5ms），复用国内基线给偷菜估值 |

内部关键函数（非导出）：

| 函数 | 行号 | 作用 |
|---|---|---|
| `solveExactItemSaleSchedule` | :248 | **精确跨期售卖排程**：给定一件货，求它在未来 N 个岛日 × 三档阶梯下的最优卖出时间表 |
| `buildCanonicalCraftTemplates` | :588 | 从配方图构造规范化的加工模板（含多级链如 `gold+coal→ingot→crown`） |
| `evaluateSupplyPortfolio` | :727 | 供给组合估值（把"卖什么、什么时候卖"当组合优化） |
| `solveJointCraftAndSell` | :850 | **加工与售卖的联合求解**：加工吃什么原料、什么时候卖出成品，两者一起定 |
| `mergeCraftActionsPreserveTopo` | :1,247 | 合并加工动作时保持拓扑序（原料必须先于成品） |
| `selectBestCropToPlant` | :1,274 | 选作物（考虑季节、成熟时长、当前价、未来到货挤占） |
| `enumerateLegalCapexCandidates` | :1,384 | 枚举合法基建候选（买地、扩仓、升级工具） |
| `selectCapexByTrajectoryDelta` | :1,439 | 用**轨迹差值**选基建（买了之后整条轨迹能多赚多少），不是简单回本期 |
| `optimizeAndSimulateSequence` | :1,539 | 主搜索：构造可行解 + 局部增广交换 + 分支定界 |
| `simulateValidBatch` | :6,979 | 批量模拟合法性验证 |
| `advanceScalarStamina` | :7,186 | 体力标量推进（含回复相位） |
| `computeExpectedRaidTransition` | :7,200 | 出访的期望状态转移（四分支） |
| `prepareRaidStaminaWithOppCost` | :7,240 | 补体力时算机会成本 |
| `replayRecordedRaidTransitions` | :7,353 | 重放已记录的出访转移 |

**求解思路**（非完整算法，但要点）：

1. 先构造一个**可行下界**（贪心+局部改进）
2. 用 `bounds.mjs` 算上界，量差距
3. 在差距大的地方做局部增广交换（augmenting swap）
4. 遇到随机动作就截断，拿真实回执再重规划

### 3.3 `bounds.mjs`（462 行）

**唯一导出：`computeValidUpperBound(...)`** —— 拉格朗日松弛上界 `U(λ) ≥ opt*`。

三条铁律（写在文件头）：

1. 如果候选集不完整或内层被裁剪 → **必须**返回 `{validUpperBound: null, reason: 'incomplete-candidate-set'}`
2. 如果允许动作里有随机转移 → 返回 `{validUpperBound: null, reason: 'stochastic-actions-require-distribution-tree'}`，**绝不**用单次采样冒充上界
3. 不等式对偶乘子 λ ≥ 0 严格投影到 R₊，内层在精确 box 域上闭式求解到 100% 全局最优

这个设计的意思是：**上界宁可没有，也不给假上界**。有了它，单测可以验证 `L ≤ opt* ≤ U`。

### 3.4 `compile-prefix.mjs`（586 行）

把 $\Pi^*$ 的**第一个桶**编译成可执行动作序列。

| 导出 | 作用 |
|---|---|
| `compileExecutablePrefix(ctx, plan)` | 编译 `buckets[0]`，逐条沙箱验真，遇首个随机动作截断 |
| `computeCausalStochasticPrefix(...)` | 因果安全的随机前缀（哪些动作能和安全地批在一起） |
| `computeEarliestDomesticTransitionSec(...)` | 下一个国内事件的最早时刻（用来算 nextWake） |
| `buildExecutablePlanSignature(...)` | 计划签名（用于计划兑现偏差审计） |

**批量打包规则**（写在文件头）：
- 相互独立的成熟地块 `harvest`、`collect`、`trap`、田间维护（`clear`/`water`/`feed`/`pet`/`goal`）可以**批进同一个 POST**（≤40 条）
- 只有当下游动作依赖未观测的随机产出（`sell`/`craft`/`eat`/`stockBuy`/`plant` 需要收获产物）时才截断
- 单个"榨体力"的随机动作（`fish`/`mine`/`bomb`/`npc`/`scratch`）之后**必须**截断

**失败处理**：任一计划动作验真失败 → 立即返回 `status: 'plan-invalid'` 阻断提交并重规划，**绝不静默跳过**继续执行残缺尾部。

---

## 4. execution/ —— 执行层

### 4.1 `http-client.mjs`（438 行）

`KernelHttpClient` 类。

| 成员 | 作用 |
|---|---|
| `classifyBucket(path)` | **按端点分桶**：`visit`/`act` 2.2 秒，`battle`/`equip` 1.2 秒，默认写 300ms，跨写 120ms |
| `_acquireBucketSlot(bucket)` | 每桶独立限流队列 |
| `getRemainingBucketCooldownMs(bucket)` | 查某桶还剩多久冷却（掐点提前量要用） |
| `isRequestIdempotent(method, path)` | 幂等性判定（决定网络失败能否重试） |
| `normalizeCookieHeaderString(...)` / `parseSessionCookieHeader(...)` | cookie 归一化 |
| `estimatedServerNowSec()` | 服务端时钟估计（用于掐点） |

**分桶的意义**：把所有 POST 统一按 2.15 秒串行，擂台和换装会被不必要地拖慢。分桶后擂台可以 1.2 秒一场。

### 4.2 `reconcile.mjs`（742 行）

**解决的是"请求发出去了，但不知道成没成"这个问题。**

| 导出 | 作用 |
|---|---|
| `withAccountLock(lockRoot, account, fn)` | 跨进程锁，`.gate` 文件串行化死 PID 回收（防止两个进程同时 unlink 新建的锁） |
| `executeTransaction(journal, req, opts)` | **事务执行**：发送前把 operation/rev/请求/预算占位持久化到 journal，崩溃后可恢复 |
| `recoverPendingTransactions(journal, ...)` | 启动时恢复未决事务：确认 / 标 unknown / 释放预算 |
| `reconcileUnknownWithFreshWorld(world, unknowns, journal)` | **未知结果核对**：用 `state.cnt['st'+targetId]` / `cnt.steal` 是否递增 + rev 变化，证明超时的 visit 到底执行没有 |

`Journal.countOccupiedBudget(...)` 会**保守占预算**：只要有 unknown 事务没对清，对应的岛日配额就先扣掉，宁可少做不可重复做。

### 4.3 `combat-engine.mjs`（1,383 行）—— 战斗模拟

**100% 表驱动**（数值来自 `rules/pet-battle-rules.json` + `/api/pet/battle/gear` 的 `catalog`），零硬编码装备 ID。

| 导出/常量 | 作用 |
|---|---|
| `BATTLE_SKILLS` / `WEAPON_SKILLS` / `LEVEL_GROWTH` / `POINT_MULT` / `SLOTS` | 战斗数值表 |
| `mulberry32(seed)` | 确定性 PRNG |
| `wilsonInterval(wins, n)` | Wilson 置信区间 |
| `simSingleBattle(a, b, rand)` | 单场模拟 |
| `simulateMatchup(a, b, trials, seed)` | **CRN（Common Random Numbers）配对蒙特卡洛**：同一组随机种子跑两套装备，差值方差大幅下降 |
| `observedPanelKey(...)` / `recordObservedPanel(...)` | 对手面板归档 |
| `buildCandidateLoadoutInterval(...)` | 候选装备组合的胜率区间 |
| `scoreGearItem(...)` | 装备评分（看被动/技能，不只看面板） |
| `planGearAndPoints(...)` | **加点算法**：走攻击断点 + 零速必暴武器补速度 |
| `loadProfileStore(...)` / `saveProfileStore(...)` | 对手档案持久化 |
| `recordBattleSnapshot(...)` | 战报入库 |
| `getOpponentSnap(...)` | 取对手快照（严格区分 `arena` 和 `guard` 两种面板） |
| `pickOptimalLoadout(...)` | 选最优三件套（weapon/armor/charm） |
| `computeGuardPosteriorForTarget(...)` | **守家后验**：模拟胜率与真实战绩按 `recordPrior` 加权混合 |
| `withGearLock(...)` | 跨进程换装锁 `.battle-gear.<account>.lock` |
| `executeWithTacticalLoadout(...)` | **战前换装**：模拟→判断是否值得换→换装→执行→`finally` 强制穿回静止装（失败时 `dirty: true` fail-closed） |
| `syncHomeHistoryProfiles(...)` / `syncGuardLogProfiles(...)` | 增量同步战报（按 lastId） |

**关键细节**：
- 换装只在**模拟显著提高胜率**时才做（默认 `minGain = 0.005`、`zThreshold = 2.0`），避免为噪音换装
- 打输后**不武断封禁**：先用新战报重算 EV，仍为负才升级成 `guardBlockSec`（默认 600 秒）；打输只冷 5 秒
- 装备锁带 `.gate` 文件防死锁

### 4.4 `pet-and-battle.mjs`（739 行）—— 站宠 + 擂台 + 彩金

| 导出 | 作用 |
|---|---|
| `petLevelOfTotalXp(total)` / `localCstDayStr(sec)` | 等级换算 / 北京时间日期 |
| `applyPetDecay(state, now)` | 按等级每整小时衰减（最多结算 48 小时） |
| `planPetCare(petState, now)` | **站宠护理规划**：每日首见（+3 心情、+20 xp）→ 喂食/清洁/休息/玩耍，按剩余经验上限挑动作 |
| `syncPetCareFirst(client, opts)` | 提交站宠护理，**必须在读 gear 之前**（等级影响面板） |
| `isDailyBattleChestReady(gear)` | 宝箱是否可开 |
| `syncBattleProfilesAndPreparation(...)` | **开打前**同步战报 + 开掉所有 ready 宝箱 + 穿静止装 + 加点 |
| `pickArenaOpponent(...)` | 选对手（等级筛选、优先低等级和打得少的） |
| `runSingleArenaBout(...)` | **每轮只打一场**，场间 8.5 秒在装备锁外在 500ms 切片里等，随时可被偷菜窗口打断 |
| `huancaiCycleStartSec(sec)` | 彩金周期起点（22:30 CST 边界） |
| `planHuancaiFloor(...)` / `runHuancaiDailyCheck(...)` | 每天花 10 D 买一张彩票（主账号限定，受 `cashReserveFloor` 保护） |

> ⚠️ **彩金已下线**：2026-11-14 实测 `/api/huancai` 返回 `410 {"code":"huancai_retired","retired":true}`，这部分对我们是死代码。

### 4.5 `snipe-scheduler.mjs`（1,719 行）—— 偷菜调度器

`SnipeScheduler` 类，**整个项目第二复杂的文件**。

**三大设计**（写在文件头）：

1. **精确跨天气/畜栏解禁时刻**：`adapter.exactPlotTimings` + `exactBarnTimings`，保护期 `rules.protect = 1800`，**零人为波次合并延迟**（旧的 `coalesceUnlockWindowSec` 已删除）——在最早的有正 EV 的 `candT` 出访
2. **常驻统一评估器**（<5ms）：`createUnifiedRaidEvaluator` 复用国内基线，评估四分支收益
3. **物理冷却前置**：`computePhysicalPrepLeadSec` 严格从真实动作冷却推导 `T_prep`（`minGap + RTT` + `换装数 × equipGap + RTT`），`executeStagedSnipe` 在解禁前完成所有准备，解禁那一刻只发 visit

**主要方法**：

| 方法 | 作用 |
|---|---|
| `syncCommittedRaidSchedule(...)` | 同步已提交的出访排期 |
| `needsScheduleRefresh(...)` / `getScheduleRefreshReason(...)` | 排期是否需要刷新（岛日变了、天气变了、季节变了） |
| `invalidateUnifiedBaseline(...)` / `primeUnifiedBaseline(...)` / `getUnifiedEvaluator(...)` | 评估器基线的失效与预热 |
| `computePhysicalPrepLeadSec(...)` | 算准备提前量 |
| `recordVisitSnapshot(...)` | 记录访问快照（解禁时刻来源） |
| `recordSnipeReceipt(entry, receipt, now)` | **回执状态机**（见下） |
| `recordReconciledVisit(...)` | 对账后的访问记录 |
| `isTargetBlocked(...)` | 目标是否被封（冷却/负期望） |
| `nextExactUnlockInfo(...)` | 下一个精确解禁时刻 |
| `hasReadyTargetNow(...)` | 现在有没有能偷的 |
| `shouldBlockBackgroundWork(now, leadSec)` | **偷菜窗口内是否阻塞后台**（五子棋/擂台/帮忙/修仙） |
| `computeImminentSnipeStaminaReservation(...)` | **为即将解禁的偷菜预留体力** |
| `collectUpcomingTargetsForController(...)` | 收集即将解禁的目标给主控 |
| `collectReadyNeighborBundlesForController(...)` | 收集现在可偷的目标包 |
| `executeStagedSnipe(...)` | **分阶段掐点执行** |
| `runIncrementalDiscoverySlice(...)` | **增量发现**：持久化 `discoveryCursor`，每次只扫 ≤2 页、探 ≤4 家，每个 HTTP 前检查偷菜窗口立即让路 |

**`recordSnipeReceipt` 的三支状态机**（这是最有价值的一段）：

```js
// 1. 每日上限
if (/上限|今天偷过|新手/.test(errMsg)) {
  entry.blockedUntil = adapter.nextNaturalDayBoundary(nowSec)   // 封到 CST 次日 0 点
  entry.blockedReason = 'server-daily-cap'
}
// 2. 409 卡在解禁时刻 ±2 秒 = 时钟截断抖动
else if (status === 409 && Math.abs(nowSec - expectedUnlockAt) <= 2 && earlyRetryCount === 0) {
  entry.earlyRetryCount = 1
  entry.expectedUnlockAt = Math.max(nowSec + 1, prevExpectedUnlock + 1)  // 1 秒后再试一次
}
// 3. 其余拒绝（最常见「没有能偷的」）
else {
  entry.cooldownUntil = nowSec + 90
}
```

**`guardOverdue` 过期退避**：

```js
const backoff = [5, 20, 60, 300][Math.min(3, prevOverdueCount)]
// 首次且过期 ≤2 秒：now + 1（给一次宽限）
```

**增量发现为什么重要**：全量扫 60 页要 40 秒，期间偷菜窗口打开就全错过了。增量发现每次只扫 2 页，游标持久化，可以在任意两次 HTTP 之间让路。

### 4.6 `async-planner.mjs`（815 行）

| 导出 | 作用 |
|---|---|
| `buildNeighborSignature(...)` | 邻居签名（判断缓存是否可复用） |
| `PlanCache` 类 | 计划缓存（按 farm digest + 邻居签名 + 约束 hash 索引） |
| `AsyncPlanManager` 类 | **Worker 线程里跑规划**，主线程可以随时 `terminate()` 抢占 |

**抢占机制**：规划可能在 Worker 里跑几秒。如果偷菜窗口打开，主线程 `worker.terminate()` 硬杀，然后 same-tick 切到 `executeStagedSnipe`。被杀的规划结果丢弃，等偷完再做。

### 4.7 `npc-toy-stall.mjs`（574 行）—— 52 弟玩具摊

| 导出 | 作用 |
|---|---|
| `solveGomokuForSeed(...)` | **15 路困难五子棋确定性全胜求解**（`cellStrength` 评估 + 局部候选 + 离线试走） |
| `computeNextNpcWakeSec(...)` | 下次该来的时刻（额度用完后算到次日 0 点 +5 秒） |
| `runNpcToyStallSlice(...)` | 抢占式执行器：五子棋 10 局计奖 + 抽牌清额度 |

### 4.8 `update-notifier.mjs`（348 行）

检查 GitHub 上有没有新版本，以及本地规则文件版本漂移。

---

## 5. audit/ —— 审计层（零耦合独立验证）

**这是整个项目最有特色的部分。** `audit/*` **严禁 import `planner/*`**。

### 5.1 `journal.mjs`（365 行）

`ContentAddressedJournal` 类：

- **内容寻址**的前后快照（snapshot hash）
- 规则源码归档（每次规则变更都存档一份）
- `wait` 决策记录（"我决定什么都不做"也要记）
- 白名单脱敏（cookie 等敏感字段）
- `sumConfirmedSalesByIsleIndex(adapter)` — 按岛日汇总已确认销量（给 MCMF 用）
- `countOccupiedBudget(...)` — 未决事务的保守预算占用

### 5.2 `replay.mjs`（534 行）

| 导出 | 作用 |
|---|---|
| `auditTransactionReplay(journal, tx)` | 单事务回放对账：重放 `applyActions`，对比实际状态变化 |
| `auditJournalReplayAll(journal)` | 全部回放 |

检验：物理账本守恒（库存/现金/体力）+ 经济账本守恒（税基/阶梯）+ **模型漂移报警**（规则变了但我们的模型没跟上）。

### 5.3 `reference-solver.mjs`（1,799 行）

**独立实现的参考解**：全合法动作枚举 + 微型精确穷举/分支定界 + 全规模独立反事实轨迹搜索。

用途：跟主规划器的解对比，算 Regret。

### 5.4 `report.mjs`（352 行）

| 导出 | 作用 |
|---|---|
| `buildAuditDecisionReport(...)` | 生成审计报告 |
| `reconstructCommitmentHistoryFromJournal(...)` | 从 journal 重建承诺历史 |

**五级区分**（这是审计的核心方法论）：

| 概念 | 含义 |
|---|---|
| `R_lower` | **事前可识别的决策 Regret 下界**（能在不知道未来的情况下证明"这一步做错了"） |
| 轨迹估计差 | 相对参考轨迹的估计差（受模型误差影响，不是真 Regret） |
| 计划兑现偏差 | 计划说的 vs 实际做到的 |
| 事后机会差 | 事后看最优的差多少（不可识别，只能参考） |
| `not-identifiable` | **明确承认"这个数我算不出来"** |

---

## 6. cli/ —— 编排层

### 6.1 `live-daemon.mjs`（988 行）

主循环，**严格因果顺序、零叶子反转**：

```
Phase A: 解禁前分阶段掐点快车道（leadSec ≤ 16）—— 最高优先级，零后台阻塞
Phase B: 可抢占的统一经济 runControllerStep（AsyncPlanManager Worker + PlanCache
         + 硬 deadline T_unlock - 14s 时 worker.terminate()，same-tick 交给 executeStagedSnipe）
Phase C: 可抢占后台切片，仅在 !snipeScheduler.shouldBlockBackgroundWork(now, 50) 时跑
         —— 站宠护理 → 擂台单场 → 修仙 → 52弟玩具摊 → 增量发现
```

**`deltaSec = min(120, nextWakeSec - now)`** —— 主循环硬上限 120 秒。

命令行开关：
- `--dry-run` — 底层拦截所有非 GET
- `--once` — 跑一轮就退
- `--domestic-only` — 纯内政（`stealBudget = 0`）
- `--allow-capex` — 允许自动买地/扩建（只在回本 ≤72h 时触发）
- `--self-ids` — 自己的 UID
- `--check-update` — 只检查更新

### 6.2 `controller.mjs`（806 行）

`runControllerStep(...)` —— **唯一统一主控制器入口**：

```
withAccountLock
  → fetchWorld
  → reconcileUnknown（未知结果核对 + 保守占预算）
  → ObservationEnvelope
  → solveWithHorizonStability
  → compileExecutablePrefix
  → executeTransaction  |  recordWait
```

**闭环管道**，没有任何"split-brain"式的第二套循环。

### 6.3 `shadow-daemon.mjs`（449 行）

影子模式：**只算不做**。用来和实盘对比（"如果我按计划做，会赚多少"）。

---

## 7. rules/ —— 站点规则

| 文件 | 行数 | 说明 |
|---|---|---|
| `pet-world-rules.js` | 1,706 | **和线上逐字节一致**（我们的 `cache/rules-*.mjs` 是同一份） |
| `xs-xian-rules.js` | — | 修仙规则（我们的 `core/xian-rules.mjs` 逐字一致） |
| `pet-battle-rules.json` | — | 战斗数值表（技能/等级成长/加点倍率） |

**关键机制**：
- `b12ConfigureClock(clockStart)` —— 长夜时钟。不喂这个，所有季节/岛日/成熟时刻全错
- `applyActions(state, actions, ctx)` —— 唯一的状态转移真值
- 加工扣料 `q0 → q1 → q2` 低星优先
- 售卖税 `b12SaleQuote` 渐进累进
- 单批最多 40 条动作，单条 `craft ≤ 20`

---

## 8. 测试体系（18 个 phase，10,997 行）

| 文件 | 测什么 |
|---|---|
| `phase1-state-and-journal` | 状态转移 + journal |
| `phase2-bounds-and-terminal` | **上界正确性与期末清算**（验证 `L ≤ opt* ≤ U`） |
| `phase2-unified-conservation` | 统一资源守恒 |
| `phase3-adversarial-audit` | 对抗性审计（故意构造难例） |
| `phase4-live-shadow` | 实盘影子对比 |
| `phase5/6-codex-round1/2-regressions` | 回归 |
| `phase7-execution-leaf-steal-combat` | 执行叶子 + 偷菜 + 战斗 |
| `phase8-preemptible-async-planner-p0` | 可抢占异步规划 |
| `phase9-holistic-season-and-stamina` | 季节与体力整体性 |
| `phase10-endogenous-stamina-and-harvest-continuity` | 内生体力与收获连续性 |
| `phase11-b16-xian-cultivation` | 修仙托管 |
| `phase12-outage-root-cause-and-anytime-recovery` | **宕机根因与任意时刻恢复** |
| `phase13-unified-crop-lifecycle-and-season-parity` | 作物生命周期与季节一致性 |
| `phase14-unified-snipe-farm-stamina-timeline` | 偷菜/农务/体力时间轴 |
| `phase15-unified-raid-contract-and-xian-isolation` | 出访契约与修仙隔离 |
| `phase16-v144-root-cause-fixes` | v1.44 根因修复 |
| `phase17-daily-goals-chests-npc-warehouse` | 每日目标/宝箱/52弟/仓库 |

**测试风格**：大量"根因回归"测试——每个线上事故都留一个测试防止复发（如 phase12 的宕机恢复、phase16 的 v1.44 根因）。

---

## 9. 设计红线（DESIGN.md §1，原文要点）

1. **单一主规划器唯一接管**——不存在启发式流水线
2. **计划即执行**——`compileExecutablePrefix` 只从 `Π*.buckets[0]` 编译，下游不二次重排
3. **四类信息严格分层**—— truths（rules-adapter）/ observations（observations）/ beliefs（区间）/ userConstraints（硬边界）
4. **零硬编码商品/星级/配方名单**
5. **诚实上下界 + 可执行终端尾段 + 独立三层审计**

其中第 5 条最关键：

> **上界 $\sup$ 内层必须精确求解**。一旦启用任何非完备裁剪，`validUpperBound` 强制输出 `null`。

这条红线的意思是：宁可承认"我算不出上界"，也不给一个假上界来骗自己"我已经最优了"。

---

## 10. 对我们最有价值的 10 个点

以下按我们实际已经吃到/值得吃的顺序：

| # | 点 | 出处 | 我们是否已移植 |
|---|---|---|---|
| 1 | 偷菜拒绝回执三分类（每日上限 / 409 边界 / 普通冷却） | `recordSnipeReceipt` | ✅ 2026-11-14 |
| 2 | 过期解禁退避 `[5,20,60,300]` | `guardOverdue` | ✅ 2026-11-14 |
| 3 | 掐点提交前服务端确认 | `executeStagedSnipe` | ✅ 2026-11-14 |
| 4 | 增量发现切片（游标持久化，每步让路） | `runIncrementalDiscoverySlice` | ❌ 我们仍是全量重扫（已加中断保护） |
| 5 | 偷菜四分支 EV（未发现/胜/平/负 + 区间） | `resolveRaidOutcomeDistribution` | ⚠️ 部分（点估计，无区间） |
| 6 | 擂台「先同步战报/开箱，后开打」 | `syncBattleProfilesAndPreparation` | ✅ 2026-11-14 |
| 7 | 擂台单场执行 + 可打断等待 | `runSingleArenaBout` | ✅ 2026-11-14 |
| 8 | HTTP 分桶限流（visit 2.2s / battle 1.2s） | `classifyBucket` | ❌ 我们统一 2.15s（保守） |
| 9 | 期末清算 + 续种流 | `evaluateTerminalLiquidationTail` / `projectContinuationFarmFlows` | ⚠️ 部分（有 `liquidationValue`，无续种流） |
| 10 | 事务日志 + 未知结果核对 | `executeTransaction` / `reconcileUnknownWithFreshWorld` | ❌ 未移植（架构级改动） |

**明确不值得移植的**：

- `planner/solve.mjs` 的 10,956 行求解器本身——我们已有 MCMF 分配 + Bellman 体力估值，日常经营够用
- `planner/bounds.mjs` 的拉格朗日上界——我们没有审计需求
- `audit/*` 全部——我们没有对外的"证明最优"义务
- `huancai` 彩金——站点已下线（410）

---

## 11. 版本演进快照（从 package.json releaseNotes）

| 版本 | 关键内容 |
|---|---|
| **v1.4.5**（2026-11-13） | 每日全部完成奖励 + 擂台每日宝箱修复 + 52 弟玩具摊抢占式执行器 + B26 仓库规则同步 |
| v1.4.4 | 根因修复（phase16 测试覆盖） |
| v1.4.3 及更早 | 见 `test/phase16-v144-root-cause-fixes.test.mjs` 与 git 历史 |

---

*本文档由 2026-11-14 通读整理。子代理报告的原始全文见 `docs/agent-reports/`。*

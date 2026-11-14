# yuyugu-kernel 全代码分析：每个功能域怎么决策、怎么算、怎么做

> **这份文档是什么**：把参考实现 `research/ref/yuyugu-kernel`（约 2.6 万行核心代码）**完整拆开**，讲清楚它在每个功能域里：
> **① 要决定什么** → **② 用什么目标函数/评分** → **③ 用什么算法算** → **④ 参数与阈值取多少** → **⑤ 算出来按什么顺序执行** → **⑥ 出错怎么退**。
>
> 不是「游戏规则说明书」，也不是「规则逐条对照」。是**代码本身的分析**——它面对什么局面，怎么想，怎么算，为什么这么算，误差在哪。
>
> 代码路径均相对 `research/ref/yuyugu-kernel/`。行号指向 2026-11-14 读到的快照。

## 目录

| 章 | 内容 |
|---|---|
| [0](#0-系统全景) | 系统全景：三层时间尺度 + 五段流水线 |
| [1](#1-一次-tick-的完整生命周期) | 一次 tick 的完整生命周期（进程、循环、状态、恢复） |
| [2](#2-状态建模从服务端-json-到规划器世界) | 状态建模：从服务端 JSON 到规划器世界 |
| [3](#3-目标函数它在最大化什么) | **目标函数：它在最大化什么**（终局估值是灵魂） |
| [4](#4-时间离散化事件桶) | 时间离散化：事件桶 |
| [5](#5-上界与影子价格拉格朗日松弛) | 上界与影子价格：拉格朗日松弛 |
| [6](#6-主规划-solveunifiedplan) | 主规划 `solveUnifiedPlan`：非预期主干 + 场景追索 |
| [7](#7-序列优化-optimizeandsimulatesequence) | 序列优化 `optimizeAndSimulateSequence` |
| [8](#8-前缀编译从计划到这一刻能发的包) | 前缀编译：从计划到「这一刻能发的包」 |
| [9](#9-种植种什么什么时候种浇几次水) | 种植：选作物、跨季溢出、浇水时机 |
| [10](#10-养殖喂食收集心情) | 养殖：喂食、收集、心情顺序 |
| [11](#11-加工配方链工坊槽位和卖货的联合) | 加工：模板、精确 DFS、分块贪心、扣料顺序 |
| [12](#12-卖货时序阶梯税) | 卖货：**MCMF 时序分配 + 阶梯容量 + 税** |
| [13](#13-采购货船与商店) | 采购：三阶段背包 DP、双分区拆包 |
| [14](#14-钓鱼挖矿炸弹随机产出的定价) | 钓鱼/挖矿/炸弹：期望产量与 CRN |
| [15](#15-偷菜从打不打到几点几分出发) | **偷菜：分支信念树 + 解禁推算 + 回执状态机** |
| [16](#16-擂台与战斗装备对手技能槽) | 擂台与战斗：确定性模拟器、换装成本 |
| [17](#17-站宠护理为什么它值得做) | 站宠护理：等级 = 擂台等级 |
| [18](#18-52d-玩具摊五子棋的离线求解) | 52D 玩具摊：五子棋离线求解 |
| [19](#19-修仙-10一个独立的资源闭环) | 修仙 1.0：灵力经济 + 17 阶段优先级 |
| [20](#20-修仙-20秘境是一个带血量约束的图搜索) | 修仙 2.0：秘境束搜索、配招、突破策略 |
| [21](#21-每日目标一个被单独拎出来的动作类型) | 每日目标：为什么用 `Infinity` |
| [22](#22-执行层限流重试对账) | 执行层：限流、重试边界、对账 |
| [23](#23-审计三层验证让计划可以被证明) | 审计：journal / replay / reference-solver |
| [24](#24-参数总表负面清单误差登记) | **参数总表、负面清单、16 项误差登记、移植排序** |

---

## 0. 系统全景

### 0.1 三层时间尺度

整套系统建立在**三个不同粒度**的决策层上，每层的算法和误差容忍度完全不同：

| 层 | 时间粒度 | 决策内容 | 算法 | 代码 |
|---|---|---|---|---|
| **执行层** | 秒级 | 这一刻发哪个 HTTP 请求、发什么动作 | 因果前缀编译 + 模拟校验 | `planner/compile-prefix.mjs`、`execution/http-client.mjs` |
| **规划层** | 岛日级（4 小时） | 未来 6 个岛日做什么：种什么、卖什么、买什么、偷谁 | 事件桶 + 序列搜索 + 专项求解器 | `planner/solve.mjs`、`planner/resources.mjs` |
| **估值层** | 12 个岛日 | 规划期末尾的剩余资产值多少钱 | 可执行终局清算模拟 | `model/objective.mjs` |

**关键设计**：这三层不是「越上层越粗略」的漏斗，而是**同一套规则模拟器**在三个时间窗上反复调用。执行层用 `simulateBatch` 逐动作验证合法性，规划层用同一个 `simulateBatch` 推演整条轨迹，估值层也用 `simulateBatch` 真的把库存卖掉。**全系统只有一份规则实现**，不存在“规划时用一个近似公式、执行时用另一套”的漂移。

### 0.2 五段流水线

```
① 观测      model/observations.mjs     服务端 JSON → ObservationEnvelope（world + beliefs + constraints）
   ↓
② 估值      model/objective.mjs        定义「什么才算好」：轨迹目标 + 终局清算价值
   ↓
③ 规划      planner/solve.mjs          6 岛日视野内搜索动作序列；bounds.mjs 提供上界用于剪枝/自检
   ↓
④ 编译      planner/compile-prefix.mjs 把计划编译成「当前时刻因果安全」的可执行前缀
   ↓
⑤ 执行      execution/*.mjs            发请求、处理回执、对账、持久化
```

### 0.3 唯一目标函数的数学形式

作者在 `DESIGN.md` 里把目标函数写成了显式公式（这在这个项目里是"宪法"级的东西）：

$$
J(\Pi \mid s_0, \mathcal{I}_0) = \sum_{\omega \in \Omega} p_\omega \left[ C_0 + \sum_{k} \gamma(t_k - t_0)\,\Delta C_{k}(\omega) + \gamma(t_H - t_0)\,V_{\text{tail}}\big(s_H(\omega), t_H, P_H(\omega)\big) \right]
$$

| 符号 | 含义 | 代码 |
|---|---|---|
| $\Omega, p_\omega$ | 外部供给场景及其概率（三档 tight/baseline/glut） | `observations.mjs:72-76` |
| $C_0$ | 初始现金 | `objective.mjs:1178` |
| $\gamma(\Delta t) = (1+\rho)^{-\Delta t/3600}$ | 小时折现因子（默认 $\rho = 0$） | `objective.mjs:25-28` |
| $\Delta C_k(\omega)$ | 第 $k$ 步动作的真实净现金流（含累进售卖税） | `simulateBatch` |
| $V_{\text{tail}}(s_H, t_H, P_H)$ | 期末可执行清算尾段净现金 | `objective.mjs:633-1141` |

**两条硬性约束**（`DESIGN.md:39`）：

1. **严禁在目标中二次扣除体力/原料的影子价格**——它们已经在状态转移里被精确扣减了。目标函数只数**真实现金**。
2. **终端尾段必须可执行**——不许用「市价 × 数量」估残值，必须构造真实的 `sell`/`craft` 动作并跑 `applyActions`。

这两条是理解整个系统的钥匙：**目标函数里没有"估值"，只有现金流**。所有「这东西值多少」的判断，都是通过"真的把它卖掉，看拿到多少钱"来回答的。

### 0.4 核心设计哲学（贯穿全部代码）

1. **不猜随机**：凡是随机动作（收获、钓鱼、挖矿、偷菜、擂台），要么用期望值进入目标函数，要么在搜索中按分布分支。`bounds.mjs:35-43` 甚至会**拒绝**对含随机动作的问题给出上界——宁可说“不知道”，也不给一个可能错误的保证。
2. **终局必须可执行**：期末库存不是按市价打个折就当钱，而是**真的构造卖单/加工单跑一遍模拟**（`objective.mjs:633-1141`）。卖不掉的东西价值严格为 0。
3. **因果安全**：计划里排在随机动作之后、依赖其未观测产出的动作，绝不提前提交（`compile-prefix.mjs:20-117`）。
4. **非预期性**：未来价格未知时，用「主干 + 场景追索」结构，主干部分所有场景共享决策，只有价格揭晓后才分叉（`solve.mjs:7458-7482`）。
5. **零魔法常数**：能用反事实轨迹差值算的，就不用调参（`selectCapexByTrajectoryDelta`，`solve.mjs:1439`）。
6. **宁可放弃也不出错**：所有 solver 都有明确的「拒绝给答案」路径（`plan-invalid`、`validUpperBound: null`、`refused-pruned-inner`）。

---

## 1. 一次 tick 的完整生命周期

> 文件：`cli/live-daemon.mjs`（988 行）+ `cli/controller.mjs`（约 800 行）+ `execution/async-planner.mjs`。这一章讲**程序在真实世界里怎么转起来**：一轮做什么、按什么顺序、什么时候睡、崩了怎么恢复。

### 1.1 进程与线程拓扑

```
┌─ live-daemon 主进程 ───────────────────────────────┐
│                                                     │
│   while (!stopping) {                              │
│     runLiveAccountTick()      ← 生命周期主体        │
│     sleep(clamp(nextWake - now))                   │
│   }                                                 │
│                                                     │
│   ├─ Phase A  偷菜快车道（可能在求解中被抢占触发）   │
│   ├─ Phase B  经济控制器 → 请求 Worker 求解          │
│   └─ Phase C  可抢占后台维护切片                     │
│                                                     │
└──────────────────┬──────────────────────────────────┘
                   │ postMessage(观察信封)
       ┌───────────▼───────────┐
       │  Worker 线程           │
       │  AsyncPlanManager      │
       │  solveWithHorizonStability()
       │  → solveUnifiedPlan()  │   ← 2,560 行求解器跑在这里
       └───────────────────────┘
```

**为什么求解必须在 Worker 里**：`solveUnifiedPlan` 一次可能跑几十秒。如果跑在主线程，期间 SIGTERM 无法响应、偷菜窗口无法抢占。放进 Worker 后，主线程可以随时 `worker.terminate()` 硬终止，代价只是丢掉这一轮的求解结果（下一轮重来）。

**跨进程互斥**靠账号锁 `.kernel.<account>.lock`，`withAccountLock` 支持死 PID 恢复（`execution/reconcile.mjs:20-62`）。

### 1.2 一轮 tick 的三段

```js
// cli/live-daemon.mjs:81-565（结构）
async function runLiveAccountTick(...) {
  // ── Phase A：偷菜快车道 ──
  if (nextSnipeUnlockSec - now <= physicalPrepLeadSec + 1) {
    await runUrgentStagedSnipe(); return          // 直接返回，不做任何别的
  }

  // ── Phase B：统一经济控制器 ──
  const effectiveDeadline = min(maxTickSolveMs, snipePrepDeadline)
  const r = await runControllerStep({ deadlineAtMs: effectiveDeadline, shouldPreemptFn })
  if (r.kind === 'committed') { updateWake(); return }   // 发了一笔，本轮结束

  // ── Phase C：后台维护（只在偷菜不阻塞时）──
  if (!snipeScheduler.shouldBlockBackgroundWork(now)) {
    await petCare()          // 每 180s
    await battleProfile()    // 每 120s / 宠物升级 / 装备脏
    await arenaBout()        // 冷却 8500ms
    await huancai()          // 每 600s
    await xianSlice()        // --enable-xian
    await npcToys()          // 52D 玩具摊
    await neighborDiscovery()// 2 页 / 4 探测
  }
  updateWake()
}
```

**核心原则：只要 Phase B 真的发出去了一笔事务，本轮就结束。** 一次 tick 只发一笔主岛事务，之后重新拉世界、重新求解。这是「滚动视野 + 单步执行」的极端形式——宁可每几秒重算一次，也不肯把一个可能已经过时的计划连着发出去。

### 1.3 Phase A：偷菜快车道为什么要独立

偷菜（raid）是**唯一一个「错过就没了」的事件**：解禁后几秒内不偷，作物就被别人偷走或被主人收走。而主岛求解可能要跑 45 秒。

```js
// cli/live-daemon.mjs:81-120
const lead = snipeScheduler.computePhysicalPrepLeadSec(...)  // 换装+网络提前量
if (nextUnlockSec - nowSec <= lead + 1) {
  await runUrgentStagedSnipeIfImminent()
  return
}
```

**这个提前量是算出来的，不是拍脑袋的**：`computePhysicalPrepLeadSec` 把「切增益装备要几笔事务、每笔的 POST 间隔（2.15s）、网络往返」都算进去，得到「最晚什么时候必须开始准备」。

**三重抢占**：

| 时机 | 机制 | 位置 |
|---|---|---|
| tick 开始前 | Phase A 直接短路，不进主规划 | live-daemon.mjs:81-120 |
| 求解进行中 | `shouldPreemptFn` 返回 true → `worker.terminate()` → 控制器返回 `deferred-by-deadline` → 同一 tick 立刻跑 Phase A | live-daemon.mjs:243-249, 319-328 |
| 求解结束后、提交前 | 锁内再检查一次 deadline 与 preempt | controller.mjs:540-552 |

### 1.4 Phase B：控制器一次决策的完整流程

```js
// cli/controller.mjs:399-629（结构）
async function runControllerStep(...) {
  // ① 入口检查：已超 deadline 或需抢占 → 立即退出
  if (shouldPreemptFn() || now >= deadlineAtMs) return { kind: 'deferred-by-deadline' }

  // ② 有未解决的事务 → 先对账
  if (journal.hasPendingUnknown()) {
    const w = await fetchWorldInLock()
    const rec = await reconcileUnknownWithFreshWorld(...)
    if (!rec.visitOnly) return { kind: 'blocked-pending-reconcile', retryAfterSec: 15 }
  }

  // ③ 拉权威世界 + 校时
  const rawWorld = await client.fetchWorld(); syncClock(rawWorld)

  // ④ 手操让位
  if (rawWorld.manualArcade?.active) return { kind: 'standby-manual-arcade' }

  // ⑤ 用「预留后的世界」做规划
  const planningWorld = applyUnknownReservations(rawWorld)   // 扣掉未知事务可能消耗的体力/罚款

  // ⑥ 只在没有未知事务时才拉邻居（邻居数据贵）
  const neighbors = remainingUnknown === 0 ? await fetchNeighbors() : []

  // ⑦ 构建观察信封
  const envelope = buildObservationEnvelope({ world: planningWorld, neighbors, ... })

  // ⑧ Worker 求解（可被 deadline / preempt 打断）
  const plan = await asyncPlanner.solveOrPreempt(envelope, {...})
  if (plan.abortedByDeadline) return { kind: 'deferred-by-deadline', retryAfterSec: 1 }
  if (plan.error) throw plan.error

  if (dryRun) return { kind: 'shadow-ready', plan }

  // ⑨ 锁内重新拉世界，确认计划还没过时
  return await withAccountLock(async () => {
    if (shouldPreemptFn() || now >= deadlineAtMs) return { kind: 'deferred-by-deadline' }
    const inLockWorld = await client.fetchWorld(); syncClock(inLockWorld)
    await reconcileAgain(...)
    if (inLockWorld.manualArcade?.active) return { kind: 'standby-manual-arcade' }

    // ⑩ rev 变了且不是「被动变化」→ 计划作废
    if (inLockWorld.rev !== planningWorld.rev &&
        !isFarmDomainPassiveCompatible(planningWorld, inLockWorld)) {
      planCache.invalidate()
      return { kind: 'stale-plan-invalidated', retryAfterSec: 1 }
    }

    // ⑪ 编译可执行前缀并提交（一次只发一笔事务）
    const compiled = compileExecutablePrefix(inLockWorld, plan)
    return await commitCompiledPlan(compiled)
  })
}
```

**每一步为什么存在**：

| 步骤 | 不这么做会怎样 |
|---|---|
| ② 先对账 | 上一轮发出去的事务结果未知，直接再发可能重复卖出/重复购买 |
| ④ 手操让位 | 玩家手动开的街机局用旧 `rev` 提交，任何后台写入都会让它 409 白玩 |
| ⑤ 预留体力 | 未知事务可能已经消耗了体力，按满体力规划会导致后续动作失败 |
| ⑥ 未知时才拉邻居 | 目录要连发 60 页 GET，能省则省 |
| ⑨ 锁内重拉世界 | 求解花了几十秒，这期间作物可能熟了、别人可能偷了你的菜、岛日可能翻了 |
| ⑩ rev 校验 | 唯一保证「执行的动作确实是规划时那个世界里的动作」的机制 |
| ⑪ 只发一笔 | 见 1.2 |

### 1.5 `isFarmDomainPassiveCompatible`：什么样的 rev 变化可以忽略

```js
// model/observations.mjs:235-289（语义）
// rev 涨了，但如果变化全部来自：
//   - 时间推进（作物生长、体力回复）
//   - state.xs（修仙切片）
//   - state.npc / state.arc（玩具摊、街机）
//   - 已售台账（自己的卖出回执）
// → 农场决策域没变，可以复用计划
// 否则 → 保守作废
```

**这是一个「白名单」而不是「黑名单」**：只承认能解释清楚的变化，解释不了就重算。宁可多跑一次求解器，也不肯在没看懂的世界状态上执行旧计划。

### 1.6 时间预算：什么时候睡、睡多久

```js
// cli/live-daemon.mjs:912-918
const sleepMs = clamp((nextWakeSec - nowServerSec) * 1000 + 150, 250, 120000)
// 无 nextWakeSec 时默认 now + 15s
```

| 来源 | 典型值 | 位置 |
|---|---|---|
| 主岛计划 `nextWakeSec` | 由 `solveUnifiedPlan` 计算 | solve.mjs:9737-9835 |
| 偷菜物理准备时刻 | 解禁前若干秒 | snipe-scheduler |
| 竞技场冷却 | 8500ms | live-daemon.mjs:437 |
| 邻居发现游标 | 15s | live-daemon.mjs:582-602 |
| 修仙 follow-up | 3s / 炼丹 19s / 打坐 30min | xian-cultivation.mjs:1672-1772 |
| 默认 | 15s | live-daemon.mjs:916 |
| 异常后 | 10s | live-daemon.mjs:967-970 |

**上限 120 秒**是刻意的：即使计划说「6 小时后才需要动」，也要每 2 分钟醒来看一眼——因为世界会变（别人偷你的菜、价格变了、手动操作）。

**睡眠期间按 500ms 分片**，保证 SIGTERM 能及时响应（967-976）。

### 1.7 Phase C 的顺序不是随意排的

```js
// cli/live-daemon.mjs:397-565，注释明确解释了顺序原因
宠物护理 → 战斗档案/宝箱/装备/属性点 → 单场竞技场 → 幻彩 → 修仙 → NPC 玩具摊 → 增量邻居发现
```

| 顺序 | 原因 |
|---|---|
| 宠物护理最先 | **站宠等级就是擂台等级**，等级影响面板属性；不先升级，后面的战斗准备算出来的胜率就是错的 |
| 战斗准备第二 | 要吃上宠物升级带来的新属性点 |
| 竞技场第三 | 冷却 8.5 秒不占装备锁，可以边等边做别的 |
| 修仙/NPC/发现最后 | 这三者都可被偷菜窗口抢占，放最后损失最小 |

**所有后台切片都是「协作式可抢占」**：进入前检查 `shouldBlockBackgroundWork`，步骤之间检查 `shouldAbortFn`。没有独立的墙钟 deadline——这是已知弱点（见 1.11）。

### 1.8 崩溃恢复：三层对账

```js
// execution/reconcile.mjs:64-106（恢复语义）
// ① reserved-and-durable（进程在发送前崩溃）
//    → 标记为 aborted-before-send，视为没发生
// ② submitted 但无回执
//    → 提升为 unknown
// ③ unknown + 新的世界快照
//    → reconcileUnknownWithFreshWorld 比对前后状态，推断是否真的发生了
```

| 层 | 机制 | 位置 |
|---|---|---|
| 发送前 | `recoverPendingTransactions` 把未发出的标为 aborted | reconcile.mjs:64-106 |
| 事务内 | `executeTransaction` 在临界区再恢复一次，检查未解决的 `act/xian-act` 阻塞 | reconcile.mjs:400-451 |
| 决策前 | 控制器发现非 visit 未知事务 → `blocked-pending-reconcile`，15 秒后重试 | controller.mjs:420-447 |

**visit（偷菜）的未知事务不阻塞农场动作**——这是一个刻意的例外：偷菜结果未知不应该把收获卡死。代价是可能多占一次偷菜配额（保守扩展到当前岛日）。

### 1.9 状态持久化：什么是磁盘上的真相

| 内容 | 位置 | 频率 |
|---|---|---|
| 事务 journal / unknown / wait 决策 / 世界快照 | `logs/live/journal/<account>` | 每笔交易、每次 wait；内容寻址 |
| 偷菜日程 | `logs/live/snipe-schedule.<account>.json` | SnipeScheduler 读写 |
| 对手档案（战斗历史） | `logs/live/opponent-profiles.json` | 战斗引擎更新 |
| 幻彩状态 | `logs/live/huancai-state.<account>.json` | 每 600s |
| PID | `logs/live/live-daemon.<account>.pid` | 启动写、退出删 |
| **计划缓存** | **仅内存** | 重启后为空 |

**计划缓存不落盘是刻意的**：重启后世界一定变了，重放旧计划没有意义。重启的第一件事就是重新拉世界、重新求解。

**PID 文件只是标记，不防重复实例**——多实例只能靠账号锁串行化（已知弱点）。

### 1.10 影子模式：一个只读的平行宇宙

`cli/shadow-daemon.mjs` 用**同一个 `runControllerStep`**，但设 `dryRun: true`，且发送函数直接抛 `SHADOW_READ_ONLY_FIREWALL`：

```js
// shadow-daemon.mjs:11-21, 23-50
// HTTP 防火墙：只允许 GET /api/*；非 GET 直接抛错；15s 超时；redirect: manual
// journal: null、lockRootDir: null → 完全隔离
// session / 对手档案 / 偷菜日程 → 只读
// 唯一写入：logs/shadow/
```

它记录三样东西：

1. **如果执行会做什么**（`nextTransactionKind` + `batchSummary`）；
2. **上一轮预测 vs 这一轮实际**（`liveTransitionSincePrevTick`：金币差、净值差）；
3. **独立 Layer-3 审计**：对确定性前缀跑 `buildAuditDecisionReport`，给出 verdict 与后悔下界。

**它不自动计算预测误差**——只把数据记进 JSONL，分析要靠下游脚本（`logs/shadow/<account>/shadow-decisions.jsonl`）。

### 1.11 这一层的已知弱点

| 弱点 | 后果 | 位置 |
|---|---|---|
| 后台切片没有总墙钟预算 | 一次慢 HTTP 可能拖长整个 tick | live-daemon.mjs:394-565 |
| 没有进程级熔断/自动重启 | 连续失败只关闭 horizon stability，不会停进程 | live-daemon.mjs:149-154, 265-276 |
| Worker 错误是固定 10 秒重试，无指数退避 | 持续故障时高频重试 | live-daemon.mjs:967-970 |
| PID 文件不防重复实例 | 多实例冲突只能靠账号锁 | live-daemon.mjs:870-874 |
| `computeNextXianWakeSec` 内部跑完整规划 | 一轮里可能重复规划多次，CPU 浪费 | xian-cultivation.mjs:1687-1691 |

### 1.12 命令行参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--account` | `main` | 账号名 |
| `--base-url` / `MEME_BASE_URL` | `https://52dmeme.com` | 站点地址 |
| `--session` / `SESSION_PATH` | `.session[.<acct>].json` | 会话文件 |
| `--partner-account` | `secondary`/`main` | 伙伴账号（只读世界） |
| `--rules` | `rules/pet-world-rules.js` | 规则文件 |
| `--data-dir` | `logs/live` | 日志/锁/档案根 |
| `--self-ids` / `MEME_SELF_IDS` | 空 | 邻居过滤自己的 ID |
| `--domestic-only` / `--no-steal` | 关 | 关闭偷菜；secondary 自动进入 |
| `--allow-capex` / `--no-capex` | domestic 默认开 | 资本开支 |
| `--max-tick-solve-ms` | 45000 | 单次求解 deadline |
| `--dry-run` / `--once` / `--check-update` | 关 | 只规划 / 单 tick / 只检查更新 |
| `--enable-xian` / `MEME_ENABLE_XIAN=1` | 关 | 开启修仙切片 |
| `--xian-break-mode` | `smart` | smart / eager / manual |
| `--xian-auto-fuse` | 关 | 自动融合 |
| `--xian-fuse-target` | `auto` | 融合目标属性 |
| `--xian-opt3` / `--xian-auto-all` | 关 | 同时开事件/社交/斗法/秘境 |
| `--disable-npc` | NPC 默认开 | 关闭 52D 玩具摊 |

---

## 2. 状态建模：从服务端 JSON 到规划器世界

> 文件：`model/observations.mjs`（784 行）+ `model/rules-adapter.mjs`（1,029 行）。这一层负责把「服务端返回的一坨 JSON」变成「规划器能推理的世界」，以及把「不确定的东西」变成「显式的区间」。

### 2.1 观测信封（ObservationEnvelope）

`buildObservationEnvelope`（`observations.mjs:714-784`）是整个系统的输入契约：

```js
{
  schemaVersion: 1,
  account: 'main',
  observedAtMs,
  mechanicalTruth: {
    rulesHash,          // 规则文件哈希（版本变了就重算）
    clockStart,         // 岛钟起点（b12 时钟校准的锚点）
  },
  observed: {
    serverNow,          // 服务端时间
    rev,                // 世界版本号
    world: cleanWorld,  // 净化后的世界快照
    partnerWorld,       // 伴侣号的世界（如果有）
    knownSoldByIsleIndex, // 已知的「每个岛日每种物品卖了多少」
  },
  beliefs: {
    supplyInferences,      // 每个物品：从当前报价反推的供给区间
    scenarios,             // 外部供给场景（三档）
    visitBeliefs,          // 本次可访问邻居的信念（能偷多少、发现概率、胜率区间）
    upcomingVisitBeliefs,  // 即将解禁的邻居信念（按解禁时刻排序）
  },
  constraints,             // 用户约束（归一化后）
  constraintsHash,         // 约束哈希（变了要重新规划）
  reservedBudgets: {
    stealUsedOrReservedThisIsleDay,  // 本岛日已用/预留的偷菜次数
  },
}
```

**设计要点**：把「观测事实」（`observed`）、「推断信念」（`beliefs`）、「用户约束」（`constraints`）**分成三个不相交的区**。规划器可以信任 `observed`，但不能信任 `beliefs`——所有 belief 都带明确的区间或概率。

### 2.2 净化：只保留白名单字段

```js
// observations.mjs:16-36
function stripSecretsDeep(val) { ... }        // 递归删掉敏感字段（token、session）
export function sanitizeWorldSnapshot(rawWorld) {
  const out = {}
  for (const k of ALLOWED_WORLD_TOP_KEYS)     // ← 白名单，不是黑名单
    if (Object.hasOwn(rawWorld, k) && rawWorld[k] !== undefined)
      out[k] = stripSecretsDeep(structuredClone(rawWorld[k]))
  return out
}
```

**为什么用白名单**：服务端 JSON 里可能夹带登录态、内部 ID、调试字段。黑名单永远漏，白名单才不会。同时 `structuredClone` 保证规划器不会意外改到原始快照。

### 2.3 从报价反推市场供给

服务端只给你**当前价格**，但规划器需要知道「市场上已经卖了多少」。`inferSupplyBoundsFromQuote`（`observations.mjs:38-70`）反推：

```js
// 价格 = round(基准价 × 供给因子)，所以供给因子 = 价格 / 基准价，带 ±0.5 的舍入误差
const rawLo = quote <= 1 ? 0 : (quote - 0.5) / dBase
const rawHi = (quote + 0.5) / dBase
const sMin = clamp(rawLo, 0.8, 1.06)
const sMax = clamp(rawHi, 0.8, 1.06)

// 供给因子反推销量：S = 1.06 - 0.3 × (vol / depth)  ⇒  vol = ((1.06 - S) / 0.3) × depth
const volMin = clampedCeil ? 0 : Math.ceil(((1.06 - sMax) / 0.3) * depth - 1e-9)
const volMax = clampedFloor ? Infinity : Math.floor(((1.06 - sMin) / 0.3) * depth + 1e-9)

return {
  deterministicBase: dBase,
  supplyFactorInterval: [sMin, sMax],
  impliedVolumeInterval: [volMin, volMax],
  clampedFloor, clampedCeil,   // ← 区间是否被 [-0.5, +0.5] 截断（信息量不足的标志）
}
```

**三个细节**：
1. **±0.5 的舍入误差必须带进去**，否则会误以为已知精确值
2. **clamp 到 [0.8, 1.06]** 是规则本身的边界（`supplyFactor = clamp(1.06 - 0.3*(sold/depth), 0.8, 1.06)`）
3. **`clampedFloor`/`clampedCeil` 标记**告诉我们这个区间是「真的算出来的」还是「被规则边界截断后无信息」——后者意味着可能已经卖爆了

### 2.4 三档外部供给场景

未来价格取决于「别人卖了多少」，而这是不可观测的。系统的处理是**离散成三个场景**：

```js
// observations.mjs:72-76
export const DEFAULT_EXTERNAL_SUPPLY_SCENARIOS = [
  { id: 'tight',    weight: 0.25, externalSupplyFactor: 1.03 },  // 市场紧俏（别人卖得少）
  { id: 'baseline', weight: 0.50, externalSupplyFactor: 0.96 },  // 基准
  { id: 'glut',     weight: 0.25, externalSupplyFactor: 0.84 },  // 市场饱和（别人卖得多）
]
```

**概率分布的均值是 0.9475，不是 1.0**——这是一个**保守偏置**：宁可低估未来收入，也不高估。这和三档权重的对称性（0.25/0.5/0.25）放在一起看，说明作者是有意把「中枢」压低一点。

### 2.5 未来报价的预测函数

```js
// observations.mjs:101-118
export function quoteFutureItemUnderScenario(adapter, {
  itemId, isleDayIndex, isleDayStr, currentPrices,
  externalSupplyFactor = 0.96, selfSoldPrevIsleDay = 0,
}) {
  // ① 同一岛日 → 用当前价（无不确定性）
  if (isleDayIndex === 0 && currentPrices?.[itemId] > 0) return currentPrices[itemId]

  // ② 未来岛日：基准价 × clamp(外部因子 + 自身冲击, 0.8, 1.06)
  const depth = R.marketDepth(itemId)
  const selfImpact = -0.3 * (selfSoldPrevIsleDay / max(1, depth))   // ← 自己昨天卖的量也压今天的价
  const effS = clamp(externalSupplyFactor + selfImpact, 0.8, 1.06)
  return adapter.quoteWithSupplyFactor(itemId, isleDayStr, effS)
}
```

**注意 `selfImpact` 的符号和量级**：自己卖得越多，明天价格越低。这形成一条**跨岛日的自我竞争约束**——今天多卖 1000 个，明天每个少卖 `0.3 × 1000/depth × 基准价`。这让「同一批货分几天卖」比「一天卖完」更值钱，是规划器理解售卖时机的基础。

### 2.6 邻居岛信念：逐格统计能偷什么

`buildVisitTargetBelief`（`observations.mjs:453-545`）把一座邻居岛变成一份「战利品清单 + 风险区间」：

```js
// ① 发现概率（由目标岛的警觉 buff 与自己的隐蔽 buff 决定）
const detProb = R.b12Detection(ownerState, visitorState, nowSec)

// ② 每格偷几个：有 carry buff 就 2 个，否则 1 个
const hasCarry = !!R.b12Effect(visitorState, 'carry', nowSec)
const unitsPerSpot = hasCarry ? 2 : 1
const guardWinUnitsPerSpot = unitsPerSpot + 1        // ← 打赢守家，每格多偷 1 个

// ③ 逐格统计（畜栏要求 cap >= 2，地块要求有作物）
for (const p of isle.barn) if (p.steal && animal.cap >= 2) { totalSpots++; lootBag[product] += unitsPerSpot }
for (const p of isle.plots) if (p.steal && p.c)           { totalSpots++; lootBag[crop] += unitsPerSpot }

// ④ 体力成本：5 + (格数-1) × 1，上限 15
const energyCost = R.b12StealCost(visitorState, nowSec, totalSpots, 5, 1, 15)

// ⑤ 胜率区间：没有数据就诚实地说不知道
const winInterval = !hasGuard ? [1, 1]
  : (post?.winInterval ?? [0.25, 0.85])              // ← 宽先验，不假装精确
const lossInterval = !hasGuard ? [0, 0]
  : (post?.lossInterval ?? [1 - winInterval[1], 1 - winInterval[0]])

// ⑥ 罚款估算：min(5000, round(1.2 × 市价))
const estFine = Math.min(5000, Math.round(marketValueAtBase * 1.2))
```

**`estimationSource` 三分类**（后面 `resolveRaidOutcomeDistribution` 会用它选口径）：

| 值 | 条件 | 后续处理 |
|---|---|---|
| `no-guard-deterministic` | 没有守家 | 确定性，胜率 100% |
| `empirical-posterior-interval` | 有守家 + 打过这个对手（`post.simulated` 或 `sampleCount > 0`） | 用后验区间中点 |
| `unobserved-wide-prior` | 有守家 + 完全没打过 | **自动切保守口径**（用区间下界） |

### 2.7 偷菜四分支分布

`resolveRaidOutcomeDistribution`（`observations.mjs:352-451`）把上面的信念展开成**离散结果分支**：

```js
const pDet = hasGuard ? detectionProb : 0
const pUndet = 1 - pDet

const rawOutcomes = [
  { kind: 'undetected',  prob: pUndet,      lootBag: 全量偷的包, fineCoins: 0 },
  { kind: 'guard-win',   prob: pDet * wCond, lootBag: 打赢的包,  fineCoins: 0 },
  { kind: 'guard-tie',   prob: pDet * dCond, lootBag: {},        fineCoins: 0 },
  { kind: 'guard-loss',  prob: pDet * lCond, lootBag: {},        fineCoins: estFine },
].filter(o => o.prob > 1e-12)
```

**三种口径决定 `wCond` / `lCond` 取区间的哪个点**：

```js
const useConservative = mode === 'conservative'
  || (mode === 'auto' && estimationSource === 'unobserved-wide-prior')
const wCond = !hasGuard ? 1 : (useConservative ? wLo : (useOptimistic ? wHi : wMid))
const lCond = !hasGuard ? 0 : (useConservative ? lHi : (useOptimistic ? lLo : lMid))
```

| 口径 | 胜率取值 | 败率取值 | 何时用 |
|---|---|---|---|
| `conservative` | **区间下界** wLo | **区间上界** lHi | 完全没数据时（自动） |
| `optimistic` | 区间上界 wHi | 区间下界 lLo | 显式要求时 |
| 中点（默认） | wMid | lMid | 有后验数据时 |

**输出四种聚合量**：

```js
expectedLootBag     // 每种物品的期望偷到量（概率加权）
guaranteedLootBag   // 每种物品在所有分支里的最小值（保底）
expectedFineCoins   // 期望罚款
worstCaseFineCoins  // 最坏罚款
```

这四种量分别给不同用途：期望值进目标函数，保底值用于约束检查（比如「至少要偷到 X 才值得去」），罚款用于风险约束。

### 2.8 用户约束归一化

`normalizeUserConstraints`（`observations.mjs:120-154`）把「用户随便写的配置」变成规划器的硬约束：

```js
const isDomesticSecondary = raw.domesticOnly || account === 'secondary'

// 副账号（专门种田）默认允许 capex、禁止偷菜；主账号默认相反
const defaultAllowCapex = isDomesticSecondary
const defaultMaxSteals = isDomesticSecondary ? 0 : (raw.maxStealsPerIsleDay ?? null)
const defaultMinStealSpots = isDomesticSecondary ? 999999 : (raw.minStealSpots ?? 0)

const baseCapexTargets = isDomesticSecondary
  ? { plotsMax: 24, barnMax: 8, trapsMax: 4, houseMax: 0, toolsMax: { rod: 4, pick: 4, spr: 3 } }
  : { plotsMax: 0, barnMax: 0, trapsMax: 0, houseMax: 0, toolsMax: { rod: 0, pick: 0, spr: 0 } }
```

**完整约束字段**：

| 字段 | 默认（主号） | 含义 |
|---|---|---|
| `allowCapex` | false | 是否允许资本开支（扩地/升级/买房） |
| `capexTargets` | 全 0 | 各类设施的目标上限 |
| `maxCapexPaybackSec` | 72 小时 | 投资回收期上限（超过就不投） |
| `maxStealsPerIsleDay` | null（不限） | 每岛日最多偷几次 |
| `minStealSpots` | 0 | 少于这么多格就不去 |
| `allowThiefBuffPurchase` | true | 是否允许买小偷增益道具 |
| `allowGuardBuffPurchase` | false | 是否允许买守家增益 |
| `cashReserveFloor` | 0 | 现金保留下限 |
| `staminaReserveFloor` | 0 | 体力保留下限 |
| `staminaReserveUntilSec` | 0 | 体力保留到这个时刻为止 |

### 2.9 农场域摘要与计划复用

规划一次要几秒到几十秒。如果这期间世界**只在时间上推进**（作物没熟、体力只回了一点），上一轮的计划仍然有效，可以继续执行。判断这件事的就是这一组函数。

#### 静态摘要

```js
// observations.mjs:194-214
export function computeStaticFarmStateDigest(world) {
  const farmState = {}
  for (const k of Object.keys(world.state).sort()) {
    if (NON_STATIC_FARM_STATE_KEYS.has(k)) continue    // ← 排除时间相关字段
    farmState[k] = k === 'cnt' ? canonicalizeStateCntForFarmDigest(...) : canonicalizeForDigest(...)
  }
  return sha256({ clockStart, coins, prices, rumors, state: farmState }).slice(0, 24)
}
```

**排除的字段**（`NON_STATIC_FARM_STATE_KEYS`）：那些「随时间自然变化」的字段（比如体力计时）。这样「什么都没发生，只是过了 10 秒」不会改变摘要。

#### 判定被动兼容

```js
// observations.mjs:235-289
export function isFarmDomainPassiveCompatible(adapter, baseWorld, liveWorld, { isWaitPlan, staticDigestBase }) {
  // ① 时间只能往前
  if (liveNow < baseNow) return false
  // ② 跨了岛日或自然日 → 世界规则变了，不能复用
  if (isleIndex(liveNow) !== isleIndex(baseNow)) return false
  if (worldDay(liveNow) !== worldDay(baseNow)) return false

  // ③ rev 涨了但找不到任何解释 → 保守地认为农场被动过
  if (liveRev > baseRev) {
    if (xs 未变 && npc 元数据未变 && arc 元数据未变) return false
  }

  // ④ 农场静态摘要必须完全相同
  if (computeStaticFarmStateDigest(baseWorld) !== computeStaticFarmStateDigest(liveWorld)) return false

  // ⑤ 体力推进必须与规则模拟一致（不能凭空多/少）
  if (advanceTimeOnly(baseWorld, liveNow).state.en !== liveWorld.state.en) return false
  if (advanceTimeOnly(baseWorld, liveNow).state.enT !== liveWorld.state.enT) return false

  return true
}
```

**第 ③ 步的逻辑最容易看反**：rev 涨了，但修仙状态（`xs`）、NPC 记录、游乐馆记录**都没变** → 说明 rev 的变化**没有已知原因** → 保守起见不复用（可能有人在别处动了农场）。

反过来说，如果 rev 涨了**且**这三者之一变了，那么 rev 变化有了解释，可以继续用摘要判断。

### 2.10 手动游乐馆让位

```js
// observations.mjs:291-343
export const DEFAULT_MANUAL_ARCADE_TTL_SEC = 180

export function getManualArcadeStandbyInfo(world, nowSec, options = {}) {
  const cur = world.state?.arc?.cur        // { g: 游戏ID, seed, t: 开始时刻 }
  if (!cur) return { active: false }
  const resumeAtSec = startedAtSec + ttlSec
  const remainingSec = max(0, resumeAtSec - refNowSec)
  return { active: refNowSec < resumeAtSec, game: cur.g, remainingSec, ... }
}
```

**为什么需要这个**：站点前端 `/isle-arcade.js` 在 `arcStart` 时捕获当时的 `world.rev`，`arcEnd` 用旧 rev 提交。**期间任何后台写入都会让玩家这一局 409 白玩**（次数照扣，前端不重试）。所以托管检测到 `arc.cur` 就整轮让位，180 秒 TTL 兜底 Esc 退出。

### 2.11 观测层刻意不做的事

| 不做 | 理由 |
|---|---|
| 不预测天气 | 天气是**确定性可算**的（`weatherOf(isleDay)`），不需要推断 |
| 不拟合对手隐藏属性 | 只给区间，让上层按保守/中点/乐观三档使用 |
| 不填补缺失数据 | 缺数据就是缺数据，`estimationSource` 显式标注 |
| 不记历史 | 历史由 `audit/journal.mjs` 单独管理 |

### 2.12 规则模拟器：全系统唯一的「真相源」

`model/rules-adapter.mjs` 不是一个数据适配层，而是**把规则模块包装成可反复调用的模拟器**。规划、执行、估值三层全部调同一份实现。

#### 2.12.1 `simulateBatch`：最小执行单元

```js
// rules-adapter.mjs:374-404
function simulateBatch(world, actions, { t, prices, rand, prng, auto = false } = {}) {
  const nextWorld = cloneWorld(world)
  const ctx = {
    t: simT, day: R.worldDay(simT),
    rand: activeRand,             // ← 随机源可注入
    prices, coins: nextWorld.coins, auto,
  }
  const res = R.applyActions(nextWorld.state, actions, ctx)   // ← 直接调站点规则
  nextWorld.coins = nextWorld.coins - (res.spend || 0) + (res.earn || 0)
  nextWorld.now = simT
  nextWorld.nextIsleAt = nextIsleBoundary(simT, cs)
  const allOk = actions.length <= 40
    && res.out.length === actions.length
    && res.out.every((o) => o && o.ok === true)
  return { afterWorld: nextWorld, result: res, allOk }
}
```

**三个关键设计**：

1. **`rand` 可注入**：这让随机动作可以被「精确枚举」（见 2.12.3）而不是靠采样。
2. **默认 PRNG 与 `world.rev` 无关**：
   ```js
   const activeRand = makeDeterministicPrng((simT ^ 0x52d001) >>> 0)
   ```
   注释写得很明确：「Default PRNG is strictly independent of `world.rev` so revision bumps never perturb simulated yields」。**同样的经济状态必须得到同样的模拟结果**，否则规划结果会因为一次无关的 rev 变化而抖动。
3. **`allOk` 是硬判据**：任何一个动作返回 `ok !== true` 就整体失败。上层（前缀编译、终局清算）用它决定是否可以提交。

#### 2.12.2 `advanceTimeOnly`：纯时间推进

```js
// rules-adapter.mjs:577-586
function advanceTimeOnly(world, toSec, { futurePrices = null } = {}) {
  const nextWorld = cloneWorld(world)
  R.refresh(nextWorld.state, targetSec)     // ← 规则里的 refresh：作物生长、动物产出、体力回复
  nextWorld.now = targetSec
  nextWorld.nextIsleAt = nextIsleBoundary(targetSec, cs)
  if (futurePrices) nextWorld.prices = { ...futurePrices }
  return nextWorld
}
```

**它和 `simulateBatch` 的分工**：`advanceTimeOnly` 只推进时间（不花体力、不产生收入），`simulateBatch` 才执行动作。估值层的「按槽位推进时间 → 发一批动作」就是这两者的交替调用。

#### 2.12.3 精确枚举单个随机动作：`enumerateExactSingleStochasticOutcomes`

> `rules-adapter.mjs:411-575`。这是全项目最精巧的工程技巧之一：**不做蒙特卡洛，直接算出精确的离散分布**。

原理：规则里的随机判定都是形如 `rand() < p` 或「按权重抽一个」。如果能构造一个**恰好落在目标结果区间中点**的随机数序列，就能让模拟器必然产生该结果；而该结果的概率就是区间的长度。

```js
const makeSeqRng = (vals) => {
  let idx = 0
  return () => (idx < vals.length ? vals[idx++] : 0.5)   // ← 按顺序吐出预设的分位数
}
```

**收获（harvest）的枚举**：

```js
const w = auto ? 3 : p.w                       // 洒水器/雨天 = 浇满 3 次
const gold   = 0.05 + 0.1  * w                 // 金星概率
const silver = 0.2  + 0.08 * w                 // 银星概率
const qSpecs = [
  { q: 2, p: gold,   u: gold * 0.5 },                                  // 金星
  { q: 1, p: silver, u: gold + silver * 0.5 },                         // 银星
  { q: 0, p: 1 - gold - silver, u: gold + silver + 0.5 * (1-gold-silver) }, // 普通
]
const extraP = 0.3 + 0.08 * w                  // 额外 +1 个的概率
// 每个品质分支 × 每个数量分支，用两个分位数驱动模拟
for (const qs of qSpecs) for (const ns of nSpecs) {
  const step = simulateBatch(refreshed, [action], { rand: makeSeqRng([qs.u, ns.u]) })
  branches.push({ prob: qs.p * ns.p, afterWorld: step.afterWorld, result: step.result })
}
```

**钓鱼（fish）的枚举**：需要 4 个分位数——是否上钩、钓到哪种鱼（按权重累计的中点）、是否金星、是否银星。

**挖矿（mine）的枚举**：一击分支遍历每种矿；两击分支遍历**有序矿对** `(i, j)`：

```js
for (let i = 0; i < pool.length; i++)
  for (let j = i; j < pool.length; j++) {
    const pairMult = i === j ? 1 : 2                  // 有序对：不同矿有两种顺序
    const pPair = pTwoHits * pairMult * (w[i]/W) * (w[j]/W)
  }
```

**代价与收益**：一次收获从「模拟 1000 次」变成「模拟 6 次」，而且概率是**精确值**而不是估计值。缺点是分支数随动作复杂度指数增长（两击挖矿是 O(n²)），所以只对**单步**做精确枚举，多步序列仍然用采样（第 7 章）。

#### 2.12.4 `exactPlotTimings`：逐天气段重算成熟时刻

> `rules-adapter.mjs:615-666`。这是种植决策的基石——**预测这块地什么时候能收**。

```js
const base = (rawPlot.h && crop.regrow ? crop.regrow * (fast ? 0.8 : 1) : crop.grow)
           * 60 * (fast ? 0.8 : 1)                       // 分钟 → 秒；新纪元 ×0.8
const g = Number(rawPlot.g || 0)                          // 已浇水累计的加速秒数

let cursor = isAlreadyRipe ? max(0, rawPlot.t) : max(nowSec, rawPlot.t)
let matureAt = null
for (let step = 0; step < 32; step++) {
  const iDay = R.isleDay(cursor)
  const isRain = R.weatherOf(iDay) === 1
  const auto = !!(isSprinkledPlot || isRain)
  const totalSeg = Math.max(1, base * (auto ? 0.6 : 1) - g)   // ← 洒水器/雨天 ×0.6
  const candMature = Math.max(cursor, Math.ceil(rawPlot.t + totalSeg))
  const segEnd = nextIsleBoundary(cursor, activeCs)
  if (candMature < segEnd) { matureAt = candMature; break }   // 在本岛日内成熟
  cursor = Math.max(cursor + 1, segEnd)                       // 跨岛日：下一段换天气
}
```

**必须逐段循环的原因**：天气按岛日变化，而天气决定是否 `×0.6`。如果预测出的成熟时刻跨过了岛日边界，就必须**用下一岛日的天气重新算**。最多 32 段（8 个岛日）够了。

**`unlockAt`（偷菜保护期结束）用同样的循环**，只是目标时刻换成 `rawPlot.t + totalSeg + protectSec`（`protectSec` 默认 1800 秒）。

**三个容易搞错的点**：
1. **`g` 是已浇水累计的加速秒数**，不是浇水次数。规则里每次浇水砍「当前剩余时间」的 25%，累计到 `g` 里。
2. **`fast` 只对 `rawPlot.t >= ISLE_LAUNCH` 的作物生效**（新纪元后种的），老作物不享受 ×0.8。
3. **反季检查**用的是 `rawPlot.t` 所在岛日的季节（`crop.seasons.includes(seasonOf(isleDay(rawPlot.t)))`），而不是当前季节。

#### 2.12.5 `simulateStandingPlotLifecycle`：一整茬作物的完整推演

> `rules-adapter.mjs:696-849`。给定一个已种下的地块，推演到它「彻底空出来」为止的每一次收获。

```js
const maxTimes = crop.regrow ? crop.times : 1
for (let guard = 0; guard < maxTimes + 2 && curPlot.h < maxTimes; guard++) {
  if (isPlotWithered(...)) { ...枯萎，需要清理... }
  const timing = exactPlotTimings(curPlot, spr, evalFrom, cs)
  if (!timing) { truncatedByCutoff = true; break }

  const cycleStartRain = weatherOf(isleDay(curPlot.t)) === 1     // ← 看的是种植时的天气
  const harvestRain = weatherOf(isleDay(timing.matureAt)) === 1  // ← 看的是收获时的天气
  const autoAtHarvest = spr || harvestRain
  const baseW = clamp(curPlot.w, 0, 3)
  const manualWaters = (spr || cycleStartRain) ? 0
    : Math.max(0, Math.min(3, dryManualWaterStages) - baseW)      // ← 默认只补到 2 次
  const wateredStages = autoAtHarvest ? 3 : Math.min(3, baseW + manualWaters)
  const wasStolen = harvests.length === 0 && rawPlot.sv?.length > 0   // ← 只有第一茬会被偷

  const stepEn = manualWaters * waterCost + harvestCost
  harvests.push({ matureAt, unlockAt, wateredStages, manualWaters, stepEn,
                  expectedUnits, expectedByQuality, postHarvest })
  ...
}
```

**四个容易搞错的点**：

| 点 | 正确做法 | 为什么 |
|---|---|---|
| **浇几次** | `dryManualWaterStages = 2`（默认补到 **2** 次，不是 3 次） | 规划时保守假设只浇 2 次；洒水器/雨天另外算 |
| **`cycleStartRain` vs `harvestRain`** | 各自看各自时刻的天气 | 种植时下雨 = 本茬自动浇水；收获时下雨 = 收获品质按浇满算 |
| **被偷只影响第一茬** | `wasStolen = harvests.length === 0 && sv.length > 0` | 连茬的第二茬开始，保护期重新计算，历史被偷记录不影响 |
| **期末裁剪（cutoff）** | 未成熟的按**进度比例** `frac` 计入 | 期末地里长了一半的作物不是 0 价值 |

期末裁剪的精确写法：

```js
if (cutoffEndSec >= 0 && timing.matureAt > cutoffEndSec) {
  const denom = Math.max(60, timing.matureAt - cycleOrigin)
  const numer = Math.max(0, cutoffEndSec - cycleOrigin)
  const frac = Math.min(1, numer / denom)
  partialProgressAtCutoff = {
    atSec: cutoffEndSec - 1, frac,
    expectedByQuality: [.. * frac, .. * frac, .. * frac],  // ← 按比例计入期望产出
  }
  truncatedByCutoff = true
}
```

#### 2.12.6 `simulateCropLifecycleFromPlant`：从播种开始的成本收益

```js
// rules-adapter.mjs:853-925
const res = {
  crop, harvests, endSec, occupiedSec,       // 何时成熟、占多久
  seedCost: crop.seed,
  plantEnCost,                               // 播种 2 点
  careAndHarvestEn,                          // 浇水 + 收获
  endClearEnCost,                            // 结束时若枯萎要清理 1 点
  totalStaminaSpent,                         // ← 上面三项之和
  totalExpectedUnits,
  ...
}
```

**带 memo**（`key = clockStart:sprinkled:startSec:cutoff:dryW:cropId`），上限 16,384 条。因为「同一时刻、同样洒水状态、同一作物」的推演结果完全确定，重复算没有意义。

#### 2.12.7 `exactBarnTimings`：畜栏的三个关键时刻

```js
// rules-adapter.mjs:928-986
const untilMax = Math.min(pen.f + 86400, age.retireAt || Infinity)   // 产出累计上限：喂食后 24 小时

// ① 下一个产出时刻
const cand = st.nextP + R.b12AnimalPeriod(pen.k, st.nextP)
if (cand <= untilMax) nextOwnUnitAt = cand

// ② 偷菜解禁：需要攒够 2 个（规则要求给主人留 1 个，所以 cap < 2 的动物永远偷不到）
let cursor = Math.max(pen.p || 0, adultAt)
let count = heldCount          // 已有的产出数
while (count < 2) {
  const per = R.b12AnimalPeriod(pen.k, cursor)
  const end = cursor + per
  if (end > untilMax) break
  count++
  if (count === 1) firstReady = end
  if (count === 2) secondReady = end
  cursor = end
}
if (secondReady > 0) {
  if (st.n >= 2) stealUnlockAt = Math.ceil(Math.max(secondReady, firstReady) + protectSec)
  else stealUnlockAt = Math.ceil(Math.max(secondReady, firstReady > 0 ? firstReady + protectSec : 0))
}

// ③ 饥饿与可再喂
hungryAt:  pen.f + 86400       // 喂食后 24 小时没产出 → 饿死
canFeedAt: pen.f + 8 * 3600    // 喂食后 8 小时才能再喂
```

**这里推翻了一个常见误解**：8 小时不是「喂一次管 8 小时」，而是「**最早可以再喂**」；真正的产出硬上限是 `pen.f + 86400`（喂食后 24 小时）。

---

## 3. 目标函数：它在最大化什么

> 文件：`model/objective.mjs`（1,230 行）。这是全项目的「价值观」所在——后面所有算法都在为这个函数服务。

### 3.1 顶层公式

`evaluateTrajectoryObjective`（`objective.mjs:1143-1189`）给出一次规划的总价值：

```
总目标值 = 初始现金
         + Σ [每笔现金流 × 折现因子(距 t0 的秒数)]
         + 终局清算价值 × 折现因子(规划期末 - t0)
```

写成代码：

```js
// objective.mjs:1157-1178
let discountedNetCashFlow = 0
for (const ev of cashEvents)
  discountedNetCashFlow += ev.netCashDelta * discountFactor(rate, ev.atSec - t0)

const tail = evaluateTerminalLiquidationTail(...)
const tailDiscount = discountFactor(rate, tH - t0)
const totalObjectiveValue = initialCoins + discountedNetCashFlow + tail.totalTerminalValue * tailDiscount
```

**为什么初始现金要加进去**：因为目标值要能跨规划轮次比较（这一轮的方案 vs 下一轮的方案）。加常数不改变本轮排序，但让数值可解释为「最终净资产」。

### 3.2 折现：默认是 0，但机制完整

```js
// objective.mjs:25-28
export function discountFactor(discountRatePerHour, elapsedSec) {
  if (!(discountRatePerHour > 0) || !(elapsedSec > 0)) return 1
  return Math.pow(1 + discountRatePerHour, -(elapsedSec / 3600))
}
```

| 参数 | 默认值 | 含义 |
|---|---|---|
| `discountRatePerHour` | **0** | 每小时折现率。0 = 不折现 |

**默认 0 是有意为之**：游戏内现金没有利息，折现的唯一理由是「同样的钱早到手更灵活」。作者保留了机制但不默认启用，说明他认为在 6 岛日视野内这个效应可以忽略——真正的时间成本通过**终局估值**（3.6 节）体现，而不是靠折现率调参。

### 3.3 规划视野与终局参数

```js
// objective.mjs:3-23
const cfg = {
  horizonSec: 6 * 14400,                    // 6 个岛日 = 24 小时实时
  extendedHorizonDeltaSec: 2 * 14400,       // 视野稳定性扩展 +2 岛日
  discountRatePerHour: 0,
  terminalSupplyMode: 'conservative-floor', // 终局价格模式
  conservativeSupplyFactor: 0.8,            // 保守供需因子
  maxLiquidationBatches: 8,                 // 终局最多 8 个 batch
  energyTerminalCreditPerPoint: 0,          // 期末体力每点值多少现金
  continuationIsleDays: 12,                 // 期终后再模拟 12 个岛日
}
```

**这几个数字的含义**：

- **6 岛日 = 24 小时实时**：作物大多 1–3 岛日成熟，动物 2–8 岛日，加工与售卖阶梯按岛日/自然日刷新。6 岛日刚好能覆盖「种下去—收获—加工—卖掉」一条完整链路，又不会让搜索空间爆掉。
- **终局续算 12 个岛日**：`continuationIsleDays: 12` 意味着期末那批还没收获的作物，会被继续模拟 12 个岛日（3 天多实时），看它们最终能变成多少钱。这是**防止规划器短视**的关键——没有这个，规划器会在视野末尾停止种地。
- **conservativeSupplyFactor: 0.8**：预测未来价格时，假设供需因子至少是 0.8（即价格按最差情况估）。`terminalSupplyMode: 'conservative-floor'` 就是「用一个保守下界估终局价」。
- **energyTerminalCreditPerPoint: 0**：期末剩余体力默认**不值钱**。这是保守的——体力不能卖，留着也未必用得上。
- **maxLiquidationBatches: 8**：每个 batch 最多 40 个动作（服务端限制），8 个 batch = 320 个动作。终局清算不会无限排下去。

### 3.4 终局价格怎么估

```js
// objective.mjs:30-53
export function buildTerminalPrices(adapter, worldAtHorizon, initialWorld, objectiveCfg, scenarioSupplyFactor = null, prevIsleSoldMap = null) {
  const tH = worldAtHorizon.now, t0 = initialWorld.now
  // ① 如果期末和现在在同一个岛日 → 直接用当前价格
  if (adapter.R.isleIndex(tH) === adapter.R.isleIndex(t0) && initialWorld.prices)
    return { ...initialWorld.prices }

  // ② 否则按岛日重建报价，供给因子取保守值（或指定场景值）
  const sFactor = objectiveCfg.terminalSupplyMode === 'scenario-matched'
    ? scenarioSupplyFactor : objectiveCfg.conservativeSupplyFactor

  for (const id of adapter.graph.sellableIds) {
    const soldPrev = prevIsleSoldMap?.[id] || 0
    const depth = adapter.R.marketDepth(id)
    // 自己昨天卖的量也会压价！
    const effS = soldPrev > 0
      ? Math.max(0.8, Math.min(1.06, sFactor - 0.3 * (soldPrev / depth)))
      : sFactor
    prices[id] = adapter.quoteWithSupplyFactor(id, iDay, effS)
  }
}
```

三个要点：

1. **同岛日直接用当前价**——没有不确定性，不用估。
2. **保守因子 0.8**——未来价格按最差供需估。这是我方自己卖出量的影响之外，再加一层外部保守。
3. **自己卖的量也压价**：`sFactor - 0.3 × (soldPrev / depth)`，即昨天卖了库存深度 10% 就再降 3%。这个公式和真实的 `supplyFactor = clamp(1.06 - 0.3*(sold/normal), 0.8, 1.06)` 同构（见规则模块）。

### 3.5 多季续作农场流：`projectContinuationFarmFlows`

> `objective.mjs:66-471`。这是估值层最复杂的一段，**400 行**，解决的问题是：规划期结束时地里还站着作物，这些作物在接下来的 12 个岛日里能变成多少钱？

#### 它模拟什么

```
输入：期末世界 + 12 个岛日的价格槽位（contSlots）
输出：{ standingPlotValue, renewalPlotValue, totalPlotContinuationValue }
```

两条价值来源：

| 项 | 含义 | 算法 |
|---|---|---|
| **standingPlotValue** | 地里已经种着的作物，按各自成熟时刻继续收获 | `simulateStandingPlotLifecycle` 逐次收获事件 |
| **renewalPlotValue** | 地块空出来后，按当季最优作物**继续复种** | 贪心选择收益率最高的作物，一批一批推演 |

#### 关键设计 1：体力不是免费的

```js
// objective.mjs:108-125
let remFreeEn = freeRegenEnPool                     // 自然回复的体力额度
const coffeePricePerEn = 15000 / 60                 // 250 D/点：用咖啡补体力时的边际成本

const previewStaminaCost = (enUnits, disc = 1.0) => {
  if (!(enUnits > 0)) return 0
  const freeTake = Math.min(remFreeEn, enUnits)     // 先吃免费额度
  const paidTake = Math.max(0, enUnits - freeTake)  // 超出部分按咖啡价买单
  return (freeTake * staminaShadowCost + paidTake * Math.max(staminaShadowCost, coffeePricePerEn)) * disc
}
```

**这是全项目最重要的一条经济逻辑**：终局续作也要花体力，而体力有两个来源——
- **自然回复的免费额度**（按 `regen 180 秒/点` 在 12 岛日内算出总量，减去已被加工承诺消耗的部分）
- **超出的部分要用咖啡买单**，边际成本 250 D/点

所以「期末继续种地」不是白捡钱，而是**先用免费体力，再按咖啡价付费**。这就自动决定了：低收益作物在体力用完后就该停，高收益作物才值得买咖啡继续种。

#### 关键设计 2：作物选择用「收益率」，不是「总利润」

```js
// objective.mjs:340-368
const previewCyclePerPlotAt = (crop, startSec) => {
  const spec = adapter.simulateCropLifecycleFromPlant(crop, {...})
  let revBatch = 0
  for (const h of spec.harvests)
    revBatch += evaluateHarvestBatch(crop.id, eq, evalSec, false)
  const cycleEnValBatch = previewStaminaCost(spec.totalStaminaSpent * batchCount, dStart)
  const cycleNetPerPlot = (revBatch - spec.seedCost * batchCount * dStart - cycleEnValBatch) / batchCount
  return {
    spec, cycleNetPerPlot,
    rawRatePerPlotSec: cycleNetPerPlot / spec.occupiedSec,   // ← 收益率：净利 / 占地秒数
  }
}
```

**为什么是单位时间收益率**：地块是稀缺资源，同一块地种 A 占 3 岛日赚 10 万，种 B 占 1 岛日赚 4 万，收益率 B 更高（4万/岛日 vs 3.3万/岛日），应该种 B。用总利润会选错。

#### 关键设计 3：跨季溢出的正确修正

```js
// objective.mjs:377-406
// 如果这个作物的收获会跨过下一个季节边界 → 它占用了本该种下一季作物的时间
if (nextSeasonB > simT && nextSeasonB < contEndSec && prev.spec.endSec > nextSeasonB)
  hasCrossSeasonSpill = true
...
if (hasCrossSeasonSpill && rNextSeason > 0 && spec.endSec > nextSeasonB) {
  const spillNextSec = spec.endSec - nextSeasonB
  const surplusVsWait = cycleNetPerPlot - spillNextSec * rNextSeason
  if (!(surplusVsWait > 1e-6)) continue                 // 跨季不划算，直接淘汰
  const preBoundaryWindowSec = Math.min(spec.occupiedSec, Math.max(60, nextSeasonB - simT))
  score = surplusVsWait / preBoundaryWindowSec           // 用"剩余价值 / 边界前的可用窗口"重新打分
}
```

这段的逻辑非常精巧：如果种 A 会跨季，那么它真正的代价是「挤占了下一季作物在边界前的那段时间」。于是：
- 先算出下一季最优作物的收益率 `rNextSeason`
- 溢出秒数 × 该收益率 = **机会成本**
- 减去机会成本后如果**还**赚钱（`surplusVsWait > 0`），才保留
- 打分用的是「剩余价值 / 边界前窗口」，而不是「剩余价值 / 总占地」——因为在边界前的那段窗口才是真正被占用且无法复用的资源

#### 关键设计 4：批处理同质地块

```js
// objective.mjs:324-333
// 把"同一时刻空出 + 同样洒水状态 + 同样需要清理"的地块合并成一批
for (let pIdx = 0; pIdx < plotN; pIdx++)
  if (freeAtSec[pIdx] === simT && sprinkled(pIdx) === isSpr && needsClear[pIdx] === ncFlag)
    batchPlots.push(pIdx)
```

**为什么**：地块之间只有这三个属性影响后续收益，同质地块的决策必然相同。合并后一次模拟算 `batchCount` 份，复杂度从 `O(地块数 × 候选作物)` 降到 `O(地块组数 × 候选作物)`。这是整个估值层能跑得动的前提。

### 3.6 可执行终局清算：`evaluateTerminalLiquidationTail`

> `objective.mjs:633-1141`，**500 行**。这里回答的问题不是「库存值多少钱」，而是「**把库存真的卖掉，能拿到多少现金**」。

#### 为什么不能用市价 × 数量

因为游戏里有五层约束会把「纸面价值」打折：

1. **售卖阶梯**：同种作物每个自然日只有前 150 个按 100%、150–400 按 85%、400 以上按 70%
2. **累进售卖税**：资本超过 300 万后有 1‰/3‰ 的边际税
3. **工坊槽位**：加工每岛日 80 次，要加工就得占槽位
4. **体力**：加工要 1 点/次，体力不够加工不了
5. **品质池**：q2 只有那么多，不能凭空按 q2 卖

所以必须**真的模拟一遍**。

#### 解法：单槽位 vs 多槽位

```js
// objective.mjs:661-720
if (explicitTerminalPrices != null || contSlots.length <= 1) {
  // 【单槽位】一个岛日内清仓：按 q2→q1→q0 排序，直接卖
  for (const id of itemIds.sort())
    for (const q of [2, 1, 0]) { ... sellActions.push({a:'sell', id, q, n}) }
  // 每 40 个一批，用 simulateBatch 真的跑
}
// 【多槽位】跨多个岛日/自然日：见下
```

**单槽位为什么按 q2→q1→q0**：高品质单价高，但**共享同一个阶梯额度**（`sc_<crop>` 统计的是所有品质的总和）。所以先用额度卖高价的，是凸优化下的正确贪心。

#### 多槽位的完整流程（五步）

```js
// objective.mjs:722-1141
// ① 把 12 个岛日的槽位按自然日分组（因为阶梯按自然日刷新）
// ② 加工规划：160 次迭代的贪心
// ③ 已加工产出从加工槽开始排卖
// ④ 初始库存：作物按自然日分段填满 150/400 阶梯，非作物找最佳槽位
// ⑤ 用 advanceTimeOnly + simulateBatch 按时间顺序真实执行
```

**第 ② 步的加工贪心**（`objective.mjs:916-981`）：

```js
for (let iter = 0; iter < 160; iter++) {
  let bestChoice = null
  for (每个岛日槽位 k) {
    if (剩余工坊槽位 <= 0) continue
    if (该槽位可用体力 < 1) continue
    for (每个加工模板 tpl) {
      const outSale = 产出在最早可卖槽位的售价
      const rawOpp = 原料的机会成本（按它最佳卖出价）
      const marginPerSlot = (outSale.val - rawOpp) / tpl.craftSlots   // ← 每个工坊槽位的净增值
      if (marginPerSlot > 1e-6 && 优于当前最优) bestChoice = ...
    }
  }
  if (!bestChoice) break        // 没有正收益的加工 → 停
  // 决定批量：最多 8 个，且按边际递减检查
  for (let m = 2; m <= bestChoice.chunk; m++) {
    const nextOpp = previewOpportunityCost(avail, rawIn, m)
    if (unitOutVal - (nextOpp - prevOpp) <= 1e-6) break   // 边际已经不赚了
    chunk = m
  }
  applyDeductRaw(avail, rawIn, chunk)
}
```

**为什么用「每槽位净增值」而不是「每批次净增值」**：工坊槽位是真正的瓶颈资源（80 槽/岛日），所以应该按槽位定价。这和 `bounds.mjs` 里把工坊槽位当作约束、把对偶值暴露成 `craftShadowByIsle` 是同一个思想。

**第 ④ 步的阶梯分配**（`objective.mjs:1019-1060`）：

```js
// 每个自然日生成三段可卖额度
for (let ndIdx = 0; ndIdx < D_CONT; ndIdx++) {
  const sc0 = getScAtNdIdx(ndIdx, id)          // 这个自然日已卖了多少
  const cap0 = Math.max(0, 150 - sc0)          // 第一段：还能按 100% 卖多少
  const cap1 = Math.max(0, 400 - Math.max(150, sc0))  // 第二段：还能按 85% 卖多少
  if (cap0 > 0) segments.push({cap: cap0, score: bestUnit * 1.00})
  if (cap1 > 0) segments.push({cap: cap1, score: bestUnit * 0.85})
  segments.push({cap: rem, score: bestUnit * 0.70})    // 第三段：永远 70%
}
segments.sort((a, b) => b.score - a.score)   // 优先卖单价最高的配额
```

这是一道**带容量约束的贪心分配**：把所有「自然日 × 单价档」的组合按单价排序，依次填满。因为每段的边际价格是递减的（1.0 → 0.85 → 0.70），所以按单价排序贪心等价于最优（这是经典的凹成本流问题的性质）。

**第 ⑤ 步：真的跑模拟**

```js
// objective.mjs:1074-1099
for (let s = 0; s < S; s++) {
  const combined = [...slotCraftActions[s], ...slotSellActions[s]]
  simWorld = adapter.advanceTimeOnly(simWorld, sl.atSec, { futurePrices: sl.prices })  // ← 推进时间
  const beforeCoins = simWorld.coins
  for (每 40 个一批) {
    const step = adapter.simulateBatch(simWorld, batch, { t: sl.atSec, prices: sl.prices })
    if (!step.allOk) allValid = false
    simWorld = step.afterWorld
  }
  discountedNetCash += (simWorld.coins - beforeCoins) * sl.discFromTH
}
```

**这带来的三个正确性保证**：
- 税是**真实累进**的（模拟器按当时余额算）
- 阶梯是**真实消耗**的（`sc_` 计数被模拟器更新）
- 体力是**真实消耗**的（`en` 被模拟器扣减）
- 任何一步非法（比如体力不够）`allValid` 会变 false，上层可以据此拒绝这个方案

### 3.7 体力可行性：`maxFeasibleAddEnAtSlot`

```js
// objective.mjs:832-874
const maxFeasibleAddEnAtSlot = (targetK) => {
  // 检查：如果给第 k 个加工槽加 X 点体力，后面已承诺的加工槽还够不够
  const checkAdd = (addEn) => {
    let curEn = initEn, curEnT = baseEnT
    for (let m = 0; m < firstSlotByIsle.length; m++) {
      const sec = contSlots[firstSlotByIsle[m]].atSec
      if (curEn < enMaxCap && sec > curEnT) {          // 自然回复
        const add = Math.floor((sec - curEnT) / regenEvery)
        if (add > 0) { curEn = Math.min(enMaxCap, curEn + add); ... }
      }
      const spendHere = spentEnByCraftSlot[m] + (m === targetK ? addEn : 0)
      if (curEn < spendHere) return false               // 这里就断了
      curEn -= spendHere
    }
    return true
  }
  // 二分找最大可行加量
  let ans = craftEnCost, lo = craftEnCost + 1, hi = enMaxCap
  while (lo <= hi) { const mid = (lo+hi)>>1; if (checkAdd(mid)) {ans=mid; lo=mid+1} else hi=mid-1 }
  return ans
}
```

**这是个精确的前缀可行性检查**：体力只能靠自然回复（每 180 秒 1 点，上限 200），所以「第 k 个槽位能加多少体力」取决于前面所有槽位消耗后的余量，以及到第 k 个槽位之间回复了多少。用二分找到最大可行值——因为 `checkAdd` 关于 `addEn` 单调（加得越多越容易不可行）。

### 3.8 滚动推迟病检测

```js
// objective.mjs:1196-1230
export function detectRollingDeferral(commitmentHistory = []) {
  // 检测「每轮都计划下一轮卖，永远不卖」的病态
  for (const step of commitmentHistory) {
    if (step.executedSellQty > 0) { consecutiveForwardShifts = 0; continue }  // 卖了就重置
    if (step.newExternalShock === true) { consecutiveForwardShifts = 0; ... }  // 有新信息就重置
    if (step.plannedSellAtSec > prevTargetSec) consecutiveForwardShifts++
  }
  if (consecutiveForwardShifts >= 2)
    return { rollingDeferralDetected: true, reason: 'rolling-horizon-endpoint-shift-without-new-information' }
}
```

**为什么要检测这个**：滚动视野规划有个经典病态——如果价格随时间缓慢上涨，每轮规划都会说「下一轮再卖更划算」，于是永远不卖。检测条件是**连续 2 次在没有新信息的情况下把卖出时点往后推**。这是对 `round2-design-review.md §3` 里 `p(t) = 100 - 1/(t+1)` 反例的直接防御。

---

## 4. 时间离散化：事件桶

> 文件：`planner/resources.mjs`（376 行）。规划器不在连续时间上搜索，而是把未来切成**事件桶（bucket）**，每个桶代表「从上一个事件到下一个事件之间」。

### 4.1 为什么用事件桶

游戏的状态变化是**离散事件驱动**的：作物成熟、动物产出、自然日刷新、岛日刷新、偷菜解禁。两次事件之间，除了体力自然回复，世界状态不变。所以：

- 在两次事件之间做任何决策，结果都一样 → 只需在每个事件点上做决策
- 这让搜索空间从「连续时间」变成「十几个关键节点」

### 4.2 事件源的完整清单

```js
// resources.mjs:29-173
addPoint(t0, 'now', true)                                   // ① 现在（硬边界）

// ② 自然日边界（00:00 UTC+8），最多 16 个
for (...) addPoint(nextNaturalDayBoundary(ndCursor), 'natural-day-reset', true)

// ③ 岛日边界（4h 活跃时钟，22:00-08:00 冻结），最多 32 个
for (...) {
  if (i === 0 && nextId - minGap > t0)
    addPoint(nextId - minGap, 'isle-day-end-supremum', false)  // 岛日结束前 2 秒的"上确界"
  addPoint(nextId, 'isle-day-reset', true)
}

// ④ 长夜开始/结束
for (...) addPoint(ev.at, ev.kind, true)

// ⑤ 体力回满时刻
let capAt = rawInitEn >= enMax
  ? t0 + fullSpanSec
  : Math.max(t0 + regenEvery, baseEnT + (enMax - rawInitEn) * regenEvery)
for (let step = 0; step < 8 && capAt < firstIsleEnd; step++) {
  addPoint(capAt, 'stamina-regen-cap', false)
  capAt += fullSpanSec                                  // 每回满一次加一个点
}

// ⑥ 多管体力周转批（当前体力 + 可吃物品 > 上限时，会边吃边耗）
if (extraTurnoverEn > 0) { ... addPoint(turnSec, 'stamina-turnover-batch', false) }

// ⑦ 地块成熟时刻
for (每个地块) {
  const timing = adapter.exactPlotTimings(p, R.sprinkled(state, i), t0, clockStart)
  addPoint(timing.matureAt, `plot-mature:${i}`, false)
}

// ⑧ 动物产出 / 饥饿时刻
for (每个畜栏) {
  const bt = adapter.exactBarnTimings(pen, t0, clockStart)
  addPoint(bt.nextOwnUnitAt, `barn-ready:${i}`, false)
  addPoint(bt.hungryAt, `barn-hungry:${i}`, false)
}

// ⑨ 显式确定性到达（外部注入）
addPoint(arr.atSec, 'deterministic-arrival', true)

// ⑩ 即将到来的偷菜解禁时刻（硬边界，绝不合并）
addPoint(rSec, 'upcoming-raid-unlock', true)

// ⑪ 钓鱼时间窗开启（按岛小时：14400/24 = 600 秒一个岛小时）
for (...) if (h !== prevHour && windowHours.has(h)) addPoint(probe, `fish-hour:${h}`, false)
```

**几个值得注意的设计**：

| 设计 | 理由 |
|---|---|
| **`isle-day-end-supremum`（岛日结束前 2 秒）** | 服务端有 `minGap: 2` 秒的动作间隔。想在岛日最后一刻做完动作，必须在边界前 2 秒发出 |
| **`stamina-regen-cap` 最多 8 个** | 一个岛日 4 小时，从空体力回满要 200×180 秒 = 10 小时，所以要跨多个岛日。8 个足够覆盖视野 |
| **`stamina-turnover-batch`（体力周转批）** | 当前体力 + 可吃食物总能量 > 上限时，说明要「吃—用—再吃」，每批的周转时刻要单独拆桶 |
| **`upcoming-raid-unlock` 是硬边界** | 偷菜解禁是**抢时效**的关键时刻，绝不能被 5 秒合并窗口吞掉 |

### 4.3 合并规则与桶数上限

```js
// resources.mjs:177-205
// 软-软合并：同自然日 + 同岛日 + 间隔 ≤ 5 秒 → 合并，保留最晚的时间戳
if (!pt.hardBoundary && !prev.hardBoundary && sameNd && sameId && pt.atSec - prev.atSec <= coalesceWindowSec) {
  for (const r of pt.reasons) prev.reasons.add(r)
  prev.atSec = pt.atSec
}

// 上限裁剪：先保 t0 + 所有硬边界，再保留最早的软事件
const selectWithinCap = (pts, cap) => {
  const hard = pts.filter(p => p.atSec === t0 || p.hardBoundary)
  if (hard.length >= cap) return hard.slice(0, cap)
  const keepSoft = pts.filter(p => p.atSec !== t0 && !p.hardBoundary).slice(0, cap - hard.length)
  return [...hard, ...keepSoft].sort((a, b) => a.atSec - b.atSec)
}
```

**默认 `maxBuckets`**：`solveUnifiedPlan` 传的是 **16**（`solve.mjs:7451`），`buildEventBuckets` 自己的默认是 20。桶越少搜索越快，但可能丢掉远处的关键事件。16 是两者的折中。

### 4.4 视野稳定性：`preservePrefixThroughSec`

```js
// resources.mjs:208-220
// 滚动视野扩展 H → H+ΔH 时，先保留 [t0, preservePrefixThroughSec] 的桶选择不变
const prefixPts = merged.filter(p => p.atSec <= preservePrefixThroughSec)
const tailPts = merged.filter(p => p.atSec > preservePrefixThroughSec)
const keptPrefix = selectWithinCap(prefixPts, pCap)
const keptTail = selectWithinCap(tailPts, maxBuckets - keptPrefix.length)
```

**解决的问题**：视野从 6 岛日扩到 8 岛日时，如果重新选桶，远处新增的事件可能把近处的软事件挤出 16 个名额——导致**近期的决策点被偷走**，规划结果抖动。加上 `preservePrefixThroughSec` 后，前缀部分的桶选择被冻结，只有尾部会变。

### 4.5 非预期性：`isTrunkBeforePriceReveal`

```js
// resources.mjs:248-249
// 第一个岛日边界之前的所有桶共享 'trunk'（主干），因为那时还看不到下一岛日的价格
isTrunkBeforePriceReveal: isleDayOffset === 0,
```

这个字段是**场景追索树的分叉点**：主干部分的决策必须对所有价格场景都成立（非预期性），只有价格揭晓之后才能按场景分别决策。第 6 章会讲它怎么用。

### 4.6 三组期望产出公式

规划器评估钓鱼/挖矿/炸药时用的不是实测，而是这三条解析公式：

```js
// resources.mjs:319-334 —— 挖矿
export function expectedMineYieldPerHit(adapter, state, isleDayStr) {
  const floor = Math.max(1, Math.min(state.mine.max, R.PICK_FLOOR[pickLv] || 8))
  const pool = R.ORES.filter(o => o.floor <= floor)
  // 权重：基础权重 × 高价矿在雷暴天加成 × 镐子等级对深层矿的加成
  const weights = pool.map(o => o.w * (o.price >= 12000 && weather === 3 ? 1.6 : 1) * (1 + (floor - o.floor)/40))
  const expectedHits = 1 + (0.25 + 0.05 * pickLv)     // ← 命中次数的期望
  return { floor, expectedHits, byOre: {...} }
}

// resources.mjs:336-353 —— 炸药
const expectedDrops = 6 + 2 * (0.3 + 0.05 * pickLv)   // ← 6 + 2×(0.3+0.05L) 个矿
// 权重额外给 ≥7000 的矿 1.35 倍

// resources.mjs:355-376 —— 钓鱼
const miss = Math.max(0.05, 0.22 - 0.04*rodLv - (useBait ? 0.08 : 0) - (weather===1 ? 0.05 : 0))
const catchProb = 1 - miss
const pGold = 0.08 + 0.05 * rodLv
const pSilver = (1 - pGold) * 0.28
const boost = (useBait ? 2 : 1) * (weather === 1 ? 1.5 : 1)   // 高价鱼权重加成
```

**这三组公式的用途**：给体力分配提供**期望收益/体力**的比值，决定「这 4 点体力该去钓鱼还是挖矿还是留着」。注意它们都显式建模了工具等级（镐/鱼竿）和天气的交互——不是拍脑袋，是照着规则里的概率表反推的。

---

## 5. 上界与影子价格：拉格朗日松弛

> 文件：`planner/bounds.mjs`（462 行）。这一个文件只做一件事：**给「未来能赚多少钱」算一个数学上严格的上界**。

### 5.1 它为什么存在

搜索算法需要剪枝：如果某个分支的「当前收益 + 未来上界」已经低于当前最优解，就可以剪掉。上界越紧，剪得越多。

但更重要的是**自检**：如果求解器算出的方案**超过了理论上界**，那一定是 bug。

### 5.2 它什么时候拒绝给上界

```js
// bounds.mjs:26-53
if (!candidateSetComplete || innerPruningApplied)
  return { validUpperBound: null, status: 'refused-pruned-inner',
           reason: 'Inner candidate set was pruned or incomplete; refusing to report invalid upper bound.' }

for (const stAct of ['harvest','fish','mine','bomb','trap','visit','npc','scratch'])
  if (allowed.has(stAct))
    return { validUpperBound: null, status: 'not-applicable-stochastic',
             reason: `Action '${stAct}' has stochastic transitions; deterministic weak-duality bound not claimed.` }
```

**这两条拒绝规则是本文件最重要的部分**：

1. **候选集不完整就不给界**——弱对偶要求内层问题在**完整的**可行域上求最优。如果候选集被剪过，得到的可能不是真上界。
2. **含随机动作就不给界**——因为随机动作的收益是随机的，「上界」需要是分布意义上的概念（比如期望上界），而弱对偶只适用于确定性转移。作者宁可返回 `null`，也不把一个样本或启发式误标成上界。

这个设计说明：**上界不是用来跑主流程的，是用来做正确性保证的**。主流程不依赖它。

### 5.3 数学模型

这是一个多期资源分配问题：

```
max  Σ_s Σ_i Σ_q [单价(i,s) × 销量(i,q,s)]
s.t. 每个物品每个槽位的累计销量 ≤ 累计供给       （余额约束）
     每个岛日的 q2/q1 品质池约束
     每个岛日的作物阶梯约束（150 / 400）
     每个岛日的工坊槽位约束（80）
     每个槽位的体力前缀约束（自然回复上限）
     每个自然日的咖啡/食物次数约束
```

对偶化所有约束后，拉格朗日函数是：

```
L(λ) = 初始现金 + Σ_c λ_c × rhs_c + Σ_j ub_j × max(0, obj_j - Σ_c a_{cj} λ_c)
```

**内层对每个变量有闭式解**：`x_j = ub_j` 当且仅当 `obj_j - Σ a λ > 0`，否则 `x_j = 0`。这是弱对偶的直接应用——因为变量之间除约束外没有耦合，内层问题是线性的，极值必在边界。

### 5.4 约束与变量的完整清单

```js
// bounds.mjs:190-330 —— 约束
cQ2(id)        // 每个物品的 q2 品质池上限
cQ12(id)       // 每个物品的 q1+q2 池上限
cPrefixItem(id, s)  // 每个物品每个槽位的累计供给（前缀和）
cCraftIsle(isle)    // 每个岛日的工坊槽位（80 - 已用）
cPrefixEn(b)        // 每个槽位的累计体力（初始 + 自然回复）
cCropTier(id, nd, tier)  // 作物阶梯：tier0 是 150 个，tier1 是接下来 250 个

// bounds.mjs:233-388 —— 变量
sell(i,q,s,tier)    // 槽位 s 卖物品 i 品质 q 在阶梯 tier 的数量
craft(recipe,s)     // 槽位 s 加工某个配方
stockBuy(item,s)    // 在某个岛日买货船货
coffee(s)           // 在某天喝咖啡（消耗现金，获得体力）
eat(spec,s)         // 在某天吃可食用作物（消耗库存，获得体力）
```

注意 **`craft` 变量的约束项是跨槽位的**：加工消耗原料，从槽位 b 开始的所有前缀都会受影响；同时产出又会在之后的槽位增加供给（`-1` 系数）。这是它能给出紧界的关键。

### 5.5 投影次梯度求解

```js
// bounds.mjs:390-443
const lambda = new Float64Array(M)
// 热启动：物品余额的对偶值设为其最高报价的 1.5 倍
for (const id of items) {
  let maxP = BASE_PRICE[id] * 1.5
  for (const sl of allSlots) maxP = Math.max(maxP, sl.prices[id] * 1.5)
  lambda[cPrefixItem(id, S-1)] = maxP
}

for (let iter = 0; iter < subgradientIterations; iter++) {   // 默认 60 次
  // ① 计算 L(λ) 和次梯度
  for (每个约束 c) subgrad[c] = rhs_c
  let dualVal = initCoins + Σ λ_c rhs_c
  for (每个变量 j) {
    const rc = obj_j - Σ λ_c a_cj
    if (rc > 0) {
      dualVal += ub_j * rc
      for (每个约束项) subgrad[c] -= a_cj * ub_j
    }
  }
  if (dualVal < bestUpper) { bestUpper = dualVal; bestLambda = λ }

  // ② 投影次梯度步
  const stepSize = (0.85 / (1 + 0.12 * iter)) * (Math.max(100, bestUpper * 0.05) / Math.sqrt(normSq))
  lambda[c] = Math.max(0, lambda[c] - stepSize * subgrad[c])   // ← 严格投影到 λ ≥ 0
}
```

**几个细节**：

| 细节 | 作用 |
|---|---|
| **热启动为 1.5 倍最高价** | 第 0 步就有合理的对偶值，不用从 0 慢慢爬 |
| **`lambda[c] === 0 && subgrad[c] > 0` 时次梯度置 0** | 已在对偶可行域的边界上，且约束不紧，不该继续往负方向推 |
| **步长 `0.85/(1+0.12iter)`** | Polyak 型衰减，前 10 步大步探索，之后收敛 |
| **`Math.max(0, ...)`** | 不等式约束的对偶乘子必须非负，这是弱对偶成立的前提 |

### 5.6 返回值与影子价格

```js
// bounds.mjs:445-461
const validUpperBound = objectiveCfg.discountRatePerHour > 0
  ? Math.ceil(bestUpper * 1e6 - 1e-6) / 1e6    // 有折扣 → 向上取整（保守）
  : Math.floor(bestUpper + 1e-6)               // 无折扣 → 向下取整（保守）

return {
  validUpperBound,
  status: 'valid-weak-duality-bound',
  craftShadowByIsle,      // ← 每个岛日工坊槽位的影子价格
  dualConstraintCount: M,
  variableCount: vars.length,
}
```

**`craftShadowByIsle` 是唯一对外暴露的对偶信息**——它告诉规划器「多一个工坊槽位，最多能多赚多少」。这个值可以用来判断买工坊升级值不值。

**取整方向很讲究**：上界要保证「不小于真实最优」，所以有折扣时向上取整、无折扣时向下取整（因为无折扣的原问题本身就是整数现金流，向下取整仍然 ≥ 真值）。

---

## 6. 主规划 `solveUnifiedPlan`：非预期主干 + 场景追索

> 文件：`planner/solve.mjs:7387-9946`（约 2,560 行）。这是**决策总装配线**：把一个游戏快照变成「未来 6 岛日的完整动作表 + 一个 raid 行程表 + 下次该几点醒」。

### 6.1 它要决定的四件事

| # | 决策 | 为什么不能分开算 |
|---|---|---|
| ① | **国内经营**：种什么、养什么、加工什么、何时卖哪批 | 共享体力预算、共享工坊槽位、共享销售额度 |
| ② | **CapEx**：现在扩建/买设备，还是等等 | 花的是同一笔现金，且影响后续所有产能 |
| ③ | **打不打 raid**：打谁、什么时候打、买什么增益 | 偷来的作物会进入同一个背包，挤占卖货与加工额度 |
| ④ | **下一笔事务是什么** | 只提交因果安全前缀，其余等回执 |

**关键设计**：①②③ 不是分别求出再拼起来，而是**全部塞进同一条轨迹**由内层 `optimizeAndSimulateSequence` 联合模拟。`solveUnifiedPlan` 自己只做「候选生成 + 排序 + 决赛验证」。

### 6.2 输入：envelope 被拆成什么

```js
// solve.mjs:7412-7469（简化）
const world0 = cloneWorld(envelope.observed.world); syncClock(world0)
const constraints = envelope.constraints          // 现金/体力保留线、偷菜次数上限、CapEx 回收期
const baseSoldByIsle = {...envelope.observed.knownSoldByIsleIndex, ...options.priorSoldByIsle}
const scenarios = envelope.beliefs.scenarios      // 未来价格场景 + 权重
```

| 输入 | 用途 | 行号 |
|---|---|---|
| `observed.world` | 克隆为 `world0`，之后所有推演都不碰原对象 | 7412-7413 |
| `constraints` | 现金保留线 `cashReserveFloor`、体力保留线、`maxStealsPerIsleDay`、`maxCapexPaybackSec` | 7415 |
| `knownSoldByIsleIndex` | 已知的岛日销量，用于价格冲击（自己卖多了会压价） | 7433 |
| `beliefs.scenarios` | 三档外部供给场景（tight/baseline/glut）及权重 | 7464-7469 |
| `beliefs.visitBeliefs` | 当前可偷目标（t0 立即） | 8650-8675 |
| `beliefs.upcomingVisitBeliefs` | 未来解禁目标（t > t0） | 8650-8693 |
| `reservedBudgets.stealUsedOrReservedThisIsleDay` | 本岛日已用/已预留的偷菜次数 | 8662 |
| `options.rawNeighborTargetsById` | 原始邻居快照，用于按访问者状态重建信念 | 8673, 10586 |

### 6.3 非预期性：哪些决策「现在就要定」，哪些「可以等」

这是整个规划最核心的分解。**价格在时刻 T 才揭晓，那么在 T 之前不能按「已知价格」决策**：

```js
// solve.mjs:7458-7482（简化）
const singleScenario = !scenarios || scenarios.length <= 1
// 按 isleDayOffset >= 1 切开：
//   trunk      = 价格揭晓之前的共享决策（无论哪个场景都做同样的动作）
//   branches[] = 价格揭晓之后，每个场景各自的最优动作
```

| 部分 | 内容 | 求解方式 |
|---|---|---|
| **trunk** | 价格揭晓前的动作（通常是 t0 当天） | 用「期望价格」求一次，得到一套**所有场景都一致**的动作 |
| **branches** | 价格揭晓后的动作，每个场景一套 | 从同一个 `trunkWorld` 出发，各自重解 |

代码流程（7741-7858）：

```
① 用期望价格跑一次完整 optimizeAndSimulateSequence → 得到 trunk 动作
② 重放 trunk 动作到一个克隆世界 → trunkWorld（所有分支的共同起点）
③ for each scenario:
      从 trunkWorld 出发，用该场景的价格重解 → branch 动作 + branch 目标值
④ 总目标值 = Σ p_ω × branch目标值
```

**为什么这么做**：如果直接按「期望价格」算完整条轨迹，规划器会在 t0 就做出「只有在某个价格场景下才合理」的动作（比如提前囤货等高价）。这在真实世界里是不可执行的——t0 时你还不知道价格。**主干-追索（trunk + recourse）是标准的随机规划做法**，参考实现用最朴素的方式实现了它：只切一刀（价格揭晓时刻）。

### 6.4 三种国内基准策略：`optimal` / `hold` / `sell-all`

在引入 raid 之前，先求出「纯国内经营」的最优解，作为**所有 raid 候选的比较基准**。

```js
// solve.mjs:8536-8594（简化）
for (const policy of ['optimal', 'hold-in-first-bucket', 'sell-all-now']) {
  const v = evaluateTrunkPolicy(policy)
  if (v > best.value) best = { policy, value: v }
}
```

| 策略 | 含义 | 什么时候会赢 |
|---|---|---|
| `optimal` | 让内层求解器自由决定卖货时机 | 大多数情况 |
| `hold-in-first-bucket` | 第一桶强制不卖，全部留到后面 | 价格即将上涨、或需要留原料加工 |
| `sell-all-now` | 第一桶全部卖掉换现金 | 现金极度紧张、或价格即将下跌 |

另外还比较了上游变体（8596-8621）：**首桶是否允许 `plant` / `stockBuy`**。有些情况下「第一桶就种地」是错的（比如马上要打 raid，体力不够）。

**这个设计的意义**：`hold` 和 `sell-all-now` 看起来是「退化策略」，但它们提供了**边界解**。如果最优解连这两个都不如，说明求解器的局部搜索出问题了——这是一种廉价的自检。

### 6.5 CapEx：用「反事实轨迹差」决定现在做还是等

CapEx（扩建田地、买陷阱、买动物、升级洒水器/镐/鱼竿/房子）是**不可逆的大额支出**。参考实现不用启发式阈值，而是**真跑两条轨迹做差**：

```js
// solve.mjs:1439-1533 selectCapexByTrajectoryDelta（结构）
const baseline = optimizeAndSimulateSequence(...)          // 不买
for (const capex of enumerateLegalCapexCandidates(...)) { // 枚举合法候选
  const withCapex = optimizeAndSimulateSequence(..., { preselectedCapexActions: [capex] })
  const delta = withCapex.objectiveEval.value - baseline.objectiveEval.value
  const paybackSec = cost / max(1e-9, delta / horizonSec)
  if (paybackSec <= constraints.maxCapexPaybackSec)  keep(capex, delta)
}
```

| 参数 | 默认 | 位置 |
|---|---|---|
| `maxCapexPaybackSec` | 72 小时 | `model/observations.mjs:144` |
| 枚举的 CapEx 类型 | expand plot / buyTrap / buyAnimal / upgrade spr,pick,rod,house | `solve.mjs:1384-1425` |

**为什么用轨迹差而不是「产能×时间×利润率」**：因为 CapEx 会改变**整条轨迹**——多一块地不只是多产一份作物，它会挤占体力、挤占工坊槽位、挤占销售额度。只有重跑完整轨迹才能捕捉这些耦合。代价是慢（每个候选一次完整求解），所以只在 t0 做一次，且结果缓存给扩展视野复用（10006-10020 只在 `extPaybackSec` 相等时复用）。

### 6.6 Raid：三级漏斗

偷菜是「高方差、强耦合」的决策——打不打、打谁、什么时候打，都会影响体力、背包、现金和后续计划。参考实现用**粗筛 → 快速排序 → 完整验证**三级漏斗来压缩搜索空间。

#### 第一级：粗筛（`evalCandidateGross`，8696-8741）

```js
// 对每个目标、每个 buff 组合：
const tr = computeExpectedRaidTransition(adapter, belief, worldAtRaid)
const grossDelta = evaluateMarginalRaidDelta(...)   // 或退化：price×qty − fine − buffCost
if (grossDelta > 1e-6) keep(target)
```

**注意**：这一级**完全不扣体力和食物成本**（注释原话："zero stamina/food cost subtracted"）。它是一个纯粹的「有没有油水」筛选，把明显亏本的目标先干掉。

#### 第二级：快速时间线排序（9027-9197）

对每个 raid 子集（最多 `2^5 − 1 = 31` 个），按时间顺序模拟体力：

```js
// 对每个子集（mask）：
let en = world0.en
const branches = [{ prob: 1, en, invDelta: {}, val: baseVal }]
for (const raid of subsetSortedByTime) {
  en = advanceScalarStamina(en, ...)          // 自然回复
  // 每个已有的概率分支 × 四种结果 → 新分支
  // 用 evalLeafMarginal 算每个分支的边际值（带 memo）
}
fastNetDelta = Σ prob × val
```

**剪枝**：分支数超过 6 时，保留前 5 + 尾部聚合（9157-9173）。这是为了防止组合爆炸——每个 raid 最多 4 种结果，5 个 raid 理论上有 4^5 = 1024 条路径。

#### 第三级：完整验证（9221-9539）

只有排名靠前的 1-2 个决赛者才做**完整联合重解**：

```js
const maxFinalists = (firstPlaceLead > 1500 || remainingMs < 5000) ? 1 : 2
```

| 情况 | 验证方式 | 行号 |
|---|---|---|
| **未来 raid**（unlockAtSec > t0） | 构造含 raid 事件桶的时间线，直接 `evaluateTrunkPolicy` 重解整条轨迹 | 9244-9279 |
| **立即 raid**（t0 就解禁） | 先算 buff + prep，构造「保证掉落 + 最坏罚款」的保守世界，再从这个世界重解后续计划 | 9280-9537 |

立即 raid 的期望值用**精确结果树**（`evalExactExpectationFn`）：对每个离散结果分别重解后续计划，再按概率加权（9433-9481）。组合数超过 16 时退化为 CRN 蒙特卡洛。

**采纳条件**：只有 `policyExpectedValue` **严格高于** `bestDomestic` 才采纳 raid（9541-9620）。否则保留纯国内计划。

#### 候选池的构造（8761-8782）

```js
const K = 5                                    // 候选池大小
pool = 前 2 个 ready（t0 可偷）+ 前 2 个 upcoming（未来解禁）+ 补齐
```

**为什么限制在 5**：31 个子集 × 每子集一次快速时间线模拟，已经是秒级开销。如果放开到 10 个目标，子集数就是 1023，无法在 deadline 内完成。

### 6.7 输出：`planOut` 的每个字段都是给谁用的

```js
// solve.mjs:9841-9940（字段清单）
{
  planId, account, rulesHash, objectiveHash, constraintsHash, constraints,
  serverNow, horizonSec, terminalMethod,
  trunkBuckets: [...],            // 每个事件桶的国内动作 + 访问动作
  raidSchedule: {...},            // 传给 SnipeScheduler 的承诺
  committedUpcomingRaids: [...],  // 未来 raid 的 prep 与前置条件
  scenarioBranches: [...],        // 各价格场景下的分支动作与目标值
  marginalContext: {...},         // 基线快照，供快速评估器复用
  nextWakeSec, waitReason,
  quality: {...}
}
```

| 字段 | 消费方 | 说明 |
|---|---|---|
| `trunkBuckets[]` | `compile-prefix.mjs` | **只有 bucket0 会被编译成可执行前缀** |
| `raidSchedule` | `execution/snipe-scheduler.mjs` | 承诺的 raid 列表，scheduler 按物理提前量触发 |
| `committedUpcomingRaids` | `snipe-scheduler.mjs` | 每个 raid 的 prep 动作、`minCoinsBeforePrep`、`unlockAtSec` |
| `marginalContext` | `createUnifiedRaidEvaluator` | 避免重复求解基线 |
| `nextWakeSec` | `cli/controller.mjs` | 决定下一次唤醒时刻 |
| `quality` | 日志 / GUI / 审计 | 可行解、标准误、置信区间、gap、剪枝统计 |

`trunkBuckets[i]` 的结构（`planner/resources.mjs:232-260` + `solve.mjs:9653-9681`）：

```js
{
  atSec, nextAtSec, durationSec,
  naturalDay, isleIndex, isleDay, isleDayOffset,
  season, weather, isLongNight,
  reasons: ['upcoming-raid-unlock', 'crop-mature', ...],  // 为什么切这个桶
  isTrunkBeforePriceReveal,
  exogenousArrivalsAtStart: [...],   // 外部到货（raid 战利品）
  domesticActions: [...],            // 普通动作对象
  visitActions: [...],               // 访问动作
  visitFirst: false,                 // 先访问还是先做国内动作
  plannedPostBucketEnFloor,          // 本桶结束后体力下界
  plannedAtEnT,                      // 体力回复时间戳
}
```

**注意动作对象是「无时间戳」的**：`{a:'plant', i:0, id:'sd_wheat'}`。时间戳在 bucket 级（`atSec`/`nextAtSec`）。这是因为同一个桶内所有动作都视为「同一时刻可发」——真正的执行时刻由 HTTP 层的限流决定。

### 6.8 早退与降级：每一种失败都有名字

| 情况 | 行为 | 位置 |
|---|---|---|
| 到达 deadline | 各层检查 `isPastDeadline()`，停止尝试新候选，标记 `raidEvalTruncatedByDeadline`；不抛异常（除非 `abortHardOnDeadline`） | 7394-7406, 8653-8655, 9201-9204, 9228-9233 |
| raid 凑不够体力 | 内层返回 `raidScheduleInfeasible: true`，候选丢弃 | 4044-4056, 7656-7671 |
| 继续计划带未来 raid 不可行 | 去掉剩余 raid 重试 | 7979-7989, 8465-8471 |
| 没有 raid 候选 / 无正毛利 | 保留纯国内计划 | 8743-8774, 8831 |
| `marginalContext` 缺失 | 退化为 `price × qty` 粗估，按 `grossSum` 取前 3 个子集 | 8728-8737, 8840-8845 |
| 精确期望不可行 | 退化为 CRN 蒙特卡洛（默认 M=4 或 8），标记 `deadline-truncated-monte-carlo-expectation` | 8379-8497 |
| 首桶含随机动作 | 只提交因果前缀，回执后重规划 | 8260-8271 |
| 无事件桶 | 只做期末估值，返回单点轨迹 | 7597-7632 |
| 上界无效 | 返回 `null`，不伪造 gap | `bounds.mjs:26-53` |

**设计哲学**：**失败必须可解释**。`quality.valueInterpretation` 会明确写出这组数字是怎么来的：

```
'deterministic'                        — 完全没有随机性，数字就是真值
'scenario-weighted'                    — 多场景加权
'exact-discrete-expectation'           — 精确离散期望
'monte-carlo'                          — 蒙特卡洛估计（带标准误）
'deadline-truncated-single-stream'     — 超时截断，只有一条轨迹
'deadline-truncated-monte-carlo-expectation'
```

调用方看到 `monte-carlo` 就知道要打折扣，看到 `single-stream` 就知道这不是期望值。

### 6.9 视野稳定性：`solveWithHorizonStability`

滚动视野规划有一个经典病态：**把视野从 H 延长到 H+ΔH，近期最优动作翻转**，导致执行器每轮都在改主意。

```js
// solve.mjs:9948-10070（结构）
const baseH = objectiveCfg.horizonSec              // 默认 24h
const extH  = baseH + (objectiveCfg.extendedHorizonDeltaSec || 28800)  // +8h
```

**机制**：

1. **收紧墙钟 deadline**（9963-9975）：取 `nextIsleBoundary(t0)` 和 `nextNaturalDayBoundary(t0)` 的较小者，deadline 压到它前 1.5 秒。**防止求解跨过 bucket 时间戳导致计划失效。**
2. 跑基础视野 → 立即通过 `onBasePlanReady` 交付（9987-9991），保证即使扩展失败也有可执行计划。
3. 预算检查（9993-10004）：`minExtBudgetMs = max(50, basePlan.elapsedMs × max(1.2, extScale))`。不够就跳过扩展。
4. 跑扩展视野，`preservePrefixThroughSec = t0 + baseH`（10018-10019）——这让 `buildEventBuckets` 在基础视野内挑选**完全相同**的桶，两个计划才可比。
5. **比较「可执行前缀的签名」**（10044-10057）：

```js
buildExecutablePlanSignature(adapter, worldObs, plan, { waitHorizonCapSec: t0 + baseH })
// 签名包含：下一笔事务类型（act/visit/wait）、domestic 批次动作、
//           visit 目标 ID、截断后的 nextWakeSec、承诺的 raid 目标@解禁时刻
const prefixStable = sig0 === sig1
```

6. 调用方采用策略（`cli/controller.mjs:711-726`、`execution/planner-worker.mjs:67-91`）：

```js
const adoptExtended = !stab.skippedByDeadline && stab.prefixStable === false && stab.extendedPlan
plan = adoptExtended ? stab.extendedPlan : stab.basePlan
```

**它不是什么**：不是动作粘性（没有把上一轮计划作为约束强行保留），也不是置信度阈值（没有用区间决定切换）。它只做一件事：**验证「立即要发的那一笔」在视野延长后是否不变**；变了就用更稳健的长视野计划。

| 参数 | 默认 | 位置 |
|---|---|---|
| `extendedHorizonDeltaSec` | 28800s（8h） | `model/objective.mjs:9-11` |
| 扩展 `maxBuckets` | `max(base+4, ceil(base×extScale))` | solve.mjs:10010 |
| 最小扩展预算 | `max(50ms, baseElapsed × max(1.2, extScale))` | solve.mjs:9995 |
| deadline 收紧 | 边界前 1500ms，至少 250ms | solve.mjs:9967-9975 |

### 6.10 这一章的方法论总结

| 问题 | 参考实现的答案 |
|---|---|
| 随机性怎么处理 | 主干-追索：价格揭晓前共享决策，之后按场景分支 |
| 组合爆炸怎么处理 | 三级漏斗：免费粗筛 → 快速排序 → 只验证决赛者 |
| 高方差决策怎么评估 | 精确离散树优先，组合超限退 CRN 蒙特卡洛 |
| 不可逆支出怎么定 | 真跑两条轨迹做差，算回收期 |
| 视野太短/太长 | 两个视野各算一次，比较可执行前缀签名 |
| 超时怎么办 | 每一层都能降级，且降级后的数字带明确标签 |

---

## 7. 序列优化 `optimizeAndSimulateSequence`

> 文件：`planner/solve.mjs:1539-6977`（约 5,440 行）。这是**整个项目最复杂的一段代码**，也是唯一真正「在一条时间线上联合优化所有事」的地方。`solveUnifiedPlan` 调用它几十次，每次都是在问「如果这么做，整条轨迹值多少」。

### 7.1 它要解决什么

给定：
- 一个起始世界 `startWorld`
- 一串事件桶 `seqBuckets`（已按时间排好，见第 4 章）
- 一个价格函数 `pricesForBucketFn(bucket, soldSoFar)`（能算出每个桶每个物品的报价）
- 已承诺的未来 raid `scheduledUpcomingRaids`
- 一堆规则与约束

求：**每个桶做哪些动作**，使得整条轨迹的目标值（第 3 章）最大。

**为什么不能贪心**：
- 体力是通的：今天多浇一次水，明天就少挖一次矿
- 工坊槽位是跨桶的：现在加工低级货，就占了晚上加工高级货的位置
- 销售额度是跨桶的：今天卖 300 个，今天的价就垮了，明天的量要重新算
- 现金是跨桶的：现在买种子，晚上就没钱买炸药

所以它被拆成 **四个 Step**，每个 Step 解决一类耦合：

| Step | 解决的问题 | 算法 | 行数 |
|---|---|---|---|
| **A** | 每个物品、每个品质、每个时刻值多少钱 | 直接卖 vs 加工反推，取大 | 1675-2034 |
| **B** | 前面做了农活/采购之后，每个桶到底有多少原料 | 确定性预扫描（真跑一遍） | 2035-3978 |
| **C** | 跨桶的加工与卖货怎么排 | 联合 LP/贪心 + 工坊槽位影子价 | 3979-4011 → `solveJointCraftAndSell` |
| **D** | 每个桶的体力怎么分 | 精确整数背包 + Bellman 分配 | 4012-6977 |

### 7.2 Step A：一个物品值多少钱

`marginalItemValueFn(id, q, atSec)`（1958-2033）返回「**再多一个单位**这个品质的物品，能多赚多少现金」。它不是市价，是**两条路里更好的那条**：

```js
// 路径 1：直接卖 —— 在最好的未来槽位卖
// 路径 2：作为配方原料 —— 反推它能贡献多少
marginal = max(
  findBestDirectSaleChoice(id, q, atSec),      // 1931-1954
  bestRecipeImpliedValue(id, q, atSec)         // 1969-2008
)
```

**路径 1：直接卖**（1931-1954）

```js
// 对每个允许卖出的未来槽位 sl：
val = Math.round(price_sl[id] * QUALITY[q])
    * cropTierMult(projected sc at sl)   // 作物阶梯：1.0 / 0.85 / 0.70
    * sl.disc                            // 折现
    * sl.netTaxFactor                    // 近似税后
取最大值
```

**路径 2：加工反推**（1969-2008）

```js
// 对每个消费 id 的可售配方 rec：
otherCost = Σ_{o != id} qty_o × 该原料的直接卖价
implied   = (bestSaleValue(rec.out) - otherCost) / needThis
// 但工坊槽位是稀缺的，所以还要按「一条配方要几个槽位」摊薄：
slotReserve = reserveUnits / needThis      // ← 分数，绝不 Math.ceil
```

**为什么用分数预留槽位**：一条配方需要 2 个单位的原料，那么「多 1 个单位」只占了半条配方的槽位。如果用 `Math.ceil`，1 个原料就会被算成占了整条配方，价值被凭空放大一倍。

**这个函数是整个求解器的计价基础**——Step D 里每一个候选动作的「收益」都是用它算的。

### 7.3 Step B：为什么必须先「假装做一遍」

Step C 需要知道「每个桶有多少原料」。但原料数量取决于：
- 前面收获了什么（农活）
- 货船买了什么（`stockBuy`）
- 畜栏收集了什么

**这些本身是决策变量**。所以参考实现的做法是：**先按确定性规则假装做一遍**，把供给量算出来。

```js
// solve.mjs:2036-2045（关键变量）
let probeWorld = cloneWorld(startWorld)
const supplyByBucket = seqBuckets.map(() => ({}))   // 每个桶每种物品的可用量
const enAfterPreByU = new Float64Array(L)           // 每个桶预扫描后的体力
const craftCapByIsle = new Map()                    // 每个岛日的工坊产能
const estUrgentFarmEnByU = new Float64Array(L)      // 每个桶的紧急农活耗体
```

**「紧急农活」的定义**（4816-4881）：不是所有农活都紧急。只有这些进 `urgentTasks`：

| 任务 | 为什么紧急 |
|---|---|
| `harvest`（成熟） | 不立刻收，保护期过了会被别人偷 |
| `clear`（枯萎） | 不清地就种不了下一茬 |
| `plant`（空地） | 早种一分钟就早熟一分钟 |
| `feed`（饥饿的动物） | 断粮会掉心情、停产 |
| `water`（即将缺水的作物） | 缺水会停长 |

**每块地的优先级不是固定的**，而是算出来的边际价值：

```js
// solve.mjs:4860
rPlot = bestNextP ? bestNextP.netRatePerSec : fallbackRate
```

`netRatePerSec` 来自 `selectBestCropToPlant`（1274-1378）：

```js
net = totalExpectedRevenue - seedCashCost - totalStaminaSpent * staminaPointCost
rawRatePerSec = net / occupiedSec
```

**单位时间净收益率**——这是「这块地值不值得优先服务」的唯一标准。注意它已经把**体力的机会成本**扣掉了（`staminaPointCost` = `baseStaminaShadowCost`）。

**`baseStaminaShadowCost`：内生的体力影子价**（2076-2129）

```js
if (初始体力 + 自然回复 >= 所有可平移需求) return termCredit   // 体力不稀缺 → 0
// 否则：
shadow = max(termCredit, min(最便宜补剂的 cpe, 最佳挖矿/钓鱼每点体力产出))
```

- 「可平移需求」= 加工 + 炸弹 + 钓鱼 + 挖矿的**剩余配额**消耗的体力
- 如果自然回复就够，体力不要钱
- 如果不够，体力至少值「最便宜的补法」或「最好的挖矿产出」中的较小者

**这是「零魔法常数」的体现**：体力影子价不是调出来的，是从当前局面算出来的。

### 7.4 Step C：跨桶联合加工 + 卖货

```js
// solve.mjs:3998-4010
const jointCS = solveJointCraftAndSell(adapter, {
  initialSupplyByBucket,      // Step B 的供给
  buckets,                    // 所有桶 + 期末延续桶
  slots,                      // 所有可卖槽位（含期末）
  craftCapByIsle,             // 每岛日工坊产能
  enCapByBucket,              // 每桶体力上限
  staminaShadowCost: 0,       // ← 注意这里是 0
  maxCraftHoldIsleDays: 3,
})
```

**`staminaShadowCost: 0` 是个刻意的选择**：这一步只回答「假设体力无限，加工什么最赚」，体力的真实稀缺性留给 Step D 去处理。这避免了「Step C 用一个体力的估计价，Step D 又用真实价」的双重计价。

**输出**（`solveJointCraftAndSell` 的返回，850-1244）：

| 字段 | 含义 |
|---|---|
| `craftsByBucket[]` | 每个桶加工什么、几个 |
| `executionOrderMoves[]` | 加工的执行顺序（用于后续增量重解） |
| `salePortfolio` | 卖货组合：哪些物品、何时、多少 |
| `supplyAfterCrafts` | 加工后的剩余供给 |
| `netPortfolioScore` | 这组方案的净分 |

**注意 `executionOrderMoves`**：它记录了「加工的先后顺序」。第 6 章的 `evaluateMarginalRaidDelta` 在评估 raid 时会复用这个顺序做增量重解（10314-10454 的 unroll 逻辑）——如果 raid 的战利品能替代某些原料，就从顺序末尾释放槽位。

### 7.5 Step D：统一体力背包 + Bellman 分配

这是整个文件最核心的一段。注释写得很直白：

```js
// solve.mjs:4012-4014
// Step D: Unified Integer Bounded Knapsack Stamina Competition
//         + Exact Marginal Stamina Top-Up (`eat` / `coffee`)!
// Every stamina-consuming unit (`craft`, `bomb`, `fish`, `mine`) competes
// simultaneously in a single 1D DP with ZERO hardcoded action priority order!
```

**「零硬编码优先级」是什么意思**：没有「先加工、再钓鱼、最后挖矿」这样的顺序。所有耗体力的动作单元被丢进同一个背包，DP 自动选出最优组合。

#### 7.5.1 动作单元：`solveBucketStaminaKnapsack`（4496-4792）

```js
const solveBucketStaminaKnapsack = (stWorld, maxEnLimit, craftBundlesOverride = null,
                                    { fullIsleQuotas = false, fishEvOverride = null } = {})
```

它把当前局面下所有**可做的、耗体力的单次动作**枚举成 item：

| 来源 | 单元 | 体力 | 收益 `gain` | 现金成本 |
|---|---|---|---|---|
| A) 加工 | `craft-bundle`（一条完整配方） | `craftSteps.length × cost.craft` | 成品价值 − 原料机会成本 | 0 |
| B) 炸弹（背包） | `bomb-inv` | `cost.bomb`（6） | 期望矿石掉落价值 | 0 |
| B) 炸弹（买） | `bomb-buy` | 6 | 掉落价值 − 商店价×折现 | 商店价 |
| C) 钓鱼（自带饵） | `fish-inv-bait` | `cost.fish`（4） | 带饵期望鱼价值 | 0 |
| C) 钓鱼（买饵） | `fish-buy-bait` | 4 | 带饵价值 − 饵价×折现 | 饵价 |
| C) 钓鱼（无饵） | `fish-no-bait` | 4 | 无饵期望鱼价值 | 0 |
| D) 挖矿 | `mine` | `cost.mine`（3） | 期望矿石掉落价值 | 0 |

**三个细节决定了这个枚举的正确性**：

1. **钓鱼的「更好时段」判断**（4563-4566）：

```js
const hasBetterWindowLaterSameIsle =
  !fullIsleQuotas &&
  seqBuckets.slice(u + 1).some(fb => fb.isleIndex === b.isleIndex) &&
  rawValBait + 1e-6 < bestFishEvInIsle &&
  s.en < enCap
```

如果同一个岛日的**后面还有黄金时段**（鱼价更高），而且**现在体力没满**，那么现在不钓——等后面钓更值。这是唯一一处「故意不做」的逻辑，而且它的条件是纯经济的（`当前价值 < 未来最佳价值`，且「等待不需要成本」= 体力没溢出风险）。

2. **炸弹买不买**（4531-4537）：

```js
const netGain = dropVal - shopBombPrice * bucketDisc
if (netGain > 1e-6 && maxAfford > 0) { ... }
```

只有**净赚**才买。而且 `maxAfford` 同时受三个约束：剩余配额、可用现金、动作位。

3. **加工单元是「一条完整配方」而不是「单个合成步」**：`craft-bundle` 包含 `craftSteps[]`（可能是一条两步链），体力成本是所有步之和。

#### 7.5.2 有界背包 → 0-1 二进制捆绑（4625-4664）

n 个相同的单元，朴素做法是当成 n 个 0-1 物品，O(n·E)。参考实现用**二进制分解**：

```js
// 1, 2, 4, 8, ... 把 n 个打包成 log(n) 个 0-1 物品
while (rem > 0) {
  const takeN = Math.min(bPow, rem)
  dpItems.push({ baseItem: base, bundleCount: takeN, costEn: base.costEn * takeN, gain: base.gain * takeN })
  rem -= takeN; bPow *= 2
}
```

**为什么先排零成本物品**（4626-4632）：

```js
const orderedRaw = [...freeRaw, ...paidRaw]
```

因为二进制分解要求「相同物品连续」，把免费的放前面能减少分组数，且保证在二维 DP 里免费物品优先被选中（两者收益相同时）。

#### 7.5.3 二维 DP：当现金也不够时（4666-4747）

```js
if (totalPaidCash > freeCash + 1e-9 && E > 0) {
  // 现金维度按 GCD 压缩，超过 500 格就降精度
  const cashUnit = Math.floor(freeCash / rawGcd) > 500
    ? Math.max(1, Math.ceil(freeCash / 500))
    : rawGcd
  const C = Math.floor(freeCash / cashUnit)
  const dp2 = new Float64Array((E + 1) * (C + 1))
  ...
}
```

**为什么需要二维**：`bomb-buy` 和 `fish-buy-bait` 两个池子竞争同一笔现金。一维 DP 只知道「花钱总数」，回溯时可能选出超出现金的组合。二维 DP 把现金也当成容量，保证回溯出的方案**绝不会超支**。

**代价**：`(E+1)×(C+1)` 的内存和时间。所以：

- 现金维度按 GCD 压缩（如果所有价格都是 100 的倍数，格数就是现金/100）
- 如果还是超过 500 格，就**降精度**（`cashUnit = ceil(freeCash/500)`），保证最多 500×E 格
- `recordCashGrid` 记录网格大小，供性能监控

**这是「精确 vs 可算」的显式权衡**：二维 DP 是精确的，但只在小规模时启用；大规模时降精度，误差上界是 `cashUnit` 分之一。

#### 7.5.4 返回的不是「方案」，是「价值曲线」（4749-4791）

```js
return { items, E, bestAtMost, reconstructAt }
```

- `bestAtMost[e]`：**给定 e 点体力，最多能赚多少**。这是核心输出。
- `reconstructAt(availEn)`：给具体体力，回溯出动作列表。

**为什么要返回整条曲线而不是一个方案**：因为 Step D 后面还要问「**多给 1 点体力值多少**」。有曲线就能直接读边际值 `bestAtMost[e+1] - bestAtMost[e]`。这正是 Bellman 分配需要的。

#### 7.5.5 Bellman 分配：强制缺口 vs 可选工作（4794-5766）

注释写得很清楚：

```js
// 2. Unified Whole-Isle Bellman Stamina Allocation & Multi-Batch Turnover (`eat` / `coffee`):
//    Jointly prices Bucket-`u` urgent farm/barn queuing loss (`V_farmCurve`),
//    Bucket-`u` shiftable work, and remaining same-isle passive regen
//    + post-midnight coffee across `[u, isleEnd]` with 0 heuristic gates!
```

它要分配的是**这个桶的体力**，在三个用途之间：

```
          ┌─ 紧急农活（不做会烂在地里/动物饿死）
当前体力 ─┼─ 可平移工作（加工/钓鱼/挖矿/炸弹）
          └─ 存起来（自然回复溢出会浪费，存到下个岛日有价值）
```

**第一步：算强制缺口**（5677-5706）

```js
const netRegenBalance = carryEn + futureSameIsleRegenEn + deferredSameIsleAddedEnVal - sameIsleRaidEn
const effFutureMandatoryEn = totalFutureSameIsleMandatoryEn + deferredUrgentEn
const mandatoryDeficit = max(causalDeficit, endDeficit)   // 两个口径取大
```

- `causalDeficit`：**过程中**最缺的时候缺多少（前缀最小值法）
- `endDeficit`：**期末**总账差多少
- 取大者，因为两个时点都可能卡住

**第二步：强制缺口必须用最便宜的补剂填满**（5682-5706）

```js
while (remMand > 0 && chunkIdx < chunks.length) {
  const take = Math.min(remMand, chunkRemEn)
  mandatoryRationCost += take * chunks[chunkIdx].cpe
  ...
}
if (remMand > 0) mandatoryRationCost += remMand * 450   // ← 实在补不上，按 450/点罚
```

`chunks` 是按 `cpe`（每点体力成本）排序的补剂池：饭团（0）→ 便宜作物 → 咖啡（250）。

**450 是「补不上」的惩罚价**：比咖啡的 250 高，比「完全不做事」的损失低。它保证了「宁可买咖啡也不让强制缺口存在」。

**第三步：剩余体力怎么用**（5709-5760）

```js
const surplusForKsIsle = max(0, netRegenBalance + fundedMand - effFutureMandatoryEn)
const baseCov = eLocalVal + surplusForKsIsle
```

然后对每个咖啡数量 `kC`，算「覆盖到多少体力 `cov` 时总价值最大」：

```js
candW = ksIsle.bestAtMost[min(ksIsle.E, cov)]     // 全部可做工作的价值
      - kC * coffeePrice * postMidDisc             // 咖啡成本
      - mandatoryRationCost                        // 强制补剂成本
      - rationWorkCost                             // 为做工作而额外补剂的成本
      + carryNext * nextIsleCarryValuePerEn        // 溢出到下岛日的体力价值
```

**`rationWorkCost` 的内层循环是关键**（5723-5749）：

```js
for (let dE = 1; dE <= maxStep; dE++) {
  const netGain = (ksIsle.bestAtMost[cov + dE] - ksIsle.bestAtMost[cov]) - dE * cpe
  if (netGain > bestNet) { bestNet = netGain; bestDe = dE }
}
```

**「多补 dE 点体力，能多做多少工作，扣掉补剂成本，净赚多少」**。只有净赚 > 0 才继续补。这是逐点边际分析，不是「补满为止」。

**第四步：raid 的体力预留**（5768-5829）

```js
const maxSpendS = min(
  max(0, curEnVal - max(bucketEnFloor, raidSched.minFeasiblePostEn)),
  urgentFarmEn + ksLocal.E
)
for (let S = 0; S <= maxSpendS; S++) { ... }
```

`raidSched.minFeasiblePostEn` 是「未来 raid 最少需要多少体力」。当前桶最多只能花到「留够这个数」为止。**这就是未来 raid 与当前农活的联合权衡**——不是先保证 raid 再排农活，而是 raid 的体力需求作为一个下界约束进入当前桶的分配。

#### 7.5.6 未来 raid 的体力调度：`buildFutureRaidStaminaSchedule`（5422-5567）

对「本桶结束后的体力 `postE`」逐点计算：如果留 `postE` 点体力到下个桶，未来所有已承诺 raid 的最便宜补给方案是什么。

返回（据调用方 5960-6218 的使用）：

| 字段 | 含义 |
|---|---|
| `minFeasiblePostEn` | 至少要留多少体力，未来 raid 才打得动 |
| `deferredPrepCost` | 未来补剂的总成本 |
| `deferredEatReserve` | 需要预留的食物数量 |
| `deferredCashReserve` | 需要预留的现金 |
| `terminalRaidEn` | 所有 raid 打完后的剩余体力 |

**这解决了「现在多花 1 点体力，未来 raid 就要多买一份咖啡」的定价问题**。当前桶的分配在「农活价值 + 后续价值 − `deferredPrepCost`」之间取最大。

#### 7.5.7 执行：`pushAndSim`（4072-4117）

算出来的动作不能直接发，必须模拟验证：

```js
const pushAndSim = (candActs) => {
  const room = maxBucketActions - bucketActs.length
  const sliced = candActs.slice(0, room)

  // 按 (isStochastic ? act.a : 'det') 分组，每组 ≤40
  while (cursor < sliced.length) {
    const firstKey = adapter.isStochasticAction(firstAct) ? firstAct.a : 'det'
    // ... 收集同 key 的连续动作
    const sv = simulateValidBatch(adapter, execWorld, chunk, {
      t: b.atSec, prices: dynamicPrices,
      rand: getExecPrngForKind(firstKey),      // ← 每种随机动作一个独立 CRN 子流
    })
    if (valid.length === 0 || !sv.sim) continue
    execWorld = sv.afterWorld
    // 记录现金变化、卖出量
  }
}
```

**`getExecPrngForKind(firstKey)` 是整段代码最精妙的设计之一**（1630）：

```js
// 每种随机动作类型一个独立的确定性 PRNG 流
// 'det' / 'fish' / 'mine' / 'harvest' / 'bomb' ...
```

**为什么必须分流的**：假设你用同一个 PRNG 流，那么「多加一次钓鱼」就会改变后面所有挖矿的随机结果。这意味着——**你无法比较「钓 5 次」和「钓 6 次」哪个好**，因为差异被随机性淹没了。分流之后，「钓 6 次」只是多了一次钓鱼抽样，挖矿的结果完全不变。这就是**公共随机数（CRN）**的标准做法。

**`maxBucketActions` 的上限**（4069-4070）：

```js
const maxBatchesInBucket = 1 + Math.floor((bucketEndSec - b.atSec) / minGap)  // 2 秒一批
const maxBucketActions = Math.min(400, maxBatchesInBucket * 40)
```

一个桶里最多能发多少动作 = 桶的时长能容纳多少批 × 每批 40 个，硬上限 400。

### 7.6 `simulateValidBatch`：批次模拟与失败回退（6979-7064）

```js
function simulateValidBatch(adapter, world, candidateActions, { t, prices, rand = null })
```

**为什么不能直接 `adapter.simulateBatch`**：因为模拟可能部分失败（某个动作因为状态变化变得非法）。这时需要：

1. **整批快模拟** → 若 `allOk`，全部接受
2. **过滤出快模拟接受的动作** → 用**同样的随机样本序列**重新模拟这批（`replayRand` 回放 `drawn`）
3. **若还失败** → 逐动作顺序模拟，失败的跳过

```js
// solve.mjs:7003-7035（简化）
const drawn = []
const wrappedRand = () => { const v = rand(); drawn.push(v); return v }
const fastSim = adapter.simulateBatch(world, candidateActions, { t, prices, rand: wrappedRand })
if (fastSim.allOk) return { validActions: candidateActions, ... }

const accepted = candidateActions.filter((_, i) => fastSim.result.out[i].ok)
let replayCursor = 0
const replayRand = () => drawn[replayCursor++]     // ← 回放同一批抽样
const sim = adapter.simulateBatch(world, accepted, { t, prices, rand: replayRand })
```

**用同一随机序列重放的目的是避免乐观偏差**：如果失败后重新抽签，那么「被拒绝的动作」会用掉一些「坏运气」，剩下的动作就更容易成功——模拟结果会系统性偏乐观。回放保证了「同一批动作，不管怎么重试，随机结果都一样」。

**已知缺陷**：过滤后动作与随机数的对应关系可能错位（因为快模拟按**原始顺序**消耗随机数，重放按**接受子序列**消耗）。逐动作回退时 `replayCursor` 又被重置。这让「同一随机流」的假设在部分失败时不严格成立——这是第 7 章唯一的已知正确性妥协。

### 7.7 `marginalContext`：冻结的基线（6938-6962）

`optimizeAndSimulateSequence` 返回前，把整条轨迹的「快照」打包：

```js
marginalContext = {
  sourceWorldRev, sourceFarmDigest, sourceIsleIndex, sourceWorldDay,
  sourceCoins, sourceEnergy,
  seqBuckets, slots, supplyByBucket, jointCS,
  craftCapByIsle, enAfterPreByU,
  initialNatDay, initialCnt, allowCraft, maxCraftHoldIsleDays,
  u0MarginalStaminaMeta,     // ← isle0 的体力价值曲线与补剂池
  baseWorldEn0, t0, tH,
  objectiveCfg, scenarioSupplyFactor, recipeInputSet,
}
```

**它存在的唯一目的：避免重复求解**。

第 6 章里，raid 候选的快速评估需要知道「多一批战利品，整条计划值多少」。如果没有 `marginalContext`，每个候选都要重跑一次 5,440 行的序列优化——31 个子集就是 31 次，绝对跑不完。

有了它，`evaluateMarginalRaidDelta` 可以在**基线附近**做局部重解（第 6 章 6.6 的快速排序）。代价是精度：它假设「基线的加工顺序和卖货槽位结构在扰动后仍近似最优」。

**失效检查**（`createUnifiedRaidEvaluator`，10821-10832）：

```js
if (precomputedMarginalContext) {
  if (ctx.sourceFarmDigest !== currentFarmDigest ||
      ctx.sourceWorldRev !== currentRev ||
      ctx.sourceIsleIndex !== currentIsleIndex ||
      ctx.sourceWorldDay !== currentWorldDay) {
    precomputedMarginalContext = null    // 世界变了，快照作废
  }
}
```

**`sourceFarmDigest` 而不是 `rev`**：`rev` 会因为修仙、玩具摊等无关操作变化，`farmDigest` 只哈希农场相关字段（`observations.mjs:160-214`）。用 digest 可以让缓存活得更久。

### 7.8 这一章的方法论总结

| 问题 | 参考实现的答案 |
|---|---|
| 一个物品值多少钱 | 直接卖 vs 加工反推，取大；工坊槽位按分数摊薄 |
| 体力怎么分 | 精确整数背包算出「体力→价值」曲线，再用 Bellman 逐点分配 |
| 多种活动怎么排序 | **不排序**——全部塞进同一个背包，DP 自动选 |
| 现金不够怎么办 | 二维 DP（体力×现金），现金维度 GCD 压缩 + 上限 500 格 |
| 随机性怎么处理 | 每种随机动作一个独立 CRN 子流，动作之间互不干扰 |
| 部分动作失败怎么办 | 整批 → 过滤重放 → 逐动作回退，三级降级 |
| 重复评估太慢怎么办 | 冻结 `marginalContext`，在基线附近做增量重解 |

## 8. 前缀编译：从计划到「这一刻能发的包」

> 文件：`planner/compile-prefix.mjs`（586 行）。这是**规划与执行之间的转换器**，也是全项目最精细的一块工程。

### 8.1 它解决的问题

规划器一次算出未来 6 个岛日的动作序列。但**你一次只能发一个 HTTP 包**，而且：

1. 服务端一个包最多 40 个动作
2. 有些动作的产出是随机的（收获可能掉种子，钓鱼可能空军）
3. 后面依赖随机产出的动作，不能在产出揭晓前提交
4. 规划算了几秒钟，这期间世界可能变了（作物熟了、体力回了、岛日翻了）
5. 变了的计划不能盲发，否则会「执行一个已经过时的决策」

### 8.2 随机性的两种形态

```js
// compile-prefix.mjs:42-98
for (let i = 0; i < capped.length; i++) {
  const act = capped[i]
  const isStoch = adapter.isStochasticAction(act)

  if (!containsStochasticAction) {
    if (isStoch) {
      containsStochasticAction = true
      if (act.a === 'harvest') {
        seenCollectionStoch = true
        taintedItems.add(cropId); taintedItems.add(`sd_${cropId}`)   // ← 污染：这个作物和它的种子不可信了
      } else if (act.a === 'trap') {
        seenCollectionStoch = true
        for (const f of R.FISH) taintedItems.add(f.id)               // ← 所有鱼都被污染
      } else {
        // fish/mine/bomb/npc/scratch：单次体力抽取，包含它之后立即截断
        endIdx = i + 1
        break
      }
    }
    continue
  }

  // 已经进入"收集型随机"批次后：
  // 不依赖被污染物品的独立动作可以继续打包
  if (INDEPENDENT_POST_COLLECTION_ACTIONS.has(act.a)) { ...继续污染... continue }

  // 依赖被污染物品的动作 → 必须等回执
  if (act.a === 'sell' || act.a === 'eat') { if (taintedItems.has(act.id)) { endIdx = i; break } }
  if (act.a === 'craft') { if (recipeTouchesTainted(act.id)) { endIdx = i; break } }
}
```

**两种随机动作的区别**：

| 类型 | 动作 | 处理 | 理由 |
|---|---|---|---|
| **收集型随机** | `harvest`、`trap` | 可以把后续**不依赖产出**的独立动作一起打包（收获另一块地、浇水、喂食…） | 这些动作之间互不影响，一起发更省往返 |
| **单次体力抽取** | `fish`、`mine`、`bomb`、`npc`、`scratch` | 包含它之后**立即截断** | 这些动作消耗体力多、结果影响后续体力预算，必须先看回执 |

**`taintedItems`（污染集）的传播**：
- 收获作物 X → X 和 `sd_X`（X 的种子）不可信（可能掉种子）
- 陷阱 → 所有鱼不可信
- **配方递归污染**：如果某个配方用到被污染的原料，这个配方也被污染（`recipeTouchesTainted` 递归检查）

**尾部清理**：

```js
// compile-prefix.mjs:100-109
if (truncatedAfterStochastic) {
  // 被截断后，末尾的 eat/coffee 要弹掉——它们是为后续动作准备的，不该提前吃
  while (prefix.length > 0 && (prefix.at(-1).a === 'eat' || prefix.at(-1).a === 'coffee'))
    prefix.pop()
}
```

### 8.3 最早物理转变时刻：`computeEarliestDomesticTransitionSec`

```js
// compile-prefix.mjs:140-206
export function computeEarliestDomesticTransitionSec(adapter, world, plannedWakeSec = null) {
  let earliest = Infinity
  consider(nextIsleBoundary(atSec, cs))
  consider(nextNaturalDayBoundary(atSec))
  consider(plannedWakeSec)

  for (每个地块) {
    const st = R.cropStage(p, atSec, auto)
    if (st.stage >= 0 && st.stage < 3) {
      const timing = adapter.exactPlotTimings(p, isSpr, atSec, cs)
      consider(timing.matureAt)                          // 成熟时刻
      if (!auto && p.w <= st.stage)
        consider(p.t + ceil(st.total * (st.stage+1) / 3)) // 浇水阶段结束（可以再浇一次）
    }
  }
  for (每个畜栏) {
    consider(age.retireAt)          // 动物退休
    consider(bt.nextOwnUnitAt)      // 下一个产出
    consider(pen.f + 8*3600)        // 8 小时喂养冷却
    consider(pen.f + 86400)         // 24 小时产出累计上限
  }
  for (每个陷阱) consider(atSec + ceil(tr.left))         // 陷阱就绪
  for (每个 buff) consider(exp)                          // buff 到期
  return earliest
}
```

**一个容易忽略的点**（代码注释里专门写明）：

> 已经成熟地块的 `unlockAt`（偷菜保护期结束）**故意不算**作要中断执行的转变。因为自己收获的合法性、成本、产量都不受 `unlockAt` 影响，跨过它不该中断正在进行的收获。

这就是「转变」的精确定义：**只算会改变当前动作合法性/收益的事件**。

### 8.4 时钟漂移的三级处理

规划算出 `bucket0.atSec`，但实际执行时 `world.now` 已经往前走了。漂移的处理分三级：

```js
// compile-prefix.mjs:327-358
const clockDrift = nowW - at0

// ① 漂移为负 或 超过 maxClockDriftSec → 计划直接报废
if (clockDrift < 0 || clockDrift > maxClockDriftSec)
  return { status: 'plan-invalid', failedReason: `bucket0-timestamp-mismatch:...` }

// ② 漂移期间跨了岛日或自然日边界 → 计划报废（世界规则变了）
if (clockDrift > 0 && (isleIndex(at0) !== isleIndex(nowW) || worldDay(at0) !== worldDay(nowW)))
  return { status: 'plan-invalid', failedReason: `bucket0-boundary-crossed:...` }
```

③ 漂移期间发生了物理转变 → **抢救式降级**（8.5）

### 8.5 抢救：只保留「无后悔」的紧急动作

```js
// compile-prefix.mjs:452-478
} else if (nowW >= earliestTransition) {
  // 世界变了，但还没跨天：只保留"无后悔"的紧急收集/护理动作
  const salvaged = extractTransitionSafeUrgentPrefix(adapter, worldBefore, prefix, plan)
  if (salvaged.length === 0) return { status: 'plan-invalid', ... }
  prefix = salvaged
  effectiveRawVisits = []      // 访问操作全部取消（要重新优化）
  truncatedByTransition = true
}
```

`extractTransitionSafeUrgentPrefix`（`compile-prefix.mjs:219-308`）的算法：

```js
const URGENT_TRANSITION_SAFE_ACTIONS = new Set([
  'harvest','collect','trap','clear','water','feed','pet','goal'   // ← 都是"不做就浪费"的
])

// ① 算出有效体力下限 = max(用户预留, 计划为偷菜预留的)
let effectiveFloor = Math.max(userReserveFloor, adjustedPlannedFloor)

// ② 逐个尝试保留紧急动作
for (const act of candidateUrgent) {
  const directStep = simulateBatch(simWorld, [act], {...})
  if (directOk && afterEn >= effectiveFloor) {
    salvagedBatch.push(act); simWorld = afterStep; continue   // 体力够，直接留
  }
  // ③ 体力不够 → 从原计划的 eat/coffee 前缀里按顺序取最小的够用前缀
  for (let tryIdx = topUpCursor; tryIdx < plannedTopUps.length; tryIdx++) {
    ...逐条模拟直到 action 合法且体力 ≥ floor...
  }
}
```

**三个关键约束**：
1. **体力下限要同时满足两层**：用户设定的预留（`staminaReserveFloor`）+ 计划为即将到来的偷菜承诺的体力（`plannedPostBucketEnFloor`）
2. **体力下限会随时间推移自动上调**：因为自然回复补上了 `passiveTicksElapsed` 点（`compile-prefix.mjs:239-254`），不要求把这段时间回的血也留着
3. **补体力只能用原计划里已有的 eat/coffee 前缀**，绝不现场挑选新的食物（`zero economic food selection in compile-prefix.mjs`）

### 8.6 输出：下一步发什么

```js
// compile-prefix.mjs:521-549
let nextTransactionKind = 'wait'
if (hasImmediateAction) {
  if (bucket0.visitFirst === true && visitOperations.length > 0)
    nextTransactionKind = 'visit'      // ← 抢偷菜窗口时，先发访问
  else if (prefix.length > 0)
    nextTransactionKind = 'act'        // ← 普通动作
  else
    nextTransactionKind = 'visit'
}
```

**`visitFirst` 的优先级**：当计划标注了「先访问」且体力够，就抢先发访问请求——因为偷菜窗口是**竞态**的，晚 2 秒可能就被别人偷了。

**另外两条安全阀**：
- 有随机动作 / 被截断 / 被转变截断 → `visitOperations` 直接清空（`compile-prefix.mjs:539-541`），不让访问插进不确定的状态里
- 访问操作的体力不足 → 整个计划 `plan-invalid`（`compile-prefix.mjs:505-519`）

### 8.7 计划签名：判断「还是不是同一个计划」

```js
// compile-prefix.mjs:557-586
export function buildExecutablePlanSignature(adapter, worldBefore, plan, { waitHorizonCapSec = null } = {}) {
  // 只比较"实际要执行的那部分"，忽略随机动作之后不可执行的长尾
  if (comp.status === 'wait')
    return JSON.stringify({ status: 'wait', nextWakeSec: cappedWake, raids: raidsSig })
  return JSON.stringify({
    status: 'ready', kind: comp.nextTransactionKind,
    dom: comp.domesticBatch,                      // 动作列表
    vis: comp.visitOperations.map(v => v.targetId), // 访问目标 ID
    raids: raidsSig,                              // 已承诺的偷菜（含解禁时刻）
  })
}
```

**用途**：两次规划如果签名相同，说明「结论没变」，可以继续执行上一轮的动作而不必重发；如果变了，才需要重建。这是**执行稳定性**的基础——防止规划器每轮都因微小数值差异给出不同动作。

---

---

## 9. 种植：种什么、什么时候种、浇几次水

> 文件：`planner/solve.mjs:1274-1378`（选作物）+ `model/rules-adapter.mjs:853-925`（生命周期模拟）+ `solve.mjs:4816-4881`（紧急农活排序）

### 9.1 决策：这块空地现在种什么

`selectBestCropToPlant`（1274-1378）对每个候选作物算一个**单位时间净收益率**，取最大。

```
对每个 crop ∈ R.CROPS：
  skel = 模拟从 now 种下到收获的完整生命周期
  R(c) = Σ over 每次收获 k, 每个品质 q:
           E[产量_{k,q}] × marginalItemValueFn(crop.id, q, matureAt_k)

  seedCost = (现在就有免费种子 sd_<crop.id> 且 q0 库存 > 0) ? 0 : crop.seed
  Net(c)   = R(c) − seedCost − staminaPointCost × skel.totalStaminaSpent
  rate(c)  = Net(c) / max(60, skel.endSec − startSec)

选 rate 最大的作物
```

**四个值得注意的细节**：

1. **`marginalItemValueFn` 用的是「成熟时刻」的价格，不是现在的价格**（`solve.mjs:1310`）。一茬作物 2 小时后才收，那它的价值就该按 2 小时后的价格算（含那时的阶梯饱和度、那时的槽位机会成本）。这是**唯一正确**的做法——用现在价格会系统性高估「晚熟作物」。

2. **免费种子只值「省下的种子钱」**（1305-1306）：
   ```js
   const hasFreeSeed = startSec === atSec && availableInv(state, `sd_${crop.id}`, 0) > 0
   ```
   它没有被当成「可以留着以后种的期权」。这是**已知的近似**——如果现在有人出高价买种子，直接卖可能更划算，但代码不考虑。

3. **体力成本用的是内生的影子价**（`staminaPointCost = baseStaminaShadowCost`，2076-2129）。体力富余时是 0，紧张时是「最便宜的补法」。

4. **`skel.totalStaminaSpent` 包含整条生命周期**：播种 + 全部浇水 + 全部收获 + 季末清理。不是只有播种那一下。

### 9.2 跨季溢出：这个修正不是可选的

如果一个作物的收获期跨过**季节边界**，它占着地到季末之后，就错过了下一季作物的收益。朴素的 `Net/occupiedSec` 会高估它。

```js
// solve.mjs:1331-1355
const rNextSeason = max over futCrop of evalCropAt(futCrop, nextSeasonBoundarySec, false).rawRatePerSec

for (跨季作物) {
  const spillNextSec = endSec - nextSeasonBoundarySec
  const surplusVsWait = Net - spillNextSec * rNextSeason
  if (surplusVsWait <= 1e-6) continue                      // 不如等下一季
  const preBoundaryWindowSec = min(occupiedSec, max(60, nextSeasonBoundarySec - atSec))
  score = surplusVsWait / preBoundaryWindowSec
}
```

**这个公式的意思是**：跨季作物的价值 = 它自己赚的 − 「如果这地空着等下一季能赚的」。只有**超额部分**才算贡献，并按「季末前那段可用时间」归一化。

**`rNextSeason` 是二次估算**：它又调用了一次 `evalCropAt`，用的是同一套 `marginalItemValueFn`，但那时投影的 `sc`（阶梯计数）可能已经不准了。这是**估算的估算**，误差会叠加。

### 9.3 天气与季节怎么进来

| 因素 | 影响 | 来源 |
|---|---|---|
| **季节** | 不在季的作物直接返回 `null`（不可种） | `rules-adapter.mjs:873-876` |
| **雨天** | `auto = true`，生长时间 ×0.6 | `rules-adapter.mjs:634-635` |
| **洒水器** | 同上（`R.sprinkled(state, i)`） | `rules-adapter.mjs:632` |
| **手动浇水** | 提高品质概率与产量，但不加速生长（见下） | `rules-adapter.mjs:771-780` |

**浇水只影响品质/产量，不影响成熟时间**——这是模拟器的**保守假设**：

```js
// rules-adapter.mjs:615-666 exactPlotTimings
// 只用已有的 p.g（已获得的生长缩减）计算成熟时刻
// 未来手动浇水的 25% 加速 NOT 计入
```

真实规则里手动浇水会缩短 25% 生长时间。模拟器不算，所以对「浇水能提前成熟」的收益是**低估**的。但品质收益照算。这是一个明确的单向保守。

### 9.4 紧急农活的排序：`rPlot` 是什么

每个桶开始时，求解器要决定「体力先给谁」。答案是按**单位时间净收益率**降序：

```js
// solve.mjs:4860
const rPlot = Math.max(0.01, bestNextP ? bestNextP.netRatePerSec : fallbackRate)
// fallbackRate = 当前作物价值 / max(1800, 生长秒数)
```

| 任务类型 | 排序键 | 额外考虑 |
|---|---|---|
| `harvest` | `rPlot + stealRisk/protectSec` | 越晚收越可能被偷 |
| `clear` | `rPlot` | 清地才能种下一茬 |
| `plant` | `netRatePerSec` | 早种早熟 |
| `feed` | `产品边际价值 / 产出周期` | 断粮停产 |
| `water`（即将缺水） | `fixedLossIfUnfunded` | 缺水停长 |

**`stealLossCap` 与 `sortPriority` 的精确公式**（4867-4882）：

```js
const unstolenExtra = Math.max(0, expectedHarvestYield(wEff, wasStolen).expectedUnits - 1.0)
const stealLossCap = unstolenExtra * marginalItemValueFn(p.c, 0, b.atSec)
const protectSec   = Math.max(600, timing?.protectSec || 1800)

sortPriority = rPlot + (b.atSec >= unlockAt
  ? stealLossCap / protectSec              // 已解禁：全额偷菜风险
  : (stealLossCap * 0.25) / protectSec)    // 未解禁：风险只算 25%
```

**`expectedUnits - 1` 是「除了保底 1 个之外，还有多少可能被偷走」**。乘以单价，就是「再等一会儿的期望损失」。

**「已解禁 / 未解禁」的 1 : 0.25 差别**：还没解禁的地，别人也偷不了，所以偷菜风险只按 1/4 计（预留给「解禁后马上被抢」的一点余量）。这是**排序上的优先级**——已解禁的地要先收。

**`wEff = auto ? 3 : p.w`**：如果洒水器覆盖，视为浇水 3 次（满），`expectedUnits` 按满水算。

**延迟损失的衰减函数**（5077-5083）：

```js
loss = rPlot × waitSec + stealLossCap × (e^{-未资助前秒数/protectSec} − e^{-未资助后秒数/protectSec})
```

指数衰减——已经被偷过的地（`p.sv` 非空）额外单位期望降为 1，此时 `stealLossCap = 0`，不再有偷菜压力。

### 9.5 浇水：什么时候浇

```js
// solve.mjs:2531-2542（探针扫描阶段）
} else if (st.stage >= 0 && st.stage < 3 && !auto && p.w <= st.stage && allowedSet.has('water')) {
  const stageEndSec = Number(p.t || b.atSec) + Math.ceil((Number(st.total || 3600) * (st.stage + 1)) / 3)
  const deltaWaterVal = 0.20 * unitVal            // ← 预扫描用「单价的 20%」粗估
  if (stageEndSec <= nextOppSecB) expiringWaters.push({ i, deltaWaterVal })
  else                            nonExpiringWaters.push({ i, deltaWaterVal })
}
```

**`stageEndSec` 的公式**：`p.t`（种下时刻）+ `总生长秒数 × (当前阶段+1) / 3`。因为作物分 3 个生长阶段。

**为什么分两类**：浇水有「最晚时刻」——如果这一阶段在你能再补水之前就结束了，那这次浇水就白浇了（作物已经进入下一阶段，浇水次数不会补回来）。这是**硬时间窗**。其余浇水可以等。

**`nextOppSecB`** 是「下一次机会」的时刻（下一次体力补充 / 下一个桶的开始）。

**预扫描用 `0.20 × 单价` 粗估，执行时用精确公式**：

```js
// solve.mjs:4823-4835
const exactManualWaterGain = (cropId, curW, remLeftSec, plotRatePerSec) => {
  const w0 = clamp(curW, 0, 2), w1 = w0 + 1
  const expVal = (w) => Σ_q expectedHarvestYield(w, false).expectedByQuality[q] × marginalValue(cropId, q)
  return max(0, expVal(w1) - expVal(w0))
       + max(0, plotRatePerSec) × floor(remLeftSec × 0.25)   // ← 加速的收益
}
```

**注意这里反而算了 0.25 的加速收益**——`plotRatePerSec × 剩余秒数 × 0.25`。这与 9.3 说的「模拟器不算浇水加速」并不矛盾：**选作物时不加速，算当前这次浇水的价值时加速**。前者是保守，后者是贪心——这是两处独立的近似。

**为什么预扫描可以粗估**：预扫描只决定「要不要现在就浇」（三类任务的排序），不决定「浇了值多少钱」。真正的价值在 Step D 的体力背包里用 `exactManualWaterGain` 精确计算。

---

## 10. 养殖：喂食、收集、心情

> 文件：`planner/solve.mjs:2247-2266`（collect/pet 顺序）+ `2618-2638`（feed 判定）+ `model/rules-adapter.mjs:928-986`（`exactBarnTimings`）

### 10.1 三个动作的确定性生成

```js
// solve.mjs:2247-2270
for (let i = 0; i < s.barn.length; i++) {
  const pen = s.barn[i]
  const stage = R.b12AnimalStage(pen, b.atSec)
  const st    = R.animalReady(pen, b.atSec)
  const canPet     = allowedSet.has('pet')     && !stage.retired && cnt['pet'+i] < 1
  const canCollect = allowedSet.has('collect') && st.ready

  if (canCollect && canPet) {
    if ((pen.m || 0) >= 95) earlyBatch.push({ a:'collect', i }, { a:'pet', i })   // 心情满 → 先收
    else                    earlyBatch.push({ a:'pet', i }, { a:'collect', i })   // 心情没满 → 先撸
  } else if (canPet)     earlyBatch.push({ a:'pet', i })
  else if (canCollect)   earlyBatch.push({ a:'collect', i })
}
```

**`canPet` 只看两件事**：今天没撸过（`cnt['pet'+i] < 1`）、没退休。**心情不决定能不能撸，只决定顺序**。

**为什么心情 ≥95 时先收再撸**：收集会重置心情（规则行为），如果先撸再收，撸的收益就被收掉了。心情 <95 时反过来——先撸把心情顶上去，再收不会掉太多。

**这是参考实现里少数几个「硬编码顺序」的地方**，注释里专门写了 `exact mood-cap ordering`——它反映的是规则的非交换性（两个动作交换顺序结果不同），不是经济偏好。

**`earlyBatch`**：这三个动作**不消耗体力**（0 EN），所以在探针阶段直接塞进 `earlyBatch`，不参与体力预算竞争。

### 10.2 喂食：两个条件，缺一不可

```js
// solve.mjs:2608-2616
const hungryAt = pen.f + 86400                          // 上次喂食后 24 小时开始饿（f = 上次喂食时刻）
if (b.atSec - pen.f >= 8 * 3600                         // ① 距上次喂食 ≥ 8 小时（不能再喂）
    && (hungryAt <= b.nextAtSec || b.atSec >= hungryAt)) // ② 饿的时刻在下一次产出之前，或现在就已经饿了
  hungryIndices.push(i)
```

**条件 ② 是整个喂食逻辑的核心**：

- `b.nextAtSec` 是这只动物**下一次产出**的时刻
- 如果 `hungryAt <= b.nextAtSec`，说明**不管它的话，它会在产出前就饿了**——那次产出会打折
- 如果 `b.atSec >= hungryAt`，说明**现在已经饿了**，正在掉产出

**这两个条件合起来的意思是**：只在「饿了会造成损失」的时候喂。如果动物还有 20 小时才产出、但 10 小时后就饿，那现在喂是**必要的**（因为下次产出在饿之后）。

**喂多少只也由体力决定**（2621-2636）：

```js
for (const idx of hungryIndices) {
  const prodVal = marginalItemValueFn(def.product, 0, b.atSec)
  const periodSec = max(3600, R.b12AnimalPeriod(pen.k, b.atSec))
  const lossPerEn = (prodVal / periodSec) * regenStepB     // 每点体力能挽回多少产出
  if (ensureProbeUrgentEn(fedCount + 1, lossPerEn)) {      // 体力够就喂
    feedActs.push({ a: 'feed', i: idx })
  }
}
```

**`lossPerEn` 是「每点体力的止损额」**：一个松露（13,500 D）的产出周期是 720 秒，那么 `13500/720 = 18.75` D/秒，乘以 `regenStepB`（回 1 点体力需要的秒数）就是「1 点体力值多少」。`ensureProbeUrgentEn` 按这个值决定是否分配体力。

**缺饲料时**（2618-2620）：

```js
const needBuy = Math.max(0, hungryIndices.length - haveFeed)
if (needBuy > 0 && allowedSet.has('buy') && coins - cashReserveFloor >= needBuy * feedPrice) {
  feedActs.push({ a: 'buy', id: feedId, n: Math.min(99, needBuy) })
}
```

**注意 `Math.min(99, needBuy)`**：服务端单次购买上限是 99。买多了浪费动作位。

### 10.3 动物没有「期末价值」

**这是参考实现最明显的估值盲区**：`objective.mjs` 完全不投射期末之后的动物产出。只有**库存里已有的动物产品**会被卖出。

与作物对比：

| | 作物 | 动物 |
|---|---|---|
| 期末已成熟未收 | 继续模拟收获与再生 | 不会自动收（必须玩家操作） |
| 期末在长大 | 按进度比例计价 | 完全不计价 |
| 期末即将产出 | 计入 | 不计入 |

**后果**：一头「还有 1 小时就产出高价值产品」的动物，和一头「刚喂完还得等 20 小时」的动物，在目标函数里价值相同（都只算库存）。这会在「卖动物 vs 留动物」的决策上系统性偏低——不过参考实现**没有卖动物的动作**，所以实际影响有限。

---

## 11. 加工：配方链、工坊槽位、和卖货的联合

> 文件：`planner/solve.mjs:588-647`（模板）+ `850-1244`（联合求解）+ `1247-1266`（动作合并）+ `4322-4483`（执行时的局部重解）

### 11.1 模板：把配方展开成「动作序列」

`buildCanonicalCraftTemplates`（588-647）对每个可售配方生成两类模板：

```js
// 单步模板
{ kind:'single', actions: [{id: rec.id, n: 1}], rawIn: {...rec.in}, craftSlots: 1 }

// 链式模板（输入本身也是配方）
{ kind:'chain',
  actions: [{id: upRec.id, n: qty}, ..., {id: rec.id, n: 1}],
  rawIn: { ...upRec.in 展开, 其他未加工输入 },
  craftSlots: 1 + Σ qty }
```

**只展开一层**。如果上游配方还有可加工的输入，它不会继续展开，而是留在 `rawIn` 里。

**这意味着什么**：一个三层深度的配方链（A→B→C），模板只到「B→C」这一层，A 必须已经在库存里。如果 A 也需要合成，需要两次独立的移动。`DESIGN.md` 说支持「任意深度」，但**代码层面不成立**。

**模板按签名排序**（644）：`signature = "${craftSlots}|输入排序->输出id"`。排序保证结果与 `R.RECIPES` 的排列顺序无关——这是一个**确定性**要求，否则同样的局面可能给出不同的计划。

### 11.2 联合求解：外层组合搜索 + 内层精确卖货

`solveJointCraftAndSell`（850-1244）的结构：

```
外层：决定每个候选加工移动 m 执行多少次 x_m
内层：给定加工后的 supply，对每个物品精确求卖货时序
目标：PortfolioValue(S + Σ x_m Δ_m) − staminaShadowCost × Σ x_m·slots_m
```

**它不是「先加工再卖」的两阶段**：加工决策直接以**最终卖货总值**为评分。加工 10 个铁锭会不会让铁锭价格垮掉？内层卖货求解器会算出来，反馈给外层。

**但也不是完整的多物品联合 MIP**：卖货对每个物品是独立求解的。物品之间只通过工坊容量和体力预算耦合。

### 11.3 精确 DFS：小规模时穷举（994-1085）

```js
// 先估算组合数
const exactTreeBound = C(M + d, d)   // M = 候选移动数, d = 最大深度
if (exactTreeBound <= 600) { 精确 DFS } else { 贪心 }
```

**DFS 的状态**：`(startIdx, curSupply, curEval, spentStaminaCost)`

**关键约束**：

```js
// solve.mjs:1019
for (let i = startIdx; i < candidates.length; i++) {
  dfs(i, ...)      // ← 从 i 开始，允许重复选 i
}
```

**「非降索引遍历」**：这保证枚举的是「多重集」而不是「排列」。做 A 再做 B，和做 B 再做 A，是同一个方案。**这把组合数从阶乘降到组合数**。

**体力约束按岛日前缀检查**（1026-1029）：

```js
// 从桶 u 到该岛最后一个桶，剩余体力都要 ≥ 本次消耗
for (let fu = u; fu <= lastBucketOfIsle; fu++) {
  if (remEn[fu] < enNeed) → 不可行
}
```

**为什么是「该岛所有后续桶」而不是「当前桶」**：因为体力是按时间顺序消耗的，一次加工消耗的体力必须在这个岛日内的任何时点都够用。

**节点上限与截断**（1003-1018）：

```js
if (nodes > 600 || (nodes % 64 === 0 && isPastDeadline())) → 截断
```

截断后保留当前最优，交给贪心兜底。

**注释说「exact memoized branch-and-bound」但代码里没有 memoization**——只有节点上限和增量卖货缓存。所谓「exact」只在 `exactTreeBound ≤ 600` 时成立。

### 11.4 贪心：大规模时的分块策略（1087-1219）

```js
// 每轮对所有候选算「最大可执行倍数」
const maxEnMult = min(capLeft, floor(remEn[fb] / enNeed))

// 分块大小：多就大块，少就小块
const chunk = maxEnMult >= 32 ? 16 : maxEnMult >= 8 ? 4 : 1

// 评分：单位工坊槽位的净增益
const ratio = (ΔValue − chunk × enNeed × staminaShadowCost) / (chunk × slots)

// 选 ratio > 1e-6 的最大者
```

**分块的意义**：加工 100 个物品如果一次只做 1 个，要 100 轮。分块后 16 个一轮，7 轮就够。但分块会掩盖「最后一块不赚」的问题，所以：

```js
// solve.mjs:1172-1190
if (chunk > 1) {
  // 比较「做 chunk 个」和「做 chunk-1 个」的价值
  if (最后一块收益 <= 0) {
    降低该候选的 chunk 上限到 4 或 1
    不提交
  }
}
```

**「最后一块校验」**：如果做到第 16 个时最后那个不赚了，就退回 15 个。这是分块贪心的标准补救。

### 11.5 扣料顺序：两处代码不一致

| 位置 | 顺序 | 理由 |
|---|---|---|
| `deductFromPrefixSupply`（693-704） | **最早桶优先** | 执行时在桶 u，未卖库存都汇入当前背包 |
| `emitOptimalBucketSells`（6884-6890） | **最晚桶优先** | 倒序扣掉未来加工消耗 |

两处对「未来加工会消耗哪批库存」的假设不一致。**这会不会出问题**：每个桶重解得局部计划（`computeBucketCraftBundles`），所以通常能吸收差异。但**极端情况下可能有原料竞争**。

### 11.6 动作合并：`mergeCraftActionsPreserveTopo`（1247-1266）

```js
// 只有「相邻且 id 相同」的 craft 动作才合并，合并后 n ≤ 20
while (i < list.length) {
  let run = 1
  while (i + run < list.length && list[i+run].a === 'craft' && list[i+run].id === list[i].id) run++
  // 合并成 ceil(run*n/20) 条
}
```

**「保拓扑」不是全局拓扑排序**，只是「不改变既有顺序的合并」：

- 链式模板内部的「上游→下游」顺序不变（模板生成时就把上游放前面）
- 不同桶的动作仍按桶的先后顺序聚合

**为什么要合并且 n ≤ 20**：服务端单动作上限是 20。合并减少动作数量，节省 HTTP 批次。

### 11.7 执行时为什么要重新求解

联合计划 `craftsByBucket` 是全局的。但执行到第 3 个桶时，真实库存已经和 Step B 的预扫描不同了（可能因为 raid、可能因为某次收获失败）。

所以每个桶在执行前**重跑一次局部 `solveJointCraftAndSell`**（4374-4388），用当前真实库存 + 未来同岛已计划加工量，然后再手工检查链式上下游的扣料可行性（4393-4458）。

**结果被拆成单步**，包装成 `craft-bundle`，带上 `gain` 和 `costEn`，进入 Step D 的体力背包。

---

## 12. 卖货：时序、阶梯、税

> 文件：`planner/solve.mjs:248-587`（`solveExactItemSaleSchedule`）+ `6835-6915`（`emitOptimalBucketSells`）

### 12.1 这是一个「带容量约束的多槽分配问题」

**问题**：你有一批货，分布在未来的若干「卖出窗口」里。每个窗口价格不同，有些物品还有每日阶梯容量。怎么分配使总收入最大？

**决策变量**：

```
x[id, q, u, d, t] ≥ 0   第 u 批到货的、品质 q 的 id，在第 d 自然日、第 t 阶梯卖出的数量
```

**约束**：

- 第 u 批货只能卖到 `availFromBucket ≥ u` 的槽位（不能卖未来才到的货）
- 每个自然日每个作物的累计销量 ≤ 150（tier 0）/ 400（tier 0+1）/ ∞（tier 2）
- 每一批的数量守恒

**目标**：

```
max Σ x × round(p × QUALITY[q]) × γ_s × τ × κ_t
```

`κ = [1.0, 0.85, 0.70]` 是阶梯倍率。

### 12.2 非作物：O(1) 查表就是精确最优

非作物没有每日阶梯容量，所以每批货**完全可分离**——独立选「可用槽位里单位价值最大的那个」就是全局最优。

```js
// solve.mjs:181-201（预计算）
for each sellable slot s:
  unit = round(price_s[item] × QUALITY[q])
  mult = slot.disc × slot.netTaxFactor
  for u = 0..availFromBucket(s):
    if (unit × mult > best[u,q] + 1e-9) { best[u,q] = ...; idx[u,q] = s }
```

**`s` 升序遍历 + 严格 `>` + 1e-9 容差**：并列时保留**更早**的槽位。这是确定性的 tie-break，避免同样的输入产生不同输出。

### 12.3 作物：两次快速判断，不行才上 MCMF

**第一判断：全局总量 ≤ 150？**（314-355）

```js
if (initialScCount + totalSupply <= 150) → 所有销量都在第一阶梯 → 直接按最佳槽分配
```

**第二判断：逐个自然日检查**（330-355）

```js
// 先把每个供给节点分到「无约束最佳槽位」
// 统计每个自然日的用量 dayUsed[d]
// 若所有自然日都满足 sc0(d) + dayUsed[d] <= 150 → 这份分配可行，且就是最优
```

**为什么这是精确的**：如果「一阶容量完全不绑定」，那么阶梯约束就是无效约束，问题退化为非作物的可分离情形。

**第三：MCMF**（357-581）

当一阶容量会绑定时，转成**最小费用最大流**：

```
节点：
  SRC
  G_i          每个合并后的供给组（同 q 且对每个自然日的 best slot 向量完全相同）
  T_{d,t}      自然日 d × 阶梯 t
  SNK

边：
  SRC → G_i        cap=cnt_i,    cost=0
  G_i → SNK        cap=cnt_i,    cost=0                  ← 卖不掉就持有
  G_i → T_{d,t}    cap=cnt_i,    cost=−baseFactor×κ_t
  T_{d,0} → SNK    cap=max(0,150−sc0(d)),      cost=0
  T_{d,1} → SNK    cap=max(0,400−max(150,sc0(d))), cost=0
  T_{d,2} → SNK    cap=totalSupply,            cost=0
```

**用 SPFA 逐次最短增广路**（496-550）：

```js
while (存在 SRC→SNK 路径) {
  找最短路（费用最负）
  沿路取最小剩余容量 push
  totalCost += push × dist[SNK]
}
return { sellsBySlot, totalWeightedRevenue: −totalCost }
```

**`−minCost` 就是最优折现收入**。

### 12.4 三个聪明的剪枝

**① 供给组合并**（361-400）：两个 `(u,q)` 节点如果对**每个自然日**的最佳槽位都相同，合并成一个。这是**精确等价**，不损失最优性。

**② `maxTierByDay`**（463-475）：如果 `totalSupply ≤ cap0`，这个自然日不可能超过 tier 0，不生成更高阶梯的边。这是安全剪枝——任一天的销量不可能超过全局总供给。

**③ 缓存**：
- `slotScheduleWeakCache` 以 `slots` 数组对象为 key
- `globalSlotItemStructCache` 以 `R` 为 key + `schedKey`
- `flowRevCache`（8192 条）/ `flowFullCache`（2048 条）

### 12.5 税：计划用近似，执行用精确

```js
// solve.mjs:1693-1695
const approxTaxFactor = Math.max(0.05, Math.min(1,
  1 - R.b12TaxSale(startWorld.state, {t: startWorld.now}, coins, 10000) / 10000
))
```

**只用一个「1 万块的单子」的税率做线性因子**，整个计划期所有槽位共用。真实税是**渐进**的（超过 300 万 1%，超过 1000 万 3%），大额卖出的实际税率会高于这个近似。

**两个后果**：

1. 计划与实收有系统性偏差（通常高估收入）
2. **这个近似计算有副作用**：`R.b12TaxSale` 会写入 `state.b12.tax.paid`。而 `execWorld` 又是从 `startWorld` 克隆的，所以后续模拟的税基包含这笔**假想**的 1 万销售额

金额很小（正常钱包 100-300 D），但这是一个**不纯的函数调用**，属于实现瑕疵。

### 12.6 逐动作发射（6835-6915）

```js
// 每个桶末尾：
1. 取当前可用库存，扣掉未来 raid 预留的 pendingEatReserve
2. 构造 remSlots（availFromBucket 平移到当前桶，当前槽价格换成实时价）
3. 对每个物品构造 remSupply：当前库存 + 未来到货 − 未来加工消耗（倒序扣）
4. 调 solveExactItemSaleSchedule → sellsBySlot
5. 只发当前桶 sellsBySlot[0]，按 q=2 → q=1 → q=0，每 999 个切一条
```

**为什么「只发当前桶」**：未来桶的卖出计划依赖未来的价格，那时会重新算。现在发了未来桶的量就是**跨期承诺**，违背了非预期性。

**为什么 q=2 先卖**：高星物品单价高，先卖高星的能更快填满当日阶梯的「高价段」。等等——阶梯是按**数量**算的，不是按价值。那为什么先卖 q2？

因为 `sellsBySlot` 里 q2/q1/q0 的量是分开算的，**先卖哪种不影响总量**。顺序只是为了确定性（同样的输入产生同样的动作序列）。

### 12.7 已知的三个偏差

| 偏差 | 原因 | 影响 |
|---|---|---|
| 按单位取整 vs 按批次取整 | 求解器 `round(p×qual)×mult` 后累加浮点；真实是整批算完再 `Math.round` | 每批每阶梯段最多 1 D，只在接近并列时改变决策 |
| 未来自然日的 `initialScCount` 按 0 | 只有当前日使用真实值 | 跨自然日时正确（00:00 清零），同日重规划时用 `emitOptimalBucketSells` 的真实 `cnt` 修正 |
| 自身销量不反馈到未来价格 | `soldTracker` 只用初始已知销量 | 计划阶段对未来价格**乐观**；执行阶段用真实 `execSoldByIsle` 重算 |

**第三个是最严重的**：如果计划「今天卖 500 个」，价格模型不会知道「卖了 500 个之后价格会跌」。它按「外部供给因子」算价。实际执行时价格已经跌了，所以收入会低于预期。

---

## 13. 采购：货船与商店

> 文件：`planner/solve.mjs:3048-3925`（三阶段背包 DP）

### 13.1 货船（`stockBuy`）：一个岛日只买一次

```js
// solve.mjs:2687
if (seenCargoIsle.has(b.isleIndex)) continue
seenCargoIsle.add(b.isleIndex)
```

**为什么只买一次**：货船货品每天刷新，一次买完是最优的——分多次买不会改变价格或库存，只会多花动作位。

### 13.2 三阶段 DP：为什么不能一次性算

货船物品有三种用途，互相竞争：

| 用途 | 例子 | 占用资源 |
|---|---|---|
| **吃** | 买作物直接吃回体力 | 体力上限 |
| **直卖** | 买便宜货转手卖 | 销售额度（会压价） |
| **加工** | 买原料做成品 | 工坊槽位 + 体力 |

如果一次性做三维 DP，规模是「体力 × 现金 × 工坊槽」，会爆炸。所以拆成三个阶段：

```
Phase 1：体力供给 + 双用途物品（吃或直卖）
         → (e, c) 二维 DP
Phase 2：不占工坊槽的工作单元（已有炸弹/钓鱼/挖矿 + 付费购买的）
         → (e, c) 二维 DP
Phase 3：占工坊槽的配方 bundle
         → (s, e, c) 三维 DP，但仅当现金足以覆盖 S 个槽时启用 S_eff = min(24, S)
```

**关键剪枝**（3310-3323）——**先证明「槽位是约束」，才建第三维**：

```js
// 1. 所有占槽的配方 bundle，按「每槽位现金成本」升序排
const sortedBySlotCost = bundleUnits.sort((a, b) => a.cashCost / a.slotsCost - b.cashCost / b.slotsCost)

// 2. 贪心：现金够买就买，累计能买到多少个槽
let remCash = availCoins
for (const bIt of sortedBySlotCost) {
  if (bIt.cashCost <= remCash) { remCash -= bIt.cashCost; maxCashFeasibleBundleSlots += bIt.slotsCost }
}

// 3. 现金能买到的槽 > 实际可用槽 S → 槽才是约束，才建第三维
const slotsBinding = maxCashFeasibleBundleSlots > S
const S_eff = slotsBinding ? Math.min(24, S) : 0
```

**逻辑是**：如果连「最便宜的一批配方」都买不起，那瓶颈是**现金**而不是工坊槽。这时候把配方 bundle 当成「无槽工作」放进 Phase 2 的 (e,c) 二维 DP 就行了——多建一维只会让 DP 变大而毫无收益。

**`Math.min(24, S)` 是硬上限**：如果 S = 60（多岛同时加工），只建模前 24 个槽。超过 24 的部分视为「不受限」。这是一个**明确的近似**——在工坊槽本来就稀缺的情况下，24 个已经足够表达「要不要做第 25 个配方」的区别。

**双用途物品的拆包**（3328-3362）：

普通二进制拆包 `1,2,4,...` 无法精确表达「买 5 个，3 个吃 2 个卖」这种组合。所以用**双分区拆包**：

```js
// 双用途：先放 1 个，然后 [1,1,2,2,4,4,...]   ← 每档两个
// 单用途：标准 [1,2,4,8,...]
if (base.canEat && base.canDirect) {
  out.push(scaleFn(base, 1)); rem -= 1
  for (let bPow = 1; rem > 0; bPow *= 2)
    for (let rep = 0; rep < 2 && rem > 0; rep++) {   // ← 每档重复两次
      const takeN = Math.min(bPow, rem); out.push(scaleFn(base, takeN)); rem -= takeN
    }
}
```

**为什么每档要两份**：一个物品可以「吃」也可以「卖」，所以同一个 bundle 需要被**独立选择两次**——一次计入吃的数量，一次计入卖的数量。两份相同大小的 bundle 让 DP 可以「取一份吃、取一份卖」。

**能表示的范围**：`[1,1,1,2,2,4,4,...]` 可以精确表示任意 `(kEat, kDirect)` 满足 `kEat + kDirect ≤ run`。

**这是整个求解器里最巧妙的技巧之一**。

### 13.3 商店（`buy`）：只买三样

```js
// solve.mjs:2625, 6692, 6706
buy: feed（饲料）/ explosive（炸药）/ bait（鱼饵）
```

**只买这三样**，而且买炸药/鱼饵前要预留「待执行咖啡的现金」（6685-6709）——否则会出现「买了炸药，咖啡钱不够了，体力不足，动作失败」。

### 13.4 现金约束：所有购买都先扣保留线

```js
// solve.mjs:4503
const freeCash = Math.max(0, coins - constraints.cashReserveFloor)
```

**没有「透支」分支**。任何购买都受这个限制。这是**硬约束**，不是软罚。

---

## 14. 钓鱼、挖矿、炸弹：随机产出的定价

> 文件：`planner/resources.mjs:315-376`（期望产量）+ `solve.mjs:4023-4034, 4513-4619`（背包单元）

### 14.1 三个动作的期望产量函数

**挖矿**（`resources.mjs:319-334`）：

```js
floor = max(1, min(state.mine.max, PICK_FLOOR[pickLv] || 8))
pool  = { ore | ore.floor <= floor }
weight = ore.w × (ore.price>=12000 && weather==3 ? 1.6 : 1)
              × (1 + (floor − ore.floor)/40)
expectedHits = 1 + (0.25 + 0.05 × pickLv)
byOre = expectedHits × normalizedWeight
```

**炸弹**（`resources.mjs:336-353`）：

```js
weight = ore.w × (ore.price>=7000 ? 1.35 : 1)
              × (ore.price>=12000 && weather==3 ? 1.6 : 1)
              × (1 + (floor−ore.floor)/40)
expectedDrops = 6 + 2 × (0.3 + 0.05×pickLv)
```

**钓鱼**（`resources.mjs:355-376`）：

```js
miss = max(0.05, 0.22 − 0.04×rodLv − 0.08×bait − 0.05×rain)
catchProb = 1 − miss
weight = fish.w × (fish.price>=9000 ? (bait?2:1)×(rain?1.5:1) : 1)
pGold   = 0.08 + 0.05×rodLv
pSilver = (1−pGold) × 0.28
pNormal = 1 − pGold − pSilver
byFish[f] = [catchProb×normW×pNormal, ×pSilver, ×pGold]
```

**这三个函数的权重是启发式的**。`(1 + (floor−ore.floor)/40)` 不是规则里的公式，而是对「深层矿更常见」的近似。天气/价格加成也是硬编码。

**它们是「期望值」，不是「精确分布」**——除了 `enumerateExactSingleStochasticOutcomes`（审计用），规划层只用期望。

### 14.2 在背包里怎么竞争

```js
// solve.mjs:4523-4527（炸弹）
const dropVal = Σ_ore expectedDrops[ore] × marginalItemValueFn(ore, 0, atSec)
items.push({ kind: 'bomb-inv', costEn: 6, gain: dropVal })

// 买炸弹
const netGain = dropVal - shopBombPrice × bucketDisc
if (netGain > 1e-6 && maxAfford > 0) items.push({ kind: 'bomb-buy', costEn: 6, gain: netGain, cashCost: shopBombPrice })
```

**钓鱼的特殊处理**（4563-4566，见 7.5.1）：同一个岛日后面有更好的黄金时段 → 现在不钓。

### 14.3 执行：随机动作单独成批

```js
// solve.mjs:4078-4091
const firstKey = adapter.isStochasticAction(firstAct) ? firstAct.a : 'det'
// 收集同 key 的连续动作，每批 ≤40
const sv = simulateValidBatch(..., { rand: getExecPrngForKind(firstKey) })
```

**为什么随机动作必须单独成批**：一个批次里的随机动作会依次消耗同一个 PRNG 流。如果混着 `fish` 和 `mine`，那么「钓了几次」会改变「挖矿的结果」——**破坏了动作之间的可比性**。

分批之后，每种动作有自己的流，互不干扰。

### 14.4 这三样都进不了「精确上界」

```js
// bounds.mjs:34-43
for (const stAct of ['harvest','fish','mine','bomb','trap','visit','npc','scratch'])
  if (allowed.has(stAct)) return { validUpperBound: null, status: 'not-applicable-stochastic' }
```

**只要允许集里有任何一个随机动作，上界就拒绝给出**。而默认动作集几乎总是包含这些——所以 `certified-optimal` 在实践中几乎不会出现。

**这不是缺陷，是诚实**：拉格朗日松弛假设变量是连续的、收益是确定的。随机的产量无法用线性约束表达上界。

---

## 15. 偷菜：从「打不打」到「几点几分出发」

> 文件：`execution/snipe-scheduler.mjs`（1,719 行）+ `planner/solve.mjs:7095-7184, 7200-7240, 10131-10800`（经济评估）。
>
> 偷菜是整个项目**离「最优控制」最远、离「工程对抗」最近**的模块。它要解决的问题不是「怎么算收益最大」，而是「**别人也在算，你为什么能先到**」。

### 15.1 决策被拆成两层，用同一个大脑

| 层 | 问题 | 时间尺度 | 代码 |
|---|---|---|---|
| **规划层** | 这一轮要不要偷？偷谁？带什么装备？喝什么 buff？ | 分钟级 | `packRaidsOnMarginalContext` + `evaluateMarginalRaidDelta` |
| **执行层** | 解禁时刻是几秒？提前多少秒出发？失败了怎么办？ | 秒级 | `SnipeScheduler` |

**关键设计**：执行层不是「按规划层的结论照做」。它维护自己的**每个目标的状态机**（`data.targets[id]`），随时可能因为新观测推翻规划层的判断。

但**两层的评分函数是同一个**。注释写得很直白：

> `createUnifiedRaidEvaluator`（10787）：Discovery / wave timing / staging / `T_unlock` execution **ALL share the exact same unified economic brain as `solveUnifiedPlan` with ZERO heuristic shadow prices**.

**为什么要强调这一点**：如果发现阶段用「粗略估值」、执行阶段用「精确估值」，那么「发现时觉得很赚、执行时发现不赚」会浪费一次提交槽位——而提交槽位是稀缺资源。

### 15.2 一个 raid 到底值多少：`evaluateMarginalRaidDelta`

这不是「战利品价值 − 体力成本」。它是：

```
ΔJ = 在 marginalCtx（冻结的基线计划）之上，
     把「这次 raid 造成的库存变化 + 体力变化 + 现金变化」
     重新跑一遍完整的「联合加工 + 卖货 + 体力再分配」，
     得到的净值差
```

**为什么必须重跑而不是查表**：偷来的 10 个铁矿石不是「10 × 铁矿石单价」。它可能是：

- 直接卖 → 按当前阶梯饱和度算钱
- 加工成铁锭再卖 → 多一道工序，但价值更高
- 加工会挤占工坊槽位 → 原本计划的加工被挤掉

**所有这些只有重跑联合求解才知道**。查表会系统性高估（默认「什么都能直接卖」）。

**实现上的三个巧思**：

**① 只重算「被触及」的部分**（10209-10233）：

```js
const canChangedItemTouchCraft = (id) => {
  const d = invDeltaById[id]
  const hasNeg = 有任意品质为负        // 消耗了原料
  if (hasNeg) return recipeInputSet.has(id) || adapter.graph.recipesById.has(id)
  if (!recipeInputSet.has(id)) return false   // 不是原料 → 影响不到加工
  if (baseCraftTouchedIds.has(id)) return true  // 原本就用到它
  const recs = adapter.graph.consumedByRecipes.get(id)
  ...
  // 新增的量是否足够凑够一个新配方的最小需求
  return totalQty >= minReq
}
```

**「新增 1 个铁矿石」如果原本计划里完全不用铁矿石，且库存里也没攒够 → 它影响不到加工，只影响卖货**。这时走快速路径，不重跑 `solveJointCraftAndSell`。

**② 三档精度**：

| 情形 | 方法 |
|---|---|
| 不触及加工 | `evaluateSupplyPortfolioIncremental`（只重算卖货，带 baseEval 增量） |
| 触及但只有新增 | 「保留全部原加工」的快速解 + 「边际槽位展开」 |
| 有原料被消耗 | 完整重跑 `solveJointCraftAndSell` |

**③ 体力可达性收紧**（10177-10189）：

```js
const maxReachableIsle0En = max(0, postRaidEn − preEnSpent0 − bucketEnFloor)
                          + regenInIsleWindow
                          + totalTopUpEnCap
```

**如果偷菜后体力变少，那么原本计划的加工就排不满了**。这里把体力上限收紧到「偷完之后实际能达到的体力」，让联合求解在**更紧的预算**下重排。这是「raid 的体力机会成本」的精确表达——不是扣一个影子价，而是让后续计划自己退化。

**`totalTopUpEnCap` 里还扣掉了 `coffeeUsedInPrep`**：准备 raid 时喝掉的咖啡，不能在国内计划里再算一次。

### 15.3 打包多个目标：分支信念树

`packRaidsOnMarginalContext`（10554-10780）一次最多打 3 家。它的搜索结构不是「枚举子集」，而是**逐步扩张的分支树**：

```
ensemble = [{ prob: 1.0, en: startEn, invDelta: prepDelta, val: baseVal }]

for step in 0..min(remStealBudget, N, 3):
  对每个剩余候选目标 v：
    对 ensemble 的每个分支 br：
      三种结果
        A. 未触发守家（概率 1−pDet）：
             inv' = br.inv + v.lootBag
             val' = evaluateMarginalRaidDelta(en − cost, inv')
        B. 触发守家且赢（概率 pDet × wBranch）：
             inv' = br.inv + v.guardWinLootBag
             val' = evaluateMarginalRaidDelta(...)
        C. 触发守家且没赢（概率 pDet × (1−wBranch)）：
             inv' = br.inv        ← 什么都没拿到
             val' = evaluateMarginalRaidDelta(...)
      把 A/B/C 三个分支的概率乘上去，加入 nextBranches

    evMid = Σ_br br.prob × [ pUndet·vA + pDet·(wMid·vB + (dMid+lMid)·vC − lMid·fine) ]
    decisionScore = (未观测先验) ? evLo : evMid

  选 decisionScore > 1e-6 且最大的 v
  把 nextBranches 按概率排序，只保留前 4 个，概率重归一化   ← 剪枝
  ensemble = 剪枝后的分支集
```

**四个必须理解的设计**：

**① 每个分支都要重算经济价值**。分支数 = 4^step（剪枝前）。3 步就是最多 16 次 `evaluateMarginalRaidDelta`。每次都要跑卖货求解。**这就是为什么有 `marginalContext` 冻结基线**——基线建一次，增量算 N 次。

**② 用区间而不是点估计**：

```js
const wLo = vb.winInterval[0], wHi = vb.winInterval[1], wMid = 0.5*(wLo+wHi)
evLo / evHi / evMid 三套
decisionScore = estimationSource === 'unobserved-wide-prior' ? evLo : evMid
```

**对「完全没观测过的岛」用下界 `evLo`，对观测过的用中点 `evMid`**。这是一条**悲观-乐观分离**原则：不知道的对手，按最坏情况算；见过的对手，按中点算。

**③ 每一步都必须严格正 EV**（10723-10725）：

```js
// Every raid step must strictly add positive value over afterPrepWorld
// (never piggybacking a negative-EV raid on domestic coffee/food stamina surplus!)
const allowStep = decisionScore > 1e-6
```

**「反正咖啡都喝了，顺手再偷一家」是被明令禁止的**。喝咖啡是为了国内生产，不是为了给负 EV 的偷菜兜底。

**④ 全局门槛是「比什么都不偷更好」**（10763-10764）：

```js
const totalNetDelta = baseAfterPrepDelta + sumScore
if (totalNetDelta > bestNoRaidPrepFloor + 1e-6 && ...) bestOption = ...
```

`bestNoRaidPrepFloor` 是「只做 buff + 体力准备、不偷任何一家」的价值。**准备动作本身也有价值**（吃饱了体力变多），所以基线不是 0。

### 15.4 信念从哪来：守家战力后验

```js
// snipe-scheduler.mjs:341-347
const posterior = (owner.guard && effGearCtx.gearData && this.profileStorePath)
  ? computeGuardPosteriorForTarget(effGearCtx.gearData, idNum, {
      knownOpponentLevel: owner.level || null,
      observedPanels: effGearCtx.observedPanels,
      storePath: this.profileStorePath,
    })
  : null
```

**三种信念来源**（`belief.estimationSource`）：

| 来源 | 含义 | 用的值 |
|---|---|---|
| `no-guard-deterministic` | 对方没守家 | 100% 拿满，零风险 |
| `observed-*` | 打过，有战绩 | 区间中点 |
| `unobserved-wide-prior` | 没见过 | 宽先验 + **下界** |

**「零 `/8` 启发式」**：多目标共享 buff 时，代码用**真实观测过的其他岛**（`_liveVisitBundles`，最多 2 个）参与评估，而不是「假设每个岛有 1/8 概率」这种编造的先验。

### 15.5 体力准备：按「每点体力花了多少钱」排序

`findCheapestRaidStaminaPrep`（7095-7184）是一个**贪心循环，最多 12 轮**：

```js
while (en < neededEn && guard < 12) {
  候选：
    - 零食（每日限量，cpe = 0）         ← 最优先，因为不花钱
    - 背包里的可吃作物：cpe = 价格 / 获得的体力
    - 货船可买的可吃作物：先 stockBuy 再 eat
    - 咖啡：cpe = 15000 / 60 = 250
  选 cpe 最小的，模拟执行
  if (!step.allOk) break     ← 模拟失败立刻停，不盲目重试
}
```

**`cpe = 价格 / 实际获得体力`**，而「实际获得体力」会被 `enMax - en` 截断——吃到满就不再吃。

**`prepareRaidStaminaWithOppCost`（7240）是升级版**：它把「吃掉的可食物品本可以卖的钱」也算进成本（`edibleOppValueFn`）。这是**正确的机会成本**——你吃的那个苹果如果卖掉能换 40 D，那它就不是免费的。

**为什么还需要旧版**：`packRaidsOnMarginalContext` 用的是旧版（10601），因为此时它已经在对比「有 raid / 无 raid」的完整价值差，机会成本会**重复计算**。

### 15.6 解禁时刻：本地推算 + 过期退避

偷菜的核心竞争力是「准确知道几点几分解禁」。这全靠本地模拟（`exactPlotTimings` / `exactBarnTimings`）。

**状态分类**（419-464）：

| 现象 | 判定 | 解禁时刻 |
|---|---|---|
| 已成熟、未被偷 | `stage===3 && stolen===0` | `matureAt + protectSec` |
| 已成熟、已被偷 | `stage===3 && stolen>0` | `nowSec`（可以立刻再偷，有 perPlot 上限） |
| 生长中 | `stage<3` | `matureAt + protectSec` |
| 别人的洒水器覆盖 | `sprinkled` | 视为「不可变」，标记 `exact: true` |
| 只有二手快照 | 无 `rawPlot` | `seenRipe + protectSec × 0.5`（粗略估计，`exact: false`） |

**`guardOverdue` 退避**（358-366）：

```js
if (rawUnlockAt > nowSec) return { unlockAt: rawUnlockAt, exact: isExact }
// 已经过期了还解不了
if (rawUnlockAt >= nowSec - 2 && prevOverdueCount === 0) return { unlockAt: nowSec + 1 }   // 首次：秒级抖动
const backoff = [5, 20, 60, 300][min(3, prevOverdueCount)]
return { unlockAt: nowSec + backoff, exact: false }
```

**「过期 5 分钟还没解禁」说明推算错了**（对方重新种了、或者规则变了）。这时候不能每轮都试，退避到 5 分钟。

### 15.7 多波次：一次访问最多安排 3 波

```js
// 500-593
const maxWavesForOwner = Math.min(3, Math.max(1, ownerLeft))
for (const candT of 不重复的解禁时刻) {
  if (upcomingWaves.length > 0 && candT < lastWaveUnlockAt + 15) continue   // 波间隔 ≥15s
  构造「假设此刻已解禁」的模拟岛（simPlots / simBarn）
  用同一个 evaluator 评估这一波
  if (profitable && spots ≥ minStealSpots && score > 0) 收下
}
```

**「模拟岛」的技巧**：把「将要成熟的」地块在副本里改成「已成熟可偷」，然后交给**同一个** `evaluateTargetWave`。这样波次评估和即时评估用的是同一套代码，不存在「波次估值口径不同」的问题。

**`claimedPlotSet` 去重**：已经算进第 1 波的地块，第 2 波不再算。否则同一块地会被重复计价。

**`waveBundlesByUnlock`**：每波存一份模拟世界。执行到第 2 波时，直接取那份快照，不用重新 GET。

### 15.8 什么时候再去探测：`nextProbeAt` 的五级规则

```js
// 606-621
let nextProbeAt = nowSec + 900                                  // 默认 15 分钟
if (blockedUntil > nowSec)          nextProbeAt = blockedUntil + 5
else if (readyEligible)             nextProbeAt = nowSec          // 现在就能偷 → 立刻
else if (upcomingEligible && expectedUnlockAt != null) {
  const lead = expectedUnlockAt - nowSec
  if (lead <= 45)                   nextProbeAt = expectedUnlockAt        // 45 秒内 → 卡点
  else if (有更早成熟且不在解禁前 60 秒内) nextProbeAt = earliestMatureAt + 5
  else                              nextProbeAt = max(nowSec + 60, expectedUnlockAt - 35)
} else if (allUnlocks.length > 0)   nextProbeAt = max(nowSec + 120, allUnlocks[0].unlockAt)
```

**45 秒这个阈值从哪来**：一次 GET 大约 0.5-2 秒，加上体力准备（可能要吃 2-3 个东西），再加换装（每次 1.25 秒）。45 秒是「还有时间从容准备」的下限。

**`expectedUnlockAt - 35`**：如果解禁在很久以后，就提前 35 秒去探一次。为什么不是提前 60 秒？因为太早探到的快照可能过期（对方在这期间收获了）。35 秒是「足够准备、又足够新鲜」的折中。

### 15.9 出发提前量：`computePhysicalPrepLeadSec`

**这是纯物理计算，不含任何经济判断**（218-241）：

```js
const rttSec     = clamp(lastRttMs / 1000, 0.5, 2.0)
const worldCheck = rttSec + 0.35                                  // 一次 GET /world
const actPrep    = 需要 act ? (actCd + minGap + rtt + 0.5) : 0     // 吃/喝
const perSwap    = max(1.25, rtt + 0.35)                          // 换一件装备
const gearPrep   = 换装 ? (equipCd + rtt + swaps×perSwap + 0.6) : (有守家 ? rtt+0.5 : 0.2)
const visitCd    = (不需要 act 且不换装) ? visit 剩余冷却 : 0

return worldCheck + actPrep + gearPrep + visitCd + 1.0            // +1 秒安全余量
```

**每一项都是「串行的、可测量的」**：

- 动作接口有 `minGap = 2` 秒的强制间隔
- 装备接口有自己的冷却
- 每次 HTTP 有 RTT
- **每项都要单独留 0.35-0.6 秒的余量**（应对抖动）

**结果用在两处**：

1. `shouldBlockBackgroundWork` 的窗口（1034）：`max(12, ceil(lead + 4))`
2. `nextExactUnlockInfo` 判断「新发现的目标还来不来得及」（976-985）：

```js
const immWindow = Math.ceil(computePhysicalPrepLeadSec(entry) + 2)
if (leadSec > immWindow) {
  sched.needsRefresh = true          // 还来得及 → 触发一次完整重规划
  continue
}
unplannedImminentDiscovery = true    // 来不及了 → 走快路径，直接上
```

**「来不及了就跳过重规划直接上」**——这是一个**刻意的权衡**：重规划要几秒钟，而窗口就在眼前。宁可放弃「最优选择」，也不能错过「次优选择」。

### 15.10 抢占与体力预留

```js
// shouldBlockBackgroundWork（1027-1036）
if (hasReadyTargetNow()) return true
const nxt = nextExactUnlockInfo(nowSec)
return nxt && nxt.leadSec <= max(12, ceil(prepLead + 4))
```

**一旦返回 true，国内经营、擂台、修仙全部让路**。

```js
// computeImminentSnipeStaminaReservation（1042-1071）
const needAtUnlock = min(15, max(6, projectedEnergyCost))
const naturalRegen = floor(lead / regenSec)          // regenSec 默认 180
const floorNow = min(enMax, max(0, needAtUnlock - naturalRegen))
```

**这是「体力预留」的精确形式**：如果 20 分钟后要偷一家需要 8 点体力的岛，而自然回复每 3 分钟 1 点，那么现在只需要留 `8 - 6 = 2` 点体力。

**没有任何多余的安全边际**——`needAtUnlock` 的上限 15 点是因为「最贵的 raid 也就 15 点」。留多了会浪费国内产能。

### 15.11 回执状态机：三种失败，三种处理

```js
// recordSnipeReceipt（765-899）
const respRejected = rawResp?.ok === false || httpStatus >= 400

if (respRejected) {
  const sentBeforeOrAtBoundary = expectedUnlock != null && (
    sentAtServerMs != null
      ? sentAtServerMs < expectedUnlock * 1000 + 250      // ← 用「发出时刻」判断，不是收到时刻
      : ...
  )

  // ① 每日上限 / 新手 / 今天偷过
  if (/上限|今天偷过|新手/.test(errMsg)) {
    blockedUntil = nextNaturalDayBoundary()   // 封到明天 0 点
    upcomingWaves = []                        // 所有波次作废
  }
  // ② 409 且「在边界上发出的」且当前时刻离解禁 ≤2 秒 且没重试过
  else if (status === 409 && sentBeforeOrAtBoundary && |now − expectedUnlock| <= 2 && earlyRetryCount === 0) {
    earlyRetryCount = 1
    expectedUnlockAt = max(now + 1, prev + 1)  // 1 秒后重试一次
    readyEligible = false
  }
  // ③ 其他（最常见「TA 家现在没有能偷的」）
  else {
    readyEligible = false
    stealableCount = 0
    cooldownUntil = now + 90
    if (prevExpectedUnlock <= now + 2)       // 窗口已经过了 → 推进下一波
      _advanceEntryToNextWave(decOwnerLeft: false)
  }
}
```

**①「`sentBeforeOrAtBoundary` 用发出时刻」的意义**：如果在解禁前 0.2 秒发出、解禁后才收到 409，那说明**服务器处理时还没解禁** —— 这是「我方时钟快了」的表现，不是「这个岛不能偷」。重试一次是对的。

如果是在解禁后 0.5 秒才发出还 409，那说明解禁时刻算错了，重试也没用。

**成功路径**（843-883）：

```js
if (outcome === 'lose') {
  lossCount++
  cooldownUntil = now + 5
  // 有战报快照 → 立刻用新战报重算信念（而不是等下一轮）
  if (body.battle && isle) return recordVisitSnapshot(...)
} else if (outcome === 'win') {
  lossCount = 0
  hasMoreWaves = _advanceEntryToNextWave(decOwnerLeft: true, completedUnlockAt: expectedUnlockAt)
  if (!hasMoreWaves) nextProbeAt = now + 300
} else {
  // 平局：岛上的东西还在，4 秒后再来
  cooldownUntil = now + 4
}
```

**平局 4 秒、输 5 秒**——这两个数不是拍脑袋的：平局意味着「还能偷，只是打平了」，所以要快；输意味着「可能要换装备」，所以多留 1 秒。

### 15.12 明确的「不做什么」：没有 2 连败封禁

```js
// 595-604
// Only mechanical game-rule caps (ownerLeft <= 0 or negative-ev-after-guard-sync) block a target;
// conditionally independent RNG battle losses NEVER trigger a 20-minute 2-loss ban!
let blockedUntil = (prev?.blockedUntil > nowSec && prev?.blockedReason !== 'two-loss-circuit-breaker')
  ? prev.blockedUntil : 0
```

**为什么拒绝「连输两次就封 20 分钟」**：

如果每场战斗是**条件独立**的（同样的装备、同样的对手，胜率固定），那「输了两次」不改变「第三次的胜率」。封禁只会让你错过两次正 EV 的机会。

**唯一会因输而变的是「信念」**——输了之后你知道了对方的战力区间更靠上，重算 EV 可能变成负的。那时自然会被 `profitable === false` 拦下，而不是靠一个人为的计数器。

**代码里还专门保留了 `two-loss-circuit-breaker` 这个字符串**，用来兼容旧存档：旧的被封记录会被忽略。

---

## 16. 擂台与战斗：装备、对手、技能槽

> 文件：`execution/pet-and-battle.mjs`（739 行）+ `execution/combat-engine.mjs`（1,383 行）
>
> 参考实现的战斗不是「打就完了」。它在**战前**做三件事：换装、模拟胜率、决定战术；在**战后**做两件事：更新档案、卖掉多余的箱子。

### 16.1 战斗模拟器：确定性、可注入随机

`combat-engine.mjs` 是一个**纯函数式**的战斗模拟器：

```js
simulateBattle(attackerState, defenderState, { seed, maxDuration = 60 })
```

**它不访问网络、不读文件、不依赖 `Math.random()`**。所有随机性都来自 `seed`。

**这带来三个能力**：

1. **同一种子可以复现**：线上打输了，本地用同一个种子能重放
2. **可以枚举**：给定配装，遍历 100 个种子算胜率分布
3. **可以离线搜索**：换装方案的最优性可以在本地算，不用真打

**战斗时间轴**：每 0.1 秒一个 tick，从技能槽 1 往后扫，找第一个冷却完毕且条件满足的技能释放。这是**优先级顺序**，不是固定循环。

### 16.2 战前：战术决策的输入

```js
// 决策输入
- 对方等级（owner.level）
- 对方守家面板（observedPanels，来自之前的战斗快照）
- 我方面板（gearData：攻击/防御/生命/速度）
- 档案库（profileStore：每场战斗的完整技能序列）
```

**守家战力后验**（`computeGuardPosteriorForTarget`）：

- 没有任何观测 → 用「同等级玩家的宽先验」
- 观测过 N 场 → 用这些场次的胜率区间
- 观测过且赢过 → 区间上移
- 观测过且输过 → 区间下移

**输出是一个区间 `[wLo, wHi]`，不是一个点**。这个区间直接进 15.2 的 `evLo/evHi`。

### 16.3 换装：`optimalLoadout` 与 `numGearChanges`

```js
{
  optimalLoadout: { head, body, weapon, ... },   // 目标配装
  numGearChanges: 3,                             // 需要换几件
  tacticalDecision: '...'                        // 战术选择（如"集火"/"保守"）
}
```

**`numGearChanges` 直接进 `computePhysicalPrepLeadSec`** —— 每换一件 1.25 秒，这决定了「提前多久出发」。

**换装不是免费的**：

- 每次 `/api/pet/battle/equip` 有独立冷却
- 换装期间的请求会占用 HTTP 配额（2.15 秒间隔）
- **如果只是为了打赢一个价值 200 D 的岛换 3 件装备（约 4 秒），那这 4 秒里别人可能已经偷完了**

所以 `numGearChanges` 也是 `evaluateMarginalRaidDelta` 的隐性成本（通过 `computePhysicalPrepLeadSec` 影响窗口判断）。

### 16.4 战后：档案更新 + 宝箱

```js
// recordBattleSnapshot(body.battle, 'guard', { storePath })
// 存：技能释放序列、每 tick 的血量、胜负
```

**为什么要存完整序列**：如果只用胜率，你无法发现「输在哪」。存了序列就能离线试「如果把技能 2 和技能 3 换个顺序，这场会不会赢」。

**宝箱**（`isDailyBattleChestReady`，272-283）：

```js
const opened = daily.chest ?? 0
const max    = daily.chestMax ?? 5
if (opened >= max) return false            // 今天开满了
if (daily.ready === true) return true      // 服务端直接说可以开
const need   = Math.max(1, daily.need ?? 3)
const earned = daily.earned ?? Math.min(max, Math.floor(daily.battles / need))
return earned > opened                      // 挣到的比开掉的多
```

**为什么不能只看 `chestMax − chest`**：那是「今天**总共**还能开几个」，而服务端是按**每 `need` 场**战斗发一个。如果今天打了 2 场、`need = 3`，`chestMax − chest` 显示还有 5 个，但实际一个都开不了。

**`daily.earned` 是新版字段**，老版本没有时退回 `floor(battles / need)`。

第 1 章的 Phase C 顺序里，**开宝箱排在「打之前」**——因为新装备可能改变战力，打完再开就浪费了这一批。

### 16.5 竞技场：`pickArenaOpponent` 就是「挑最弱的」

```js
export function pickArenaOpponent(opponentsList = [], excludeIds = null) {
  const candidates = opponentsList.filter(o => o?.id != null
    && !(o.left != null && !(Number(o.left) > 0))          // 还有剩余次数
    && !excludeIds?.has(Number(o.id)))                     // 今天没打过
  candidates.sort((a, b) =>
    (a.level - b.level) ||                                 // ① 等级最低
    (a.power - b.power) ||                                 // ② 战力最低
    (a.id - b.id))                                         // ③ id 最小（确定性）
  return candidates[0]
}
```

**没有任何经济计算**。理由很直接：**竞技场的奖励不随对手变强而变多**（至少参考实现这么假设）。所以「赢的概率最大化」就等于「挑最弱的」。

**`left > 0` 的过滤**：每个对手每天只能打有限次数，打完就得换人。

**`excludeIds`**：今天已经打过的，不再重复（否则会浪费次数在同一个对手身上）。

**`id` 作为 tie-break**：保证同样的输入产生同样的选择。这是整个代码库里反复出现的一个原则——**任何排序都必须有确定性的最终兜底键**。

### 16.6 幻彩：每天 10 D 的底仓

```js
export function planHuancaiFloor({ ... }) { ... }   // 587
```

**幻彩是一个「保底机制」**：花 10 D 参与，保留一个最低回报。**参考实现只在有正 EV 时参与**，并且把它当**每日固定动作**排进 Phase C 的固定位置。

**注意**：我们自己的程序里，`/api/huancai` 实测返回 410（功能已下线），所以这一块**不移植**（见 `changes-2026-11-14.md` 第 9 节）。

---

## 17. 站宠护理：为什么它值得做

> 文件：`execution/pet-and-battle.mjs:50-272`

### 17.1 核心洞察：站宠等级 = 擂台等级

这在规则里不是显式写明的，但实际效果是：**站宠等级决定了擂台战力，擂台战力决定了偷菜/守家的胜负**。

所以护理站宠不是「养成乐趣」，而是**偷菜的基建投入**。

### 17.2 四个纯函数

| 函数 | 作用 |
|---|---|
| `petLevelOfTotalXp(total)` | 总经验 → 等级（`floor(total / XP_PER_LEVEL) + 1`，余数即当前进度） |
| `localCstDayStr(sec)` | 北京时间日期（**用 UTC 方法 + 8 小时偏移**，避免本地时区干扰） |
| `applyPetDecay(state, now)` | 按小时线性衰减，**上限 72 小时** |
| `planPetCare(petState, now)` | 每日首见（+3 心情、+20 xp）→ 逐项补状态 + 玩耍 |

**`applyPetDecay` 的精确公式**（68-80）：

```js
const dtHours = Math.min(72, Math.max(0, (nowSec - prevTs) / 3600))
if (dtHours >= 0.02) {          // 小于 72 秒不结算，避免频繁写入
  hunger -= dtHours * 5        // 饥饿 -5/小时  → 20 小时见底
  mood   -= dtHours * 3.5      // 心情 -3.5/小时 → 28.5 小时见底
  clean  -= dtHours * 2.5      // 清洁 -2.5/小时 → 40 小时见底
  energy -= dtHours * 2        // 精力 -2/小时  → 50 小时见底
}
```

**三个数字的含义**：

- **72 小时上限**：离线 3 天后不再继续衰减。这不是「仁慈」，而是**防止数值变成天文数字的负数**（如果离线 30 天，`hunger` 会是 −3500，虽然 `clampStat` 会截断，但中间计算可能出问题）
- **`0.02` 小时（72 秒）的门槛**：如果程序每 30 秒轮询一次，每次只衰减 0.017 小时，写盘频率会非常高。≥72 秒才落一次盘
- **四个衰减率不同**：饥饿最快（20 小时见底），精力最慢（50 小时）。所以离线一晚后，**最紧急的是喂食**

**`planPetCare` 的动作选择**（100-190）——**不是按固定顺序喂→洗→玩，而是每一步重新判断「最缺什么」**：

```js
for (let step = 0; step < 25; step++) {
  const xpLeft     = dailyCap − 今天已得经验
  const needHunger = hunger < 92
  const needClean  = clean  < 92
  const needEnergy = energy < 90
  const needMood   = mood   < 95

  // ① 紧急阈值（低于 45/35 就是危急，立刻补）
  if      (hunger < 45) chosen = 'feed'
  else if (energy < 35) chosen = 'rest'
  else if (clean  < 45) chosen = 'clean'
  // ② 都在 92 以下时，补「数值最低的那一项」
  else if (needHunger && hunger <= min(clean, energy)) chosen = 'feed'
  else if (needClean  && clean  <= energy)             chosen = 'clean'
  else if (needEnergy)                                  chosen = 'rest'
  else if (needHunger)                                  chosen = 'feed'
  else if (needClean)                                   chosen = 'clean'
  // ③ 都不缺，但有心情空间或经验空间 → 玩
  else if ((needMood || xpLeft > 0) && energy >= 20 && hunger >= 20 && clean >= 15)
    chosen = 'play'

  if (!chosen) break
  执行 chosen，累加属性与 xp
}
```

**三层判据的意义**：

| 层 | 阈值 | 逻辑 |
|---|---|---|
| ① 紧急 | `hunger<45` / `energy<35` / `clean<45` | 再不管就掉状态了，不管经验有没有满都要做 |
| ② 补低 | `<92` | **补「当前最低的那一项」**，而不是固定顺序——这样四项会自然趋于均衡 |
| ③ 玩耍 | `mood<95` 或还有经验空间，且三项都 ≥ 20/20/15 | 玩耍是唯一「可能亏属性换心情/经验」的动作，所以要三项都有余量 |

**`step < 25` 的上限**：防止「补了又掉」的死循环（理论上不会，但这是个兜底）。

**每日经验上限 `dailyCap`**（`DEFAULT_DAILY_XP_CAP`）：每做一次动作都会检查 `xpLeft`，溢出就不再加。**这正是「收益会溢出，成本不会」的具体实现**。

### 17.3 时机：必须在读 gear 之前

```js
// 第 1 章 Phase C 的顺序：
宠物护理 → 战斗准备 → 竞技场 → 幻彩 → 修仙 → NPC → 邻居发现
```

**为什么护理必须最前**：护理会改变等级，等级改变面板，面板是 `gearData` 的一部分。如果先读 gear 再护理，那这一轮的所有战斗决策都用的是**旧等级**。

**这是一个典型的「因果顺序」约束**，不是偏好。

---

## 18. 52D 玩具摊：五子棋的离线求解

> 文件：`execution/npc-toy-stall.mjs`（574 行）

### 18.1 五子棋为什么要「求解」而不是「对弈」

```js
export function solveGomokuForSeed(R, seed, d = 3, N = R?.GOMOKU_N || 15) { ... }   // 316
```

**关键在 `seed`**：站点的五子棋是**给定种子**的，也就是说 AI 的走法是**确定性**的。

这意味着：**你可以在本地把这个种子下的整盘棋枚举出来，找到必胜路线，然后在线按谱走**。

**`d = 3` 是搜索深度**。为什么是 3 而不是更深：

- 深度每加 1，节点数 × 15²（合法落点）
- 深度 3 已经能覆盖「我走 → 对手走 → 我走」的完整战术组合
- **不需要找到全局最优**，只需要找到「在这个种子下不输」的一条线

### 18.2 三级策略：贪心 → 束搜索 → 兜底，全程用重放验证

**不是 minimax**。核心洞察是：**对手是确定性的**。`R.gomokuAI(b, seed, step, d, N)` 是站点规则模块的原样副本，给定棋盘、种子、步数、难度，它的走法是**唯一确定**的。

所以「走这一步之后会怎样」不需要估计——**直接问 oracle**。

```js
// evaluateMoveAgainstOracle（约 210-260 行）
function evaluateMoveAgainstOracle(R, board, N, seed, step, d, cand) {
  落子 cand
  if (我方五连) return { terminal: 'win' }
  if (棋盘满)   return { terminal: 'draw' }
  const [ax, ay] = R.gomokuAI(board.slice(), seed, step, d, N)   // ← 对手的确定应手
  落对方子
  if (对方五连) return { terminal: 'lose' }
  if (棋盘满)   return { terminal: 'draw' }
  return { boardAfter, score }                                    // 继续
}
```

**三级策略**（`solveGomokuForSeed`，316-360）：

```
第 1 级：贪心试走 × 4 个开局
  openings = [[中心], [中心左], [中心上], [左上]]
  for each opening:
    greedy = runGreedyPlaythrough(...)
    if (R.gomokuReplay(seed, greedy.mv, d, N) === 'win') return { mv, outcome: 'win' }
    if (第一次没赢且不是 bad) bestFallback = ...

第 2 级：束搜索 × 前 3 个开局
  runBeamSearchPlaythrough({ beamWidth: 5, branchK: 5, firstMove })
    - 每步用 rankCandidateMoves 排出前 5 个候选落点
    - 每个候选走 evaluateMoveAgainstOracle
    - nextBeam 按 score 排序，保留前 5
    - 遇到 terminal === 'win' 立刻返回
  if (verified === 'win') return
  if (verified === 'draw' && fallback 更差) bestFallback = ...

第 3 级：兜底
  if (bestFallback && replay !== 'bad') return bestFallback
  throw new Error(`failed to find valid non-bad replay`)
```

**三个关键设计**：

**① 每一步都「重放验证」而不是「相信搜索结果」**：

```js
const verified = R.gomokuReplay(seed, greedy.mv, d, N)
if (verified === 'win') return { mv: greedy.mv, outcome: 'win' }
```

`gomokuReplay` 是规则模块里的**完整回放函数**——它把整盘棋从头走一遍，返回 `'win' | 'draw' | 'lose' | 'bad'`。

**为什么必须验证**：搜索过程中用的 `evaluateMoveAgainstOracle` 只往前看**一步**（我走 → 对手走）。它给出的 `score` 是启发式。整盘下来可能被对手翻盘。**只有全盘重放才知道真实结果**。

**`'bad'` 是什么**：非法走法（落在已有子的位置、越界）。如果搜索产生 `bad`，说明模拟器有 bug，直接抛错——**不提交任何东西**。

**② 贪心优先于束搜索**：

```js
for (const openMove of openings) { 贪心 → 验证 }
for (const openMove of openings.slice(0,3)) { 束搜索 → 验证 }
```

**贪心比束搜索便宜得多**，而且在确定性对手下，贪心的成功率相当高（因为对手的应手可以直接问）。只有当 4 个开局都贪心失败时，才动用束搜索。

**③ 兜底也要「非 bad」**：

```js
if (bestFallback && R.gomokuReplay(seed, bestFallback.mv, d, N) !== 'bad') return bestFallback
throw new Error(...)
```

**宁可抛错也不提交非法棋谱**。抛错会被上层捕获并跳过这一局——这一局就算输了次数，但不会因为非法请求被封号。

**为什么只提交必胜棋谱**（调用方的策略）：如果返回的是 `draw` 或 `lose`，那不下比下更好——因为输了会掉次数。**「宁可放弃也不出错」**这条哲学在这里的具体体现。

> 我们自己的同类实现在 60 局实测里 57 胜（数据来自本项目 MEMORY，不是参考仓库的测量）。

### 18.3 唤醒时刻：`computeNextNpcWakeSec`（360）

```js
export function computeNextNpcWakeSec(adapter, world, nowSec, npcOptions = { enabled: true })
```

**它算的是「下一次有意义的 NPC 动作在几点」**：

- 玩具摊每日次数刷新时刻
- 当前对局的截止时刻
- 如果今天已经打完 → 明天 0 点

**为什么需要精确唤醒**：NPC 动作不消耗体力，但**占提交槽位**。如果每 5 分钟盲轮询一次，就会挤掉国内经营的提交。

---

## 19. 修仙 1.0：一个独立的资源闭环

> 文件：`execution/xian-cultivation.mjs:1089-1672`（`planXianActions`）+ `rules/xs-xian-rules.js`（348 行，站点 `xs-rules.js` 的逐字副本）

### 19.1 为什么修仙不能塞进主规划器

主岛经济的目标函数是「现金」。修仙是一个**完全不同维度的资源系统**：

```
药材 → 炼丹 → 丹药 → 灵力 + 农园经验 + 修为
                    ↓
                  灵根/功法 → 战力 → 秘境/斗法
```

**三处根本性的不同**：

| | 主岛 | 修仙 |
|---|---|---|
| 目标 | 最大化 6 岛日内的现金现值 | 最大化「长期成长速度」 |
| 资源 | 体力（可买、可吃回来） | 灵力（每日固定恢复，买不到） |
| 世界 | 连续变化，可精确预测价格 | 离散状态（层数、丹炉、地力） |

**灵力的「不可交易性」是决定性的**：主岛体力不够可以买咖啡，修仙灵力不够只能等第二天。所以修仙的优化问题不是「怎么花钱换资源」，而是「**在固定预算下怎么安排任务顺序**」。

### 19.2 灵力预算：每日约 325 点

主要消耗（`COST` 常量）：

| 动作 | 灵力 | 说明 |
|---|---|---|
| `harvest`（收药） | 2 | 每块地 |
| `plant`（种） | 1 | 每块地 |
| `water`（浇） | 1 | 每块地 |
| `brew`（起炉） | 5 | 一炉丹 |
| `hoe`（开荒） | 3 | 每块新地 |
| `sit`（打坐） | 0 | 但占时间 |
| `stipend` / `task` / `talk` | 0 | 宗门日常免费 |
| `use huiling`（吃回灵丹） | 净 +85 | 起炉 5 → 得 90 |

**回灵丹是全系统最重要的单品**：花 5 点灵力起炉、等 19 秒收丹得 3 颗、吃一颗回 30 点。净赚 85 点/炉。

**这就是为什么优先级 1b 是「紧急回灵丹」**（`xian-cultivation.mjs:1279-1296`）：

```js
// 1b. Urgent huiling cauldron BEFORE farm plots can drain sim.en below COST.brew = 5!
//     Spending 5 xs.en here returns +90 xs.en today (+85 net xs.en), preventing farm energy starvation.
```

**如果先收地（花 2 点/块）把灵力耗到 4 点以下，就起不了炉了**。而一炉丹能把灵力翻倍。所以**起炉必须抢在收地之前**。

### 19.3 完整优先级序列：17 个阶段，按「不可逆性」排序

`planXianActions` 主循环的核心是**「按顺序尝试，第一个成功的就 emit，然后重新从头扫」**：

```js
const emit = (act) => {
  if (actions.length >= maxActionsPerBatch) { truncatedByBatchCap = true; return false }
  const res = xsAct(sim, act, t, () => 0.99)     // ← 用确定性 rand 预演
  if (!res?.ok) return false
  actions.push(toWireXsAction(act))
  return true
}
```

**`() => 0.99` 的意义**：所有随机动作（炼丹出品品质、翻地掉落）在规划时都按「几乎成功」预演。这样计划的动作序列在**乐观情况**下是自洽的；执行时如果运气差，下一次规划会修正。

完整序列：

| # | 阶段 | 关键条件 | 为什么在这个位置 |
|---|---|---|---|
| 1 | 收丹 | 丹炉到点且没有成熟地等它的 `log` 步 | 收丹解锁「下一炉」，不占用 `log` |
| 1b | **紧急回灵丹** | 今日回灵丹没吃满 + 灵力够起炉 | 必须在任何耗灵力的农活之前 |
| 2 | 收成熟作物 | `g >= 3`，优先缺的丹方药材，然后价值最高 | 对齐到 `log % 4 === 3` 拿**双倍产量** |
| 3 | 吃培元丹（`lv < 5`） | 有库存 | 升级解锁更高级种子，**必须在种植之前** |
| 4 | 批量卖多余药材 | 纯现金药材，`n ≤ 99` | 让石头资本流动，买种子 |
| 5 | 浇正在生长的旱地 | `p.c && p.g < 3 && !p.w` | 停止生长的作物是纯损失 |
| 6 | 种植 + 浇水所有空地 | 保留成熟收割/紧急炼丹的灵力 | 空地不种就是浪费 |
| 7 | 每日回灵丹配额补足 | `>= 20:00` 或距午夜 `< 25 分钟` | 防跨日溢出 |
| 8 | 起炉 | `lv >= 5` 时培元丹受「空地完成 + 富余灵力」双重门控 | 培元丹在 lv5 后不给农园经验 |
| 9 | 开荒 | `lv < 4` 只在 `en >= 92` 时开 | lv4 前的草药生长太快，开荒会灵力饥荒 |
| 10 | 学功法 | 50 石/个，且**在灵根融合消耗基础灵根之前** | 融合会吃掉灵根，学不了对应功法 |
| 10b | 宗门/心境日常 | 0 灵力、每日 1 次 | 纯白送 |
| 10c | 社交章节/赠礼 | opt-in（`--xian-auto-social`） | 不可逆的关系选择 |
| 10d | 每日运势 | opt-in（`--xian-auto-events`） | 随机 |
| 10e | 秘境/斗法 | opt-in（`--xian-auto-realm` / `--xian-auto-duel`） | 见第 20 章 |
| 11 | 打坐/突破/融合 | 尾部 | 不消耗灵力，只占时间 |

**「对齐到 `log % 4 === 3`」是什么**（`alignLogForDoubleHarvest`，1150-1188）：

```js
let guard = 0
while (sim.log % 4 !== 3 && actions.length + 1 < maxActionsPerBatch && guard++ < 6) {
  // 优先用「严格产出」的动作把 log 推到 3 mod 4
  优先 equip → finish → use huiling → use peiyuan → sit/rise → stipend → task → talk → water
}
```

**`log` 是「农事进度计数器」**。收药时如果 `log % 4 === 3`，产量 ×2。所以**在收药之前，先把 `log` 推到对的位置**——而且只能用「本身就有产出」的动作去推，不能浪费。

**这是一个典型的「顺序价值」问题**：同样的动作，换个顺序，产量差一倍。

### 19.4 突破的决策：`smart` 模式为什么不急着升境界

```js
// shouldAllowBreakPolicy（323-345）
if (opts.breakMode === 'manual') return false
const r = Number(x.cv?.r || 0)
if (r >= REALMS.length - 1) return false         // 已是大圆满
if (opts.breakMode === 'eager') return true

// smart 模式：
if ((x.lv || 1) < 5) {
  if (r > 0) return false                         // 农园没到 5 级，不升第 2 个境界
  const grow = ROOT_GROW[rootCount] || 1
  return Boolean(opts.autoFuse) || grow > 1       // 只有这两种情况才升炼气→筑基
}
return true
```

**`smart` 的核心判断**：**农园等级 5 比修为境界更重要**。

理由：

1. 培元丹每颗给 +40 农园经验，但 `lv >= 5` 之后就不给了
2. 农园 lv5 解锁「雷竹」（高价值药材）
3. 突破时**修为清零**（`c.s = 1; c.xp = 0`），之前攒的全白费
4. 境界提升带来的收益（更高功法、更高灵力上限）**不如农园 lv5 的收益**

**但有两个例外**：

- 开了 `autoFuse`：需要先到筑基才能融合灵根
- 灵根数 4 或 5（`ROOT_GROW > 1`）：境界提升会提高灵根倍率，收益更大

**这是一个「跨系统优先级」的显式编码**——不是"哪个数字大就做哪个"，而是"先解锁哪个系统"。

### 19.5 灵根融合：`selectOptimalFusionPair`

```js
// 250-290
for (每个灵根对 (i, j)) {
  const f = FUSIONS[fuseKey(base[i], base[j])]
  if (!f) continue
  const rest = 除 i,j 外的灵根
  const totalReachableFusions = 1 + maxPentagonMatchingCount(rest)   // ← 关键
  const rank = VARIANT_TECH_PRIORITY.indexOf(f.id)
  candidates.push({ totalReachableFusions, priorityRank: rank })
}

sort by:
  1. totalReachableFusions 降序          ← 先保证「还能继续融合多少次」
  2. priorityRank 升序                    ← 变异功法的偏好
  3. key 字典序                           ← 确定性 tie-break
```

**`maxPentagonMatchingCount(rest)`**：融合用的是「五边形」图结构，剩余灵根还能做多少次**不相交的**配对。

**排序键 1 的意义**：融合是**不可逆**的（两个基础灵根变一个变异灵根）。先融哪一对，决定了后面还能融多少次。所以第一优先级是「**保留最大的后续融合空间**」，而不是「这一次融合的强度」。

**注意 `xsFuse` 默认关闭**（`--xian-auto-fuse` 默认 OFF），注释写得很明白：

> root fusion is permanent

### 19.6 明确禁止的五个动作

```js
export const FORBIDDEN_XIAN_ACTIONS = new Set([
  'xsRoot',   // 初始灵根选择（st < 4）
  'xsStory',  // 序章剧情
  'xsFight',  // 弹幕关卡
  'xsWin',
  'xsLose',
])
export function assertSafeXianBatch(actions, world, rawOptions) { ... }   // 每次提交前检查
```

**为什么禁止这些**：

- `xsRoot` / `xsStory`：**不可逆**。一旦选错，整个账号的成长路线就定了
- `xsFight` / `xsWin` / `xsLose`：客户端弹幕小游戏。注释直接写「inferior stone/en to Lv2+ farming」——**打弹幕赚的石头和灵力，还不如种地**

**`assertSafeXianBatch` 是一个运行时断言，不是注释**。它在每次提交前检查动作列表，命中就抛错。这是「宁可崩溃也不做错事」的硬门控。

### 19.7 唤醒时刻：`computeNextXianWakeSec`

```js
export function computeNextXianWakeSec(world, nowSec, rawOptions) { ... }   // 1672-1790
```

收集所有「下一件有意义的事」的时刻，取最近的：

```js
const medCapAt = Number(sim.med?.t || t) + MED_MAX + 1     // 打坐结束
if (secNeeded < MED_MAX) ...                                // 今天还能再打一次
const nextEvAt = evLast + EV_GAP + 1                        // 运势冷却
const brewAt = brew.t + BREW_READY_SEC                      // 丹炉到点
const plotAt = 最近成熟地块
const dailyAt = 次日 0 点（宗门/委托/回灵丹刷新）
```

**为什么用精确唤醒而不是固定轮询**：修仙动作每批最多 30 个（`MAX_XS_BATCH`），一次提交能做完一批。做完就该等，硬轮询只会浪费 HTTP 配额。

---

## 20. 修仙 2.0：秘境是一个带血量约束的图搜索

> 文件：`execution/xian-cultivation.mjs:845-1089`（`buildCandidateSlotSets` + `solveRealmBeam`）+ `1543-1600`（`tryEmitAutoRealm`）

### 20.1 为什么秘境不能贪心

秘境是一个**分层 DAG**：

```
层 L=0: 起点
层 L=1..2: 若干节点（战斗 / 商店 / 宝箱 / 事件）
层 L=3: 终点
```

每次前进消耗血量，战斗失败直接出局。**每次选择都影响后续**：

- 走战斗节点 → 掉血，可能撑不到终点
- 走商店节点 → 花石头买药（回血），但石头是奖励的一部分
- 走宝箱节点 → 拿材料/丹药，但不回血

**贪心「走最赚的」会死在半路**。所以用**束搜索**。

### 20.2 状态与转移

```js
const remainingSteps = (2 - startZ.L) * 4 + (3 - startZ.R)
let beam = [{ state: clone(simWithRlm), path: [], spentStone: 0, lootScore: 0 }]

for (let step = 0; step < remainingSteps && beam.length > 0; step++) {
  for (const entry of beam) {
    // 变体 1：如果当前节点是商店、且 hp < 80%、且石头 ≥ 药价+40 → 先买药
    // 变体 2：不买药，直接走
    for (const v of variants) {
      for (const node of rlmNext(map, v.state.rlm)) {
        模拟 rgo(node)
        if (end === 'win') 收进 completed
        if (end === 'lose') 丢弃
        else 计算评分，加入 expanded
      }
    }
  }
  // 按 (L, R, c, spentStone) 去重，保留每格最高分
  // 排序取前 REALM_BEAM_WIDTH = 14
}
```

**「变体：先买药」的条件**（878-886）：

```js
if (curNode?.k === 'shop' && !boughtKey.includes(...) && z.hp < z.mx * 0.8 && stone >= SHOP[0].st + 40) {
  // 花 SHOP[0].st 买，保留 40 石头余量
}
```

**`hp < 80%` 才买**：满血买药是浪费。**`+40` 余量**：后面的节点可能还要花钱。

### 20.3 评分函数：血量、战利品、花费石头

```js
// 中间节点
const lootScore = stone * 0.5 + pillCnt * 40 + matCnt * 12 + herbCnt * 8
const hpFrac = ns.rlm.hp / ns.rlm.mx
const score = hpFrac * 1000 + lootScore - spentStone * 4

// 通关
const score = (res.hp?.[0] ?? ns.cv?.xp ?? 0) + 10000 - spentStone * 4
```

**权重的含义**：

| 项 | 权重 | 解读 |
|---|---|---|
| 血量比例 | × 1000 | **1000 分 = 满血**。血量是第一优先级 |
| 丹药 | × 40 | 丹药最值钱（能直接吃） |
| 材料 | × 12 | 材料次之（能合成） |
| 草药 | × 8 | 草药最次（能种） |
| 石头 | × 0.5 | 石头**最不值钱**——因为种地能赚 |
| 花费石头 | × 4 | **花出去的石头按 8 倍计代价**（−4 vs 收入 0.5） |
| 通关奖励 | +10000 | 通关本身压倒一切 |

**「花 1 石头 = 少 4 分，赚 1 石头 = 多 0.5 分」**：这是一个**极度厌恶花钱**的设定。买一瓶药（假设 50 石头）要 −200 分，相当于 5 颗丹药。**只有在能救命（多打几个节点）时才值得**。

### 20.4 只认「完整通关」

```js
if (completed.length === 0) return null      // 没通关 → 不提交任何动作
completed.sort((a, b) => b.score - a.score)
return completed[0]
```

**部分通关的收益是零**——因为秘境奖励只在通关时结算。所以搜索的终止条件是「到达终点」，中途的 `lootScore` 只是**剪枝的启发式**，不是目标。

**这与我们自己的实现一致**（`changes-2026-11-14.md` 5.2 节「秘境只认完整通关」）。

### 20.5 配招：先试当前，不行再换

`tryEmitAutoRealm`（1010-1050）：

```js
if (sim.rlm) {
  const slotSets = buildCandidateSlotSets(sim)      // 最多 14 套
  const curSlots = mySlots(sim)
  for (const slots of slotSets) {
    const needSlots = !sameSlotSet(slots, curSlots)
    if (needSlots && actions.length + 2 > maxActionsPerBatch) continue

    const probe = clone(sim)
    if (needSlots && !xsAct(probe, { a: 'slots', herb: slots.join(',') })?.ok) continue
    const sol = solveRealmBeam(probe, nowSec)
    if (!sol) continue                                 // 这套打不通

    if (needSlots && !emit({ a: 'slots', ... })) return
    for (const act of sol.path) emit(act)
    return
  }
}
```

**`buildCandidateSlotSets` 的 12 个模板**（849-897）：

```js
const templates = [
  [own1, 'wood2', 'water2', 'thunder2'],       // 本命 + 木/水/雷
  [own1, 'wood2', 'wind2', 'water2'],
  [top1, 'wood2', 'thunder2', 'wind2'],        // 最强单体 + 木/雷/风
  [top1, 'water2', 'earth2', 'wood2'],
  [top1, 'water2', 'guard', ccOrFast[0]],
  [top1, ccOrFast[0], ccOrFast[1], 'water2'],
  [top1, alt1, 'water2', 'wood2'],
  [top1, alt1, 'thunder2', 'wind2'],
  [top1, 'poison2', 'wood2', 'water2'],
  [top1, 'metal2', 'wind2', 'bolt'],
  [own1, `${x.tech}2`, 'water2', 'guard'],
  [own1, `${x.tech}2`, 'bolt', 'guard'],
]
```

**这是一个「人工经验 + 自动验证」的组合**：

- 模板是**人挑的**（水2 几乎出现在所有模板里——因为它大概率是治疗/护盾）
- 每套模板都要**跑一次完整的束搜索**验证能不能通关
- 第一套能通的就执行，**不再找更好的**

**为什么「第一套能通就停」**：换配招要占一个动作位（`slots`），而且束搜索本身要时间。如果当前配招能通关，换配招的边际收益只是「多剩点血」——不值。

**`nuke1Order`（优先级）**：

```js
['wind1', 'thunder1', 'metal1', 'ice1', 'poison1', 'lava1', 'fire1', 'water1', 'wood1', 'earth1']
```

**风1 最强**（可能因为是高速），土1 最弱。这是从**战斗模拟器的数值反推出来的排序**，不是规则的显式属性。

### 20.6 斗法：确定性判断

```js
if (!opts.autoDuel) ...
// deterministc duels：用战斗模拟器（combat-engine）算胜率，
// 只在胜率足够高时打
```

**与偷菜守家的区别**：偷菜的守家战是**真打**（有随机性，可能输）；修仙斗法是**本地可精确模拟**的（同样的配招、同样的对手，结果确定或有精确分布）。

所以斗法的决策更简单：**能赢就打，不能赢就不打**。不需要区间估计。

**注意 `MAX_XS_BATCH = 30`**：一批最多 30 个修仙动作。打满 8 场斗法 + 3 次秘境 + 农活，很容易超。超出就 `truncatedByBatchCap = true`，下一轮继续。

### 20.7 1.0 和 2.0 怎么协调

**它们在同一个函数里，同一个 `sim` 状态上顺序执行**：

```
planXianActions:
  ...
  10e. tryEmitAutoRealm（2.0 秘境）+ tryEmitAutoDuel（2.0 斗法）
  ...
  11. 打坐/突破/融合
```

**2.0 排在 10e**：在农活、炼丹、宗门日常**之后**，在打坐**之前**。

**为什么在打坐之前**：打坐只是「把时间换成修为」，随时可以做。秘境和斗法有**每日次数限制**，不做就浪费了。

**为什么在农活之后**：秘境消耗的是**血量**（不是灵力），不影响农活。但如果先打秘境而血量掉了，可能影响后续……实际上秘境是独立的状态（`rlm`），不影响主状态。所以顺序上放在农活之后主要是**为了让农活先占满灵力**。

---

## 21. 每日目标：一个被单独拎出来的动作类型

> 文件：`planner/solve.mjs:45-65`（`collectClaimableGoalActions`）

### 21.1 为什么 `goal` 是一个独立动作

站点的「每日目标」是**在某个时间点可以领取的奖励**。参考实现把它建模成一个 `goal` 动作：

```js
export function collectClaimableGoalActions(R, state, nowSec) {
  const out = []
  for (const g of R.WORLD?.dailyGoals || []) {
    if (!R.goalClaimable?.(state, g, nowSec)) continue
    out.push({ a: 'goal', id: g.id })
  }
  return out
}
```

**它有三个特殊性**：

1. **零成本**：不消耗体力、不花现金
2. **零风险**：领了就有，不影响任何状态
3. **有截止时刻**：过了当天就没了

**所以它永远应该做——如果它出现在允许集里**。

### 21.2 在规划里的位置

`goal` 动作被放进**探针预扫描的 `urgentTasks`**（第 7.3 节），但没有任何经济评分：

```js
// 只要可领，就排在最前面
if (R.goalClaimable(state, g, nowSec)) urgentTasks.push({ kind: 'goal', id: g.id, priority: Infinity })
```

**`priority: Infinity`**：这是整个求解器里**唯一一个用 `Infinity` 的地方**。因为「领奖励」在任何情况下都不该被推迟。

**这不是偷懒，是正确性**：如果给 `goal` 也算一个「机会成本」，那在某些极端情况下（体力极少、现金极紧）可能会算出「先不领」——而这是**严格错误**的，因为领取不消耗任何资源。

---

## 22. 执行层：限流、重试、对账

> 文件：`execution/http-client.mjs`（438 行）+ `execution/reconcile.mjs`（742 行）

### 22.1 限流：三层

```js
// http-client.mjs
const GLOBAL_MIN_GAP_MS = 2150          // 全局：任何两个请求之间至少 2.15 秒
const bucketCooldowns = new Map()       // 每个 (method, path) 独立冷却
```

| 层 | 规则 | 目的 |
|---|---|---|
| **全局间隔** | 2.15 秒 | 避免触发站点的通用限流 |
| **端点冷却** | `${method} ${path}` 独立 | 有些端点有自己更严的限制（如 equip） |
| **429 退避** | 按 `Retry-After` 或指数退避 | 服务端说慢就慢 |

**`getRemainingBucketCooldownMs(method, path)`** 被 `computePhysicalPrepLeadSec` 用来算「还要等多久」——这让**出发时刻的计算包含了真实的冷却状态**。

**为什么是 2.15 秒**：这是实测出来的。`changes-2026-11-14.md` 第 9 节记录了「HTTP 分桶限流（擂台 1.2 秒）不移植，统一 2.15 秒最安全」——参考实现里有 `classifyBucket` 的分桶限流，但站点真实限制未验证。

### 22.2 重试：只对「服务端去重的写接口」

```js
// 参考实现的策略
const RETRYABLE = new Set([
  'POST /api/pet/world/act',     // ← 服务端按 (rev, action) 去重
  'POST /api/pet/battle/equip',
])
```

**只重试「重试了也不会执行两次」的接口**。这是幂等性分析：

- `world/act`：每次带 `rev`，同一个 `rev` 的相同动作服务端只执行一次
- `visit`：**不重试**，因为不知道上一次是否已经打了
- `sell`：**不重试**，因为可能已经卖了

**这与我们自己的实现一致**（`bbe0735`「重试边界收紧到服务端去重的写接口」）。

### 22.3 对账：`reconcile.mjs` 的三种状态

```js
// 一次写操作有三种结果
confirmed       // 服务端明确返回成功
rejected        // 服务端明确返回失败
unknown         // 超时 / 断线 / 5xx —— 不知道发生了什么
```

**`unknown` 是最危险的**：你可能已经卖了 500 个苹果，也可能一个都没卖。

**参考实现的处理**（`reconcileUnknownWithFreshWorld`）：

```js
1. 拉一次新世界（GET /world）
2. 对比「预期的状态变化」和「实际的状态变化」
3. 推断出这次操作是成功还是失败
4. 如果是偷菜的 visit：调用 recordReconciledVisit 更新状态机
```

**为什么不用「事务日志 + 逐条核对」**：`changes-2026-11-14.md` 第 9 节评估过 742 行的 `reconcile.mjs`，结论是「架构级改动；每轮 refresh + 非幂等不重试已覆盖主要后果」，不移植。

### 22.4 时钟同步

```js
// http-client.mjs
syncClock(clockStart)     // 从服务端响应头 / 响应体里的 now 校准
```

**时钟精度直接决定偷菜成败**：如果本地时钟比服务器快 2 秒，你会提前 2 秒出发，吃 409。

参考实现用了**区间校准**（服务端时钟的上下界），而不是单点估计。这与我们自己的 `178c8b0` 改动一致。

### 22.5 分桶限流为什么被放弃

```js
// 参考实现有：
function classifyBucket(method, path) {
  if (path.includes('/battle')) return 'battle'    // 1.2 秒
  if (path.includes('/visit')) return 'visit'
  return 'default'
}
```

**我们实测发现**：站点的限流不是按路径分桶的，而是一个统一的令牌桶。所以参考实现的分桶限流**在真实站点上并不成立**——按 1.2 秒打 `/battle` 反而可能触发全局限流。

**统一 2.15 秒是更保守、更安全的选择**。

---

## 23. 审计：三层验证，让「计划」可以被证明

> 文件：`audit/replay.mjs`（534 行）+ `audit/reference-solver.mjs`（1,799 行）+ `audit/report.mjs`（352 行）+ `audit/journal.mjs`（365 行）

### 23.1 审计要回答的三个问题

| 问题 | 工具 |
|---|---|
| 「这个计划如果重放一遍，结果一样吗？」 | `replay.mjs` |
| 「这个计划是最优的吗？差多少？」 | `reference-solver.mjs` + `bounds.mjs` |
| 「为什么这个计划这么做？」 | `report.mjs` + `journal.mjs` |

### 23.2 `journal.mjs`：事件溯源

```js
// 每个动作执行后记录
{
  seq: 12345,                    // 全局序号
  at: 1700000000,                // 时刻
  kind: 'act',                   // act / visit / equip / ...
  request: { ... },              // 发出的内容
  response: { ... },             // 收到的内容
  worldRevBefore: 1234,
  worldRevAfter: 1235,
}
```

**它是不可变的追加日志**。任何一次执行都可以被精确重放。

**已知缺陷**（子代理发现）：

- `firstSeq` / `lastSeq` 字段在 `_applyParsedEventToIndex` 中**从未写入**
- 但 `report.mjs:258-266` 依赖它统计「某个物品的售卖区间」

**结果**：报告里「物品售卖区间」这一项永远是空的。

### 23.3 `replay.mjs`：确定性重放

```js
replayJournal(journalPath, { adapter, rulesVersion }) {
  // 逐条重放，用记录里的 response 而不是重新请求
  // 对比「重放后的世界」和「记录里的 worldRevAfter」
}
```

**它的价值**：如果重放结果不一致，说明**规则模块变了**或者**模拟器有 bug**。这是「规划与执行用同一套模拟器」这条设计的**验证手段**。

### 23.4 `reference-solver.mjs`：独立的第二意见

**1,799 行**，它是一个**完全独立的求解器**：

- 不复用 `solve.mjs` 的任何代码
- 用最朴素的穷举/DP
- **只在小规模问题上跑**（比如 3 个物品、2 个时间段）

**用途**：定期用它对拍 `solve.mjs` 的结果。如果两者不一致，说明 `solve.mjs` 有 bug。

**这是软件工程里的「差分测试」**——用一个慢但正确（简单到容易验证）的实现，去检验一个快但复杂的实现。

### 23.5 `report.mjs`：人读的报告

```js
generateReport(journalPath, { format: 'markdown' })
```

输出：

- 时间线（每个时刻做了什么）
- 收支明细
- 效率指标（每点体力赚多少）
- **异常标记**（负收益、超时、重试）

**「异常的定价」**：报告不只是流水账，它会把「这次卖出比计划少赚了 15%」标出来。

### 23.6 审计为什么没被移植

`changes-2026-11-14.md` 第 9 节的结论：

| 项 | 行数 | 不移植原因 |
|---|---|---|
| `audit/*` 全部 | 3,050 | 「我们没有『对外证明最优』的义务」 |

**这是对取舍的诚实**：审计是为了「向别人证明我的计划是对的」。单人自用的托管脚本没有这个需求。

但**其中有两个东西值得借鉴**：

1. **journal 的事件溯源**：我们有自己的 `logs/`，但没有结构化的事件日志
2. **`replay` 的对拍**：我们有 selftest，但没有「用真实历史数据重放验证」

---

## 24. 参数总表、负面清单、误差登记

### 24.1 全部关键常量（按功能域）

**目标与时间**

| 参数 | 值 | 位置 | 作用 |
|---|---|---|---|
| `horizonSec` | `6 × 14400` | `objective.mjs` | 主优化视野 = 6 岛日 |
| `extendedHorizonDeltaSec` | `2 × 14400` | 同上 | 视野不稳定时延长 2 岛日 |
| `continuationIsleDays` | `12` | 同上 | 期末尾段的继续经营视野 |
| `discountRatePerHour` | `0` | 同上 | 默认不折现（6 天内折现影响极小） |
| `conservativeSupplyFactor` | `0.8` | `observations.mjs` | 外部供给按保守的 80% 算 |
| `maxLiquidationBatches` | `8` | `objective.mjs` | 期末清算最多 8 批 |
| `terminalSupplyMode` | `'conservative-floor'` | 同上 | 期末供给取下界 |

**桶与批**

| 参数 | 值 | 位置 | 作用 |
|---|---|---|---|
| `maxBuckets` | 12 | `createUnifiedRaidEvaluator` | 快速评估器的桶上限 |
| `maxSingleBatch` | `R.WORLD.maxActions`（40） | `solve.mjs:4066` | 单批动作上限 |
| `minGapBucket` | `R.WORLD.minGap`（2 秒） | 同上 | 同批动作最小间隔 |
| `maxBucketActions` | `min(400, batches × 40)` | 同上 | 单桶动作上限 |

**体力与食物**

| 参数 | 值 | 位置 | 作用 |
|---|---|---|---|
| `mandatoryDeficit` 罚项 | `450 / EN` | `solve.mjs:5707` | 补不上体力时的硬罚 |
| 咖啡 | 15000 D / 60 EN → 250 cpe | `R.WORLD.coffee` | 每日上限 3 杯 |
| 自然回复 | 每 180 秒 1 点 | `R.WORLD.regen` | 影响偷菜体力预留 |
| `cashUnit` 上限 | 500 格 | `solve.mjs:4695` | 二维 DP 的现金维度压缩 |

**卖货**

| 参数 | 值 | 位置 | 作用 |
|---|---|---|---|
| 一阶阶梯容量 | 150 / 自然日 | `R.WORLD` | 每个作物 |
| 二阶阶梯容量 | 400 / 自然日 | 同上 | 累计 |
| 阶梯倍率 | `[1.0, 0.85, 0.70]` | 同上 | |
| 累进税 | 按**钱包余额**：300 万内 0%，300-1000 万 1%，1000 万以上 3% | `R.b12TaxSale`（`pet-world-rules.js:1638-1651`） | 是余额税不是交易税；计划用 1 万单近似 |
| `approxTaxFactor` 下限 | 0.05 | `solve.mjs:1694` | 防止除零 |

**加工**

| 参数 | 值 | 位置 | 作用 |
|---|---|---|---|
| 精确 DFS 阈值 | `C(M+d, d) ≤ 600` | `solve.mjs:994` | 组合数上限 |
| DFS 节点上限 | 600 | `solve.mjs:1003` | 超了转贪心 |
| 贪心分块 | `32→16 / 8→4 / 其他→1` | `solve.mjs:1102` | |
| 单动作 `n` 上限 | 20 | `mergeCraftActionsPreserveTopo` | 服务端限制 |
| 工坊槽维度上限 | 24 | `solve.mjs:3307` | 三维 DP 剪枝 |

**偷菜**

| 参数 | 值 | 位置 | 作用 |
|---|---|---|---|
| `maxWavesForOwner` | `min(3, ownerLeft)` | `snipe-scheduler.mjs:502` | 单岛最多 3 波 |
| 波次间隔 | ≥ 15 秒 | 同上 `:517` | |
| `overdue` 退避 | `[5, 20, 60, 300]` | 同上 `:364` | |
| 冷却（普通失败） | 90 秒 | 同上 `:817` | |
| 冷却（平局） | 4 秒 | 同上 `:882` | |
| 冷却（输） | 5 秒 | 同上 `:848` | |
| 边界重试窗口 | `\|now − unlock\| ≤ 2` 秒 | 同上 `:807` | 只重试一次 |
| 打包上限 | `min(remStealBudget, N, 3)` | `solve.mjs:10640` | |
| 分支剪枝 | 保留前 4，概率重归一化 | `solve.mjs:10747` | |
| 体力预留成本上限 | 15 EN | 同上 `:1057` | |
| 优先级抢占窗口 | `max(12, prepLead + 4)` 秒 | 同上 `:1034` | |

**修仙**

| 参数 | 值 | 位置 | 作用 |
|---|---|---|---|
| `MAX_XS_BATCH` | 30 | `xian-cultivation.mjs:78` | 单批动作上限 |
| `BREW_READY_SEC` | `max(BREW_MIN+4, 19)` | 同上 `:80` | 炼丹成熟时间 |
| `REALM_BEAM_WIDTH` | 14 | 同上 `:117` | 秘境束宽 |
| 秘境商店买药阈值 | `hp < 80% && stone ≥ 药价+40` | 同上 `:881-884` | |
| 秘境评分 | `hpFrac×1000 + loot − stone×4` | 同上 `:950` | |
| 通关奖励 | +10000 | 同上 `:945` | |
| 打坐上限 | `MED_MAX` | `xs-xian-rules.js` | |
| 运势间隔 | `EV_GAP`，每日 `EV_DAILY` 次 | 同上 | |
| 突破策略 | `smart` / `eager` / `manual` | 同上 `:75` | 默认 smart |

**战斗与执行**

| 参数 | 值 | 位置 | 作用 |
|---|---|---|---|
| 全局请求间隔 | 2150 ms | `http-client.mjs` | 实测安全值 |
| 单次装备切换 | `max(1.25, rtt + 0.35)` 秒 | `computePhysicalPrepLeadSec` | |
| 五子棋搜索深度 | `d = 3` | `npc-toy-stall.mjs:316` | |
| 站宠衰减上限 | 72 小时 | `applyPetDecay` | 离线惩罚封顶；四个属性 -5/-3.5/-2.5/-2 每小时 |

### 24.2 负面清单：参考实现**明确不做**的

这一节比正面清单更重要——它划出了「一个成熟托管程序认为不值得做」的边界。

| 不做什么 | 位置 | 理由（代码注释原文/推断） |
|---|---|---|
| **帮忙（help）** | 全仓库无对应模块 | 收益低于机会成本（一次帮忙约 2-3 D，占一个动作位） |
| **独立守家** | 只有 `combat-engine`，无「设置守家阵容」动作 | 守家是被动的，只在被偷时起作用；参考实现选择接受罚款 |
| **弹幕关卡 `xsFight`** | `FORBIDDEN_XIAN_ACTIONS` | 「inferior stone/en to Lv2+ farming」——打弹幕不如种地 |
| **自动管家** | 无 | 抽成机制让净收益为负（详见 `SITE-MODULES.md` 第 23 章） |
| **自动玩具摊之外的 NPC** | 只有五子棋求解 | 其他 NPC 交互收益不明确 |
| **每日目标的经济建模** | `priority: Infinity` | 免费的东西不需要算 |
| **跨进程单实例锁** | 无（单进程模型） | 参考实现是单实例 CLI |
| **规则热更新** | 有 `update-notifier.mjs`（348 行）但只检查版本 | 版本变化时提示用户重启，不热替换 |
| **事务日志 + 未知结果核对** | `reconcile.mjs` 有，但是「拉新世界推断」而非全量日志 | 复杂度换不来相应收益 |

**「帮忙不做」这一条尤其值得注意**：我们的程序里是有帮忙模块的（`core/engine.mjs` 里有 `r.helped`）。如果参考实现的判断是对的，那帮忙就是在浪费提交槽位。

**验证方法**：查我们的日志，统计「帮忙」动作的日均收益。如果低于「同样时间做别的」，就该关掉。

### 24.3 误差登记：所有已知的近似

**这一节是全文最有价值的部分之一**——它把「这个求解器在哪些地方不精确」一次列清楚。

| # | 近似 | 位置 | 方向 | 量级 |
|---|---|---|---|---|
| 1 | 税率用「1 万单」线性近似 | `solve.mjs:1693` | 高估收入 | 大额卖出时 1-3% |
| 2 | 自身销量不反馈到未来价格 | `soldTracker` 只用初始已知 | 高估收入 | 取决于卖量 |
| 3 | 加工模板只展开一层 | `buildCanonicalCraftTemplates:588` | 低估能力 | 深层配方用不上 |
| 4 | 浇水加速不计入成熟时间 | `rules-adapter.mjs:615` | 低估收益 | 最多 25% 时间 |
| 5 | 动物期末价值不投射 | `objective.mjs` | 低估资产 | 「快产出的动物」被低估 |
| 6 | 随机产量用期望而非分布 | `resources.mjs` | 中性（但方差未定价） | |
| 7 | 上界对含随机动作拒绝给出 | `bounds.mjs:34` | 诚实 | |
| 8 | `simulateValidBatch` 过滤后随机数错位 | `solve.mjs:6979` | 未知 | 低频 |
| 9 | `deductFromPrefixSupply` 与 `emitOptimalBucketSells` 扣料方向不一致 | `solve.mjs:693` vs `:6884` | 未知 | 极端情况 |
| 10 | `jointEnAfterPre = max(enAfterPre, craftCap×craftEn)` | `solve.mjs` | 高估体力 | 加工配额可能排满 |
| 11 | 跨季作物的 `rNextSeason` 是二次估算 | `solve.mjs:1331` | 未知 | 跨季时 |
| 12 | 免费种子不按期权定价 | `solve.mjs:1305` | 低估 | 种子涨价时 |
| 13 | 修仙卖药不读实时价格 | `xian-cultivation.mjs:494` | 未知 | 静态 `HERBS.sell` |
| 14 | 修仙 `plotView` 未传 `tech` | `xian-cultivation.mjs:528` | 低估木系 | 0.8 生长系数未生效 |
| 15 | `partnerSoldByIsle` 声明未使用 | `solve.mjs:1553` | — | 死代码 |
| 16 | journal 的 `firstSeq/lastSeq` 从未写入 | `audit/journal.mjs` | — | 报告缺一项 |

**关于「方向」这一列**：如果近似是**单向**的（总是高估或总是低估），那可以用一个校准系数修正。如果是**双向**的（取决于具体情况），就只能在执行时用实测数据纠正——参考实现选择了后者（每轮 refresh 后重算）。

### 24.4 两个隐藏的架构级问题

**问题 1：规划层和执行层的时间尺度不匹配**

规划算的是「6 个岛日内怎么安排」，执行是「现在发哪个包」。中间的 `compile-prefix` 试图桥接，但它**只能处理「漂移 < maxClockDriftSec」的情况**。

超过之后就是 `plan-invalid`，整份计划作废，重新规划。**这意味着：一次耗时 8 秒的求解，如果 3 秒后世界变了，可能白算。**

`changes-2026-11-14.md` 里的 `marginalContext` 冻结基线就是一个缓解——但它只对「非 farm 变化」（修仙、玩具摊）免疫。

**问题 2：`marginalContext` 的失效检查用 `sourceFarmDigest` 而不是 `rev`**

```js
// solve.mjs:6938-6962
if (marginalCtx.sourceFarmDigest !== computeStaticFarmStateDigest(world)) → 失效
```

**为什么不用 `rev`**：`rev` 会因为修仙/玩具摊的任何写入而变化，而那些变化**不影响岛内经营**。用 `digest` 只跟踪「地块、畜栏、库存、现金、体力」这些真正相关的东西。

**但 `digest` 是「静态农场状态」的哈希**：它包含了已经在生长但还没成熟的地块。这意味着**任何一次「生长了一个 tick」都会让 digest 变化**——除非 digest 只算「静态属性」（作物类型、种植时刻），不算「当前生长进度」。

如果它算的是生长进度，那 `marginalContext` 几乎每轮都会失效，缓存形同虚设。**这一块需要实测确认**。

### 24.5 与我们程序的对照：值得移植的排序

基于以上全部分析，按「投入产出比」排序：

| 优先级 | 项 | 参考位置 | 我们的现状 | 理由 |
|---|---|---|---|---|
| **P0** | 偷菜分支信念树 | `packRaidsOnMarginalContext` | 我们按单目标贪心 | 多目标打包能显著提高一次出门的产出 |
| **P0** | `evaluateMarginalRaidDelta` 的「只重算被触及部分」 | `solve.mjs:10209` | 我们直接查表估值 | 查表会高估偷菜收益 |
| **P1** | 修仙秘境配招搜索 | `buildCandidateSlotSets` | 我们 12 套（已实现） | 参考是 14 套，差异极小 |
| **P1** | `smart` 突破策略 | `shouldAllowBreakPolicy` | 我们按境界自动突破 | 农园 lv5 优先这条值得借鉴 |
| **P1** | 多波次偷菜 | `_advanceEntryToNextWave` | 已移植（`1c8bdf5`） | — |
| **P2** | 加工二分法拆包 | `solve.mjs:3413` | 我们是一维 | 只在「买 5 个、3 吃 2 卖」时有用 |
| **P2** | 五子棋离线求解 | `solveGomokuForSeed` | 我们已实现 | — |
| **P3** | 拉格朗日上界 | `bounds.mjs` | 不做 | 没有「证明最优」的需求 |
| **P3** | 审计三层 | `audit/*` | 不做 | 同上 |
| **不做** | 帮忙、独立守家、弹幕、管家 | 见 24.2 | 我们做了帮忙 | **建议实测收益后决定是否关掉** |

### 24.6 一句话总结这 2.6 万行代码

如果只能记住一件事，那就是：

> **它把「我现在该做什么」变成了「在 6 个岛日的现金流现值上，每个候选动作的精确边际贡献是多少」——然后用一套共享的模拟器，把这个判断在观测、规划、编译、执行四个阶段重复计算，每一层都比上一层更精确，但结论永远来自同一个目标函数。**

这也解释了为什么它需要 2.6 万行：**不是为了算得更复杂，而是为了让「同一件事」在四个不同的抽象层级上都能被正确计算**。



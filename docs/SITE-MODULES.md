# 鱼鱼谷网站功能模块 × 参考项目处理方式详解

> **这份文档是什么**：按「网站上的功能模块」组织，逐个说明 **① 站点规则是什么**、**② 参考项目 `yuyugu-kernel` 具体怎么处理**（算法、参数、阈值、代码位置）。
>
> **与另外两份的区别**：
> - [REFERENCE-KERNEL.md](REFERENCE-KERNEL.md) 按**代码目录**讲模块（model/planner/execution…），是架构视角；
> - [changes-2026-11-14.md](changes-2026-11-14.md) 讲**我们自己改了什么**；
> - 本文按**网站功能**讲，是业务视角 —— 想知道「这个功能对方到底怎么玩的」看这份。
>
> 代码路径均相对 `research/ref/yuyugu-kernel/`。行号指向 2026-11-14 读到的快照。

---

## 0. 网站全景

### 0.1 时间体系：三套时钟

这是整个系统最容易搞错的地方。站点同时跑着**三套时间**：

| 时钟 | 用途 | 规则 |
|---|---|---|
| **现实时间（北京时间）** | 每日额度、售卖阶梯、每日目标、天气 | 自然日 00:00 刷新 |
| **岛钟 `b12ClockSeconds`** | 作物生长、动物产出、季节、岛日 | 现实 4 小时 = 岛上 1 天；**但每天 22:00–08:00 停摆**，所以一天实际走 **3.5 个岛日** |
| **长夜 `b12IsLongNight`** | 纪事/夜潮 | 北京时间 22:00–08:00 |

岛钟的精确实现（`rules/pet-world-rules.js:1183`）：

```js
function b12ActiveSeconds(t) {
  const local = t + 8*3600                      // 转北京时间
  const day = Math.floor(local / 86400)
  const second = local - day*86400
  return day*14*3600 + Math.max(0, Math.min(14*3600, second - 8*3600))
  //                ↑ 每天只累计 08:00–22:00 这 14 小时
}
export function b12ClockSeconds(t) {
  if (!b12ClockEpoch || t <= b12ClockEpoch) return t + 8*3600   // 未配置时钟：退回线性
  return b12ClockEpoch + 8*3600 + b12ActiveSeconds(t) - b12ActiveSeconds(b12ClockEpoch)
}
```

**必须先用 `b12ConfigureClock(epoch)` 喂服务端时钟**（`:1172`），否则所有 `isleDay` / `isleHour` / `cropStage` / `b12Season` 全部错位。参考实现在 `cli/controller.mjs` 拉到世界快照后立刻配置。

派生：

| 量 | 公式 | 行号 |
|---|---|---|
| 岛日序号 | `isleIndex(t) = floor(b12ClockSeconds(t) / 14400)` | `:35` |
| 岛时 | `isleHour(t) = floor((clock % 14400) / 600)`（0–23） | `:37` |
| 第几个岛日 | `isleDayNo(t) = isleIndex(t) - isleIndex(ISLE_LAUNCH) + 1` | `:39` |
| 本季剩余 | `isleSeasonLeft(t)`，12 岛日一季 | `:40` |
| 下一个岛日边界 | `b12NextIsleBoundary(t)`，**跨长夜时要跳过 10 小时** | `:1190` |
| 长夜 key | `b12NightKey(t) = worldDay(t - 22*3600)` | `:1204` |

季节：12 个岛日一季，`b12Season(t) = floor((isleDayNo(t)-1) / 12)`（`:1655`）。非岛日按真实周换季，2026-11-02 为春季第一周（`:29`）。

### 0.2 体力与每日额度

`rules/pet-world-rules.js:11`：

```js
energyBase: 100, energyPerHouse: 20, regen: 180,
maxActions: 40, minGap: 2,
```

| 项 | 数值 |
|---|---|
| 体力上限 | 100 + 20 × 小屋等级（小屋最高 5 级 → **200**） |
| 回复 | 每 **180 秒** 1 点；一天约 **480 点**；满了不累计 |
| 动作消耗 | 播种 2 / 浇水 1 / 收获 1 / 清理 1 / 喂食 1 / 钓鱼 4 / 挖矿 3 / 加工 1 / 炸药 6 |
| 单次提交 | 最多 **40 个动作**，服务端每 **2 秒** 受理一次 |
| 咖啡 | 15000 D → 60 体力，每日 3 次（**可以突破上限**） |
| 潮汐饭团 | 6500 D → 20 体力，每日 2 个（`B12_SNACK`，`:1326`） |
| 管家代劳 | 钓鱼/挖矿每次 **多耗 1 点**（`AUTO.surcharge`，`:515`） |

体力回复是在 `refresh(s, t)` 里惰性结算的（`:451`）：

```js
if (s.en >= max) s.enT = Math.max(s.enT, t)
else {
  const n = Math.floor((t - s.enT) / WORLD.regen)
  if (n > 0) { s.en = Math.min(max, s.en + n); s.enT = s.en >= max ? t : s.enT + n * WORLD.regen }
}
```

> **规划含义**：体力是**内生 Resources**，不是外生约束 —— 你今天不用掉的点在明天不会攒下来（上限内才累计）。参考实现的 `planner/resources.mjs` 专门按回复相位建桶，就是为了不浪费「马上要回满的那几点」。

**每日 vs 岛日额度**（`s.cnt` 按自然日清零，`s.iq` 按岛日）：

| 额度 | 周期 | 上限 |
|---|---|---|
| 钓鱼 | **岛日** | 80 竿 |
| 挖矿 | **岛日** | 100 下 |
| 加工 | **岛日** | 80 次 |
| 炸药 | **岛日** | 10 次 |
| 52弟 | **岛日** | 52 次 |
| 咖啡 | 日 | 3 次 |
| 售卖阶梯 `sc_<crop>` | **自然日** | 150 全价 / 之后 85% / 400 后 70% |
| 每日目标 `goal<k>` | 自然日 | 4 个（3 个目标 + 全完成） |

### 0.3 动作协议全集（28 个）

服务端 `applyActions` 接受的动作（`rules/pet-world-rules.js:513` 起，逐分支）：

| 动作 | 参数 | 体力 | 说明 |
|---|---|---|---|
| `plant` | `i` 地块, `c` 作物 | 2 | 优先扣背包里的种子，没有才花钱买 |
| `water` | `i` | 1 | 洒水器覆盖或雨天时拒绝 |
| `harvest` | `i` | 1 | 品质与数量都取决于浇水次数 |
| `clear` | `i` | 1 | 清枯萎/空地 |
| `feed` | `i` 畜栏 | 1 | 距上次喂食 < 8 小时拒绝 |
| `pet` | `i` | 0 | 每天每只一次，+6 心情 |
| `collect` | `i` | 0 | 收动物产物 |
| `buyAnimal` | `k` 动物 | 0 | 畜栏满则拒绝 |
| `sellAnimal` | `i` | 0 | 只能收回 40% 原价 |
| `buyTrap` | — | 0 | 最多 4 个 |
| `trap` | `i` | 0 | 收蟹笼 |
| `fish` | `bait?` | 4 | 岛日 80 竿 |
| `mine` | `f` 层数 | 3 | 岛日 100 下 |
| `bomb` | `f` 层数 | 6 | 岛日 10 次 |
| `craft` | `id`, `n` ≤ 20 | 1×n | 岛日 80 次，扣料低星优先 |
| `sell` | `id`, `q`, `n` ≤ 999 | 0 | 作物走阶梯价 |
| `buy` | `id`, `n` | 0 | 集市/杂货 |
| `stockBuy` | 货船 | 0 | 每日货船 |
| `expand` | `k`: plot/barn | 0 | 买地/扩畜栏 |
| `upgrade` | `k`: rod/pick/spr/house | 0 | 工具/小屋升级 |
| `goal` | `k` 0–4 | 0 | 领每日目标奖励 |
| `eat` | `id`, `q` | 0 | 吃作物回体力 |
| `coffee` | — | 0 | 咖啡 |
| `npc` | `g` 游戏, `k` | 0 | 52弟（rps/card/gomoku/box） |
| `scratch` | `k` 彩票类型, `n` | 0 | 鱼彩刮刮乐 |
| `lotto` | 号码 | 0 | 鱼彩大乐透 |
| `warehouse` | — | 0 | 囤货仓库操作 |
| `storyRead` | `chapter` 1–3 | 0 | 读纪事（不花钱） |
| `nightClaim` | `key` | 0 | 领夜潮小礼 |
| `guardRefund` | — | 0 | 领旧守家道具补偿 |

另有**修仙**动作走 `/api/xs/*`，见第 18 章。

### 0.4 经济总公式

参考实现的目标函数（`model/objective.mjs`）：

```
J = Σ_ω p_ω [ C₀ + Σ_k γ(t_k−t₀)·ΔC_k(ω) + γ(t_H−t₀)·V_tail(s_H, t_H, P_H) ]
γ(Δt) = (1+ρ)^(−Δt/3600)      默认 ρ = 0（不折现）
ΔC_k = earn_k − spend_k       真实现金流，含税
```

**关键约束**：体力/原料的消耗已经在 `applyActions` 的状态转移里扣掉了，**目标函数里不能再二次扣影子价格** —— 这条写在 `DESIGN.md`，参考实现的代码严格遵守。

### 0.5 价格的形成（五个乘子）

`priceOf`（`:136`）：

```
price = round( base
             × marketFactor(item, day)      // 随机游走 × 季节 × 商闻事件
             × supplyFactor(soldYesterday, normal)  // 全站昨日卖出量
             × eventFactor(item, day)       // 商闻事件（已含在 marketFactor 里）
)
```

- `marketFactor`（`:119`）：4 天加权随机游走（权重 1 / 0.6 / 0.35 / 0.15）+ 季节（当季 0.92 / 反季 1.3）+ 偶发事件（1.5% 或 4% 概率 ×0.7 或 ×1.3）；岛日 clamp `[0.65, 1.7]`，非岛日 `[0.5, 2]`
- `supplyFactor`（`:132`）：`clamp(1.06 − 0.3 × soldYesterday/normal, 0.8, 1.06)`；**岛日用 `marketDepth(item) = clamp(1600000/basePrice, 800, 6000)`，非岛日用 `NORMAL_VOLUME = 400`**
- 商闻（`:250`）：每个岛日按季节/天气权重抽 **2 条**（不同商会），乘子 0.78–1.6
- 品质：`QUALITY = [1, 1.25, 1.5]`（普通/银星/金星）
- 作物阶梯（`:89`）：同一作物自然日 前 150 全价、151–400 85%、之后 70%

### 0.6 税（两套）

`rules/pet-world-rules.js:1638`：

```js
B12_TAX = { free: 3_000_000, high: 10_000_000, subsidyCap: 1_000_000 }

b12Marginal(capital, lowRate, highRate, denominator):
  excess = max(0, capital − 3,000,000)
  low  = min(excess, 7,000,000)
  high = excess − low
  return (low×lowRate + high×highRate) / denominator
```

| 税种 | 计征基数 | 边际税率 | 上限 |
|---|---|---|---|
| **余额税** `b12BalanceTax(balance)` | 当前现金 | 超 300 万部分 1‰，超 1000 万部分 3‰ | 无 |
| **售卖税** `b12SaleQuote(wallet, paid, gross)` | 当前现金 + 今日已缴 carry | 收入增量按 1% / 3%（`denominator=100`） | `min(gross, max(0, wallet+gross−300万))` |

售卖税是**当天累计**的（`d.tax.paid`，自然日重置），所以「今天已经卖了很多」之后边际税率会跳到 3%。参考实现的 `solveExactItemSaleSchedule` 正是把这个累计状态放进跨期排程里一起优化。

### 0.7 天气（每天一种，全站一致）

`weatherOf(day)`（`:112`）：`0=晴 / 1=雨 / 2=风 / 3=雪`。冬天雪概率 35%，其它季节雨 30% / 风 15%。

| 天气 | 效果 | 代码 |
|---|---|---|
| 雨 | 作物**自动浇水**（收获按 `w=3` 算品质）；钓鱼 miss −5%，贵鱼权重 ×1.5；手动浇水被拒绝 | `:549` `:566` `:732` `:737` |
| 风 | 蟹笼产出**翻倍** | `:485` `:707` |
| 雪（仅冬） | 矿洞宝石（价 ≥12000）权重 ×1.6 | `:756` `:787` |

---

## 1. 种植业

> 下面 `R:...` 指 `research/ref/yuyugu-kernel/rules/pet-world-rules.js`，`S:...` 指 `research/ref/yuyugu-kernel/planner/solve.mjs`，`A:...` 指 `research/ref/yuyugu-kernel/model/rules-adapter.mjs`。

### 1.1 地块与作物表

初始 6 块，最多 24 块；第 n 块（n 从 7 起）价格 `10000 × n`（`R:14`）。从 6 扩到 24 共需 **279 万 D**。

| id | 名称 | 季节(0春/1夏/2秋/3冬) | 种价 | 基础卖价 | 首茬(分) | 连茬(分) | 次数 | 食用体力 |
|---|---|---|---:|---:|---:|---:|---:|---:|
| turnip | 小白萝卜 | 春、冬 | 110 | 540 | 30 | - | 1 | 8 |
| carrot | 胡萝卜 | 春、秋 | 180 | 960 | 60 | - | 1 | 10 |
| wheat | 小麦 | 夏、秋 | 220 | 1400 | 120 | - | 1 | 6 |
| strawberry | 草莓 | 春 | 720 | 3300 | 240 | 180 | 4 | 14 |
| tomato | 番茄 | 夏 | 540 | 2550 | 180 | 150 | 4 | 12 |
| corn | 玉米 | 夏、秋 | 900 | 4800 | 360 | 240 | 3 | 14 |
| grape | 葡萄 | 秋 | 1080 | 5700 | 360 | 240 | 4 | 12 |
| pumpkin | 南瓜 | 秋、冬 | 1440 | 9000 | 600 | - | 1 | 20 |
| cabbage | 冬白菜 | 冬 | 450 | 2350 | 150 | - | 1 | 12 |

出处 `R:43-52`。`times` **含首茬**，所以 `times=4` 实际收 4 次（`R:584`）。作物没有专门的种子商店，`plant` 时先消耗背包里的 `sd_<crop>`（品质 0），没有才扣 D 币（`R:532-538`）；种子来源是每日目标与 NPC 奖励（`R:292` `R:311`）。

### 1.2 生长公式（`R:471-482`）

```js
const crop = CROPS.find(c => c.id === p.c)
if (!crop.seasons.includes(seasonOf(isleDay(p.t)))) return { stage: -1 }   // ← 用「种植时刻」的季节
const fast = p.t >= ISLE_LAUNCH
const base = (p.h && crop.regrow ? crop.regrow*0.8 : crop.grow) * 60 * (fast ? 0.8 : 1)
const total = base * (auto ? 0.6 : 1) - p.g
const el = t - p.t
if (el >= total) return { stage: 3 }
return { stage: Math.min(2, Math.floor((el/total)*3)) }
```

四个必须记住的点：

1. **季节检查用 `p.t`（种植时刻的岛日），不是当前时刻** —— 所以已种下的作物不会生长途中换季枯萎，单茬作物和连茬的最后一茬都能跨季成熟（`R:474`）。
2. `fast = p.t >= ISLE_LAUNCH`（2026-11-07 20:00 北京时间之后种的）：首茬和连茬都再乘 **0.8**。
3. `auto = 洒水器覆盖 || 当前岛日天气是雨`，直接整段 `total × 0.6`（`R:478` `R:566`）。
4. **`el = t - p.t` 是真实秒**，长夜时钟冻结不影响作物生长（`R:1169` 的注释明确「Never replaces … crop elapsed time」）。

### 1.3 浇水的真实机制（`R:543-563`）

```
拒绝条件：地块空 / 洒水器覆盖 / 雨天 / stage<0 / stage>=3 / p.w > stage
成功：扣 1 体力，p.w++，p.g += floor(剩余时间 × 0.25)
```

- **不是**「浇水缩短 25% 总时长」，而是「每次砍掉**当前剩余**时间的 25%」，等效 `剩余 × 0.75`。
- 同一阶段只能浇一次（`p.w > stage` 拒绝），`stage` 最大 2，所以一块地最多浇 **3 次**。
- 手工浇水改的是 `p.g`，逐次累加；不是倍率。

### 1.4 收获的品质与数量（`R:564-589`）

```js
const auto = sprinkled(s,i) || weather === 1
const w = auto ? 3 : p.w
const gold = 0.05 + 0.1*w, silver = 0.2 + 0.08*w
// 金星 < gold；否则 < gold+silver 银星；否则普通
const n = max(1, (1 + (rand < 0.3 + 0.08*w ? 1 : 0)) - (p.sv?.length ? 1 : 0))
```

| 浇水阶段 w | 金星 | 银星 | 普通 | 期望个数(未被偷) | 期望品质倍率 |
|---:|---:|---:|---:|---:|---:|
| 0 | 5% | 20% | 75% | 1.30 | 1.075 |
| 1 | 15% | 28% | 57% | 1.38 | 1.145 |
| 2 | 25% | 36% | 39% | 1.46 | 1.215 |
| 3 | 35% | 44% | 21% | 1.54 | 1.285 |

- **洒水器/雨天按 `w = 3` 算**，哪怕从没浇过水。
- 被偷过（`p.sv.length > 0`）固定少 1 个但至少 1 个，品质概率不变 —— 不管被偷几次都只少 1。
- 收获扣 1 体力 + 6 经验（`R:578-581`）。
- 连茬：`crop.regrow && p.h+1 < crop.times` 时重建 `{c, t:ctx.t, w:0, g:0, h:p.h+1}`，否则清空（`R:583-587`）。重置时若新季节不包含该作物，立刻 `stage = -1`。

### 1.5 素材/派生的真值：`exactPlotTimings`（`A:615-666`）

参考实现的核心工具。它**逐岛日段**重算成熟时刻，因为服务端是在「收获/浇水那一刻」用当时天气重算整段 `total`：

```
cursor = isAlreadyRipe ? max(0, p.t) : max(nowSec, p.t)
repeat ≤32 次:
    isRain = weatherOf(isleDay(cursor)) === 1
    auto   = isSprinkled || isRain
    totalSeg = max(1, base*(auto?0.6:1) - g)
    candMature = max(cursor, ceil(p.t + totalSeg))
    segEnd = nextIsleBoundary(cursor)
    if (candMature < segEnd) { matureAt = candMature; break }
    cursor = max(cursor+1, segEnd)
```

然后同样循环一次算 `unlockAt = ceil(p.t + totalSeg + protect)`（保护期默认 **1800 秒现实秒**，来自访客接口的 `rules.protect`，不在规则模块本体里）。

**这是本项目最大的缺口**：我们的 `cropMatureAt`（`core/market.mjs:199`）和 `cycleOf`（`core/planner.mjs:322`）只看 `now` 那一刻的天气，一锤定音。后果：

- 现在晴、稍后雨 → 预测偏晚（服务端下雨后会把 `total` 追认成 0.6 倍）
- 现在雨、稍后晴 → 预测偏早（我们以为熟了却收不了）
- 偷菜解禁时刻（`core/steal-schedule.mjs:216`）同样受影响

### 1.6 对方怎么选作物：`selectBestCropToPlant`（`S:1274-1378`）

不是「按单位时间收益排个队」，而是一个带**跨季机会成本**的逐块决策。

**候选集**：遍历全部 9 种作物，用 `simulateCropLifecycleFromPlant` 模拟完整生命周期；种植时刻不在该作物季节的直接返回 `null`（`A:873`）。

**生命周期模拟**（`A:696-849`）按 `maxTimes = regrow ? times : 1` 循环：

- 每茬先判枯萎（`A:744`）
- 找本茬成熟/解禁（`exactPlotTimings`）
- 算手工浇水次数 `manualWaters = min(3, dryManualWaterStages) - baseW`，**规划时传 `dryManualWaterStages = 2`**（`S:1293`）—— 保守假设只浇 2 个阶段，不是 3
- 收获后 `predictPostHarvestPlot` 判断下一状态：`empty` / `regrow` / `withered`（`A:674-694`）
- 汇总 `totalStaminaSpent = 2(播种) + Σ(浇水 + 收获) + 期末清地`

**估值**（`S:1287-1315`）：

```
totalExpectedRevenue = Σ_每茬 Σ_q E[本茬 q 品质个数] × marginalItemValueFn(crop.id, q, 本茬成熟时刻)
seedCashCost = 背包有 sd_<crop> 品质0 ? 0 : crop.seed
net = totalExpectedRevenue - seedCashCost - totalStaminaSpent × staminaPointCost
rawRatePerSec = net / occupiedSec
```

三个关键：

1. **每茬用自己的成熟时刻估值**，不是用平均价。`marginalItemValueFn` 会在「该时刻之后所有可卖时点」里选最高的折现价，并考虑该自然日的阶梯额度（`S:1931-2008`）。
2. **会算加工增值**：对每个消耗该作物的配方，扣掉其他原料的直接卖价机会成本，取「直接卖」与「加工隐含价」的较大者（`S:1969-2008`）。
3. **体力按影子价格折钱**：`staminaPointCost` = `max(0, min(最便宜补体力单价, 最好钓鱼/挖矿收益 per energy))`（`S:2077-2128`）。所以一块地占的体力已经扣掉了「拿去除草/钓鱼能赚多少」。
4. **免费种子**：`startSec === atSec && 背包有 sd_<crop> 品质0` 时 seedCashCost 置 0（`S:1305`），执行时还用 `freeSeedCounts` 记账避免超发（`S:2574` `S:4941`）。我们完全没做这件事。

**跨季机会成本**（`S:1317-1356`）：如果本作物 `endSec` 越过下一个换季边界，先算 `rNextSeason`（把所有作物放到换季边界重新估一遍，取最大 `rawRatePerSec`），然后：

```
spillNextSec = endSec - nextSeasonBoundary
surplusVsWait = net - spillNextSec × rNextSeason
if (surplusVsWait <= 1e-6) 直接淘汰        // ← 宁可空着等下一季
score = surplusVsWait / min(occupiedSec, max(60, nextSeasonBoundary - atSec))
```

正常情况 `score = rawRatePerSec`；若 `enforceHorizonCutoff`（期末清算模式），`score = net`，生命周期在 `tEnd` 截断并按比例计入未成熟部分（`A:782-805`）。

**额度预约**：选定作物后调用 `marginalItemValueFn(crop.id, 0, atSec, {reserveUnits: round(totalExpectedUnits)})`，把未来产量记到该自然日的 `sc_<id>` 上并占用加工坊槽位（`S:2586` `S:6554`）。后续地块估值会看到额度已被吃掉一部分 —— 这是防「9 块地全种南瓜」的关键机制。

### 1.7 对方怎么安排浇水 / 收获 / 清理

**bucket 内固定顺序**（`S:4816-4818` `S:6496-6612`）：

```
harvest → clear → plant → feed → expiring water
```

硬编码，不是按收益排序。因为收获释放地块、清理释放地块、补种必须紧跟收获、浇水只处理会丢的阶段、喂食在种植之后。

**浇水分两类**：

- **会过期的（expiring）**：`stage 0..2`、`!auto`、`p.w <= stage`，且本阶段结束时刻 `<= nextOppSec`。阶段结束时刻 = `p.t + ceil(st.total*(stage+1)/3)`（`S:2529`）。价值 `exactManualWaterGain` = 品质/多收的价值 + `rPlot × floor(剩余×0.25)` 的提前进下一茬价值（`S:4823`）。按 `fixedLossIfUnfunded` 降序。
- **不会过期的（non-expiring）**：只有「没有任何正收益空地待种」且「执行完紧急任务还有富余体力」才做（`S:6789-6809`）。测试 `phase10:114-142` 硬性断言：低体力下非过期浇水不能抢补种的体力。

**收获排序**（`S:4862-4884`）：

```
rPlot = 该地空出来后种最优作物的 netRatePerSec
stealLossCap = max(0, 期望个数 - 1.0) × marginalItemValueFn(crop, 0, now)
sortPriority = rPlot + (now >= unlockAt ? stealLossCap/protectSec : 0.25 × stealLossCap/protectSec)
```

按 `sortPriority` 降序执行。`rPlot` 代表「越早空出来下一茬越值钱」，第二项代表「过了保护期的被偷风险」。所有 `harvestTasks` 按此排序，`clearTasks` 按 `rPlot` 降序，执行时**先收完所有熟地再清枯萎**（`S:4919` `S:6498`）。

**清理的判定**：`stage === -1`（当前枯萎），或 `predictPostHarvestPlot` 返回 `withered`（连茬重置时新季节不包含该作物）。**后者在收获后立刻追加 clear**（`S:2515-2521`）—— 我们的收割循环只在扫描时看到 `stage === -1` 才清，收获后新产生的枯萎要等下一轮巡视，白丢一个巡视周期。

**体力分配**：这些任务不是「能付就付」，而是进去一个**边际损失曲线**：

1. 构造 urgentTasks，各自 `costEn` = harvest 1 / clear 1 / plant 2 / feed 1 / expiringWater 1
2. `evalUnfundedFarmMetrics(fundedEn)` 模拟「只给这么多体力会 funding 到哪」，对每个未 funding 的任务算等待损失（`S:5056-5105`）：
   - harvest：`ratePerSec × waitSec + stealLossCap × (e^{-expBefore/protect} - e^{-expAfter/protect})`
   - plant：`max(ratePerSec × waitSec, 若跨季且该作物下季不可种则 npv)`
   - feed：`haltRatePerSec × 断粮秒数`
3. 建 `V_farmCurve[eF] = 相比 0 体力减少的损失`（`S:5107`）
4. bucket 级 DP 在这条曲线、钓鱼/挖矿/加工收益、吃/咖啡补体力之间分配

### 1.8 天气与季节

- 天气**确定可预测**：`weatherOf(day) = hash('weather:'+day)`（`R:111-117`），冬天雪 35%/雨 15%/风 15%/晴 35%，其他季节雨 30%/风 15%/晴 55%。参考实现没有天气情景树。
- 季节：岛日时代 12 岛日一季（`R:31`）。`isleSeasonLeft(t) = 12-1-((isleIndex(t)-isleIndex(launch)) % 12)`，0 = 本季最后一天（`R:40`）。
- **已种作物不因换季枯萎**（`cropStage` 用 `p.t`），只有连茬重置时才检查新季节。
- 换季边界 `nextSeasonBoundary` 精确到长夜后的第一个岛日边界（`A:213-237`）。
- **真正的随机性在价格**：默认三情景 tight/baseline/glut，权重 0.25/0.50/0.25，对应 `externalSupplyFactor` 1.03/0.96/0.84；第一个 `isleDayOffset >= 1` 的 bucket 之后才分支（`model/observations.mjs:72-76` `S:7471`）。

### 1.9 扩地决策

`enumerateLegalCapexCandidates`（`S:1384`）：`freeCash = coins - cashReserveFloor`；地块候选条件是 `plotN < 24 && plotPrice(plotN+1) <= freeCash`。枚举顺序 plot → trap → animal → spr → pick → rod → house，**但顺序不代表优先级**。

`selectCapexByTrajectoryDelta`（`S:1439-1532`）的判断不是静态回本期，而是：

```
paybackSec = max(horizonSec, min(72h, maxCapexPaybackSec))
J(买地后 72 小时内重新优化的整条轨迹) - J(不买的最优轨迹) > 1e-6
```

- 用 `optimizeAndSimulateSequence` 在 `paybackSec` 窗口内重新优化整条轨迹（capex 被禁用），目标是 `totalObjectiveValue`（现金折现 + 期末库存/地里作物价值）
- 含随机动作的轨迹额外跑 4 条样本流取平均（`S:1488`）
- **每次求解最多选一个 capex**（`S:1506`）

买地的价值会通过「多一块地参与选种 + 改变阶梯额度 + 改变加工名额 + 重新分配体力」自然体现，不需要手工估。

**默认只对副号开**：主号 `allowCapex=false`、所有 targets=0；副号 domestic 默认允许 24 地 / 8 畜栏 / 4 蟹笼 / 工具满级（`model/observations.mjs:120-144`）。

### 1.10 与我们的差异清单

| # | 差异 | 影响 |
|---|---|---|
| 1 | 成熟/解禁预测只按 `now` 的天气 | 天气翻转时成熟时刻偏差可达整段 40% |
| 2 | 规划时假设手工地浇满 3 阶段（我们）vs 2 阶段（对方） | 单块地产量估值偏高 |
| 3 | 先浇水再补种（我们 `core/planner.mjs:777` → `:793`）vs 先补种（对方） | 体力见底时种不了地 |
| 4 | 收获后新产生的枯萎不在同批清理 | 换季窗口白丢一个巡视周期 |
| 5 | 收获按地块下标 vs 按 `rPlot + 偷菜风险` | 体力不足时可能先收低价值地 |
| 6 | 用未来平均价 vs 每茬成熟时刻的最优价 | 抹平不同成熟日的价差 |
| 7 | 种子成本一律按全价 | 免费种子多时误判不赚钱 |
| 8 | 无「空着等下一季」选项 | 换季前可能种下跨季低效作物 |
| 9 | 加工估值只算单原料配方、名额静态近似 | 胡萝卜/南瓜估值偏低，名额可能重复占用 |

## 2. 养殖业

### 2.1 畜栏与动物表

初始 **2** 个畜栏，最多 **8** 个；第 n 个（n 从 3 起）价格 `80000 × n`（`R:15`）。从 2 扩到 8 共 33 万 D。

| id | 名称 | 买价 | 产出周期(分) | 窝容量 | 产物 | 产物基础价 |
|---|---|---:|---:|---:|---|---:|
| chicken | 小鸡 | 12,000 | 240 | 3 | egg 鸡蛋 | 1,350 |
| duck | 鸭子 | 24,000 | 300 | 3 | duckegg 鸭蛋 | 2,500 |
| cow | 奶牛 | 60,000 | 480 | 2 | milk 牛奶 | 5,850 |
| sheep | 绵羊 | 90,000 | 1,440 | 1 | wool 羊毛 | 19,000 |
| pig | 小猪 | 150,000 | 720 | 1 | truffle 松露 | 13,500 |

出处 `R:53-59`。买入时初始状态 `{k, f:t, p:t, m:60, born:t}` —— **心情 `m` 初值 60**（`R:610`）。

### 2.2 成长、成年期与退休

```js
B12_GROW_DAYS  = {chicken:2, duck:3, cow:5, sheep:5, pig:6}      // 岛日
B12_ADULT_DAYS = {chicken:24, duck:36, cow:48, sheep:60, pig:72} // 岛日
```

（`R:1573-1574`）

- 成长阶段 `stage`：`elapsed >= days ? 2 : elapsed >= ceil(days/2) ? 1 : 0`（`R:1595`）。**只有 `stage === 2` 才产东西**（`collect` 拒绝时提示「动物还在成长，距成年约 N 个岛日」）。
- 退休时刻 `retireAt = adultAt + B12_ADULT_DAYS[k] × ISLE_SPAN`，之后 `stage = 3`、`retired = true`（`R:1590-1592`）。
- **退休后不再需要喂食**，但窝里已有的产物仍可收取（`R:630` `R:653` `R:670`）。
- 时间换算用 `b12AfterActive`（`R:1575-1587`）—— 它跳过每天的 22:00–08:00 冻结段，所以「2 个岛日」实际要跨 **3.5 个现实日的白天**。最多循环 1000 次，超出抛 `RangeError`。

### 2.3 喂食、抚摸与心情

**喂食**（`R:624-646`）：

```
拒绝：动物空 / 已退休 / t - pen.f < 8*3600（还饱着呢）/ 背包没有 feed
成功：扣 1 饲料 + 1 体力，pen.f = t，pen.m = min(100, m + 8)
```

**关键：不是「8 小时喂一次」，而是「8 小时后才可以喂」** —— 喂一次的有效期是 **24 小时**（`fed = t - pen.f < 86400`，`R:1611`）。

**抚摸 `pet`**（`R:647-661`）：每天每只 1 次，`pen.m = min(100, m + 6)`，**不耗体力**。

**心情影响品质**（`R:1605-1609`）：

```js
const bonus = weatherOf(day)===0 ? +0.02 : weatherOf(day)===3 ? -0.02 : 0   // 晴 +2%，雪 -2%
const gold   = clamp(pen.m/250 + bonus, 0, 0.45)
const silver = clamp(pen.m/120, 0, 0.8)
// r < gold → 金星；r < gold + (1-gold)*silver → 银星；否则普通
```

所以满心情 100 时：金星 40%、银星 48%、普通 12%；心情 60（刚买）时：金星 24%、银星 40%、普通 36%。**收产物会 `m = max(20, m - 2)`，抚摸 +6，喂食 +8** → 每天喂 1 次 + 摸 1 次 = +14，收 1 次 -2，净 +12，可以把心情推到满。

### 2.4 产出周期与季节/天气

```js
b12AnimalPeriod(kind, t) = round(def.every*60 × factors[kind][season] × climate)

factors = {
  chicken: [.98, 1.02, 1,    1   ],
  duck:    [.96, 1,    1.02, 1.02],
  cow:     [.98, 1.04, .98,  1   ],
  sheep:   [1,   1.02, .98,  1   ],
  pig:     [1,   1.02, .96,  1.02],
}   // 索引顺序 [春, 夏, 秋, 冬]
climate = 雨 ? (duck ? .97 : 1.01) : 雪 ? 1.02 : 1
```

（`R:1597-1604`）

**周期是逐产物独立算的**：`animalReady` 的循环是「从 `cursor = max(pen.p, adultAt)` 开始，每产一个就把 `cursor += b12AnimalPeriod(kind, cursor)`」，所以**同一只动物在不同岛日产出的产物周期可能不同**（跨季/跨天气）。

**累计上限是 `cap` 个**，窝满了后面的时间不累计（`R:1622` 的 `nextP = n>=cap ? max(cursor,until) : cursor`）。

**饥饿累计上限 24 小时**：`until = min(t, pen.f + 86400, retireAt)` —— 喂一次之后的 24 小时内正常产出，超过 24 小时的部分**不产出**。

> 这是第 25 章第 9 条误解：「动物喂一次管 8 小时」是错的，8 小时只是**最早可以再喂**的时刻。真正的硬约束是「只累计 24 小时」。

### 2.5 收产物（`R:662-686`）

- **不耗体力**（`WORLD.cost` 里没有 `collect`），加 6 经验（`R:23`）
- `ctx.auto` 时**所有产物强制品质 0**（`R:675`）—— 这与种植的 `ctx.auto` 判定一致
- 收取后 `pen.m = max(20, m - 2)`
- 窝里没满时保留剩余进度；满了以后的时间不累计

### 2.6 卖动物

`gross = round(def.price × 0.4)`，再扣售卖税（`R:619`）。也就是说**卖掉只回收 40%，且还要交税** —— 除非是真要腾畜栏，否则不划算。

### 2.7 对方怎么处理养殖

> 详细算法见第 12 份子代理报告，这里列核实过的结论。

**参考实现的养殖估值在 `simulateBarnLifecycle`（`model/rules-adapter.mjs`）**，与作物生命周期同构：

1. 逐产物按 `b12AnimalPeriod(kind, cursor)` 推算产出时刻（**注意周期随季/天气变**，不能用一个固定 `every`）
2. 产物品质按 `b12AnimalQuality(a, start)` 的哈希**确定性可预测** —— 给定 `born` 与产出时刻就能算出品质，不需要随机建模
3. 喂食成本按「每 24 小时 1 饲料 + 1 体力」计，并检查背包饲料库存
4. 退休后停止产出，剩余价值只有窝里已积累的部分
5. 买动物是 capex 候选，用轨迹差值评估（见 1.9）

**关键洞察**：动物的产出是**完全确定性的**（周期、品质都由 `worldHash` 决定），所以参考实现可以精确预测未来每一件产物的时刻和品质，不需要期望值。这和作物收获的随机性（品质是 `Math.random`）形成对比。

**我们的差异**（`core/planner.mjs`）：

| 差异 | 影响 |
|---|---|
| 用固定 `every` 乘一个季节/天气系数，不逐产物推进 | 跨季/跨天气时产出时刻偏差 |
| 心情 `m` 的长期均衡没建模 | 品质期望偏差（满心情 vs 60 心情差 16% 金星率） |
| 摸宠物（`pet`）的 +6 心情没进规划 | 白丢免费品质提升 |
| 卖动物回收 40% 的税后价值没考虑 | 腾栏决策可能亏 |

---

## 3. 加工

### 3.1 配方表（`R:151-168`）

| id | 名称 | 原料 | 成品价 | 原料直接卖价之和 | 净增值 |
|---|---|---|---:|---:|---:|
| salad | 田园沙拉 | 萝卜 3 + 胡萝卜 3 | 6,500 | 4500 | +2000 |
| flour | 面粉 | 小麦 5 | 9,200 | 7000 | +2200 |
| jam | 草莓果酱 | 草莓 4 | 17,000 | 13200 | +3800 |
| ketchup | 番茄酱 | 番茄 4 | 13,500 | 10200 | +3300 |
| popcorn | 爆米花 | 玉米 3 | 18,500 | 14400 | +4100 |
| wine | 葡萄酒 | 葡萄 4 | 31,000 | 22800 | +8200 |
| pie | 南瓜派 | 南瓜 2 + 鸡蛋 2 | 26,000 | 20700 | +5300 |
| kimchi | 泡菜 | 冬白菜 4 | 12,500 | 9400 | +3100 |
| mayo | 蛋黄酱 | 鸭蛋 3 | 9,800 | 7500 | +2300 |
| cheese | 奶酪 | 牛奶 3 | 23,500 | 17550 | +5950 |
| sweater | 羊绒毛衣 | 羊毛 2 | 50,000 | 38000 | +12000 |
| ironbar | 铁锭 | 铁 4 + 煤 2 | 10,200 | — | — |
| ingot | 金锭 | 金 4 + 煤 2 | 23,000 | — | — |
| jewel | 宝石项链 | 红宝石 1 + 绿宝石 1 + 金 1 | 46,000 | — | — |
| crown | 钻石王冠 | 钻石 2 + 金锭 1 | 108,000 | — | — |
| bomb | 炸药 | 煤 3 + 铜 2 | **0（不能卖）** | — | 拿去矿洞炸矿 |

**注释说「卖价都比原料高 20%–40%」**（`R:150`），但注意这只是相对**基础价**，不含市场乘子。当原料在反季暴涨到 ×1.3 时，加工可能反而不划算 —— 这正是参考实现要用 `implied = (成品价 - 其他原料机会成本) / needThis` 而不是「固定清单」的原因。

**`bomb` 必须单独对待**：`price: 0` 表示不能卖，只能拿去矿洞用（`R:167` 注释「不能卖：拿去矿洞炸矿」）。所以它的价值 = 一次炸矿的期望收益，不是 0。

### 3.2 加工动作的完整实现（`R:768-779`）

```js
const r = RECIPES.find(x => x.id === act.id), n = clamp(1, 20, act.n)
if (icount('craft') + n > WORLD.daily.craft) 失败「这个岛日加工坊已经忙不过来了（谷内换天就刷新）」
if (s.en < cost * n) 失败「体力不足」

const have = id => (s.inv[id] || [0,0,0]).reduce((a,b) => a+b, 0)
if (任一原料 have(id) < need*n) 失败「材料不够」

// ← 扣料严格低星优先
for (const [id, need] of Object.entries(r.in)) {
  let left = need * n
  for (let q = 0; q < 3 && left > 0; q++) {
    const m = Math.min(left, s.inv[id]?.[q] || 0)
    if (m) { invTake(s.inv, id, q, m); left -= m }
  }
}

invAdd(s.inv, r.id, 0, n)               // ← 成品固定品质 0
s.en -= cost * n
xp += WORLD.xp.craft * n                // 2 经验/次
s.cnt.craft = count('craft') + n
```

五个必须记住的点：

1. **额度按岛日 80 次**（`WORLD.daily.craft`），不是自然日
2. **每次 1 体力**（`WORLD.cost.craft`），一次最多做 20 个
3. **材料检查用总数，扣料严格 `q0 → q1 → q2`** —— 所以做 4 个果酱会先扣光 0 星草莓，再扣 1 星（`R:775`）
4. **成品永远是品质 0**，不管原料是什么品质
5. **`icount('craft')` 和 `s.cnt.craft` 都在记账** —— 前者用于额度判断，后者用于统计

### 3.3 对方怎么估值加工

参考实现不预设「哪些配方值得做」，而是把加工拆成**三层**：

**第一层：单位提炼（`marginalItemValueFn`，`S:1969-2008`）**

对每种消耗该作物的配方：

```
implied = (成品价 - 其他原料的直接卖价机会成本) / needThis
value(item, q) = max(直接卖价, implied)
```

也就是说：**胡萝卜的价值 = max(直接卖的价格, 做田园沙拉的隐含价值)**。如果沙拉不赚钱，`implied < 直接卖价`，就自动退回直接卖。

**第二层：槽位预约（`S:2011-2027`）**

选定作物后按 `reserveUnits / needThis` 做**分数槽位预约**，绝不 `Math.ceil`：

```js
slotUsage += reserveUnits / needThis
```

这样可以避免「3 种作物各占 1 个槽位，实际只用 0.3 个」的浪费，也避免「多个作物重复占用同一批槽位」。

**第三层：期末续期（`model/objective.mjs:169-239` 的 `evaluateHarvestBatch`）**

期末清算时，把加工槽位、其他原料库存、折现率全部纳入，判断「期末收获的这批原料应该直接卖还是留着加工」。

### 3.4 我们的差异

| 差异 | 影响 |
|---|---|
| 只算单原料配方（`core/planner.mjs:371-377` 的注释明确说明） | 胡萝卜（田园沙拉）、南瓜（南瓜派）、铁锭/金锭/宝石项链/钻石王冠全部估值偏低或漏算 |
| 槽位用静态估算 `WORLD.daily.craft × 3.5 - (mine ? 90 : 0)`（`core/planner.mjs:414`） | 名额可能被重复占用或闲置 |
| 不按 `q0 → q1 → q2` 的低星优先顺序估算 | 用高星料做加工，白亏卖价差 |
| 炸药的「不能卖但能炸矿」价值没建模 | 可能把煤/铜直接卖掉，或不做炸药 |

**一个必须记住的换算**：`3.5` 是「一个自然日 = 3.5 个岛日」的换算（14 小时白天 / 4 小时岛日）。**每天实际能加工 280 次，不是 80 次**。

**关于 `- (mine ? 90 : 0)`**：这是为挖矿预留的加工能力 —— 因为挖矿算法里炸药能显著提升产出，而炸药需要煤 3 + 铜 2。但这 90 是拍脑袋的静态值，参考实现是让 DP 自然权衡。

---

## 4. 商店与采购

### 4.1 三套不同的采购通道

| 动作 | 卖什么 | 价格 | 限额 |
|---|---|---|---|
| `buy` | **只有** `feed` 饲料 150、`bait` 鱼饵 400、`bomb` 炸药 2500 | **固定价，不受市场因子影响**（`R:79` `R:172`） | 每批 1~99 个，无每日上限 |
| `stockBuy` | **货船**（每日轮换） | 固定价 = `SHOP[id]?.price ?? BASE_PRICE[id]` | **每岛日个人限额** |
| —— | 种子 | 没有种子商店；`plant` 时先消耗 `sd_<crop>` 库存，没有才扣币（`R:532`） | —— |

（`R:889-902` `R:1551-1556`）

**注意 `buy` 的价格是写死的**：饲料永远 150、鱼饵永远 400、炸药永远 2500，不参与任何市场乘子。所以「等便宜了再买」对这三种完全无效。

### 4.2 货船：完全确定性可预测（`R:1324-1340`）

```js
b12Stock(t, prices) {
  const day = isleDay(t)
  const pick = (ids, n, salt) => ids
    .map(id => ({ id, r: worldHash('b12-cargo:' + day + ':' + salt + ':' + id) }))
    .sort((a,b) => a.r - b.r || a.id.localeCompare(b.id))
    .slice(0, n).map(x => x.id)

  const groups = [
    ['crop',     pick(CROPS 全部 id,                      4, 'crop'),     24],
    ['animal',   pick(ANIMALS 全部 product,               2, 'animal'),    8],
    ['crafted',  pick(RECIPES.filter(x=>x.price),         2, 'crafted'),   4],
    ['material', pick([...FISH, ...ORES].map(x=>x.id),    2, 'material'),  6],
    ['supply',   worldHash('b12-rare:' + day) < .15
                   ? ['tide_snack', pick(['feed','bait','bomb'], 1, 'supply')[0]]
                   : pick(['feed','bait','bomb'], 2, 'supply'),           12],
  ]
}
```

**这是站点里最容易被低估的可预测性**：货船的每一件商品由 `worldHash('b12-cargo:' + day + ':' + salt + ':' + id)` 排序决定，而 `worldHash` 是**纯函数**。所以：

- 可以**精确预测今天、明天、后天**的货船内容
- 可以据此规划「今天囤什么、明天等什么」
- 不需要任何猜测或统计

**限量按岛日**（`b12StockLeft`，`R:1338`）：

```js
b12StockLeft(s, item, t) = max(0, item.limit - (s.b12?.shop?.d === isleDay(t) ? s.b12.shop.n[item.id] || 0 : 0))
```

也就是说：**换岛日就重置**，一个自然日里有 3.5 个岛日 = 3.5 份额度。

**组别限额**：crop 24 / animal 8 / crafted 4 / material 6 / supply 12。

**潮汐饭团 `tide_snack`**：`worldHash('b12-rare:' + day) < 0.15` 时出现在 supply 组，**限购 1 个**，价格 6500，`+20 体力`（受上限截断）。

### 4.3 对方怎么处理采购

**① 三种消耗品的购买门槛（`S:2950-2990`）**

参考实现不按「库存少了就补」，而是对每一种都算**边际收益 vs 折现后的买价**：

```js
// 炸药（S:2951）
if (bombDropVal - shopBombPrice * bucketDisc > 1e-6) { 买 }

// 鱼饵（S:2985）
if (valBait - baitPrice * bucketDisc > Math.max(0, valNoBait)) { 买 }

// 饲料（S:2624）
if (coins - cashReserveFloor >= needBuy * feedPrice) { 买 }
```

- `bombDropVal` = 一次炸矿的**期望产出价值**（含矿石的边际物品价）
- `valBait` / `valNoBait` = 用饵/不用饵的**一次钓鱼期望产出价值**（按鱼的边际价加权）
- `bucketDisc` = 该 bucket 的折现因子

**折现因子是关键**：它让「明天才用得上」的补给打折，避免一次性囤满。饲料的判断最简单（只有现金约束），因为饲料是**刚性消耗**（不喂就没产出），不需要比较收益。

**② 货船优先于商店（`S:2952-2955`）**

```js
const cargoBombOffer = cargoPrice.has(bombId) && cargoPrice.get(bombId) <= shopBombPrice
  ? Math.min(remBombNeed, cargoLeft.get(bombId) || 0)
  : 0
const shopBombCap = Math.min(remBombNeed - cargoBombOffer, Math.floor(availCoins / shopBombPrice))
```

**如果货船有更便宜或同价的货，先买货船的，再买商店的**。因为货船限量按岛日刷新，不买就浪费；而商店随时可买。

**③ 货船分配：三类目标共享预算（`S:2682-2790`）**

每个岛日只分配一次（`seenCargoIsle`）。在共享约束 `(availCoins, cargoLeft, 未预留工坊槽位, 未预留体力, 非咖啡体力)` 下，同时优化三类目标：

1. **完整的配方补全包（bundle-aware）**：不是「缺一个胡萝卜就买一个」，而是「这个配方还差什么，凑齐一整套」，避免「每买一个原料就烧掉一个工坊槽位」
2. **直接原料转卖套利（raw-resale arbitrage）**：货船价 < 当前市场价时买入直接卖
3. **体力/炸药补给**：潮汐饭团按 CPE 与咖啡比较，炸药按 `bombDropVal`

**④ 低现金的工作资本预售（`S:2268`）**

当现金不足时，参考实现会在 bucket 0 先卖掉一部分库存换工作资本 —— 包括「精确种子的、饲料的和正套利的货船需求」。这是为了避免「明明有货但没钱买种子」的僵局。

### 4.4 我们的差异

| 差异 | 影响 |
|---|---|
| 采购可能按固定阈值而非「边际收益 vs 折现买价」 | 可能在不需要时囤货，或该买时不买 |
| 没有「货船优先于商店」的顺序 | 白丢货船的限量折扣 |
| 货船没有做 bundle-aware 分配 | 每买一个原料烧一个槽位 |
| 货船的确定性没用来做前瞻规划 | 白丢可精确预测的采购机会 |

---

## 5. 卖货：阶梯、税与供需

### 5.1 价格公式（`R:136-141`）

```js
priceOf(item) = round(BASE_PRICE[item] × marketFactor × supplyFactor × eventFactor)
```

四个乘子：

**① `marketFactor`（`R:118-130`）**：确定性的随机游走 + **季节乘数**

- 当季作物 × **0.92**，反季 × **1.3**
- 岛日时代最终钳位 `[0.65, 1.7]`

> 所以「当季收获的作物卖价天生比反季低 8%」。这是「反季囤货」的理论基础。

**② `supplyFactor`（`R:131-135`）**

```js
supplyFactor = clamp(1.06 - 0.3 × soldYesterday / max(1, normal), 0.8, 1.06)
normal = marketDepth(item) = clamp(1_600_000 / max(1, price), 800, 6000)   // 岛日
normal = 400                                                              // 非岛日
```

> 这是第 25 章第 8 条误解：**分母不是全站昨日销量，而是 `marketDepth`**。

**③ `eventFactor`（`R:237-268`）**：商会事件。例如「甘霖普降」（雨天权重 ×2）让所有作物 ×0.85，虫灾 ×1.4，寒潮只影响冬菜/萝卜/胡萝卜。

**④ 品质倍率**：`QUALITY = [1, 1.25, 1.5]`

### 5.2 `sell` 的完整实现（`R:903-918`）

```js
const unit = Math.round(price × QUALITY[q])
const isCrop = CROPS.some(c => c.id === id)
const soldBefore = isCrop ? count('sc_' + id) : 0
const gross = Math.round((isCrop ? cropTierValue(soldBefore, n, unit) : unit × n)
                         × (ctx.auto ? 1 - AUTO.fee : 1))
const tax = b12TaxSale(s, ctx, coinsLeft(), gross)
const value = gross - tax
if (isCrop) s.cnt['sc_' + id] = soldBefore + n
invTake(s.inv, id, q, n)
```

四个必须注意的点：

1. **`sc_<crop>` 在卖出瞬间累加**，不是自然日切换时才加。自然日切换时 `refresh` 里 `s.cnt = {}` 归零。
2. **只有作物走阶梯价**，鱼/矿/加工品/动物产物都是线性 `unit × n`。
3. **`ctx.auto` 的抽成系数是 `AUTO.fee = 0`** —— 管家代卖实际不抽成（第 25 章第 12 条）。
4. **每日售卖上限已取消**（`R:913` 注释「卖得再多也照常结算」）。

### 5.3 作物阶梯价（`R:88-94`）

**按「每个玩家、每个自然日、每种作物」累计**：

| 当日已卖件数 `before` | 本批单价倍率 |
|---|---|
| `< 150` | 1.00 |
| `150 ~ 399` | 0.85 |
| `>= 400` | 0.70 |

```js
cropTierValue(before, n, unit)   // 分段累加，一批跨档时按档拆
```

> 关键：150/400 的额度是**自然日**额度，一个自然日里的 **3.5 个岛日共享同一份额度**。种 9 块南瓜（每块 ~1.5 个）也只够 13 个，远不到 150 —— 所以阶梯对普通玩家基本不触发，只有大规模单一作物种植时才有意义。

### 5.4 售卖税：边际累进（`R:1638-1654`）

```js
B12_TAX = { free: 3_000_000, high: 10_000_000, subsidyCap: 1_000_000 }

b12Marginal(capital, lowRate, highRate, denom):
  excess = max(0, capital - 3_000_000)
  low  = min(excess, 7_000_000)
  high = excess - low
  return (low × lowRate + high × highRate) / denom

b12SaleQuote(wallet, paid, gross):
  carried = wallet < 3_000_000 ? 0 : paid          // ← 余额不到 300 万时不 carry
  basis   = wallet + carried
  tax     = b12Marginal(basis + gross, 1, 3, 100) - b12Marginal(basis, 1, 3, 100)
  tax     = clamp(tax, 0, min(gross, max(0, wallet + gross - 3_000_000)))

b12TaxSale(s, ctx, wallet, gross):
  day = worldDay(t)                                // ← 自然日，不是岛日
  if (d.tax.day !== day) d.tax = { day, paid: 0 }
  q = b12SaleQuote(wallet, d.tax.paid, gross)
  d.tax.paid = q.carried + q.tax
```

**三层含义**：

| 层 | 区间 | 税率 | 说明 |
|---|---|---|---|
| 余额 + 当日已付 ≤ 300 万 | 免税 | **0** | 这是绝大多数玩家所在的区间 |
| 300万 ~ 1000万 | **1%** | 边际 |
| > 1000万 | **3%** | 边际 |

- `tax` 的上限是 `min(gross, max(0, wallet+gross-3_000_000))` —— **只有超过 300 万的部分才可能被征税**
- `paid` 是**当日累计已付税**，用作下一笔的 `carried`；所以当天卖得越多，后续税率越高
- **`carried` 只在 `wallet >= 3_000_000` 时才生效** —— 余额 300 万以下时，即使当天已经卖了很多，也不把 `paid` 计入 basis

**余额税**（`R:1644`）是另一套独立的税：

```js
b12BalanceTax(balance) = b12Marginal(balance, 1, 3, 1000)   // 1‰ / 3‰，分母 1000
```

按「每天结算一次余额的 1‰/3‰」理解。它和售卖税是**两笔不同的费用**，不要混淆。

### 5.5 对方怎么排售卖（`S` 的 `solveExactItemSaleSchedule`）

参考实现不按「现在能卖就卖」，而是把「什么时候卖哪批货」做成一个**跨岛日的排程问题**：

1. **枚举未来所有可卖槽位**：每个事件桶 + 期末清算桶
2. **对每个槽位算**：`round(price × quality) × 阶梯倍率 × 折现 × 税后系数`
3. **阶梯倍率用该自然日的 `sc_<id>` 已卖数量估计**（`S:1943-1945`）
4. **选最高折现值的槽位**
5. **对未来外部供给做三情景**：tight 1.03 / baseline 0.96 / glut 0.84（`O:72-76`），第一个 `isleDayOffset >= 1` 的 bucket 之后才分支（`S:7471`）

**为什么必须折现**：`sl.disc` 是每个桶的折现因子，因为「今天卖 100 万」和「明天卖 100 万」对现在的价值不同（现金可以立刻投入 capex / 买咖啡）。

**期末清算**：`tEnd` 之后不再有槽位，所有库存必须卖或留作期末价值。参考实现把「留在仓库里的库存」按当时的价折算成期末价值（`model/objective.mjs:1178-1185`）。

**我们的差异**：

| 差异 | 影响 |
|---|---|
| 用未来若干天的**平均价**（`core/market.mjs:616-628`） | 抹平不同成熟日/不同槽位的价差 |
| 不做跨岛日排程 | 不利用「反季 ×1.3」的窗口 |
| 折扣/税率档位估算可能静态 | 大额卖出时低估税率上升 |

---

## 6. 囤货仓库（B26）

### 6.1 站点规则（`R:1504-1545`）

**仓库有 4 级**，存档在 `state.b26`：

| 等级 | 升级价 | 格数 | 每格上限 | 到价提醒 | 到价自动出售 | 特性 |
|---:|---:|---:|---:|---:|---:|---|
| 1 | — | 12 | 300 | 0 | 0 | 基础货架 |
| 2 | 80,000 | 18 | 600 | 8 | 0 | 加石基与二层、行情走势、到价提醒 |
| 3 | 300,000 | 22 | 1,200 | 16 | **8** | 冷库、到价自动出售（管家巡视时执行） |
| 4 | 1,000,000 | 30 | 2,400 | 24 | **16** | 吊车与金招牌 |

**一个关键设计**：`vault` 是 `inv` 的**预留子集**，不是额外库存（`R:1207` 的注释明确写着「inv remains the sole stock ledger. vault is a reserved subset, never extra stock.」）。

所以「存进仓库」的真实含义是**标记为「不要自动卖掉/加工掉」**，物品还在 `inv` 里。

### 6.2 三个仓库动作（`R:1522-1536`）

| 动作 | 最低等级 | 作用 |
|---|---|---|
| `warehouse` | 1 | 设置某物品某品质的预留数量 |
| `whUp` | 1 | 升级仓库 |
| `whAlert` | 2 | 设置到价提醒（只提醒，不自动卖） |
| `whOrder` | 3 | 设置到价自动出售（`{price, n}`） |

**`whOrder` 的一个副作用**（`R:1535`）：

```js
const k12 = b12State(s).keep[id]
if (k12) { k12[q] = 0; if (!k12.some(Boolean)) delete s.b12.keep[id] }
```

**设置自动出售会自动清掉同物品同品质的 b12 预留** —— 因为两者都是「不卖」的标记，语义冲突，服务端选择让自动卖单优先。

### 6.3 自动出售的执行时机（`R:1537-1545`）

```js
b26AutoSell(s, pr, day) {
  if (w.lv < 3) return []                       // ← 3 级才启用
  for (const [key, [price, n]] of Object.entries(w.order)) {
    const [id, qs] = key.split(':'), q = +qs
    if (!(pr[id] >= price)) continue            // ← 当前市场价达到或超过触发价
    const amt = min(n, hidden[id][q], vault[id][q])
    ...
  }
}
```

**只在管家巡视时执行**（`b12ReplenishWarehouse` 之后）。所以：

- 不是「实时到价就自动卖」，而是「管家每 2 小时巡视时，如果价格已经达到就卖」
- 如果价格在你睡觉时冲高又回落，可能错过
- `pr` 是**当前市场价**（含五个乘子），不是基础价

### 6.4 对方怎么处理仓库：**被动尊重，不主动管理**

**参考实现完全没有主动调用 `warehouse` / `whOrder` / `whAlert` / `whUp`** —— 全仓库搜索这几个动作，只有：

- 规则模块里的定义（`R:1522-1536`）
- `test/phase17.4` 的规则同步测试（验证 12 格/300 上限、Lv2 的 600/格）

**它做的唯一一件事，也是在规划器的每一处都做的**（`model/rules-adapter.mjs:239-253`）：

```js
function availableInv(state, id, q) {
  const raw = Number(state?.inv?.[id]?.[q] || 0)
  const reserved = Number(state?.b12?.vault?.[id]?.[q] || 0)
  return Math.max(0, raw - reserved)          // ← 可用 = 库存 − 预留
}
```

**所有规划路径都走 `availableInv`**，所以：

- 卖货不会卖预留的货
- 加工不会用预留的原料
- 喂动物不会吃预留的饲料
- 钓鱼不会用预留的鱼饵（`A:467`）

也就是说，参考实现把 vault 当作**「用户自己设的不可动约束」**，规划器只负责尊重它，不负责管理它。

**这与它的定位一致**：参考实现是一个纯执行器，仓库预留是「玩家自己的决定」，不该被自动程序覆盖。而**我们的实现可以更主动** —— 因为我们要做的是「全自动托管」，包括「什么时候该升级仓库」「什么时候该设到价卖单」。

### 6.5 我们该怎么做（结合参考实现的教训）

| 项 | 建议 |
|---|---|
| `availableInv` 的语义 | **必须**像参考实现一样，所有读库存的地方都减去 `vault`，否则会把预留的货卖掉 |
| 仓库升级 | 80,000 / 300,000 / 1,000,000 应该进 capex 候选，用轨迹差值评估（见 1.9） |
| 到价自动卖单 | 3 级开放，8 条；适合设在「反季 ×1.3 的高价窗口」 |
| 货船确定性 | 用 `worldHash('b12-cargo:...')` 精确预测未来几天的货船，提前规划套利 |
| **不要**主动设 vault 预留 | 除非用户的明确要求；参考实现不这么做是有道理的 —— 自动程序不该替用户决定「哪些货不卖」 |

---

## 7. 升级与扩建

### 7.1 价格表（`R:14-20`）

| 项 | 价格 | 上限 | 效果 |
|---|---|---|---|
| 地块 | `10000 × n`（n 从 7 起） | 24 | 多一块地 |
| 畜栏 | `80000 × n`（n 从 3 起） | 8 | 多一只动物 |
| 蟹笼 | `30000 × n`（n 从 1 起） | 4 | 多一个笼 |
| 小屋 | `[10万, 25万, 60万, 120万, 250万]` | 5 | 每级**体力上限 +20** |
| 鱼竿 `rod` | `[0, 8万, 30万, 100万]` | 4 | 减少跑鱼 + 解锁高级鱼 |
| 镐子 `pick` | `[0, 8万, 30万, 100万]` | 4 | 提高挖矿深度上限 |
| 洒水器 `spr` | `[15万, 50万, 150万]` | 3 | 覆盖前 8/16/24 块地，自动浇水 |

`upgradePrice` 的索引是「升到 lv+1 的价格」（`R:1005-1014`），`house` 用 `housePrice[当前等级]`。

### 7.2 洒水器的价值（`R:470` `R:478` `R:566`）

**不是「省浇水体力」这么简单**：

1. 生长 `total × 0.6`（快 40%）
2. 收获按 `w = 3` 算品质（金星 35%、期望 1.54 个）
3. 完全不需手动浇水

所以 Lv3 洒水器（150 万，覆盖全部 24 块地）的价值远超「省 24 点体力/轮」。

**注意 `sprCover = [0, 8, 16, 24]` 是「覆盖下标 < N 的前 N 块地」** —— 新扩的第 9 块地在 Lv1 时不在覆盖范围。

### 7.3 对方怎么决策（`S:1439-1532`）

见 1.9 的 `selectCapexByTrajectoryDelta`。**所有 capex 候选（地块/蟹笼/动物/洒水器/镐子/鱼竿/小屋）都用同一套轨迹差值评估**，没有硬编码优先级。

**每次求解最多选一个 capex**，后续轮次再评估剩余候选。

**为什么轨迹差值比线性回本更准**：

- 洒水器会**改变作物选择**（自动 0.6 倍 → 更短周期、更高品质、更多连茬），线性估算抓不到这个交互
- 买地会改变**阶梯额度、加工名额、体力分配**
- 小屋的 +20 体力上限会通过体力 DP 影响所有工作的可执行量

**我们的差异**（`core/planner.mjs:1728-1937`）：

| 差异 | 影响 |
|---|---|
| 用 `payback = cost/dailyGain + delayDays`，上限 5 天（`core/config.mjs:60`） | 长期资产可能被误判为不值得 |
| 洒水器按 `covered × 2.5 × min(foodCost,600) × ISLE_PER_DAY` 线性估（`:1831`） | 抓不到「改变作物选择」的交互 |
| 小屋按 `20 × max(600, perEnergy)` 估（`:1928`） | 同上 |
| 按 `payback` 升序，单轮只买 1 项（`:1936`） | 与对方一致 |

## 8. 钓鱼

### 8.1 规则

鱼种表（`rules.js:61`）。**注意：`hours` 是「岛时」，不是北京时间** —— 文件注释写的「北京时间小时」是旧版遗留：

| 鱼 | 价格 | 权重 w | 鱼竿 | 季节 | 岛时 |
|---|---:|---:|---:|---|---|
| 沙丁鱼 | 1,200 | 40 | 1 | 四季 | 0–24 |
| 鲤鱼 | 2,000 | 30 | 1 | 春/秋/冬 | 0–24 |
| 鲈鱼 | 3,600 | 22 | 1 | 夏/秋 | 6–20 |
| 三文鱼 | 7,200 | 14 | 2 | 秋/冬 | 0–24 |
| 鱿鱼 | 8,800 | 12 | 2 | 冬/春 | 18–30（跨岛午夜） |
| 金枪鱼 | 14,500 | 8 | 3 | 夏/冬 | 0–24 |
| 河豚 | 21,000 | 6 | 3 | 夏/春 | 12–20 |
| 迷你鲸 | 96,000 | 1 | 4 | 四季 | 0–24 |

岛时 1 小时 = 现实 10 分钟有效时间（`isleHour = floor((clock % 14400) / 600)`）。鱼池过滤：`rod <= 当前鱼竿` 且季节包含当前岛季且岛时落在区间内，跨午夜用 `h+24` 再判一次（`rules.js:497`）。

**单竿结算**（`rules.js:721`）：

- 体力 4，每日 **80 竿/岛日**，经验 9
- **先计数再判跑鱼** —— 跑鱼也消耗 80 竿配额，也算「钓鱼」目标 1 次（`rules.js:729`）

跑鱼率（`rules.js:732`）：

```js
miss = max(0.05, 0.22 - 0.04*rodLv - (用饵?0.08:0) - (雨天?0.05:0))
```

| 鱼竿 | 基础跑鱼率 |
|---|---:|
| 1 | 18% |
| 2 | 14% |
| 3 | 10% |
| 4 | 6%（下限 5%） |

**贵鱼权重加成**（`rules.js:737`）：

```js
boost = (用饵 ? 2 : 1) * (雨天 ? 1.5 : 1)
// 只乘给 price >= 9000 的鱼
```

> 关键细节：**吃加成的是金枪鱼 14500、河豚 21000、迷你鲸 96000**。三文鱼 7200 和鱿鱼 8800 **不吃**鱼饵/雨天的权重加成，只吃跑鱼率改善。

品质（`rules.js:739`）：`q=2` 概率 `0.08 + 0.05*rodLv`（13%/18%/23%/28%）；否则再掷一次 `<0.28` 为 `q=1`。即**银品质是剩余部分的 28%**，不是绝对 28%。

鱼饵：杂货铺 400 D/个，动作带 `bait:true` 且背包有饵时消耗（规则层不会自动买）。

### 8.2 `expectedFishYieldPerCast` 的公式（`resources.mjs:355`）

```
pool = fishPool(state, atSec, rodLv)
miss = max(0.05, 0.22 - 0.04*rodLv - (useBait?0.08:0) - (rain?0.05:0))
catchProb = 1 - miss
boost = (useBait?2:1) * (rain?1.5:1)
weight(f) = f.w * (f.price>=9000 ? boost : 1)
pGold   = 0.08 + 0.05*rodLv
pSilver = (1 - pGold) * 0.28
pNormal = 1 - pGold - pSilver
byFish[f][q] = catchProb * weight(f)/Σweight * p_q
```

和服务端的两次 `rand()` 语义严格对应：先判金，金不中再判银。

### 8.3 数值量级（基础价、晴天、无商闻）

| 场景 | 单竿期望毛收入 | 每点体力 |
|---|---:|---:|
| 春、竿 1、无饵 | ~1,424 | 356 |
| 春、竿 1、有免费饵 | ~1,563 | 391 |
| 秋、竿 2、白天无饵 | ~2,681 | 670 |
| 夏、竿 3、白天无饵 | ~5,111 | 1,278 |
| 夏、竿 3、买饵（净成本 400） | ~7,379 | 1,845 |
| 夏、竿 3、雨天买饵 | ~8,283 | 2,071 |

**低等级买饵通常不划算**：春季竿 1 买饵只多约 139 D 毛收益，低于 400 D 饵价。规划器的购买条件正是 `valBait - baitPrice*折现 > max(0, valNoBait)`（`solve.mjs:4584`）。

### 8.4 对方怎么决策

1. **每竿价值按当前/未来行情和税费算**，不用基础价；`marginalItemValueFn` 对 q0/q1/q2 分别估值后加总（`solve.mjs:4548`）
2. **和挖矿/炸药/加工共用体力 DP**：钓鱼分「用背包饵」「买饵」「无饵」三种单位，按净收益竞争（`solve.mjs:4573`）
3. **等黄金时段**：如果同一岛日内后面的桶里鱼群期望更高，且**当前体力未满**，本轮先不钓，等后面时段；体力已满时不等（避免浪费回复）（`solve.mjs:4558`）
4. **岛日末清配额**：`fullIsleQuotas` 模式下用整岛日剩余配额 + 当日最高鱼群 EV 做一次性分配（`solve.mjs:4569`）
5. **鱼竿升级**属于 CapEx 候选，走反事实轨迹模拟（`solve.mjs:1412`）。规则上的收益有三块：解锁鱼种、跑鱼率每级 −4pp、金品质每级 +5pp

> 注意：**蟹笼只按鱼竿 1 的鱼池结算**，所以鱼竿升级不会提升蟹笼产出（`rules.js:712`）。

---

## 9. 挖矿

### 9.1 规则

**矿洞结构**：单一矿洞按「层」组织。实际下挖层数（`rules.js:748`）：

```js
floor = max(1, min(请求层 f, s.mine.max, PICK_FLOOR[镐子等级]))
```

请求再深也没用，最多挖到「已解锁最深」和「镐子等级上限」两者较小值。

矿石表（`rules.js:71`）：

| 矿石 | 基础价 | 权重 | 最低层 |
|---|---:|---:|---:|
| 煤 | 480 | 40 | 1 |
| 铜矿 | 900 | 35 | 1 |
| 铁矿 | 1,900 | 25 | 6 |
| 紫水晶 | 7,200 | 6 | 8 |
| 金矿 | 4,200 | 14 | 12 |
| 祖母绿 | 12,000 | 4 | 15 |
| 红宝石 | 18,000 | 3 | 20 |
| 钻石 | 36,000 | 1.2 | 25 |

镐子等级（`rules.js:19` `rules.js:78`）：

| 等级 | 升级价 | 可达最深层 |
|---|---:|---:|
| 1 | 80,000 | 8 |
| 2 | 300,000 | 16 |
| 3 | 1,000,000 | 24 |
| 4 | 满级 | 30 |

**梯子机制**：只有「当前层 == `s.mine.max`」且「`s.mine.max` < 镐子上限」时才可能出梯子。普通挖矿 **25%** 概率 +1 层（`rules.js:762`）；炸药 **60%** 概率 +1 层（`rules.js:789`）。**在非最深层挖矿不会推进深度。**

**单次挖矿**（`rules.js:743`）：

- 体力 3，每日 **100 下/岛日**，经验 6
- **先扣次数再结算产出** —— 没出矿也算一次
- 每次出 1 个，另有 `25% + 5%*镐子等级` 概率多出 1 个 → 期望掉落 `1.25 + 0.05*pickLv`
- 权重（`rules.js:756`）：

```js
weight(o) = o.w
          × (o.price >= 12000 && 天气==雪 ? 1.6 : 1)
          × (1 + (floor - o.floor)/40)
```

> 雪天只加成基础价 **≥12000** 的矿（祖母绿/红宝石/钻石）。紫水晶 7200 和金矿 4200 **不吃**雪天加成。

- 矿石无品质，永远 q=0

**30 层普通天气的实际概率**（按上式计算，总权重 209.575）：

| 矿石 | 概率 |
|---|---:|
| 煤 | 32.93% |
| 铜 | 28.81% |
| 铁 | 19.09% |
| 紫水晶 | 4.44% |
| 金矿 | 9.69% |
| 祖母绿 | 2.62% |
| 红宝石 | 1.79% |
| 钻石 | 0.64% |

**炸药**（`rules.js:780`）：

- 配方 煤×3 + 铜×2，杂货铺直购 2500 D，每日 **10 次/岛日**
- 体力 6，掉落 `6 + 2*(30% + 5%*镐子等级)` ≈ 6.7–7.0 个
- 权重在普通公式上再乘 `price>=7000 ? 1.35 : 1`
- **关键细节**：炸药令 `s.cnt.mine += 6`（推进「敲矿石」目标 6 点），但**不扣 `s.iq.mine` 的每日 100 下配额**（`rules.js:784`）。所以 10 次炸药可以白送 60 点目标进度，不占挖矿次数

### 9.2 每点体力收益量级

| 场景 | 每动作期望 | 每点体力 |
|---|---:|---:|
| 1 层、镐 1 | 879 | 293 |
| 8 层、镐 1/2 | 1,712 | 571 |
| 16 层、镐 2/3 | 2,562 | 854 |
| 24 层、镐 3 | 3,096 | 1,032 |
| 30 层、镐 4 | 3,444 | 1,148 |
| 30 层、雪天、镐 4 | 4,076 | 1,359 |

炸药：1 层约 755 D/体力，30 层约 3,152，30 层雪天约 3,796。**炸药是最高单位体力产出**，但受每日 10 次和炸药库存限制。

### 9.3 对方怎么决策

1. 挖矿和加工、炸药、钓鱼一起进入同一个「体力 × 现金」背包 DP，按边际收益/体力竞争，**不是固定优先级**（`solve.mjs:4483`）
2. 当付费单位（买炸药、买鱼饵）可能超现金时，改用精确二维 `(体力, 现金)` DP，保证不超预算（`solve.mjs:4666`）
3. 执行阶段把所有随机动作按单位体力收益从高到低排序：炸药组 → 钓鱼组 → 挖矿组（`solve.mjs:6722`）
4. **挖矿没有「等时段」逻辑** —— 产出只受深度/雪天影响，不受岛时影响。它通常是钓鱼、加工、农务之后的剩余体力去处
5. 真正的约束是 `effectiveShiftableFloor`：农务、牧场、未来偷菜波次先锁体力，挖矿不能把体力花到该下限以下（`solve.mjs:6418`）

**镐子升级的估值**：升级本身**不改变当前层权重**，只是把可达上限从 8 提到 16/24/30；升级后还要靠 25% 的梯子一层层推上去。所以升级的收益是「未来深度的期权」，不是立即加成。

> 参考实现的建模缺口：`expectedMineYieldPerHit` **不包含「本次命中可能 +1 层」的期权价值**。当 `s.mine.max` 正好卡在镐子上限时，均值函数会低估升级价值，只能靠 CapEx 反事实模拟里的实际梯子随机分支补偿（`rules-adapter.mjs:508` 枚举了梯子分支）。

---

## 10. 蟹笼

### 10.1 规则

- 上限 4 个，第 n 个价格 `30000*n`（30k/60k/90k/120k）
- 每笼每 **180 分钟**产 1 条鱼，窝容量 **4 条**
- **大风天产量翻倍**（`rules.js:485`）：`n = min(cap, floor(elapsed/10800) * (windy?2:1))`
- **收笼不耗体力**（`WORLD.cost` 里没有 `trap`），也不计每日次数
- 鱼池固定按**鱼竿 1** 过滤，品质固定 q=0（`rules.js:713`）
- 收笼后重置计时：没满时按已收数量推进整数周期；**满了则直接以当前时间为新起点，丢掉溢出进度**（`rules.js:718`）

> **天气在收笼时刻一次性乘 2**，不是按经过时段逐段计算。所以大风当天再收笼，会把之前累计的时间整体按双倍结算。

### 10.2 价值估算（按鱼竿 1 鱼池）

| 季节/时段 | 鱼池 | 单鱼期望 | 单笼每小时 | 4 笼每小时 |
|---|---|---:|---:|---:|
| 春、冬全天 | 沙丁40 + 鲤鱼30 | 1,543 | 514 | 2,057 |
| 夏 6–20 岛时 | 沙丁40 + 鲈鱼22 | 2,052 | 684 | 2,736 |
| 夏 20–6 岛时 | 沙丁 40 | 1,200 | 400 | 1,600 |
| 秋 6–20 岛时 | 沙丁 + 鲤鱼 + 鲈鱼 | 2,035 | 678 | 2,713 |

**单笼回本时间**：春季约 58 小时、夏季白天约 44 小时 —— 正好落在默认 72 小时 CapEx 回本窗口内。但实际购买仍由反事实轨迹模拟决定，不用静态 ROI。

### 10.3 对方怎么安排

- **放置**：`buyTrap` 是 CapEx 候选；被选中后作为 bucket 0 的预选 CapEx 动作执行（`solve.mjs:2233`）。动作本身 0 体力但占 1 个动作槽
- **收取**：每个事件桶开始时，先把所有 `n>0` 的蟹笼收掉（`solve.mjs:2238`）。0 体力，所以总是排在其它消耗体力的动作之前
- **满了怎么办**：没有额外补偿，超过 4 条直接丢失。靠「醒来时间」减少损失 —— 事件轴把「笼子即将 ready」作为下一次唤醒时间（`compile-prefix.mjs:192`）
- **和编译器的关系**：`trap` 被归入「收集型随机动作」，可以先和 harvest/collect 一起批处理，再接着做不依赖随机产物的照料动作；但之后依赖鱼库存的 sell/craft/eat 必须等回执（`compile-prefix.mjs:59`）

## 11. 偷菜（出访）

> 下面 `R:...` 指规则模块，`S:...` 指 `planner/solve.mjs`，`O:...` 指 `model/observations.mjs`，`N:...` 指 `execution/snipe-scheduler.mjs`，`C:...` 指 `execution/combat-engine.mjs`。

### 11.1 站点规则

**两条协议**（`docs/MODULES.md:557-567`）：

- `GET /api/pet/world/visit/:id` 拿目标快照（不花体力、不节流）
- `POST /api/pet/world/visit/:id {operation, kind:'all', i:0}` 执行一次出访

**回执里的 `rules`** 是权威值，不写死（`N:349-351`）：

| 字段 | 线上值 | 含义 |
|---|---:|---|
| `protect` | 1800 | 成熟后保护期（秒） |
| `perPlot` / `perPen` | 2 / 2 | 每块地/每栏每茬最多被偷 2 个 |
| `daily` / `perOwner` | 999 / 999 | 全服/每家每日上限（实际不约束） |
| `energy` / `perSpot` / `energyMax` | 5 / 1 / 15 | 出访基础体力 + 每多一处 +1，单次封顶 15 |
| `fineMax` / `fineDaily` | 5000 / 20000 | 单次罚款上限 / 每日罚款上限 |
| `homeHp` | 1.1 | 守家方 +10% 生命 |
| `caught` | 0.55 | 基础发现率 |
| `active` | 259200 | 目录只保留 3 天内活跃的岛 |
| `newbieDays` | 1 | 新手 24 小时不可互动 |

注意 `energyMax: 15` 是**单次出访**的体力封顶，不是人物体力上限（那是 `100 + 20×房屋等级`）。

**发现率**（`R:196-199`）：

```js
b12Detection(owner, visitor, t) = clamp(0.55
  + GUARD_ITEMS[守卫道具].detect
  + (偷菜道具.legacy ? -0.15 : THIEF_ITEMS[道具].detect)
  + clamp(好友协防, 0, 0.06), 0.35, 0.75)
```

道具：守家 —— 潮铃 +10%、贝壳护具 hp+8%、珊瑚挡板 def+4、萤火灯 +6%；偷菜 —— 轻步斗篷 −10%、风声口哨 −6% 且**每次少耗 1 体力**、折叠菜篮每处多拿 1 个（`R:175-185`）。好友协防**总加成夹在 +0.06**，不是「每个好友 +5% 最多 +15%」（文档口径与代码不一致，以代码为准）。

**偷菜体力**（`R:200-202`）：

```js
b12StealCost = max(1, min(15, 5 + (spots-1)*1) - 口哨体力减免)
```

**罚款**：规则文件里没有独立常量，按 UI 文档「基础货值 × 1.2，封顶 5000」建模（`O:517`）。**参考实现没有实现 `fineDaily = 20000` 的累计账本**（已知简化，单目标决策不需要）。

**结算时的罚款夹取**：服务端不会让你负余额，回放里把罚款夹到当前持有的 D 币（`S:7370-7376`）。

### 11.2 对方怎么估值：四分支 × 三种口径

**不把「有守家」简化成一个胜率**，而是展开为四个互斥分支（`O:352-451`）：

```js
const pDet = hasGuard ? detectionProb : 0, pUndet = 1 - pDet
const useConservative = mode === 'conservative'
  || (mode === 'auto' && vb.estimationSource === 'unobserved-wide-prior')
const wCond = !hasGuard ? 1 : (useConservative ? wLo : (useOptimistic ? wHi : wMid))
const lCond = !hasGuard ? 0 : (useConservative ? lHi : (useOptimistic ? lLo : lMid))

const rawOutcomes = [
  { kind:'undetected', prob: pUndet,       lootBag: undetBag, fineCoins: 0 },
  { kind:'guard-win',  prob: pDet*wCond,   lootBag: winBag,   fineCoins: 0 },
  { kind:'guard-tie',  prob: pDet*dCond,   lootBag: {},       fineCoins: 0 },
  { kind:'guard-loss', prob: pDet*lCond,   lootBag: {},       fineCoins: estFine },
]
```

**三种口径的切换规则**：

| `estimationSource` | 何时 | 用哪组 |
|---|---|---|
| `no-guard-deterministic` | 没有守家 | 必胜，根本不进战斗分支 |
| `empirical-posterior-interval` | 有真实战报/CRN 模拟 | `wMid`（区间中点） |
| `unobserved-wide-prior` | 有守家但从没见过战斗数据 | **强制 `wLo` 保守** |

**Wilson 区间**（`C:40-47` `C:975-1026`）：用 z = 1.28（约 90% 置信）给出胜率/败率区间。守家强度用 `computeGuardPosteriorForTarget` 跑 **CRN（公共随机数）蒙特卡洛**模拟，保证不同候选的模拟可比。线上守护战报也会被 shadow-daemon 换算成 Wilson 后验作为兜底。

**保守/乐观双端**（`S:10711-10721`）：

```js
evLo = pUndet*wUndetExpected + pDet*(wLo*wGuardWinExpected + (dLo+lHi)*wEmptyExpected - lHi*fine) - curEnsembleVal
evHi = ... wHi / (dHi+lLo) / lLo ...
evMid = ... wMid / (dMid+lMid) / lMid ...
decisionScore = estimationSource === 'unobserved-wide-prior' ? evLo : evMid
```

注意 `wEmptyExpected` 覆盖「平局或战败但没罚款的库存」，罚款按 `lHi/lLo/lMid` **单独扣一次**，避免重复扣。

**统一目标函数**：真正的估值入口 `evaluateMarginalRaidDelta`（`S:10131-10546`）把战利品加入库存、扣体力、扣罚款与 buff 花费，返回「库存与制作增量 + 体力增量 − 现金支出」。也就是说**偷菜必须与「这些体力本来能挖矿/钓鱼/制作」竞争**，不是孤立算货值。

**BUFF 组合**：`buildThiefBuffCombinations`（`S:7066-7093`）枚举同槽互斥的组合，剩余时间 > 1800 秒的同 buff 不重复买。

**赛前补体力**：`findCheapestRaidStaminaPrep`（`S:7095-7184`）循环最多 12 步，每步选当前最便宜且可行的补法（背包作物按 CPE = 单位报价/回复量、库存零食 CPE=0、商店可买的、咖啡按 `price/energy` 并检查每日杯数与现金下限），直到达标或无解。带机会成本版本 `prepareRaidStaminaWithOppCost`（`S:7240-7351`）会把吃掉本来要卖/进制作链的作物差额计为 `oppCost`，咖啡价格乘桶折现 `bucketDisc`。

**绝对不允许「顺带偷一个负 EV 的岛」**：每一步都要求 `decisionScore > 1e-6`（`S:10723-10725`）。

### 11.3 对方怎么发现目标：增量切片

**持久游标**（`N:38-46`）：`discoveryCursor` / `lastMarkedSyncAtSec` / `targets` 三个字段持久化。

`runIncrementalDiscoverySlice`（`N:1594-1718`）的完整流程：

1. **先判抢占**：`shouldBlockBackgroundWork(now, 50)` —— 已有可偷目标或 50 秒内有确切解禁目标，直接返回 `preempted-by-snipe`，**一个 HTTP 请求都不发**
2. **目录候选打分**（`N:1613-1633`）：跳过自己/新手/已封禁；优先级 = 「可偷数量达阈值 +100 / 未建档 +30 / 到探测时刻 +20」
3. **已建档但到点的目标先入池**（`N:1635-1648`）：优先级 `50 + (即将解禁 ? 40 : 0)`，避免「正在长、快到解禁」的岛被目录页序淹没
4. **标记列表每 180 秒同步**：`GET /neighbors/marked?limit=20&q=`
5. **目录只翻 2 页 × 20 条**，游标从上次中断处继续；遇「列表已更新」错误就重置游标（`N:1660-1679`）
6. **只探测优先级最高的 4 家**（`N:1681`），每次探测后立即 `recordVisitSnapshot`
7. **发现可偷即早退**：返回 `ready-target-found`，让控制器 1 秒内进入狙击（`N:1697`）

对比我们的 `refreshWatchList`：默认扫 60 页、无持久游标、每轮从头扫。我们靠「部分失败合并旧名单」解决中断问题（`core/social.mjs:603-628`），参考实现靠「游标 + 只翻 2 页」根本不会中断在第 3 页。

两边共同的原则：**目录里的 `plots/pens` 只是发现线索，权威事实一定来自 `GET /visit/:id`**。

### 11.4 对方怎么掐点：`T_prep` 物理提前量

不是固定 8 秒，而是把「拉世界状态、补体力 POST、换装 POST、请求冷却」全部串起来（`N:218-241`）：

```
T_prep = worldCheckSec      (rtt + 0.35)
       + actPrepSec         (剩余 act 冷却 + minGap + rtt + 0.5)
       + gearPrepSec        (剩余 equip 冷却 + rtt + 换装件数 × max(1.25, rtt+0.35) + 0.6)
       + remVisitCdSec      (剩余 visit 冷却)
       + 1.0                (余量)
```

`rtt = clamp(lastRttMs/1000, 0.5, 2.0)`。

**执行阶段的严格因果顺序**（`N:1184-1586`）：

1. 入口窗口检查：`lead > ceil(T_prep+2)` 直接返回 `no-imminent-snipe`
2. 守家日志补同步：若上次战报没带对方面板，先同步再用最新世界重算；重算后既不可偷也不未来可偷 → 封 600 秒
3. 睡到 `unlockAt − T_prep`，然后**拉最新世界**、同步时钟、reconcile 未决 `unknown`
4. 手动游乐馆让位检查
5. 偷菜预算检查（默认每岛日最多 3 次）
6. **已提交契约快路径**：验证解禁时刻误差 ≤2 秒、spots 未掉、buff 仍可买且未过期、体力可补足、现金不低于下限 —— 全过才复用，否则降级重评
7. **统一重评兜底**：用 live bundle 重算后验，负 EV 直接撤掉
8. 体力仍不足 → 不硬上，冷却到 `unlockAt+15`
9. **赛前准备作为独立事务**：`POST /act {reason:'staged-snipe-prep'}`，只有 `confirmed` 才继续
10. 换装提前量：睡到 `unlockAt − gearLeadSec`
11. **访问事务**：`waitBeforeSendFn` 睡到 `T_unlock + 25ms` 再发 `/visit/:id`

测试 `phase7:420+` 硬性约束：prep 必须在 equip 之前、equip 必须在 unlock 之前、visit 在 unlock 之后 25~100ms 内发出、不允许多余的 GET。

我们的是秒级窗口（`core/steal-schedule.mjs` 的 `prepLeadSec`），没有毫秒级 sleep，也没有预提交的装备事务。

### 11.5 回执状态机（`N:761-930`）

| 条件 | 动作 |
|---|---|
| 文案匹配 `/上限\|今天偷过\|新手/` | 封到下一个自然日 0 点，清空未来波次 |
| 409 且「发送时刻在推算边界之前/当刻」且 `\|now−prev\|≤2` 且未重试过 | `earlyRetryCount=1`，把 `expectedUnlockAt` 推到 `max(now+1, prev+1)`，**不在函数里重发** |
| 其他拒绝 | 90 秒冷却、可偷数清零；原解禁时刻已过则推进下一波（不扣 `ownerLeft`）；没有未来波次则删 live bundle 触发重规划 |
| `lose` | `lossCount+1`；回执没有 `battle` 面板则 `needsGuardLogSync=true`；冷却 5 秒；有面板则立即重算 EV。**没有两连败禁令** |
| `win` | `lossCount=0`；推进下一波并扣一次 `ownerLeft`；没有下一波则 `nextProbeAt=now+300` |
| 平局 | 只加 4 秒冷却，spots 保留 |

**409 分支的关键细节**：比较的是**实际发送时刻**与推算的解禁秒边界 + 250ms，不是响应到达时刻。只有确认是「在边界前或边界当刻发出」且偏差 ≤2 秒，才认为是服务器时钟截断抖动。

**「打输不封禁」是设计选择不是遗漏**：状态机只在两种机械原因下封岛 —— `ownerLeft<=0`（每日上限）和「同步守家日志后 EV 仍为负」。连续的 RNG 战斗失败绝不触发 20 分钟封禁。测试 `phase7:282+` 明确断言「不存在 two-loss ban」。

**unknown 的 reconcile**（`N:901-930` `execution/reconcile.mjs:109-355`）：访问超时记为 `unknown`，下次执行前先用新世界快照对账；推断为守家战败则标记 `needsGuardLogSync`。设计意图是「不确定是否已扣次数」→「保守占用预算 + 下次先对账」。

### 11.6 多波次（`N:498-593` `N:700-759`）

- 波数上限 `maxWavesForOwner = min(3, max(1, ownerLeft))` —— **权威上限来自回执的 `left.owner`**，不是本地自己数
- 同岛两波至少间隔 **15 秒**（「准备 + 提交 + 换装」的最小物理间隔）
- 每波把已认领的 spot 从后续波移除（`claimedPlotSet` / `claimedPenSet`）
- 只有 `profitable && totalSpots >= minStealSpots && decisionScore > 0` 的波才保留
- 打赢后 `_advanceEntryToNextWave`：扣 `ownerLeft`、下一波必须 `unlockAt >= max(now+6, completedUnlockAt+10)`、设置 `nextProbeAt = max(now+10, next.unlockAt−40)`

我们的 `advanceIsleWave`（`core/steal-schedule.mjs`）同构，`maxWaves` 默认 2（参考实现允许 3）。

### 11.7 体力预留：狙击优先于生产（`N:1042-1071`）

```js
needAtUnlock = min(15, max(6, projectedEnergyCost))
naturalRegen = floor(lead / regen)            // regen = 180 秒
floorNow = min(enMax, max(0, needAtUnlock - naturalRegen))
return { staminaReserveFloor: floorNow, staminaReserveUntilSec: unlockAt }
```

这个 floor 写进 `constraints.staminaReserveFloor`，然后在规划器里生效：

- 每个 bucket 在 `b.atSec < staminaReserveUntilSec` 时把 `bucketEnFloor` 提升到 floor，**背包与补体力都不能把体力花到该下限以下**（`S:4797-4804`）
- `nextWakeSec` 也考虑 `plannedPostBucketEnFloor`，避免「醒来时体力被生产花光、错过解禁」（`S:9766`）

测试 `phase7:608+` 验证「有狙击预留时挖矿会被挡住」。我们的 `snipeStaminaReservation` 同构（`core/steal-schedule.mjs:615`）。

---

## 12. 守家与罚款

### 12.1 站点规则

- 是否有守家由 `owner.guard` / `isle.guard` 决定。**有守家才进三结局**（胜/平/负）；无守家时 `winInterval=[1,1]`、`lossInterval=[0,0]`（`O:503-515`）
- 守家方主场生命 **+10%**（`homeHp: 1.1`）
- 战败按 UI 文档「基础货值 × 1.2，封顶 5000」赔（`fineMax`），每日累计上限 `fineDaily = 20000`
- 罚款夹到当前持有 D 币，不会负余额

### 12.2 对方怎么估守家强度

`computeGuardPosteriorForTarget`（`C:975-1026`）跑 **CRN 蒙特卡洛**：

- 用公共随机数保证不同候选的模拟结果可比（同一随机种子序列）
- 输出胜率/败率的 **Wilson 区间**（z = 1.28）
- 用 `estimationSource` 三态决定用区间下端还是中点（见 11.2）

线上守护战报也会被 `shadow-daemon` 换算成 Wilson 后验兜底（`cli/shadow-daemon.mjs:52-102`）。

### 12.3 什么时候放弃一个目标

只有两种机械原因（`N:595-604` `N:1223-1249`）：

1. `ownerLeft <= 0`（每日上限）→ 封到下一个自然日
2. **同步守家日志后 EV 仍为负** → 封 600 秒

**绝不用「连败 N 次」封岛** —— 那是把 RNG 波动误读成目标变强。我们的 `classifyStealReject` 与之一致。

---

## 13. 帮忙

### 13.1 站点规则

`POST /api/pet/world/help/:id {operation}`，回执 `{result:{done,coins,xp,aff,affGain,lv,energy,owner}, ...}`（`core/social.mjs:144-153`）。

- 每次 **1 体力 → 200 D + 2 经验**，另加亲密度（每人每天最多 +5）
- 每天最多 **10 家**
- 独立的 **帮忙币每日上限 4000 D**
- 新手 24 小时不可互动

**一个关键陷阱**：回执里的 `state` 是**对方岛**的状态，不能覆盖自己的 world。本地实现只置 `world.revDirty=true`，下次再拉（`core/social.mjs:146-152`）。

### 13.2 参考实现：**没有帮忙决策**

`yuyugu-kernel` 只在 HTTP 层把 `/help/:id` 识别为非幂等写，分配 `world-help` 限速桶、最小间隔 2200ms（`execution/http-client.mjs:11-16` `:117`）。**没有 `helpDaily`、没有「帮谁/何时帮」的规划函数**。事务层注释提到 visit 的偷菜/帮忙共享预算，但那只是通用机制（`execution/reconcile.mjs:460`）。

所以这部分只能看我们自己的实现。

### 13.3 我们的 `helpDaily`（`core/social.mjs:159-252`）

**两层上限**：

- 家数上限 `perDay = 10`
- D 币上限 `HELP_DAILY_CAP = 4000`，从 `world.state.cnt.helpCoin` 读今日已得

> 曾有过真事故：到顶后服务端只扣体力不给钱，11-13 有六家一共烧了 31 点体力换 0 D。所以到顶必须停。

**能不能帮以服务端 `canHelp` 为准，不用 `plots+pens>0`**：

> 实测 120 个邻居里 `canHelp=true` 有 118 个，而 `plots+pens>0` 只有 2 个 —— 旧判断跳过了 116 个本可以帮的岛。这是「目录字段语义错误导致功能几乎全废」的典型案例。

**其它细节**：

- 体力门槛 `minEnergy = 5`（`core/config.mjs:307`），按「体力档次变化」打日志避免连续静默跳过
- 每次 POST 后 `sleep(1200)`
- 409 或「今天帮过/已经帮/上限/额度」→ 记入 `memoHelp` 不再重试
- **狙击窗口内整轮跳过**（`core/engine.mjs:730-745`）—— 一次帮忙占 2.15 秒串行写带宽，可能把访问请求推到窗口外
- 连续帮不到人 → `helpStall` 累加 → 规划器退避到 900 秒，不每 60 秒空扫 8 页目录

**帮谁的优先级**：目录顺序（服务端已按活跃度/推荐排序）+ 跳过规则。因为边际收益几乎是常数（1 体力 → 200 D），帮谁都一样，关键是**尽快用满 10 家**。

## 14. 擂台

> `B:...` 指 `rules/pet-battle-rules.json`，`C:...` 指 `execution/combat-engine.mjs`，`PB:...` 指 `execution/pet-and-battle.mjs`。

### 14.1 站点规则

- 每日 **30 场**，前 30 场有掉落；两场间隔至少 **8 秒**
- 胜/平/负 分别给 **15 / 8 / 5** 点站宠经验；掉落概率约 **25% / 15% / 10%**（`research/live-05a5c445/pet-battle.js:306`）
- **宝箱**：每 3 场发 1 个、每天最多 5 个；每个必出一件装备，传说约 8%，**连续 10 次必出传说**（`:285`）
- 两种开法：首页 `home.chests` 里带 `tier` 的用 `POST /battle/chest {tier}`；每日进度宝箱用 `POST /battle/chest {}`
- 突破训练三档费用 30 / 45 / 60（合计 13,500 D），加的是**站宠经验**不是擂台经验
- 装备只按基础属性的 **30%** 生效，每强化 +1 再乘 `1 + 0.04×enh`，强化上限 +10

### 14.2 成长公式（`B:2-22`）

| 属性 | 每级成长 | 每点加点 | 加点键 |
|---|---:|---:|---|
| hp | +5 | +4 | vit |
| atk | +0.7 | +0.4 | str |
| def | **0** | **0** | **null（无）** |
| agi | +0.5 | +0.4 | agi |
| spd | +0.5 | +0.4 | spd |

```
面板 = round(基础值 + (等级-1)×levelGrowth + 加点×pointMult
            + Σ 每件装备属性 × 0.30 × (1 + 0.04×强化))
```

**`def` 没有加点通道** —— `pointKey.def` 是 `null`（`B:16-22`），区间构造时也被强制成 `{lo:0,hi:0}`（`C:321-324`）。所以防御只能来自装备和等级。

**站点还给每只宠一个 ±10% 的天赋浮动**（`pet-battle.js:307`），所以同一套装备、同一等级的面板不一定完全相同 —— 这是后面「观测面板反推区间」机制存在的原因。

### 14.3 技能表（`B:23-64`）

**通用 20 招**按表顺序从强到弱尝试（等级不够的跳过）：

| id | 等级 | 概率 | kind | power | 附加 |
|---|---:|---:|---|---:|---|
| think | 50 | 0.08 | focus | 0 | 下一次攻击必暴 |
| token | 40 | 0.08 | drain | 1.3 | 吸血 0.5 |
| maid | 30 | 0.08 | evade | 0 | 2 回合闪避 |
| bloom | 25 | 0.08 | heal | 0.12 | 额外护盾 0.08 |
| zoo | 20 | 0.08 | hit | 0.45×4 | 四段 |
| lion | 18 | 0.09 | hit | 1.9 | 单段 |
| violin | 16 | 0.09 | stun | 0.9 | 眩晕 0.45 |
| juggle | 14 | 0.10 | hit | 0.5×3 | 三段 |
| hotpot | 12 | 0.11 | burn | 0.8 | 灼烧 0.25×3 |
| whale | 10 | 0.08 | hit | 2.1 | 单段 |
| balloon | 9 | 0.10 | shield | 0.14 | 护盾 |
| poker | 8 | 0.12 | weak | 0.9 | 削弱 0.2×2 |
| cat | 7 | 0.10 | heal | 0.08 | 净化负面 |
| overtime | 6 | 0.12 | crit | 1.05 | 必暴 |
| firework | 5 | 0.12 | hit | 1.6 | 单段 |
| crab | 4 | 0.14 | hit | 0.62×2 | 两段 |
| bubble | 3 | 0.15 | stun | 1.15 | 眩晕 0.25 |
| snack | 2 | 0.12 | heal | 0.10 | 治疗 |
| pout | 1 | 0.20 | hit | 1.35 | 单段 |
| tail | 1 | 1.00 | hit | 1.0 | 兜底普攻 |

**18 个武器技能**（"w-" + 武器 id）触发时**优先于通用招式**。最有价值的是 `w-lion`（crit，必暴，power 1.2）和 `w-fireworks`（hit，1.8）。

**`pickSkill` 的跳过规则**（`C:49-65`）：满血跳过治疗、已有护盾跳过护盾、对手已灼烧跳过灼烧、自己已在闪避/集气时跳过对应技能。最后返回 `tail`。

### 14.4 单场战斗模拟（`C:81-221`）

每方状态 `{hp, sh, stun, weak, weakMul, burn, burnDmg, evade, focus, revived}`。

**出手顺序**（`C:101-111`）：第 1 回合若只有一方有 `passive.first` 则该方先手；否则 spd 高者先手；相同则掷硬币。

**每次行动开始时**（`C:113-130`）：

1. 先结算自身灼烧（`burn--` + `burnDmg`，可能直接死）
2. 若被眩晕：消耗本回合，`stun=false`
3. 否则选招

> 灼烧在眩晕**之前**结算 —— 眩晕不能阻止灼烧伤害。

**伤害公式**（`C:163-181`）：

```js
dodgeChance = clamp(0.04 + (对手agi - 我agi)*0.006 + 被动闪避 + (对手在闪避状态 ? 0.25 : 0), 0.02, 0.40)
critChance  = min(0.35, 0.10 + 我agi*0.003)
defMul      = 100 / (100 + 对手def)        // ← 不是百分比减伤；def=100 时伤害减半
dmg = max(1, round(atkEff × power × (0.6+rand×0.8) × (暴击?1.7:1) × defMul))
```

四个容易看错的点：

- **闪避是每一段独立判定**。多段技能可以只中一段，也可能全空；只有 `anyHit` 才附加眩晕/削弱/灼烧/吸血（`C:174-199`）
- **`crit` 类技能让所有段都暴击**（`sk.kind==='crit'` 在每段都成立），而 `focus` 只让第一段必暴（条件带 `h===0`）
- 伤害下限是 1，永不出现 0
- 护盾先吸收再扣 HP（`C:68-76`）

**附加效果**（`C:184-198`）：灼烧伤害基于攻击者的 `atkEff`（不是固定值）；吸血和 `passive.lifesteal` 可叠加；反伤 `thorns` 和反击 `counter` 在命中后触发。

**20 回合结束**按**剩余 HP 占最大 HP 的比例**判胜负，不是绝对值（`C:218-220`）。

### 14.5 `simulateMatchup`：CRN 公共随机数（`C:223-258`）

```js
for (let i = 0; i < n; i++) {
  const me = isFn ? meOrSampler((i + 0.5) / n) : meOrSampler   // 分层采样面板
  const rng = mulberry32((seed + Math.imul(i, 0x9e3779b9)) >>> 0)   // ← 同一 seed 同一局号 = 同一随机序列
  ...
}
```

**为什么必须用 CRN**：`pickOptimalLoadout` 对每个装备组合都用**同一个 seed** 调 `simulateMatchup`（`C:892` `C:899-903`）。这样 A 装备和 B 装备在第 i 局面对的是同一组闪避/暴击/随机浮动，**两者的差异主要来自装备本身而不是随机数**，配对差的方差显著变小，`calcPairedSe` 才有意义。

**效用函数按模式区分**：

```js
arena: win 1.0 / draw 0.5 / loss 0.0    → utility = winRate + 0.5×drawRate
guard: win 1.0 / draw 0.0 / loss -0.2   → utility = winRate - 0.2×lossRate
```

守家给失败 −0.2 是因为守家失败会丢货/罚款，不能和「平局不赚不亏」等价。

### 14.6 观测面板反推区间（`C:287-435`）

站点只返回面板的 `breakdown.total`，不告诉「基础值/加点/装备浮动」各是多少。参考实现的处理：

1. **观测键** = `charmId:charmEnh:level|w:武器id:enh|a:护甲id:enh|p:str,vit,agi,spd`（`C:287`）
2. **区间反推**：`baseBounds = [base-0.4999, base+0.4999]` 与 `[total-0.4999-加点-curFloat, ...]` 求交（`C:312-369`）
3. **用历史观测继续收紧**：对每个同等级观测，减去当时的加点和装备浮动，得到候选基础值区间，与当前区间求交
4. **命中观测键就返回精确面板**（`C:419`），否则用 `atQuantile(q)` 在区间内**分层采样**（`C:426-435`）

这是解决「不知道真实基础面板」的标准做法：先反推一个区间，再用历史观测收窄，最后在区间内分层采样让模拟对不确定性做平均。

### 14.7 装备评分与候选组合

**`scoreGearItem`（`C:453-472`）**：

```js
statMult = 0.30 × (1 + 0.04×enh)
statScore = (atk×10 + spd×8 + agi×8 + def×3 + hp×0.5) × statMult

pasBonus = revive ? value×1200 : lifesteal ? value×620 : counter ? value×320 : 有被动 ? 35 : 0
skillBonus = 武器技能是 crit ? 30 : (有技能 ? 18 : 0)
rarityAndSkill = rarity×15 + skillBonus

score = statScore + pasBonus + rarityAndSkill
```

权重背后的逻辑：攻击直接决定伤害 → 10；速度和敏捷都影响先手/暴击/闪避 → 8；防御只减伤且没有加点通道 → 3；生命只影响生存 → 0.5。**复活按 1200 倍估值**，因为它能把一场必败变成第二条命。

**这个分数不是胜率**，只是静止装选择和候选池剪枝的启发式（`C:450-452`）。真正的取舍仍由 `simulateMatchup` 决定。

**候选组合（`C:792-831`）**：武器前 4、护甲前 3、护符前 5，把静止装插到各自列表最前面，再做完整笛卡尔积 → **最多 120 套**。三槽位全枚举，不需要贪心或梯度。

### 14.8 加点算法：断点式加 STR（`C:478-621`）

**为什么不全堆一项**：每点 str 给 0.4 atk，但面板是整数。attack 从 42.0 到 42.4 时显示值可能仍是 42；只有跨过某个 0.5 边界，整数面板才 +1。所以把点数集中到**刚好跨过整数边界**的位置，收益最高。

```
普通武器 STR_BREAKPOINTS     = [3,5,8,10,13,15,18,20,23,25,28,30,33,35,38,40,43,45]
零速必暴武器              = [2,4,7,9,12,14,17,19,22,24,26,29,32,34,37,39,42,44]
13 级以上零速必暴：先走早期 [2,4,7,9,12,14,17,19,22,24]，然后把 vit 补到 8，
                      再走后期 [26,29,32,34,37,39,42,44]
```

到达断点后如果还有剩余点数，就继续往下一个断点走；**一旦下个断点跨不过去，把剩余点全部给 vit**（`C:595-608`）—— 因为 str 的边际收益在断点之间是 0，而 vit 每点稳定给 4 HP。

**「零速必暴武器」的处理**（典型是舞狮头这类：技能是 crit，但装备本身不加 spd）：

- 必暴只保证「打中时暴击」，不保证「能先出手」。如果速度比对手低，可能还没出手就被打死。
- 所以先补 spd 到 `minSpdPts`（默认 3；零速必暴武器是 4，已穿着且面板 spd < 19 时是 `min(6, cur+1)`，≥19 就不再加）
- 如果补到 4 后还剩至少 2 点，预留 `reserveForSpdObs = 2`，等穿上武器观测到真实面板后再花

**`agi` 永远不加** —— 代码里只给 `points.spd` / `points.str` / `points.vit` 赋值（`C:496-608`）。因为 agi 的收益被闪避公式和 0.4 的加点系数摊薄，不如把攻击堆到整数断点。

**为什么要多轮加点**：穿上零速必暴武器后 `spd.total` / `atk.total` 才可观测；第一轮可能因为「还没穿武器」而预留了 `reserveForSpdObs`，穿上后第二轮才把预留点花到下一个断点。参考实现因此做**两轮**（`PB:374-385`）。

### 14.9 换装的统计门槛（`C:842-948`）

```js
rawGain = bestOut.utility - baseOut.utility
se      = calcPairedSe(bestOut.utilities, baseOut.utilities)    // 配对标准误
zScore  = se > 0 ? rawGain / se : (rawGain > 0 ? Infinity : 0)

只有 best != fallback && rawGain >= minGain(0.005) && zScore >= zThreshold(2.0) 才真正换
```

两个条件必须**同时**满足：

- 只过 `minGain` 不过 `z`：提升可能只是噪音
- 只过 `z` 不过 `minGain`：统计上显著，但实际只提升 0.1%，不值得多发几次换装 POST、承担换装失败和装备未恢复的风险

**没有对手档案就不换装**（`C:874-884` 返回 `unknown-opponent`）—— 避免「没有对手信息还乱换装」。

**等效用时选换装件数更少的**（`C:912`）。

### 14.10 选对手（`PB:420-434`）

```js
candidates = opponents.filter(o => o.id != null && (o.left == null || o.left > 0) && !excludeIds.has(o.id))
candidates.sort((a,b) => (a.level - b.level) || (a.power - b.power) || (a.id - b.id))
return candidates[0]
```

**只按等级升序 → 战力升序 → id 升序取第一个**。没有按 `fought` 过滤，也没有等级窗口 —— 信任服务端 `opponents` 接口返回的列表已经是可打的。

**为什么优先低等级**：擂台掉落只看「打了几场」，不看对手等级；低等级对手胜率高，同样的 30 场能拿到更多胜利经验和掉落机会。

**我们的差异**（`core/arena.mjs:335-359`）：我们主动分三次查询（`maxLevel=myLevel-1` → `+3` → `100`），过滤 `fought < 5`，排序按「等级升序 → 今日已打次数升序」。比参考实现更细，避免反复打同一个对手。

### 14.11 一次只打一场（`PB:436-560`）

函数注释写得很直接：「Executes AT MOST ONE preemptible arena bout per call」。

```js
if (shouldAbortFn?.()) return { status: 'preempted-by-snipe' }   // 进入前
// 冷却 8.5 秒，在 gear lock 之外，每 500ms 检查一次 abort
if (await sleepPreemptible(minBoutGapMs, shouldAbortFn)) return { status: 'during-cooldown' }
const oppResp = await getJson('/api/pet/battle/opponents?limit=20&q=')
if (shouldAbortFn?.()) return { status: 'preempted-by-snipe' }   // 打之前再查一次
await executeWithTacticalLoadout(...)
```

**为什么一次只打一场**：

- 每场 8.5 秒，30 场要 4 分钟；期间偷菜解禁窗口打开时无法让路
- 一次调用只打一场，调度器可以在场间重新计算下次唤醒时刻
- **冷却刻意放在 gear lock 之外**：等待期间静止装已经穿回，锁不占用；`shouldAbortFn` 可以在 500ms 粒度打断

**我们的差异**：每轮最多 `perVisit = 5` 场（`core/config.mjs:234`），但保留逐场 abort 和切片冷却（`core/arena.mjs:367` `:429`）。

### 14.12 宝箱判定的三种状态（`PB:272-281`）

```js
const opened = Number(daily.chest || 0)
const max = Number(daily.chestMax ?? 5)
if (opened >= max) return false
if (daily.ready === true) return true
const need = Math.max(1, Number(daily.need ?? 3))
const earned = daily.earned != null ? Number(daily.earned)
                                   : Math.min(max, Math.floor(Number(daily.battles || 0) / need))
return earned > opened
```

同时兼容三种服务端状态：新版本有 `earned`、旧版本没有但有 `battles/need`、以及服务端提前置 `ready=true`。

**为什么不能只用 `chestMax - chest`**：那是「今天总共能开几个」，中间还隔着「已挣到但未开」的 `earned`。

### 14.13 为什么顺序是「站宠 → 准备 → 打」

**`syncBattleProfilesAndPreparation` 的顺序**（`PB:289-418`）：

1. `GET /battle/home`；没有 `adopted` 直接返回
2. 同步擂台 history 和守家日志到档案
3. 开 `home.chests` 里带 `tier` 的宝箱
4. `GET /battle/gear`，再按 `daily` 开每日宝箱（最多 10 个，用回执 catalog 刷新 gear）
5. `recordObservedPanel`
6. 按 `planGearAndPoints` 穿最佳静止装，每次换装后用回执刷新 gear
7. **两轮加点**
8. 最后算 `finalPlan`，写 `restingGear` / `activeGear` / `dirty`

**为什么这个顺序**：

| 为什么 | 原因 |
|---|---|
| 站宠护理必须最前 | 站宠等级**就是**擂台等级，升级会直接加面板并给 +3 自由点。先算加点再升级，方案就作废 |
| 宝箱必须在穿装之前 | 开出来的装备可能直接是升级，先开箱才能本轮穿上 |
| 加点必须两轮 | 穿上最佳武器后 `wornSpdTotal` / `wornAtkTotal` 才可观测 |
| 档案同步放在准备阶段 | 后面的 `pickOptimalLoadout` 要用 `getOpponentSnap`，先同步才能用上刚校准的面板 |

### 14.14 战后归档（`C:686-741`）

- **`effMode = battle.xp > 0 ? 'arena' : mode`** —— 服务端擂台战报带经验 `xp`，守家战报不带，可以用它区分
- 擂台模式：A、B 双方都存，但跳过 `isAssistFighter`（协防单位）
- 守家模式：B（守家方）总是存为 `guard`；A（来袭者）只有在「不是协防、等级 ≤ B、且有 gear」时才存为 `arena`，标记 `sourceMode='guard-attacker-uncapped'`
- `cleanFighterSnap` 会剥掉名字里的「· 静潮协防」，从武器 id 推导 `wskill`
- 档案按 `updatedAt` 只保留更新的一份；`profiles` 按对手 id 聚合 `arena` 和 `guard` 两份

**增量同步**（`C:1312-1383`）：按 `lastHomeHistoryId` 过滤 `id > lastId`，**先按 id 升序排序再 `slice(0, maxFetch)`**，避免先截断再排序导致中间记录被跳过。守家日志 `maxFetch=8`。档案文件采用**临时文件 + rename 原子替换**（`C:675-684`）。

### 14.15 守家时用擂台档案的加成（`C:759-788`）

`getOpponentSnap` 的模式隔离：

- `arena` 模式只取 `arena` 快照；协防单位返回 null
- `guard` 模式优先取 `guard` 快照；**如果 guard 不存在或等级对不上，允许用 arena 快照替代，但替代时把 HP 乘 `homeHpMult = 1.1`**（守家方有 +10% 生命）
- `knownOpponentLevel` 与快照等级不同时，用 `adaptSnapToKnownLevel` 按等级差补 `LEVEL_GROWTH`，并**清空 `skills`**（技能解锁等级变了，不能沿用旧技能表）

### 14.16 我们的真实战绩后验（参考实现没有）

参考实现的 `winInterval` **不是置信区间**，它只是把点估计包成二元素数组（`C:1014-1015`）。真正的统计不确定性在装备选择里用配对 z 检验处理。

我们在 `core/battle.mjs:146-171` 加了「模拟 + 真实战绩」的混合后验：

```
posterior_win  = (sim_win  × prior + real_wins)   / (prior + n)
posterior_loss = (sim_loss × prior + real_losses) / (prior + n)
posterior_draw = (sim_draw × prior + real_draws)  / (prior + n)
```

`prior` 默认 4 场。效果：如果模拟说守家胜率 60%，真实打了 1 场且输了，后验胜率会从 0.6 拉到约 0.48；如果真实打了 4 场全输，则约 0.3。**几场真实战报就能明显校准模拟的系统性偏差**，而不会因为 1 场偶然失败就把结论推翻。

---

## 15. 站宠

### 15.1 站点规则（以线上前端为准）

**护理动作**（`research/live-05a5c445/pet-store.js:93-110`）：

| 动作 | 效果 | 经验 |
|---|---|---:|
| feed | 饱食 +18，亲密度 +2 | 8 |
| play | 精力 −10，饱食 −4，亲密度 +7 | **12** |
| rest | 精力 +22，饱食 −2 | 4 |
| clean | 清洁 +28，亲密度 +1 | 4 |
| 每日首见 | 无属性变化 | **20** |

**升级需要 `L × 100` 经验**（不是固定 120）；升级后亲密度 +3（`pet-store.js:31` `:118-128`）。

**每日经验上限以服务端 `progress.cap` 为准**（当前账号 1000，前端本地常量只有 300）。

**衰减按「每整小时、按等级」**（`pet-store.js:49-70`）：

```
饱食  2 × (L≥10 ? 0.5 : L≥2 ? 0.9 : 1)
精力  L≥10 ? 0.5 : L≥6 ? 0.8 : 1
清洁  L≥10 ? 0.5 : 1
```

**最多结算 48 小时**，不足 1 小时的部分保留。

> **参考实现用的是已淘汰的旧模型**：`XP_PER_LEVEL=120`、每日上限 167、字段 `mood`、固定衰减「饱食 −5/h、心情 −3.5/h、清洁 −2.5/h、精力 −2/h、最多 72 小时」（`PB:38-80`）。线上已改成 `cleanliness`、`L×100`、按等级衰减。我们的 `core/pet-care.mjs:9-24` 明确记录了这一点并按线上重写。

### 15.2 参考实现的护理优先级（`PB:136-169`）

```js
if (hunger < 45) chosen = 'feed'
else if (energy < 35) chosen = 'rest'
else if (clean < 45) chosen = 'clean'
else if (needHunger && hunger <= min(clean, energy)) chosen = 'feed'
else if (needClean && clean <= energy) chosen = 'clean'
else if (needEnergy) chosen = 'rest'
else if (needHunger) chosen = 'feed'
else if (needClean) chosen = 'clean'
else if ((needMood || xpLeft > 0) && energy >= 20 && hunger >= 20 && clean >= 15) chosen = 'play'
```

其中 `needHunger = hunger<92`、`needClean = clean<92`、`needEnergy = energy<90`、`needMood = mood<95`。

**设计意图分三层**：

1. **先救急**：`< 45` / `< 35` 时不管经验效率，先补最影响生存的状态
2. **其次补最低的那项**：在 hunger/clean/energy 之间选当前值最低的
3. **最后才玩**：只有精力 ≥20、饱食 ≥20、清洁 ≥15 时才玩（play 会消耗精力和饱食）

**每日首见在衰减之后、护理循环之前**：`met_day !== authDay` 时设 `met_day`、心情 +3、加 20 经验 —— 不需要任何属性条件，是纯白拿的经验。

### 15.3 参考实现的保存协议（`PB:192-267`）

```
GET  /api/pet/state  → { user_id, revision, state, progress }
POST /api/pet/state  → { user_id, revision, base_total, operation: UUID, state }
```

- `base_total` 是保存前的总经验，服务端用它做**乐观并发校验**
- `409` = 别的标签页/设备先存了 → **重新 GET、重新规划一次**，不能拿旧计划硬提交
- 第二次还失败就返回错误

我们的 `petCareRound`（`core/pet-care.mjs:190-279`）同构，最多保存 2 次；409 时 `continue` 重新读；如果服务端 `day_xp` 没有增加就停止，避免死循环。

### 15.4 我们比参考实现多做的一点：先清洁

我们的规划器有一段参考实现没有的逻辑（`core/pet-care.mjs:141-146`）：

```js
if (cleanliness < 60 && remaining > 0 && actions.length < maxActions) 先清洁一次
```

**为什么**：如果纯按经验最大化，`clean`（4 经验）会永远排在 `play`（12）/`feed`（8）/`rest`（4）之后，清洁度会一路掉到 0。先补一次把下限托住。

### 15.5 为什么站宠必须在擂台之前

**站宠等级就是擂台等级**。升级会：

1. 直接加 hp/atk/agi/spd（`B:2-8` 的每级成长）
2. 给 **+3 自由属性点**

如果先算装备和加点、再升级，刚算出的加点方案就是基于旧等级/旧自由点的，服务端一升级就作废。所以参考实现的 daemon 把护理放在最前（`cli/live-daemon.mjs:397-402`），我们的 `core/engine.mjs:765-776` 也是。

---

## 16. 52弟玩具摊（五子棋 / 抽牌 / 盲盒）

### 16.1 站点规则

```js
NPC = { daily: 52, jackpot: 0.001, jackpotCoins: 1_000_000 }
NPC_GAMES = { rps: '剪刀石头布', card: '抽牌比大小', gomoku: '五子棋', box: '盲盒夺宝' }
GOMOKU_N = 15, GOMOKU_PAID = 10
GOMOKU_LEVELS = {1: {mult: 0.8}, 2: {mult: 1.2}, 3: {mult: 1.5}}
BOX_SET = [50, 30, 20, 10, 5, 0, -10, -20, -30]
```

（`R:301-306`）

**每日 52 次**。**关键：平局不消耗次数、也不给奖励**（`R:796` 的 `if (res !== 'draw') s.cnt.npc = count('npc') + 1`）。输棋**消耗次数**但没奖励。

**五子棋只有前 10 局计奖**（`GOMOKU_PAID = 10`）。结算时只要 `G0.d && res !== 'draw'` 就 `gomokuPaid++` —— **输棋同样消耗计奖局数**（`R:812`）。练习局（`G0.p`）既不 pay 也不计数。

**练习局自动触发**：`practice = !!d && (used >= NPC.daily || count('gomokuPaid') >= GOMOKU_PAID)`（`R:806`）—— 当天次数用完或计奖局数用完时开局，自动变成练习局。

**奖励分布**（`R:307-315`）：

```js
const r = ctx.rand()
if (r < 0.001) return { coins: 1_000_000, jackpot: true }        // 0.1% 直接 100 万
if (r < 0.62)  return { coins: round((1000 + floor(rand²×7000)) × mult / 100) × 100 }   // 62% 现金
// 剩下 38% 给一件物品，数量再乘 mult
```

物品池 9 等概率：`bomb(1-2)` / `bait(10)` / `feed(10)` / `sd_<当季随机作物>(8)` / `amethyst` / `emerald` / `ruby` / `iron(6)` / `gold(3)`。

**抽牌比大小**：双方各从 1..13 均匀抽取 → 胜率 `78/169 ≈ 46.15%`、平局 `13/169 ≈ 7.69%`、负率 46.15%（`R:801-804`）。

**石头剪刀布**：对方均匀出 0/1/2 → 胜率 1/3、平局 1/3。

**盲盒**：9 个盒子（点数 `BOX_SET`），双方从同一个剩余池**无放回**抽 3 次，比总和大。一局要 3 个以上请求，参考实现默认不玩（`core/npc.mjs:121-125`）。

### 16.2 为什么五子棋必须「离线验证」

**服务端 `gomokuReplay` 是确定性的**（`R:411-424`）：

```js
// 玩家先手；mv 是玩家的落子序列
for (每步 k) {
  b[y*N+x] = 1
  if (五连) return k === mv.length-1 ? 'win' : 'bad'
  const [ax, ay] = gomokuAI(b, seed, k, d, N)   // ← 服务端 AI 也是确定性的
  b[ay*N+ax] = 2
  if (五连) return k === mv.length-1 ? 'lose' : 'bad'
}
```

`gomokuAI` 用 `rng32(seed*31 + step*7919)` —— **给定 seed 和步数就是确定性的**（`R:374`）。所以本地只要用同一份规则、同一个 seed 重放，就能在提交前**确切知道**这盘是赢/输/平。

参考实现的所有路线最终都要过 `gomokuReplay`，不是为了「估计胜率」，而是为了「确认这盘真的赢」。

### 16.3 参考实现的求解器（`execution/npc-toy-stall.mjs`）

**`cellStrength(b, N, x, y, who)`**（`:6-60`）—— 每个空点的棋型分，对四个方向分别统计：

| 连子数 | 两端都空 | 一端空 | 两端都堵 |
|---:|---:|---:|---:|
| ≥5 | 1,000,000 | — | — |
| 4 | 60,000 | 12,000 | 0 |
| 3 | 4,200 | 320 | 0 |
| 2 | 220 | 35 | 0 |

再加「扫过所有含该点的长度 5 窗口」的加分（`count>=4` +2,600、`===3` +110、`===2` +10），以及「双活三/更强」额外 +15,000。

> 这是**求解器自己的评分**，不是服务端的 `gomokuStrength`（`R:324-334` 的数值是 50,000/10,000/3,500/250/180/30）。两套数值不同但排序意图一致。求解器不能直接调服务端评分，因为那个函数不导出。

**`collectLocalCands`**：只收集「距离任意已有棋子 Chebyshev 距离 ≤2」的空点；空棋盘返回天元。

**`rankCandidateMoves`**（`:107-151`）：

1. 自己一步成五 → `{winNow:true, score:1e9}`
2. 对手恰好一个一步成五 → 必挡，`5e8`
3. 对手 ≥2 个一步成五 → 候选池限制在这些必挡点（反正挡不住，先挡一个）
4. 否则 `mix = myS*1.15 + aiS*1.05 - manhattanCenter*0.25`，取 `mix` 前 4 + `myS` 前 2 + `aiS` 前 2，去重后最多 `maxBranch`

**`evaluateMoveAgainstOracle`**（`:153-209`）—— 用服务端 AI 当裁判：

```
我下这一手 → 如果直接成五返回 1e12
           → 否则调 R.gomokuAI 拿对手回应 → 对手直接成五返回 null
           → 再枚举我下一步的所有成五点和最大棋型分，按规则打分
```

打分规则（`:191-201`）：

```js
if (myFiveCnt > 0 && aiFiveCnt === 0) return 5e8 + myFiveCnt*1e5
if (aiFiveCnt >= 2) return -2e8 - aiFiveCnt*1e6
if (aiFiveCnt === 1) return maxMy >= 50000 ? -2e5 : -8e5
if (maxAi >= 50000) return -1.5e6
return maxMy*1.25 - maxAi*1.1 + myFiveCnt*50000 + candItem.myS*0.1
```

**四路搜索**（`:316-354`）：

1. 四个开局：`[[c,c], [c-1,c], [c,c-1], [c-1,c-1]]`（`c = N>>1`）
2. 每个开局跑 `runGreedyPlaythrough`，`maxBranch=6`，每条路线都过 `gomokuReplay === 'win'` 验证
3. 没找到 → 取前 3 个开局跑束搜索（`beamWidth=5, branchK=5`）
4. 优先级：win → draw → 任意 non-bad

### 16.4 我们为什么不提交输棋

服务端 `pay` 只在 `res === 'win'` 时发奖；输棋会让 `cnt.npc + 1`，五子棋还会让 `gomokuPaid + 1`。所以：

- 提交输棋：浪费一次计奖局数和一次每日额度，收益 0
- 提交平局：不消耗次数，但也不赚，且可能让服务端局面卡住
- 提交胜局：拿奖励，消耗次数，符合预期

**我们的做法更严格**（`core/npc.mjs:59-65`）：求解失败或验证失败时**直接 `start` 新一局**，绝不提交空棋谱/输棋 —— 注释明确写了「提交空棋谱会被判 lose 并消耗次数」。

参考实现在找不到必胜时抛错，`runNpcToyStallSlice` 因此不会提交 `end`（`npc-toy-stall.mjs:491-495`）。

### 16.5 每日额度与批量抽牌（`npc-toy-stall.mjs:391-574`）

优先级：

1. 配置关闭 → `disabled`
2. **`cnt.npc >= 52` 且没有未完成五子棋 → 零 HTTP、零锁直接返回 `quota-complete`**（`:414-427`）
3. 手动游乐馆活跃 → `standby-manual-arcade`，下次 5 秒后或 `resumeAtSec` 再看
4. 有未完成的真实五子棋 → 求解并提交 `{a:'npc', g:'gomoku', k:'end', mv}`
5. 有未完成的盲盒 → 选最小未开盒 index 提交 `{k:'pick', i}`
6. `used >= 52` → `quota-complete`
7. `paid < 10` → 开一局**困难**五子棋 `{k:'start', d:3}`
8. 否则：一次提交最多 **40 个抽牌动作**（`max(1, min(40, 52-used))`）

**为什么困难档**：`mult = 1.5` vs 简单 0.8 —— 在能保证必胜的前提下，难度越高奖励倍率越大。

---

## 17. 游乐馆

### 17.1 站点规则（`R:1342-1500`）

| 游戏 | 每日次数 | 每局出手 | 描述要点 |
|---|---:|---:|---|
| 弹弹乐 bounce | 10 | 5 甩 | 全屏，反弹越多倍率越高 |
| 鲸鱼桌球 pool | 10 | 6 杆 | 连击加成，金球 3 倍分，自己落洞 −50 |
| 鲸鱼保龄 bowl | 10 | 10 投 | 5 轮 × 2 投；全中 30（连续再 +10），补中 20 |

**`MIN_PLAY = {bounce:5, pool:6, bowl:8}`** —— `arcEnd` 时若服务端处理时刻差小于这个秒数，返回「太快了，这局不计分」（`R:1472` `R:1486`）。

**次数在 `arcStart` 时就扣**（`R:1480` 的 `x.n[g]++`）；`arcEnd` 只负责重放、计分、更新 `best` / `db` / `b9Rank`，**不返回 D 币**。

**计分要点**：

- 桌球：普通球 `100×combo`、金球 `300×combo`、大肥鱼自己落洞 −50、清台 `500 + 150×(6-已用杆数)`
- 保龄：全中 `30+10×连中`、补中 20、否则按倒瓶数
- 弹弹乐：`gain = floor(pts × (1 + 0.5×反弹数 + bonus))`，另有暗格、角落 +60、道具盒

**一个重要的可重试点**：`「太快了」`和「出手数据无效」的判断都在 `x.cur = null` **之前**（`R:1485-1486`），所以服务端**不清 `cur`** —— 等够时间可以救回来，不需要白烧次数。

### 17.2 手动游玩必须让位（`model/observations.mjs:291-343`）

前端 `/isle-arcade.js` 在 `arcStart` 时捕获当时的 `world.rev`，玩家玩几十秒后提交 `arcEnd`，用的还是旧 rev。**期间任何后台写请求都会让 `world.rev` 前进，服务端回 409**，而前端不会自动重试 —— 玩家这一局作废，次数还照扣。

所以后台必须识别「有人正在手动玩」，并在整局期间停止写入：

```js
const cur = world.state?.arc?.cur
const startedAtSec = floor(Number(cur?.t || 0))
if (!cur || !startedAtSec) return { active: false }
const ttlSec = max(10, options?.ttlSec ?? 180)
const resumeAtSec = startedAtSec + ttlSec
const active = nowSec < resumeAtSec
```

**`ttl = 180` 秒是兜底**：如果玩家按 Esc 退出，前端不会发 `arcEnd`，`cur` 会永久残留；180 秒后自动认为这一局结束，避免后台永远停写。

我们的 `core/world.mjs:51-69` 实现了同样的逻辑，`MANUAL_ARCADE_TTL = 180`。

### 17.3 参考实现只让位，不自动玩

参考实现在两处检查手动游玩（`npc-toy-stall.mjs:433-443` `:470-482`），活跃时返回 `standby-manual-arcade`，下次 `min(now+5, resumeAtSec)` 再看。`computeNextNpcWakeSec` 也会考虑（`:368-373`）。

**它没有自动求解/自动提交 `arcStart`/`arcEnd` 的模块** —— 对这一块，参考实现的行为是「检测到就停，等人玩完」。

### 17.4 我们的自动托管（`core/arcade.mjs`）

**让位的双重条件**（`core/arcade.mjs:229-243`）：

```js
const ma = world.manualArcade?.(world.now, cfg.arcade?.manualTtlSec)
if (ma?.active && !world.ourArcadeHeld?.()) { 让位 }
```

`world.ourArcadeHeld()`（`core/world.mjs:76-84`）判断「这个 `cur` 是不是我们自己刚开的局」：

- 没有自己的局标记 → 不是自己的局
- 有自己的标记但快照还没同步到 `cur` → 按自己的局处理（刚 `arcStart`、还没刷新 state 的窗口）
- 有 `cur` → 必须**游戏名和 seed 都匹配**才算自己的局

**写入门控**（`core/world.mjs:162-173`）：`world.act` 里再检查一次，手动游玩中且不是自己的局就抛 `ManualArcadeError`。这样即使某个模块漏检查，只要走 `world.act` 也会被挡住。

**计时起点的关键细节**（`core/arcade.mjs:252-269`）：

```js
const r1 = await world.act([{a:'arcStart', g}], {silent:true})
const o = (r1.out || [])[0]
startedAt = Date.now()      // ← 回执到达之后才开始计时
```

**为什么**：POST 有 2.15 秒串行节流，`arcStart` 可能在本地排队 2 秒才发出去；如果从发请求前开始计时，本地等 5.8 秒到服务端只剩 4.5 秒，弹弹乐 `MIN_PLAY=5` 会被判「太快了」。

**求解与重试**：

- 用站点自己的 `cache/arcade-<ver>.mjs` 求解：pool/bowl 用贪心候选，bounce 每个候选都**从 seed 重建状态**（因为 `settle` 会消耗 `w.R`，不重建会污染随机数流）
- `canonicalShots` 按服务端量化规则重放一遍，确保提交的 shots 和搜索时一致
- 等 `MIN_PLAY[g] + 1.2` 秒再 `arcEnd`；「太快了」最多重试 3 次
- `arcEnd` 无论成败都清 `world.ourArcade = null`
- 连续失败就停止该游戏的本轮循环，避免把剩余次数全烧光

**调度位置**：游乐馆放在所有经济动作之后、偷菜之前（`core/engine.mjs:852-865`）。每局要等 `MIN_PLAY`，所以单轮只玩 `perTick` 局，不拖住掐点偷菜。

## 18. 修仙 1.0

> 路径缩写：`R` = `rules/xs-xian-rules.js`，`X` = `execution/xian-cultivation.mjs`，`L` = `cli/live-daemon.mjs`，`S` = `execution/snipe-scheduler.mjs`。

### 18.1 境界与修为

9 个大境界（炼气 → 筑基 → 金丹 → 元婴 → 化神 → 炼虚 → 合体 → 大乘 → 渡劫），每境界 1–9 层（`R:30`）。

修为需求（`R:33`）：

```js
cvNeed(r, s) = Math.round(60 * (r+1) * (r+1) * (1 + s*0.25))
```

| 境界 | 1 层需求 | 9 层突破门槛 | 1 层到可突破总计 |
|---|---:|---:|---:|
| 炼气 r=0 | 75 | 195 | 1,215 |
| 筑基 r=1 | 300 | 780 | 4,860 |
| 金丹 r=2 | 675 | 1,755 | 10,935 |
| 渡劫 r=8 | 6,075 | 15,795 | 98,415 |

突破条件：`s>=9 && xp>=cvNeed(r,9)` 且持有 **r+1 颗培元丹**（`R:97`）。渡劫 r=8 是终点，不能再破。

成功率（`R:179`）：

```js
breakRate = clamp(0.6 + (mind-50)/250 + luck/500, 0.3, 0.9)
```

- 心境 50、气运 0 → 60%；心境 100 → 80%；气运 ±50 各 ±10%
- **成功**：`r++`、`s=1`、`xp=0`、心境 +5
- **失败**：本层修为 ×0.7、心境 −8，**培元丹照样消耗**
- 突破不耗灵力（`COST.break = 0`）

打坐（`R:94`）：

```js
gain = floor((d/60) * 10 * rootMult * (tech==='ice' ? 1.2 : 1) * medBonus)
medBonus = (0.8 + mind/250) * Π(师父 1.1 | 道侣 1.15)
```

`MED_MIN = 60` 秒（不足 60 秒收功收益为 0）、`MED_MAX = 1800` 秒（`R:34`）。打坐本身不耗灵力。

### 18.2 灵力

| 项 | 数值 | 出处 |
|---|---|---|
| 上限 | 100 | `R:4` |
| 自然回复 | 每 360 秒 1 点 = **10 点/小时**；御风诀主修 270 秒 1 点 = 13.33/小时 | `R:4` `R:65` |
| 水壶容量 | 20；水主修 +10；打水免费且一次打满 | `R:5` `R:122` |
| 每日总量 | 自然 ~240 + 3 颗回灵丹最高 90 = **约 330** | — |

动作消耗（`R:15`）：锄地 3（厚土主修 1）、播种 1、浇水 1、收获 2、起炉 5、斗法 10、进秘境 15；移动/商店/撤退/打坐/突破/融合/学功法/装备 **全部 0**。

### 18.3 丹药

| 丹药 | 配方 | 效果 | 每日上限 | 卖价 |
|---|---|---|---|---|
| 回灵丹 | 灵草×3 + 金菇×1 | +30 灵力（万毒经 +40） | 3 颗 | 60 |
| 培元丹 | 灵草×2 + 铃兰×1 | 药园经验 +40（万毒经 +60） | 无 | 90 |

炼丹流程（`R:104`）：

1. `brew` 立即扣药材，一次只能一炉
2. 必须等 `BREW_MIN = 15` 秒，超过 `BREW_MAX = 1800` 秒成色强制为 0
3. **成色来自提交参数 `a.n`（0–2），不是由等待时长推算**：

```js
q = d > BREW_MAX ? 0 : clamp(a.n | 0, 0, 2)
n = 1 + q + (tech === 'fire' && q >= 1 ? 1 : 0)
```

固定提交 `n=2` → 普通主修 3 颗，火主修 4 颗。参考实现用 `BREW_READY_SEC = 19` 秒（15 + 4 秒时钟余量，`X:78`）。

培元丹在药园 Lv5 后不再产生有效经验（`R:130`），所以 Lv5 后只留作突破/融合材料。

### 18.4 药园

| 作物 | 种子 | 卖价 | 每阶段秒 | 解锁等级 | 收获经验 |
|---|---:|---:|---:|---:|---:|
| 灵草 | 5 | 12 | 600 | 1 | 4 |
| 金菇 | 12 | 30 | 1200 | 1 | 4 |
| 铃兰 | 20 | 55 | 1800 | 2 | 8 |
| 冰莲 | 40 | 120 | 3600 | 3 | 12 |
| 赤芝 | 60 | 190 | 5400 | 4 | 16 |
| 雷竹 | 90 | 300 | 7200 | 5 | 20 |

生长（`R:63`）：3 个阶段，**每浇一次水才计时，未浇水时计时暂停**。青木诀主修生长时间 ×0.8。收获后回空 `soil`，不自动补种。

初始存档 24 块地：8 块 `soil` + 14 块 `weed`，另有 2 块预种灵草 → 开局实际 10 块可耕（`R:60`）。

**双倍收获**（`R:90`）：产量 `1 + (x.log % 4 === 3 ? 1 : 0)` —— 每第 4 个成功动作后的那次收获双倍。`x.log` 是**所有成功动作的全局计数**，所以可以跨动作类型对齐。

药园等级（`R:130`）：`xpNeed(lv) = 40*lv*lv`，1→2 级 40，2→3 级 160，3→4 级 360，4→5 级 640，累计 1200。经验来源：收获 `作物等级×4`、出炉 `6 + q×4`、吃培元丹 40。

### 18.5 功法

十部功法，每部两个技能（`R:36`）：

| 元素 | 功法 | 主修被动 |
|---|---|---|
| 火 | 流火诀 | 炼丹出炉 +1 颗（良品及以上） |
| 水 | 沧澜诀 | 水壶容量 +10 |
| 木 | 青木诀 | 作物生长快 20% |
| 金 | 庚金剑诀 | 卖药材多得 15% |
| 土 | 厚土诀 | 锄地只耗 1 点灵力 |
| 冰 | 玄冰诀 | 打坐修为 +20% |
| 雷 | 紫霄雷法 | 斗法胜利修为 ×1.5 |
| 风 | 御风诀 | 灵力恢复快 25% |
| 熔 | 熔岩诀 | 斗法胜利灵石 +30% |
| 毒 | 万毒经 | 培元丹 +50%、回灵丹多回 10 |

- 学功法 50 灵石，必须拥有对应元素灵根，每部只能学一次
- **同时只能一部主修，每天只能换一次**（`x.te`，`R:112`）
- 单灵根（基础+变异共 1 条）时功法效率 ×1.5
- 层数（`R:47`）：`techLayer = min(9, 1 + floor(sqrt(tm/2)))`，`layerNeed(L) = 2L²`
- 层数收益：`power = 1 + 0.06*(L-1)`、弹幕数 `2 + (L>=3) + (L>=9)`、命数 `3 + (L>=6)`
- 每次斗法胜利给主修 +1 熟练

### 18.6 灵根与融合

五行基础 + 五个变异（冰/雷/风/熔/毒，`R:24` `R:29`）。

| 总根数 n | 基数 `ROOT_BASE` | 成长 `ROOT_GROW` |
|---:|---:|---:|
| 1 | 2.0 | 0.85 |
| 2 | 1.5 | 0.93 |
| 3 | 1.15 | 1.00 |
| 4 | 0.85 | 1.08 |
| 5 | 0.60 | 1.17 |

```js
rootMult = ROOT_BASE[n] * (ROOT_GROW[n] * (1 + 0.12 * 变异根数)) ^ 大境界r
```

变异根每个给成长倍率 +12%，且融合后基础根数 −1 —— **数值上显著增强**，代价是不可逆、55% 成功率、失败掉修为并锁 24 小时。

测灵根：根数按权重抽（1 根 8% / 2 根 20% / 3 根 32% / 4 根 25% / 5 根 15%），只能玩家在 `st===1` 时做一次（`R:91`），**自动化禁止**。

融合表（`R:28`）：金+水→冰、火+金→雷、水+木→风、土+火→熔、土+木→毒。

硬性条件（`R:99`）：大境界 ≥1、两条基础根都在、培元丹 ≥2、灵石 ≥200、冷却已过。成功率 55%；失败当前修为 ×0.8，`fuseCd = now + 86400`，材料照扣。

### 18.7 宗门

| 声望 | 等级 | 每日俸禄 |
|---:|---|---:|
| 0 | 外门弟子 | 10 |
| 200 | 内门弟子 | 25 |
| 800 | 真传弟子 | 50 |
| 2000 | 长老 | 90 |

委托每天 3 条（`R:217`），7 种模板：药材（灵草5 / 金菇3 / 铃兰2 / 冰莲1）、丹药（回灵丹1 / 培元丹1）、当日斗法胜 1 场。奖励公式 `rw = win ? 30 : pill ? 40 : 20 + n*4`；贡献 `ctb += rw`、声望 `rep += rw`、灵石 `+= round(rw/2)`、执事好感 +5。

委托池会排除「药材等级 > 药园等级 + 1」的药材，所以低等级药园不会刷出冰莲/赤芝。

> **注意**：`ctb`（贡献）在规则里只累加，**没有任何消耗/兑换动作**；宗门等级实际由 `rep` 决定。所以委托的价值是「声望 + 灵石 + 执事好感」，不是贡献消费系统。

### 18.8 人脉、往事、送礼、机缘

29 个 NPC（老 21 + 新 8），其中 10 个有往事章节。

好感 `[-500, 1000]`，档位：0 陌生 / 100 熟识 / 300 好友 / 600 挚友 / 900 知己。

- **叙话**：每人每天一次 +5 好感；每天最多 30 次，但只有**前 3 次**各 +1 心境（`R:205`）
- **送礼**：每人每天一次，喜欢 +40 / 普通 +15 / 讨厌 −10，可送药材或丹药
- 好感降到 −100 且无关系时自动变仇人 `rel=4`

关系效果：师父（打坐 +10%）、道侣（打坐 +15%）、结拜（斗法灵石 +10%）、仇人（秘境普通战斗 30% 概率被截杀，输了本趟收获全丢）。

往事章节（`R:147`）：10 个 NPC × 2 章 × 2 选项，需要 `fav >= need.fav` 且 `r >= need.r`，必须按顺序推进。选项可给好感/心境/气运/修为/灵力/关系/物品。典型高价值项：castle 第二章可选 `fav+80/师父 rel1` 或 `cv+80`；water 第二章可选 `fav+50/结拜 rel3`。

机缘（`R:160`）：每天最多 3 次、间隔 ≥600 秒，触发概率 `0.4 + luck/500`。12 个事件各有 2–3 个选项。**关键机制**：`evroll` 时服务端记录一个 `cur.r`（0–1），`evpick` 时用 `roll = cur.r - luck/400` 依次减各分支权重 —— 气运越高越容易落进前面的高收益分支。

### 18.9 试炼（4 关，手动弹幕）

| id | 名称 | 最短战斗秒 | 基础灵石 | 境界要求 |
|---|---|---:|---:|---:|
| duel | 切磋 | 40 | 15 | 0 |
| secret | 秘境竹林 | 70 | 40 | 0 |
| demon | 魔窟 | 100 | 90 | 1 |
| sword | 葬剑山 | 100 | 150 | 2 |

需要先学一部功法；每天最多 8 次（与自动斗法共享），每次 10 灵力；进入后 30 分钟内必须提交。

`win` 时若战斗时间 < `S.min` 判「战斗时间不足，结果作废」；> 1800 秒则清空并作废。灵石 = `S.stone + min(S.spells, a.n)*5`，熔岩 ×1.3，结拜 ×1.1。切磋当天已赢过同一 NPC 时灵石为 0，但仍计胜场/熟练。非切磋首次通关额外培元丹×1。每次胜利：`tw.n++`、主修熟练 +1、修为 `floor(15*rootMult*(雷?1.5:1))`。

> 这是**客户端弹幕战斗**，服务端只校验最短时长和 30 分钟窗口，胜负由客户端提交。自动化绝不能提交 `xsFight/xsWin/xsLose`。

### 18.10 对方的 11 阶段规划（`planXianActions`，`X:1089`）

**四道让位门**（`X:1091`）：

| 条件 | reason |
|---|---|
| `enabled=false` | `disabled` |
| 无灵根 / `st<4` | `prologue-manual-standby` |
| `xs.fight` 存在且 30 分钟内 | `manual-fight-in-progress` |
| `autoRealm=false` 且 `xs.rlm` 存在且 6 小时内 | `manual-realm-in-progress` |

然后 `structuredClone` 存档并 `xsTick` 到当前时间。**所有动作先在克隆上用固定随机数预演**（`rand = () => 0.99`），只有预演成功的动作才进批次（`X:1135`）。

#### 阶段 1：出炉

- 有熟地且 `sim.log % 4 === 3` 时**故意不出炉** —— 这个位置正好可以双倍收获，出炉会把 `log` 推进到 0 从而丢掉双倍（`X:1267`）
- 否则先换主修（如当天还没换），再提交 `finish n=2`
- **1b 紧急起炉**：炉空、灵力 ≥5、回灵丹额度没满、原料齐、且当前不在双倍窗口 → 立刻起一炉。理由：起炉花 5 灵力，出炉 3 颗回灵丹 = 90 灵力，净 **+85**，防止农事把灵力花到不够起炉（`X:1279`）

#### 阶段 2：收获

候选排序（`X:1300`）：

```js
urgentNeed = (缺回灵丹原料 || 缺培元丹原料) ? 1 : 0
sort by urgentNeed desc → sell desc → idx asc
```

每收一块前检查 `isUrgentCauldronReady()`：
- 还没起炉、灵力 ≥5、且 `log%4 !== 3` → 先起一炉（回灵丹优先）
- 起炉在即且 `en - 2 < 5` → **停止收获，保住 5 点灵力起炉**

灵力 <2 且还有多块熟地时，按 `remainingRipe*4` 的预算判断是否吃回灵丹。

**双倍对齐**（`X:1154`）：计算 `stepsForDouble = (3 - log%4 + 4) % 4`，如果本批剩余槽位不够「对齐步数 + 1 次收获」，就把这块熟地留到下一批。对齐只允许**严格产出型**动作，最多循环 6 次：

> `equip` 换主修 / `finish` 出炉 / `use` 丹药 / `sit` / `rise` / `stipend` 领俸禄 / `task` 交委托 / `talk` 叙话 / `water` 浇水 / `plant` 播种 / `sell` 卖 1 株 / `buy` 买 1 颗种子 / `learn` 学功法 / `refill` 打水

**绝不**用收获、突破、融合、机缘、斗法、秘境这些会改变产出/资源的动作来对齐。

#### 阶段 3：吃培元丹

只在药园 `lv < 5` 且 `peiyuan > 保底持有量` 时吃（让药园升级后能种更高级种子）。

保底算法（`X:332`）：
- `lv>=5` → 无穷
- 允许突破且 `s>=8` → 保 `r+1` 颗
- `autoFuse` + 冷却好 + 有可融合对：`r>=1` → 保 2 颗；`r=0 && s>=8` → 保 3 颗（1 突破 + 2 融合，突破后 `xp=0` 正好同一窗口融合）

#### 阶段 4：卖药材

排序：作物等级降序、卖价降序（雷竹/赤芝/冰莲优先，灵草最后）。

保留量 `bagReserve = alchemyAndSectReserve + socialNeeds`：
- `alchemyAndSectReserve`：炼丹底仓 + 今日宗门委托
- `socialNeeds`：每个「章节未完成、好感<300、今天未送礼、有可送喜好草药」的 NPC 各 1 株

**破产兜底**：地里无作物、无种子、买不起最便宜种子（5 灵石）时，有任何药材就卖。单次最多 99 株。

#### 阶段 5：浇水

按田块索引顺序。关键在**灵力保留**：

```js
minReservedEnForRipeOrBrew() = 有紧急起炉 ? 5 : 有熟地 ? 2 : 0
```

每次浇水前检查 `en - 1 >= minReserved`；不够先吃回灵丹，仍不够则停止浇水。水壶空则先 `refill`（0 灵力）。

#### 阶段 6：播种

选种算法 `chooseCropForEmptyPlot`（`X:461`），按优先级：

1. 金菇（回灵丹原料）不足 → 金菇
2. 灵草不足 → 灵草
3. 药园 ≥2 且铃兰不足 → 铃兰
4. **任意缺口药材**，按等级/卖价降序（用于宗门委托要的赤芝/冰莲等）
5. 否则种当前解锁的最高级药材
6. 买不起最高级种子时：只有「地里少于 3 株」或「灵力 ≥85 快溢出」才降级种低级

买种一次买 `min(10, 剩余空田, 灵石 // 种子价)` 包。种下后如果够 1 点灵力就顺手浇。每株都保留 `minReservedEnForRipeOrBrew()`。

#### 阶段 7：回灵丹补额度

这个阶段传入 `pendingEnergyNeed = 0`，所以只会在两种情况下吃：
- 距 CST 午夜 ≤4 小时（**20:00 以后**）
- 距午夜 ≤25 分钟且 `en <= 90`

即「白天不为了吃而吃，晚上把每天 3 颗的额度用掉，避免作废」。白天真正缺灵力时，阶段 2/5/6 会带具体预算调用同一个函数。

#### 阶段 8：炼丹（起炉）

优先级（`X:1437`）：
1. 今天回灵丹额度没满且原料齐 → 立刻炼回灵丹
2. 还有回灵丹批次目标，且（所有开口田打理完 / 富余灵力 ≥5 / 灵力 ≥80）→ 回灵丹
3. 还有培元丹批次目标，且（药园 <5 / 开口田全打理完且富余 ≥5 / 灵力 ≥85）→ 培元丹

`allOpenWatered` 的定义是「没有任何 `soil` 田处于空置、缺水生长或成熟待收」—— 只要田里还有活，培元丹就不会抢灵力。

批次目标（`X:412`）：

```js
targetHuilingPills = (3 - 今日已吃) + 3
huilingBatches = min(2, ceil((target - (库存 + 在炉3颗)) / 3))
desiredPeiyuan  = computeDesiredPeiyuanStock(...)
peiyuanBatches  = 药园>=2 ? min(2, ceil((desired - (库存+在炉3))/3)) : 0
```

#### 阶段 9：杂草扩张

只在「没有未完成的开口田」时做（`X:1461`）。阈值：

```js
canExpand = lv < 4 ? en >= 92
                   : (computeSurplusEnergy() >= 8 || en >= 65)
```

药园 Lv4 之前种的是快菜（0.5–3 小时），灵力本来就吃紧，只有快溢出（≥92）才扩。Lv4 之后（4.5–6 小时作物），富余 ≥8 或灵力 ≥65 就扩。

单块成本：锄地 3（厚土 1）+ 播种 1 + 浇水 1 = 5 灵力。

#### 阶段 10：学功法 / 换主修 / 日常 / 2.0

**10a 学功法**（`X:1490`）：只学已拥有灵根对应的功法，变异灵根优先。每部 50 灵石；第一部额外留 `max(24, 最高种子价×2)`。**必须排在融合之前** —— 融合会消耗基础灵根，但已学功法永久保留。

**10a 换主修**（`X:1496`）：按固定优先级挑：
- 药园 <5：毒 → 火 → 风 → 冰 → 木 → 金 → 土 → 水 → 雷 → 熔
- 药园 ≥5：冰 → 毒 → 风 → 火 → 金 → 木 → 土 → 水 → 雷 → 熔

只有 `sim.te !== 今天` 时才换。

**10b 日常**：领俸禄（零成本）→ 交可安全交的宗门委托（`findTurnInableSectTaskIndex`）→ 叙话（最多 3 人/天）。

委托安全线（`X:624`）：
- 胜利类：`tw.d === today && tw.n >= n`
- 药材类：`bag[key] >= n + keepUrgent`（`keepUrgent` 是今天还缺回灵丹且原料已齐时保留的丹方用量）
- 回灵丹类：`haveHuiling - n >= 今日剩余额度`
- 培元丹类：`havePeiyuan - n >= max(breakNeed*retryMult + fuseReserve, 保底持有量)`

**10c 社交**（`X:1524`）：先推进往事章节，再送礼。往事按 `SOCIAL_GIFT_PRIORITY_NPCS` 顺序，两个选项都打分，`bestScore > -1000` 就发 `chap`。送礼跳过章节已完成/好感 ≥300/今天已送过的，只送对方**喜欢的草药**，且 `bag[h] > alchemyAndSectReserve[h]`。**不送丹药** —— 培元丹/回灵丹是突破与每日灵力的硬通货，换 +40 好感不划算。

**10d 机缘**（`X:1533`）：有未决事件（30 分钟内）时，用 `roll = cur.r - luck/400` **预先确定性判断会落到哪一支**，打分后只有正收益才 `evpick`；没有未决事件且当天次数 <3 且距上次 ≥600 秒 → `evroll`。

**10e 自动秘境 / 斗法**：见第 19 章。

**10f 刷新委托**：若 `sim.tk.d !== today`，发 `tasks`，标记 `emittedStochastic`，下一批拿真实列表。

#### 阶段 11：突破 / 打坐 / 融合尾部

**突破策略**（`X:313`）：

```js
manual → false
r >= 8  → false
eager   → true
smart:
  lv < 5:  r > 0 → false
           r = 0 → autoFuse || ROOT_GROW[根数] > 1
  lv >= 5: true
```

即药园 Lv5 之前 smart 模式优先把培元丹喂药园（每颗 +40 经验）；只有炼气期且（开了自动融合或 4/5 根成长倍率 >1）才允许提前破到筑基。

**三条收尾路径**：

1. **修为已满且有 `r+1` 颗培元丹**：先 `break`，再处理打坐。如果正在打坐且已过 `MED_MIN+5`，先 `rise` 再 `sit`。
   > 关键顺序：**`break` 在 `rise` 之前** —— 突破成功会把本层修为清零，先把突破做掉才能保住打坐池里已累积的收益。
2. **正在打坐且收功刚好能满**：`projectMeditationAfterRise` 预测收功后状态，若满足突破条件则发 `rise → break → sit`。
3. **普通 30 分钟循环**：超过 `MED_MAX = 1800` 秒 → `rise` 然后 `sit`。
   > 即使 `s=9` 但突破被策略推迟，**仍继续打坐**，攒突破失败后的缓冲。

**融合**（`X:1634`）：

```js
autoFuse && r>=1 && 冷却已过 && 培元丹>=2 && 灵石>=200
&& 两条基础灵根的功法都已学           // 否则融合会永久失去学习机会
&& cv.xp <= max(15, floor(cvNeed(r,s)*0.12))   // 失败只掉 12% 以内的修为
```

### 18.11 资源分配：灵力怎么在农事、斗法、秘境、打坐间分

参考实现没有显式预算表，而是用「**农事优先 + 2.0 入场门槛 + 保留 2/5 点**」：

1. **农事先花**：阶段 1–9 在阶段 10e 之前执行
2. **给收成/起炉保留**（`X:1259`）：`有紧急起炉 → 5；有熟地 → 2；否则 0`
3. **秘境门槛**：`Boolean(sim.rlm) || ((surplus >= 21 || en >= 75) && en - 15 >= minReserved)`
4. **斗法门槛**：`en - 10 >= minReserved`，且有胜利委托时 `surplus >= 10 || en >= 22`，无委托时 `surplus >= 26 && en >= 45`
5. **打坐**：0 灵力，放最后，只消耗时间

**富余灵力 `surplus` 的定义**（`X:517`）：

```js
upcomingNeed = 熟地(4) + 缺水田(1) + 空田(2) + 1800 秒内会成熟的田
自然回复 = floor((now - enAt + 1800) / regenSec)   // 仅当 en < 100
surplus = en - max(0, upcomingNeed - 自然回复)
```

按规则常量粗算：自然回复 240/天 + 3 颗回灵丹 90 = 330 灵力/天；8 场自动斗法 80 + 3 次秘境 45 = **125 是 2.0 的硬上限**，其余都给 1.0。参考实现不会主动把额度打满，只在富余跨过门槛时做 2.0。

### 18.12 为什么禁 `xsRoot` / `xsStory` / `xsFight` / `xsWin` / `xsLose`

`X:67`：

- `xsRoot` / `xsStory`：**不可逆的初始选择**，只能由玩家在网页端推进。`root` 只在 `st===1` 时可做一次，`story` 必须严格按 `n = st+1` 顺序
- `xsFight` / `xsWin` / `xsLose`：**客户端弹幕战斗**，服务端只校验最短战斗秒数和 30 分钟窗口。自动化提交 `xsWin` 等于伪造战斗结果，违反站点契约

额外在运行时拒绝的：
- `xsPeek` / `xsRout`：`assertSafeXianBatch` 明确报 `Unsafe manual xian action`。`peek` 花 20 灵石只为看对方一个技能，纯浪费；`rout` 只带回一半掉落
- `xsFuse`：默认关闭，只有 `autoFuse=true` 才允许
- `xsBreak`：`breakMode=manual` 时禁止

### 18.13 批次安全校验 `assertSafeXianBatch`（`X:186`）

1. 动作数 ≤ `maxActionsPerBatch`（默认 30，最大 30）
2. 每个动作不得在 `FORBIDDEN_XIAN_ACTIONS` 中
3. `fromWireXsAction` 必须能解析（短名必须存在于 `COST` 表，共 36 个动作）
4. 逐项开关校验：`xsEvroll/xsEvpick` 需 `autoEvents`；`xsGift/xsChap` 需 `autoSocial`；`xsAb` 需 `autoDuel`；`xsRin/xsRgo/xsRbuy` 需 `autoRealm`；`xsSlots` 需 `autoDuel` 或 `autoRealm`

这道校验在**规划器末尾执行一次，在执行切片里又执行一次**，属于双保险。

**开关归一化**（`X:164`）：

```js
breakMode  ∈ {smart, eager, manual}，默认 smart
fuseTarget ∈ {auto, ice, thunder, wind, lava, poison}，默认 auto
autoAll = opt3 || autoAll
autoEvents / autoSocial / autoDuel / autoRealm = autoAll || 对应开关
autoFuse = 单独开关                    // 不含在 autoAll 里！
maxActionsPerBatch = clamp(floor(n), 1, 30)
```

### 18.14 唤醒 `computeNextXianWakeSec`（`X:1672`）

**前置直接返回**：

| 条件 | 返回 |
|---|---|
| `enabled=false` | `Infinity` |
| 无灵根 / `st<4` | `t + 120` |
| 手动战斗 30 分钟内 | `min(t+60, fight.t+1802)` |
| 手动秘境 6 小时内 | `min(t+120, rlm.t + 6*3600 + 2)` |

**当前有可执行动作** → `t + 3`（大于主循环 2.2 秒提交间隔）。

**否则收集所有候选时刻取最小值**：

1. 下一个 CST 午夜 +3 秒
2. 丹炉出炉：`brew.t + 19`
3. **作物长下一阶**：`ceil(p.w + HERBS[p.c].grow * (木?0.8:1) + 1)`
4. **需要灵力才能推进农事**：若「有炉且原料齐 / 有熟地 / 有缺水田 / 有空田能选种」→ 加入「下一滴自然回复灵力」的时刻
5. **灵力接近上限 88**：`ceil(enBase + max(1, 88-en)*regenSec + 1)`
6. 打坐上限：`med.t + 1800 + 1`
7. **精确突破就绪**：

```js
remXp = Σ_{s=curS..9} cvNeed(curR, s) - cv.xp
ratePerSec = 10 * rootMult * (冰?1.2:1) * medBonus / 60
secNeeded = max(MED_MIN+5, ceil((remXp+1)/ratePerSec))
```

8. 融合冷却结束：`fuseCd + 2`
9. 机缘冷却：`evLast + EV_GAP + 1`
10. **晚间补丹**：`下一 CST 午夜 - 4*3600 + 5`（20:00:05）

最后 `min(所有 > t 的候选)`。

> 唤醒模型**没有**为「斗法达到 10 点」「秘境达到 15 点」单独加候选 —— 它们要么由农事灵力候选间接覆盖，要么等午夜。

### 18.15 执行切片 `runXianCultivationSlice`（`X:1778`）

```
1. enabled=false → disabled
2. shouldAbortFn() → aborted-by-preemption
3. 估算当前时刻（优先 httpClient.estimatedServerNowSec）
4. 有 observedWorld：
   a. preview = planXianActions → 0 动作则 idle + 算唤醒，零 HTTP
   b. dryRun / 无 journal → dry-run-planned
5. 正式执行：
   a. 再次 shouldAbort
   b. GET /api/pet/world 拿 liveWorld（失败 → 30 秒后重试）
   c. reconcileUnknownWithFreshWorld；仍有非 visit unknown → blocked-pending-reconcile，10 秒
   d. 再次 shouldAbort
   e. 用 liveWorld 重新 planXianActions
   f. assertSafeXianBatch
   g. executeTransaction({ kind:'xian-act', body: { rev, operation, actions } })
   h. 按 postWorld 算唤醒；confirmed 且 followUpSoon → min(computed, postNow+3)
```

**每次只发一个 POST，最多 30 条动作。**

`followUpSoon` 由三种情况触发：批次被上限截断、发了随机动作（`evroll/tasks/break/fuse`）、刚好达到上限。刚起炉且没有其他触发时 `followUpSoon=false`，下次唤醒按 `brew.t+19`。

**失败处理**：本地预演失败的动作不会进入批次（规划器继续尝试下一个候选）；服务端失败按 `executeTransaction` 判定 `confirmed/rejected/unknown`，unknown 会挡住后续事务直到对账完成。

**让位给偷菜**：修仙是后台切片，只在 `!snipeScheduler.shouldBlockBackgroundWork()` 时执行；切片内部三处 `shouldAbortFn` 检查（开始前、拉世界后、提交前），可以中途被抢占。玩家手动斗法（30 分钟内）或手动秘境（6 小时内）时，规划器本身整批待命。

## 19. 修仙 2.0（秘境 / 斗法 / 融合）

### 19.1 秘境区域

| 区域 | 解锁境界 | 怪物强度 | 基础血 | 首领 | 产物药材 | 难度 k |
|---|---:|---:|---:|---|---|---:|
| 竹海迷踪 | 0 | 0.5 | 45 | 三尾妖狐 | 灵草/金菇/铃兰 | 0 |
| 地火洞窟 | 1 | 0.64 | 62 | 魔修长老 | 铃兰/赤芝 | 1 |
| 古修洞府 | 2 | 1.02 | 100 | 剑冢之主 | 冰莲/赤芝 | 2 |
| 云海仙岛 | 3 | 1.1 | 105 | 雷云老怪 | 冰莲/雷竹 | 3 |

每日 3 次、每次 15 灵力；进入时血量按 **1.5 倍**计算（`R:277`）。

**地图生成**（`R:278`）：3 层，每层 3 个普通行 + 1 个收尾行。普通行起始至少 1 列，70% 概率向左/右各扩一列 → 每行 1–3 个节点。收尾行固定 1 个节点（前两层 `elite`、第三层 `boss`）。

节点权重：`fight 38 / chest 10 / spring 8 / event 14 / shop 6 / trap 8 / camp 6 / herb 10`。

移动规则：从当前列 c 只能走到 `|c'−c| <= 1` 的列；如果当前行是最后一列或 `R<0`，下一行所有列都可走。**走 12 步正好通关**（3 层 × 4 行）。

节点效果：

| 节点 | 效果 |
|---|---|
| fight | 普通怪战斗；胜后回 10% 最大血，掉灵石/药材/材料 |
| elite | 1.4 倍怪 |
| boss | 1.7 倍首领；胜利直接结束并结算 |
| chest | 灵石 12，50% 材料，30% 药材 |
| spring | 回 40% 最大血 |
| camp | 回 30% 最大血、心境 +2 |
| trap | 掉 10%–20% 最大血，至少留 1 |
| event | 按种子+气运抽 5 种结果：12% 伤害 / mind+4 / 药材 / 宝箱 / 修为 `20*(1+k)*rootMult` |
| shop | 可买回春散（25，回 50% 血）/ 玄铁（80）/ 灵玉（80） |
| herb | 2–3 株区域药材 |
| amb | 仇人截杀，败则本趟全丢（普通战斗 30% 触发一次） |

**结算**：通关本趟掉落 100% 入账，首次通关额外 +2 培元丹 +2 回灵丹；战败/主动撤退只入账 50%；被仇人截杀 0%。

### 19.2 秘境的束搜索（`X:901`）

参考实现**没有**「优先战斗/优先事件/优先休息」的固定策略表。它利用一个关键事实：秘境地图、怪物、掉落、战斗全部由种子派生，**可以在本地用 `xsAct` 精确复现**。所以它直接做确定性束搜索：

1. `remainingSteps = (2−L)*4 + (3−R)`：从当前位置到结束的准确步数
2. 每层普通行有 1–3 个可达节点，`rlmNext` 给出所有合法下一节点
3. 对每个节点调用 `rgo`，得到实际战斗结果 `w`、掉落 `lt`、剩余血量、节点事件的真实随机结果
4. **商店节点的额外分支**：血量 < 80% 且灵石 ≥65（25 + 40 缓冲）且该店未买过 → 展开「先买回春散再走」的分支
5. 每个中间状态评分：

```js
lootScore = 灵石*0.5 + 丹药数*40 + 材料数*12 + 药材数*8
score = (hp / mx) * 1000 + lootScore - spentStone*4
```

6. 去重键 `${L}:${R}:${c}:${spentStone}`，同键只留最高分；按分排序保留前 **`REALM_BEAM_WIDTH = 14`** 条
7. **终点必须是 `res.end === 'win'`** 才进入完成集合；`lose` 或中途丢失 `rlm` 的分支直接丢弃

实际效果：战斗节点不是被「偏好」，而是因为胜利后回 10% 血、给掉落，分数通常高于空过；**打不过的分支会被模拟判负并剪掉**。春泉/营地因为提高终局血量比例而被间接偏好。商店只买回春散（玄铁/灵玉 80 灵石换材料在评分里不划算）。

### 19.3 「只认完整通关」的含义

- `solveRealmBeam` 只把 `end === 'win'` 的路径放进 `completed`；`completed.length === 0` 时返回 `null`
- `tryEmitAutoRealm` 只有拿到非空解才发 `xsRin`；**否则不进场**
- 所以「进场」意味着：规划器已经找到一条在本地确定性模拟中**必定打败最终首领、不会中途死亡**的路线
- 测试 11.9 断言弱角色在无必胜线时不会发出 `xsRin`，且不会出现 `rout` 或 `lose`

### 19.4 卡在秘境里怎么办 —— 一个已知死锁

参考实现**不会自动撤出**：

- `xsRout` 被 `assertSafeXianBatch` 永久禁止（只带回一半掉落）
- 如果已在秘境且束搜索找不到任何通关路径，`tryEmitAutoRealm` 遍历完所有配招后**直接 return，不产生任何动作**
- `computeNextXianWakeSec` 也没有为「已在秘境但无解」添加专门候选

正常退出方式只有：玩家网页端手动撤退、某次自动路线战败（同 50%）、或等 6 小时后 `rin` 强制结算旧秘境。这是已知风险 —— 参考实现用「只进必胜本」从源头避免，但**没有为已卡住的状态留逃生口**。

### 19.5 配招：4 个槽位怎么选

`buildCandidateSlotSets`（`X:843`）：

1. 先放**当前配招**（保证不会比现状更差）
2. 再按 12 套模板生成候选（必须恰好 4 个、互不重复、全部已学）：

| # | 模板 |
|---:|---|
| 1 | `[本元素1, 木2, 水2, 雷2]` |
| 2 | `[本元素1, 木2, 风2, 水2]` |
| 3 | `[最强1, 木2, 雷2, 风2]` |
| 4 | `[最强1, 水2, 土2, 木2]` |
| 5 | `[最强1, 水2, 护盾, 控制/快攻]` |
| 6 | `[最强1, 控制1, 控制2, 水2]` |
| 7 | `[最强1, 第二强1, 水2, 木2]` |
| 8 | `[最强1, 第二强1, 雷2, 风2]` |
| 9 | `[最强1, 毒2, 木2, 水2]` |
| 10 | `[最强1, 金2, 风2, 灵弹]` |
| 11 | `[本元素1, 本元素2, 水2, 护盾]` |
| 12 | `[本元素1, 本元素2, 灵弹, 护盾]` |

`nuke1Order`（最强 1 技能优先级）：风 → 雷 → 金 → 冰 → 毒 → 熔 → 火 → 水 → 木 → 土。去重后最多返回 14 套。

**为什么顺序重要**：战斗模拟每 0.1 秒从槽 0 到槽 3 找第一个冷却好的技能然后 break（`R:262`）。同样四个技能，把控制/爆发放前面会改变读条和冷却节奏；**治疗技能在血量 >75% 时跳过，护盾在已有护盾时跳过**，所以顺序还会影响这些技能的「是否愿意现在放」。

**试配招怎么搜**：
- **秘境**：对每套候选 → 克隆状态 → 写入 `slots` → `rin` → 跑束搜索。**只有能搜出完整通关路径**，才把 `slots → rin → 整条路径` 一起提交
- **斗法**：对每个目标、每套配招 → 用真实种子跑模拟 → 只有 `res.w === 1` 才提交 `slots` + `ab`

### 19.6 斗法

自动同门斗法（`xsAb`，`R:332`）：

- 每天 8 次、每次 10 灵力，**与手动试炼共享 `df` 日计数**
- 种子 `hseed(日, NPC, 当日第几场, 灵石, 修为)` —— 本地可完全复现
- 胜：当天第一次赢该 NPC 给 `round(15*(1+0.5r))` 灵石（熔岩 ×1.3、结拜 ×1.1）；`tw.n++`；主修熟练 +1，可能升层；**不给修为**
- 负：无额外惩罚；无论胜负都 **+3 好感**

**目标顺序**：今天没赢过的 NPC 按等级从低到高；如果有未完成胜利委托，再把今天已赢过的加进候选（重复赢仍给熟练/好感，`tw.n` 也会涨）。

**角色战力**（`R:240`）：

```js
myHp  = 100 + 60*r + 5*(s-1)
power = (1 + 0.3*r + 0.03*(s-1)) * techEff * techPerks(techLayer).power
```

**NPC 战力**：`pw = 0.7 + 0.06*lv`、`hp = 90 + 10*lv`，技能槽固定 `[本元素1, 本元素2, bolt, guard]` 后按哈希旋转。

**战斗模拟**（`R:249`）：最长 60 秒、0.1 秒一跳、确定性 RNG。克制关系 `WHEEL`（金克木、木克土、土克水、水克火、火克金）：被克制方伤害 ×0.75、读条 ×1.2。10% 暴击 ×1.5；护盾可吸收非穿透伤害；灼烧/眩晕/减速/打断都存在。60 秒后按剩余血量比例判胜，**平局判负**。

### 19.7 融合：`selectOptimalFusionPair`（`X:230`）

1. 只取基础灵根；变异灵根不能继续参与
2. 枚举所有 `i<j` 对，查 `FUSIONS` 表；指定了 `fuseTarget` 则只保留该产物
3. 对每个候选计算 `totalReachableFusions = 1 + maxPentagonMatchingCount(rest)` —— 递归算出「融合完这一对之后最多还能融合几次」
4. 排序：`totalReachableFusions desc → variantPriority asc → key asc`
5. `VARIANT_TECH_PRIORITY = ['poison','ice','wind','fire','wood','metal','earth','water','thunder','lava']`

**四灵根链的端点保护**：链 A-B-C-D 有三条合法边。选 A-B（端点）后 C-D 仍可融合 → 2 次；选 B-C（中间）后 A 和 D 不相邻 → 1 次。排序把端点边排前面，**绝不会选中间边**（测试 11.6 断言）。

**五边形 C5**：任意一对相邻融合后必剩一条路径，所以所有候选都是 2 次，按变体优先级排。

**参考实现没有显式计算期望收益**，而是用三个门控把失败损失压到最小：
1. 只在 `xp <= max(15, cvNeed(r,s)*0.12)` 时融合（失败最多损失约 12% 本层修为）
2. 两条基础灵根的功法都必须**先学**（融合后基础根消失，但功法永久保留 —— 先学避免永久错过）
3. 选「能保留最多后续融合次数」的配对

**为什么默认 `autoFuse = false`**：融合是**永久且不可逆**的 —— 成功则两条基础灵根消失，失败有 24 小时冷却 + 修为损失，选错配对会堵死后续融合。`autoAll/opt3` 也**不会**顺带打开它，必须显式 `--xian-auto-fuse`。

### 19.8 2.0 与 1.0 的灵力竞争

2.0 的硬上限：8 场斗法 ×10 + 3 次秘境 ×15 = **125 灵力/天**。1.0 农事和起炉优先，2.0 只在富余跨过门槛时做（具体门槛见 18.11）。

**自动斗法不加修为** —— 修为只来自手动试炼、往事选项、机缘选项、秘境事件结果。2.0 给 1.0 的是**资源**（灵石、药材、材料）和**永久乘数**（心境、气运、关系）。

## 20. 每日目标

### 20.1 规则

**目标池**（`R:270`，共 17 条，分三档难度）：

| 难度 | 目标 | 数量 | 前置条件 |
|---|---|---|---|
| 1 | 播种 | 10 | — |
| 1 | 收获作物 | 8 | — |
| 1 | 手动浇水 | 8 | **洒水器未全覆盖** |
| 1 | 收动物产物 | 3 | **有动物** |
| 1 | 钓鱼 | 6 | — |
| 1 | 敲矿石 | 15 | — |
| 2 | 收获作物 | 25 | — |
| 2 | 钓鱼 | 20 | — |
| 2 | 敲矿石 | 40 | — |
| 2 | 卖货收入 | 80,000 | — |
| 2 | 加工 | 5 | — |
| 2 | 收动物产物 | 10 | **畜栏 ≥2** |
| 3 | 收获作物 | 60 | **地块 ≥10** |
| 3 | 卖货收入 | 300,000 | — |
| 3 | 敲矿石 | 80 | — |
| 3 | 加工 | 15 | — |
| 3 | 钓鱼 | 45 | — |

**选题**（`pickGoals`，`R:279`）：

```js
for (const [t, n] of [[1,2],[2,1],[3,1]]) {
  const pool = GOAL_POOL.map((g,i) => ({g,i,r:worldHash('goal2:'+day+':'+i)}))
    .filter(x => x.g.t === t && (!x.g.ok || x.g.ok(s)))
    .sort((a,b) => a.r - b.r)              // 按 hash 排序 = 确定性随机
  for (const x of pool) { if (list.length >= [0,2,3,4][t]) break; ... }
}
```

即 **2 个简单 + 1 个中等 + 1 个困难 = 4 个目标**，同一天所有人一样，但按每个玩家自己的岛况过滤（洒水器全覆盖就不出浇水、没动物不出收集）。

**奖励**（`goalReward`，`R:292`）：

| 完成 | D 币 | 物品 | 站宠 |
|---|---:|---|---:|
| 简单目标 | 5,000 | 随机 1 项：饲料×10 / 鱼饵×6 / 当季种子×6 / 铜矿×6 | — |
| 中等目标 | 15,000 | 随机 1 项：当季后两种种子×12 / 鱼饵×15 / 炸药×2 / 铁矿×8 | — |
| 困难目标 | 40,000 | 随机 1 项：炸药×3 / 红宝石×1 / 当季后两种种子×20 | 3 |
| **k=4 全完成** | **30,000** | **祖母绿×1 + 炸药×2** | **3** |

k=4 的前置：**4 个目标都已领奖**（不是「都完成」，是「都领过」）。

### 20.2 参考实现怎么领

`collectClaimableGoalActions(R, naturalDay, state)`（`planner/solve.mjs:45`）：

```js
for (let k = 0; k < 4; k++) {
  if (alreadyClaimed) { readyOrClaimed[k] = true; continue }
  if (count(goals[k].id) >= goals[k].n) { goalActs.push({a:'goal', k}); readyOrClaimed[k] = true }
}
if (readyOrClaimed.every(Boolean) && !state.cnt?.goal4) goalActs.push({a:'goal', k:4})
```

**一次收集全部可领的，包括最后的 k=4 奖励**。领奖不消耗动作/体力/灵力（`goal` 分支没有 `s.en -= cost`），所以在规划器里它是「免费收益」，被放在 `solve.mjs:3928`（probe）和 `:6813`（exec）两处无条件加入批量。

> 注意：`goal` 动作**计入 `s.cnt.<id>` 的完成度判断是服务端自己维护的**。领奖时服务端只检查 `count(goals[k].id) >= goals[k].n` 和 `count('goal'+k)`，所以「先领小奖再领 k=4」必须在同一个批次或按顺序提交 —— 参考实现把它们都放进同一批，`k=0..3` 在前、`k=4` 在最后。

### 20.3 目标计数口径（决定完成速度）

| 目标类型 | 计数方式 | 出处 |
|---|---|---|
| 播种 / 浇水 / 收获 / 收动物 / 加工 | 每执行一次动作 +1；**加工按数量 +n** | `rules.js:540` `:560` `:581` `:684` `:777` |
| 钓鱼 | 每次下竿 +1，**跑鱼也算** | `rules.js:729` |
| 挖矿 | 每次挖矿 +1；**炸药额外 +6** | `rules.js:751` `:784` |
| 卖货收入 | 按**税后净入账** `value` 累加，不是挂牌价；**卖动物不计入** | `rules.js:916` `:613` |

**目标按自然日、配额按岛日** —— 一个自然日跨多个岛日，所以目标可以跨岛日累计，而鱼/矿配额每 3.5 岛日（约 14 小时有效时间）就重置一次。

### 20.4 领奖的时点（参考实现）

三处领奖，各有目的：

| 时点 | 目的 | 出处 |
|---|---|---|
| 每个事件桶的**预演阶段** | 让奖励金币/物品进入后续体力-现金模拟 | `solve.mjs:3926` |
| 执行阶段 **3.5（卖货之前）** | 覆盖农务/加工/收笼刚完成的目标 | `solve.mjs:6811` |
| 执行阶段 **4.5（卖货之后）** | 专门处理 `sold 80,000/300,000` 这类卖完才达标的，并在同一批领 k=4 | `solve.mjs:6826` |

**奖励不扣税**（只有 sell/sellAnimal 走卖货税）。领奖 0 体力，但占 1 个动作槽（单批最多 40）。

### 20.5 规划器不主动追目标

参考实现**不会**为了拿目标额外安排「再挖 80 下」或「再钓 45 竿」—— 它只把目标当顺手奖励。正常配额（鱼 80、矿 100）远大于目标阈值（鱼 45、矿 80），所以鱼/矿目标通常自然完成；收获 60、加工 15 则取决于当日农务/加工计划是否够。

> 对比：**站内管家只领简单+中等**（过滤条件是 `gs[k].t < 3`，`rules.js:1138`），所以它**永远不会触发 k=4**。如果托管交给管家，全清奖励的 30,000 D + 祖母绿 + 炸药×2 全部拿不到。

---

## 21. 纪事、夜潮与剧情

### 21.1 山谷纪事（3 章）

| 章 | 标题 | 内容 |
|---:|---|---|
| 1 | 重开海路 | 货船靠岸，四条航线通向不同季节；说明货船按基础价售货、每岛日换货 |
| 2 | 暖棚与仓灯 | 仓库预留机制；动物幼年/成长/成年/老年四阶段；长夜里作物继续生长 |
| 3 | 静潮公约 | **每晚 22:00 关闭航标、岛钟停到 08:00**；商店和岛日额度不刷新但现实生产继续；季末第 11/12 岛日归港节，公库向资金较少、持续经营的玩家发补贴 |

`storyRead` 动作（`R:1693`）：参数 `chapter` 1–3，记录到 `s.b12.chapters` 位图，**不消耗任何资源**。这是纯阅读动作，无奖励。

> 第 3 章是理解整个「长夜时钟」的官方说明 —— 岛钟在 22:00–08:00 完全停摆，这就是 `b12ActiveSeconds` 每天只累计 14 小时的来源。

### 21.2 夜潮（每日小礼）

`b12NightView(s, t)`（`R:1686`）：

```js
key = worldDay(t - 22*3600)          // 以「昨晚 22:00」为界
start = Date.parse(key + 'T22:00:00+08:00') / 1000
roll = worldHash('b12-night:' + s.b12.storySeed + ':' + key)
event = available && roll < 0.2 ? min(3, floor(roll / 0.05)) : -1
```

- **20% 概率有事件**（4 档，每档 5%）
- `available` 要求 `b12ClockStart()` 已配置且 `start >= clockStart` 且 `storySeed` 是安全整数
- **确定性**：同一晚反复刷新不会改变结果（注释明确写了「刷新和反复访问不会改变结果」）

4 个事件（`R:1680`）：

| 标题 | 奖励 |
|---|---|
| 漂流瓶里的种植札记 | 小白萝卜 ×1 |
| 修灯人的回礼 | 鱼饵 ×2 |
| 暖棚门前 | 饲料 ×2 |
| 鲸群的潮汐便笺 | 小白萝卜 ×1 |

领取：`nightClaim` 必须带正确的 `key`（服务端会校验，key 变了报「夜潮已经变化」）；已领过报「这段夜潮的礼物已经领取」。

价值很低（道具价值 < 1000 D），但**零成本**，属于「顺手领」。

**参考实现不领**：`planXianActions` 和 `solve.mjs` 的默认动作集合里都没有 `storyRead` 和 `nightClaim`（`solve.mjs:7436` `solve.mjs:10813`）。所以这两项都是**纯遗漏**，不是有意不做。

如果要补，逻辑很简单：
- 三章纪事各发一次 `{a:'storyRead', chapter:i}`
- 每自然日第一次规划前用 `b12NightView(state, t)` 判断 `claimable`，可领时发 `{a:'nightClaim', key}`

**key 的时效**：`b12NightKey(t) = worldDay(t - 22*3600)`，在每天 22:00 切换。所以前一晚的礼物**最晚可以到当天 22:00 前领**，过了 22:00 就换成新 key。

---

## 22. 咖啡、口粮与体力经济

### 22.1 三种体力来源

| 来源 | 价格 | 体力 | 每日上限 | 重置时钟 | 能否突破上限 |
|---|---:|---:|---:|---|---|
| 咖啡 | 15,000 | 60 | 3 杯 | 自然日 | **能** |
| 潮汐饭团 | 6,500（货船） | 20 | 2 个 | 自然日 | 不能（满了一律拒绝） |
| 吃作物 | 作物自带 `eat` 值 | 6–20 × 品质 | 无 | — | 不能（满了一律拒绝） |

作物食用值（`crop.eat`）：小白萝卜 8、胡萝卜 10、小麦 6、草莓 14、番茄 12、玉米 14、葡萄 12、南瓜 20、冬白菜 12。

**只有咖啡能突破上限**（`R:886` 直接 `s.en += 60`，没有截断）。`eat`（`R:872`）和 `tide_snack`（`R:1567`）都是 `min(energyMax, ...)`，且**体力已满时直接拒绝**（不消耗物品）。

**吃作物按品质放大**：`s.en += round(crop.eat * QUALITY[q])`（`R:872`）—— 金星作物（q=2）给 **1.5 倍**体力。所以金星南瓜一口回 **30 点**。

> **关于潮汐饭团的重要更正**：它不是长夜小礼，而是**货船的稀有补给**（`R:1325`）。每个岛日有 15% 概率出现在货船的 supply 组，**每人限购 1 个**（`R:1334` `R:1336`）。

### 22.2 单位体力成本

| 方式 | 每点体力成本 | 备注 |
|---|---:|---|
| 咖啡 | 250 D | 唯一能突破上限；每天 3 杯 |
| 潮汐饭团 | 325 D | 出现率 15%/岛日，限购 1 |
| 吃南瓜（普通品质） | ~450 D | 按卖价 9000 ÷ 20 |
| 吃金星南瓜 | ~300 D | 30 点 ÷ 9000 |
| 「缺口兜底价」 | 450 D | 规划器对补不上的强制缺口用的惩罚估值（`solve.mjs:5697`） |

**规划器的判断顺序**（`solve.mjs:3222` 附近）：

```
有剩余每日额度 && 有体力缺口 && (20 × 当前最优工作的每体力净收益 > 6500 × 折现)
   → 买饭团
咖啡同理，250 D/体力，更便宜，先用满 3 杯
```

**结论**：低等级挖矿约 293 D/体力、竿 1 钓鱼约 356 D/体力 —— 325 的饭团只是勉强。中后期 30 层挖矿约 1,148、竿 3 好时段 1,278–2,071 —— 325 非常划算。所以「**前期按需、后期见到就买**」。

### 22.3 体力机会成本

体力是**内生资源**：上限内会自然回复，满了就不再累计。所以：

- **快满时的体力 ≈ 免费** → 适合做低价值动作（挖浅层、浇地）
- **刚用完的体力 ≈ 最贵** → 适合留给定点狙击（偷菜解禁、擂台）
- 一天自然回复约 480 点（含小屋加成后更多）

参考实现在 `planner/resources.mjs` 里按**回复相位**建桶，就是为了精确表达「这 3 点体力 12 分钟后才回，但现在就能用掉」。

### 22.4 同岛日跨自然日时能喝 6 杯咖啡

如果同一个岛日跨过自然日午夜，咖啡配额会在午夜重置。规划器会计算：

```js
postMidCoffeeCap = min(3, 可用现金 / 15000)
// 允许在同一个岛日内最多喝 6 杯
```

（`solve.mjs:5647` `solve.mjs:5463`）

这是「跨岛日携带能量」的手段之一：规划器把跨岛日体力的价值上限设为 `min(下一岛日最高工作每体力收益, 咖啡每体力成本)`（`solve.mjs:5268`）。

---

## 23. 管家（挂机）与离线

### 23.1 规则：**注释与代码不一致，以代码为准**

`R:1015` 的注释写：

> 每 4 小时巡视一次…最多补 2 天（12 轮）…雇佣一次 30 万 D币，之后每轮巡视付 5000 工钱…钓鱼/挖矿每次多耗 2 点体力…代卖抽成 20%…没有咖啡

但**实际常量**（`R:1021`）：

```js
export const AUTO = {
  every: 2 * 3600,        // 2 小时（注释说 4 小时）
  maxBack: 48 * 3600,     // 48 小时
  maxVisits: 24,          // 24 轮（注释说 12 轮）
  fee: 0,                 // 代卖抽成 0（注释说 20%）
  surcharge: 0,           // 钓鱼/挖矿不加耗（注释说 +2）
  budgetMax: 5_000_000,
  hire: 150_000,          // 雇佣 15 万（注释说 30 万）
  wage: 1_500,            // 每轮工钱 1500（注释说 5000）
}
```

**结论：注释是上一版的遗留，实际规则宽松得多** —— 不加耗、不抽成、每 2 小时一轮、工钱只要 1500。参考实现读的也是代码，所以它的估值按 `fee = 0` 算。

**更严重的注释冲突**：注释说「管家收获只有普通品质、不会多收；鱼也普通品质；代卖抽成 20%」（`R:574` `R:1019`）。但实际调用是 `auto:false, butler:true`（`R:1054`），而品质/多收/抽成判断用的都是 `ctx.auto`（`R:575` `R:739` `R:911`）。

> **所以当前版本管家实际拿到的是正常品质、正常多收概率、0 抽成、无额外体力消耗。** 真实差异只剩：每 2 小时一次的行动粒度、每轮 1500 工钱、不喝咖啡、不领困难目标/k4。

### 23.2 管家默认策略

`AUTO_DEFAULT`（`R:1022`）：

```js
{ on: false, crop: 'best', water: true, feed: true,
  fishPct: 50, keep: 30, sell: true, minPct: 90,
  budget: 100_000, craft: false, bomb: false, goals: true, guard: 0 }
```

| 字段 | 含义 |
|---|---|
| `crop: 'best'` | 补种时选「当前最值钱的」 |
| `water: true` | 自动浇水 |
| `feed: true` | 自动喂食 |
| `fishPct: 50` | 剩余体力 50% 钓鱼、50% 挖矿 |
| `keep: 30` | 卖货时保留 30% 库存 |
| `sell: true` / `minPct: 90` | 只有价格 ≥ 基础价 90% 才卖 |
| `budget: 100_000` | 单轮采购预算 10 万 |
| `craft: false` / `bomb: false` | 默认不加工、不炸矿 |
| `goals: true` | 顺手做每日目标 |

**一轮巡视的顺序**（`R:1077` 的循环，逐行细节）：

| 步 | 做什么 | 出处 |
|---:|---|---|
| 1 | **收蟹笼**：所有 `n>0` 的笼 | `R:1090` |
| 2 | **牧场**：收所有可收产物；需要喂的（距上次 ≥8 小时且未退休）先补买饲料（缺多少买 `lack+5`，预算内才买），再逐只喂 | `R:1092` |
| 3 | **农田收获/清理**：成熟收，反季枯萎清 | `R:1106` |
| 4 | **浇水 + 补种**：非雨天、非洒水地块、该阶段未浇水的才浇；按 `bestCrop(season)` 在空地补种，要求预算 ≥ 种子价且 `体力 - keep >= 2` | `R:1114` |
| 5 | **可选**：炸药最多 3 个（受剩余体力约束）；加工只做「成品价 > 原料价×1.1」的配方；守家按配置买；目标只领 `t<3` 的简单/中等 | `R:1126` |
| 6 | **剩余体力钓鱼/挖矿**：`spare = en - keep`；`nf = floor(spare*fishPct/100/4)`，`nm = floor((spare - nf*4)/3)`；先钓鱼（背包有饵就用），再挖到 `f:99` | `R:1139` |
| 7 | **仓库补预留 + 到价自动卖**：`b12ReplenishWarehouse` 先补目标进 vault，再跑 Lv3 仓库的到价自动出售订单 | `R:1148` `R:1537` |
| 8 | **卖货**：只卖当前价 ≥ 基础价 × `minPct%`（默认 90%）的物品，按品质行分别卖 | `R:1150` |

补算上限 `maxVisits = 24` 轮 = 48 小时，超出部分不再补。每轮先付 1500 工钱，现金不够就跳过该轮但时间戳仍推进（`R:1078`）。

**管家的选种估值式**（`R:1032`）：

```js
v(c) = (c.price*1.4*(c.regrow ? min(c.times,3) : 1) - c.seed)
       / max(巡视间隔分钟数, c.grow*0.6)
```

`1.4` 是品质/多收的经验倍率，不是精确期望。

### 23.3 参考实现怎么处理管家

**参考实现完全没有处理管家**：

- `planner` / `execution` / `cli` 里**没有**调用 `autoSettle`、`autoConfig`，也没有设置 `s.auto` 的代码
- `autoSettle` 只存在于规则模块（`R:1318`），由站内服务端在玩家回来时调用
- 参考实现本身是持续在线的 live-daemon，每个事件桶直接提交动作，**相当于用实时精确规划替代管家**

对我们的启示：如果账号同时开着站内管家，可能出现「管家 2 小时结算 + 直连动作」两套逻辑同时作用，并额外付工钱。**接入时必须显式关闭站内管家**（我们的 `core/engine.mjs` 已经做了这件事）。

### 23.4 管家相对亲手玩的缺口

| 缺口 | 说明 |
|---|---|
| 只领简单/中等目标 | **从不领困难目标，也永远不触发 k=4**（`R:1138`） |
| 不喝咖啡、不吃潮汐饭团 | 完全不补能量（`R:1139`） |
| 不买鱼饵、不买炸药 | 只用背包里现有的（`R:1143`） |
| 不做出访/偷菜、擂台、52弟、纪事/夜潮、货船采购 | 全流程都没有 |
| 钓鱼/挖矿固定 50% 分配 | 不择黄金时段，不动态比较单位体力收益 |
| 卖货只看 `minPct` | 不做跨岛日行情持有/批次优化 |
| 每 2 小时一次的行动粒度 | 作物成熟后可能等最多 2 小时才收 |

---

## 24. 总调度：一轮里先做什么后做什么

参考实现 `cli/live-daemon.mjs` 的主循环分三阶段，**严格按因果顺序、零叶子反转**：

```
Phase A: 解禁前分阶段掐点快车道（leadSec <= 16）—— 最高优先级，零后台阻塞
Phase B: 可抢占的统一经济 runControllerStep
         （AsyncPlanManager Worker + PlanCache + 硬 deadline T_unlock-14s 时终止）
Phase C: 可抢占后台切片，仅当 !shouldBlockBackgroundWork(now, 50) 时跑
         —— 站宠护理 → 擂台单场 → 修仙 → 52弟玩具摊 → 增量发现
```

`deltaSec = min(120, nextWakeSec - now)` —— 主循环硬上限 120 秒。

Phase C 内部的顺序是有讲究的：

| 顺序 | 模块 | 为什么排在这里 |
|---:|---|---|
| 1 | 站宠护理 | 等级影响擂台面板，**必须在读 gear 之前** |
| 2 | 擂台单场 | 每场 8.5 秒，可被偷菜窗口打断 |
| 3 | 修仙 | 独立存档，不占主岛资源，随时可让位 |
| 4 | 52弟玩具摊 | 五子棋离线求解，不占主岛资源 |
| 5 | 增量发现 | 每次只扫 2 页、探 4 家，每个 HTTP 前检查偷菜窗口 |

**为什么擂台在修仙之前**：擂台有每日场次上限（30 场），漏一天就少一天的宝箱和战报；修仙没有每日「必须做完」的硬额度，晚一轮代价小。

**为什么增量发现排在最后**：它是最容易被中断的模块（每个 HTTP 前都可让路），放在最后不会阻塞任何有硬时限的任务。

### 24.1 我们（本项目）的调度顺序

我们的 `core/engine.mjs` 是另一套（顺序规划 + 模块化切片），顺序是：

> 收获/种植/浇水/清理/喂食/收产物/蟹笼/钓鱼/挖矿/加工/卖货/买货/升级/扩建/目标/咖啡/进食/囤货/夜潮/纪事/守家补偿

两套的差别：

| 维度 | 参考实现 | 我们 |
|---|---|---|
| 决策方式 | 统一规划器一次求解，输出第一个桶 | 顺序规则 + 局部优化 |
| 抢占 | Worker 线程硬杀 | 每步检查 `shouldAbort` |
| 偷菜优先级 | Phase A 独占，主规划有硬 deadline | `snipeWindow` 让路，硬抢占主循环 |
| 后台任务 | 严格串行，按固定顺序 | 各自有 stall 计数，独立退避 |
| 唤醒 | `min(120, nextWake - now)` 单一节拍 | 多来源唤醒取最小值 |

---

## 25. 站点规则里容易误解的 12 个点

以下是通读规则原文时发现的、容易按直觉理解错的地方：

| # | 常见误解 | 实际规则 | 出处 |
|---:|---|---|---|
| 1 | 岛日是现实 4 小时 | 还要**跳过每天 22:00–08:00**，一天只走 3.5 个岛日 | `R:1183` |
| 2 | 浇水一次缩短 25% 生长时间 | 是「每阶段一次」，`p.w > st.stage` 时拒绝；缩短的是**当前剩余时间**的 25% | `R:554` `R:561` |
| 3 | 雨天/洒水器只是省事 | 收获时按 `w = 3` 算**品质和额外产出** | `R:572` |
| 4 | 作物按自然日刷新 | 生长走**岛钟**，售卖阶梯走**自然日**，两者不同步 | `R:89` vs `R:472` |
| 5 | 钓鱼/挖矿每日 80/100 次是自然日 | 是**岛日**（`ibump` 用 `isleIndex`） | `R:722` `R:744` |
| 6 | 加工扣料随便扣 | 严格 `q0 → q1 → q2` **低星优先** | `R:775` |
| 7 | 售卖税是固定比例 | 边际累进，且**按当日累计 carry** 递增（1% → 3%） | `R:1645` |
| 8 | 供需因子看全站昨日销量 | 岛日分母是 `marketDepth(item)`（按基础价算，800–6000），非岛日才是固定的 400 | `R:132` `R:140` |
| 9 | 动物喂一次管 8 小时 | 可以 8 小时后喂，但**产出只累计 24 小时**，窝满了就不再涨 | `R:631` `R:1611` |
| 10 | 动物永久产出 | 有**退休机制**：鸡 24 岛日、猪 72 岛日；退休后不再产出，但待收产物仍可取 | `R:1574` `R:1592` |
| 11 | 修仙贡献可以兑换 | `ctb` 只累加，**没有任何消耗动作**；宗门等级由 `rep` 决定 | `R:221` `R:140` |
| 12 | 管家的注释说抽成 20% | 实际 `AUTO.fee = 0`，注释是旧版遗留 | `R:1021` |

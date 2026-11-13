# 鱼鱼谷规则机制全量分析（版本 05a5c445 / 修仙 20b20a0e）

> 缩写：**R**=`cache/rules-05a5c445.mjs`（1706 行，站点 `/pet-world-rules.js` 原文）；**A**=`cache/arcade-05a5c445.mjs`（157 行）；**X**=`core/xian-rules.mjs`（348 行，修仙 `xs/rules.js` 原文）。
> 外部常量引用 **S**=`core/social.mjs`、**SS**=`core/steal-schedule.mjs`、**AR**=`core/arena.mjs`、**BR**=`core/battle-rules.json`。
> 三份规则文件已与线上逐字节核对（md5：`6d961f38…` / `e790cdcd…` / `f824c9bf…`）。所有数值均带 文件:行号。生成日期 2026-11-13。

## 0. 对全自动托管最重要的结论

1. 岛日时钟只在北京时间 08:00–22:00 走：现实 4 小时 = 1 岛日，22:00–08:00 冻结；自然日 0 点重置 `cnt`/目标/税日，岛日额度按 `isleIndex` 重置（R:29、R:451-469、R:510、R:1179-1186）。
2. 体力上限 100+20×小屋等级，最高 200；每 180 秒回 1 点（R:13、R:449、R:451-461）。
3. 当前管家实际参数：每 2 小时一轮、最多回溯 48 小时/24 轮、每轮工钱 1500、代卖抽成 0、钓/矿附加耗体 0；注释里的「4 小时/2 点/20%」已过期（R:1016-1021）。管家内部用 `auto:false, butler:true`，所以收获/钓鱼/产物没有「仅普通品质」惩罚（R:1054、R:575、R:675、R:739）。
4. 岛日时代作物按**种植当日**的季节判定，正常种下后不会换季枯萎；只有旧版（`p.t < ISLE_LAUNCH`）按当前季节判枯（R:474、R:528）。
5. 售卖税：资产 300 万内免税；超过 300 万部分 1%，超过 1000 万部分 3%；每笔卖货按「钱包+当日已缴」增量计税并有 gross 上限保护（R:1638-1653）。
6. 集市价 = 基础价 × 随机游走 × 季节 × 单商品暴涨暴跌 × 供需 × 商会事件；岛日每天全站 2 条商会事件，非岛日无事件（R:119-141、R:250-268）。
7. 货船每岛日固定 5 组货，个人额度独立、按基础价卖，不抢库存；`stockBuy` 必须带当日 `day`（R:1327-1339、R:1551-1560）。
8. b26 的 vault 只是 `inv` 的预留子集；仓库格/单格上限约束 `warehouse` 和管家补货，自动出售只在管家巡视的屏蔽上下文执行（R:1206-1207、R:1290-1299、R:1538-1544）。
9. 夜潮礼物由 `s.b12.storySeed` 决定，R 不生成该字段；服务端不注入则永远没有礼物（R:1687-1690）。
10. 修仙的修为、突破、丹方、斗法、秘境全部在 X；1.0 与 2.0 动作分层实现，确定性战斗/秘境由 `hseed/rng` 重放（X:74、X:202、X:241-242）。

---

## A. 世界与时间

### A.1 自然日与岛日

- `worldDay(t) = new Date((t+8*3600)*1000).toISOString().slice(0,10)`，即北京时间日期（R:29）；`hourOf(t)` 取北京时间小时（R:32）。
- `ISLE_SPAN = 4*3600`，`ISLE_LAUNCH = 1794052800`，`ISLE_SEASON_DAYS = 12`（R:34）。1794052800 = 北京时间 2026-11-07 20:00。
- `isleIndex(t) = floor(b12ClockSeconds(t)/14400)`（R:35）；`isleDay(t)` 是 `isleIndex*86400000` 的虚拟日期（R:36、R:41）。
- `isleHour = floor((clock%14400)/600)`；`isleMinute = floor((clock%14400%600)/10)`——1 岛小时 = 现实 10 分钟，1 岛分钟 = 现实 10 秒（R:37-38）。
- `isleDayNo(t) = isleIndex(t) - isleIndex(ISLE_LAUNCH) + 1`，上线当天为第 1 岛日（R:39）。
- `isleSeasonLeft = 12-1-(((isleIndex-launchIndex)%12)+12)%12`，0 表示本季最后一天（R:40）。
- 旧版真实季节：以 2026-11-02（周一）为春第一周，每 7 天换季（R:31）。

### A.2 季节与天气

- `SEASONS=['春','夏','秋','冬']`，`WEATHERS=['晴','雨','风','雪']`（R:26-27）。
- 岛日季节：`floor((isleIndex(day)-isleIndex(launch))/12) mod 4`（R:31）；第 1–12 岛日春、13–24 夏、25–36 秋、37–48 冬。
- `b12Season(t) = floor((isleDayNo(t)-1)/12)`，从 0 开始（R:1655）。
- 天气由 `worldHash('weather:'+day)` 决定（R:112-117）：
  - 冬季：`r<0.35` 雪(3)，`r<0.50` 雨(1)，`r<0.65` 风(2)，否则晴。
  - 其他：`r<0.30` 雨，`r<0.45` 风，否则晴；非冬季不会下雪。
- 效果：雨自动浇水且鱼更好钓（R:549、R:732、R:737）；风使蟹笼速率翻倍（R:485、R:707）；雪使高价宝石权重 ×1.6（R:756、R:787）。

### A.3 长夜时钟

- `b12ConfigureClock(epoch)` 只接受 `[ISLE_LAUNCH, 4,000,000,000]` 的安全整秒（R:1171-1177）；`b12ClockStart()` 未配置为 0（R:1178）。
- `b12ActiveSeconds(t)` 只累计每天 08:00–22:00 的 14 小时；`b12ClockSeconds(t)` 在锚点后返回「锚点+8h + 两端活动秒差」，22:00–08:00 冻结；未配置或 `t<=锚点` 退回 `t+8h`（R:1179-1186）。
- `b12IsLongNight(t)`：北京小时 ≥22 或 <8（R:1187-1189）。
- `b12NextIsleBoundary` 跳过夜间，最多跨一个长夜（14h > 4h）（R:1190-1203）。
- 夜潮键 `b12NightKey(t) = worldDay(t-22*3600)`（R:1204）。
- `b12AfterActive(t, seconds)` 按活动秒换算真实时间，跳过 22:00–08:00，最多循环 1000 次（R:1575-1587）。

### A.4 每日重置边界

| 计数器 | 存储 | 重置条件 | 行号 |
|---|---|---|---|
| 体力日、自然日 `cnt` | `enDay`,`cnt` | `worldDay(t)` 变化 | R:451-465 |
| 当日收入 | `earn={day,amt}` | 自然日变化 | R:466-467 |
| 岛日额度 fish/mine/craft/bomb | `iq={d,...}` | `isleIndex` 变化 | R:433、R:510-511、R:721-722、R:743-744、R:771、R:780-781 |
| 每日目标 | `goals={day,list}` | 目标 day 变化 | R:287-288 |
| 售卖税日 | `b12.tax={day,paid}` | 自然日变化且时钟已配置 | R:1651-1653 |

> `b12SaleQuote(wallet,paid,gross)` 是**纯函数、不做日界**；只有 `b12TaxSale` 会在 `d.tax.day!==worldDay(t)` 时把 paid 归零。所以任何在本地预测卖货税的地方（`core/market.mjs` 的 `sellPlan`）都必须自己先判 `tax.day===worldDay(now)`，否则跨 0 点后拿昨天的 paid 去算，会高估今天的税。
| 货船个人额度 | `b12.shop={d,n}` | `isleDay(t)` 变化 | R:1339、R:1558 |
| 游乐馆次数 | `arc.d/n` | `ctx.day` 变化 | R:1477、R:1489 |
| 夜潮领取 | `b12.night.key` | 夜潮 key 变化 | R:1686-1701 |
| 本季活跃掩码 | `b12.activity={season,mask}` | `b12Season` 变化 | R:1656-1659 |

---

## B. 体力

- 上限：`energyBase=100`，每级小屋 `+20`，`energyMax(s) = 100+20*s.tools.house`（R:13、R:449）；小屋最高 5 级 → 200（R:17）。
- 回复：每 180 秒 1 点；满上限后 `enT` 跟随当前时间，不积累（R:13、R:453-461）。升级小屋立即 `en += 20`（R:965-968）。
- 食物：
  - 作物 `eat`：萝卜 8、胡萝卜 10、小麦 6、草莓 14、番茄 12、玉米 14、葡萄 12、南瓜 20、冬白菜 12（R:43-51）。
  - `eat`：消耗 1 个指定品质，回复 `round(eat*QUALITY[q])`；`QUALITY=[1,1.25,1.5]`；满体力不能吃（R:861-873、R:87）。
  - 咖啡：15000 D，+60 体力，每天 3 杯（R:22、R:875-888）。
  - 潮汐饭团 `B12_SNACK={energy:20, daily:2, price:6500}`，按上限截断；货船 15% 概率刷出（R:1326、R:1562-1568、R:1334）。
- 动作耗体 `WORLD.cost`：播种 2、浇水 1、收获 1、清理 1、喂食 1、钓鱼 4、挖矿 3（R:21）；加工每个 1、炸矿 6（R:173）。其余动作 0。
- **运行时补丁**（R:173）：`WORLD.cost.craft=1`、`WORLD.cost.bomb=6`、`WORLD.daily.craft=80`、`WORLD.daily.bomb=10`、`WORLD.xp.craft=2`。所以 `WORLD.daily` 的最终值是 `{fish:80, mine:100, coffee:3, craft:80, bomb:10}`，`WORLD.cost` 也多了 craft/bomb 两项。离线读 R:22 的字面量会漏掉这两项。
- 工具等级不直接改变耗体；鱼竿影响空竿/鱼池/品质，镐子影响矿层/额外矿石/炸矿/梯子，洒水器影响自动浇水，房屋影响上限（R:732、R:739、R:748、R:754-756、R:786、R:470）。
- 管家 `keep` 是保留体力阈值，夹 0–300；钓鱼/挖矿/种植前检查 `s.en-a.keep`（R:1029、R:1121、R:1127、R:1140-1141）。
- `fish`/`mine` 附加耗体 `AUTO.surcharge=0`，注释里的「+1/+2」已失效（R:515、R:1021）。

---

## C. 农田

### C.1 作物表（R:42-52）

| id | 名称 | 季节 | 种子价 | 基础价 | 生长分钟 | 复茬分钟 | 次数 | 吃回 |
|---|---|---|---:|---:|---:|---:|---:|---:|
| turnip | 小白萝卜 | 春/冬 | 110 | 540 | 30 | - | - | 8 |
| carrot | 胡萝卜 | 春/秋 | 180 | 960 | 60 | - | - | 10 |
| wheat | 小麦 | 夏/秋 | 220 | 1400 | 120 | - | - | 6 |
| strawberry | 草莓 | 春 | 720 | 3300 | 240 | 180 | 4 | 14 |
| tomato | 番茄 | 夏 | 540 | 2550 | 180 | 150 | 4 | 12 |
| corn | 玉米 | 夏/秋 | 900 | 4800 | 360 | 240 | 3 | 14 |
| grape | 葡萄 | 秋 | 1080 | 5700 | 360 | 240 | 4 | 12 |
| pumpkin | 南瓜 | 秋/冬 | 1440 | 9000 | 600 | - | - | 20 |
| cabbage | 冬白菜 | 冬 | 450 | 2350 | 150 | - | - | 12 |

### C.2 生长公式（R:471-482）

- 季节：岛日时代用 `seasonOf(isleDay(p.t))`（种植时刻季节）；旧数据用 `seasonOf(worldDay(t))`；不匹配 `stage=-1` 枯萎（R:474）。
- `fast = p.t >= ISLE_LAUNCH`；`base = (p.h && regrow ? regrow*(fast?0.8:1) : grow)*60*(fast?0.8:1)`。即首茬在岛日时代 ×0.8，复茬再额外 ×0.8（总 0.64）（R:476-478）。
- `total = base*(auto?0.6:1) - p.g`；`auto` 为洒水器覆盖 `i<sprCover[s.tools.spr]` 或雨天（R:478、R:470、R:549、R:566）。
- `elapsed >= total` → 成熟 `stage=3`；否则 `stage=min(2, floor(elapsed/total*3))`，`left=total-elapsed`（R:479-481）。
- 浇水：未自动、stage 0–2、`p.w<=stage` 时 `p.g += floor(st.left*0.25)`，`p.w++`，耗 1 体（R:543-562）。三次浇水按当前剩余递减，**并非**总时长 ×0.75³。
- 洒水器/雨天 `total*0.6`（快 40%），且收获按 `w=3` 计算品质/多产（R:478、R:572）。
- 洒水器 `sprCover=[0,8,16,24]`，价格 `[150000,500000,1500000]`（R:19-20、R:470）。
- 复茬：`regrow && p.h+1 < (times||1)` → 重置 `{c,t,w:0,g:0,h:p.h+1}`，否则清空（R:584-587）。

### C.3 品质与数量（R:564-588）

- `w = auto?3:p.w`；金星率 `0.05+0.1w`，银星率 `0.2+0.08w`；一次 rand：`q=2 if r<gold`；`q=1 if r<gold+silver`；否则 0（R:572-575）。
  - w=0：金 5%、银 20%、普通 75%；w=3：金 35%、银 44%、普通 21%。
- 数量 `1+(rand<0.3+0.08w?1:0)`，被偷过（`p.sv` 非空）减 1，最后 `max(1,n)`；`ctx.auto` 固定 1。管家用 `auto:false`，正常吃品质和 +1 概率（R:576-577、R:1054）。
- 收获耗 1 体、+6 经验、`cnt.harvest++`（R:579-581）。

### C.4 阶梯价与税

- `QUALITY=[1,1.25,1.5]`；卖出单价 `unit=round(price*QUALITY[q])`，价格来自 `ctx.prices`（R:87、R:910）。
- 作物每自然日：前 150 个全价；151–400 个 85%；401 起 70%（R:88-94）；`cropTierValue` 跨档累加，`s.cnt['sc_'+id]` 记录当天已卖数量（R:90-95、R:912）。
- 非作物不阶梯：`unit*n`（R:911）。
- 自动代卖 `ctx.auto ? 1-AUTO.fee : 1`，当前 `fee=0`（R:911、R:1021）。
- 售卖税 `b12TaxSale`：
  - `B12_TAX.free=3,000,000`，`high=10,000,000`，低档 1%、高档 3%（R:1638-1648）。
  - 钱包 <300 万时 `carried=0`；否则当日已缴计入 basis；`tax = marginal(basis+gross) - marginal(basis)`，并夹在 `[0, min(gross, max(0, wallet+gross-3M))]`（R:1645-1648）。
  - 仅在时钟已配置且 `t>=clockStart` 收税；`tax.paid = carried+tax`；税日按 `worldDay`（R:1650-1653）。
- 余额税：1‰/3‰ 边际（R:1640-1644）。
- `s.cnt.sold` 累加的是**税后净收入** `value`，不是 gross（R:913-914）。

### C.5 扩地与成本

- 初始 6 块、最大 24；第 n 块（从第 7 块起）`10000*n`（R:14、R:919-934）。
- 畜栏初始 2、最大 8；第 n 格 `80000*n`（R:15、R:936-948）。
- 蟹笼最大 4，第 n 个 `30000*n`（R:16、R:687-699）。
- 房屋 5 级：`[100000,250000,600000,1200000,2500000]`（R:17、R:1006-1010）。
- 鱼竿/镐子表 `[0,80000,300000,1000000]`：1→2 级 8 万，2→3 级 30 万，3→4 级 100 万（R:19、R:1011-1013）。
- 洒水器 `[150000,500000,1500000]`（R:19）。

---

## D. 牧场

### D.1 动物表（R:53-59）

| id | 名称 | 价格 | 产出间隔分钟 | 窝容量 | 产物 | 产物基础价 |
|---|---|---:|---:|---:|---|---:|
| chicken | 小鸡 | 12000 | 240 | 3 | egg 鸡蛋 | 1350 |
| duck | 鸭子 | 24000 | 300 | 3 | duckegg 鸭蛋 | 2500 |
| cow | 奶牛 | 60000 | 480 | 2 | milk 牛奶 | 5850 |
| sheep | 绵羊 | 90000 | 1440 | 1 | wool 羊毛 | 19000 |
| pig | 小猪 | 150000 | 720 | 1 | truffle 松露 | 13500 |

### D.2 成长/退休

- 成长岛日 `{chicken:2, duck:3, cow:5, sheep:5, pig:6}`（R:1573）。
- 成年后存活岛日 `{chicken:24, duck:36, cow:48, sheep:60, pig:72}`（R:1574）。
- `b12AnimalStage`（R:1588-1596）：无 `born` 的旧动物视为锚点成年；`adultAt = b12AfterActive(born, growDays*ISLE_SPAN)`；`retireAt = b12AfterActive(adultAt, adultDays*ISLE_SPAN)`；阶段 `elapsed>=days?2 : elapsed>=ceil(days/2)?1 : 0`；到期 `retired:true`，待收产物仍可收（R:670）。
- 产出周期 `b12AnimalPeriod`（R:1597-1603）：`round(every*60*factors[kind][season]*climate)`。
  - 季节因子：chicken `[.98,1.02,1,1]`；duck `[.96,1,1.02,1.02]`；cow `[.98,1.04,.98,1]`；sheep `[1,1.02,.98,1]`；pig `[1,1.02,.96,1.02]`。
  - 气候：雨 duck×.97、其他×1.01；雪×1.02；其他×1。
- `animalReady`（R:1610-1624）：`fed = t-a.f < 86400 && !retired`；`until = min(t, a.f+86400, retireAt)`；从 `max(a.p, adult)` 按周期结算，直到窝满或超过 until；返回 `n/ready/stage/daysLeft/adultLeft/retireAt/retired/qualities/firstReady/period/nextP/left`。
- 品质 `b12AnimalQuality`（R:1605-1609）：`worldHash('b12-animal:'+kind+':'+born+':'+start)`；起始日晴 +0.02 金、雪 -0.02；`gold=clamp(m/250+bonus, 0, .45)`，`silver=clamp(m/120, 0, .8)`；`r<gold` 金，`r<gold+(1-gold)*silver` 银，否则普通。
- 心情 m 初始 60；喂 +8、摸 +6（上限 100），收 -2（下限 20）（R:610、R:644、R:659、R:682）。

### D.3 喂/摸/收/卖

- 买动物（R:599-612）：`barn.length<barnN`，扣价，初始 `{k,f:p:now,m:60,born:now}`；不耗体。
- 喂食（R:624-646）：未退休；距上次 <8 小时拒绝；消耗 1 普通饲料；耗 1 体；`b12FeedAnimal` 保留进度并平移饥饿区间；`pen.f=now`，m+8。
- 摸（R:647-661）：每只每天 1 次（`cnt['pet'+i]`），m+6，不耗体。
- 收产物（R:662-686）：`animalReady().ready`；`ctx.auto` 全普通；收后 `m=max(20,m-2)`，+6 经验。
- 卖动物（R:613-623）：购买价 40%，再扣售卖税。
- 饲料 150 D（R:79）；管家缺料自动买 `min(99, lack+5)`（R:1095-1104）。
- 规则包无「偷动物窝」动作；串门读取 `pen.steal` 标记（S:292），偷取结算在站点。

---

## E. 钓鱼 / 挖矿 / 炸矿 / 加工坊

### E.1 鱼表（R:61-69）

| id | 名称 | 基础价 | 权重 | 鱼竿 | 季节 | 岛日时段 |
|---|---|---:|---:|---:|---|---|
| sardine | 沙丁鱼 | 1200 | 40 | 1 | 春夏秋冬 | 0–24 |
| carp | 鲤鱼 | 2000 | 30 | 1 | 春/秋/冬 | 0–24 |
| bass | 鲈鱼 | 3600 | 22 | 1 | 夏/秋 | 6–20 |
| salmon | 三文鱼 | 7200 | 14 | 2 | 秋/冬 | 0–24 |
| squid | 鱿鱼 | 8800 | 12 | 2 | 冬/春 | 18–30（跨午夜） |
| tuna | 金枪鱼 | 14500 | 8 | 3 | 夏/冬 | 0–24 |
| puffer | 河豚 | 21000 | 6 | 3 | 夏/春 | 12–20 |
| whale | 迷你鲸 | 96000 | 1 | 4 | 全季 | 0–24 |

- `fishPool` 用 `isleHour(t)` 过滤，跨午夜用 `h+24` 匹配（R:497-500）；注释写「北京时间小时」，实际是**岛日小时**（R:60、R:498）。
- `fish{bait?}`（R:721-742）：
  - 每岛日 80 竿（R:22、R:722）。
  - `miss = max(0.05, 0.22-0.04*rod-(bait?0.08:0)-(rain?0.05:0))`；鱼竿 1/2/3/4 基础空竿 18%/14%/10%/6%（R:732）。
  - 耗 4 体、+9 经验；鱼饵消耗 1 个普通鱼饵（R:726-729）。
  - 高价鱼权重 `(bait?2:1)*(rain?1.5:1)`，仅 `price>=9000`（R:737-738）。
  - 品质：`ctx.auto` → 0；否则 `rand<0.08+0.05*rod` → 金星；否则**另一次** `rand<0.28` → 银星（R:739）。
- 蟹笼：购买 `30000*(现有+1)`，最多 4（R:16、R:687-699）；`trapReady` 每 180 分钟 1 个、窝上限 4、风天产出翻倍（R:483-487）；`trap` 鱼池强制 `maxRod=1`、全普通品质（R:701-719）。

### E.2 矿层（R:72-78）

| id | 名称 | 基础价 | 权重 | 最低层 |
|---|---|---:|---:|---:|
| coal | 煤 | 480 | 40 | 1 |
| copper | 铜矿 | 900 | 35 | 1 |
| iron | 铁矿 | 1900 | 25 | 6 |
| amethyst | 紫水晶 | 7200 | 6 | 8 |
| gold | 金矿 | 4200 | 14 | 12 |
| emerald | 祖母绿 | 12000 | 4 | 15 |
| ruby | 红宝石 | 18000 | 3 | 20 |
| diamond | 钻石 | 36000 | 1.2 | 25 |

- `PICK_FLOOR=[0,8,16,24,30]`：镐 1→8、2→16、3→24、4→30（R:78）。
- `s.mine.max` 初始 1，梯子逐层 +1，且不超过镐子上限（R:447、R:762-764）。
- `mine{f}`（R:743-767）：
  - 每岛日 100 下；耗 3 体、+6 经验。
  - `floor = max(1, min(f||1, s.mine.max, PICK_FLOOR[pick]))`。
  - `hits = 1+(rand<0.25+0.05*pick?1:0)`。
  - 权重 `w*(price>=12000&&snow?1.6:1)*(1+(floor-o.floor)/40)`。
  - 当前层 = max 且未到镐上限时，25% 发现下一层梯子（R:762-765）。

### E.3 炸矿（R:780-790）

- 每岛日 10 次；消耗 1 炸药、耗 6 体；`cnt.mine+=6` 但不计入 `iq.mine`；经验 +24（R:783-784）。
- 产出 `n = 6+(rand<0.3+0.05*pick?2:0)`；权重 `w*(price>=7000?1.35:1)*(price>=12000&&snow?1.6:1)*(1+(floor-o.floor)/40)`（R:786-787）。
- 梯子概率 60%（R:789）；炸药配方煤 3+铜 2，或杂货铺 2500（R:167、R:172）。

### E.4 加工坊（R:150-168）

| id | 名称 | 原料 | 卖价 |
|---|---|---|---:|
| salad | 田园沙拉 | 萝卜3+胡萝卜3 | 6500 |
| flour | 面粉 | 小麦5 | 9200 |
| jam | 草莓果酱 | 草莓4 | 17000 |
| ketchup | 番茄酱 | 番茄4 | 13500 |
| popcorn | 爆米花 | 玉米3 | 18500 |
| wine | 葡萄酒 | 葡萄4 | 31000 |
| pie | 南瓜派 | 南瓜2+鸡蛋2 | 26000 |
| kimchi | 泡菜 | 冬白菜4 | 12500 |
| mayo | 蛋黄酱 | 鸭蛋3 | 9800 |
| cheese | 奶酪 | 牛奶3 | 23500 |
| sweater | 羊绒毛衣 | 羊毛2 | 50000 |
| ironbar | 铁锭 | 铁矿4+煤2 | 10200 |
| ingot | 金锭 | 金矿4+煤2 | 23000 |
| jewel | 宝石项链 | 红宝石1+祖母绿1+金矿1 | 46000 |
| crown | 钻石王冠 | 钻石2+金锭1 | 108000 |
| bomb | 炸药 | 煤3+铜2 | 0（不可卖） |

- `craft` 1–20 个；每岛日 80 个；每个耗 1 体、+2 经验（R:173、R:768-778）。
- 材料按品质 0→1→2 扣，产出固定普通品质（R:775-778）。
- 加工品写入 `BASE_PRICE`/`ITEM_NAME`，可进入集市/货船/仓库（R:169-170）。

---

## F. 集市与货船

### F.1 市场因子

`marketFactor(item, day)`（R:119-130）：

1. `d = dayNum(day)`；
2. `walk = Σ_{k=0..3}(worldHash(item+':'+(d-k))-0.5)*W[k]`，`W=[1,0.6,0.35,0.15]`（R:122-124）；
3. 单商品暴涨暴跌：`worldHash('event:'+item+':'+d) < (isle?.015:.04)` 时，`worldHash('ev2:'+item+d)<.5` 取 `isle?.8:.7`，否则 `isle?1.3:1.45`；否则 1（R:126）；注意 `ev2` 输入**无分隔符**；
4. 作物季节：当季 .92、反季 1.3；非作物 1（R:127-128）；
5. 岛日 `clamp(exp(walk*.5-.02)*seasonal*event, .65, 1.7)`；非岛日 `clamp(exp(walk*.7-.03)*seasonal*event, .5, 2)`（R:129）。

供需（R:132-133）：

`supplyFactor = clamp(1.06-0.3*soldYesterday/max(1,normal), .8, 1.06)`；非岛日 `normal=400`，岛日 `normal = marketDepth(item) = clamp(round(1,600,000/max(1, base||1000)), 800, 6000)`（R:133-135）。

最终价 `priceOf = max(1, round(base*marketFactor*supplyFactor*eventFactor))`（R:136-141）。`eventFactor` 为当天匹配该商品的所有商会事件 `m` 的乘积，非岛日恒 1（R:250-251、R:268）。

### F.2 商会事件（R:229-248）

每岛日抽 2 条、不同商会；`marketEvents` 用 `worldHash('mkt:'+day+':'+k)` 加权抽取（R:250-267）。

| 事件 | 商会 | 商品 | m | 权重 |
|---|---|---|---|---|
| feast | 东海龙宫 | 全部鱼 | 1.35 | w==1?3:1 |
| seal | 东海龙宫 | 全部鱼 | .82 | .7 |
| storm | 东海龙宫 | 全部鱼 | 1.5 | w==2?3:0 |
| jade | 昆仑玉坊 | 宝石+项链+王冠 | 1.4 | w==3?3:1 |
| jadeglut | 昆仑玉坊 | 宝石 | .8 | .7 |
| forge | 不周山工坊 | 金属+铁锭+金锭 | 1.35 | s==3?2:1 |
| quake | 不周山工坊 | 金属+宝石 | 1.55 | .35 |
| harvest | 扶桑神农社 | 当季作物 | .8 | s==2?2.5:1 |
| locust | 扶桑神农社 | 全部作物 | 1.4 | s==1?2:.6 |
| frost | 扶桑神农社 | 白菜/萝卜/胡萝卜/泡菜/沙拉 | 1.45 | s==3?(w==3?3:2):0 |
| rain | 扶桑神农社 | 全部作物 | .85 | w==1?2:0 |
| brew | 瀛洲酒肆 | 葡萄/小麦/葡萄酒/面粉 | 1.45 | s==2?2.5:1 |
| lantern | 青丘狐市 | 南瓜/鸡蛋/鸭蛋/派/果酱/爆米花 | 1.35 | s>=2?2:.7 |
| fox | 青丘狐市 | 羊毛/毛衣/项链 | 1.5 | s==3?1.5:.4 |
| peach | 蓬莱仙市 | 草莓/番茄/玉米/果酱/番茄酱/沙拉 | 1.35 | s<=1?2:.6 |
| immortal | 蓬莱仙市 | 松露/奶酪/葡萄酒 | 1.6 | .35 |
| hoard | 归墟商号 | 全部畜产+奶酪+蛋黄酱 | .78 | 1 |
| caravan | 归墟商号 | 松露/羊毛/奶酪/王冠/葡萄酒/毛衣 | 1.4 | .8 |

- `items==='season'` 展开为当季作物，`'crops'` 展开为全部 9 种（R:261）；缓存最多 40 天（R:264-265）。

### F.3 货船（R:1324-1339、R:1551-1560）

- 每岛日固定 5 组，按 `worldHash('b12-cargo:'+day+':'+salt+':'+id)` 排序抽取（R:1328）。
- 作物 9 选 4，限 24；畜产 5 选 2，限 8；加工品 15 选 2，限 4；材料（8 鱼+8 矿）16 选 2，限 6；补给 15% 概率刷潮汐饭团（限 1）+ feed/bait/bomb 选 1（限 12），否则 feed/bait/bomb 选 2（限 12）（R:1329-1335）。
- 价格：潮汐饭团 6500；其余 `SHOP[id].price`（饲料 150、鱼饵 400、炸药 2500）或 `BASE_PRICE`（R:1336、R:79、R:172）。
- 个人额度 `limit - 当天本人已买`，独立不抢（R:1338-1339）。
- `stockBuy{id,n,day}`：`act.day` 必须等于当前 `isleDay`；n 安全正整数且不超额度；扣 `price*n`，普通品质入包（R:1551-1560）。
- 货架每岛日刷新；长夜冻结不换货（R:1183-1186）。

---

## G. 每日目标、52弟、游乐馆、擂台、站宠经验

### G.1 每日目标（R:269-298）

- `GOAL_POOL` 17 条；每天 2 简单 + 1 中等 + 1 困难，按 id 去重（R:279-286）。
- 简单（t=1，5000 D）：播种 10；收获 8；手动浇水 8（洒水器覆盖 < 地块数）；收产物 3（有动物）；钓鱼 6；挖矿 15（R:270-272）。
- 中等（t=2，15000 D）：收获 25；钓鱼 20；挖矿 40；卖货 80000；加工 5；收产物 10（≥2 动物）（R:273-274）。
- 困难（t=3，40000 D）：收获 60（≥10 地）；卖货 300000；挖矿 80；加工 15；钓鱼 45（R:275-276）。
- 奖励（R:292-298）：单目标 `GOAL_COINS=[0,5000,15000,40000]`；简单物品 饲料10/鱼饵6/当季种子6/铜矿6 选一；中等 当季后两种种子12/鱼饵15/炸药2/铁矿8 选一；困难 炸药3/红宝石1/当季后两种种子20 选一，额外 `pet:2`；全部完成（k=4）给 30000 D+祖母绿1+炸药2+`pet:3`（R:278、R:295）。
- `goal{k}`：k 0–4，每项只能领一次；k<4 需计数达标，k=4 需 goal0–3 均已领；物品普通品质（R:973-988）。卖货计数使用税后净收入 `cnt.sold`。
- 管家只自动领 `t<3` 的简单/中等目标，**不领困难目标**（R:1156）。

### G.2 52弟（R:300-424）

- 每日 52 局；中奖池 0.001 概率 1,000,000 D（R:301、R:307-309）。
- 非平局才消耗次数；胜利额外 `cnt.npcWin++`（R:796）。
- **奖励只在胜利时发放**（R:795 `pay()` 的 `if(res==='win')`）：输和平都不扣任何东西，平局连次数都不消耗。所以每次「计次」的期望 = 胜率 × 单胜奖励，是纯白拿，不是零和：
  - 抽牌胜率 468/1000（13×13 中 78 胜、14 平），每次计次约 **2,733 D**；
  - 石头剪刀布胜率 1/3，每次计次约 **2,705 D**；
  - 盲盒对称，量级相同，但要 3 个请求才能走完一局。
  - 五子棋前 10 局有 ×1.5 倍率且托管近全胜，所以先打满 10 局，剩余约 42 次额度用来抽牌，一天约 **11 万 D**、零体力零成本（2026-11-13 用本文件规则 400×200 局实测）。
- 38% 物品奖：炸药、鱼饵、饲料、当季种子、紫水晶、祖母绿、红宝石、铁矿、金矿；62% 金币 `round((1000+floor(rand²*7000))*mult/100)*100`（R:310-314）。
- 石头剪刀布：`(m+1)%3` 判胜负（R:797-800）。
- 抽牌：1–13 比大小，平局重来（R:801-804）。
- 盲盒：`BOX_SET=[50,30,20,10,5,0,-10,-20,-30]`；玩家选 1 盒，双方从剩余池无放回抽，系统再移除 1 个未选盒；3 轮后比 `me/np` 总和（R:303、R:815-829）。
- 五子棋：15 路；难度倍率 0.8/1.2/1.5；每日计奖上限 10 局，超出练习（R:304-306、R:806-813）。
  - 评分：成 4 双活 50000/单活 10000；成 3 双活 3500/单活 250；成 2 双活 180/单活 30；双活三以上 +12000；五格窗口 4 子 2500、3 子 100、2 子 8（R:324-334）。
  - 简单：活四/冲四 90% 会堵，其余前 4 名按 [0.4,0.27,0.19,0.14] 随机（R:380-388）。
  - 普通：取估值最高（R:389）。
  - 困难：先下自己的活四；VCF 深度 6/预算 500；对手 VCF 深度 6/预算 350 时在前 8 候选找破解；最后前 6 按 `a*1.15+o-reply*0.9` 选（R:390-408）。
  - 默认倍率 1.5（R:813）。
- 刮刮乐：票价 1000/10000；一次 1 或 10 张；表 `[[1000,.00005],[50,.002],[10,.01],[5,.03],[2,.08],[1,.18]]`；逐档累积判定，实际返奖率约 71%；1000 倍标记 jackpot（R:427-443）。
- 彩票：500/张，最多 30 张；红球 1–30 选 5，蓝球 1–10 选 1；开奖号 `isleDayNo`（每岛日一期）；奖级 5+1=1,000,000；5=100,000；4+1=20,000；4=3000；3+1=1000；3=300；2+1=200（R:430-439）。`lottoClaim` 需服务端 `ctx.draws`，未提供返回 pending，未到期票保留（R:854-859）。

### G.3 游乐馆（R:1341-1503；A 同源）

- 每游戏每日 10 局：弹弹乐 5 甩、桌球 6 杆、保龄 10 投（5 轮×2）（R:1346-1350）。
- `DT=1/120`，单局最多 1080 步 = 9 秒（R:1351-1352）。
- 弹弹乐：固定 1280×720；`VW=clamp(min(W,H)*.34,170,300)`，`hx=.1875VW, hy=.2227VW, r=.19VW`；初速量化 .001，<450 无效，>2400 截断；阻力 2.2、碰壁 .6、停止 25（R:1362-1363、R:1359、R:1390-1392）。
  - 倍率 `1+0.5*反弹+bonus`；神秘箱 30–150、宝箱 4×15、泡泡 +1 bonus、冰块 100、礼物 120、墙角 60、弹簧 5（R:1360、R:1432-1445）。
  - 隐藏机关分值 `[40,50,30,60,80,40,100,30]`；每条边按长度分段（R:1360、R:1375-1377、R:1437）。
  - 箱子数 `clamp(round(W*H/110000), 4, 10)`，破后低于基数补一个（R:1377、R:1462）。
- 桌球：540×960，6 洞（角 32、中 30）；鱼 r22/m1.5，10 球 r17/m1；随机一金球；速度 `120+p*1580`；普通球 `100*combo`，金球 `300*combo`，鱼进洞 -50；清台 `500+150*(6-杆数)`（R:1356、R:1368-1370、R:1394、R:1415-1418、R:1454）。
- 保龄：540×960，10 瓶；速度 `420+p*900`，vy 最小 -120；旋转在瓶区前生效；全中 30+10×连续全中，补中 20，否则两投相加（R:1357、R:1394-1396、R:1423-1425、R:1457-1460）。
- `arcStart{g}`：每日每游戏 10 次；随机种子；返回 `{seed,left}`（R:1478-1481）。
- `arcEnd{g,shots}`：最短 5/6/8 秒；服务端整局重放；写 `arc.best/db` 与 `b9Rank`（R:1472-1491）。
  `MIN_PLAY={bounce:5,pool:6,bowl:8}`（R:1472、A:130）是模块内部常量、**不在 export 里**；它比的是服务端两次处理的时刻差（`ctx.t-c.t`），不是客户端自报耗时 —— 这是弹弹乐「太快了」十连 0 分的根源。
- 串门/非本人不能玩（R:1495-1498）。

### G.4 擂台与站宠经验（R 之外）

- R 没有擂台属性/装备/训练/突破/约战/宝箱实现，只给目标奖励挂站宠经验，并注释「困难目标和全部完成还送擂台装备（服务端发）」（R:291-297）。
- `core/arena.mjs`：接口 `/api/pet/battle`，含 `home/gear/equip/points/chest/train/buy/enhance/battle/opponents`（AR:25-33、AR:67、AR:83、AR:107、AR:161、AR:179、AR:194、AR:229、AR:300）。
  - 每日 30 场、间隔 8.5 秒（服务端限制 8 秒）（AR:238、AR:277、AR:283、AR:377）。
  - 每日宝箱默认 5（AR:103）；3 个装备槽 armor/weapon/charm；可买史诗 rarity=3；强化到 +10（AR:167-187）。
  - 训练档位 300/200/100/50/10 经验，按服务端 `gear.prices.trainTiers` 计价；每日预算默认 150000 D（AR:149-164、AR:141）。
  - `core/battle-rules.json`：每级 hp+5、atk+0.7、agi+0.5、spd+0.5；每点 vit+4 hp、str+0.4 atk、agi/spd+0.4；20 个宠物技能、18 个武器技能（BR:2-15、BR:23-45）。
- 站宠经验：R 产出 `WORLD.xp={harvest:6, collect:6, fish:9, mine:6}`、`craft:2`（R:23、R:173），目标奖励 `pet:2/3`（R:295-297）；等级曲线不在 R。

---

## H. 串门、偷菜、帮忙与守家

> R 只提供发现率/偷菜耗体公式和道具表；请求协议、保护期、罚款、次数上限在 S/SS 与站点服务端。

- 帮忙（S:3、S:95-108、S:112-206）：每天 10 家、每家 1 次；每次 1 体力；200 D+2 经验；D 币日上限 4000（S:3、S:129）。接口 `POST /api/pet/world/help/{id}`，body `{operation:uuid}`；返回 `{coins,xp,energy,aff,done}`；返回的 state 是对方岛，必须标脏（S:97-107）。亲密度由服务端 `res.aff` 返回（S:183-186）。
- 偷菜（S:4、S:683-688、S:1204-1237）：
  - 接口 `POST /api/pet/world/visit/{id}`，body `{operation:uuid, kind:'all', i:0}`。
  - 基础 5 体，每多一处 +1，单次上限 15（S:4、S:269、S:318、S:343）。
  - 返回 `outcome/items|item,n/spots/fine/xp/battle`（S:1205-1237）。
  - 胜利按实际 items 估值，spots 计入战果；若带 xp 加擂台经验；打赢可多得 1 个（S:1174、S:1209-1227）。
  - 失败按市价 1.2 倍赔，单次上限 5000，每日 20000；主人罚款到上限则本次不再赔（S:5、S:1233-1234）。
  - 平局只记 spots，无收益无罚款（S:1235-1236）。
- 保护/可偷时点：
  - 解禁 = 成熟 + `protect`，默认 1800 秒（SS:9、SS:160）。
  - 动物窝按第二产物时刻 + 保护期推算（SS:93-123）。
  - 每块地每茬最多被偷 2 个，`stolen>=2` 锁死（S:442、S:476、S:583）。
  - 新手保护 24 小时（S:383）；邻居 `stealable=1` 只返回列表生成时可偷的岛（S:61-66、S:374-379）。
- 发现率 `b12Detection`（R:196-199）：`clamp(.55+守家detect+偷方detect+min(.06,max(0,friend)), .35, .75)`；守家潮铃 +.10、萤火灯 +.06；偷方斗篷 -.10、口哨 -.06；旧斗篷 -.15；朋友最多 +.06（R:176-184、R:191-198）。
- 偷菜耗体 `b12StealCost`：`max(1, min(max, base+(spots-1)*per)-whistle减耗)`（R:200-202）；服务端基础 5/+1/15。
- 道具（R:174-185）：潮铃 800/24h/警戒/+10%；贝壳护具 1600/24h/护具/生命+8%；珊瑚挡板 1800/24h/护具/防御+4；萤火灯 650/24h/警戒/+6%；斗篷 1200/24h/潜行/-10%；口哨 1400/24h/潜行/-6%、偷菜少耗 1 体；菜篮 2500/24h/携带/每处多 1 个。同槽不能混用，同一效果最多预付 7 天（R:216-222）。
- 守家战由站点结算；R 的 `guardBoost()=>0`，旧复合加成已废弃（R:188）。`prepareStealBattle` 打输后按 `blockSec` 默认 600 秒冷却（S:756-768、S:1179-1185）。
- 接口：`GET /api/pet/world/neighbors?limit=20&q=&cursor=&stealable=1`（S:61-66）；`GET .../visit/{id}`（S:70）；`POST .../help/{id}`（S:99-100）；`POST .../visit/{id}`（S:683-684）。

---

## I. 囤货仓库 b26 与 b12.vault/keep

### I.1 等级（R:1504-1521）

| 等级 | 升级价 | 格数 | 每格上限 | 提醒条数 | 自动出售条数 |
|---:|---:|---:|---:|---:|---:|
| 1 | - | 12 | 300 | 0 | 0 |
| 2 | 80000 | 18 | 600 | 8 | 0 |
| 3 | 300000 | 22 | 1200 | 16 | 8 |
| 4 | 1000000 | 30 | 2400 | 24 | 16 |

- `B26.cost=[0,80000,300000,1000000]`、`slots=[12,18,22,30]`、`unit=[300,600,1200,2400]`、`alerts=[0,8,16,24]`、`orders=[0,0,8,16]`；`perks` 是四档的中文说明（基础货架 / 加石基与二层 / 冷库 / 吊车与金招牌）；升级价取 `cost[当前lv]`（R:1506-1507、R:1526）。
- `b26State` 默认 `{v:1,lv:1,order:{},alert:{},sold:[]}`；lv 夹 1–4；order 键 `id:q` 值 `[price,n]`；alert 值 price>0；sold 保留最近 20 条 5 元组（R:1508-1514）。
- `b26Check`：新物品且已用格数 ≥ slots 拒绝；同一物品三品质总和 +n > unit 拒绝（R:1516-1520）。`b26Room` 新物品无空格返回 0，否则 `unit-现有总量`（R:1521）。
- `whUp`：lv<4，扣 `cost[lv]`（R:1526）。
- `whAlert`：lv≥2；price=0 取消；条数上限 `alerts[lv-1]`（R:1529-1530）。
- `whOrder`：lv≥3；q 0/1/2；n 1..unit[3]；条数上限 `orders[lv-1]`；下单时清 `b12.keep[id][q]`（R:1531-1536）。
- 只有本人可管理（R:1524）。

### I.2 vault/keep 语义（R:1206-1299）

- `vault` 是 `inv` 的预留子集，不是额外库存；`keep` 是自动补足目标（R:1206-1207）。
- `b12State` 清洗：只保留已知 id、最多 256 个；vault 不超过 inv 各品质；keep 只需安全整数；全 0 删除（R:1212-1227）。
- `b12Available = inv - vault`；在仓库屏蔽上下文内直接返回 inv（R:1229-1232）。
- `warehouse{id,q,n,keep}`：id 已知、q 0–2、n 0..当前 inv 数量；n=0 同时删除 b26 订单 `id:q`；写 vault；`keep:boolean` 设置/清除 keep；返回 `{ok,a:'warehouse',id,q,n,msg}`（R:1234-1245、R:1306）。
- `includeWarehouse:true` 才可动用预留（R:1247-1268）：craft 按配方×数量；sell 指定品质 n；eat 1；feed/bomb/bait/plant seed 各 1 普通。
- `b12WithAvailableInventory`：临时把 inv 换成 `inv-vault`，执行，合并 hidden，重新清洗 b12（R:1270-1288）。`applyActions` 对每个动作套这层；失败库存类消息会追加提示（R:1301-1316）。
- `b12ReplenishWarehouse`：每轮按 keep 从可用库存移入 vault，受 `b26Room` 限制；屏蔽上下文中移动 hidden（R:1290-1299、R:1148）。
- `b26AutoSell`（R:1538-1544）：只在屏蔽上下文且 lv≥3；对 order，当天价 ≥ target 时从 hidden+vault 取 `min(n,...)` 放回 inv 并生成 sell；部分成交减单；记录 `[day,id,q,amt,price]`，保留 20 条；sell 随后由管家执行并扣税；`AUTO.fee=0`。
- `alert` 只存储，R 没有推送函数；托管需自行比较 `world.prices`（R:1506、R:1529-1530）。
- 自动出售只在管家巡视时触发，不是独立定时任务（R:1538-1539、R:1149）。
- `whOrder` 清 keep，`whAlert` 不影响 keep（R:1535）。

> **澄清**：`b26AutoSell` 不是死代码。`autoSettle` 走的是 `b12WithAvailableInventory(s, null, ()=>b12BaseAutoSettle(...))`（R:1145-1150），mask 在 `run()` 期间有效，所以自动出售能正常触发。它只对**不启用管家**的托管无效。

---

## J. 夜幕、夜潮、纪事、税与补贴、退款

### J.1 山谷纪事（R:1675-1679、R:1692-1696）

- 三章：1 重开海路、2 暖棚与仓灯、3 静潮公约（R:1676-1678）。
- `storyRead{chapter}`：1–3，`chapters |= 1<<(chapter-1)`（R:1693-1696）。

### J.2 夜潮（R:1680-1701）

- 4 个奇缘：种植札记萝卜1；修灯人鱼饵2；暖棚门前饲料2；潮汐便笺萝卜1（R:1680-1685）。
- `b12NightView`：`key = b12NightKey(t)`；开始时刻 `Date.parse(key+'T22:00:00+08:00')/1000`；要求时钟已配置、开始 ≥ 锚点、`storySeed` 安全整数；`roll = worldHash('b12-night:'+seed+':'+key)`；`roll<.2` 才有事件，索引 `min(3, floor(roll/.05))`；每 key 只能领一次（R:1686-1691）。
- `nightClaim{key}`：key 必须匹配当前夜潮，未领且有礼物；普通品质入包，写 `b12.night={key,at,event}`（R:1697-1702）。
- `storySeed` 不在 R 生成；服务端不写则永远没有礼物（R:1687-1690）。

### J.3 税与补贴（R:1638-1673）

- `B12_TAX={free:3,000,000, high:10,000,000, subsidyCap:1,000,000}`（R:1638）。
- 边际税：`excess=max(0, capital-3M)`；`low=min(excess,7M)`；`high=excess-low`；`(low*lowRate+high*highRate)/denominator`（R:1640-1643）；余额 1‰/3‰（R:1644），卖货 1%/3%（R:1645-1648）。
- `b12AllocateSubsidies`：按 gap 比例，单项上限 `min(gap, 1,000,000)`；先满足会触顶项，再按比例分剩余；整数余数留公库（R:1661-1673）。
- `b12RecordActivity`：任一 `plant/water/harvest/collect/feed/fish/mine/craft/sell/sellAnimal/bomb/trap` 成功，记录本季 12 岛日活跃位（R:1656-1659）。

### J.4 旧守家退款（R:203-213）

- 旧档位 `[.15/800/24h, .3/2000/24h, .5/5000/48h]`（R:205）。
- 退款 `floor(price*min(8*86400, max(0, until-clockStart))/(h*3600))`（R:204-207）。
- `guardRefund` 写 `b12.guardRefund={at,amount}`，删除 `s.guard`，每个账号一次（R:210-213）。

---

## K. 全部动作名、字段与成功返回

`applyActions` 顶层返回 `{out, spend, earn, xp, tax}`；每个 out 至少 `{ok,a}`，失败 `{ok:false,a,msg}`；单批最多 40（R:13、R:512、R:1305）。

### K.1 农田/牧场

| 动作 | 字段 | 成功返回 | 行号 |
|---|---|---|---|
| plant | `c,i` | `{ok,a,spend,seed?}` | R:522-542 |
| water | `i` | `{ok,a}` | R:543-563 |
| harvest | `i` | `{ok,a,got:[{id,q,n}]}` | R:564-589 |
| clear | `i` | `{ok,a}` | R:590-598 |
| buyAnimal | `k` | `{ok,a,spend}` | R:599-612 |
| sellAnimal | `i` | `{ok,a,earn,gross,tax}` | R:613-623 |
| feed | `i` | `{ok,a}` | R:624-646 |
| pet | `i` | `{ok,a}` | R:647-661 |
| collect | `i` | `{ok,a,got}` | R:662-686 |
| buyTrap | 无 | `{ok,a,spend}` | R:687-700 |
| trap | `i` | `{ok,a,got}` | R:701-720 |

### K.2 钓鱼/矿/加工/杂货

| 动作 | 字段 | 成功返回 | 行号 |
|---|---|---|---|
| fish | `bait?` | `{ok,a,got,msg?}` | R:721-742 |
| mine | `f?` | `{ok,a,got,msg?}` | R:743-767 |
| bomb | `f?` | `{ok,a,got,msg?}` | R:780-791 |
| craft | `id,n` 1–20 | `{ok,a,got:[{id,q:0,n}]}` | R:768-779 |
| buy | `id`=feed/bait/bomb 或 guard1–4/cloak/whistle/sack；`n` 1–99（仅 feed/bait/bomb 用 n） | `{ok,a,spend}` | R:889-902、R:215-223 |
| eat | `id,q` 0–2 | `{ok,a}` | R:861-874 |
| coffee | 无 | `{ok,a,spend}` | R:875-888 |
| sell | `id,q,n` 1–999 | `{ok,a,earn,gross,tax}` | R:903-918 |
| expand | `k`=plot/barn | `{ok,a,spend}` | R:919-952 |
| upgrade | `k`=rod/pick/spr/house | `{ok,a,spend}` | R:953-972 |
| goal | `k` 0–4 | `{ok,a,earn,got,pet?}` | R:973-988 |

### K.3 52弟/彩票/刮刮乐

| 动作 | 字段 | 成功返回 | 行号 |
|---|---|---|---|
| npc | `g`=rps/card/gomoku/box；`k`=start/play/end/pick；`m,d,mv,i` | `{ok,a,g,res,seed,practice,box,npc,me,np,suit,earn,got,jackpot,mine,theirs,j,sa,sb}` 视游戏而定 | R:792-830 |
| scratch | `k` 0/1, `n` 1/10 | `{ok,a,k,n,spend,earn?,tickets,mult?,jackpot?}` | R:831-844 |
| lotto | `n` 5 红, `b` 蓝 | `{ok,a,spend,d}` | R:845-853 |
| lottoClaim | 无 | `{ok,a,pending?}` 或 `{ok,a,tickets,earn?}` | R:854-860 |

### K.4 仓库/货船/夜潮/纪事/退款

| 动作 | 字段 | 成功返回 | 行号 |
|---|---|---|---|
| warehouse | `id,q,n,keep?` | `{ok,a:'warehouse',id,q,n,msg}` | R:1234-1245、R:1306 |
| whUp | 无 | `{a,ok,spend,lv,msg}` | R:1526 |
| whOrder | `id,q,price,n` | `{a,ok,msg}` | R:1531-1536 |
| whAlert | `id,price` | `{a,ok,msg}` | R:1529-1530 |
| stockBuy | `id,n,day` | `{a,ok,id,n,spend,msg}` | R:1551-1560 |
| eat（tide_snack） | `id='tide_snack'` | `{a,ok,energy,msg}` | R:1562-1568 |
| storyRead | `chapter` 1–3 | `{a,ok,msg}` | R:1693-1696 |
| nightClaim | `key` | `{a,ok,got,msg}` | R:1697-1702 |
| guardRefund | 无 | `{a,ok,earn,refund,msg}` | R:210-213 |

### K.5 游乐馆

| 动作 | 字段 | 成功返回 | 行号 |
|---|---|---|---|
| arcStart | `g` | `{a,ok,g,seed,left,msg}` | R:1478-1481 |
| arcEnd | `g,shots` | `{a,ok,g,score,best,dayBest,newBest,newDay,left,msg}` | R:1483-1492 |

`shots`：弹弹乐 `[x,y,vx,vy]`（|vx|,|vy|≤2400）；桌球/保龄 `[angle,power,spin?]`（|angle|≤7、0≤power≤1、|spin|≤1）（R:1385、R:1390-1398）。

### K.6 拒绝条件

- 体力不足：有 cost 的动作统一拒绝（R:515-519）。
- 非本人：游乐馆、仓库管理、货船/夜潮等通过 `ctx.ownerId!=null||ctx.visit` 拒绝（R:1497、R:1524）。
- 其余季节/地块/动物/库存/额度在动作内逐条校验。

---

## L. state 结构

`newWorld(t)`（R:445-448）：

```
{
 v:2, en:100, enT:t, enDay:worldDay(t),
 plotN:6, plots:[null×6], barnN:2, barn:[], traps:[],
 inv:{turnip:[4,0,0], feed:[6,0,0]},
 tools:{rod:1, pick:1, spr:0, house:0}, mine:{max:1},
 earn:{day:worldDay(t), amt:0}, cnt:{}, log:0
}
```

运行期顶层：`iq:{d,fish,mine,craft,bomb,...}`（R:510-511）；`goals:{day,list}`（R:288）；`seen:[id]`（R:992-999）；`npcG`（R:806、R:815）；`lotto/lottoLog/scratchLast`（R:842、R:848、R:858）；`auto/autoLog`（R:1022、R:1164-1165）；`b12`；`b26`；`arc`；`b9Rank`；旧残留 `thief/guard`（R:191-192、R:205-207）。

`b12`：`v:1`、`guardVersion:1`（R:1214、R:1225）；`vault:{id:[q0,q1,q2]}`；`keep:{id:[q0,q1,q2]}`；`shop:{d,n}`（R:1558-1559）；`effects:{slot:{id,until}}`（R:189-194、R:222）；`guardRefund`（R:212）；`tax:{day,paid}`（R:1652）；`activity:{season,mask}`（R:1659）；`chapters`（R:1695）；`night:{key,at,event}`（R:1701）；`storySeed`（R:1687）。

`b26`：`{v:1, lv:1..4, order:{"id:q":[price,n]}, alert:{id:price}, sold:[[day,id,q,amt,price]...]}`（R:1508-1514）。

`arc`：`{v,d,n,db,best,cur,plays}`（R:1476-1477）；`b9Rank:{since,total,daily,day}`（R:1489-1490）。

`b15`：三份规则与全仓库没有 `state.b15` 字面字段。它是前端「摸鱼小窗 / 囤货仓库」UI 代号，数据实际落 `b12.vault/keep` 与 `b26`；`live/pet-isle-ui.js:316-399` 使用 `b12.vault/keep`，不写 b15。

---

## M. 修仙 rules.js（X）

### M.1 基础常量

- `XS_VERSION=1`；`EN_MAX=100`；`EN_REGEN=360` 秒；`CAN_MAX=20`；`PLOTS=24`；`START_OPEN=8`（X:3-5）。`xsDay = floor((t+28800)/86400)`（X:23）。
- 初始 `newXs`：灵力 100、灵石 100、水壶 20、药园 1、经验 0；24 块地中下标 14/15 预种灵草（g=3/g=1），前 8 松土其余杂草；种子灵草 6；`cv={r:0,s:1,xp:0}`（X:58-62）。
- 药草表（X:7-14）：

| id | 名称 | 行 | 种子 | 卖价 | 每阶段秒 | 药园等级 |
|---|---|---:|---:|---:|---:|---:|
| lingcao | 灵草 | 0 | 5 | 12 | 600 | 1 |
| jingu | 金菇 | 1 | 12 | 30 | 1200 | 1 |
| linglan | 铃兰 | 2 | 20 | 55 | 1800 | 2 |
| binglian | 冰莲 | 3 | 40 | 120 | 3600 | 3 |
| chizhi | 赤芝 | 4 | 60 | 190 | 5400 | 4 |
| leizhu | 雷竹 | 5 | 90 | 300 | 7200 | 5 |

- 耗灵 `COST`：锄地 3（土灵根 1）、播种 1、浇水 1、收获 2、炼丹 5、斗法 10，其余 0（X:15、X:79）。
- 丹药：回灵丹灵草3+金菇1，卖 60，+30 灵力，每日 3；培元丹灵草2+铃兰1，卖 90，药园经验 +40；炼制 15–1800 秒，品质 q0–2 出丹 `1+q`（X:17-21）。
- 灵根：五行；根数权重 `[[1,8],[2,20],[3,32],[4,25],[5,15]]`；基础 `{1:2, 2:1.5, 3:1.15, 4:.85, 5:.6}`；成长 `{1:.85, 2:.93, 3:1, 4:1.08, 5:1.17}`；`rootMult = BASE[n]*(GROW[n]*(1+0.12*变异根数))^r`（X:24-32）。
- 融合：金+水=冰、火+金=雷、水+木=风、土+火=熔、土+木=毒；根数 -1，每个变异根成长 +12%（X:28-32）。
- `cvNeed = round(60*(r+1)^2*(1+s*.25))`；`REALMS` 9 境（X:30-33）。打坐 60–1800 秒；`g = floor(秒/60*10*rootMult*(冰?1.2:1)*medBonus)`（X:34、X:93-96）。
- 心境默认 50，气运 0（X:178）；`medBonus = .8+mind/250`，每个师父 ×1.1、每个道侣 ×1.15（X:180）。突破率 `max(.3, min(.9, .6+(mind-50)/250+luck/500))`（X:179）；需 s=9 且 xp≥cvNeed(r,9)，消耗培元丹 r+1；成功 r+1/s=1/xp=0/mind+5；失败 xp×.7/mind-8（X:97-98）。
- 功法 10 部，每部 2 技能，售价 50；单灵根修本属性效率 ×1.5（X:35-53）。层数 `1+floor(sqrt(熟练/2))`，最高 9；下一层需 `2L²`；每层 power +6%；炸弹槽基础 2 个，3/9 层各 +1；生命基础 3，6 层 +1（X:48-50）。
- `powerOf = (1+.3r+.03(s-1))*techEff*techPerks.power`；`myHp = 100+60r+5(s-1)`（X:53、X:240）。
- 关卡 `duel/secret/demon/sword`：min 40/70/100/100 秒，灵石 15/40/90/150，境界 0/0/1/2，技能数 2/3/4/4（X:55-57）。每日斗法 8 次、每次 10 灵；记录 1800 秒过期（X:56、X:113-115）。

### M.2 1.0 动作（X:82-129）

| 动作 | 字段 | 规则 | 成功返回 |
|---|---|---|---|
| hoe | `i` | 锄地/除草；有未成熟作物拒绝 | `{ok,msg}` |
| plant | `i,herb` | 松土、空地、种子、药园等级 | `{ok,msg}` |
| water | `i` | 有水、未成熟、未浇过 | `{ok,msg}` |
| harvest | `i` | 成熟；`n=1+(log%4===3?1:0)`；经验 `lv*4` | `{ok,msg,herb,n}` |
| root | `el` | 测灵根；el 五行 | `{ok,msg,roots}` |
| sit/rise | 无 | 打坐 60–1800 秒 | `{ok,msg,gainCv,lvUp2?}` |
| break | 无 | 突破 | `{ok,msg,realm?,failBreak?}` |
| fuse | `el='a+b'` | 筑基后、2 培元丹+200 石、55%、失败 24h | `{ok,msg,fused?,failFuse?}` |
| story | `n` | 顺序 1–4；第 2 需灵根、第 3 需收获过 | `{ok,msg}` |
| brew | `herb` | 检查丹方，起火 | `{ok,msg}` |
| finish | `n` 0–2 | ≥15 秒；>1800 秒 q=0；火灵根良品+1 | `{ok,msg,pill,n,q}` |
| use | `herb` | 回灵丹日 3；培元丹 +40/+60 经验 | `{ok,msg}` |
| learn/equip | `el` | 50 石；灵根匹配；主修每天换一次 | `{ok,msg}` |
| fight | `herb,el?` | 关卡、境界、日 8 次、距上场≥1800 秒 | `{ok,msg}` |
| win | `n` 技能数 | 最短秒；`stone = S.stone+min(S.spells,n)*5`；重复对手无奖 | `{ok,msg,stone,cap,first?,gainCv,layer?}` |
| lose | 无 | 结束战斗 | `{ok,msg}` |
| refill/buy/sell | `herb,n` | 水壶；种子 1–10；药材 1–99，金灵根 ×1.15 | `{ok,msg}` |

### M.3 2.0 人脉/机缘/宗门（X:133-226）

- NPC 21+8；关系 `师父/道侣/结拜/仇人`；师父打坐 +10%、道侣 +15%、结拜斗法灵石 +10%、仇人秘境伏击（X:136）。
- 好感阈值 `[0,100,300,600,900]` → 陌生/熟识/好友/挚友/知己（X:137-138）。
- 宗门声望 0/200/800/2000 → 外门/内门/真传/长老；日俸 10/25/50/90（X:139-140、X:222）。
- 送礼：每人每天一次；喜欢 +40、普通 +15、讨厌 -10（X:141-145、X:206-207）。
- 叙话：每人每天一次，最多 30 人；+5 好感；每天前 3 人额外心境 +1（X:205）。
- 往事：每 NPC 2 章，按顺序；需好感/境界；两个选项效果见 X:147-158。
- 机缘：日 3 次、间隔 600 秒、触发率 `.4+luck/500`、当前保留 1800 秒；12 事件（X:160-174）；选项 `roll = cur.r-luck/400`（X:211-216）；池排除 `array`（境界<1）与已有 `palace` 标记（X:213）。
- 委托：每天 3 条；药材等级 ≤ 药园+1；交差奖励贡献 `win30/pill40/herb20+4n`，声望同值、灵石一半、执事 +5（X:176、X:217-221）。
- `applyEff`：好感夹 [-500,1000]；≤-100 自动仇人；心境 0–100；气运 -50–50；灵石/修为 ×(1+.5r)；灵力 0–100；声望 ≥0；结拜/道侣清同类关系（X:182-197）。

### M.4 自动战斗（X:227-266）

- 五行相克：金克木、木克土、土克水、水克火、火克金（X:228）。
- 通用：灵弹 cast .6/cd 1.2/dmg 7；护体金光 cast .8/cd 10/shield 22（X:232-234）。
- 技能：1 技能 cast 1.8/cd 6/dmg 26 + 专属；2 技能 cast .9/cd 4 + 专属（X:235-237）。
  - 2 技能：火 dmg5+burn[3,5]；水 heal24；木 dmg4+stun1.6；金 dmg15+pierce1+cast1.1+cd5；土 shield30+cd9；冰 dmg6+slow5；雷 dmg8+intr1+cast.4+cd6；风 dmg9+cast.3+cd2.4；熔 dmg10+burn[4,4]；毒 burn[5,6]+cast.7（X:230）。
  - 1 技能附加：雷 intr1；冰 slow4；熔 burn[3,4]；毒 burn[3,5]；风 cast1.2；金 pierce1（X:231）。
- 60 秒、0.1 秒/跳；4 技能槽；按槽位找第一个冷却好；被克制方伤害 ×.75、读条 ×1.2；伤害 `dmg*pw*(.9+.2R)`，10% 暴击 ×1.5；护盾吸收（穿透除外）；灼烧/治疗/护盾/眩晕/减速/打断；治疗仅在 hp<75%，护盾仅在无盾；胜者按死亡或剩余血量比例，平血判负（X:250-266）。
- NPC 29 人，元素/等级 52d 土3 至 ancestor 雷30；`pw=.7+.06*lv`、`hp=90+10*lv`（X:244-247）。
- 默认技能槽主修两技能+灵弹+护体；可保存 4 个不同已学技能（X:238-239、X:330）。

### M.5 秘境（X:267-348）

| id | 名称 | 境界 | pw/hp | 怪物池 | Boss | 手动关卡 | 药草 | k |
|---|---|---:|---|---|---|---|---|---:|
| bamboo | 竹海迷踪 | 0 | .5/45 | 蝠/狐/蛛/傀儡 | 三尾妖狐 | secret | 灵草/金菇/铃兰 | 0 |
| cave | 地火洞窟 | 1 | .64/62 | 蝠/石傀/魔修/蛛 | 魔修长老 | demon | 铃兰/赤芝 | 1 |
| tomb | 古修洞府 | 2 | 1.02/100 | 剑灵/傀儡/石傀/魔修 | 剑冢之主 | sword | 冰莲/赤芝 | 2 |
| cloud | 云海仙岛 | 3 | 1.1/105 | 剑灵/蝠/狐/魔修 | 雷云老怪 | 无 | 冰莲/雷竹 | 3 |

- 每日 3 次、每次 15 灵；进入 `hp=mx=meFighter(x,1.5).mx`；未走完且 <6h 不能再进，>6h 自动失败结束（X:277、X:339-341）。
- 地图 3 层；每层 3 普通行（列 1，70% 加列 0/2）+ 第 4 行精英/首领；节点权重 `fight38/chest10/spring8/event14/shop6/trap8/camp6/herb10`（X:275-279）。
- 前进：`R=-1` 或 2 任意列；否则同列/相邻（X:280、X:303）。
- 战斗倍率：普通 1.0、精英 1.4、首领 1.7、仇人伏击 1.5；属性浮动 `.85+.3*rng(seed)`；胜利回 10% 最大生命；首领胜利结束；首领可 `n=1` 手动，云海无手动只能自动（X:305-315）。
- 节点：泉 40%；营地 30%+心境2；陷阱 10–20%（至少留 1）；事件 `R+luck/200` 分 5 档（0 受伤12%、1 心境+4、2 药材、3 宝箱、4 修为 `20*(1+k)*rootMult`）；商店标记（X:316-323）。
- 战利品：普通 6 石、30% 药、20% 材料；精英 20、材料1–2、30% 培元丹；首领 50、材料2–3、培元丹1；伏击 40；宝箱 12、50% 材料、30% 药；药草点 2–3 株（X:292-301）；灵石再乘 `(1+.6k)*(.8+.4R)`（X:292）。
- 结算：胜利全带；非伏击失败一半；伏击失败全丢；首通培元丹2+回灵丹2（X:283-291）。
- 商店：回春散 25（回 50%）、玄铁 80、灵玉 80；每节点每件一次（X:327、X:343-345）；`rout` 按失败结算一半（X:346）。

### M.6 act3 与确定性边界

- `slots` 保存 4 个不同已学技能；`peek` 20 石，每个 NPC 每天最多看穿 4 个技能；`ab` 自动斗法扣 10 灵、计日 8 次，胜后首胜该 NPC 得 `round(15*(1+.5r))` 石（熔岩 ×1.3、结拜 ×1.1），好感 +3，功法熟练 +1（X:330-338）。
- `rin/rgo/rbuy/rout` 见 M.5（X:339-346）。
- `hseed`：FNV-1a 变体，参数 `|` 拼接，返回 uint32；`rng`：mulberry32（X:241-242）。
- 1.0 `act` 与 2.0 `act2` 接收 `rand`，默认 `Math.random`（X:74、X:202）；测灵根/突破/融合/炼丹、机缘/委托抽取使用它。
- 战斗/秘境必须确定性：`ab` 种子 `hseed(day,npc,df.n,stone,cv.xp)`；`rin` 种子 `hseed(day,rd.n,area,stone,cv.xp,log)`；地图/节点/怪物/战斗/首领弹幕分别用 `rlmMap(seed)`、`rng(hseed(seed,L,R+1,c))`、`rng(sd)`、`hseed(...,'b')`、`rng(hseed(seed,'dm'))`（X:278-279、X:303-311、X:326）。

---

## N. rules 模块全部 export（122 个）

```
ANIMALS AUTO AUTO_DEFAULT B12_ADULT_DAYS B12_CHAPTERS B12_GROW_DAYS B12_SNACK B12_TAX B26
BASE_PRICE BOX_SET CROPS CROP_TIERS FISH GOALS GOAL_BONUS GOAL_BONUS_COINS GOAL_COINS
GOAL_POOL GOAL_REWARD GOMOKU_LEVELS GOMOKU_N GOMOKU_PAID GUARD_ITEMS GUILDS ISLE_LAUNCH
ISLE_SEASON_DAYS ISLE_SPAN ITEM_NAME LOTTO LOTTO_PRIZE MARKET_EVENTS NORMAL_VOLUME NPC
NPC_GAMES ORES PICK_FLOOR QUALITY RECIPES SCRATCH SCRATCH_TABLE SEASONS SHOP THIEF_ITEMS
WEATHERS WELCOME_GIFT WORLD animalReady applyActions autoConfig autoDue autoSettle
b12AfterActive b12AllocateSubsidies b12AnimalPeriod b12AnimalStage b12Available b12BalanceTax
b12BaseApplyActions b12BaseAutoSettle b12ClockSeconds b12ClockStart b12ConfigureClock
b12Detection b12Effect b12FeedAnimal b12GuardRefundQuote b12IsLongNight b12NextIsleBoundary
b12NightKey b12NightView b12RecordActivity b12ReplenishWarehouse b12SaleQuote b12Season
b12State b12StealCost b12Stock b12StockLeft b12TakeAnimal b12TaxSale b26State bestCrop
cropFullLeft cropStage cropTierValue dailyGoals dailyGoalsOld energyMax eventFactor fishPool
goalReward gomokuAI gomokuLine gomokuReplay guardBoost hourOf isIsleDay isleCount isleDay
isleDayNo isleHour isleIndex isleMinute isleSeasonLeft lottoDrawId lottoFromBytes lottoPrize
marketDepth marketEvents marketFactor newWorld priceOf refresh seasonOf sprinkled supplyFactor
thiefBuff trapReady upgradePrice weatherOf worldDay
```

验证命令（项目根目录）：

```
node --input-type=module -e "import * as R from './cache/rules-05a5c445.mjs'; console.log(Object.keys(R).sort().join(' '))"
```

## O. 版本对比（a4a62d77 → 05a5c445）

- 旧 96,141 B → 新 116,876 B，增加 20,735 B；`diff -u` 只有 5 个 hunk。
- 差异只有：
  1. 管家结算新增 `run(b26AutoSell(s,pricesFor(isleDay(t)),isleDay(t)),t)`，在补货后、普通卖货前（新 R:1149；diff 旧上下文 1146）。
  2. `b12WarehouseAction` 增加 `b26Check`，n=0 删除 `s.b26.order[id+':'+q]`（新 R:1237；旧 1233）。
  3. `b12ReplenishWarehouse` 的 amount 增加 `b26Room(s,d,id)` 上限（新 R:1294；旧 1289）。
  4. 插入游乐馆 `ARC_RULES`（新 R:1341-1503）和 b26（新 R:1504-1545）；`b12ExtraAction` 增加 b26/arcade 两个前置分支（新 R:1547-1548）。
  5. 末尾 `export {B26, b26State};`（新 R:1706）。
- **结论**：差异就是「游乐馆 + b26 三个接线点 + 导出」，没有其他规则改动。
- `cache/rules-50b30a89.mjs` 与 `cache/rules-05a5c445.mjs` 字节完全相同（`cmp` 无差异）；`cache/arcade-05a5c445.mjs` 与 R 内联游乐馆的物理常量一致（A:3-157 与 R:1343-1501 同源）。

---

## P. 明确不在三份文件内的机制

- 擂台属性/装备/训练/突破/约战/宝箱：R 无实现，见 `core/arena.mjs` 与 `core/battle-rules.json`。
- 站宠等级曲线：R 只产出 xp 和 `pet` 奖励标记。
- 偷菜保护期、偷取上限、罚款上限、新手保护、亲密度增量、守家战结算：R 只有公式和道具；完整口径在 S/SS 与站点服务端。
- `ctx.prices`、`ctx.draws`、`storySeed`、动作 `rev`/409 由服务端/引擎注入，不在 R 中（R:905、R:856、R:1687；world.mjs:90-93、110-127）。
- `b15` 不是 state 字段，是前端 UI 代号；实际仓库数据见 `b12.vault/keep` 与 `b26`。

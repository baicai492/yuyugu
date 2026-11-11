p='ANALYSIS.md'; s=open(p,encoding='utf-8').read()
for a,b in [("| 有货就卖（不看行情） | 约 800 万 | 650 万 | 900 万 |","| 有货就卖（不看行情） | 约 770 万 | 650 万 | 900 万 |"),
            ("| 不做货船低买高卖 | 约 1060 万 | 750 万 | 1330 万 |","| 不做货船低买高卖 | 约 1030 万 | 680 万 | 1420 万 |")]:
    assert a in s; s=s.replace(a,b)
open(p,'w',encoding='utf-8',newline='\n').write(s)

open('README.md','w',encoding='utf-8',newline='\n').write('''# 鱼鱼谷（52dmeme.com/pets）全自动托管 · Chrome 插件

详细的机制、数据和策略分析见 [ANALYSIS.md](ANALYSIS.md)。

## 安装

1. Chrome 打开 `chrome://extensions`，右上角打开「开发者模式」。
2. 点「加载已解压的扩展程序」，选本目录下的 `extension` 文件夹。
3. 在 Chrome 里登录 52dmeme.com，点工具栏的小鱼图标，打开右上角总开关。

首次打开总开关会弹确认：默认会自动投资（新岛约花 800 万 D币，只买 10 天内回本的项目，始终保留 300 万余额），也可以选「开启但不投资」。

## 运行方式

- 托管逻辑跑在站点标签页里（请求和你手动玩完全同源）。开着托管但没有站点标签页时，插件会自动开一个固定的后台标签页。
- **浏览器必须开着**。关掉浏览器的时段，成熟超过 30 分钟的地一定会被别人的脚本偷（实测保护期结束 13 秒就被偷）。
  每天有固定时段关机的话，在「设置 → 防偷」里填离线时段，种地计划会避开在那段时间成熟。
- 想 24 小时挂着又不想开浏览器，可以用 Node 版：`node yuyugu.mjs`（读 `../messages/cookie.txt`，逻辑相同）。不要和插件同时开。

## 弹窗里的设置

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 演练模式 | 关 | 只在日志里打印计划，不提交 |
| 自动投资 / 回本期 / 保留余额 | 开 / 10 天 / 300 万 | |
| 货船低买高卖、加工坊、52弟 五子棋、咖啡 | 开 | |
| 卖出门槛 / 行情预测范围 | 97% / 7 岛日 | 调低、调小 = 少囤货 |
| 擂台日常 | 开 | 免费：每天 30 场 + 宝箱，自动换装加点 |
| 被偷后自动续守家道具 | 开 | 约 2400 D/天，只在被偷后 24 小时内或设了离线时段时续 |
| 离线时段 | 关 | |
| 自动偷菜 | **关** | 盯着活跃小岛，保护期一过就去；等级低时基本打不过守家鱼 |
| 串门帮忙 | 关 | 实测不赚 |

## 预期收益（14 天本地模拟，非实测）

稳定后日均约 1000–1300 万 D币（含库存），不投资约 500 万。当日赚钱榜第 1 名是 1970 万、第 10 名 960 万，量级吻合。
实测只有几次单轮巡视，没有连续挂过一整天。

## 风险

- 脚本会囤货等高价（常驻一两千万基础价的库存）；站点如果停服或重置，库存可能作废。
- 五子棋 52 局全胜、每岛日额度全用满，行为上很明显是脚本，是否会被处理无法判断。
- 站点改版后规则表会自动跟随线上版本；如果接口结构变了，托管会报错停下而不是乱操作。

## 文件

- `extension/` 插件（`lib/strategy.mjs` 策略、`lib/social.mjs` 擂台与偷菜、`lib/gomoku.mjs` 五子棋、`page.mjs` 页面端主循环）
- `yuyugu.mjs` Node 版运行器；`sim.mjs` 本地模拟器（`node sim.mjs 14 --book`）
- `research/` 调研时抓的前端源码、接口样本、分析与验证脚本
''')

p='C:/Users/Administrator/.claude/projects/E--lrz-python-project/memory/52dmeme-yuyugu-bot.md'
open(p,'w',encoding='utf-8',newline='\n').write('''---
name: 52dmeme-yuyugu-bot
description: 鱼鱼谷(/pets)托管做成了 Chrome 插件（52dmeme/yuyugu/extension），另有 Node 版和模拟器；协议坑、收益杠杆、防偷结论
metadata:
  type: project
---

鱼鱼谷（52dmeme.com/pets）全自动托管，2026-11-11 完成，在 `E:\lrz\python project\52dmeme\yuyugu\`。用户要的最终形态是 **Chrome 插件**（`extension/`，MV3，逻辑注入站点页面运行）；同一套 `extension/lib` 也被 Node 版 `yuyugu.mjs` 和模拟器 `sim.mjs` 复用。说明见 README.md，数据分析见 ANALYSIS.md。

- 协议：`GET /api/pet/world`，`POST /api/pet/world/act {rev, operation, actions≤40}`，2 秒一次；Node 里 POST 不带 Origin 头会 403「非法来源」（cookie 失效是 401）。
- 规则表 `/pet-world-rules.js` 前后端共用，直接 import 做本地预演；价格是日期哈希，可预测未来岛日行情。
- 收益杠杆：吃菜回体力极便宜→用满每岛日额度；货船基础价进货等高点卖；52弟 五子棋 AI 确定性→本地求解全胜。模拟日均约 1000–1300 万，与赚钱榜前列同量级。
- 防偷：别人的脚本在 30 分钟保护期结束后 13 秒就到，只有「成熟即收」可靠；离线时段靠改种地计划规避。自动偷菜已写但默认关，成功路径未实测（账号 8 级打不过守家鱼）。
- 测试插件：playwright-core + `channel: 'msedge'` + `--headless=new --load-extension`（`research/test-extension.mjs`）。

**Why:** 用户目标是「赚 D币越多越好」，并明确要求防偷、可选偷菜、详细分析。

**How to apply:** 截至 11-11 只做过几次单轮实测（未投资），持续托管和约 800 万投资留给用户在弹窗里确认开启。再问到时先看用户是否已在跑；站点改版后先用演练模式验证。相关：[[52dmeme-farm-helper]]。
''')
p='C:/Users/Administrator/.claude/projects/E--lrz-python-project/memory/MEMORY.md'
s=open(p,encoding='utf-8').read()
i=s.index('- [鱼鱼谷托管脚本]'); j=s.index('\n',i)
s=s[:i]+'- [鱼鱼谷托管插件](52dmeme-yuyugu-bot.md) — 52dmeme/yuyugu/extension 是 Chrome 插件（另有 Node 版与模拟器）；吃菜回体力+行情预测+五子棋必胜；防偷只能靠成熟即收；偷菜默认关且未实测成功；持续托管与约 800 万投资待用户开启'+s[j:]
open(p,'w',encoding='utf-8',newline='\n').write(s)

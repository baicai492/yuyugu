# 本轮计划（2026-11-13，站点 05a5c445 / 修仙 20b20a0e）

- [x] 更新规则缓存 与 xian-rules
      rules-05a5c445.mjs / arcade-05a5c445.mjs / xsrules-20b20a0e.mjs 已落盘并与线上逐字节一致；
      core/rules.mjs 已加游乐馆独立加载器。
- [x] 重分析站点 05a5c445 全部模块
      用登录态 cookie 重抓 /pets 与全部前端模块；重读 pet-isle.js、isle-arcade.js、
      isle-warehouse.js、xs2.js、xs3.js；重算数值表；产出 ANALYSIS-05a5c445.md + MODULES.md。
      （ANALYSIS.md 是 11-11 版存档，按用户要求保留不覆盖；新版单独落盘。）
      research/analysis-tables.md 已用 05a5c445 规则重算。
- [x] 接入游乐馆自动打满
      core/arcade.mjs：pool/bowl 克隆贪心（自检 1200 / 250），bounce 候选 + 全随机流重建；
      提交前 canonicalShots 规范化（坐标/速度量化、限速裁剪）；
      遵守 MIN_PLAY 5/6/8 秒；arcStart → arcEnd；每日各 10 局，单轮 perTick 局。
- [x] 接入囤货仓库 b26
      planVault 加 slots/unit 约束（b26Check 原文口径）；planVaultUpgrade 撞墙才升级；
      whOrder/whAlert 未接（文档注明自动出售在 05a5c445 原文里很可能不触发）。
- [x] 更新修仙 2.0 托管
      core/xian2.mjs：talk/gift/chap/evroll/evpick/tasks/task/stipend/slots/ab/rin/rgo/rout；
      evpick/ab/秘境本地精确预演（秘境束搜索），evroll/tasks 先提交再按真实状态规划；
      peek 不接（只对手动弹幕有用）；遵守 FORBIDDEN_XIAN_ACTIONS。
- [x] 接线与收尾
      core/world.mjs 动作名表、core/engine.mjs 主流程（游乐馆段、修仙2.0、唤醒时间）、
      core/config.mjs 开关（xian2 / arcade / vault.upgrade）；
      清理 arc-bench/arc-probe/arc-probe2；selftest 81 项全过；commit + push。
- [x] 全模块审计（AUDIT-05a5c445.md）
      重新拉取 36 个前端模块（pets.js 入口链 + xs/*.js），逐个核对 72 个协议动作
      （岛 36 + 修仙 36）；线上三份规则文件与本地缓存逐字节一致；未接的 11 项逐条给出量化理由
      （彩票返奖率 3.49% / 74%、山谷纪事无奖励、whOrder 只服务端管家触发、
      弹幕与序章属手动专属）。
- [x] GUI 接上 2.0 与游乐馆
      概览加仓库行；修仙页加「修仙 2.0」与「游乐馆」两张卡片；设置页加修仙2.0/游乐馆/仓库升级；
      /api/status 增加 vault 快照；manifest 2.1.0。
- [x] 修弹弹乐「太快了」十连 0 分
      根因：MIN_PLAY 比的是服务端两次处理时刻之差，而客户端 POST 有 2.15 秒节流；
      旧计时起点在发请求之前，5.8 秒到服务端只剩 4 秒。改为从 arcStart 回执之后计时、
      余量 1.2 秒，并对「太快了」重试 arcEnd（服务端不清 arc.cur）。
- [x] 第四份分析报告 ANALYSIS-rules-mechanics.md
      规则数值全量 A–P 十六节（世界时钟/体力/农田/牧场/渔矿加工/集市事件/每日目标/偷菜/
      b26/夜潮税补/72 动作/state/修仙 rules/122 导出/版本差异/文件外机制），每条带 文件:行号。
- [x] 按四份文档对账并修真实缺口
      · 售卖税预测跨日归零（core/market.mjs）：b12SaleQuote 是纯函数不做日界，
        必须自己判 tax.day===worldDay(now)，否则 0 点后沿用昨天的 paid 高估今天的税；
      · 52弟剩余额度抽牌（core/npc.mjs + config + GUI）：pay() 只在胜利时发奖、
        输和平零成本，抽牌 2,733 D/计次；旧注释「期望中性默认不打」是错的。
        五子棋打满 10 局后剩 42 次额度，一天约 11 万 D；
      · 管家抽成文案（core/world.mjs）：05a5c445 起 AUTO.fee=0，不再抽 20%；
      · 重启在线主程序（内置 /api/command restart，带端口交接与失败回滚）。

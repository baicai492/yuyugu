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

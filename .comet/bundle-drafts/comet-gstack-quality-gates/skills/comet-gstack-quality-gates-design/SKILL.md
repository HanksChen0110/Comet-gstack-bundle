---
name: comet-gstack-quality-gates-design
description: "澄清 OpenSpec 和项目规则，记录当前版本确认与预算。"
---

# Design

先运行 `workflow-guard.mjs entry design`，加载原 `comet-design` 完成设计产物。对照 proposal、design、tasks、delta spec、项目 AGENTS.md/CLAUDE.md 与当前代码，只读检查目标、非目标、规则来源、适用范围、关键未知项和验收场景是否矛盾。采用少量关键问题澄清；每项标记已确认、推断、待用户决定。未解决的规则冲突或影响实现的未知项不得进入 plan。

保留原 Comet 的设计方案确认。Design Doc 与 delta spec 定稿后，再按 `../comet-gstack-quality-gates/reference/start-approval.md` 展示当前摘要、验证命令和预算，取得用户对此版本的明确确认，运行 `workflow-policy.mjs snapshot`、`approve <confirmed-brief.json>` 与 `check`。旧的产物确认和“推荐决定预授权”不能代替本次确认。

不默认调用 `autoplan`，也不在确认前运行代码审查、测试或浏览器 QA。用 `workflow-state.mjs record design` 保存 `design-summary` 与 `user-confirmation`，运行 `workflow-guard.mjs exit design --apply`，只按当次 NODE/SKILL 路由。范围、规则或验收场景变更后先更新 OpenSpec，再对新摘要重新确认。
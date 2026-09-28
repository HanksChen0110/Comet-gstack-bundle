# 开工确认与预算

在 OpenSpec 的 proposal、design、tasks 和 delta spec 完成后，用少量关键问题澄清目标、非目标、边界、规则来源、关键未知项和验收场景。先对照项目 `AGENTS.md`、`CLAUDE.md` 及现有代码，检查规格、计划与任务是否互相矛盾。把每条信息标为已确认、推断或待用户决定；影响实现的推断、待决定项或规则冲突存在时停在设计阶段。

首次开工前向用户展示**当前文件版本**和覆盖整个 change 的预算，请求一次明确确认。后续节点只检查同一确认的摘要与剩余预算，不逐阶段请求。原有 Comet 产物确认仍执行；它或“推荐决定已预授权”均不能替代这次具体规格确认。用户确认后，运行：

```text
node comet-gstack-quality-gates/scripts/workflow-policy.mjs snapshot
node comet-gstack-quality-gates/scripts/workflow-policy.mjs approve <confirmed-brief.json>
node comet-gstack-quality-gates/scripts/workflow-policy.mjs check
```

`snapshot` 输出当前 OpenSpec 和项目规则摘要。`confirmed-brief.json` 至少包含：

```json
{
  "specDigest": "<snapshot.spec.digest>",
  "rulesDigest": "<snapshot.rules.digest>",
  "userConfirmation": {"kind": "explicit-user", "text": "<用户对所展示版本的明确确认>"},
  "goal": "<目标>",
  "nonGoals": ["<非目标>"],
  "rules": [{"text": "<适用规则>", "source": "AGENTS.md:行号或用户消息", "status": "confirmed"}],
  "unknowns": [{"text": "<未知项及处置>", "status": "resolved"}],
  "conflicts": [],
  "scenarios": ["<可验收场景>"],
  "taskType": "document",
  "riskLevel": "normal",
  "checks": ["node --test affected.test.mjs"],
  "budgetMinutes": 240,
  "maxRepairRounds": 1
}
```

`taskType` 为 `document`、`web` 或 `code`。预算字段可省略，新 change 默认总计 4 小时、1 轮实现返工；已确认 change 不因新默认值而延长。高风险 change 设 `riskLevel: high`，在普通完整 diff 审查后运行独立第二审，并用 `record-second-review <report.json>` 记录。普通 change 不运行第二审。

目标、范围、适用规则或验收场景实质变化后，先更新 OpenSpec，再向用户展示新摘要并重新确认；旧确认自动失效。任务复选框由 `[ ]` 变为 `[x]` 不影响摘要。证据格式、CLI 路由及已批准实现内的定向修复由 Agent 自行处理。开始前、恢复后和每个节点入口都检查预算与摘要，但校验不是新确认。

活跃 change 的 Hook 在 plan 及后续节点，对识别出的直接文件写工具检查当前开工确认；open/design 阶段可继续写规格。Shell 命令等无法可靠识别写入意图的工具不能仅凭 Hook 保证阻止，仍须使用节点守卫和批准的 `run-check`。这层限制应保留在试点报告中。

构建阶段只运行受改动影响的批准命令；用 `workflow-policy.mjs run-check -- <command> [args]` 执行，单条默认 10 分钟上限。相同代码、规格和命令的通过记录直接复用；相同失败重复出现时暂停并调查。若项目 `AGENTS.md` 要求完整回归，应在确认中列入命令并执行，或先请用户调整项目规则。

网页任务只在 verify 对批准的所有场景做只读检查，将 `{ "readOnly": true, "passed": true, "scenarios": [...] }` 及实际问题证据保存成报告，再运行 `record-qa <report.json>`。文档和普通代码任务不运行浏览器 QA。广泛全站探索需用户另行发起。QA 只报告；修复由 build 执行，复测限于受影响场景。

进入实现返工前运行 `workflow-policy.mjs repair`（语义失败引发的 overlay 自动回退会自动计数）。证据或工具调用格式失败先在当前节点纠正，不消耗实现返工轮次。第 1 轮实现返工后的验收复测仍失败、没有实质进展或到达总时间上限时，运行 `workflow-policy.mjs handoff <简短进度和下一步>` 保存交接并停止新的测试和审查。过期后仍可写交接；续跑需用户重新确认新预算。跨 Codex/Claude token 没有统一实时计数，以时间和返工轮次硬停，token 只做事后复盘。

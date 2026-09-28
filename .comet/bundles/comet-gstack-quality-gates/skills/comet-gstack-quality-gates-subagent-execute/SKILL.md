---
name: comet-gstack-quality-gates-subagent-execute
description: "Comet Classic handoff 执行节点；按已确认规格和预算交接。"
---

# Subagent Execute

先运行 `workflow-guard.mjs entry subagent-execute` 并核对开工确认。保留 `subagent-driven-development` 的 handoff 证据和当前代码状态检查。子代理收到相同规格摘要、规则、场景、受影响检查与剩余预算；不得自行扩大范围或追加逐段 review。handoff 返回后由 review 节点对完整 diff 审查一次。

用 `workflow-state.mjs record subagent-execute` 记录 `handoff-request`、`handoff-result` 和实际产物，再运行 `workflow-guard.mjs exit subagent-execute --apply`。缺失证据、预算到期或规格漂移时暂停并保存交接。

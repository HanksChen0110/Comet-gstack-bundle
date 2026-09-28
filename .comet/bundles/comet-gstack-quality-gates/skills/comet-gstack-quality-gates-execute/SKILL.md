---
name: comet-gstack-quality-gates-execute
description: "Comet Classic execute 节点；按已确认规格限额实现。"
---

# Execute

先运行 `workflow-guard.mjs entry execute`；未获当前规格确认或预算到期时停止。加载 `comet-build` 完成本次任务，只运行批准的受影响检查。项目规则要求的完整回归仍执行或先请求调整。用 `workflow-policy.mjs run-check -- <命令>` 运行检查，默认单条 10 分钟；相同代码与规格摘要的通过记录复用。

不创建 implementation-segments.json，不运行逐段 review。代码稳定后在 review 节点对完整 diff 审查一次。记录真实 `implementation-summary` 与 `test-evidence`；`tasks.md` 必须匹配完成状态。退出运行 `workflow-guard.mjs exit execute --apply`，按当次 NODE/SKILL 路由。

失败先报告与调查。需要定向修复时计入返工预算；预算到期或超过 1 轮自动返工则保存交接并暂停。规则、范围或验收场景变化先更新 OpenSpec 并重新获取当前版本确认。

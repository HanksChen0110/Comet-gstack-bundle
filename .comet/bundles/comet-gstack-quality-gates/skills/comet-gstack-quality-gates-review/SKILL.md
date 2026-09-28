---
name: comet-gstack-quality-gates-review
description: "对当前完整 diff 做一次审查；仅高风险追加独立第二审。"
---

# Review

先运行 `workflow-guard.mjs entry review`。加载 `requesting-code-review`，只对本次完整 diff、已批准规格与相关测试证据审查一次，检查正确性、安全和边界。不要按任务或实现段分别调用。当前代码与规格摘要已有有效通过 receipt 时复用。普通任务不固定调用 `codex` 第二审；`riskLevel: high` 时请独立审查者检查，并用 `workflow-policy.mjs record-second-review <report.json>` 记录。

把 `review-summary`、`review-code-state-hash`、`review-spec-digest`、`review-result: pass`、`review-blockers-resolved: true` 写入 Node evidence。将真实 review 结构化原件保存为 `evidence/gstack/review-source.json`，运行 `workflow-guard.mjs receipt review requesting-code-review <review-source.json>`；再将同一 schemaEvidence 和原件的 SHA-256 写入 `evidence/gstack/review-current-diff.json` 的 `reportDigest`。Guard 检查两文件、代码与规格绑定；最后运行 `workflow-guard.mjs exit review --apply`。证据格式错误在当前节点纠正，不重新审查同一 diff，也不计实现返工。

有 blocker 时先报告，回 build 做定向修复；第二轮失败或预算到期时停止并保存交接。不得用旧 diff 审查结果授权新代码。

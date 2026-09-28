---
name: comet-gstack-quality-gates-verify
description: "按当前已批准验收场景验证；网页任务做只读 QA。"
---

# Verify

先运行 `workflow-guard.mjs entry verify` 并核对当前开工确认。加载 `comet-verify` 和 `verification-gate`，以已批准验收场景为范围完成最终验证；构建阶段已通过且代码、规格摘要相同的检查不重复运行。项目 AGENTS.md 要求完整回归时按该规则执行。测试通过 `workflow-policy.mjs run-check -- <命令>` 运行，单条默认 10 分钟。

文档任务不运行浏览器 QA。网页任务只读检查批准的全部场景、核心流程和受影响页面，保存 `{ "readOnly": true, "passed": true, "scenarios": [...] }` 及实际证据的报告，运行 `workflow-policy.mjs record-qa <report.json>`；不调用会改码、提交或启动全站巡检的 `qa`。失败先报告，再回 build 定向修复和复测；最多 1 轮自动返工。

将 `verification-commands`、`verification-result`、`verification-gate-passed`、当前代码/draft hash 和 `verify-evidence-validity: valid` 写入 Node evidence。将真实结构化原件保存为 `evidence/gstack/verify-source.json`，运行 `workflow-guard.mjs receipt verify verification-gate <verify-source.json>`；再将同一 schemaEvidence 和原件的 SHA-256 写入 `evidence/gstack/verify-scoped.json` 的 `reportDigest`。运行 `workflow-guard.mjs exit verify --apply`。Guard 会检查当前 receipt、artifact、代码、规格和网页 QA 记录。证据格式错误由本节点自行纠正，不重新测试同一输入。

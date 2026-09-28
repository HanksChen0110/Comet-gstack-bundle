---
name: comet-gstack-quality-gates-archive
description: "检查当前验证证据后调用原 Comet Classic 归档事务。"
---

# Archive

先运行 `workflow-guard.mjs entry archive`。重新核对当前开工确认、预算、verify 的 passed Guard、receipt、报告摘要、artifact 路径和 SHA-256；网页任务还须有当前代码与规格的只读 QA 报告。普通任务不固定运行 `health`。已有项目规则明确要求 health 时照做，或先请用户调整规则。

记录 archive Node evidence 后运行 `workflow-guard.mjs authorize archive`。授权只绑定当前证据，任一代码、规格、规则、draft 或 artifact 漂移都会失效。随后加载原 `comet-archive`，保留其归档前用户确认、OpenSpec 同步、pending action、single-flight journal/lease 与成功后 finalize。Agent 不手动调用内部 confirm/prepare/finalize/recover，不将授权或 prepared 视为已经归档。

失败先报告并按当前 Guard 路由定向处理；超过预算或返工次数则保存交接并暂停。不得用旧授权绕过归档前检查。

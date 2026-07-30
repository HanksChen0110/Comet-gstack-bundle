---
name: comet-gstack-quality-gates-subagent-execute
description: "仅在 /comet-gstack-quality-gates-subagent-execute 被显式调用或由 comet-gstack-quality-gates 路由选中时使用；完成 subagent-execute 节点并记录质量门证据。"
---

# Subagent Execute

## 节点目标

完成 `comet-gstack-quality-gates` 的 `subagent-execute` 节点。

职责：按 workflow protocol 完成 `subagent-execute` 节点并留下可验证证据。

## 操作指引

### 前置条件

- 委派范围、选定 change、当前代码状态和返回证据契约已持久化。
- `subagent-driven-development` 与 `review` 均可解析；子代理任务提示必须明确要求加载 `review`，不能只由协调者事后声称已审查。

### 步骤

1. 使用 `subagent-driven-development` 发起原有委派流程，并先运行 `workflow-handoff.mjs request subagent-execute`。把 stdout 中的 `REQUEST_ID`、`REQUEST_DIGEST`、`HANDOFF_SCOPE` 和 `NODE` 原样保存并随任务交给子代理；这些字段是 accept 所需的最小绑定上下文，不需要也不得借诊断 `status`、猜文件路径或手写 ledger 补取。
2. 要求子代理在交接内加载 `review`，并在结构化 execution report 中原样回传 request stdout 的 id、digest、scope，连同实际 review 结果、子代理执行证据、blocker 处置和与请求一致的代码/draft hash；不得自填 `completedChecks`。
3. 仅用匹配的 pending request 执行 `workflow-handoff.mjs accept subagent-execute <structured-return-report.json>`。accept 会核对 request id/digest/scope、当前 change/code/draft/protocol，并在内部让 guard mint `review` receipt；Agent 不直接调用 guarded receipt。缺少 stdout 绑定字段、report、receipt、hash 一致性或 blocker 处置时拒绝接受，停在 subagent-execute 重新 request/交接。
4. accept 成功后运行本 Node 的后续 Exit Check；accept 本身只输出 HANDOFF/REQUEST/receipt 结果，不输出 `NEXT/SKILL`。只有 Exit Check 输出 `NEXT: auto` 时，才使用同一输出的 `SKILL:` 继续。

### 完成判定

本节点完成是 request stdout 与 accept 可审计地配对，且接受返回已由 guard 生成满足 handoff schema 的有效 receipt，不是子代理宣称“完成”。协调者不能用自己的总结替代返回 evidence，也不能因 Skill 名称被提及而接受交接。

### 红旗

- 子代理未加载 `review`，但协调者补写“已审”。
- 丢弃 `REQUEST_DIGEST` 或 `HANDOFF_SCOPE`，再靠 `status`、文件猜测或手写字段补齐。
- 跳过 request，或以另一次 request 的 id/digest 接受返回。
- 自填 `completedChecks`、直接 mint handoff-guarded receipt 或手写 ledger。
- 接受与请求时不同代码/draft 状态的返回，或有 blocker/证据缺失仍视为成功。

## 入口检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs entry subagent-execute
```

## Skill 实现

加载 `subagent-driven-development` 执行本节点，operation 为 `default`。

## 必需 Skill 调用

- 通过 `workflow-handoff.mjs request` 持久化委派请求，要求子代理加载 `review` 并返回结构化 review artifact，再通过 `workflow-handoff.mjs accept` 接收；handoff receipt 由 accept 内部铸造，Agent 不直接调用 `workflow-guard.mjs receipt`（scope: `handoff`，enforcement: `handoff-guarded`）。

## 增强调用

- 本节点没有 augmentation。

## 输出结构

- `comet.handoff.v1`：必需证据 `handoff-request`、`handoff-result`；必需 artifact 无。
- `gstack.subagent.handoff-review.v1`：必需证据 `handoff-review-loaded`、`handoff-review-result`、`subagent-returned-evidence`、`handoff-code-state-hash`、`handoff-review-blockers-resolved`；必需 artifact `subagent-handoff-review-reports`。

## 证据记录

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs context

node comet-gstack-quality-gates/scripts/workflow-state.mjs record subagent-execute '{"summary":"record the real Node result","schemaEvidence":{}}'

```

状态记录器不能铸造 Required Skill receipt。每个 guarded binding 都要保存结构化执行报告，包含 Node、Skill、change、status、开始/完成时间、当前 code hash、当前 draft hash、非空 `skillOutput` 与对应 `schemaEvidence`。handoff-guarded binding 只通过 workflow-handoff request/accept，由 accept 内部铸造 receipt；Agent 不直接调用 receipt。receipt 的字段必须只覆盖该 Skill 负责的证据子集，并与 Node 最终证据和 Output Schema artifact 一致。禁止复用旧 code state 或旧 Bundle draft 的 hash。



委派前先持久化请求：

```bash
node comet-gstack-quality-gates/scripts/workflow-handoff.mjs request subagent-execute
```

子代理返回结构化 review artifact 后，通过 handoff guard 接收：

```bash
node comet-gstack-quality-gates/scripts/workflow-handoff.mjs accept subagent-execute <structured-return-report.json>
```



## 守卫规则

- `handoff-evidence`：按 `evidence-only` 校验。

## 退出检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs exit subagent-execute --apply
```

始终只遵循本次退出检查标准输出中的 `NEXT`、`NODE`、`SKILL` 动态路由。`build_mode`、`review_mode`、当前有效 Guard 证据和 remediation 都可能改变下一节点；不得按 protocol 数组顺序硬推后继，也不得复用旧输出。

## 恢复

依次运行 `node comet-gstack-quality-gates/scripts/workflow-state.mjs status` 与 `node comet-gstack-quality-gates/scripts/workflow-state.mjs next`。若 remediation 正在执行或可重试，按输出的 `RETRY`、`NODE`、`SKILL` 唯一路径继续；实际重试命令是 `node comet-gstack-quality-gates/scripts/workflow-guard.mjs retry-remediation <from>`。原 Classic `.comet.yaml` 是唯一控制状态。


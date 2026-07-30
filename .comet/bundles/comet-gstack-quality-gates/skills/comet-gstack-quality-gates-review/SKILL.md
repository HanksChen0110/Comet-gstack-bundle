---
name: comet-gstack-quality-gates-review
description: "仅在 /comet-gstack-quality-gates-review 被显式调用或由 comet-gstack-quality-gates 路由选中时使用；完成 review 节点并记录质量门证据。"
---

# Review

## 节点目标

完成 `comet-gstack-quality-gates` 的 `review` 节点。

职责：按 workflow protocol 完成 `review` 节点并留下可验证证据。

## 操作指引

### 前置条件

- execute 或已接受的 handoff 已提供当前代码状态，且没有待处理的上游 evidence 缺口。
- `codex` 可解析；不可解析时停止，不把普通 code review 结果标记为对抗审查。

### 步骤

1. 保留 `requesting-code-review` 的现有审查职责；本节点只在正式 verify 前加载 `codex` 进行对抗审查。
2. 将实际审查结果、发现项处置、当前代码状态 hash 与当前 draft hash 写入结构化 execution report，并交由 Auto 区 guard mint receipt；不得自填 `completedChecks`。
3. 出现未处置 blocker 或审查揭示实现问题时回到 execute 修复，随后重新进入 review；不要带着旧 hash 或 receipt 进入 verify。
4. guard 通过后才按 runtime 的 `NEXT: auto` 和 `SKILL:` 衔接。

### 完成判定

完成意味着对抗审查结论属于当前代码和当前 draft，阻断发现已经有实际处置，且结构化报告已生成有效 receipt；仅运行 `codex` 或只有“无问题”口头结论均不足以推进。

### 红旗

- 审查在旧 diff 上完成后代码又变化。
- 将低优先级建议和 blocker 混淆，或忽略真正 blocker。
- 自填 `completedChecks`，或以通过普通审查替代 `codex` 的报告和 receipt。

## 入口检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs entry review
```

## Skill 实现

加载 `requesting-code-review` 执行本节点，operation 为 `default`。

## 必需 Skill 调用

- 加载 `codex`，保存非空结构化输出与 schema evidence，再用 `workflow-guard.mjs receipt` 铸造 `required-skill:review.codex` receipt（scope: `review`，enforcement: `guarded`）。

## 增强调用

- 本节点没有 augmentation。

## 输出结构

- `comet.review.v1`：必需证据 `review-summary`；必需 artifact 无。
- `gstack.review.codex-adversarial.v1`：必需证据 `codex-review-run`、`codex-adversarial-result`、`codex-code-state-hash`、`codex-draft-hash`、`codex-blockers-resolved`；必需 artifact `codex-adversarial-report`。

## 证据记录

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs context

node comet-gstack-quality-gates/scripts/workflow-state.mjs record review '{"summary":"record the real Node result","schemaEvidence":{}}'
node comet-gstack-quality-gates/scripts/workflow-guard.mjs receipt review codex <structured-execution-report.json>
```

状态记录器不能铸造 Required Skill receipt。每个 guarded binding 都要保存结构化执行报告，包含 Node、Skill、change、status、开始/完成时间、当前 code hash、当前 draft hash、非空 `skillOutput` 与对应 `schemaEvidence`。普通 guarded binding 再执行上方 receipt 命令。receipt 的字段必须只覆盖该 Skill 负责的证据子集，并与 Node 最终证据和 Output Schema artifact 一致。禁止复用旧 code state 或旧 Bundle draft 的 hash。







## 守卫规则

- `review-evidence`：按 `evidence-only` 校验。

## 退出检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs exit review --apply
```

始终只遵循本次退出检查标准输出中的 `NEXT`、`NODE`、`SKILL` 动态路由。`build_mode`、`review_mode`、当前有效 Guard 证据和 remediation 都可能改变下一节点；不得按 protocol 数组顺序硬推后继，也不得复用旧输出。

## 恢复

依次运行 `node comet-gstack-quality-gates/scripts/workflow-state.mjs status` 与 `node comet-gstack-quality-gates/scripts/workflow-state.mjs next`。若 remediation 正在执行或可重试，按输出的 `RETRY`、`NODE`、`SKILL` 唯一路径继续；实际重试命令是 `node comet-gstack-quality-gates/scripts/workflow-guard.mjs retry-remediation <from>`。原 Classic `.comet.yaml` 是唯一控制状态。


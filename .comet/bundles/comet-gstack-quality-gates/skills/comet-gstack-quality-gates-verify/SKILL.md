---
name: comet-gstack-quality-gates-verify
description: "仅在 /comet-gstack-quality-gates-verify 被显式调用或由 comet-gstack-quality-gates 路由选中时使用；完成 verify 节点并记录质量门证据。"
---

# Verify

## 节点目标

完成 `comet-gstack-quality-gates` 的 `verify` 节点。

职责：按 workflow protocol 完成 `verify` 节点并留下可验证证据。

## 操作指引

### 前置条件

- execute 与 review 的最新 Guard result、receipt 和 artifact 均对齐当前代码状态、当前 draft 及各自最新的适用 invalidation chain，且没有未处置 blocker；更新但不作用于该 Node 的其他 invalidation 不改变这条链。
- `verification-gate` 与 `qa` 均可解析；任一缺失时停在 verify，不得倒序、跳过或用旧结果替代。

### 步骤

1. 保留 `comet-verify` 的原有验证职责，并先加载 `verification-gate`。结构化 report 只投影 schema 中以 `verification-` 开头的必需字段，同时记录当前 change、code/draft/protocol、真实起止时间与非空 Skill output；运行 `workflow-guard.mjs receipt verify verification-gate <report.json>` mint receipt。不得自填 `completedChecks`。
2. 只有取得当前有效的 `verification-gate` receipt 后才加载 `qa`。QA report 投影其余必需字段，并把前一步的 `predecessorReceiptId` 与 `predecessorReportDigest` 原样绑定；同时记录 QA 起止时间、运行前后代码 hash、是否改代码、是否产生新提交、是否发现待修复问题。runtime 会拒绝缺失、错误、倒序或过期的前驱绑定。
3. QA intake 一旦出现 `qa-code-modified=true`、`qa-new-commit-created=true` 或 `qa-fix-required=true`，runtime 会在 mint QA receipt 前写入审计、失效 execute/review/verify 的旧 evidence、receipt 与 Guard result，并启动 `verify-qa-invalidated`。该 invalidation 可以与其他历史或当前 invalidation 共存，但只作用于其声明的 `invalidatedNodes`；不要等待 Exit Check，也不要把本次 QA 当作通过 receipt。
4. 即使 Classic `review_mode` 为 `off`，overlay remediation 也必须强制 execute 通过后进入 review，完成 fresh review Guard 后才可重回 verify。若统一 route 输出 `NEXT: retry-remediation`，只执行同次输出的完整 `RETRY: node <absolute-package-path>/scripts/workflow-guard.mjs retry-remediation <from>`。若已应用，则只按同次输出的 `NODE: execute` 与 `SKILL:` 回到 execute；不得在 verify 原地补证据或发明 reset/bypass。
5. remediation 后，每个 Node 只绑定对自身最新适用的 invalidation chain，并依次建立当前代码/draft 的 execute sealed manifest/逐段 review → execute fresh Guard → review receipt/fresh Guard → `verification-gate` → `qa`。简单 QA recovery 时三者可同属原 QA chain；若 review 再失败形成更新的 review→execute chain，execute/review 必须绑定新 chain，而 verify 仍绑定其最新适用的原 recovery anchor。跨 Node 前驱按各自最新 chain 与同一当前 code/draft 校验，不能用全局单一 chain id 覆盖。
6. 两张 verify receipt 都 mint 后，将两者字段联合写入当前 verify Node evidence 与同一 Output Schema artifact，并保留两份 report digest。运行 `workflow-guard.mjs exit verify --apply`；Exit Check 联合校验字段投影覆盖、`verification-gate → qa` 顺序、前驱链、artifact digest、当前 code/draft/protocol、语义规则与作用域正确的 fresh remediation chain。
7. overlay verify 通过时，runtime 先在 ledger 写入与当前两张 receipt、hash 和适用 chain 绑定的 passed Guard result；若 verify 是当前 Classic phase 的最后一道 overlay gate，随后才调用原 `comet guard <change> verify --apply`。archive 的 `authorize` 会重新求得当前 verify Guard result、两张 receipt id 和两份 report digest，并把这组 ledger 快照绑定进授权；任一 receipt、artifact、code、draft、protocol、chain 或 Guard result 漂移，后续 archive confirmation/consume 都会拒绝。
8. `workflow-state.mjs status`、`workflow-state.mjs next` 与 Classic hook 使用同一内部 route resolver，必须得到一致 current Node。Agent 只按 `next` 当前输出继续；三者不一致是 runtime 错误，应阻断而不是选择其中一个，也不需要手工调用 Guard route 或不存在的 Guard verify 命令。

### 完成判定

verify 通过必须由当前代码和 draft 上职责分离的 `verification-gate → qa` 两份 report、receipt 与聚合 artifact 构成，并产生绑定它们的当前 passed Guard result。若经历一次或嵌套 invalidation，execute/review/verify 都必须具备绑定自身最新适用 chain 的 fresh Guard 结果；其他无关或旧 chain 不能污染、替换或阻断当前 Node。archive 使用的是这组 ledger 快照，不是普通字段或口头结论。

### 红旗

- 在 verification-gate report 中伪装 QA 字段，或让 QA report 借用 verification 字段凑覆盖。
- QA 缺真实前驱 receipt id/digest，或先运行 QA 再补 verification-gate。
- QA 已改码、新提交或发现修复项，却仍尝试 archive。
- remediation 后没有重新封存 execute manifest、逐段 review，或缺 fresh execute/review Guard result。
- 用账本里更新但无关的 invalidation chain 替换当前 QA chain，导致 receipt 或 Guard result 错绑。
- `status`、`next` 与 hook 路由冲突时仍任选一路推进。
- 把旧 verify 普通字段当作当前 ledger-backed Guard 快照。

## 入口检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs entry verify
```

## Skill 实现

加载 `comet-verify` 执行本节点，operation 为 `default`。

## 必需 Skill 调用

- 加载 `verification-gate`，保存非空结构化输出与 schema evidence，再用 `workflow-guard.mjs receipt` 铸造 `required-skill:verify.verification-gate` receipt（scope: `main`，enforcement: `guarded`）。
- 加载 `qa`，保存非空结构化输出与 schema evidence，再用 `workflow-guard.mjs receipt` 铸造 `required-skill:verify.qa` receipt（scope: `main`，enforcement: `guarded`）。

## 增强调用

- 本节点没有 augmentation。

## 输出结构

- `comet.verify.v1`：必需证据 `verification-commands`、`verification-result`；必需 artifact 无。
- `gstack.verify.ordered-quality-gates.v1`：必需证据 `verification-gate-run-id`、`verification-gate-passed`、`verification-gate-completed-at`、`verification-gate-code-state-hash`、`verification-gate-draft-hash`、`qa-run-id`、`qa-completed-at`、`qa-code-state-before-hash`、`qa-code-state-after-hash`、`qa-draft-hash`、`qa-after-verification-gate`、`qa-code-modified`、`qa-new-commit-created`、`qa-fix-required`、`verify-evidence-validity`、`remediation-return-node`、`ordered-gates-rerun-after-remediation`；必需 artifact `ordered-verify-gates-report`。

## 证据记录

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs context

node comet-gstack-quality-gates/scripts/workflow-state.mjs record verify '{"summary":"record the real Node result","schemaEvidence":{}}'
node comet-gstack-quality-gates/scripts/workflow-guard.mjs receipt verify verification-gate <structured-execution-report.json>
node comet-gstack-quality-gates/scripts/workflow-guard.mjs receipt verify qa <structured-execution-report.json>
```

状态记录器不能铸造 Required Skill receipt。每个 guarded binding 都要保存结构化执行报告，包含 Node、Skill、change、status、开始/完成时间、当前 code hash、当前 draft hash、非空 `skillOutput` 与对应 `schemaEvidence`。普通 guarded binding 再执行上方 receipt 命令。receipt 的字段必须只覆盖该 Skill 负责的证据子集，并与 Node 最终证据和 Output Schema artifact 一致。禁止复用旧 code state 或旧 Bundle draft 的 hash。







## 守卫规则

- `verify-result`：按 `evidence-only` 校验。

## 退出检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs exit verify --apply
```

始终只遵循本次退出检查标准输出中的 `NEXT`、`NODE`、`SKILL` 动态路由。`build_mode`、`review_mode`、当前有效 Guard 证据和 remediation 都可能改变下一节点；不得按 protocol 数组顺序硬推后继，也不得复用旧输出。

## 恢复

依次运行 `node comet-gstack-quality-gates/scripts/workflow-state.mjs status` 与 `node comet-gstack-quality-gates/scripts/workflow-state.mjs next`。若 remediation 正在执行或可重试，按输出的 `RETRY`、`NODE`、`SKILL` 唯一路径继续；实际重试命令是 `node comet-gstack-quality-gates/scripts/workflow-guard.mjs retry-remediation <from>`。原 Classic `.comet.yaml` 是唯一控制状态。


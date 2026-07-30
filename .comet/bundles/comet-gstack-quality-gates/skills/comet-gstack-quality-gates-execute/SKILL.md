---
name: comet-gstack-quality-gates-execute
description: "仅在 /comet-gstack-quality-gates-execute 被显式调用或由 comet-gstack-quality-gates 路由选中时使用；完成 execute 节点并记录质量门证据。"
---

# Execute

## 节点目标

完成 `comet-gstack-quality-gates` 的 `execute` 节点。

职责：按 workflow protocol 完成 `execute` 节点并留下可验证证据。

## 操作指引

### 前置条件

- 当前计划可执行，`review` 可解析；缺失时停止并报告依赖，不能以自我检查替代 required review。
- 每次进入或因 remediation 重返 execute，都把当前代码与 draft 视为一个新的实现批次；只为当前批次建立 inventory，不借用旧批次 manifest、receipt 或 artifact。

### 步骤

1. 保留 `comet-build` 的原有实现流程。完成当前批次的实现后，为所有已完成实现段分配稳定且唯一的 segment id；不要用一份总评替代分段。
2. 在 mint 本批第一张 review receipt 之前，运行 `workflow-guard.mjs context`，生成位于 run root 内的 `implementation-segments.json`，明确写入 `node: execute`、当前 change、完整且非空的 `segmentIds`、当前 `codeStateHash` 和 `draftHash`。这一步是 runtime 承认的初始 manifest 声明边界：实现段集合已确定，但逐段 review 尚未开始。
3. 运行 `workflow-guard.mjs segment-register execute <implementation-segments.json>`。runtime 会校验 current route 与 context，封存 manifest 路径、SHA、完整 segment 集合和 inventory id，并把同一集合写入 execute evidence。同一 code/draft 下已封存集合不能缩减、改写；后续 `workflow-state.mjs record` 也不能改变它。若代码在封存后变化，旧 inventory、receipt 与 artifact 即失效；待新代码稳定后，必须在第一张新 review receipt 前按新 context 重新声明并封存 manifest。
4. 对封存集合中的每个 segment 分别加载 `review`。每份结构化 report 只能投影一个当前 segment id，记录真实审查输出、blocker 处置、当前 change/code/draft/protocol 与真实起止时间；再运行 `workflow-guard.mjs receipt execute review <report.json>` mint 唯一 receipt。不得自行填写 `completedChecks`。
5. 为每个 segment 生成独立结构化 Output Schema artifact，artifact 必须携带该 segment 的 schema evidence 和对应 report digest。Node evidence 中的 `implementation-segment-index` 必须与 sealed inventory 完全一致。
6. 运行 `workflow-guard.mjs exit execute --apply`。Exit Check 会做一一映射：sealed manifest 中每个 segment 恰好对应一张当前 review receipt 和一个绑定同一 report digest 的 artifact；遗漏、重复 segment、重复 digest、清单外 segment、hash 漂移或 blocker 未处置都会阻断。通过后只按当前输出的 `NEXT:`、`NODE:`、`SKILL:` 继续。

### 完成判定

execute 完成不是“存在 review”，而是当前 code/draft 的 sealed manifest 已在第一张 review receipt 前声明，且 manifest 中每个 segment 与 review report、receipt、artifact 形成严格双射。代码或 draft 变化会建立新的 context 边界，旧批次记录只保留审计，不能支持当前推进。

### 红旗

- 先 mint review receipt，之后才补写或缩小 manifest。
- 用一个 receipt、同一 report digest 或一份总 artifact 覆盖多个 segment。
- `implementation-segment-index` 与 sealed inventory 不一致，或包含清单外 segment。
- 封存后改代码却沿用旧 inventory、receipt 或 artifact。
- 自填 `completedChecks`，或只在对话中声称 review 已完成。

## 入口检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs entry execute
```

## Skill 实现

加载 `comet-build` 执行本节点，operation 为 `default`。

## 必需 Skill 调用

- 加载 `review`，保存非空结构化输出与 schema evidence，再用 `workflow-guard.mjs receipt` 铸造 `required-skill:execute.review` receipt（scope: `review`，enforcement: `guarded`）。

## 增强调用

- 本节点没有 augmentation。

## 输出结构

- `comet.execution-evidence.v1`：必需证据 `implementation-summary`、`test-evidence`；必需 artifact `task-state`。
- `gstack.execute.segment-review.v1`：必需证据 `implementation-segment-index`、`review-per-segment`、`segment-code-state-hash`、`segment-review-blockers-resolved`；必需 artifact `segment-review-reports`。

## 证据记录

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs context
node comet-gstack-quality-gates/scripts/workflow-guard.mjs segment-register execute <implementation-segments.json>
node comet-gstack-quality-gates/scripts/workflow-state.mjs record execute '{"summary":"record the real Node result","schemaEvidence":{}}'
node comet-gstack-quality-gates/scripts/workflow-guard.mjs receipt execute review <structured-execution-report.json>
```

状态记录器不能铸造 Required Skill receipt。每个 guarded binding 都要保存结构化执行报告，包含 Node、Skill、change、status、开始/完成时间、当前 code hash、当前 draft hash、非空 `skillOutput` 与对应 `schemaEvidence`。普通 guarded binding 再执行上方 receipt 命令。receipt 的字段必须只覆盖该 Skill 负责的证据子集，并与 Node 最终证据和 Output Schema artifact 一致。禁止复用旧 code state 或旧 Bundle draft 的 hash。

开始逐段 review 前，先用当前 context hash 生成完整 segment manifest，并执行 `segment-register` 封存 inventory。封存后同一 code/draft 下不得缩减或改写 segment 集合。





## 守卫规则

- `build-complete`：按 `semantic` 校验。

## 退出检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs exit execute --apply
```

始终只遵循本次退出检查标准输出中的 `NEXT`、`NODE`、`SKILL` 动态路由。`build_mode`、`review_mode`、当前有效 Guard 证据和 remediation 都可能改变下一节点；不得按 protocol 数组顺序硬推后继，也不得复用旧输出。

## 恢复

依次运行 `node comet-gstack-quality-gates/scripts/workflow-state.mjs status` 与 `node comet-gstack-quality-gates/scripts/workflow-state.mjs next`。若 remediation 正在执行或可重试，按输出的 `RETRY`、`NODE`、`SKILL` 唯一路径继续；实际重试命令是 `node comet-gstack-quality-gates/scripts/workflow-guard.mjs retry-remediation <from>`。原 Classic `.comet.yaml` 是唯一控制状态。


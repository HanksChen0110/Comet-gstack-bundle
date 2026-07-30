---
name: comet-gstack-quality-gates-plan
description: "仅在 /comet-gstack-quality-gates-plan 被显式调用或由 comet-gstack-quality-gates 路由选中时使用；完成 plan 节点并记录质量门证据。"
---

# Plan

## 节点目标

完成 `comet-gstack-quality-gates` 的 `plan` 节点。

职责：按 workflow protocol 完成 `plan` 节点并留下可验证证据。

## 操作指引

### 前置条件

- design 的持久化证据与确认仍有效，当前 change 没有因修订回退到 design。
- 本节点继续委托 `comet-build` 的计划产出语义，不改写它的 implementation。

### 步骤

1. 调用 `comet-build` 形成可执行计划与任务契约。
2. 将计划产物与计划摘要按本节点既有证据规则记录，并确认计划没有把质量门伪装成可选建议。
3. 若计划不能对应已确认设计或任务不可执行，留在 plan 修订；完成后只依据 runtime 的 `NEXT:` 和 `SKILL:` 衔接。

### 完成判定

计划真正完成是后续执行者能据此实施并对照证据，而不是仅存在一个计划文件。设计不一致、任务含糊或产物无法读取时继续修订，不提前进入 execute。

### 红旗

- 为了尽快实施而跳过计划与设计的对应关系。
- 在本节点重新定义 `comet-build` 的执行实现。
- 未读取 runtime 输出就凭阶段名称跳转。

## 入口检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs entry plan
```

## Skill 实现

加载 `comet-build` 执行本节点，operation 为 `default`。

## 必需 Skill 调用

- 本节点没有额外 Required Skill Call。

## 增强调用

- 本节点没有 augmentation。

## 输出结构

- `comet.plan.v1`：必需证据 `producer-summary`；必需 artifact `implementation-plan`。

## 证据记录

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs context

node comet-gstack-quality-gates/scripts/workflow-state.mjs record plan '{"summary":"record the real Node result","schemaEvidence":{}}'

```

状态记录器不能铸造 Required Skill receipt。每个 guarded binding 都要保存结构化执行报告，包含 Node、Skill、change、status、开始/完成时间、当前 code hash、当前 draft hash、非空 `skillOutput` 与对应 `schemaEvidence`。普通 guarded binding 再执行上方 receipt 命令。receipt 的字段必须只覆盖该 Skill 负责的证据子集，并与 Node 最终证据和 Output Schema artifact 一致。禁止复用旧 code state 或旧 Bundle draft 的 hash。







## 守卫规则

- `plan-artifacts`：按 `artifact-structured` 校验。

## 退出检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs exit plan --apply
```

始终只遵循本次退出检查标准输出中的 `NEXT`、`NODE`、`SKILL` 动态路由。`build_mode`、`review_mode`、当前有效 Guard 证据和 remediation 都可能改变下一节点；不得按 protocol 数组顺序硬推后继，也不得复用旧输出。

## 恢复

依次运行 `node comet-gstack-quality-gates/scripts/workflow-state.mjs status` 与 `node comet-gstack-quality-gates/scripts/workflow-state.mjs next`。若 remediation 正在执行或可重试，按输出的 `RETRY`、`NODE`、`SKILL` 唯一路径继续；实际重试命令是 `node comet-gstack-quality-gates/scripts/workflow-guard.mjs retry-remediation <from>`。原 Classic `.comet.yaml` 是唯一控制状态。


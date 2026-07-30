---
name: comet-gstack-quality-gates-design
description: "仅在 /comet-gstack-quality-gates-design 被显式调用或由 comet-gstack-quality-gates 路由选中时使用；完成 design 节点并记录质量门证据。"
---

# Design

## 节点目标

完成 `comet-gstack-quality-gates` 的 `design` 节点。

职责：按 workflow protocol 完成 `design` 节点并留下可验证证据。

## 操作指引

### 前置条件

- `comet-open` 已留下可恢复的单一 change 状态，设计范围未被后续实现改动取代。
- `autoplan` 可解析；不可解析时报告依赖缺失，不以普通讨论替代四视角审查。

### 步骤

1. 由 `comet-design` 产出原有设计与 OpenSpec 上下文；本节点只补充质量门，不复制其设计流程。
2. 在设计准备交由用户确认前加载 `autoplan`，完成 CEO、engineering、design、DX 四个视角，并将每个结论、阻断项处置、当前 change 与当前 draft hash 写入结构化 execution report。把报告交给 Auto 区 guard 记录真实调用结果并 mint receipt；不得自行填写 `completedChecks` 冒充已调用。
3. 有阻断项时留在 design 修订；四视角都完整且阻断项已处置后，保留 Classic 的设计确认语义。
4. 仅在 guard 通过且 runtime 输出 `NEXT: auto` 时使用输出中的 `SKILL:` 继续。

### 完成判定

设计完成须同时满足设计产物可审查、四视角审查属于当前 change/当前 draft、所有阻断项已处置，且结构化报告已产生有效 receipt。清单已走完但视角缺失、draft 已变或用户尚未完成原有确认，均不能推进。

### 红旗

- 用一次泛泛评审替代四个视角。
- 沿用旧 draft 的审查结论。
- 自填 `completedChecks`，或用口头结论替代结构化报告和 guard receipt。
- 把 guard 通过误解为可以省略 Classic 的用户设计确认。

## 入口检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs entry design
```

## Skill 实现

加载 `comet-design` 执行本节点，operation 为 `default`。

## 必需 Skill 调用

- 加载 `autoplan`，保存非空结构化输出与 schema evidence，再用 `workflow-guard.mjs receipt` 铸造 `required-skill:design.autoplan` receipt（scope: `main`，enforcement: `guarded`）。

## 增强调用

- 本节点没有 augmentation。

## 输出结构

- `comet.design.v1`：必需证据 `design-summary`、`user-confirmation`；必需 artifact `design-doc`、`delta-spec`。
- `gstack.design.autoplan-review.v1`：必需证据 `autoplan-run`、`ceo-review`、`engineering-review`、`design-review`、`dx-review`、`design-draft-hash`、`design-blockers-resolved`；必需 artifact `autoplan-review-report`。

## 证据记录

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs context

node comet-gstack-quality-gates/scripts/workflow-state.mjs record design '{"summary":"record the real Node result","schemaEvidence":{}}'
node comet-gstack-quality-gates/scripts/workflow-guard.mjs receipt design autoplan <structured-execution-report.json>
```

状态记录器不能铸造 Required Skill receipt。每个 guarded binding 都要保存结构化执行报告，包含 Node、Skill、change、status、开始/完成时间、当前 code hash、当前 draft hash、非空 `skillOutput` 与对应 `schemaEvidence`。普通 guarded binding 再执行上方 receipt 命令。receipt 的字段必须只覆盖该 Skill 负责的证据子集，并与 Node 最终证据和 Output Schema artifact 一致。禁止复用旧 code state 或旧 Bundle draft 的 hash。







## 守卫规则

- `design-artifacts`：按 `artifact-structured` 校验。

## 退出检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs exit design --apply
```

始终只遵循本次退出检查标准输出中的 `NEXT`、`NODE`、`SKILL` 动态路由。`build_mode`、`review_mode`、当前有效 Guard 证据和 remediation 都可能改变下一节点；不得按 protocol 数组顺序硬推后继，也不得复用旧输出。

## 恢复

依次运行 `node comet-gstack-quality-gates/scripts/workflow-state.mjs status` 与 `node comet-gstack-quality-gates/scripts/workflow-state.mjs next`。若 remediation 正在执行或可重试，按输出的 `RETRY`、`NODE`、`SKILL` 唯一路径继续；实际重试命令是 `node comet-gstack-quality-gates/scripts/workflow-guard.mjs retry-remediation <from>`。原 Classic `.comet.yaml` 是唯一控制状态。


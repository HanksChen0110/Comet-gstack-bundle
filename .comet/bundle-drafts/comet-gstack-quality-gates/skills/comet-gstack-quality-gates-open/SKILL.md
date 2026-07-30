---
name: comet-gstack-quality-gates-open
description: "仅在 /comet-gstack-quality-gates-open 被显式调用或由 comet-gstack-quality-gates 路由选中时使用；完成 open 节点并记录质量门证据。"
---

# Open

## 节点目标

完成 `comet-gstack-quality-gates` 的 `open` 节点。

职责：按 workflow protocol 完成 `open` 节点并留下可验证证据。

## 操作指引

### 前置条件

- 当前请求已能关联到一个明确的 change；若没有 active change 或同时有多个 active change，先按持久化状态阻断并请用户选择，不能借对话历史猜测。
- 本节点保留 `comet-open` 的 intake 与 `.comet.yaml` 初始化语义；不要替换它的 implementation，也不要创建第二份 overlay 状态。

### 步骤

1. 调用 `comet-open` 完成原有 intake，并只从选定 change 的 `.comet.yaml` 读取或初始化状态。
2. 将用户意图、change 归属和初始化结果记录为本节点证据；保留已有 control 字段与其他节点 implementation。
3. 让运行时读取持久化状态并输出 `NEXT:`；只有输出为 `NEXT: auto` 时才按同一输出的 `SKILL:` 衔接，不能自行推断下一节点。

### 完成判定

真正完成不是“已听到需求”，而是当前 change 的状态已可被另一设备重新读取，且 intake evidence 与状态文件一致。缺少唯一 change、状态损坏或初始化证据缺失时停留本节点；不要以创建临时 run 文件冒充恢复能力。

### 红旗

- 因为用户说过 change 名称就跳过 `.comet.yaml` 对账。
- 多个 active change 时悄悄选择最近一个。
- 把本节点当作改写 Classic control implementation 的入口。

## 入口检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs entry open
```

## Skill 实现

加载 `comet-open` 执行本节点，operation 为 `default`。

## 必需 Skill 调用

- 本节点没有额外 Required Skill Call。

## 增强调用

- 本节点没有 augmentation。

## 输出结构

- `comet.intake.v1`：必需证据 `intake-summary`；必需 artifact `comet-state`。

## 证据记录

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs context

node comet-gstack-quality-gates/scripts/workflow-state.mjs record open '{"summary":"record the real Node result","schemaEvidence":{}}'

```

状态记录器不能铸造 Required Skill receipt。每个 guarded binding 都要保存结构化执行报告，包含 Node、Skill、change、status、开始/完成时间、当前 code hash、当前 draft hash、非空 `skillOutput` 与对应 `schemaEvidence`。普通 guarded binding 再执行上方 receipt 命令。receipt 的字段必须只覆盖该 Skill 负责的证据子集，并与 Node 最终证据和 Output Schema artifact 一致。禁止复用旧 code state 或旧 Bundle draft 的 hash。







## 守卫规则

- `comet-state-created`：按 `state-transition` 校验。

## 退出检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs exit open --apply
```

始终只遵循本次退出检查标准输出中的 `NEXT`、`NODE`、`SKILL` 动态路由。`build_mode`、`review_mode`、当前有效 Guard 证据和 remediation 都可能改变下一节点；不得按 protocol 数组顺序硬推后继，也不得复用旧输出。

## 恢复

依次运行 `node comet-gstack-quality-gates/scripts/workflow-state.mjs status` 与 `node comet-gstack-quality-gates/scripts/workflow-state.mjs next`。若 remediation 正在执行或可重试，按输出的 `RETRY`、`NODE`、`SKILL` 唯一路径继续；实际重试命令是 `node comet-gstack-quality-gates/scripts/workflow-guard.mjs retry-remediation <from>`。原 Classic `.comet.yaml` 是唯一控制状态。


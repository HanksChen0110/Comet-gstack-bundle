---
name: comet-gstack-quality-gates
description: "在 Comet Classic 中先确认当前 OpenSpec 规则与预算，再执行限额开发、完整 diff 审查、按场景验证和归档。"
---

# Comet + gstack 限额工作流

此 Bundle 叠加在 Comet Classic 的 `open → design → build → verify → archive` 上。`.comet.yaml` 仍是唯一控制状态，`reference/workflow-protocol.json` 是节点、输出结构与守卫契约。不要创建第二套 change 状态，不改历史 change。

## 启动与开工确认

运行 `workflow-state.mjs status` 和 `workflow-state.mjs next`，按同一次输出进入节点。open/design 可完善 OpenSpec；首次进入 plan 前按 `reference/start-approval.md` 对当前规格、项目规则与整次预算取得一次明确确认。后续节点及恢复会话只校验这份确认，不重复询问。仅在目标、范围、适用规则或验收场景实质变化，或整次预算真正耗尽时重新确认。未确认、规则冲突、关键未知项或规格漂移时停止代码、测试与审查，保存简短交接。现有 Comet 产物确认继续保留，不能以“推荐决定已预授权”代替这次确认。

新 change 默认整次预算 4 小时、1 轮实现返工，单条测试命令 10 分钟；不是每个阶段重开预算，已确认 change 沿用原截止时间。证据格式、CLI 路由和状态记录的纠错不算实现返工，也不触发重新确认。项目 AGENTS.md 要求完整回归时仍执行或先请用户修改规则。相同代码、规格与命令的通过证据可复用。长会话恢复只读落盘状态与摘要，不继续携带旧聊天全文。

## 节点职责

| 节点 | 工作 |
| --- | --- |
| open/design | 澄清目标、非目标、规则来源、未知项与验收场景，检查 OpenSpec 产物间矛盾；记录当前版本确认。 |
| plan | 用现有 `comet-build` 计划，列受影响检查、场景与预算。 |
| execute/subagent-execute | 实现当前任务，运行受影响的批准检查；不封存逐段清单、不逐段审查。 |
| review | 使用 `requesting-code-review` 对当前完整 diff 审查一次并绑定代码与规格摘要；高风险才做独立第二审。 |
| verify | 用 `verification-gate` 按批准场景做最终验证；网页任务另做只读 QA 并记录报告，文档任务不运行浏览器 QA。 |
| archive | 重新检查当前 verify Guard、receipt、报告摘要、artifact 快照和开工确认，再调用原 `comet-archive` 的用户确认与归档事务；`health` 非默认必需。 |

QA 发现问题只报告，回 build 做定向修复和复测；不得让 QA 自动改码、提交并重新启动全链循环。达到预算或返工上限时运行 `workflow-policy.mjs handoff <进度、证据、下一步>`，等新的预算确认。

## 证据与恢复

普通 Node 证据由 `workflow-state.mjs record` 保存。必需 Skill 的真实报告由 `workflow-guard.mjs receipt` 铸造 receipt；review/verify 的 receipt 原件与引用其 SHA-256 的 Output Schema 汇总文件分开保存，避免自引用摘要。每个节点离开前运行 `workflow-guard.mjs exit <node> --apply`；归档前先运行 `workflow-guard.mjs authorize archive`。只按 Guard 当次给出的 `NEXT/NODE/SKILL` 路由。Guard 的代码/draft/规格/规则与 artifact 失效检查不可绕过。归档内部 confirm/prepare/finalize/recover 仍由 Classic runtime 处理，Agent 不手工调用。

同一项目内的 Classic `comet check` 与 overlay Guard 必须使用同一版 `comet` CLI；Windows 下应确认 `comet.cmd` 的 PATH 指向项目选定版本。Classic 的检查输入按命令真实读取的文件声明在项目级 `.comet/check-policy.json`，否则新增审查报告也可能让默认全树输入失效并重复测试。此策略只声明真实依赖，不能漏掉影响结果的文件或环境。

当前节点、预算、已执行命令、审查与 QA 记录均写在项目 `.comet/workflow-evidence/<change>/`。换会话先运行 `workflow-policy.mjs check`、`workflow-state.mjs status` 与 `next`，再读取短交接；不要重跑同一摘要下已通过的命令或审查。

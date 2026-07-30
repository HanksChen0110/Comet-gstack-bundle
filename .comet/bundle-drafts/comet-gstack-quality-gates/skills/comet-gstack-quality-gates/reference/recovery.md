# 恢复规则

本文件严格拆分两类 scope：A 是 Bundle authoring/publishing lifecycle（Creator proposal、eval workload、publish approval、install approval）；B 是生成后的 workflow runtime（change/.comet.yaml、design/verify/archive）。A 永远不是 runtime entry 首次调用的前提：runtime 输入清晰即自动 init/恢复；Creator 确认只约束 creator init/generate。B 的真实 runtime decisions 由当前 Classic Node skill 处理并持久化；NEXT: manual 仅是无选项交接，唯一 remediation 为 auto。

## 确定性恢复

1. 重新读取 Creator state 或当前 change 的 `.comet.yaml`、phase、completed Nodes、guard 结果、artifacts、evidence、当前代码状态 hash、draft hash 与已持久化用户选择；不信任对话或设备记忆。
2. 用实际文件和 hash 对账。状态称完成但 artifact 缺失、所属 change 不同、顺序失真、blocker 未处置或 hash 不同，即视为未完成/过期；记录精确失效原因，不制造 PASS。
3. 显示恢复摘要：当前阶段、阻塞原因、建议的唯一下一步、有效 evidence、以及仅在当前仍合法的用户选项。仍有效的 Creator 确认、设计确认、branch rebind、verify 例外、归档交付、eval 和安装选择必须复用，不重复询问。
4. 只有持久化选择失效，或新出现两个以上互斥合法选项，才回到 `reference/decision-points.md` 的对应暂停。

## verify 与 QA

- qa 只能在当前代码状态和当前 draft 的 `verification-gate` 已通过、已记录后运行；缺任一条件即从缺失 gate 恢复，不能先跑 qa。
- qa 改码、创建提交或报告待修复问题时，立即记录 `verify-evidence-validity: invalidated` 与 `remediation-return-node: execute`，保留旧 evidence 审计但拒绝 archive。
- 之后确定性执行 `execute → review`：修复、段审查和 Codex review 都对新状态完成后，完整重跑 `verification-gate → qa`。未完成 rerun 不得进入 archive。
- run id 缺失、时间顺序反转、代码/draft hash 不同或 blocker 未处置同样无效；不得由用户批准跳过。前三次可修复 verify failure 自动回 build，超限时仅恢复到继续修复/停止寻求外部决策的真实选择。

## archive、eval 与交付

- archive 前先核验有效 verify，再核验 health 在真正 archive 动作前针对当前代码运行，且有复合分、分项、跨 change 趋势与 blocker 处置。health 缺失/过期/不完整保持停止状态，不显示归档确认。
- health 有待修复发现时确定性回 `execute → review → verify`，完成后重新 health；通过后才恢复 archive 确认。已持久化的 archive 交付若失败，只能重试同一 push/PR，不得改选分支、交付方式或删除历史。
- eval evidence 必须属于当前 draft hash；skip、失败或过期时保持 not-ready。若存在已选 quick/full 且证据有效，恢复直接复用；只有其失效或选择未持久化时重新展示三档选择。
- publish 与安装均不能从既有选择自动授权：恢复时若 approval 未持久化，停在对应人工批准；安装先恢复 preview，再等待明确安装批准。

## 停止与手动衔接

- Skill 不可解析、state 损坏、artifact 不可读或 guard 无安全恢复边时，停在当前 Node，报告缺失项、已做诊断和恢复前提；不编造选项。
- `NEXT: manual` 时保留 state，显示 runtime `HINT`、稳定 BLOCKED 原因、完成 evidence 和接手动作后结束当前调用。
- 跨设备恢复只依赖持久化 state、artifact、hash、evidence 和选择；不依赖会话上下文。

## 恢复风险

最大风险是 QA、review、health 或 draft 变化后仍复用旧结论。任何状态、artifact 或 hash 冲突都按失效处理并重验，宁可重复门禁也不复用旧证据。

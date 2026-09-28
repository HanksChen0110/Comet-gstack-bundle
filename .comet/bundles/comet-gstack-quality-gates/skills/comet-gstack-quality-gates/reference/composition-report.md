# 组合记录

此 Bundle 保留 Comet Classic 的 open、design、build、verify、archive 状态及原节点实现。design 对 OpenSpec 和规则做只读矛盾检查，不默认调用 autoplan；build 取消逐段 review 清单；review 对当前完整 diff 只调用一次 requesting-code-review，高风险才加独立第二审；verify 必须有 verification-gate 当前证据，浏览器 QA 只在网页任务按批准场景只读执行；archive 不固定调用 health，但重验当前 verify 证据和 artifact 快照。

开工确认、预算、检查缓存与网页 QA 记录由 workflow-policy.mjs 写在当前 change 的 workflow-evidence 目录。workflow-guard.mjs 在节点边界核对规格、规则、预算和证据，且不替换 Classic 状态机。详见 workflow-protocol.json 与 start-approval.md。

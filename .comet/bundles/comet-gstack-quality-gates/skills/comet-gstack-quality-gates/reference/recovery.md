# 恢复

从新会话读取项目 .comet.yaml、workflow-state.mjs status/next 和 .comet/workflow-evidence/<change>/start-approval.json。先运行 workflow-policy.mjs check；如果预算耗尽仍可调用 handoff 保存进度，续跑需要新预算确认。不要把整晚对话重新放入上下文。

规格、项目规则、代码、Bundle draft 或报告 artifact 变化时，重新验证对应摘要与 Guard。相同代码、规格和命令的有效通过检查直接复用；完整 diff 有有效 review receipt 时不重复审查。任何失效只补做受影响的检查与报告。

网页 QA 只读报告问题。需修复时在允许的一轮预算内回 build 定向处理，再按批准场景复测；不让 QA 自动改码、提交或启动全链循环。第二轮失败、无实质进展或时间预算到限，保存失败项、当前代码/规格摘要、已执行命令、审查调用数、返工次数与下一步并暂停。

archive 恢复沿用 Classic 的 pending action、journal、lease 和同一 attempt 安全重试。先重算当前 verify Guard、receipt、report digest 和 artifact 快照；质量漂移会撤销旧授权。OpenSpec 已成功移动 change 但 finalize 中断时只恢复 finalize，不重跑归档。

# Comet gstack Bundle 仓库约定

## 范围

- 本仓库只发布 `comet-gstack-quality-gates` Bundle、使用说明和维护规则。
- Bundle 真源位于 `.comet/bundles/comet-gstack-quality-gates/`。
- 不加入具体项目的 change 状态、评估日志、密钥或业务源码。

## 修改

- 保留 Comet Classic 原状态机和节点 implementation。
- 质量能力通过现有 OpenSpec 产物、Output Schema、证据账本与 Guard 叠加，不创建第二套 change 状态。
- 实现前必须有绑定当前规格摘要的开工确认，写明目标、非目标、规则来源、未知项、验收场景、任务类型、验证命令与预算。关键未知项或规则冲突未解决时停止。
- 一次开工确认覆盖该 change 在预算内的全部节点与恢复会话；节点入口只校验原确认仍有效，不逐阶段请用户重复确认。仅当目标、范围、适用规则或验收场景实质变化，或预算实际耗尽时重新确认。证据格式、CLI 路由和已批准实现内的定向修复由 Agent 自行处理。
- 新 change 默认总预算为 4 小时、1 轮实现返工；单条测试命令默认 10 分钟上限。已确认 change 沿用自己的原预算。预算真正耗尽时保存证据并暂停，续跑需要新的预算确认。
- 普通 change 对当前完整 diff 只审一次；高风险 change 才启用独立第二审。相同代码与规格摘要下复用已通过的证据。
- build 只跑受改动影响的检查；verify 按已批准场景验证。文档任务不运行网页 QA；网页任务只读检查核心流程与受影响页面。QA 报告问题后由实现阶段定向修复。
- `qa` 和 `health` 不作为所有 change 的固定必需项。归档仍须检查当前规格、代码、验证证据及其失效状态；项目 AGENTS.md 要求的完整回归不得静默跳过。
- 不使用 `--overwrite` 覆盖用户已有 Skill。
- `scripts/` 仅放 Bundle 维护辅助工具；评测交接与外部结果保存在被忽略的 `.comet/eval-handoffs/`，不得进入分发 Bundle。交接必须绑定当前 draft 与 eval manifest 摘要，结果校验只核对证据一致性，不代替 Comet 原生 eval 判定。
- 订阅账号 Agent 可按交接文件做独立场景评审，结果标为 `external-agent`；它不是 Comet 官方 eval，不能伪装成 `comet-eval` 或直接解锁原生 ready。
- 本机订阅 Agent 可调用时，由维护脚本直接读取当前请求、发起只读评审、写回结果并校验；用户不负责复制交接文件。外部 Agent 不可用或证据不足时留 `blocked` 结果和简短交接。
- 活跃 change 的直接文件写工具应在 Hook 层检查当前开工确认；open/design 阶段仍允许完善规格。Shell 等无法可靠判定写入意图的工具继续由节点守卫和 `run-check` 约束，不宣称任意工具写入都被 Hook 拦截。

## 验证

- 运行 `node .comet/bundles/comet-gstack-quality-gates/skills/comet-gstack-quality-gates/scripts/comet-check.mjs`。
- 在隔离项目验证开工门槛、预算、证据复用、文档与网页路径，并记录耗时、测试命令数、审查调用数、返工次数。
- Bundle authoring 重新生成并校验 ready；分发预览只在隔离副本进行，避免 CLI 改写真源元数据。
- 新版 Comet 先在隔离副本做 `--collect` 和受预算约束的正式评测；只有正式结果经 Comet 原生记录和审查通过，才能接入发布门。
- 提交前检查 `git diff --check`、敏感信息和目标文件清单。

## 发布

- README 使用中文，命令和文件路径保留英文。
- 本轮只做项目级试点；全局同步和 GitHub push 另行决定。

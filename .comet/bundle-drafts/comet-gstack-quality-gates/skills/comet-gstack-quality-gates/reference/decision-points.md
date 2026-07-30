# 决策点

先按四类处理候选节点：只有至少两个当前可执行、且会改变范围、行为、风险接受、分支归属或不可逆交付的选项才暂停；唯一安全路径自动处理；缺依赖或无恢复边是停止条件；`NEXT: manual` 只交还控制权。仍有效的持久化选择必须复用，不能以默认推荐、历史偏好或 `NEXT: auto` 绕过真正停顿。

本文件严格拆分两类 scope：A 是 Bundle authoring/publishing lifecycle（Creator proposal、eval workload、publish approval、install approval）；B 是生成后的 workflow runtime（change/.comet.yaml、design/verify/archive）。A 永远不是 runtime entry 首次调用的前提：只要 runtime 的 change、目标、范围与当前 phase 输入清晰，即自动 init/恢复；Creator 确认只约束 creator init/generate。B 的真实 runtime decisions 由当前 Classic Node skill 处理并持久化；NEXT: manual 仅是无选项交接，唯一 remediation 为 auto。

## 分类

| 候选节点 | 分类 | 处理 |
| --- | --- | --- |
| Creator 方案尚未确认 | 用户决策 | 展示 `confirm-generate`、`revise-proposal`、`cancel`；选择改变 Bundle 是否及如何生成。确认才可 init，修订回方案页，取消不生成草稿。 |
| 清晰的 change、目标、范围与当前 phase | 自动处理 | 初始化或恢复 `.comet.yaml`，进入第一个没有有效 Exit evidence 的 Node；不重复确认已知输入。 |
| design 可审查产物完成 | 用户决策 | 用户确认进入 plan、要求修订回 design，或取消 change；选择与理由写入 `comet.design.v1` 的 `user-confirmation` evidence。 |
| `bound_branch` 与当前分支不一致 | 用户决策 | 用户选择切回绑定分支，或明确让当前分支接管并 rebind；持久化后重新入口检查。不得自动切换或换绑。 |
| verify 的完整检查确认 delta spec 与 Design Doc 矛盾 | 用户决策 | 选择记录 `Implementation Divergence`、回 build 同步两份文档，或接受偏差继续 verify；理由和证据写入验证报告。 |
| WARNING/SUGGESTION 的修复会引入行为、范围或风险取舍 | 用户决策 | 选择修复或接受偏差；接受理由与影响范围写入验证报告。CRITICAL/IMPORTANT 与范围内明确可修复问题不可豁免。 |
| `verify_failures >= 3` 且又有可修复失败 | 用户决策 | 选择继续修复（记录下一次失败并回 build）或停止当前 workflow 并寻求外部决策；不得自动开始第 4 次修复。 |
| archive 入口已通过，verify 与当前 health evidence 均有效且无 blocker | 用户决策 | 选择归档并推送、归档/推送/创建 PR、调整或重新验证、暂不归档；仅前两项允许 `archive-confirm` 与不可逆归档。 |
| eval 计划已展示且 `skip`、`quick`、`full` 都可用 | 用户决策 | 用户选择工作量；选择和预计成本写入 eval evidence。`skip` 不是 ready、publish 或 distribute 的许可。 |
| publish/install 前 | 用户决策 | publish readiness 的人工 approval 与安装 preview 后的安装批准均需单独明确同意；拒绝或暂缓不写入、不安装。 |
| guard 缺证据、顺序错误、hash/draft 不匹配、`verification-gate` 未过或 qa 未运行 | 自动处理 | 读取稳定失败原因，补齐唯一协议允许的证据或恢复边；不询问是否跳过 guard。 |
| qa 改代码、创建提交或发现待修复问题 | 自动处理 | 立即令旧 verify evidence `invalidated`，按 `execute → review` 修复与审查；对新代码状态和当前 draft 完整重跑 `verification-gate → qa`。 |
| execute、handoff、Codex review 或 health guard 有未处置 blocker | 自动处理 | 走 protocol 的唯一 remediation 路径；health 的需修复发现回 `execute → review → verify` 后重新运行 health。 |
| archive 前 health 缺失、过期、不完整或不属当前代码状态 | 停止条件 | 停止 archive，报告缺少的复合分、分项、跨 change 趋势、hash 或 blocker 处置；不展示“仍归档”选项。 |
| 依赖 Skill 不可解析、state 损坏、artifact 不可读，或无安全恢复边 | 停止条件 | 报告具体缺失项、当前 Node、已做的只读诊断及恢复前提；不伪造选择。 |
| runtime 返回 `NEXT: manual` | 手动衔接 | 显示 `HINT`、当前 phase、有效 evidence、稳定 BLOCKED 原因和接手方动作，然后交还控制权；它不是确认点。 |

## 真正的用户停顿点

### Creator 方案确认

触发：方案页已列明 Node 职责、binding、Required Skill Call、Output Schema、enforcement、可执行披露和 readiness 影响，但尚未确认。

选项：`confirm-generate`（记录确认并进入 init/authoring）、`revise-proposal`（返回方案）、`cancel`（停止本次创建）。选择写入 Creator proposal-confirmation state；本 draft 已有有效确认时恢复不得重问。

### 设计确认与分支归属

设计确认触发于 design 的完整可审查产物；选项为确认进 plan、修订回 design、取消。分支冲突触发于入口 check 的 `bound_branch` 不一致；选项为切回绑定分支或明确 rebind 当前分支。两者都必须写入当前 change 的持久化 evidence/state 并重新执行相应入口检查。

### Verify 例外

规格漂移时可记录 `Implementation Divergence`、回 build 同步，或接受偏差继续；只有回 build 改变阶段。对于会产生真实取舍的 WARNING/SUGGESTION，可选择修复或接受并记录理由；`verify_failures >= 3` 时可选择继续修复或停止寻求外部决策。其余 guard 或质量失败不是用户风险选择：CRITICAL/IMPORTANT、范围内明确修复、前三次可修复失败、证据失效和 QA remediation 都自动按协议回退。

### 归档、eval 与安装

归档仅在当前 verify 和 health 通过后暂停：归档并推送、归档/推送/建 PR、调整或重新验证、暂不归档。前两项才可执行 `archive-confirm`；第三项回 verify；第四项保留 active change 与 `branch_status: pending`。

生成后且 eval 选择实际可用时，暂停让用户在 `skip`、`quick`、`full` 中选择；证据绑定当前 draft hash，skip/失败/过期一律阻止 ready。readiness 通过后，publish approval 与 preview 后安装 approval 是独立的人类决定，不能从 eval 或 archive 选择推断。

## 非暂停规则

- Required Skill Call 只在各自 Node 内执行，不能因入口提及而提前批量运行。
- QA 改码、新提交或 `fix-required` 必须让旧两门 verify evidence 失效；不得选择沿用旧证据。
- health 缺失是 archive 停止条件，不是接受风险的选项。
- `NEXT: manual` 是交接，不是用户确认。

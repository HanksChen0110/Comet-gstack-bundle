---
name: comet-gstack-quality-gates
description: "仅在显式调用 /comet-gstack-quality-gates 或由 Comet 恢复路由选中时使用；按质量门协议处理当前 change。"
---

# comet-gstack-quality-gates

## 决策核心

### 决策分类与决策点

### 权威状态、当前节点与恢复

Comet Classic 的 `openspec/changes/<change>/.comet.yaml` 和原 Node implementation 是唯一控制状态机；overlay sidecar 只保存 evidence、receipt、Guard result、invalidation、handoff、sealed segment inventory、archive authorization 与 archive claim，不覆盖 control Node，也不建立第二份主状态。

1. 每次进入或恢复都先运行 `workflow-state.mjs status` 查看当前 active change、Classic phase、remediation 与诊断信息。没有 active change 时进入永久 `/comet-classic`/`/comet-open`；多个 active changes 时只接受 `.comet/current-change.json` 中通过 `comet state select` 写入、符合 `comet.selection.v2`、`workflow: classic` 且仍指向 active change 的显式选择。缺少选择、JSON/Schema 损坏或选择已失效时必须阻断，不能猜最近一个。
2. 随后运行 `workflow-state.mjs next`。`status`、`next` 和 Classic hook 都调用同一内部 route resolver，把 `.comet.yaml`、当前有效 ledger Guard result 与适用的 remediation chain 联合计算成同一个 current Node；三者不一致表示 runtime 错误，必须阻断，不能任选一个继续。只加载同一次 `next` 输出中 `NEXT: auto` 对应的一个 `NODE:`/`SKILL:`。
3. 多个 invalidation 可以同时留在审计账本中。路由和 Guard 只绑定对当前 Node 适用的 chain，即 `from` 为该 Node 或 `invalidatedNodes` 包含该 Node；更新但无关的 invalidation 不得抢占路由，也不得污染当前 receipt/Guard result。`NEXT: retry-remediation` 时只执行同次输出的完整 `RETRY:`，由统一 resolver 保持同一 chain 与目标 Node。
4. `NEXT: manual` 或稳定 blocked 时报告证据、原因与唯一接手动作，不自行推进。artifact 缺失/被改写、receipt digest 改变、change/code/draft/protocol 漂移、前驱顺序错误或 blocker 未处置时，旧记录只保留审计，不能恢复为 PASS。

### 真实命令面

Agent 可直接运行的 overlay 命令是：

- `workflow-state.mjs status`、`workflow-state.mjs next`、`workflow-state.mjs record <node> <json>`。overlay 的 `init` 会明确拒绝；状态只能由 `/comet-open`/Classic 建立。
- `workflow-guard.mjs context`、`workflow-guard.mjs segment-register execute <segment-manifest.json>`、`workflow-guard.mjs receipt <node> <skill> <structured-report.json>`、`workflow-guard.mjs entry <node>`、`workflow-guard.mjs exit <node> --apply`、`workflow-guard.mjs retry-remediation <from>`、`workflow-guard.mjs authorize archive`。route 是 state/hook 的内部解析能力；不存在名为 `verify` 的 Guard PASS 子命令。
- handoff 对 Agent 只开放 `workflow-handoff.mjs request <node>` 与 `workflow-handoff.mjs accept <node> <structured-return-report.json>`。request stdout 会直接输出 `REQUEST_ID`、`REQUEST_DIGEST`、`HANDOFF_SCOPE` 和 `NODE`；把这四项原样交给子代理并写回 return report。不得靠诊断 `status`、直接 receipt、猜文件路径或手写 ledger 绕过 request/accept。

真实 Classic boundary 内部使用 `non-consuming confirmation boundary`、`pre-OpenSpec preparation boundary`、`post-OpenSpec finalization boundary`、`archived-postcondition recovery boundary` 与 `safe retry release boundary`，分别承担非消费确认、journal/lease prepare、成功终结、已移动 change 的崩溃恢复和失败释放；都不是 Agent 手工命令。

### Receipt、segment 与 verify 证据

`workflow-state.mjs record` 只能保存普通 Node evidence，不能写 Required Skill 资格；`completedChecks`、receipt 与 ledger 字段会被剥离。Required Skill 必须真实运行并生成结构化 report，再由 `receipt` 校验 current Node、binding、change、code/draft、起止时间、非空 `skillOutput`、schema 字段与 artifact 后 mint ledger receipt。handoff-guarded receipt 只能由 matching request 的 `accept` 内部 mint；request id/digest/scope 必须来自 request stdout。

每张 receipt 与 passed Guard result 都只绑定当前 Node 最新的适用 invalidation chain；如果没有适用 chain，就不得携带其他 chain id。这样 design 的自修复不会污染 execute，execute/subagent-execute 各自恢复时也不会被更新但无关的 invalidation 劫持。

execute 在当前实现批次代码稳定、且第一张逐段 review receipt 产生前，必须声明完整非空 `implementation-segments.json` 并运行 `segment-register` 封存。sealed inventory 在同一 code/draft 下不可缩减或改写；Exit Check 要求每个 manifest segment 与唯一 review receipt、唯一 report digest、独立 artifact 严格一一映射。代码或 draft 变化后必须按新 context 重新封存，旧批次只保留审计。

verify 把字段按 binding 分工：`verification-gate` 只提交 verification 字段，QA 提交其余字段并绑定前驱 receipt id/digest。两张 receipt、聚合 Node evidence 和同一 Output Schema artifact 联合通过后，`exit verify --apply` 会写入与它们、当前 hash、适用 chain 及 Required Output Schema artifact 规范路径/SHA-256 快照绑定的 passed Guard result；archive authorize 会把该 Guard result id、两张 receipt id、两份 report digest与 verify/health artifact snapshots 的排序后 `snapshotDigest` 作为当前 ledger snapshot。route、confirm 与 archive prepare 都会重读并复算；漂移先使对应 Guard result/authorization 失效，再由 validated route 与配置的 `onFailure` 输出 `NODE/SKILL`，而不是沿用旧完成状态或硬编码回退节点。

### Classic 边界、安全回退与原子 bypass

非 archive Node 的 `exit --apply` 先验证并记录 overlay Guard result。若同一 Classic phase 还有 overlay Node，只路由下一 Node；若是该 phase 最后一道 gate，才调用原 `comet guard <change> <phase> --apply`。直接运行 Classic guard 或 `comet state transition` 也不能绕过：真实 handler 在写 `.comet.yaml` 前使用与 `status`、`next` 相同的 route resolver 再执行 overlay 边界。

`verify-fail`、`archive-reopen`、`preset-escalate` 是安全的 backward events，不要求 forward exit gate；正常用户/Classic 回退可直接通过。remediation 若需要触发这些事件，会使用内部 30 秒、单次、精确绑定 change/event/protocol/invalidation transition/event cursor 的 bypass token。Classic boundary 通过原子 rename 抢占 token，并同时核对 ledger cursor/status；未知 cursor、过期、并发复用或第二次消费都会失败。每次 event 子进程返回后（包括 exit 0）都必须重读 `.comet.yaml` 并验证 `archive-reopen → verify` 或 `verify-fail → build` 的真实后置状态；未满足时保持 retry，不能标记 applied。该 token 只防 remediation 递归拦截，不是 Agent 或用户的绕过入口。

QA intake 报告改码、新提交或待修复问题时，会在 QA receipt mint 前立即把旧 evidence、receipt 与 Guard result 移入 invalidation 审计，并路由 execute。每个 Node 必须在自身最新适用 chain 下重做 sealed segment manifest/逐段 review、execute Guard、review receipt/Guard、`verification-gate → qa`。若 review 修复又产生更新 invalidation，execute/review切到新 chain，verify保留其最新适用的原 recovery anchor；不能用全局单一 chain覆盖嵌套恢复。只按统一 route 返回的 `NEXT:`、`NODE:`、`SKILL:` 或 `RETRY:` 继续。

### Archive 与真实用户决策

archive 的固定顺序是：当前 verify ledger 与 artifact snapshotDigest → health structured report/artifact/receipt 与 snapshotDigest → `authorize archive` → 加载原 `comet-archive` → 用户明确确认 → Classic `archive-confirm` 非消费检查 → 同一 pending action 的 owner-safe prepare → OpenSpec → 成功后同 action/token/attempt finalize → consumed。

`authorize` 把当前 change、canonical protocol/protocolHash、code/draft、health receipt/report digest、verify Guard/ordered receipts/report digests，以及 verify/health Required Artifact 的规范 path/SHA-256 列表和排序后 `snapshotDigest` 写入 authorization identity。相同当前快照的重复 authorize 幂等返回同一 token；快照变化会 revoke 旧 token 并签发新 generation。artifact A→B→A 时，恢复后的 A 必须取得 A2，原 A1 和 B 保持 revoked，不能因 SHA 再次相同而复活。

用户确认后，真实 Classic handler 为 pending action 使用稳定 action id，并以其 SHA-256 命名 transaction journal；journal 记录 authorization/action/attempt/status、prepare 进度和时间戳，是恢复真源。ownerId/ownerPid lease 保证 single-flight：live owner 存在时，即使 lease 时间已过，并发 loser 仍以 `in flight` 阻断；只有显式安全 release 或确认 owner PID 已死亡后才允许同一 action 接管。

OpenSpec 前的 prepare 按 journal 幂等对账 sidecar、token claim、boundary claim 与 evidence。四类任一步中断后，同一 action retry 只补缺失步骤，仍收敛到同一 prepared context。OpenSpec 非零 release lease供同一 pending action重试，但不 consumed。

OpenSpec 成功后，finalize以同一 token/action/attempt幂等终结sidecar、claims与transaction。若 change 已移动而 finalize 崩溃，Classic依据 archived postcondition + pending action调recover，先从journal恢复并finalize overlay，再完成Classic archived；不得重跑成功OpenSpec。Agent不直接调用这些内部命令，也不把journal/lease/claim当作已归档。


artifact 缺失、SHA 或 snapshotDigest 漂移时，先让对应 passed Guard result 或 authorization 失效，再让 `status`、`next` 与 hook 共用的 validated route 按实际 `onFailure` 输出唯一 `NODE/SKILL`；不得根据 artifact 类型自行推断或固定回退。尤其是 archive preflight 的任一 health、verify、artifact、receipt、SHA 或 snapshotDigest 失败都会应用 `archive-quality-blocked`，从 archive 路由到 execute。consume 质量失败只把当前 action/attempt 自己拥有的 canonical claims 退役为 failed audit并释放 lease；完成 `execute → review → verify → health → authorize` 后，fresh authorization 通过当前 preflight，同一 pending action 才可绑定 fresh attempt，旧 attempt 保留审计。非质量 journal/claim/I/O 错误只记录 lastError、释放 lease并保留原 attempt 的 same-action retry；不得触发质量回退或采用 health-only。非 archive Node 同样只服从当次实际输出。

只有至少存在两个合法选项时才停下来让用户决策，例如设计确认、真实范围/风险取舍和原 `comet-archive` 的不可逆确认。缺证据、hash 漂移、QA invalidation、顺序错误、确定性 remediation 与唯一合法下一步都不是绕过质量门的用户选项。

### Full eval 的真实性

full eval 必须读取当前生成目录的 `comet/eval.yaml`，在每个隔离临时 Git/change 中调用生成包的真实 `workflow-guard.mjs`，并只依据真实 exit code、stdout/stderr 与持久化 ledger 判定场景。`qa-before-verification-gate` 会真实建立 verification 与 QA receipts 的反转时间证据、物化 artifact，并在 Exit Check 的顺序语义规则阻断；`qa-modified-code-then-archive` 会先 mint 当前 verification-gate receipt、真实改动代码、提交 QA mutation intake触发 invalidation/execute route，再真实尝试 archive并被阻断。其余场景同样通过实际 receipt/exit/authorize 路径运行。场景名、普通 `completedChecks` 或手工构造的 eval result 都不算 evidence；draft 或 runtime hash 变化后必须重新执行并记录当前结果。

### 红旗

- `status`、`next` 或 hook 给出不同 Node 时任选其一继续，而不是按 runtime 错误阻断。
- 用更新但无关的 invalidation chain 替换当前 Node 的适用 chain，或把无 chain 的 receipt 绑定到别的 chain。
- 看到普通 Node evidence 就认为 Required Skill 已完成，忽略 ledger receipt、artifact 与 Guard result。
- 丢弃 handoff request stdout 的 digest/scope，再靠诊断 status 或猜文件补齐。
- 先做逐段 review 再补/缩小 manifest，或复用同一 receipt/report digest 覆盖多个 segment。
- QA invalidation 后在 verify 原地补证据，或复用旧 Guard result。
- 把安全 backward event 或内部原子 bypass 误当作公开绕过命令。
- artifact A→B→A 后复活 A1，或让失败竞争者改写非本 attempt owner 的 claim。
- 在 OpenSpec 前把 prepared 写成 consumed；OpenSpec 失败后另起 action/token/attempt，或跳过全量重验直接重跑。
- 手动运行内部 confirm/prepare/finalize，把非消费确认、prepared claim 或 failed audit 当成实际归档。
- 用场景描述、普通字段或手工 result 冒充 full eval 的真实 guard 执行证据。
### 本轮可执行性补强

- 当 Classic `review_mode` 为 `off`，QA 失效链仍由 overlay 强制保持 `execute → review → verification-gate → qa`，不会因 Classic 跳过 review 而死锁。
- 英文生成不仅无汉字，还为 execute sealed segments、verify predecessor receipt/digest 与 QA invalidation/off-mode 回退、archive live-owner/四步 journal/质量与操作性错误隔离/fresh-authorization rebind/崩溃恢复提供与中文等价的确定性 operator contract；handoff 只展示 request → accept → 后续 Exit Check。
- full eval 的倒序场景会真实形成 verification 与 QA 的反转时间证据后在 exit 阻断；QA 改码场景先形成完整有效的 verification evidence，再触发 invalidation、execute route 和 archive block。

- execute 与 subagent-execute 的 Exit Check 不使用协议数组硬编码后继；始终只按同一次 stdout 的 `NEXT/NODE/SKILL` 动态路由，因为 build_mode、review_mode 与 remediation 都可能改变合法下一步。


## 工作流节点

1. `comet-gstack-quality-gates-open`：处理 `open` 节点；Required Skill：无；Output Schema：`comet.intake.v1`。
2. `comet-gstack-quality-gates-design`：处理 `design` 节点；Required Skill：`autoplan`；Output Schema：`comet.design.v1`、`gstack.design.autoplan-review.v1`。
3. `comet-gstack-quality-gates-plan`：处理 `plan` 节点；Required Skill：无；Output Schema：`comet.plan.v1`。
4. `comet-gstack-quality-gates-execute`：处理 `execute` 节点；Required Skill：`review`；Output Schema：`comet.execution-evidence.v1`、`gstack.execute.segment-review.v1`。
5. `comet-gstack-quality-gates-subagent-execute`：处理 `subagent-execute` 节点；Required Skill：`review`；Output Schema：`comet.handoff.v1`、`gstack.subagent.handoff-review.v1`。
6. `comet-gstack-quality-gates-review`：处理 `review` 节点；Required Skill：`codex`；Output Schema：`comet.review.v1`、`gstack.review.codex-adversarial.v1`。
7. `comet-gstack-quality-gates-verify`：处理 `verify` 节点；Required Skill：`verification-gate`、`qa`；Output Schema：`comet.verify.v1`、`gstack.verify.ordered-quality-gates.v1`。
8. `comet-gstack-quality-gates-archive`：处理 `archive` 节点；Required Skill：`health`；Output Schema：`comet.archive.v1`、`gstack.archive.health-score.v1`。

## Skill 绑定

- `open`：原实现 `comet-open`（default）；Required Skill Call：无。
- `design`：原实现 `comet-design`（default）；Required Skill Call：`autoplan`。
- `plan`：原实现 `comet-build`（default）；Required Skill Call：无。
- `execute`：原实现 `comet-build`（default）；Required Skill Call：`review`。
- `subagent-execute`：原实现 `subagent-driven-development`（default）；Required Skill Call：`review`。
- `review`：原实现 `requesting-code-review`（default）；Required Skill Call：`codex`。
- `verify`：原实现 `comet-verify`（default）；Required Skill Call：`verification-gate`、`qa`。
- `archive`：原实现 `comet-archive`（default）；Required Skill Call：`health`。

## 运行与恢复

### 启动协议

1. 运行 `node comet-gstack-quality-gates/scripts/workflow-state.mjs status` 读取当前 active change。
2. 若没有 active change，使用 `/comet-open` 或固定入口 `/comet-classic` 创建或恢复。
3. 运行 `node comet-gstack-quality-gates/scripts/workflow-state.mjs next`，只加载返回的一个 Skill。

### 上下文恢复规则

- 每次恢复都重新执行启动协议，以文件与脚本输出为准，不依赖对话记忆判断当前节点。
- 若文件证据缺失或当前 code/draft 已漂移，把节点视为未完成并重新进入。
- 用户意图与 `next` 冲突时暂停并确认，不静默切换节点。

### 节点边界规则

- 非 archive 节点离开前运行 `node comet-gstack-quality-gates/scripts/workflow-guard.mjs exit <node> --apply`；只有 overlay 质量门通过后，原 Classic guard 才能推进 phase。
- Guard 返回唯一的 `NODE`、`SKILL` 或 `REMEDIATION_NODE` 时只沿该路径继续。
- 可用恢复命令包括 `workflow-state.mjs status`、`workflow-state.mjs next` 与 `workflow-guard.mjs retry-remediation <from>`。
- 普通 Node 证据由 `workflow-state.mjs record` 记录；Required Skill receipt 只能由 `workflow-guard.mjs receipt` 铸造；handoff 使用 `workflow-handoff.mjs request/accept`。
- archive 节点先完成 health 并执行 authorize，再加载原 archive delegate。归档事务边界由 Classic runtime 内部处理：它把单一 attempt 绑定到当前 pending action，运行 OpenSpec，并只在成功后协调授权状态。Agent 不调用任何内部归档事务命令。失败 attempt 只能由同一 pending action 在重新校验后重试，其他 action、token 或 attempt 不能接管。

路由、Output Schema、Required Skill Call 与恢复状态以 `reference/workflow-protocol.json` 为准。

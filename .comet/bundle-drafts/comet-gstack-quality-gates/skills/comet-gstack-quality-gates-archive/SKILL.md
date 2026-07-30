---
name: comet-gstack-quality-gates-archive
description: "仅在 /comet-gstack-quality-gates-archive 被显式调用或由 comet-gstack-quality-gates 路由选中时使用；完成 archive 节点并记录质量门证据。"
---

# Archive

## 节点目标

完成 `comet-gstack-quality-gates` 的 `archive` 节点。

职责：按 workflow protocol 完成 `archive` 节点并留下可验证证据。

## 操作指引

### 前置条件

- Classic 已进入 archive phase；统一 validated route 已确认当前 Node 为 archive，且当前 verify ledger 快照包含 passed Guard result、按序的 `verification-gate`/`qa` receipts、report digests、Required Output Schema artifact 的规范路径/SHA-256 快照及其 `snapshotDigest`，并仍匹配当前 change、code/draft/protocol 与适用 remediation chain。
- `health` 可解析；原 `comet-archive` 的用户确认、delta 同步、pending action checkpoint 和实际 OpenSpec 归档仍由其原 implementation 负责。

### 步骤

1. 在 health gate 与 authorization 完成前，不加载或执行原 archive implementation。先加载 `health`，把当前代码状态的复合评分、非空数值分项评分、至少包含基线与当前 change 标识/数值评分/观测时间/方向的跨 change 趋势、发现项和 blocker 处置写入非空结构化 report。
2. 运行 `workflow-guard.mjs receipt archive health <report.json>` mint 当前 health receipt；把相同 schema evidence 写入 archive Node evidence 和结构化 Output Schema artifact。report、artifact、receipt、change、code/draft/protocol、评分结构或趋势结构任一不一致都阻断。
3. 运行 `workflow-guard.mjs authorize archive`。authorize 会重新校验 health report/artifact/receipt、archive semantic rules，并从 ledger 重建当前 verify authorization：passed verify Guard result id、按序的两张 verify receipt id、两份 report digest，以及 verify/health Required Output Schema artifact 的规范路径/SHA-256 列表。排序后的完整列表生成 `snapshotDigest`，该 digest 连同当前 hash/receipt/Guard 身份进入 authorization fingerprint 并写回 ledger。
4. 同一当前快照的重复 authorize 幂等返回同一 authorized token；快照变化会 revoke 旧 token 并签发新 generation。即使 artifact 从 A 改为 B 后又恢复为字节相同的 A（A→B→A），恢复后的 A 也必须取得新的 token A2；A1 与 B 都保持 revoked，绝不复活。成功输出 `ARCHIVE AUTHORIZED`；授权不改变 Classic 状态，也不等于 prepared、consumed 或已归档。
5. 收到授权后加载原 `comet-archive`。原流程取得用户对不可逆归档的明确确认后执行 Classic `archive-confirm`；真实 transition boundary 内部运行非消费式 `non-consuming confirmation boundary`，重新比较唯一当前 token、verify/health ledger、artifact snapshots 与 `snapshotDigest`。通过只把 Classic `archive_confirmation` 写为 confirmed，authorization 仍为 `authorized`。
6. Classic handler 为 pending action 建立稳定 action id，并用其 SHA-256 命名 transaction journal。journal 绑定 authorizationId/actionId/attemptId/status、`journal/boundary/token/evidence` 四个原子 step 状态、reconciledSteps 与时间戳，是恢复真源；ownerId/ownerPid lease 保证同一 action single-flight。live owner 存在时，即使 lease 时间字段已过期，并发 loser 也必须以包含 actionId、ownerPid、lease 时间/age 和安全恢复动作的 `in flight` 诊断失败，不能启动第二次 OpenSpec；只有同 owner 续行、显式安全释放或确认 owner PID 已死亡时同一 action 才可接管。
7. 内部 prepare（命令名 `pre-OpenSpec preparation boundary`）按 journal 幂等对账并修复 authorization sidecar、token claim、change/protocol boundary claim 与 evidence。journal、boundary、token、claim、I/O 或 evidence 任一步出现操作性失败后，只记录 lastError 并释放 lease，不触发质量 remediation；同一 action retry 只补缺失步骤，不另起 token/action/attempt。
8. prepare 每次从头重验唯一授权、current Node、code/draft/protocol、health/verify receipts、report digests、schema/semantic、artifact path/SHA 与 `snapshotDigest`；通过才输出 `ARCHIVE PREPARED`。
9. handler 随后运行 OpenSpec。非零时保留 pending action 与 prepared transaction并 release owner lease；同一 action可重新取得 lease全量复核重试，其他 action/token/attempt 不得接管。
10. 只有 OpenSpec 成功，finalize 才以相同 token/action/attempt 幂等把 authorization sidecar、双 claim 与 transaction 标记 `consumed`并释放 lease。重复 finalize 同一 consumed transaction幂等成功。
11. 若 OpenSpec 已移动 change 但 finalize 崩溃，Classic 必须依据 archived postcondition + pending action 调 `archived-postcondition recovery boundary`，从 journal取得 prepared context，先 finalize overlay，再完成 Classic archived；不得重跑已成功的 OpenSpec，也不得提前写 Classic archived。
12. Agent 不直接调用内部 confirm/prepare/finalize/recover/release，也不把 authorization、confirmed、prepared、journal、lease、claim 或 failed audit 当作已归档；归档后不运行 overlay exit。
13. confirm 或 consume 的任一 health、verify、receipt、artifact、SHA 或 snapshotDigest preflight 漂移都会应用 `archive-quality-blocked`。consume 将 journal 标为 `quality-blocked`，只把该 action/attempt 自己拥有的 canonical token/boundary claims 退役为 failed audit并释放 owner lease，再从 archive 回到 execute；随后必须完成 execute → review → verify，并重新 health → authorize。fresh authorization 通过当前 preflight 后，同一 pending action 才可绑定 fresh attempt，旧 attempt 保留在 `previousAttempts`；其他 action/token/attempt 不得借此接管。remediation 只有在每个 Classic event 子进程返回后（包括 exit 0）重读 `.comet.yaml` 并确认 `archive-reopen → verify`、`verify-fail → build` 的真实后置状态时才可 applied；否则保持 retry。只按同次 remediation 的 NODE/SKILL 推进，不得猜测或采用 health-only 回退。

### 完成判定

合法顺序是：verify snapshot → health evidence → authorize → 用户确认 → non-consuming confirm → pending action + journal/owner lease → idempotent prepare/reconcile → prepared → OpenSpec → same-action finalize → consumed。OpenSpec 非零 release lease并保留同 action重试；OpenSpec 已移动但 finalize 崩溃时必须 recover/finalize后才完成 Classic archived。各状态不能互相替代。

### 红旗

- 用 verify 普通字段、旧 receipt 或没有规范 path/SHA 与 `snapshotDigest` 的 artifact 引用替代当前 passed Guard result 快照。
- health 分项为空，或趋势只有 direction、没有基线/当前 change 的数值与观测时间。
- artifact A→B→A 后复活 A1，或接受任何 revoked/consumed token。
- 只取得 token claim 而没有 change/protocol boundary claim，或让失败竞争者移动非自己 attemptId 拥有的 canonical claim。
- 在 OpenSpec 前把 prepared 写成 consumed，或把 OpenSpec 非零误写为 overlay failed 并另起 action/token/attempt。
- Agent 手动运行内部 prepare/finalize，或在用户确认前进入 prepare。
- 把非消费的 archive-confirm、prepared claim 或 failed audit 当作实际归档已完成。
- 同 action retry 时跳过全量重验，或让其他 action/token/attempt 接管 prepared attempt。
- 当前 55-test runtime regression 覆盖 prepare 四步故障修复、OpenSpec-success/finalize-crash recovery、并发 single-flight与无 DEP0190；npm dist 被覆盖后旧 evidence 失效。


## 入口检查

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs entry archive
```

## Skill 实现

暂不加载 `comet-archive`；先完成 health gate 与下方归档前授权。

## 必需 Skill 调用

- 加载 `health`，保存非空结构化输出与 schema evidence，再用 `workflow-guard.mjs receipt` 铸造 `required-skill:archive.health` receipt（scope: `main`，enforcement: `guarded`）。

## 增强调用

- 本节点没有 augmentation。

## 输出结构

- `comet.archive.v1`：必需证据 `archive-summary`、`archived-state`；必需 artifact 无。
- `gstack.archive.health-score.v1`：必需证据 `health-run-before-archive`、`health-composite-score`、`health-component-scores`、`health-cross-change-trend`、`health-code-state-hash`、`health-blockers-resolved`；必需 artifact `health-score-report`。

## 证据记录

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs context

node comet-gstack-quality-gates/scripts/workflow-state.mjs record archive '{"summary":"record the real Node result","schemaEvidence":{}}'
node comet-gstack-quality-gates/scripts/workflow-guard.mjs receipt archive health <structured-execution-report.json>
```

状态记录器不能铸造 Required Skill receipt。每个 guarded binding 都要保存结构化执行报告，包含 Node、Skill、change、status、开始/完成时间、当前 code hash、当前 draft hash、非空 `skillOutput` 与对应 `schemaEvidence`。普通 guarded binding 再执行上方 receipt 命令。receipt 的字段必须只覆盖该 Skill 负责的证据子集，并与 Node 最终证据和 Output Schema artifact 一致。禁止复用旧 code state 或旧 Bundle draft 的 hash。





## 归档前授权

加载原 archive implementation 前，先完成上方 Required Skill Call 与证据记录，然后运行：

```bash
node comet-gstack-quality-gates/scripts/workflow-guard.mjs authorize archive
```

命令会生成单次 `AUTHORIZATION` 并保留到真实归档边界。看到 `ARCHIVE AUTHORIZED` 后加载 `comet-archive`。Agent 不操作内部归档事务；原实现取得用户确认后，由 Classic runtime 在不可逆 OpenSpec 动作紧邻前重新校验 health、verify、code 与 draft，并维护单一 attempt 的完整审计。失败后只有同一 pending action 可在重新校验后重试，成功授权绝不复用。

## 守卫规则

- `archive-state`：按 `state-transition` 校验。

## 最终归档步骤

看到 `ARCHIVE AUTHORIZED` 后加载 `comet-archive` 并完成真实归档。用户批准后，归档事务边界完全由 Classic runtime 内部处理；失败时只有同一 pending action 可在重新校验后重试。以原实现结果结束；archive 后 change 已不再 active，不执行 overlay exit。

# Comet gstack quality gates

我把 gstack 的几道质量检查接进了 Comet Classic。Comet 继续管理 change、阶段和归档，这个 Bundle 负责在几个容易被省略的节点上卡住流程，直到证据齐全。

这套 Bundle 最初基于 Comet `0.4.0-beta.9` 生成；当前优化版仍在项目级试点，尚未同步到 Claude Code 和 Codex 的全局注册层。

## 改了什么

Comet Classic 的状态机和节点 implementation 都保留。Bundle 只增加三类东西：

- Required Skill Call：规定当前节点必须实际调用哪个 Skill。
- Output Schema：规定要留下哪些结构化证据。
- Guard：证据缺失、顺序错误或 hash 过期时阻止推进。

具体绑定如下：

| Node | Required Skill | 约束 |
|---|---|---|
| `design` | `autoplan` | 记录 CEO、engineering、design、DX 四个视角的审查结果 |
| `execute` | `review` | 对当前完整 diff 审查一次，已有同摘要通过证据可复用 |
| `subagent-execute` | `review` | 子代理回传前完成 handoff review |
| `review` | `requesting-code-review` | 对当前完整 diff 做一次正式审查；高风险才做独立第二审 |
| `verify` | `verification-gate`，网页任务按需只读 QA | 只验证已批准场景；文档任务不运行网页 QA |
| `archive` | 归档前检查 | 核对当前规格、代码及验证证据；`health` 非默认必需 |

## 开工与验证限额

实现前对当前 OpenSpec 规格、适用规则、验收场景和整次预算确认一次；节点推进和换会话恢复只校验原确认，不重复找用户。新 change 默认总预算为 4 小时、最多 1 轮实现返工、单条测试命令 10 分钟；已确认的旧 change 沿用原预算。只有目标、范围、规则或验收场景实质变化，或预算实际耗尽，才重新确认；证据格式和 CLI 调用问题由 Agent 自行纠正。build 只跑受影响的检查；verify 按已批准场景验证。网页 QA 只读报告问题，定向修复由实现阶段完成。同一规格和代码摘要下的通过证据不重复运行。

活跃 change 的直接文件写工具在 plan 及后续节点也检查开工确认；open/design 仍能编写规格。Shell 等意图不明的工具依赖节点守卫和 `run-check`，不能把 Hook 当作任意命令的写入沙箱。

## 仓库结构

```text
.
├─ .comet/
│  ├─ bundle-authoring/
│  │  └─ comet-gstack-quality-gates.json
│  ├─ bundle-drafts/
│  │  └─ comet-gstack-quality-gates/
│  └─ bundles/
│     └─ comet-gstack-quality-gates/
├─ scripts/
│  ├─ bundle-eval-handoff.mjs
│  └─ run-subscription-eval.mjs
├─ patches/
│  ├─ comet-0.4.0-beta.9-global-hook-path.patch
│  └─ comet-gstack-global-no-active-hook.patch
├─ AGENTS.md
├─ CLAUDE.md
└─ README.md
```

`.comet/bundles/comet-gstack-quality-gates/` 是待重新评估的 Bundle 真源；当前 `bundle-authoring` 为 `drift-conflict`，不能据此分发。`bundle-drafts` 保存同内容的评测 draft。`scripts/` 只服务维护流程，交接结果写入被 Git 忽略的 `.comet/eval-handoffs/`。

## 安装前准备

需要：

- Node.js 22 或更高版本
- 可用的 `comet` CLI
- Claude Code 或 Codex
- 已注册的 `autoplan`、`review`、`codex`、`verification-gate`、`qa`、`health`

先检查：

```powershell
node --version
comet --version
comet --help
```

## Clone 和自检

```powershell
git clone https://github.com/HanksChen0110/Comet-gstack-bundle.git
cd Comet-gstack-bundle

node .comet/bundles/comet-gstack-quality-gates/skills/comet-gstack-quality-gates/scripts/comet-check.mjs
```

正常输出：

```text
workflow-contract-ok
```

## 交给其他 Agent 评测

在真源目录执行一条命令，由脚本准备快照、调用本机订阅登录的 Claude CLI 只读评测、写入报告并校验：

```powershell
node scripts/run-subscription-eval.mjs
```

脚本先核对 Bundle 真源与 draft 一致，并把 draft 复制到被忽略的隔离目录；Agent 只获得 Read 工具，单次评测上限 45 分钟和 CLI 报价 1 美元。结果、实际模型、用量、报告摘要和 `verified.json` 自动保存在同一交接目录；已通过的同快照外部评审直接复用。可用 `--dry-run` 只检查路径和快照。本机 Claude CLI 的实际模型由登录账号配置决定，运行结果会记录；CLI 不可用或证据不足时结果为 `blocked`，不由用户手工搬运文件。该路径不是 Comet 官方 eval。

若评测环境有 Comet 支持的 API 凭据，可以先用新版 Comet 的 `--collect` 检查任务与配置，再在 45 分钟预算内运行正式评测。填写 `mode: comet-eval`，把未经修改的 `repository-eval-result.json` 放在交接目录，并在 `officialResult.path` 和 `officialResult.sha256` 引用它。Comet `0.4.3` 实测不会使用 Codex 的订阅登录完成正式 eval；认证缺失、样本全跳过或工具故障时填写 `blocked`，不可填写 `passed`。密钥不得写进交接文件。

需要手动接收其他 Agent 的结果时仍可运行底层校验：

```powershell
node scripts/bundle-eval-handoff.mjs verify --project . --request <request.json路径> --result <result.json路径>
```

校验会检查请求版本、Bundle 与 manifest 摘要，以及评审报告或 Comet 结果的文件摘要，并写出 `verified.json`。`external-agent` 即使评审通过也只记为试点证据，`eligibleForCometRecord` 仍是 `false`；本轮保持 Comet 原生 ready 阻塞。最终是否达到 `ready` 仍由 Comet 原生 eval、review 和当前 hash 检查决定。变更 Bundle 后要重新生成请求。

当前快照请求 `060e93cfc0403788ef829ac3` 已由本机订阅 Agent 自动评审并通过六项场景的结果校验；试点报告已冻结为带 SHA-256 的副本。Agent 未运行测试，命令结果引用本地试点的历史记录。相同快照再次运行会复用该结果。authoring 仍为 `drift-conflict`，原生 `ready` 仍阻塞。

当前 manifest 已把 Comet `0.4.3` 不支持的 `workflow-semantic-negative` 替换为该版本提供的 `workflow-route-conformance`。本地负向测试继续覆盖开工确认、漂移和预算；`--collect` 只验证任务可发现，正式评分仍需支持的 API 凭据。

## 旧版兼容补丁（仅 `0.4.0-beta.9`）

Comet `0.4.0-beta.9` 在 global scope 下会生成 `.claude/...` 或 `.agents/...` 相对 Hook 路径。换到其他工作区后，Node 找不到脚本。

下面仅记录旧版 `0.4.0-beta.9` 的历史补丁办法；尚未验证它是否适用于 Comet `0.4.3`，不得照搬到新版。本轮只做隔离项目试点，不修改本机全局安装。

```powershell
$repoRoot = (Get-Location).Path
$cometRoot = Join-Path (npm root -g) '@rpamis\comet'

Push-Location $cometRoot
git apply "$repoRoot\patches\comet-0.4.0-beta.9-global-hook-path.patch"
Pop-Location
```

补丁内容和原因见 [patches/README.md](patches/README.md)。后续 Comet 版本如果已经修复 global Hook 路径，不要重复应用。

## 预览安装

先看 Comet 准备写哪些文件：

```powershell
comet publish distribute comet-gstack-quality-gates `
  --project . `
  --platform claude `
  --platform codex `
  --scope global `
  --locale zh `
  --preview `
  --json
```

重点看三项：

- `unsupported` 应为空。
- `executableDisclosures.command` 应是用户目录下的绝对路径。
- 目标文件不能和其他 Skill 冲突。

预览不会写文件。

## 正式安装

确认预览后运行：

```powershell
comet publish distribute comet-gstack-quality-gates `
  --project . `
  --platform claude `
  --platform codex `
  --scope global `
  --locale zh `
  --confirm-executables `
  --json
```

命令没有 `--overwrite`。遇到冲突先停下来查文件归属。

安装完成后，重启一次 Claude Code 和 Codex，让它们重新扫描全局 Skill。

## 安装后的 Hook 兼容处理

global scope 下还要处理一个边界：普通工作区没有 active Comet change 时，质量门 Hook 应该直接放行。

正式安装完成后运行：

```powershell
$repoRoot = (Get-Location).Path

Push-Location "$HOME\.claude\skills\comet-gstack-quality-gates"
git apply "$repoRoot\patches\comet-gstack-global-no-active-hook.patch"
Pop-Location

Push-Location "$HOME\.agents\skills\comet-gstack-quality-gates"
git apply "$repoRoot\patches\comet-gstack-global-no-active-hook.patch"
Pop-Location
```

然后在一个没有 active change 的目录中测试：

```powershell
node "$HOME\.claude\skills\comet-gstack-quality-gates\scripts\comet-hook-guard.mjs" before_tool
node "$HOME\.agents\skills\comet-gstack-quality-gates\scripts\comet-hook-guard.mjs" before_tool
```

两边都应返回退出码 `0`，并输出：

```text
workflow-hook-guard-skipped
REASON: no active Comet change
```

## 怎么用

Claude Code：

```text
/comet-gstack-quality-gates
```

Codex：

```text
$comet-gstack-quality-gates
```

也可以把任务一起说清楚：

```text
请使用 comet-gstack-quality-gates 继续当前 change，只按状态返回的下一节点推进。
```

新项目还没有 Comet Classic 时，先初始化：

```powershell
comet init . --workflow classic --scope project --language zh --skip-existing
```

主入口发现没有 active change 时，会转到 `/comet-classic` 或 `/comet-open`。change 建立后再调用主入口，它会读取真实状态并加载当前节点。

## 状态放在哪里

Bundle 可以全局安装，状态仍然留在各自项目：

```text
openspec/changes/<change-name>/.comet.yaml
```

Required Skill receipt、Guard result、invalidation 和归档授权保存在项目侧的 evidence 目录。不同项目之间不会共享 change 状态。

常用 CLI：

```bash
comet state select <change-name>
comet state check <change-name> <phase>
comet guard <change-name> <phase> --apply
comet state next <change-name>
comet archive <change-name>
```

平时直接调用 Bundle 主入口更省事。CLI 主要用来查状态、处理多 change 选择，以及执行 Skill 明确要求的状态操作。

## 当前版本

- Bundle version：`1.0.0`
- 审批稿 hash：`c3d1b6079837dc825ff6358258716a9694aef7322d14bb4d0c3da42d606d77fc`
- Workflow kind：`comet-five-phase-overlay`
- 节点数：8
- Required Skill Call：7

仓库里的 Bundle 保持审批稿 hash。两处 global scope 兼容处理放在 `patches/`，分别解决 Hook 绝对路径和普通工作区放行问题。补丁不修改 Comet 状态，也不降低 active change 期间的质量门。

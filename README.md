# Comet gstack quality gates

我把 gstack 的几道质量检查接进了 Comet Classic。Comet 继续管理 change、阶段和归档，这个 Bundle 负责在几个容易被省略的节点上卡住流程，直到证据齐全。

这套改造目前用在 Claude Code 和 Codex，基于 Comet `0.4.0-beta.9` 生成。

## 改了什么

Comet Classic 的状态机和节点 implementation 都保留。Bundle 只增加三类东西：

- Required Skill Call：规定当前节点必须实际调用哪个 Skill。
- Output Schema：规定要留下哪些结构化证据。
- Guard：证据缺失、顺序错误或 hash 过期时阻止推进。

具体绑定如下：

| Node | Required Skill | 约束 |
|---|---|---|
| `design` | `autoplan` | 记录 CEO、engineering、design、DX 四个视角的审查结果 |
| `execute` | `review` | 每个实现段都要有独立 review 证据 |
| `subagent-execute` | `review` | 子代理回传前完成 handoff review |
| `review` | `codex` | 运行一次 Codex 对抗审查 |
| `verify` | `verification-gate` → `qa` | 调用顺序固定，两项证据绑定当前代码和 draft |
| `archive` | `health` | 归档前记录复合评分和跨 change 趋势 |

## verify 为什么管得比较严

`verify` 的执行顺序固定：

```text
verification-gate → qa
```

QA 只要改了代码、产生新提交，或者发现还要修的问题，旧 verify 证据就会失效。流程退回 `execute/review`，修完并审查后重新跑一遍 `verification-gate → qa`。旧 draft hash、倒序调用和过期代码证据也会被 Guard 拦住。

归档前还要再跑 `health`。评分、分项结果、趋势和当前代码 hash 都记录成功后，才进入原来的 `comet-archive` 流程。

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
├─ patches/
│  ├─ comet-0.4.0-beta.9-global-hook-path.patch
│  └─ comet-gstack-global-no-active-hook.patch
├─ AGENTS.md
├─ CLAUDE.md
└─ README.md
```

`.comet/bundles/comet-gstack-quality-gates/` 是已批准的 Bundle。`bundle-authoring` 只保留分发所需的 ready 状态，`bundle-drafts` 保存同一 hash 的 draft。仓库保留这些路径，是为了让 Comet CLI 继续执行原生 hash 校验和分发流程。

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

## 全局安装前的兼容补丁

Comet `0.4.0-beta.9` 在 global scope 下会生成 `.claude/...` 或 `.agents/...` 相对 Hook 路径。换到其他工作区后，Node 找不到脚本。

当前版本需要先给本机 Comet 包应用补丁。只做 project scope 安装时可以跳过这一步。

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

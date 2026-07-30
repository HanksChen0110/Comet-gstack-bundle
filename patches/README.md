# 全局安装兼容补丁

## 1. Comet 0.4.0-beta.9 的路径补丁

`comet publish distribute --scope global` 在 `0.4.0-beta.9` 中会把 Hook 命令写成相对路径：

```text
node .claude/skills/...
node .agents/skills/...
```

Claude Code 和 Codex 从其他工作区运行 Hook 时找不到这些脚本。补丁让 global scope 保留安装脚本的绝对路径，project scope 继续使用相对路径。

先找到本机的 Comet npm 包目录：

```powershell
npm root -g
```

进入 `@rpamis\comet` 目录后应用补丁：

```powershell
git apply <仓库路径>\patches\comet-0.4.0-beta.9-global-hook-path.patch
```

检查预览输出中的 `executableDisclosures.command`。路径应指向用户目录下的 `.claude` 或 `.agents`，不能以 `.claude/`、`.agents/` 开头。

## 2. Bundle Hook 的普通工作区放行补丁

已批准 Bundle 会在没有 active Comet change 时返回错误。Hook 安装到 global scope 后，这会影响普通工作区。

正式安装 Bundle 后，分别进入 Claude Code 和 Codex 的全局 Bundle 目录应用补丁：

```powershell
$repoRoot = Resolve-Path <仓库路径>

Push-Location "$HOME\.claude\skills\comet-gstack-quality-gates"
git apply "$repoRoot\patches\comet-gstack-global-no-active-hook.patch"
Pop-Location

Push-Location "$HOME\.agents\skills\comet-gstack-quality-gates"
git apply "$repoRoot\patches\comet-gstack-global-no-active-hook.patch"
Pop-Location
```

在没有 active change 的目录中运行：

```powershell
node "$HOME\.claude\skills\comet-gstack-quality-gates\scripts\comet-hook-guard.mjs" before_tool
node "$HOME\.agents\skills\comet-gstack-quality-gates\scripts\comet-hook-guard.mjs" before_tool
```

两条命令都应输出：

```text
workflow-hook-guard-skipped
REASON: no active Comet change
```

# Comet gstack Bundle 仓库约定

## 范围

- 本仓库只发布 `comet-gstack-quality-gates` Bundle、使用说明和维护规则。
- Bundle 真源位于 `.comet/bundles/comet-gstack-quality-gates/`。
- 不加入具体项目的 change 状态、评估日志、密钥或业务源码。

## 修改

- 保留 Comet Classic 原状态机和节点 implementation。
- 质量能力只通过 Required Skill Call、Output Schema 和 Guard 叠加。
- `verify` 固定执行 `verification-gate → qa`；QA 改码后必须重新验证。
- `archive` 前必须运行 `health` 并记录当前证据。
- 不使用 `--overwrite` 覆盖用户已有 Skill。

## 验证

- 运行 `node .comet/bundles/comet-gstack-quality-gates/skills/comet-gstack-quality-gates/scripts/comet-check.mjs`。
- 运行两平台、global scope 的 `comet publish distribute ... --preview --json`。
- 提交前检查 `git diff --check`、敏感信息和目标文件清单。

## 发布

- README 使用中文，命令和文件路径保留英文。
- push 前报告变更、验证结果和 commit。

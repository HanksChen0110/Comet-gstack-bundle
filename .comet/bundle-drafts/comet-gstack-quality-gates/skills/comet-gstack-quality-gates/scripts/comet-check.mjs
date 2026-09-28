#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const required = [
  "SKILL.md",
  "../comet-gstack-quality-gates-open/SKILL.md",
  "../comet-gstack-quality-gates-design/SKILL.md",
  "../comet-gstack-quality-gates-plan/SKILL.md",
  "../comet-gstack-quality-gates-execute/SKILL.md",
  "../comet-gstack-quality-gates-subagent-execute/SKILL.md",
  "../comet-gstack-quality-gates-review/SKILL.md",
  "../comet-gstack-quality-gates-verify/SKILL.md",
  "../comet-gstack-quality-gates-archive/SKILL.md",
  "reference/resolved-skills.json",
  "reference/workflow-protocol.json",
  "reference/start-approval.md",
  "reference/decision-points.md",
  "reference/recovery.md",
  "reference/authoring-lanes.json",
  "reference/skill-review.md",
  "reference/composition-report.md",
  "reference/subagents/script-author.md",
  "agents/claude/comet-any-script-author.md",
  "scripts/comet-plan.mjs",
  "scripts/comet-check.mjs",
  "scripts/comet-hook-guard.mjs",
  "scripts/workflow-state.mjs",
  "scripts/workflow-guard.mjs",
  "scripts/workflow-handoff.mjs",
  "scripts/workflow-policy.mjs",
  "comet/skill.yaml",
  "comet/guardrails.yaml",
  "comet/checks.yaml",
  "comet/eval.yaml"
];

async function main() {
  const missing = [];
  for (const relative of required) {
    try {
      const stats = await fs.stat(path.join(packageRoot, relative));
      if (!stats.isFile()) missing.push(relative);
    } catch {
      missing.push(relative);
    }
  }
  if (missing.length > 0) {
    console.error('Missing required workflow contract files: ' + missing.join(', '));
    process.exit(1);
  }
  const protocol = JSON.parse(await fs.readFile(path.join(packageRoot, 'reference', 'workflow-protocol.json'), 'utf8'));
  if (protocol.schemaVersion !== 1 || !Array.isArray(protocol.nodes)) {
    throw new Error('workflow-protocol.json must use the current schema with nodes');
  }
  console.log('workflow-contract-ok');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

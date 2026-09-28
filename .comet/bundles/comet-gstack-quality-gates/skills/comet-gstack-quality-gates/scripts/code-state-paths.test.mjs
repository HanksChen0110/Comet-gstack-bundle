import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflow-guard.mjs');
const source = fs.readFileSync(scriptPath, 'utf8');
const match = source.match(/function excludedFromCodeState\(relative\) \{[\s\S]*?\n\}/u);
assert.ok(match, 'excludedFromCodeState must remain discoverable');
const excludedFromCodeState = Function(`${match[0]}; return excludedFromCodeState;`)();

for (const relative of [
  '.comet/current-change.json',
  'openspec/changes/example/.comet.yaml',
  'openspec/changes/example/.comet/run-state.json',
  'openspec/changes/example/.comet/trajectory.jsonl',
  'openspec/changes/example/evidence/gstack/report.json',
  'openspec/changes/example/proposal.md',
  'openspec/changes/example/tasks.md',
  'openspec/changes/example/specs/guide/spec.md',
  'docs/superpowers/reports/example-verify.md'
]) {
  assert.equal(excludedFromCodeState(relative), true, `${relative} must not change codeStateHash`);
}

assert.equal(excludedFromCodeState('src/index.js'), false);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comet-code-hash-'));
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
git('init');
fs.writeFileSync(path.join(root, 'index.js'), 'export const value = 1;\n');
const context = () => {
  const result = spawnSync(process.execPath, [scriptPath, 'context'], {
    cwd: root, env: { ...process.env, COMET_RUN_ROOT: root }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).codeStateHash;
};
const beforeCommit = context();
git('add', 'index.js');
git('-c', 'user.name=Pilot', '-c', 'user.email=pilot@example.invalid', 'commit', '-m', 'fixture');
assert.equal(context(), beforeCommit, 'committing identical working files must not invalidate evidence');
fs.writeFileSync(path.join(root, 'index.js'), 'export const value = 2;\n');
assert.notEqual(context(), beforeCommit, 'real code changes must invalidate evidence');
console.log('CODE_STATE_PATHS=PASS');

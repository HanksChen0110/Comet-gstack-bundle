import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const hook = path.join(scripts, 'comet-hook-guard.mjs');
const policy = path.join(scripts, 'workflow-policy.mjs');

test('direct writes require current approval after design', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'comet-hook-approval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const change = path.join(root, 'openspec', 'changes', 'example');
  await mkdir(path.join(change, 'specs', 'guide'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), '# Rules\n');
  await writeFile(path.join(change, '.comet.yaml'), 'phase: design\narchived: false\n');
  await writeFile(path.join(change, 'proposal.md'), '# Goal\n');
  await writeFile(path.join(change, 'specs', 'guide', 'spec.md'), '# Scenario\n');
  await writeFile(path.join(root, 'check.mjs'), 'console.log("CHECK OK");\n');
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(git('init', '-b', 'main').status, 0);
  assert.equal(git('add', '.').status, 0);
  assert.equal(git('-c', 'user.name=Comet Test', '-c', 'user.email=comet-test@example.invalid', 'commit', '-m', 'fixture').status, 0);
  const env = { ...process.env, COMET_RUN_ROOT: root };
  const run = (script, args, input, extraEnv = {}) => spawnSync(process.execPath, [script, ...args], {
    cwd: root, env: { ...env, ...extraEnv }, input, encoding: 'utf8'
  });
  const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'guide.md' } });

  assert.equal(run(hook, ['before_tool'], payload).status, 0, 'design writes remain available');
  await writeFile(path.join(change, '.comet.yaml'), 'phase: build\narchived: false\n');
  const blocked = run(hook, ['before_tool'], payload);
  assert.notEqual(blocked.status, 0, 'build write needs approval');
  assert.match(blocked.stderr, /No valid start approval/u);
  assert.equal(run(hook, ['before_tool'], JSON.stringify({ tool_name: 'Read' })).status, 0);
  assert.notEqual(run(hook, ['before_tool'], '', { FILE_PATH: 'guide.md' }).status, 0);
  assert.notEqual(run(hook, ['before_tool'], JSON.stringify({ tool_name: 'apply_patch' })).status, 0);
  assert.notEqual(run(policy, ['run-check', '--', 'node', 'check.mjs']).status, 0);

  const snapshot = JSON.parse(run(policy, ['snapshot']).stdout);
  const brief = {
    specDigest: snapshot.spec.digest, rulesDigest: snapshot.rules.digest,
    userConfirmation: { kind: 'explicit-user', text: 'Synthetic test fixture approval' },
    goal: 'Write guide', nonGoals: ['No web UI'],
    rules: [{ text: 'Confirm scope', source: 'AGENTS.md', status: 'confirmed' }],
    unknowns: [], conflicts: [], scenarios: ['Guide exists'], taskType: 'document',
    checks: ['node check.mjs']
  };
  const briefPath = path.join(root, 'brief.json');
  await writeFile(briefPath, JSON.stringify(brief));
  assert.equal(run(policy, ['approve', briefPath]).status, 0);
  assert.equal(run(hook, ['before_tool'], payload).status, 0);
  assert.match(run(policy, ['run-check', '--', 'node', 'check.mjs']).stdout, /CHECK OK/u);
  assert.match(run(policy, ['run-check', '--', 'node', 'check.mjs']).stdout, /CHECK REUSED/u);
  const recorded = JSON.parse(await readFile(path.join(root, '.comet/workflow-evidence/example/start-approval.json')));
  assert.equal(recorded.checksRun.length, 1);
  await writeFile(path.join(change, 'specs', 'guide', 'spec.md'), '# Changed scenario\n');
  const stale = run(hook, ['before_tool'], payload);
  assert.notEqual(stale.status, 0, 'stale approval blocks write');
  const approval = JSON.parse(await readFile(path.join(root, '.comet/workflow-evidence/example/start-approval.json')));
  assert.ok(approval.invalidatedAt);
});

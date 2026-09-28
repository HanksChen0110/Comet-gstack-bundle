import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflow-policy.mjs');

test('approval blocks unknowns, drift, stale consent and exhausted budget', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-policy-'));
  const change = path.join(root, 'openspec/changes/example');
  await fs.mkdir(path.join(change, 'specs/guide'), { recursive: true });
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# Rules\nConfirm scope.\n');
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '# Rules\nConfirm scope.\n');
  await fs.writeFile(path.join(change, '.comet.yaml'), 'phase: build\narchived: false\n');
  await fs.writeFile(path.join(change, 'proposal.md'), '# Goal\nExample.\n');
  await fs.writeFile(path.join(change, 'design.md'), '# Design\nOne section.\n');
  await fs.writeFile(path.join(change, 'tasks.md'), '- [ ] Write it\n');
  await fs.writeFile(path.join(change, 'specs/guide/spec.md'), '# Requirement\nOne section.\n');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    cwd: root, env: { ...process.env, COMET_RUN_ROOT: root }, encoding: 'utf8'
  });
  assert.notEqual(run('check').status, 0, 'no approval must block work');
  const snapshot = JSON.parse(run('snapshot').stdout);
  const brief = {
    specDigest: snapshot.spec.digest, rulesDigest: snapshot.rules.digest,
    userConfirmation: { kind: 'explicit-user', text: 'Test approval for this exact fixture version' },
    goal: 'Write one section', nonGoals: ['No web UI'],
    rules: [{ text: 'Confirm scope', status: 'confirmed', source: 'AGENTS.md' }],
    unknowns: [], conflicts: [], scenarios: ['One section is present'],
    taskType: 'document', checks: ['node check.mjs']
  };
  const input = path.join(root, 'brief.json');
  await fs.writeFile(input, JSON.stringify({ ...brief, unknowns: [{ text: 'Unresolved rule', status: 'pending' }] }));
  assert.notEqual(run('approve', input).status, 0, 'unresolved unknown must block approval');
  await fs.writeFile(input, JSON.stringify(brief));
  assert.equal(run('approve', input).status, 0);
  const approvalPath = path.join(root, '.comet/workflow-evidence/example/start-approval.json');
  let approval = JSON.parse(await fs.readFile(approvalPath, 'utf8'));
  assert.equal(approval.budgetMinutes, 240);
  assert.equal(approval.maxRepairRounds, 1);
  assert.equal(run('repair').status, 0);
  assert.notEqual(run('repair').status, 0, 'second repair must block');
  await fs.appendFile(path.join(change, 'specs/guide/spec.md'), '\nChanged.\n');
  assert.notEqual(run('check').status, 0, 'spec change must invalidate approval');
  await fs.writeFile(path.join(change, 'specs/guide/spec.md'), '# Requirement\nOne section.\n');
  assert.notEqual(run('check').status, 0, 'restoring bytes must not revive stale consent');
  assert.equal(run('approve', input).status, 0, 'new explicit confirmation can approve restored version');
  approval = JSON.parse(await fs.readFile(approvalPath, 'utf8'));
  approval.expiresAt = '2000-01-01T00:00:00.000Z';
  await fs.writeFile(approvalPath, JSON.stringify(approval));
  assert.notEqual(run('check').status, 0, 'expired budget must block');
  assert.equal(run('handoff', 'resume after fresh budget approval').status, 0, 'handoff remains available after expiry');
});

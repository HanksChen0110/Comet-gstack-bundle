import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundle-eval-handoff.mjs');
const name = 'comet-gstack-quality-gates';

function run(project, ...args) {
  return spawnSync(process.execPath, [script, ...args, '--project', project], {
    encoding: 'utf8',
  });
}

test('external eval handoff rejects unsupported passes and stale snapshots', async (context) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-eval-handoff-'));
  context.after(async () => fs.rm(project, { recursive: true, force: true }));
  for (const folder of ['bundles', 'bundle-drafts']) {
    const root = path.join(project, '.comet', folder, name);
    await fs.mkdir(path.join(root, 'skills', name, 'comet'), { recursive: true });
    await fs.writeFile(path.join(root, 'bundle.yaml'), 'name: test\n');
    await fs.writeFile(path.join(root, 'skills', name, 'comet', 'eval.yaml'), 'kind: SkillEvalManifest\n');
  }
  const prepared = run(project, 'prepare');
  assert.equal(prepared.status, 0, prepared.stderr);
  const { requestPath, requestId, snapshot } = JSON.parse(prepared.stdout);
  const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
  const resultPath = path.join(path.dirname(requestPath), 'result.json');
  const result = {
    schemaVersion: 2,
    kind: 'comet.bundle-eval-return',
    requestId,
    snapshot,
    mode: 'external-agent',
    outcome: 'blocked',
    agent: 'codex',
    model: 'selected-by-user',
    summary: 'Agent could not run the official evaluator.',
  };
  await fs.writeFile(resultPath, JSON.stringify(result));
  const blocked = run(project, 'verify', '--request', requestPath, '--result', resultPath);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).eligibleForCometRecord, false);

  result.outcome = 'passed';
  await fs.writeFile(resultPath, JSON.stringify(result));
  const incomplete = run(project, 'verify', '--request', requestPath, '--result', resultPath);
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /all scenario verdicts/);

  const reviewPath = path.join(path.dirname(requestPath), 'review.md');
  const review = '# External review\nEvery scenario was checked.\n';
  await fs.writeFile(reviewPath, review);
  result.scenarioVerdicts = request.scenarios.map(({ id }) => ({
    id, verdict: 'pass', evidence: 'Inspected fixture and command output.',
  }));
  result.review = { path: 'review.md', sha256: createHash('sha256').update(review).digest('hex') };
  await fs.writeFile(resultPath, JSON.stringify(result));
  const external = run(project, 'verify', '--request', requestPath, '--result', resultPath);
  assert.equal(external.status, 0, external.stderr);
  assert.equal(JSON.parse(external.stdout).eligibleForCometRecord, false);

  const pilotPath = path.join(path.dirname(requestPath), 'pilot.md');
  await fs.writeFile(pilotPath, 'pilot evidence\n');
  result.pilotEvidence = {
    path: 'pilot.md', sha256: createHash('sha256').update('pilot evidence\n').digest('hex'),
  };
  await fs.writeFile(resultPath, JSON.stringify(result));
  assert.equal(run(project, 'verify', '--request', requestPath, '--result', resultPath).status, 0);
  await fs.writeFile(pilotPath, 'changed evidence\n');
  const changedPilot = run(project, 'verify', '--request', requestPath, '--result', resultPath);
  assert.equal(changedPilot.status, 1);
  assert.match(changedPilot.stderr, /Pilot evidence SHA-256 does not match/);
  await fs.writeFile(pilotPath, 'pilot evidence\n');

  await fs.writeFile(reviewPath, '# Changed review\n');
  const tampered = run(project, 'verify', '--request', requestPath, '--result', resultPath);
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /External review SHA-256 does not match/);
  await fs.writeFile(reviewPath, review);

  result.mode = 'comet-eval';
  await fs.writeFile(resultPath, JSON.stringify(result));
  const unsupported = run(project, 'verify', '--request', requestPath, '--result', resultPath);
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /requires a passing official Comet eval result/);

  for (const folder of ['bundles', 'bundle-drafts']) {
    await fs.writeFile(path.join(project, '.comet', folder, name, 'bundle.yaml'), 'name: changed\n');
  }
  const stale = run(project, 'verify', '--request', requestPath, '--result', resultPath);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /stale or invalid/);
});

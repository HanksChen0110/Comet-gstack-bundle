import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const workflowStatePath = path.join(scriptsRoot, 'workflow-state.mjs');
const workflowGuardPath = path.join(scriptsRoot, 'workflow-guard.mjs');
const hookGuardPath = path.join(scriptsRoot, 'comet-hook-guard.mjs');

async function createFixture({ changes, selection, selectionRaw }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'comet-selection-'));
  for (const name of changes) {
    const changeRoot = path.join(root, 'openspec', 'changes', name);
    await mkdir(changeRoot, { recursive: true });
    await writeFile(
      path.join(changeRoot, '.comet.yaml'),
      ['phase: open', 'workflow: full', 'archived: false', 'language: zh-CN', ''].join('\n'),
      'utf8',
    );
  }
  if (selection !== undefined || selectionRaw !== undefined) {
    await mkdir(path.join(root, '.comet'), { recursive: true });
    const payload =
      selectionRaw !== undefined
        ? selectionRaw
        : JSON.stringify(
            {
              schema: 'comet.selection.v2',
              workflow: 'classic',
              change: selection,
              selectedAt: '2026-08-25T00:00:00.000Z',
            },
            null,
            2,
          );
    await writeFile(path.join(root, '.comet', 'current-change.json'), payload, 'utf8');
  }
  const init = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const add = spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const commit = spawnSync(
    'git',
    ['-c', 'user.name=Comet Test', '-c', 'user.email=comet-test@example.invalid', 'commit', '-m', 'fixture'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(commit.status, 0, commit.stderr || commit.stdout);
  return root;
}

function runStatus(root) {
  return spawnSync(process.execPath, [workflowStatePath, 'status'], {
    cwd: root,
    env: { ...process.env, COMET_RUN_ROOT: root },
    encoding: 'utf8',
  });
}

function runNext(root) {
  return spawnSync(process.execPath, [workflowStatePath, 'next'], {
    cwd: root,
    env: { ...process.env, COMET_RUN_ROOT: root },
    encoding: 'utf8',
  });
}

function runRoute(root, expectedSelection) {
  return spawnSync(process.execPath, [workflowGuardPath, 'route'], {
    cwd: root,
    env: {
      ...process.env,
      COMET_RUN_ROOT: root,
      COMET_SELECTED_CHANGE: expectedSelection,
    },
    encoding: 'utf8',
  });
}

function runHook(root) {
  return spawnSync(process.execPath, [hookGuardPath, 'before_tool'], {
    cwd: root,
    env: { ...process.env, COMET_RUN_ROOT: root },
    encoding: 'utf8',
  });
}

function parseStatus(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('resolves the explicitly selected Classic change when multiple changes are active', async (t) => {
  const root = await createFixture({ changes: ['alpha-change', 'beta-change'], selection: 'beta-change' });
  t.after(() => rm(root, { recursive: true, force: true }));

  const status = parseStatus(runStatus(root));

  assert.equal(status.status, 'running', JSON.stringify(status));
  assert.equal(status.change, 'beta-change');
  assert.equal(status.currentNode, 'open');
});

test('blocks multiple active changes when no current selection exists', async (t) => {
  const root = await createFixture({ changes: ['alpha-change', 'beta-change'] });
  t.after(() => rm(root, { recursive: true, force: true }));

  const status = parseStatus(runStatus(root));

  assert.equal(status.status, 'blocked');
  assert.match(status.reason, /Multiple active Comet changes/u);
});

test('blocks a selected change that is no longer active', async (t) => {
  const root = await createFixture({ changes: ['alpha-change', 'beta-change'], selection: 'missing-change' });
  t.after(() => rm(root, { recursive: true, force: true }));

  const status = parseStatus(runStatus(root));

  assert.equal(status.status, 'blocked');
  assert.match(status.reason, /selected Classic change 'missing-change' is not active/u);
});

test('blocks malformed current selection instead of guessing', async (t) => {
  const root = await createFixture({
    changes: ['alpha-change', 'beta-change'],
    selectionRaw: '{not-json',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const status = parseStatus(runStatus(root));

  assert.equal(status.status, 'blocked');
  assert.match(status.reason, /current change selection contains invalid JSON/u);
});

test('keeps single-active-change behavior even when selection is stale', async (t) => {
  const root = await createFixture({ changes: ['alpha-change'], selection: 'missing-change' });
  t.after(() => rm(root, { recursive: true, force: true }));

  const status = parseStatus(runStatus(root));

  assert.equal(status.status, 'running', JSON.stringify(status));
  assert.equal(status.change, 'alpha-change');
});

test('routes next through the selected active change', async (t) => {
  const root = await createFixture({ changes: ['alpha-change', 'beta-change'], selection: 'beta-change' });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = runNext(root);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^NODE:\s+open$/mu);
});

test('routes the hook through the selected active change', async (t) => {
  const root = await createFixture({ changes: ['alpha-change', 'beta-change'], selection: 'beta-change' });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = runHook(root);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^NODE:\s+open$/mu);
});

test('blocks a route subprocess when selection changed after its parent pinned a change', async (t) => {
  const root = await createFixture({ changes: ['alpha-change', 'beta-change'], selection: 'alpha-change' });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = runRoute(root, 'beta-change');

  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /current change selection changed from 'beta-change' to 'alpha-change'/u);
});

test('blocks a route subprocess when its pinned change is no longer active', async (t) => {
  const root = await createFixture({ changes: ['alpha-change'], selection: 'alpha-change' });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = runRoute(root, 'beta-change');

  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /selected Classic change 'beta-change' is not active/u);
});

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readStructuredArtifact } from './structured-artifact.mjs';

async function withFixture(t, name, content) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'comet-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, name);
  await writeFile(file, content, 'utf8');
  return file;
}

test('accepts non-empty Markdown with a heading as a structured document', async (t) => {
  const file = await withFixture(t, 'design.md', '---\nrole: technical-design\n---\n\n# Design\n\nBody\n');

  const artifact = await readStructuredArtifact(file);

  assert.deepEqual(artifact, { format: 'markdown' });
});

test('rejects Markdown with no document heading', async (t) => {
  const file = await withFixture(t, 'design.md', 'plain text only\n');

  const artifact = await readStructuredArtifact(file);

  assert.equal(artifact, null);
});

test('accepts a JSON object and returns its fields for semantic validation', async (t) => {
  const file = await withFixture(t, 'report.json', '{"schemaEvidence":{"passed":true}}\n');

  const artifact = await readStructuredArtifact(file);

  assert.deepEqual(artifact, { schemaEvidence: { passed: true } });
});

test('rejects JSON arrays and malformed JSON', async (t) => {
  const arrayFile = await withFixture(t, 'array.json', '[]\n');
  const malformedFile = await withFixture(t, 'broken.json', '{not-json\n');

  assert.equal(await readStructuredArtifact(arrayFile), null);
  assert.equal(await readStructuredArtifact(malformedFile), null);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  'openspec/changes/example/evidence/gstack/report.json'
]) {
  assert.equal(excludedFromCodeState(relative), true, `${relative} must not change codeStateHash`);
}

assert.equal(excludedFromCodeState('openspec/changes/example/proposal.md'), false);
assert.equal(excludedFromCodeState('src/index.js'), false);
assert.ok(source.includes("':(exclude)openspec/changes/**/.comet/**'"), 'tracked diff must exclude mutable per-change Comet state');
console.log('CODE_STATE_PATHS=PASS');

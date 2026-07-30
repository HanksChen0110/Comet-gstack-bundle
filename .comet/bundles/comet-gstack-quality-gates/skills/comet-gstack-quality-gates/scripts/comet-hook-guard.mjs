#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const event = process.argv[2] ?? 'before_tool';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const runRoot = process.env.COMET_RUN_ROOT ? path.resolve(process.env.COMET_RUN_ROOT) : process.cwd();
const protocolPath = path.join(packageRoot, 'reference', 'workflow-protocol.json');

function isCometOverlay(protocol) {
  return protocol.kind === 'comet-five-phase-overlay';
}

function parseSimpleYaml(raw) {
  const state = {};
  for (const line of String(raw).split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([^:#][^:]*):\s*(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1].trim();
    let value = match[2].trim();
    const commentIndex = value.indexOf(' #');
    if (commentIndex >= 0) value = value.slice(0, commentIndex).trim();
    if (value === 'true') state[key] = true;
    else if (value === 'false') state[key] = false;
    else if (value === 'null') state[key] = null;
    else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      state[key] = value.slice(1, -1);
    } else {
      state[key] = value;
    }
  }
  return state;
}

async function activeCometChanges() {
  const changesRoot = path.join(runRoot, 'openspec', 'changes');
  let entries;
  try {
    entries = await fs.readdir(changesRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw error;
  }
  const changes = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(changesRoot, entry.name, '.comet.yaml');
    let state;
    try {
      state = parseSimpleYaml(await fs.readFile(statePath, 'utf8'));
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
      throw error;
    }
    const archived = state.archived === true || String(state.archived ?? '').toLowerCase() === 'true';
    if (!archived) changes.push({ name: entry.name, statePath, state });
  }
  return changes.sort((left, right) => left.name.localeCompare(right.name));
}

async function resolveCometOverlayChange() {
  const changes = await activeCometChanges();
  if (changes.length === 0) {
    throw new Error(
      'No active Comet change; use /comet-open or the permanent /comet-classic entry to create one.',
    );
  }
  if (changes.length > 1) {
    throw new Error(
      'Multiple active Comet changes: ' +
        changes.map((change) => change.name).join(', ') +
        '. Ask the user which change to resume.',
    );
  }
  return changes[0];
}

function hasOverlayEvidence(evidence, nodeId) {
  const value = evidence && typeof evidence === 'object' ? evidence[nodeId] : null;
  return !!(value && typeof value === 'object' && !Array.isArray(value));
}

function hasSuccessfulOverlayGuard(evidence, nodeId, validGuardNodeIds = null) {
  if (validGuardNodeIds instanceof Set) return validGuardNodeIds.has(nodeId);
  const ledger =
    evidence && typeof evidence === 'object' && !Array.isArray(evidence)
      ? overlayLedger(evidence)
      : { guardResults: [] };
  return ledger.guardResults.some(
    (result) => result && result.node === nodeId && result.status === 'passed',
  );
}

function hasGeneratedPlan(state) {
  if (!Object.prototype.hasOwnProperty.call(state, 'plan')) return false;
  const value = state.plan;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized !== '' && normalized !== 'null';
  }
  return true;
}

function overlayBuildExecutionNode(state) {
  if (
    state.build_mode === 'subagent-driven-development' &&
    state.subagent_dispatch === 'confirmed'
  ) {
    return 'subagent-execute';
  }
  return 'execute';
}

function overlayNodeFromState(state, evidence = {}, validGuardNodeIds = null) {
  const phase = String(state.phase ?? '').trim();
  if (phase === 'open') return 'open';
  if (phase === 'design') return 'design';
  if (phase === 'build') {
    if (state.build_pause === 'plan-ready' || !hasGeneratedPlan(state)) {
      return 'plan';
    }
    const executionNode = overlayBuildExecutionNode(state);
    if (!hasSuccessfulOverlayGuard(evidence, executionNode, validGuardNodeIds)) return executionNode;
    if (String(state.review_mode ?? 'off') !== 'off') return 'review';
    return executionNode;
  }
  if (phase === 'verify') return 'verify';
  if (phase === 'archive') return 'archive';
  return null;
}

function evidencePathFor(protocol, change) {
  const changeName = typeof change === 'string' ? change : change.name;
  return path.join(runRoot, '.comet', 'workflow-evidence', changeName, protocol.name + '.json');
}

async function readOverlayEvidence(protocol, change) {
  try {
    const parsed = JSON.parse(await fs.readFile(evidencePathFor(protocol, change), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeOverlayEvidence(protocol, change, value) {
  const file = evidencePathFor(protocol, change);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid + '-' + Date.now();
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temporary, file);
}

function overlayLedger(evidence) {
  const current =
    evidence.__ledger && typeof evidence.__ledger === 'object' && !Array.isArray(evidence.__ledger)
      ? evidence.__ledger
      : {};
  current.receipts = Array.isArray(current.receipts) ? current.receipts : [];
  current.invalidations = Array.isArray(current.invalidations) ? current.invalidations : [];
  current.guardResults = Array.isArray(current.guardResults) ? current.guardResults : [];
  current.archiveAuthorizations = Array.isArray(current.archiveAuthorizations)
    ? current.archiveAuthorizations
    : [];
  current.segmentInventories = Array.isArray(current.segmentInventories)
    ? current.segmentInventories
    : [];
  evidence.__ledger = current;
  return current;
}


function statePath(protocol) {
  const preferred = String(protocol.state?.statePath ?? '');
  if (preferred.includes('*')) {
    throw new Error('workflow-run statePath cannot contain wildcards');
  }
  const relative = preferred;
  return path.join(runRoot, ...relative.split('/').filter(Boolean));
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function validatedOverlayNode() {
  const result = spawnSync(
    process.execPath,
    [path.join(packageRoot, 'scripts', 'workflow-guard.mjs'), 'route'],
    {
      cwd: runRoot,
      encoding: 'utf8',
      env: { ...process.env, COMET_RUN_ROOT: runRoot },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      'Cannot resolve current overlay Node: ' +
        String(result.stderr || result.stdout || 'exit ' + result.status).trim(),
    );
  }
  const node = /^NODE:\s*(\S+)\s*$/mu.exec(result.stdout)?.[1];
  if (!node) throw new Error('Overlay route guard did not return a NODE.');
  return node;
}

function route(protocol) {
  return (protocol.nodes ?? []).filter((node) => !node.disabled);
}

function completedSet(state) {
  return new Set(Array.isArray(state.completedNodes) ? state.completedNodes : []);
}

function nextNode(protocol, state) {
  const completed = completedSet(state);
  return route(protocol).find((node) => !completed.has(node.id)) ?? null;
}

async function main() {
  const protocol = await readJson(protocolPath);
  if (protocol.schemaVersion !== 1 || !Array.isArray(protocol.nodes)) {
    throw new Error('workflow-protocol.json must use the current schema with nodes');
  }
  const nodes = route(protocol);
  if (nodes.length === 0) {
    throw new Error('workflow protocol has no enabled nodes');
  }
  if (isCometOverlay(protocol)) {
    const change = await resolveCometOverlayChange();
    const current = validatedOverlayNode();
    if (!current || !nodes.some((node) => node.id === current)) {
      throw new Error('active Comet change has no valid workflow Node');
    }
    console.log('workflow-hook-guard-ok');
    console.log('EVENT: ' + event);
    console.log('NODE: ' + current);
    return;
  }
  let state;
  try {
    state = await readJson(statePath(protocol));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error('workflow state is missing; run workflow-state.mjs init first');
    }
    throw error;
  }
  if (state.workflow !== protocol.name) {
    throw new Error('workflow state does not match this workflow protocol');
  }
  if (state.status !== 'running') {
    throw new Error('workflow is not running; current status is ' + String(state.status));
  }
  const current = state.currentNode ?? nextNode(protocol, state)?.id ?? null;
  if (!current || !nodes.some((node) => node.id === current)) {
    throw new Error('workflow state has no valid current Node');
  }
  console.log('workflow-hook-guard-ok');
  console.log('EVENT: ' + event);
  console.log('NODE: ' + current);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

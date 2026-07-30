#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const command = process.argv[2] ?? 'status';
const nodeId = process.argv[3] ?? null;
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


function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
}

function generatedNodeSkillName(protocol, id) {
  return (slug(protocol.name) || 'workflow') + '-' + (slug(id) || 'node');
}

function findNode(protocol, id) {
  return (protocol.nodes ?? []).find(
    (node) => node.id === id || generatedNodeSkillName(protocol, node.id) === id,
  );
}

function handoffPath(protocol, change, node) {
  return path.join(
    runRoot,
    '.comet',
    'workflow-handoffs',
    change.name,
    protocol.name,
    node.id + '.json',
  );
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid + '-' + Date.now();
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temporary, file);
}

function guardContext() {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'workflow-guard.mjs'), 'context'],
    { cwd: runRoot, env: { ...process.env, COMET_RUN_ROOT: runRoot }, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error('Cannot create handoff context: ' + String(result.stderr || result.stdout).trim());
  }
  return JSON.parse(result.stdout);
}

async function main() {
  const protocol = JSON.parse(await fs.readFile(protocolPath, 'utf8'));
  if (!isCometOverlay(protocol)) {
    throw new Error('workflow-handoff currently supports comet-five-phase-overlay only.');
  }
  if (!nodeId) throw new Error(command + ' requires a Node id.');
  const node = findNode(protocol, nodeId);
  if (!node) throw new Error('Unknown workflow Node: ' + nodeId);
  const handoffBindings = (node.requiredSkillCalls ?? []).filter(
    (binding) => binding.scope === 'handoff' || binding.enforcement === 'handoff-guarded',
  );
  if (handoffBindings.length === 0) {
    throw new Error('Node ' + node.id + ' has no handoff-guarded Required Skill Call.');
  }
  const change = await resolveCometOverlayChange();
  const file = handoffPath(protocol, change, node);
  if (command === 'request') {
    const context = guardContext();
    const createdAt = new Date().toISOString();
    const request = {
      id: createHash('sha256')
        .update([protocol.name, change.name, node.id, createdAt].join('\0'))
        .digest('hex'),
      workflow: protocol.name,
      protocolHash: createHash('sha256').update(JSON.stringify(protocol)).digest('hex'),
      change: change.name,
      node: node.id,
      status: 'pending',
      requiredSkills: handoffBindings.map((binding) => binding.skill),
      codeStateHash: context.codeStateHash,
      draftHash: context.draftHash,
      createdAt,
    };
    request.requestDigest = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');
    await writeJsonAtomic(file, request);
    console.log('HANDOFF REQUEST: ' + request.id);
    console.log('REQUEST_ID: ' + request.id);
    console.log('REQUEST_DIGEST: ' + request.requestDigest);
    console.log('HANDOFF_SCOPE: handoff');
    console.log('NODE: ' + node.id);
    return;
  }
  if (command === 'accept') {
    let request;
    try {
      request = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      throw new Error('A matching handoff request is required before acceptance.');
    }
    if (
      request.status !== 'pending' ||
      request.change !== change.name ||
      request.node !== node.id ||
      request.protocolHash !== createHash('sha256').update(JSON.stringify(protocol)).digest('hex')
    ) {
      throw new Error('A matching handoff request is required before acceptance.');
    }
    const artifactPath = process.argv[4];
    if (!artifactPath) throw new Error('accept requires a structured return artifact path.');
    const context = guardContext();
    if (
      request.codeStateHash !== context.codeStateHash ||
      request.draftHash !== context.draftHash
    ) {
      throw new Error(
        'The handoff request is stale because the code state or Bundle draft changed; create a new request.',
      );
    }
    const absoluteArtifact = path.resolve(runRoot, artifactPath);
    const relativeArtifact = path.relative(runRoot, absoluteArtifact);
    if (relativeArtifact.startsWith('..') || path.isAbsolute(relativeArtifact)) {
      throw new Error('Handoff return artifact must stay inside the run root.');
    }
    let returnRaw;
    let returnRecord;
    try {
      returnRaw = await fs.readFile(absoluteArtifact);
      returnRecord = JSON.parse(returnRaw.toString('utf8'));
    } catch (error) {
      throw new Error(
        'Handoff return must be readable structured JSON: ' +
          String(error instanceof Error ? error.message : error),
      );
    }
    if (
      !returnRecord ||
      typeof returnRecord !== 'object' ||
      Array.isArray(returnRecord) ||
      returnRecord.requestId !== request.id ||
      returnRecord.requestDigest !== request.requestDigest ||
      returnRecord.handoffScope !== 'handoff'
    ) {
      throw new Error(
        'Handoff return requestId, requestDigest, or handoffScope does not match the pending request.',
      );
    }
    request.status = 'accepting';
    request.acceptToken = createHash('sha256')
      .update(
        [
          request.id,
          request.requestDigest,
          createHash('sha256').update(returnRaw).digest('hex'),
          new Date().toISOString(),
        ].join('\0'),
      )
      .digest('hex');
    await writeJsonAtomic(file, request);
    const receiptIds = [];
    for (const binding of handoffBindings) {
      const result = spawnSync(
        process.execPath,
        [
          path.join(__dirname, 'workflow-guard.mjs'),
          'receipt',
          node.id,
          binding.skill,
          artifactPath,
        ],
        {
          cwd: runRoot,
          env: {
            ...process.env,
            COMET_RUN_ROOT: runRoot,
            COMET_HANDOFF_ACCEPT_TOKEN: request.acceptToken,
          },
          encoding: 'utf8',
        },
      );
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.status !== 0) {
        request.status = 'pending';
        delete request.acceptToken;
        await writeJsonAtomic(file, request);
        throw new Error('Handoff return rejected for required Skill ' + binding.skill + '.');
      }
      const receiptId = /^RECEIPT:\s*(\S+)$/imu.exec(result.stdout)?.[1];
      if (!receiptId) {
        throw new Error('Handoff guard did not return a receipt id for ' + binding.skill + '.');
      }
      receiptIds.push(receiptId);
    }
    request.status = 'accepted';
    delete request.acceptToken;
    request.acceptedAt = new Date().toISOString();
    request.returnArtifact = relativeArtifact.replaceAll('\\', '/');
    request.returnArtifactSha256 = createHash('sha256').update(returnRaw).digest('hex');
    request.acceptedReceiptIds = receiptIds;
    await writeJsonAtomic(file, request);
    console.log('HANDOFF: accepted');
    console.log('REQUEST: ' + request.id);
    return;
  }
  if (command === 'status') {
    try {
      console.log(await fs.readFile(file, 'utf8'));
    } catch {
      console.log(JSON.stringify({ status: 'not-requested', node: node.id }, null, 2));
    }
    return;
  }
  throw new Error('Unknown command: ' + command);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCometChangeResolver } from './change-selection.mjs';

const command = process.argv[2] ?? 'status';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const runRoot = process.env.COMET_RUN_ROOT ? path.resolve(process.env.COMET_RUN_ROOT) : process.cwd();
const protocolPath = path.join(packageRoot, 'reference', 'workflow-protocol.json');
const { resolveCometOverlayChange } = createCometChangeResolver(runRoot);

function isCometOverlay(protocol) {
  return protocol.kind === 'comet-five-phase-overlay';
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

function generatedNodeSkillName(protocol, nodeId) {
  return (slug(protocol.name) || 'workflow') + '-' + (slug(nodeId) || 'node');
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

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
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

function printNext(protocol, node) {
  if (!node) {
    console.log('NEXT: done');
    return;
  }
  console.log('NEXT: auto');
  console.log('NODE: ' + node.id);
  console.log('SKILL: ' + generatedNodeSkillName(protocol, node.id));
}

function activeRemediation(evidence) {
  const ledger = overlayLedger(evidence);
  return (
    [...ledger.invalidations]
      .reverse()
      .find((entry) => entry.status === 'applying' || entry.status === 'retry') ?? null
  );
}

function remediationRetryCommand(from) {
  return (
    'node ' +
    JSON.stringify(path.join(packageRoot, 'scripts', 'workflow-guard.mjs')) +
    ' retry-remediation ' +
    from
  );
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

function printRemediation(protocol, remediation) {
  console.log('NEXT: retry-remediation');
  console.log('REMEDIATION: ' + remediation.transitionId);
  console.log('REMEDIATION_NODE: ' + remediation.to);
  console.log('NODE: ' + remediation.to);
  console.log('SKILL: ' + generatedNodeSkillName(protocol, remediation.to));
  console.log('RETRY: ' + remediationRetryCommand(remediation.from));
  if (remediation.lastError) console.log('LAST_ERROR: ' + remediation.lastError);
}

function parseEvidence(raw) {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { summary: raw };
  }
}

function unprivilegedEvidence(value) {
  const evidence = { ...value };
  delete evidence.completedChecks;
  delete evidence.receipts;
  delete evidence.__ledger;
  return evidence;
}

async function readState(protocol) {
  try {
    return await readJson(statePath(protocol));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error('Missing workflow state. Run workflow-state.mjs init first.');
    }
    throw error;
  }
}

async function main() {
  const protocol = await readJson(protocolPath);
  if (protocol.schemaVersion !== 1 || !Array.isArray(protocol.nodes)) {
    throw new Error('workflow-protocol.json must use the current schema with nodes');
  }
  if (isCometOverlay(protocol)) {
    if (command === 'init') {
      throw new Error(
        'Comet overlay state is created by /comet-open; use the permanent /comet-classic entry to start a change.',
      );
    }
    if (command === 'status') {
      try {
        const change = await resolveCometOverlayChange();
        const evidence = await readOverlayEvidence(protocol, change);
        const remediation = activeRemediation(evidence);
        const currentNode = validatedOverlayNode();
        console.log(
          JSON.stringify(
            {
              status: remediation ? remediation.status : 'running',
              change: change.name,
              statePath: change.statePath,
              currentNode,
              phase: change.state.phase ?? null,
              ...(remediation
                ? {
                    remediation: {
                      id: remediation.id,
                      transitionId: remediation.transitionId,
                      targetNode: remediation.to,
                      nextEventIndex: remediation.nextEventIndex ?? 0,
                      lastError: remediation.lastError ?? null,
                      retry: remediationRetryCommand(remediation.from),
                    },
                  }
                : {}),
            },
            null,
            2,
          ),
        );
      } catch (error) {
        console.log(
          JSON.stringify(
            { status: 'blocked', reason: error instanceof Error ? error.message : String(error) },
            null,
            2,
          ),
        );
      }
      return;
    }
    if (command === 'next') {
      const change = await resolveCometOverlayChange();
      const evidence = await readOverlayEvidence(protocol, change);
      const remediation = activeRemediation(evidence);
      if (remediation) {
        printRemediation(protocol, remediation);
        return;
      }
      const nodeId = validatedOverlayNode();
      printNext(protocol, route(protocol).find((node) => node.id === nodeId) ?? null);
      return;
    }
    if (command === 'record') {
      const nodeId = process.argv[3];
      if (!nodeId) throw new Error('record requires a Node id.');
      const node = route(protocol).find((item) => item.id === nodeId || generatedNodeSkillName(protocol, item.id) === nodeId);
      if (!node) throw new Error('Unknown workflow Node: ' + nodeId);
      const change = await resolveCometOverlayChange();
      const evidence = await readOverlayEvidence(protocol, change);
      const currentNode = validatedOverlayNode();
      if (currentNode !== node.id) {
        throw new Error(
          'Current Node is ' + String(currentNode) + '; cannot record ' + node.id + '.',
        );
      }
      const recordedEvidence = unprivilegedEvidence(parseEvidence(process.argv.slice(4).join(' ')));
      const sealedInventory = [...overlayLedger(evidence).segmentInventories]
        .reverse()
        .find(
          (entry) =>
            entry.node === node.id &&
            entry.change === change.name &&
            entry.status === 'sealed',
        );
      if (
        sealedInventory &&
        Object.prototype.hasOwnProperty.call(
          recordedEvidence.schemaEvidence ?? {},
          'implementation-segment-index',
        ) &&
        JSON.stringify(
          (Array.isArray(recordedEvidence.schemaEvidence['implementation-segment-index'])
            ? recordedEvidence.schemaEvidence['implementation-segment-index']
            : [recordedEvidence.schemaEvidence['implementation-segment-index']])
            .map((item) => String(item).trim())
            .filter(Boolean),
        ) !== JSON.stringify(sealedInventory.segmentIds)
      ) {
        throw new Error('Sealed implementation segment inventory cannot be changed or reduced.');
      }
      evidence[node.id] = {
        ...recordedEvidence,
        ...(sealedInventory ? { segmentInventoryId: sealedInventory.id } : {}),
        recordedAt: new Date().toISOString(),
      };
      await writeOverlayEvidence(protocol, change, evidence);
      console.log('EVIDENCE: ' + node.id);
      printNext(protocol, route(protocol).find((item) => item.id === validatedOverlayNode()) ?? null);
      return;
    }
    throw new Error('Unknown command: ' + command);
  }
  const file = statePath(protocol);
  if (command === 'init') {
    const node = nextNode(protocol, { completedNodes: [] });
    await writeJson(file, {
      schemaVersion: 1,
      workflow: protocol.name,
      status: node ? 'running' : 'completed',
      currentNode: node?.id ?? null,
      completedNodes: [],
      evidence: {},
      history: [],
    });
    printNext(protocol, node);
    return;
  }
  if (command === 'status') {
    try {
      console.log(JSON.stringify(await readJson(file), null, 2));
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        console.log(JSON.stringify({ status: 'not-started' }, null, 2));
        return;
      }
      throw error;
    }
    return;
  }
  if (command === 'next') {
    printNext(protocol, nextNode(protocol, await readState(protocol)));
    return;
  }
  if (command === 'record') {
    const nodeId = process.argv[3];
    if (!nodeId) throw new Error('record requires a Node id.');
    const node = route(protocol).find((item) => item.id === nodeId || generatedNodeSkillName(protocol, item.id) === nodeId);
    if (!node) throw new Error('Unknown workflow Node: ' + nodeId);
    const state = await readState(protocol);
    state.evidence = state.evidence && typeof state.evidence === 'object' ? state.evidence : {};
    state.history = Array.isArray(state.history) ? state.history : [];
    state.evidence[node.id] = {
      ...unprivilegedEvidence(parseEvidence(process.argv.slice(4).join(' '))),
      recordedAt: new Date().toISOString(),
    };
    state.history.push({ event: 'evidence-recorded', node: node.id, at: new Date().toISOString() });
    await writeJson(file, state);
    console.log('EVIDENCE: ' + node.id);
    printNext(protocol, nextNode(protocol, state));
    return;
  }
  throw new Error('Unknown command: ' + command);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

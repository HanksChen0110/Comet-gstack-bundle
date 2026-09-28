#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCometChangeResolver, parseSimpleYaml } from './change-selection.mjs';
import { readStructuredArtifact } from './structured-artifact.mjs';
import { checkSecondReview, checkStartApproval, checkWebQa, consumeRepairRound } from './workflow-policy.mjs';

const requestedCommand = process.argv[2] ?? 'context';
const command = requestedCommand === 'retry-remediation' ? 'exit' : requestedCommand;
const nodeId = process.argv[3] ?? null;
const apply =
  process.argv.includes('--apply') ||
  requestedCommand === 'authorize' ||
  requestedCommand === 'retry-remediation';
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
    return 'review';
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
  return protocol.nodes.filter((node) => !node.disabled);
}

function findNode(protocol, id) {
  return route(protocol).find((node) => node.id === id || generatedNodeSkillName(protocol, node.id) === id) ?? null;
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

function remediationRetryCommand(from) {
  return (
    'node ' +
    JSON.stringify(path.join(packageRoot, 'scripts', 'workflow-guard.mjs')) +
    ' retry-remediation ' +
    from
  );
}

function classicPhaseForOverlayNode(nodeId, classicState) {
  if (nodeId === 'open' || nodeId === 'design' || nodeId === 'verify') return nodeId;
  if (nodeId === 'review') return 'build';
  if (
    (nodeId === 'execute' || nodeId === 'subagent-execute') &&
    String(classicState.review_mode ?? 'off') === 'off'
  ) {
    return 'build';
  }
  return null;
}

function runClassicGuardApply(change, phase) {
  const executable =
    process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'comet';
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'comet.cmd', 'guard', change.name, phase, '--apply']
      : ['guard', change.name, phase, '--apply'];
  return spawnSync(executable, args, {
    cwd: runRoot,
    encoding: 'utf8',
    timeout: 600000,
  });
}

function evidenceFor(state, id) {
  const value = state.evidence && typeof state.evidence === 'object' ? state.evidence[id] : null;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nonEmptyStructured(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return !!(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function substantiveEvidence(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return !!(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function hasDedicatedStructuralSemantic(field) {
  return field === 'health-component-scores' || field === 'health-cross-change-trend';
}

function bindingFor(node, skill) {
  return [...(node.requiredSkillCalls ?? []), ...(node.augmentations ?? [])].find(
    (binding) => binding.skill === skill,
  );
}

function implementationSegmentIds(value) {
  const source =
    Array.isArray(value)
      ? value
      : value && typeof value === 'object' && !Array.isArray(value)
        ? value.completedSegments ?? value.segmentIds ?? []
        : [value];
  return [...new Set(
    source
      .filter((item) => typeof item === 'string' || typeof item === 'number')
      .map((item) => String(item).trim())
      .filter(Boolean),
  )];
}

function receiptFieldMatchesNode(node, field, value, nodeEvidence, allEvidence) {
  const expected = evidenceValue(nodeEvidence, field, allEvidence);
  if (node.id === 'execute' && field === 'implementation-segment-index') {
    const segments = implementationSegmentIds(expected);
    return segments.includes(String(value).trim());
  }
  return valuesEqual(value, expected);
}

function requiredCustomEvidenceIds(protocol, node, skill = null) {
  const schemas = schemaMap(protocol);
  const required = (node.outputSchemas ?? [])
    .filter((schemaId) => !String(schemaId).startsWith('comet.'))
    .flatMap((schemaId) => (schemas.get(schemaId)?.evidence ?? []))
    .filter((field) => field.required)
    .map((field) => field.id);
  if (!skill || (node.requiredSkillCalls ?? []).length <= 1) return required;
  if (skill === 'verification-gate') {
    return required.filter((field) => String(field).startsWith('verification-'));
  }
  if (skill === 'qa') {
    return required.filter((field) => !String(field).startsWith('verification-'));
  }
  return required;
}

async function receiptArtifactMatches(receipt) {
  try {
    const target = path.resolve(runRoot, receipt.artifactPath);
    const relative = path.relative(runRoot, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const raw = await fs.readFile(target);
    return createHash('sha256').update(raw).digest('hex') === receipt.artifactSha256;
  } catch {
    return false;
  }
}

function guardHandoffPath(protocol, change, node) {
  return path.join(
    runRoot,
    '.comet',
    'workflow-handoffs',
    change.name,
    protocol.name,
    node.id + '.json',
  );
}

async function handoffReceiptAccepted(protocol, change, node, receipt) {
  try {
    const request = JSON.parse(
      await fs.readFile(guardHandoffPath(protocol, change, node), 'utf8'),
    );
    return (
      request.status === 'accepted' &&
      request.id === receipt.handoffRequestId &&
      request.requestDigest === receipt.handoffRequestDigest &&
      (request.acceptedReceiptIds ?? []).includes(receipt.id)
    );
  } catch {
    return false;
  }
}

function receiptSchemaMatchesNode(protocol, node, receipt, allEvidence) {
  const schemaEvidence = receipt.schemaEvidence;
  if (!nonEmptyStructured(schemaEvidence)) return false;
  const nodeEvidence = evidenceFor({ evidence: allEvidence }, node.id);
  if (!nodeEvidence) return false;
  const alignedEntries = Object.entries(schemaEvidence).filter(([field]) =>
    hasEvidenceField(nodeEvidence, field),
  );
  if (
    alignedEntries.some(
      ([field, value]) =>
        !receiptFieldMatchesNode(node, field, value, nodeEvidence, allEvidence),
    )
  ) {
    return false;
  }
  const requiredCustom = new Set(requiredCustomEvidenceIds(protocol, node, receipt.skill));
  return (
    requiredCustom.size === 0 ||
    [...requiredCustom].every(
      (field) =>
        Object.prototype.hasOwnProperty.call(schemaEvidence, field) &&
        (
          substantiveEvidence(schemaEvidence[field]) ||
          hasDedicatedStructuralSemantic(field)
        ) &&
        hasEvidenceField(nodeEvidence, field) &&
        receiptFieldMatchesNode(
          node,
          field,
          schemaEvidence[field],
          nodeEvidence,
          allEvidence,
        ),
    )
  );
}

async function validReceipts(protocol, node, allEvidence, change = null) {
  const ledger = overlayLedger(allEvidence);
  const protocolHash = currentProtocolHash(protocol);
  const codeStateHash = await currentCodeStateHash();
  const draftHash = await currentBundleDraftHash(protocol);
  let specDigest = null;
  if (!['open', 'design'].includes(node.id) && change) {
    try { specDigest = (await checkStartApproval(change.name, { budget: false })).specDigest; }
    catch { return []; }
  }
  const invalidatedReceiptIds = new Set(
    ledger.invalidations.flatMap((entry) => entry.receiptIds ?? []),
  );
  const accepted = [];
  for (const receipt of ledger.receipts) {
    const binding = receipt ? bindingFor(node, receipt.skill) : null;
    if (
      !receipt ||
      !binding ||
      receipt.node !== node.id ||
      receipt.change !== (change?.name ?? receipt.change) ||
      receipt.protocolHash !== protocolHash ||
      receipt.codeStateHash !== codeStateHash ||
      receipt.draftHash !== draftHash ||
      (specDigest !== null && receipt.specDigest !== specDigest) ||
      receipt.scope !== binding.scope ||
      receipt.enforcement !== binding.enforcement ||
      receipt.status !== 'passed' ||
      invalidatedReceiptIds.has(receipt.id) ||
      !receiptSchemaMatchesNode(protocol, node, receipt, allEvidence) ||
      (
        binding.enforcement === 'handoff-guarded' &&
        (!change || !(await handoffReceiptAccepted(protocol, change, node, receipt)))
      ) ||
      !(await receiptArtifactMatches(receipt))
    ) {
      continue;
    }
    accepted.push(receipt);
  }
  return accepted;
}

async function validGuardResults(protocol, change, allEvidence) {
  const ledger = overlayLedger(allEvidence);
  const protocolHash = currentProtocolHash(protocol);
  const codeStateHash = await currentCodeStateHash();
  const draftHash = await currentBundleDraftHash(protocol);
  let approvedSpecDigest = null;
  try { approvedSpecDigest = (await checkStartApproval(change.name, { budget: false })).specDigest; }
  catch { /* design/open may precede approval */ }
  const invalidatedGuardIds = new Set(
    ledger.invalidations.flatMap((entry) => entry.guardResultIds ?? []),
  );
  const accepted = new Map();
  for (const result of ledger.guardResults) {
    const node = protocol.nodes.find((item) => item.id === result?.node);
    if (
      !node ||
      result.status !== 'passed' ||
      result.change !== change.name ||
      result.protocolHash !== protocolHash ||
      result.codeStateHash !== codeStateHash ||
      result.draftHash !== draftHash ||
      (!['open', 'design'].includes(node.id) && result.specDigest !== approvedSpecDigest) ||
      invalidatedGuardIds.has(result.id)
    ) {
      continue;
    }
    const latestInvalidation =
      [...ledger.invalidations]
        .reverse()
        .find(
          (entry) =>
            entry.status === 'applied' &&
            (
              entry.from === node.id ||
              (entry.invalidatedNodes ?? []).includes(node.id)
            ),
        ) ?? null;
    if (
      (latestInvalidation && result.chainId !== latestInvalidation.id) ||
      (!latestInvalidation && result.chainId)
    ) {
      continue;
    }
    const receipts = await validReceipts(protocol, node, allEvidence, change);
    const validReceiptIds = new Set(receipts.map((receipt) => receipt.id));
    if (!(result.receiptIds ?? []).every((receiptId) => validReceiptIds.has(receiptId))) {
      continue;
    }
    const requiredChecks = [
      ...(node.requiredSkillCalls ?? []).map(
        (binding) => 'required-skill:' + node.id + '.' + binding.skill,
      ),
      ...(node.augmentations ?? [])
        .filter((binding) => binding.enforcement && binding.enforcement !== 'advisory')
        .map((binding) => 'augmentation:' + node.id + '.' + binding.skill),
    ];
    const receiptChecks = new Set(receipts.map((receipt) => receipt.check));
    if (!requiredChecks.every((check) => receiptChecks.has(check))) continue;
    const nodeEvidence = evidenceFor({ evidence: allEvidence }, node.id);
    if (!nodeEvidence) continue;
    if (missingRequiredSchemaEvidence(protocol, node, nodeEvidence, allEvidence).length > 0) {
      continue;
    }
    if (
      (await invalidRequiredArtifacts(
        protocol,
        node,
        nodeEvidence,
        allEvidence,
        change,
      )).length > 0
    ) {
      continue;
    }
    if (
      (await semanticRuleFailures(
        protocol,
        node,
        nodeEvidence,
        allEvidence,
        change,
      )).length > 0
    ) {
      continue;
    }
    const currentArtifactSnapshots = await requiredArtifactSnapshots(protocol, node, change);
    const recordedArtifactSnapshots = Array.isArray(result.artifactSnapshots)
      ? result.artifactSnapshots
      : [];
    if (!valuesEqual(recordedArtifactSnapshots, currentArtifactSnapshots)) continue;
    accepted.set(node.id, result);
  }
  return accepted;
}

async function validGuardNodeIds(protocol, change, allEvidence) {
  return new Set((await validGuardResults(protocol, change, allEvidence)).keys());
}

async function currentOverlayNode(protocol, change, allEvidence) {
  const validResults = await validGuardResults(protocol, change, allEvidence);
  if (String(change.state.phase ?? '') === 'build') {
    const remediation =
      [...overlayLedger(allEvidence).invalidations]
        .reverse()
        .find((entry) => isFullRecoveryInvalidation(entry)) ?? null;
    if (remediation) {
      for (const requiredNodeId of ['execute', 'review']) {
        const requiredNode = protocol.nodes.find(
          (candidate) => candidate.id === requiredNodeId && !candidate.disabled,
        );
        if (requiredNode && !validResults.has(requiredNodeId)) {
          return requiredNodeId;
        }
      }
      if (protocol.nodes.some((candidate) => candidate.id === 'verify' && !candidate.disabled)) {
        return 'verify';
      }
    }
  }
  return overlayNodeFromState(
    change.state,
    allEvidence,
    new Set(validResults.keys()),
  );
}

function remediationRequiresClassicBuildAdvance(change, allEvidence, nodeId, routedNodeId) {
  if (
    nodeId !== 'review' ||
    routedNodeId !== 'verify' ||
    String(change.state.phase ?? '') !== 'build' ||
    String(change.state.review_mode ?? 'off') !== 'off'
  ) {
    return false;
  }
  return [...overlayLedger(allEvidence).invalidations]
    .reverse()
    .some((entry) => isFullRecoveryInvalidation(entry));
}

async function currentVerifyAuthorization(protocol, change, allEvidence) {
  const verifyNode = protocol.nodes.find((item) => item.id === 'verify');
  const requiredSkills = new Set(
    (verifyNode?.requiredSkillCalls ?? []).map((binding) => binding.skill),
  );
  if (!verifyNode || !requiredSkills.has('verification-gate')) {
    throw new Error('Verify protocol must require verification-gate.');
  }
  const verifyEvidence = evidenceFor({ evidence: allEvidence }, 'verify');
  if (!verifyEvidence) throw new Error('Current ledger-backed verify evidence is missing.');
  const receipts = await validReceipts(protocol, verifyNode, allEvidence, change);
  const gateReceipt = [...receipts]
    .reverse()
    .find((receipt) => receipt.skill === 'verification-gate');
  if (!gateReceipt) throw new Error('Current verification-gate receipt is missing or invalid.');
  const missingCoverage = missingReceiptSchemaCoverage(
    protocol,
    verifyNode,
    receipts,
    allEvidence,
  );
  if (missingCoverage.length > 0) {
    throw new Error(
      'Current verify receipts do not cover Output Schema: ' + missingCoverage.join(', '),
    );
  }
  const invalidArtifacts = await invalidRequiredArtifacts(
    protocol,
    verifyNode,
    verifyEvidence,
    allEvidence,
    change,
  );
  if (invalidArtifacts.length > 0) {
    throw new Error(
      'Current verify Output Schema artifacts are invalid: ' + invalidArtifacts.join(', '),
    );
  }
  const semanticFailures = await semanticRuleFailures(
    protocol,
    verifyNode,
    verifyEvidence,
    allEvidence,
    change,
  );
  if (semanticFailures.length > 0) {
    throw new Error(
      'Current verify semantic evidence is invalid: ' +
        semanticFailures.map((failure) => failure.ruleId).join(', '),
    );
  }
  const verifyGuard = (await validGuardResults(protocol, change, allEvidence)).get('verify');
  if (!verifyGuard) {
    throw new Error('Current verify Guard result is missing or stale.');
  }
  if (!(verifyGuard.receiptIds ?? []).includes(gateReceipt.id)) {
    throw new Error('Current verify Guard result is not bound to the verification receipt.');
  }
  const artifactSnapshots = Array.isArray(verifyGuard.artifactSnapshots)
    ? verifyGuard.artifactSnapshots
    : [];
  return {
    guardResultId: verifyGuard.id,
    receiptIds: [gateReceipt.id],
    reportDigests: [gateReceipt.reportDigest],
    artifactSnapshots,
    snapshotDigest: createHash('sha256')
      .update(JSON.stringify(artifactSnapshots))
      .digest('hex'),
  };
}

function missingReceiptSchemaCoverage(protocol, node, receipts, allEvidence) {
  if ((node.requiredSkillCalls ?? []).length <= 1) return [];
  const nodeEvidence = evidenceFor({ evidence: allEvidence }, node.id);
  if (!nodeEvidence) return requiredCustomEvidenceIds(protocol, node);
  const priorInvalidation = latestAppliedInvalidation(allEvidence, node.id);
  return requiredCustomEvidenceIds(protocol, node).filter((field) => {
    if (
      field === 'ordered-gates-rerun-after-remediation' &&
      node.id === 'verify' &&
      !priorInvalidation
    ) {
      return false;
    }
    return !receipts.some((receipt) => {
      if (!requiredCustomEvidenceIds(protocol, node, receipt.skill).includes(field)) {
        return false;
      }
      return (
        Object.prototype.hasOwnProperty.call(receipt.schemaEvidence ?? {}, field) &&
        substantiveEvidence(receipt.schemaEvidence[field]) &&
        receiptFieldMatchesNode(
          node,
          field,
          receipt.schemaEvidence[field],
          nodeEvidence,
          allEvidence,
        )
      );
    });
  });
}

function implementationSegmentCoverageFailures(protocol, node, receipts, allEvidence) {
  if (
    node.id !== 'execute' ||
    !requiredCustomEvidenceIds(protocol, node).includes('implementation-segment-index')
  ) return [];
  const nodeEvidence = evidenceFor({ evidence: allEvidence }, node.id);
  const ledger = overlayLedger(allEvidence);
  const inventory = [...ledger.segmentInventories]
    .reverse()
    .find(
      (entry) =>
        entry.id === nodeEvidence?.segmentInventoryId &&
        entry.node === 'execute' &&
        entry.status === 'sealed' &&
        entry.protocolHash === currentProtocolHash(protocol),
    );
  const expected = implementationSegmentIds(inventory?.segmentIds);
  const reviewReceipts = receipts.filter(
    (receipt) => receipt.check === 'required-skill:execute.review',
  );
  const reviewed = reviewReceipts.flatMap((receipt) =>
    implementationSegmentIds(receipt.schemaEvidence?.['implementation-segment-index']),
  );
  const uniqueReviewed = [...new Set(reviewed)];
  const duplicateSegments = reviewed.filter(
    (segment, index) => reviewed.indexOf(segment) !== index,
  );
  const reportDigests = reviewReceipts.map((receipt) => receipt.reportDigest);
  const failures = [];
  if (!inventory || expected.length === 0) {
    failures.push('implementation-segment-inventory-unsealed');
  }
  if (
    inventory &&
    reviewReceipts.some(
      (receipt) =>
        receipt.codeStateHash !== inventory.codeStateHash ||
        receipt.draftHash !== inventory.draftHash,
    )
  ) {
    failures.push('implementation-segment-inventory-stale');
  }
  if (
    expected.length !== uniqueReviewed.length ||
    expected.some((segment) => !uniqueReviewed.includes(segment))
  ) {
    failures.push('implementation-segment-review-coverage');
  }
  if (duplicateSegments.length > 0) failures.push('implementation-segment-review-duplicate');
  if (new Set(reportDigests).size !== reportDigests.length) {
    failures.push('implementation-segment-report-digest-duplicate');
  }
  return failures;
}

async function validReceiptChecks(protocol, node, allEvidence, change = null) {
  return new Set(
    (await validReceipts(protocol, node, allEvidence, change)).map((receipt) => receipt.check),
  );
}

async function missingRequiredSkillChecks(protocol, node, allEvidence, change = null) {
  const values = await validReceiptChecks(protocol, node, allEvidence, change);
  return (node.requiredSkillCalls ?? [])
    .map((binding) => 'required-skill:' + node.id + '.' + binding.skill)
    .filter((check) => !values.has(check));
}

async function missingAugmentationChecks(protocol, node, allEvidence, change = null) {
  const values = await validReceiptChecks(protocol, node, allEvidence, change);
  return (node.augmentations ?? [])
    .filter((binding) => binding.enforcement && binding.enforcement !== 'advisory')
    .map((binding) => 'augmentation:' + node.id + '.' + binding.skill)
    .filter((check) => !values.has(check));
}

function hasEvidenceField(evidence, id) {
  if (Object.prototype.hasOwnProperty.call(evidence, id)) return true;
  const schemaEvidence = evidence.schemaEvidence;
  return !!(
    schemaEvidence &&
    typeof schemaEvidence === 'object' &&
    !Array.isArray(schemaEvidence) &&
    Object.prototype.hasOwnProperty.call(schemaEvidence, id)
  );
}

function schemaMap(protocol) {
  return new Map((protocol.outputSchemas ?? []).map((schema) => [schema.id, schema]));
}

function latestAppliedInvalidation(allEvidence, nodeId) {
  const ledger = overlayLedger(allEvidence);
  return (
    [...ledger.invalidations]
      .reverse()
      .find(
        (entry) =>
          entry.status === 'applied' &&
          (entry.from === nodeId || (entry.invalidatedNodes ?? []).includes(nodeId)),
      ) ?? null
  );
}

function isFullRecoveryInvalidation(entry) {
  const invalidatedNodes = new Set(entry?.invalidatedNodes ?? []);
  return (
    entry?.status === 'applied' &&
    entry?.to === 'execute' &&
    invalidatedNodes.has('execute') &&
    invalidatedNodes.has('review') &&
    invalidatedNodes.has('verify')
  );
}

function missingRequiredSchemaEvidence(protocol, node, evidence, allEvidence) {
  const schemas = schemaMap(protocol);
  const missing = [];
  const priorInvalidation = latestAppliedInvalidation(allEvidence, node.id);
  for (const schemaId of node.outputSchemas ?? []) {
    const schema = schemas.get(schemaId);
    for (const field of schema?.evidence ?? []) {
      if (
        field.id === 'ordered-gates-rerun-after-remediation' &&
        node.id === 'verify' &&
        !priorInvalidation
      ) {
        continue;
      }
      if (
        field.required &&
        (
          !hasEvidenceField(evidence, field.id) ||
          (
            !substantiveEvidence(evidenceValue(evidence, field.id, allEvidence)) &&
            !hasDedicatedStructuralSemantic(field.id)
          )
        )
      ) {
        missing.push(schemaId + '.' + field.id);
      }
    }
  }
  return missing;
}

function evidenceValue(evidence, id, allEvidence) {
  const separator = String(id).indexOf('.');
  let source = evidence;
  let fieldId = id;
  if (separator > 0) {
    const nodeId = String(id).slice(0, separator);
    const candidate = allEvidence && typeof allEvidence === 'object' ? allEvidence[nodeId] : null;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      source = candidate;
      fieldId = String(id).slice(separator + 1);
    }
  }
  if (Object.prototype.hasOwnProperty.call(source, fieldId)) return source[fieldId];
  const schemaEvidence = source.schemaEvidence;
  if (
    schemaEvidence &&
    typeof schemaEvidence === 'object' &&
    !Array.isArray(schemaEvidence) &&
    Object.prototype.hasOwnProperty.call(schemaEvidence, fieldId)
  ) {
    return schemaEvidence[fieldId];
  }
  return undefined;
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function gitOutput(args) {
  const result = spawnSync('git', args, {
    cwd: runRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      'Cannot calculate current code state hash: git ' +
        args.join(' ') +
        ' failed: ' +
        String(result.stderr || result.error?.message || 'unknown error').trim(),
    );
  }
  return result.stdout;
}

function gitAttempt(args) {
  return spawnSync('git', args, {
    cwd: runRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function excludedFromCodeState(relative) {
  const normalized = String(relative).replaceAll('\\', '/');
  return (
    normalized === '.comet' ||
    normalized.startsWith('.comet/') ||
    normalized.startsWith('openspec/changes/') ||
    normalized.startsWith('docs/superpowers/reports/')
  );
}

async function currentCodeStateHash() {
  const hash = createHash('sha256');
  if (gitOutput(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
    throw new Error('Cannot calculate current code state hash: run root is not a Git work tree.');
  }
  const files = [...new Set([
    ...gitOutput(['ls-files', '-z']).split('\0').filter(Boolean),
    ...gitOutput(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean),
  ])]
    .filter((relative) => !excludedFromCodeState(relative))
    .sort();
  for (const relative of files) {
    const file = path.join(runRoot, relative);
    hash.update('FILE\0' + relative.replaceAll('\\', '/') + '\0');
    try { hash.update(await fs.readFile(file)); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      hash.update('DELETED');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function currentProtocolHash(protocol) {
  return createHash('sha256').update(JSON.stringify(protocol)).digest('hex');
}

async function currentBundleDraftHash(protocol) {
  try {
    const manifest = await fs.readFile(path.join(packageRoot, 'comet', 'eval.yaml'), 'utf8');
    const match = /^\s*draftHash:\s*["']?([a-f0-9]{64})["']?\s*$/imu.exec(manifest);
    if (match) return match[1];
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
  }
  return currentProtocolHash(protocol);
}

async function semanticRuleFailures(protocol, node, evidence, allEvidence, change = null) {
  const schemas = schemaMap(protocol);
  const failures = [];
  let codeHash;
  const draftHash = await currentBundleDraftHash(protocol);
  const priorInvalidation = latestAppliedInvalidation(allEvidence, node.id);
  for (const schemaId of node.outputSchemas ?? []) {
    const schema = schemas.get(schemaId);
    for (const rule of schema?.semanticRules ?? []) {
      if (
        rule.id === 'ordered-gates-must-be-current-after-remediation' &&
        node.id === 'verify' &&
        !priorInvalidation
      ) {
        continue;
      }
      const fields = rule.field ? [rule.field] : (rule.fields ?? []);
      const values = fields.map((field) => evidenceValue(evidence, field, allEvidence));
      let passed = false;
      if (rule.operator === 'equals') {
        passed = values.length === 1 && valuesEqual(values[0], rule.value);
      } else if (rule.operator === 'not-equals') {
        passed = values.length === 1 && !valuesEqual(values[0], rule.value);
      } else if (rule.operator === 'same') {
        passed = values.length >= 2 && values.every((value) => valuesEqual(value, values[0]));
      } else if (rule.operator === 'before') {
        const earlier = Date.parse(String(values[0] ?? ''));
        const later = Date.parse(String(values[1] ?? ''));
        passed = values.length === 2 && Number.isFinite(earlier) && Number.isFinite(later) && earlier < later;
      } else if (rule.operator === 'matches-current-code') {
        codeHash = codeHash ?? (await currentCodeStateHash());
        passed = values.length > 0 && values.every((value) => value === codeHash);
      } else if (rule.operator === 'matches-protocol') {
        passed = values.length > 0 && values.every((value) => value === draftHash);
      } else if (rule.operator === 'number-at-least') {
        passed = values.length === 1 && typeof values[0] === 'number' && values[0] >= Number(rule.value);
      }
      if (!passed) {
        failures.push({
          schemaId,
          ruleId: rule.id,
          operator: rule.operator,
          remediation: rule.remediation ?? null,
        });
      }
    }
  }
  if (node.id === 'verify' && priorInvalidation) {
    const ledger = overlayLedger(allEvidence);
    const codeStateHash = await currentCodeStateHash();
    const requiredChecks = ['execute', 'review', 'verify'].flatMap((requiredNodeId) => {
      const requiredNode = protocol.nodes.find((item) => item.id === requiredNodeId);
      const invalidation = latestAppliedInvalidation(allEvidence, requiredNodeId);
      const boundary = invalidation
        ? Date.parse(String(invalidation.appliedAt ?? invalidation.createdAt ?? ''))
        : 0;
      return (requiredNode?.requiredSkillCalls ?? []).map((binding) => ({
        check: 'required-skill:' + requiredNodeId + '.' + binding.skill,
        nodeId: requiredNodeId,
        chainId: invalidation?.id ?? null,
        boundary,
      }));
    });
    const invalidatedReceiptIds = new Set(
      ledger.invalidations.flatMap((entry) => entry.receiptIds ?? []),
    );
    const freshReceipts = [];
    for (const requirement of requiredChecks) {
      const receipt = ledger.receipts.find(
        (candidate) =>
          candidate.check === requirement.check &&
          (
            requirement.chainId
              ? candidate.chainId === requirement.chainId
              : !candidate.chainId
          ) &&
          candidate.change === (change?.name ?? candidate.change) &&
          candidate.protocolHash === currentProtocolHash(protocol) &&
          candidate.codeStateHash === codeStateHash &&
          candidate.draftHash === draftHash &&
          candidate.status === 'passed' &&
          !invalidatedReceiptIds.has(candidate.id) &&
          Number.isFinite(requirement.boundary) &&
          Date.parse(String(candidate.mintedAt ?? '')) > requirement.boundary,
      );
      if (receipt && (await receiptArtifactMatches(receipt))) freshReceipts.push(receipt);
    }
    const ordered =
      freshReceipts.length === requiredChecks.length &&
      freshReceipts.every(
        (receipt, index) =>
          receipt.check === requiredChecks[index].check &&
          (index === 0 ||
            Date.parse(freshReceipts[index - 1].mintedAt) < Date.parse(receipt.mintedAt)),
      );
    const requiredGuardNodes = ['execute', 'review'].filter((requiredNodeId) =>
      requiredChecks.some((requirement) =>
        requirement.check.startsWith('required-skill:' + requiredNodeId + '.'),
      ),
    );
    const guardSequence = requiredGuardNodes.map((requiredNodeId) => {
      const invalidation = latestAppliedInvalidation(allEvidence, requiredNodeId);
      const boundary = invalidation
        ? Date.parse(String(invalidation.appliedAt ?? invalidation.createdAt ?? ''))
        : 0;
      return [...ledger.guardResults]
        .reverse()
        .find(
          (result) =>
            result.node === requiredNodeId &&
            result.status === 'passed' &&
            (
              invalidation
                ? result.chainId === invalidation.id
                : !result.chainId
            ) &&
            result.change === (change?.name ?? result.change) &&
            result.protocolHash === currentProtocolHash(protocol) &&
            result.codeStateHash === codeStateHash &&
            result.draftHash === draftHash &&
            Date.parse(String(result.mintedAt ?? '')) > boundary &&
            freshReceipts
              .filter((receipt) => receipt.node === requiredNodeId)
              .every((receipt) => (result.receiptIds ?? []).includes(receipt.id)),
        );
    });
    const guardsOrdered =
      guardSequence.every(Boolean) &&
      guardSequence.every(
        (result, index) =>
          index === 0 ||
          Date.parse(guardSequence[index - 1].mintedAt) < Date.parse(result.mintedAt),
      );
    if (!ordered || !guardsOrdered) {
      const present = new Set(freshReceipts.map((receipt) => receipt.check));
      const missingFresh = requiredChecks
        .map((requirement) => requirement.check)
        .filter((check) => !present.has(check));
      failures.push({
        schemaId: 'remediation-chain',
        ruleId:
          'fresh-execute-review-verification-required:' +
          (missingFresh.length > 0 ? missingFresh.join('|') : 'ordered-guard-success'),
        operator: 'causal-after',
        remediation: 'verify-qa-invalidated',
      });
    }
  }
  if (node.id === 'archive') {
    const componentScores = evidenceValue(evidence, 'health-component-scores', allEvidence);
    const trend = evidenceValue(evidence, 'health-cross-change-trend', allEvidence);
    if (
      componentScores !== undefined &&
      (!componentScores ||
        typeof componentScores !== 'object' ||
        Array.isArray(componentScores) ||
        Object.keys(componentScores).length === 0 ||
        !Object.values(componentScores).every(
          (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
        ))
    ) {
      failures.push({
        schemaId: 'archive-health',
        ruleId: 'health-component-scores-substantive',
        operator: 'structured-numeric',
        remediation: 'archive-quality-blocked',
      });
    }
    const flatTrend =
      trend &&
      typeof trend === 'object' &&
      !Array.isArray(trend) &&
      typeof trend.baselineChangeId === 'string' &&
      trend.baselineChangeId.trim().length > 0 &&
      typeof trend.currentChangeId === 'string' &&
      trend.currentChangeId.trim().length > 0 &&
      trend.baselineChangeId !== trend.currentChangeId &&
      typeof trend.baselineScore === 'number' &&
      Number.isFinite(trend.baselineScore) &&
      typeof trend.currentScore === 'number' &&
      Number.isFinite(trend.currentScore) &&
      Number.isFinite(Date.parse(String(trend.observedAt ?? '')));
    const observationTrend =
      trend &&
      typeof trend === 'object' &&
      !Array.isArray(trend) &&
      Array.isArray(trend.observations) &&
      trend.observations.length >= 2 &&
      new Set(trend.observations.map((item) => item?.changeId)).size >= 2 &&
      trend.observations.every(
        (item) =>
          item &&
          typeof item.changeId === 'string' &&
          item.changeId.trim().length > 0 &&
          typeof item.score === 'number' &&
          Number.isFinite(item.score) &&
          Number.isFinite(Date.parse(String(item.observedAt ?? ''))),
      );
    if (trend !== undefined && !flatTrend && !observationTrend) {
      failures.push({
        schemaId: 'archive-health',
        ruleId: 'health-cross-change-trend-substantive',
        operator: 'cross-change-observations',
        remediation: 'archive-quality-blocked',
      });
    }
  }
  return failures;
}

async function currentClassicState(change) {
  return parseSimpleYaml(await fs.readFile(change.statePath, 'utf8'));
}

function classicEventPostcondition(event, state) {
  const phase = String(state.phase ?? '');
  if (event === 'verify-fail') return phase === 'build';
  if (event === 'archive-reopen') return phase === 'verify';
  return false;
}

async function applyOverlayRemediation(protocol, change, node, failures) {
  const requested = new Set(failures.map((failure) => failure.remediation).filter(Boolean));
  const existingEvidence = await readOverlayEvidence(protocol, change);
  const pendingTransitionIds = new Set(
    overlayLedger(existingEvidence).invalidations
      .filter((entry) => entry.status === 'applying' || entry.status === 'retry')
      .map((entry) => entry.transitionId),
  );
  const transitions = (protocol.remediationTransitions ?? []).filter(
    (transition) =>
      transition.from === node.id &&
      (
        transition.onFailure === true ||
        requested.has(transition.id) ||
        pendingTransitionIds.has(transition.id)
      ),
  );
  const applied = [];
  for (const transition of transitions) {
    let overlayEvidence = await readOverlayEvidence(protocol, change);
    let ledger = overlayLedger(overlayEvidence);
    let invalidation =
      [...ledger.invalidations]
        .reverse()
        .find(
          (entry) =>
            entry.transitionId === transition.id &&
            (entry.status === 'applying' || entry.status === 'retry'),
        ) ?? null;
    if (!invalidation) {
      if (transition.to === 'execute' && transition.from !== 'execute') {
        await consumeRepairRound(change.name);
      }
      const invalidatedNodes = transition.invalidateEvidence ?? [];
      const invalidatedEvidence = {};
      for (const evidenceNode of invalidatedNodes) {
        if (overlayEvidence[evidenceNode] !== undefined) {
          invalidatedEvidence[evidenceNode] = overlayEvidence[evidenceNode];
          delete overlayEvidence[evidenceNode];
        }
      }
      const receiptIds = ledger.receipts
        .filter((receipt) => invalidatedNodes.includes(receipt.node))
        .map((receipt) => receipt.id);
      const invalidatedGuardResults = ledger.guardResults.filter((result) =>
        invalidatedNodes.includes(result.node),
      );
      const guardResultIds = invalidatedGuardResults.map((result) => result.id);
      ledger.guardResults = ledger.guardResults.filter(
        (result) => !invalidatedNodes.includes(result.node),
      );
      const createdAt = new Date().toISOString();
      invalidation = {
        id: createHash('sha256')
          .update(
            [
              protocol.name,
              change.name,
              transition.id,
              createdAt,
              JSON.stringify(failures),
            ].join('\0'),
          )
          .digest('hex'),
        transitionId: transition.id,
        change: change.name,
        from: transition.from,
        to: transition.to,
        failures,
        invalidatedNodes,
        invalidatedEvidence,
        receiptIds,
        guardResultIds,
        invalidatedGuardResults,
        codeStateHash: await currentCodeStateHash(),
        draftHash: await currentBundleDraftHash(protocol),
        status: 'applying',
        nextEventIndex: 0,
        events: (transition.overlayEvents ?? []).map((event, index) => ({
          index,
          event,
          status: 'pending',
          attempts: 0,
        })),
        lastError: null,
        createdAt,
      };
      ledger.invalidations.push(invalidation);
      await writeOverlayEvidence(protocol, change, overlayEvidence);
    }
    const events = transition.overlayEvents ?? [];
    for (
      let eventIndex = Number(invalidation.nextEventIndex ?? 0);
      eventIndex < events.length;
      eventIndex += 1
    ) {
      const event = events[eventIndex];
      overlayEvidence = await readOverlayEvidence(protocol, change);
      ledger = overlayLedger(overlayEvidence);
      invalidation = ledger.invalidations.find((entry) => entry.id === invalidation.id);
      if (!invalidation) throw new Error('Overlay remediation ledger entry disappeared.');
      invalidation.status = 'applying';
      invalidation.lastError = null;
      invalidation.nextEventIndex = eventIndex;
      invalidation.events = Array.isArray(invalidation.events)
        ? invalidation.events
        : events.map((item, index) => ({
            index,
            event: item,
            status: 'pending',
            attempts: 0,
          }));
      const eventState = invalidation.events[eventIndex];
      const classicState = await currentClassicState(change);
      if (eventState?.status !== 'succeeded' && classicEventPostcondition(event, classicState)) {
        eventState.status = 'succeeded';
        eventState.reconciledAt = new Date().toISOString();
        invalidation.nextEventIndex = eventIndex + 1;
        invalidation.updatedAt = new Date().toISOString();
        await writeOverlayEvidence(protocol, change, overlayEvidence);
        continue;
      }
      if (eventState) {
        eventState.status = 'applying';
        eventState.attempts = Number(eventState.attempts ?? 0) + 1;
        eventState.attemptedAt = new Date().toISOString();
      }
      await writeOverlayEvidence(protocol, change, overlayEvidence);
      const executable =
        process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'comet';
      const eventArgs =
        process.platform === 'win32'
          ? ['/d', '/s', '/c', 'comet.cmd', 'state', 'transition', change.name, event]
          : ['state', 'transition', change.name, event];
      const bypassToken = createHash('sha256')
        .update(
          [
            protocol.name,
            change.name,
            invalidation.id,
            event,
            String(eventState?.attempts ?? 0),
            new Date().toISOString(),
            String(process.pid),
          ].join('\0'),
        )
        .digest('hex');
      const bypassPath = path.join(
        runRoot,
        '.comet',
        'workflow-internal-bypass',
        bypassToken + '.json',
      );
      await fs.mkdir(path.dirname(bypassPath), { recursive: true });
      await fs.writeFile(
        bypassPath,
        JSON.stringify(
          {
            token: bypassToken,
            protocol: protocol.name,
            protocolHash: currentProtocolHash(protocol),
            invalidationId: invalidation.id,
            transitionId: transition.id,
            change: change.name,
            event,
            eventIndex,
            status: 'pending',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      const result = spawnSync(executable, eventArgs, {
        cwd: runRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          COMET_OVERLAY_INTERNAL_BYPASS_TOKEN: bypassToken,
        },
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.status !== 0) {
        const errorMessage =
          'Overlay remediation ' +
          transition.id +
            ' failed while applying ' +
            event +
            ': ' +
          String(result.error?.message || 'exit ' + result.status);
        const reconciledClassicState = await currentClassicState(change);
        overlayEvidence = await readOverlayEvidence(protocol, change);
        ledger = overlayLedger(overlayEvidence);
        invalidation = ledger.invalidations.find((entry) => entry.id === invalidation.id);
        if (invalidation && classicEventPostcondition(event, reconciledClassicState)) {
          invalidation.status = 'applying';
          invalidation.nextEventIndex = eventIndex + 1;
          invalidation.lastError = null;
          invalidation.updatedAt = new Date().toISOString();
          if (Array.isArray(invalidation.events) && invalidation.events[eventIndex]) {
            invalidation.events[eventIndex].status = 'succeeded';
            invalidation.events[eventIndex].reconciledAt = new Date().toISOString();
            invalidation.events[eventIndex].lastError = null;
          }
          await writeOverlayEvidence(protocol, change, overlayEvidence);
          continue;
        }
        if (invalidation) {
          invalidation.status = 'retry';
          invalidation.nextEventIndex = eventIndex;
          invalidation.lastError = errorMessage;
          invalidation.failedEvent = event;
          invalidation.updatedAt = new Date().toISOString();
          if (Array.isArray(invalidation.events) && invalidation.events[eventIndex]) {
            invalidation.events[eventIndex].status = 'failed';
            invalidation.events[eventIndex].lastError = errorMessage;
          }
        }
        await writeOverlayEvidence(protocol, change, overlayEvidence);
        console.error('REMEDIATION RETRY: ' + errorMessage);
        console.log('NEXT: retry-remediation');
        console.log('REMEDIATION_NODE: ' + transition.to);
        console.log('NODE: ' + transition.to);
        console.log('SKILL: ' + generatedNodeSkillName(protocol, transition.to));
        console.log('RETRY: ' + remediationRetryCommand(transition.from));
        return applied;
      }
      const reconciledClassicState = await currentClassicState(change);
      if (!classicEventPostcondition(event, reconciledClassicState)) {
        const errorMessage =
          'Overlay remediation ' +
          transition.id +
          ' exited 0 while applying ' +
          event +
          ' without satisfying the Classic state postcondition.';
        overlayEvidence = await readOverlayEvidence(protocol, change);
        ledger = overlayLedger(overlayEvidence);
        invalidation = ledger.invalidations.find((entry) => entry.id === invalidation.id);
        if (invalidation) {
          invalidation.status = 'retry';
          invalidation.nextEventIndex = eventIndex;
          invalidation.lastError = errorMessage;
          invalidation.failedEvent = event;
          invalidation.updatedAt = new Date().toISOString();
          if (Array.isArray(invalidation.events) && invalidation.events[eventIndex]) {
            invalidation.events[eventIndex].status = 'failed';
            invalidation.events[eventIndex].lastError = errorMessage;
          }
        }
        await writeOverlayEvidence(protocol, change, overlayEvidence);
        console.error('REMEDIATION RETRY: ' + errorMessage);
        console.log('NEXT: retry-remediation');
        console.log('REMEDIATION_NODE: ' + transition.to);
        console.log('NODE: ' + transition.to);
        console.log('SKILL: ' + generatedNodeSkillName(protocol, transition.to));
        console.log('RETRY: ' + remediationRetryCommand(transition.from));
        return applied;
      }
      overlayEvidence = await readOverlayEvidence(protocol, change);
      ledger = overlayLedger(overlayEvidence);
      invalidation = ledger.invalidations.find((entry) => entry.id === invalidation.id);
      if (!invalidation) throw new Error('Overlay remediation ledger entry disappeared.');
      invalidation.nextEventIndex = eventIndex + 1;
      invalidation.updatedAt = new Date().toISOString();
      if (Array.isArray(invalidation.events) && invalidation.events[eventIndex]) {
        invalidation.events[eventIndex].status = 'succeeded';
        invalidation.events[eventIndex].completedAt = new Date().toISOString();
        invalidation.events[eventIndex].lastError = null;
      }
      await writeOverlayEvidence(protocol, change, overlayEvidence);
    }
    const refreshed = await readOverlayEvidence(protocol, change);
    const refreshedLedger = overlayLedger(refreshed);
    const recorded = refreshedLedger.invalidations.find((entry) => entry.id === invalidation.id);
    if (recorded) {
      recorded.status = 'applied';
      recorded.appliedAt = new Date().toISOString();
      recorded.nextEventIndex = events.length;
      recorded.lastError = null;
    }
    await writeOverlayEvidence(protocol, change, refreshed);
    console.error(
      'REMEDIATION APPLIED: ' +
        transition.id +
        ' (' +
        transition.from +
        ' -> ' +
        transition.to +
        ').',
    );
    console.log('NEXT: auto');
    console.log('REMEDIATION_NODE: ' + transition.to);
    console.log('NODE: ' + transition.to);
    console.log('SKILL: ' + generatedNodeSkillName(protocol, transition.to));
    applied.push(transition);
  }
  return applied;
}

async function blockOverlay(protocol, change, node, message) {
  console.error(message);
}

async function blockOnSemanticFailures(protocol, node, evidence, allEvidence, change = null) {
  const failures = await semanticRuleFailures(protocol, node, evidence, allEvidence, change);
  if (failures.length === 0) return false;
  console.error(
    'BLOCKED: semantic Output Schema rules failed: ' +
      failures.map((failure) => failure.schemaId + '.' + failure.ruleId).join(', '),
  );
  if (apply && change) {
    await applyOverlayRemediation(protocol, change, node, failures);
  }
  return true;
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
}

function patternToRegExp(pattern) {
  return new RegExp('^' + String(pattern).split('*').map(escapeRegExp).join('.*') + '$', 'u');
}

async function matchingPaths(root, relativePattern) {
  const parts = String(relativePattern).split('/').filter(Boolean);
  const matches = [];
  async function walk(current, index) {
    if (index >= parts.length) {
      try {
        const stats = await fs.stat(current);
        if (stats.isFile()) matches.push(current);
      } catch {
        return;
      }
      return;
    }
    const part = parts[index];
    if (!part.includes('*')) {
      await walk(path.join(current, part), index + 1);
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    const matcher = patternToRegExp(part);
    for (const entry of entries) {
      if (matcher.test(entry.name)) await walk(path.join(current, entry.name), index + 1);
    }
  }
  await walk(root, 0);
  return matches;
}

function artifactPatternForChange(pattern, change) {
  if (!change) return pattern;
  return String(pattern).replace(
    'openspec/changes/*/',
    'openspec/changes/' + change.name + '/',
  );
}

function artifactReportDigests(parsed) {
  const values = [];
  if (typeof parsed?.reportDigest === 'string') values.push(parsed.reportDigest);
  if (Array.isArray(parsed?.reportDigests)) values.push(...parsed.reportDigests);
  if (
    parsed?.receiptReportDigests &&
    typeof parsed.receiptReportDigests === 'object' &&
    !Array.isArray(parsed.receiptReportDigests)
  ) {
    values.push(...Object.values(parsed.receiptReportDigests));
  }
  return new Set(values.filter((value) => typeof value === 'string'));
}

async function invalidRequiredArtifacts(
  protocol,
  node,
  evidence,
  allEvidence = {},
  change = null,
) {
  const schemas = schemaMap(protocol);
  const invalid = [];
  const receipts = change ? await validReceipts(protocol, node, allEvidence, change) : [];
  for (const schemaId of node.outputSchemas ?? []) {
    const schema = schemas.get(schemaId);
    for (const artifact of schema?.artifacts ?? []) {
      if (!artifact.required) continue;
      const paths = (
        await Promise.all(
          (artifact.paths ?? []).map((artifactPath) =>
            matchingPaths(runRoot, artifactPatternForChange(artifactPath, change)),
          ),
        )
      ).flat();
      if (paths.length === 0) {
        invalid.push(schemaId + '.' + artifact.id + '.artifact-exists');
        continue;
      }
      let accepted = false;
      const boundReportDigests = new Set();
      const segmentArtifactBindings = [];
      let lastFailure = schemaId + '.' + artifact.id + '.artifact-structured';
      for (const artifactPath of paths) {
        let parsed;
        if ((artifact.validations ?? []).includes('artifact-structured')) {
          parsed = await readStructuredArtifact(artifactPath);
          if (!parsed) continue;
        }
        if ((artifact.validations ?? []).includes('semantic')) {
          if (parsed?.format === 'markdown') {
            if (!String(schemaId).startsWith('comet.')) {
              lastFailure = schemaId + '.' + artifact.id + '.semantic';
              continue;
            }
            accepted = true;
            if (node.id !== 'execute') break;
            continue;
          }
          if (!parsed) {
            parsed = await readStructuredArtifact(artifactPath);
            if (!parsed) {
              lastFailure = schemaId + '.' + artifact.id + '.semantic';
              continue;
            }
          }
          const source =
            parsed.schemaEvidence && typeof parsed.schemaEvidence === 'object'
              ? parsed.schemaEvidence
              : parsed.evidence && typeof parsed.evidence === 'object'
                ? parsed.evidence
                : parsed;
          const required = (schema.evidence ?? []).filter((field) => field.required);
          const aligned = required.every(
            (field) =>
              Object.prototype.hasOwnProperty.call(source, field.id) &&
              (
                node.id === 'execute' && field.id === 'implementation-segment-index'
                  ? implementationSegmentIds(
                      evidenceValue(evidence, field.id, { [node.id]: evidence }),
                    ).includes(String(source[field.id]).trim())
                  : valuesEqual(
                      source[field.id],
                      evidenceValue(evidence, field.id, { [node.id]: evidence }),
                    )
              ),
          );
          if (!aligned) {
            lastFailure = schemaId + '.' + artifact.id + '.semantic';
            continue;
          }
          if (receipts.length > 0 && !String(schemaId).startsWith('comet.')) {
            const digests = artifactReportDigests(parsed);
            for (const digest of digests) boundReportDigests.add(digest);
            if (node.id === 'execute') {
              segmentArtifactBindings.push({
                segment: String(source['implementation-segment-index'] ?? '').trim(),
                digests,
              });
            }
            if (
              node.id !== 'execute' &&
              !receipts.every((receipt) => digests.has(receipt.reportDigest))
            ) {
              lastFailure = schemaId + '.' + artifact.id + '.report-digest-binding';
              continue;
            }
          }
        }
        accepted = true;
        if (node.id !== 'execute') break;
      }
      if (
        accepted &&
        node.id === 'execute' &&
        !String(schemaId).startsWith('comet.') &&
        receipts.length > 0 &&
        (
          !receipts.every((receipt) => {
            const segment = String(
              receipt.schemaEvidence?.['implementation-segment-index'] ?? '',
            ).trim();
            const matches = segmentArtifactBindings.filter(
              (binding) =>
                binding.segment === segment &&
                binding.digests.size === 1 &&
                binding.digests.has(receipt.reportDigest),
            );
            return matches.length === 1;
          }) ||
          segmentArtifactBindings.length !== receipts.length
        )
      ) {
        accepted = false;
        lastFailure = schemaId + '.' + artifact.id + '.segment-report-artifact-binding';
      }
      if (!accepted) invalid.push(lastFailure);
    }
  }
  return invalid;
}

async function requiredArtifactSnapshots(protocol, node, change) {
  const schemas = schemaMap(protocol);
  const snapshots = [];
  for (const schemaId of node.outputSchemas ?? []) {
    const schema = schemas.get(schemaId);
    for (const artifact of schema?.artifacts ?? []) {
      if (!artifact.required) continue;
      const paths = (
        await Promise.all(
          (artifact.paths ?? []).map((artifactPath) =>
            matchingPaths(runRoot, artifactPatternForChange(artifactPath, change)),
          ),
        )
      ).flat();
      for (const artifactPath of [...new Set(paths)].sort()) {
        const raw = await fs.readFile(artifactPath);
        snapshots.push({
          schemaId,
          artifactId: artifact.id,
          path: path.relative(runRoot, artifactPath).replaceAll('\\', '/'),
          sha256: createHash('sha256').update(raw).digest('hex'),
        });
      }
    }
  }
  return snapshots.sort((left, right) =>
    [left.schemaId, left.artifactId, left.path]
      .join('\0')
      .localeCompare([right.schemaId, right.artifactId, right.path].join('\0')),
  );
}

function artifactSnapshotDigest(snapshots) {
  return createHash('sha256').update(JSON.stringify(snapshots)).digest('hex');
}

async function mintOverlayReceipt(protocol, change, node, skill, artifactInput) {
  const binding = bindingFor(node, skill);
  if (!binding) {
    throw new Error('Skill ' + skill + ' is not bound to Node ' + node.id + '.');
  }
  let handoffRequest = null;
  if (binding.enforcement === 'handoff-guarded' || binding.scope === 'handoff') {
    const acceptToken = process.env.COMET_HANDOFF_ACCEPT_TOKEN;
    try {
      handoffRequest = JSON.parse(
        await fs.readFile(guardHandoffPath(protocol, change, node), 'utf8'),
      );
    } catch {
      handoffRequest = null;
    }
    if (
      !acceptToken ||
      !handoffRequest ||
      handoffRequest.status !== 'accepting' ||
      handoffRequest.acceptToken !== acceptToken
    ) {
      throw new Error(
        'A handoff-guarded receipt can only be minted internally by workflow-handoff accept.',
      );
    }
  }
  const artifactPath = path.resolve(runRoot, artifactInput);
  const relative = path.relative(runRoot, artifactPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Receipt artifact must stay inside the run root.');
  }
  let raw;
  let record;
  try {
    raw = await fs.readFile(artifactPath);
    record = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(
      'Receipt artifact must be readable structured JSON: ' +
        String(error instanceof Error ? error.message : error),
    );
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Receipt artifact must contain a JSON object.');
  }
  if (!nonEmptyStructured(record.skillOutput)) {
    throw new Error('Receipt artifact must contain non-empty Skill output evidence in skillOutput.');
  }
  if (!nonEmptyStructured(record.schemaEvidence)) {
    throw new Error('Receipt artifact must contain non-empty schemaEvidence.');
  }
  const evidence = await readOverlayEvidence(protocol, change);
  const currentNode = await currentOverlayNode(protocol, change, evidence);
  if (currentNode !== node.id) {
    throw new Error(
      'Cannot mint receipt for Node ' +
        node.id +
        ' while the current Classic/overlay Node is ' +
        String(currentNode) +
        '.',
    );
  }
  const codeStateHash = await currentCodeStateHash();
  const draftHash = await currentBundleDraftHash(protocol);
  const startedAt = Date.parse(String(record.startedAt ?? ''));
  const completedAt = Date.parse(String(record.completedAt ?? ''));
  const now = Date.now();
  const checks = [
    [record.node === node.id, 'node'],
    [record.skill === skill, 'skill'],
    [record.change === change.name, 'change'],
    [record.status === 'passed', 'status'],
    [record.codeStateHash === codeStateHash, 'codeStateHash'],
    [record.draftHash === draftHash, 'draftHash'],
    [Number.isFinite(startedAt) && Number.isFinite(completedAt) && startedAt < completedAt, 'time-order'],
    [Number.isFinite(completedAt) && completedAt <= now + 5000, 'completedAt-future'],
  ];
  const invalid = checks.filter(([passed]) => !passed).map(([, field]) => field);
  if (invalid.length > 0) {
    throw new Error('Receipt artifact fields are invalid: ' + invalid.join(', '));
  }
  const qaInvalidatesVerification =
    skill === 'qa' &&
    (
      record.schemaEvidence['qa-code-modified'] === true ||
      record.schemaEvidence['qa-new-commit-created'] === true ||
      record.schemaEvidence['qa-fix-required'] === true
    );
  if (qaInvalidatesVerification) {
    const currentEvidence =
      evidence[node.id] && typeof evidence[node.id] === 'object' && !Array.isArray(evidence[node.id])
        ? evidence[node.id]
        : {};
    evidence[node.id] = {
      ...currentEvidence,
      schemaEvidence: {
        ...(currentEvidence.schemaEvidence ?? {}),
        ...record.schemaEvidence,
      },
      qaIntake: {
        artifactPath: relative.replaceAll('\\', '/'),
        artifactSha256: createHash('sha256').update(raw).digest('hex'),
        codeStateHash,
        draftHash,
        recordedAt: new Date().toISOString(),
      },
    };
    await writeOverlayEvidence(protocol, change, evidence);
    await applyOverlayRemediation(protocol, change, node, [
      {
        schemaId: 'qa-intake',
        ruleId: 'qa-invalidated-current-verification',
        operator: 'qa-code-state-change',
        remediation: 'verify-qa-invalidated',
      },
    ]);
    return {
      remediated: true,
      check: 'required-skill:' + node.id + '.' + skill,
    };
  }
  const checkPrefix = (node.requiredSkillCalls ?? []).some((item) => item.skill === skill)
    ? 'required-skill:'
    : 'augmentation:';
  const check = checkPrefix + node.id + '.' + skill;
  const requiredOrder = (node.requiredSkillCalls ?? []).map(
    (item) => 'required-skill:' + node.id + '.' + item.skill,
  );
  const orderIndex = requiredOrder.indexOf(check);
  const ledger = overlayLedger(evidence);
  const protocolHash = currentProtocolHash(protocol);
  const latestInvalidation = latestAppliedInvalidation(evidence, node.id);
  const chainId = latestInvalidation?.id ?? null;
  const remediationOrder =
    chainId && isFullRecoveryInvalidation(latestInvalidation)
      ? ['execute', 'review', 'verify'].flatMap((requiredNodeId) => {
          const requiredNode = protocol.nodes.find((item) => item.id === requiredNodeId);
          return (requiredNode?.requiredSkillCalls ?? []).map(
            (item) => 'required-skill:' + requiredNodeId + '.' + item.skill,
          );
        })
      : requiredOrder;
  const receiptOrderIndex = remediationOrder.indexOf(check);
  let predecessor = null;
  if (receiptOrderIndex > 0) {
    const previousCheck = remediationOrder[receiptOrderIndex - 1];
    const previousNode = String(previousCheck).slice(
      'required-skill:'.length,
      String(previousCheck).lastIndexOf('.'),
    );
    const previousInvalidation = latestAppliedInvalidation(evidence, previousNode);
    const previousChainId = previousInvalidation?.id ?? null;
    const prior = [...ledger.receipts]
      .reverse()
      .find(
        (receipt) =>
          receipt.check === previousCheck &&
          receipt.status === 'passed' &&
          receipt.protocolHash === protocolHash &&
          receipt.codeStateHash === codeStateHash &&
          receipt.draftHash === draftHash &&
          (previousChainId
            ? receipt.chainId === previousChainId
            : !receipt.chainId),
      );
    if (!prior || !(await receiptArtifactMatches(prior))) {
      throw new Error(
        'Receipt order violation: ' + previousCheck + ' must be guard-minted first.',
      );
    }
    predecessor = prior;
    if (
      record.predecessorReceiptId !== prior.id ||
      record.predecessorReportDigest !== prior.reportDigest
    ) {
      throw new Error(
        'Receipt order violation: the report must bind predecessorReceiptId and predecessorReportDigest to ' +
          previousCheck +
          '.',
      );
    }
    if (previousNode !== node.id) {
      const priorGuard = [...ledger.guardResults]
        .reverse()
        .find(
          (result) =>
            result.node === previousNode &&
            result.status === 'passed' &&
            (previousChainId
              ? result.chainId === previousChainId
              : !result.chainId) &&
            result.protocolHash === protocolHash &&
            result.codeStateHash === codeStateHash &&
            result.draftHash === draftHash &&
            (result.receiptIds ?? []).includes(prior.id),
        );
      if (!priorGuard) {
        throw new Error(
          'Remediation chain requires a successful Guard result for Node ' +
            previousNode +
            ' before minting ' +
            check +
            '.',
        );
      }
    }
  }
  const artifactSha256 = createHash('sha256').update(raw).digest('hex');
  const mintedAt = new Date().toISOString();
  const receipt = {
    id: createHash('sha256')
      .update(
        [
          protocol.name,
          change.name,
          node.id,
          skill,
          artifactSha256,
          record.completedAt,
          mintedAt,
        ].join('\0'),
      )
      .digest('hex'),
    check,
    node: node.id,
    skill,
    change: change.name,
    scope: binding.scope,
    enforcement: binding.enforcement,
    status: 'passed',
    protocolHash,
    codeStateHash,
    draftHash,
    ...(!['open', 'design'].includes(node.id)
      ? { specDigest: (await checkStartApproval(change.name)).specDigest } : {}),
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    artifactPath: relative.replaceAll('\\', '/'),
    artifactSha256,
    reportDigest: artifactSha256,
    skillOutputDigest: createHash('sha256')
      .update(JSON.stringify(record.skillOutput))
      .digest('hex'),
    schemaEvidence: record.schemaEvidence,
    schemaEvidenceDigest: createHash('sha256')
      .update(JSON.stringify(record.schemaEvidence))
      .digest('hex'),
    ...(predecessor
      ? {
          predecessorReceiptId: predecessor.id,
          predecessorReportDigest: predecessor.reportDigest,
        }
      : {}),
    ...(chainId ? { chainId } : {}),
    ...(handoffRequest
      ? {
          handoffRequestId: handoffRequest.id,
          handoffRequestDigest: handoffRequest.requestDigest,
        }
      : {}),
    mintedAt,
  };
  ledger.receipts.push(receipt);
  await writeOverlayEvidence(protocol, change, evidence);
  return receipt;
}

async function recordOverlayGuardSuccess(protocol, change, node, allEvidence) {
  const ledger = overlayLedger(allEvidence);
  const receipts = await validReceipts(protocol, node, allEvidence, change);
  const latestInvalidation =
    [...ledger.invalidations]
      .reverse()
      .find(
        (entry) =>
          entry.status === 'applied' &&
          receipts.some((receipt) => receipt.chainId === entry.id),
      ) ?? null;
  const mintedAt = new Date().toISOString();
  const result = {
    id: createHash('sha256')
      .update(
        [
          protocol.name,
          change.name,
          node.id,
          receipts.map((receipt) => receipt.id).join(','),
          mintedAt,
        ].join('\0'),
      )
      .digest('hex'),
    node: node.id,
    change: change.name,
    status: 'passed',
    protocolHash: currentProtocolHash(protocol),
    codeStateHash: await currentCodeStateHash(),
    draftHash: await currentBundleDraftHash(protocol),
    ...(!['open', 'design'].includes(node.id)
      ? { specDigest: (await checkStartApproval(change.name)).specDigest } : {}),
    receiptIds: receipts.map((receipt) => receipt.id),
    artifactSnapshots: await requiredArtifactSnapshots(protocol, node, change),
    ...(latestInvalidation ? { chainId: latestInvalidation.id } : {}),
    mintedAt,
  };
  ledger.guardResults.push(result);
  await writeOverlayEvidence(protocol, change, allEvidence);
  return result;
}

async function validateAuthorizedArchive(
  protocol,
  change,
  evidence,
  token = null,
  actionId = null,
) {
  const node = findNode(protocol, 'archive');
  const archiveEvidence = evidenceFor({ evidence }, 'archive');
  if (!node || !archiveEvidence) {
    throw new Error('Archive authorization evidence is missing.');
  }
  if ((await currentOverlayNode(protocol, change, evidence)) !== 'archive') {
    throw new Error('Archive authorization is valid only in the Classic archive phase.');
  }
  const ledger = overlayLedger(evidence);
  const protocolHash = currentProtocolHash(protocol);
  const currentAuthorizations = ledger.archiveAuthorizations.filter(
    (entry) =>
      entry.node === 'archive' &&
      entry.change === change.name &&
      entry.protocolHash === protocolHash &&
      (
        entry.status === 'authorized' ||
        (entry.status === 'prepared' && actionId && entry.actionId === actionId)
      ),
  );
  if (currentAuthorizations.length !== 1) {
    throw new Error('Exactly one current unconsumed archive authorization is required.');
  }
  const authorization = currentAuthorizations[0];
  await checkWebQa(change.name);
  if (token && authorization.id !== token) {
    throw new Error('Archive authorization token is revoked, superseded, or not current.');
  }
  const codeStateHash = await currentCodeStateHash();
  const draftHash = await currentBundleDraftHash(protocol);
  if (
    authorization.protocolHash !== protocolHash ||
    authorization.codeStateHash !== codeStateHash ||
    authorization.draftHash !== draftHash
  ) {
    throw new Error('Archive authorization is stale for the current code, draft, or protocol.');
  }
  const healthRequired = (node.requiredSkillCalls ?? []).some((binding) => binding.skill === 'health');
  const healthReceipts = healthRequired ? await validReceipts(protocol, node, evidence, change) : [];
  const healthReceipt = healthRequired ? healthReceipts.find(
    (receipt) => receipt.id === authorization.healthReceiptId &&
      receipt.reportDigest === authorization.healthReportDigest,
  ) : null;
  if (healthRequired && !healthReceipt) throw new Error('Archive health receipt is missing or stale.');
  const missingSchema = missingRequiredSchemaEvidence(
    protocol,
    node,
    archiveEvidence,
    evidence,
  ).filter((failure) => !failure.startsWith('comet.archive.v1.'));
  if (missingSchema.length > 0) {
    throw new Error('Archive Output Schema evidence is invalid: ' + missingSchema.join(', '));
  }
  const invalidArtifacts = await invalidRequiredArtifacts(
    protocol,
    node,
    archiveEvidence,
    evidence,
    change,
  );
  if (invalidArtifacts.length > 0) {
    throw new Error('Archive Output Schema artifacts are invalid: ' + invalidArtifacts.join(', '));
  }
  const semanticFailures = await semanticRuleFailures(
    protocol,
    node,
    archiveEvidence,
    evidence,
    change,
  );
  if (semanticFailures.length > 0) {
    throw new Error(
      'Archive semantic evidence is invalid: ' +
        semanticFailures.map((failure) => failure.ruleId).join(', '),
    );
  }
  const verifyAuthorization = await currentVerifyAuthorization(
    protocol,
    change,
    evidence,
  );
  if (
    verifyAuthorization &&
    (
      authorization.verifyGuardResultId !== verifyAuthorization.guardResultId ||
      !valuesEqual(authorization.verifyReceiptIds, verifyAuthorization.receiptIds) ||
      !valuesEqual(authorization.verifyReportDigests, verifyAuthorization.reportDigests)
    )
  ) {
    throw new Error('Archive authorization is not bound to the current verify receipt chain.');
  }
  const artifactSnapshots = {
    health: await requiredArtifactSnapshots(protocol, node, change),
    verify: verifyAuthorization?.artifactSnapshots ?? [],
  };
  const snapshotDigest = artifactSnapshotDigest(artifactSnapshots);
  if (
    authorization.snapshotDigest !== snapshotDigest ||
    !valuesEqual(authorization.artifactSnapshots, artifactSnapshots)
  ) {
    throw new Error(
      'Archive authorization artifact snapshot is stale for the current health or verify evidence.',
    );
  }
  return { authorization, healthReceipt, verifyAuthorization };
}

function archiveAuthorizationClaimPath(protocol, change, authorizationId) {
  return path.join(
    path.dirname(evidencePathFor(protocol, change)),
    protocol.name + '.archive-claims',
    authorizationId + '.json',
  );
}

function archiveBoundaryClaimPath(protocol, change) {
  return path.join(
    path.dirname(evidencePathFor(protocol, change)),
    protocol.name + '.archive-claims',
    'current.json',
  );
}

function archiveTransactionPath(protocol, change, actionId) {
  return path.join(
    path.dirname(evidencePathFor(protocol, change)),
    protocol.name + '.archive-transactions',
    createHash('sha256').update(actionId).digest('hex') + '.json',
  );
}

function archiveTransactionLeasePath(protocol, change, actionId) {
  return archiveTransactionPath(protocol, change, actionId) + '.lease';
}

async function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!(error && typeof error === 'object' && error.code === 'EPERM');
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid + '-' + randomBytes(8).toString('hex');
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temporary, file);
}

async function acquireArchiveTransactionLease(protocol, change, actionId) {
  const file = archiveTransactionLeasePath(protocol, change, actionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const ownerId = process.env.COMET_ARCHIVE_OWNER_ID || randomBytes(32).toString('hex');
  const ownerPid = Number(process.env.COMET_ARCHIVE_OWNER_PID || process.pid);
  const lease = {
    actionId,
    ownerId,
    ownerPid,
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeExclusiveClaim(file, lease);
      return { file, lease };
    } catch (error) {
      if (!(error instanceof Error) || !/already claimed|single-use/iu.test(error.message)) {
        throw error;
      }
      let current;
      try {
        current = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        continue;
      }
      if (current.ownerId === ownerId && current.ownerPid === ownerPid) {
        return { file, lease: current };
      }
      const recordedPid = Number(current.ownerPid);
      const acquiredAtMs = Date.parse(current.acquiredAt ?? '');
      const ageMs = Number.isFinite(acquiredAtMs) ? Math.max(0, Date.now() - acquiredAtMs) : 'unknown';
      const diagnostic =
        'actionId=' + String(current.actionId ?? actionId) +
        ', ownerPid=' + String(current.ownerPid ?? 'unknown') +
        ', acquiredAt=' + String(current.acquiredAt ?? 'unknown') +
        ', expiresAt=' + String(current.expiresAt ?? 'unknown') +
        ', ageMs=' + String(ageMs) + '. ';
      if (!Number.isInteger(recordedPid) || recordedPid <= 0) {
        throw new Error(
          'Archive action is already in flight and owner death cannot be confirmed: ' +
            diagnostic +
            'Do not delete the lease. Inspect the owning Classic archive process and use the Classic archive recovery flow.',
        );
      }
      if (await processIsAlive(recordedPid)) {
        throw new Error(
          'Archive action is already in flight: ' +
            diagnostic +
            'Wait for the owner PID to exit, or use the Classic archive recovery flow only after the owning process has stopped. Do not delete the lease.',
        );
      }
      const latest = JSON.parse(await fs.readFile(file, 'utf8'));
      if (
        latest.ownerId !== current.ownerId ||
        latest.ownerPid !== current.ownerPid ||
        (await processIsAlive(recordedPid))
      ) {
        continue;
      }
      const stalePath =
        file + '.stale-' + Date.now() + '-' + String(current.ownerId ?? 'unknown');
      try {
        await fs.rename(file, stalePath);
      } catch {
        continue;
      }
    }
  }
  throw new Error('Archive action lease could not be acquired safely.');
}

async function releaseArchiveTransactionLease(context) {
  let current;
  try {
    current = JSON.parse(await fs.readFile(context.file, 'utf8'));
  } catch {
    return false;
  }
  if (
    current.ownerId !== context.lease.ownerId ||
    current.ownerPid !== context.lease.ownerPid
  ) {
    return false;
  }
  const released =
    context.file +
    '.released-' +
    Date.now() +
    '-' +
    String(context.lease.ownerId);
  await fs.rename(context.file, released);
  return true;
}

async function acquireArchiveTransaction(
  protocol,
  change,
  authorizationId,
  actionId,
  expectedAttemptId = null,
) {
  if (!actionId) throw new Error('Archive transaction requires an action id.');
  const lease = await acquireArchiveTransactionLease(protocol, change, actionId);
  const file = archiveTransactionPath(protocol, change, actionId);
  let transaction;
  let resumed = true;
  try {
    transaction = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) {
      await releaseArchiveTransactionLease(lease);
      throw error;
    }
    resumed = false;
    const createdAt = new Date().toISOString();
    transaction = {
      actionId,
      authorizationId,
      attemptId: randomBytes(32).toString('hex'),
      change: change.name,
      protocol: protocol.name,
      protocolHash: currentProtocolHash(protocol),
      status: 'preparing',
      createdAt,
      steps: {
        journal: { status: 'completed', completedAt: createdAt },
        boundary: { status: 'pending' },
        token: { status: 'pending' },
        evidence: { status: 'pending' },
      },
      reconciledSteps: [],
    };
    try {
      await writeExclusiveClaim(file, transaction);
    } catch {
      transaction = JSON.parse(await fs.readFile(file, 'utf8'));
      resumed = true;
    }
  }
  if (
    !expectedAttemptId &&
    transaction.actionId === actionId &&
    transaction.change === change.name &&
    transaction.protocol === protocol.name &&
    transaction.status === 'quality-blocked' &&
    transaction.authorizationId !== authorizationId
  ) {
    try {
      const evidence = await readOverlayEvidence(protocol, change);
      await validateAuthorizedArchive(
        protocol,
        change,
        evidence,
        authorizationId,
        actionId,
      );
    } catch (error) {
      await releaseArchiveTransactionLease(lease);
      throw error;
    }
    const reboundAt = new Date().toISOString();
    transaction.previousAttempts = [
      ...(Array.isArray(transaction.previousAttempts)
        ? transaction.previousAttempts
        : []),
      {
        authorizationId: transaction.authorizationId,
        attemptId: transaction.attemptId,
        status: transaction.status,
        qualityBlockedAt: transaction.qualityBlockedAt,
        lastError: transaction.lastError,
        steps: transaction.steps,
      },
    ];
    transaction.authorizationId = authorizationId;
    transaction.attemptId = randomBytes(32).toString('hex');
    transaction.protocolHash = currentProtocolHash(protocol);
    transaction.status = 'preparing';
    transaction.reboundAt = reboundAt;
    transaction.steps = {
      journal: { status: 'completed', completedAt: reboundAt },
      boundary: { status: 'pending' },
      token: { status: 'pending' },
      evidence: { status: 'pending' },
    };
    transaction.reconciledSteps = [];
    delete transaction.qualityBlockedAt;
    delete transaction.lastError;
  }
  if (
    transaction.actionId !== actionId ||
    transaction.authorizationId !== authorizationId ||
    transaction.change !== change.name ||
    transaction.protocol !== protocol.name ||
    (expectedAttemptId && transaction.attemptId !== expectedAttemptId)
  ) {
    await releaseArchiveTransactionLease(lease);
    throw new Error('Archive transaction does not match this action, token, or attempt.');
  }
  transaction.lease = lease.lease;
  transaction.ownerId = lease.lease.ownerId;
  transaction.ownerPid = lease.lease.ownerPid;
  transaction.pid = lease.lease.ownerPid;
  transaction.claimedAt ??= transaction.createdAt;
  transaction.updatedAt = new Date().toISOString();
  await writeJsonAtomic(file, transaction);
  if (transaction.status === 'consumed' && !expectedAttemptId) {
    await releaseArchiveTransactionLease(lease);
    throw new Error('Archive transaction is already consumed and single-use.');
  }
  return { file, lease, transaction, resumed };
}

async function completeArchiveTransactionStep(context, step) {
  context.transaction.steps =
    context.transaction.steps && typeof context.transaction.steps === 'object'
      ? context.transaction.steps
      : {};
  context.transaction.reconciledSteps = Array.isArray(context.transaction.reconciledSteps)
    ? context.transaction.reconciledSteps
    : [];
  const current = context.transaction.steps[step];
  const completedAt = new Date().toISOString();
  if (current?.status === 'completed') {
    if (context.resumed && !context.transaction.reconciledSteps.includes(step)) {
      context.transaction.reconciledSteps.push(step);
    }
    context.transaction.steps[step] = {
      ...current,
      status: 'completed',
      reconciledAt: completedAt,
    };
  } else {
    context.transaction.steps[step] = { status: 'completed', completedAt };
  }
  context.transaction.updatedAt = completedAt;
  await writeJsonAtomic(context.file, context.transaction);
}

async function ensureArchiveTransactionClaim(file, transaction) {
  const desired = {
    attemptId: transaction.attemptId,
    authorizationId: transaction.authorizationId,
    actionId: transaction.actionId,
    change: transaction.change,
    protocol: transaction.protocol,
    protocolHash: transaction.protocolHash,
    command: 'consume-archive',
    ownerId: transaction.lease?.ownerId,
    ownerPid: transaction.lease?.ownerPid,
    pid: transaction.lease?.ownerPid,
    status: transaction.status === 'prepared' ? 'prepared' : 'claimed',
    claimedAt: transaction.createdAt,
  };
  try {
    const current = JSON.parse(await fs.readFile(file, 'utf8'));
    if (
      current.attemptId !== desired.attemptId ||
      current.authorizationId !== desired.authorizationId ||
      current.actionId !== desired.actionId ||
      current.status === 'consumed'
    ) {
      throw new Error('Archive claim belongs to another action, token, or attempt.');
    }
    return current;
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await writeExclusiveClaim(file, desired);
  } catch {
    return ensureArchiveTransactionClaim(file, transaction);
  }
  return desired;
}

function maybeArchiveFault(step) {
  if (process.env.COMET_ARCHIVE_FAULT_AFTER_STEP === step) {
    console.error('INJECTED ARCHIVE CRASH AFTER: ' + step);
    process.exit(86);
  }
}

function archiveQualityPreflightFailure(error) {
  const failure = new Error(String(error instanceof Error ? error.message : error));
  failure.code = 'COMET_ARCHIVE_QUALITY_PREFLIGHT';
  return failure;
}

function isArchiveQualityPreflightFailure(error) {
  return (
    error &&
    typeof error === 'object' &&
    error.code === 'COMET_ARCHIVE_QUALITY_PREFLIGHT'
  );
}

async function writeExclusiveClaim(file, claim) {
  let handle;
  try {
    handle = await fs.open(file, 'wx');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      throw new Error('Archive boundary is already claimed, consumed, or no longer single-use.');
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(claim, null, 2) + '\n', 'utf8');
  } finally {
    await handle.close();
  }
}

async function finalizeOwnedClaimFile(file, attemptId, value, release = false) {
  let current;
  try {
    current = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return false;
  }
  if (current.attemptId !== attemptId) return false;
  const temporary = file + '.tmp-' + process.pid + '-' + Date.now();
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  const latest = JSON.parse(await fs.readFile(file, 'utf8'));
  if (latest.attemptId !== attemptId) {
    await fs.unlink(temporary).catch(() => {});
    return false;
  }
  await fs.rename(temporary, file);
  if (release) {
    const failedPath =
      file.slice(0, -'.json'.length) +
      '.failed-' +
      Date.now() +
      '-' +
      attemptId +
      '.json';
    await fs.rename(file, failedPath);
  }
  return true;
}

async function acquireArchiveAuthorizationClaim(protocol, change, authorizationId) {
  if (!/^[a-f0-9]{64}$/u.test(String(authorizationId))) {
    throw new Error('Archive authorization token is malformed.');
  }
  const file = archiveAuthorizationClaimPath(protocol, change, authorizationId);
  const boundaryFile = archiveBoundaryClaimPath(protocol, change);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const attemptId = randomBytes(32).toString('hex');
  const claim = {
    attemptId,
    authorizationId,
    change: change.name,
    protocol: protocol.name,
    protocolHash: currentProtocolHash(protocol),
    command: 'consume-archive',
    pid: process.pid,
    status: 'claimed',
    claimedAt: new Date().toISOString(),
    codeStateHash: await currentCodeStateHash(),
    draftHash: await currentBundleDraftHash(protocol),
  };
  let boundaryOwned = false;
  let tokenOwned = false;
  try {
    await writeExclusiveClaim(boundaryFile, claim);
    boundaryOwned = true;
    await writeExclusiveClaim(file, claim);
    tokenOwned = true;
  } catch (error) {
    const failed = {
      ...claim,
      status: 'failed',
      failedAt: new Date().toISOString(),
      stage: tokenOwned ? 'claimed' : boundaryOwned ? 'token-claim' : 'boundary-claim',
      error: String(error instanceof Error ? error.message : error),
    };
    if (tokenOwned) {
      await finalizeOwnedClaimFile(file, attemptId, failed, true);
    }
    if (boundaryOwned) {
      await finalizeOwnedClaimFile(boundaryFile, attemptId, failed, true);
    }
    throw error;
  }
  return { file, boundaryFile, claim, boundaryOwned, tokenOwned };
}

async function resumePreparedArchiveAuthorizationClaim(
  protocol,
  change,
  authorizationId,
  actionId,
) {
  const file = archiveAuthorizationClaimPath(protocol, change, authorizationId);
  const boundaryFile = archiveBoundaryClaimPath(protocol, change);
  let tokenClaim;
  let boundaryClaim;
  try {
    tokenClaim = JSON.parse(await fs.readFile(file, 'utf8'));
    boundaryClaim = JSON.parse(await fs.readFile(boundaryFile, 'utf8'));
  } catch {
    return null;
  }
  if (
    tokenClaim.status !== 'prepared' ||
    boundaryClaim.status !== 'prepared' ||
    tokenClaim.authorizationId !== authorizationId ||
    boundaryClaim.authorizationId !== authorizationId ||
    tokenClaim.actionId !== actionId ||
    boundaryClaim.actionId !== actionId ||
    !tokenClaim.attemptId ||
    tokenClaim.attemptId !== boundaryClaim.attemptId
  ) {
    return null;
  }
  return {
    file,
    boundaryFile,
    claim: tokenClaim,
    boundaryOwned: true,
    tokenOwned: true,
    resumed: true,
  };
}

async function finishArchiveAuthorizationClaim(context, status, details = {}) {
  const completedAt = new Date().toISOString();
  const value = {
    ...context.claim,
    ...details,
    status,
    ...(status === 'consumed'
      ? { consumedAt: completedAt }
      : status === 'prepared'
        ? { preparedAt: completedAt }
        : { failedAt: completedAt }),
  };
  for (const file of [context.file, context.boundaryFile]) {
    const owned =
      file === context.file ? context.tokenOwned !== false : context.boundaryOwned !== false;
    if (!owned) continue;
    const finalized = await finalizeOwnedClaimFile(
      file,
      context.claim.attemptId,
      value,
      status === 'failed',
    );
    if (!finalized) {
      throw new Error('Archive claim ownership changed before finalize.');
    }
  }
}

async function main() {
  const protocol = await readJson(protocolPath);
  if (protocol.schemaVersion !== 1 || !Array.isArray(protocol.nodes)) {
    throw new Error('workflow-protocol.json must use the current schema with nodes');
  }
  if (command === 'context') {
    console.log(JSON.stringify({
      codeStateHash: await currentCodeStateHash(),
      draftHash: await currentBundleDraftHash(protocol),
    }, null, 2));
    return;
  }
  if (command === 'route') {
    if (!isCometOverlay(protocol)) {
      throw new Error('route is supported only for comet-five-phase-overlay.');
    }
    const change = await resolveCometOverlayChange();
    const evidence = await readOverlayEvidence(protocol, change);
    const current = await currentOverlayNode(protocol, change, evidence);
    console.log('NODE: ' + String(current));
    return;
  }
  if (command === 'confirm-archive') {
    if (!isCometOverlay(protocol)) {
      throw new Error('confirm-archive is supported only for comet-five-phase-overlay.');
    }
    const change = await resolveCometOverlayChange();
    await checkStartApproval(change.name);
    const evidence = await readOverlayEvidence(protocol, change);
    let validated;
    try {
      validated = await validateAuthorizedArchive(protocol, change, evidence);
    } catch (error) {
      const node = findNode(protocol, 'archive');
      await applyOverlayRemediation(protocol, change, node, [
        {
          schemaId: 'archive-preflight',
          ruleId: 'confirm-archive',
          remediation: 'archive-quality-blocked',
          message: String(error instanceof Error ? error.message : error),
        },
      ]);
      throw error;
    }
    console.log('ARCHIVE CONFIRMATION OK');
    console.log('AUTHORIZATION: ' + validated.authorization.id);
    return;
  }
  if (command === 'segment-register') {
    if (!isCometOverlay(protocol)) {
      throw new Error('segment-register is supported only for comet-five-phase-overlay.');
    }
    const requestedNode = process.argv[3];
    const manifestInput = process.argv[4];
    if (requestedNode !== 'execute' || !manifestInput) {
      throw new Error('segment-register requires: execute <segment-manifest.json>.');
    }
    const change = await resolveCometOverlayChange();
    const evidence = await readOverlayEvidence(protocol, change);
    if ((await currentOverlayNode(protocol, change, evidence)) !== 'execute') {
      throw new Error('Implementation segment inventory can be sealed only at the execute Node.');
    }
    const manifestPath = path.resolve(runRoot, manifestInput);
    const relative = path.relative(runRoot, manifestPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Segment manifest must stay inside the run root.');
    }
    const raw = await fs.readFile(manifestPath);
    const manifest = JSON.parse(raw.toString('utf8'));
    const segmentIds = implementationSegmentIds(manifest.segmentIds);
    const codeStateHash = await currentCodeStateHash();
    const draftHash = await currentBundleDraftHash(protocol);
    if (
      manifest.node !== 'execute' ||
      manifest.change !== change.name ||
      manifest.codeStateHash !== codeStateHash ||
      manifest.draftHash !== draftHash ||
      segmentIds.length === 0 ||
      segmentIds.length !== (manifest.segmentIds ?? []).length
    ) {
      throw new Error('Segment manifest fields or current hashes are invalid.');
    }
    const ledger = overlayLedger(evidence);
    const existing = [...ledger.segmentInventories]
      .reverse()
      .find(
        (entry) =>
          entry.node === 'execute' &&
          entry.change === change.name &&
          entry.codeStateHash === codeStateHash &&
          entry.draftHash === draftHash &&
          entry.status === 'sealed',
      );
    if (existing && !valuesEqual(existing.segmentIds, segmentIds)) {
      throw new Error('Sealed implementation segment inventory cannot be changed or reduced.');
    }
    const inventory = existing ?? {
      id: createHash('sha256').update(raw).digest('hex'),
      node: 'execute',
      change: change.name,
      protocolHash: currentProtocolHash(protocol),
      codeStateHash,
      draftHash,
      segmentIds,
      manifestPath: relative.replaceAll('\\', '/'),
      manifestSha256: createHash('sha256').update(raw).digest('hex'),
      status: 'sealed',
      sealedAt: new Date().toISOString(),
    };
    if (!existing) ledger.segmentInventories.push(inventory);
    const currentEvidence =
      evidence.execute && typeof evidence.execute === 'object' ? evidence.execute : {};
    evidence.execute = {
      ...currentEvidence,
      schemaEvidence: {
        ...(currentEvidence.schemaEvidence ?? {}),
        'implementation-segment-index': segmentIds,
      },
      segmentInventoryId: inventory.id,
    };
    await writeOverlayEvidence(protocol, change, evidence);
    console.log('SEGMENT INVENTORY: ' + inventory.id);
    console.log('SEGMENTS: ' + segmentIds.join(','));
    return;
  }
  if (command === 'receipt') {
    if (!nodeId) throw new Error('receipt requires a Node id.');
    const node = findNode(protocol, nodeId);
    if (!node) throw new Error('Unknown workflow Node: ' + nodeId);
    const skill = process.argv[4];
    const artifactPath = process.argv[5];
    if (!skill || !artifactPath) {
      throw new Error('receipt requires a Skill name and structured artifact path.');
    }
    if (!isCometOverlay(protocol)) {
      throw new Error('receipt is currently supported only for comet-five-phase-overlay.');
    }
    const change = await resolveCometOverlayChange();
    if (node.id !== 'design' && node.id !== 'open') await checkStartApproval(change.name);
    if (node.id === 'review') {
      const evidence = await readOverlayEvidence(protocol, change);
      const prior = (await validReceipts(protocol, node, evidence, change)).find((item) => item.skill === skill);
      if (prior) {
        console.log('RECEIPT REUSED: ' + prior.id);
        return;
      }
    }
    const receipt = await mintOverlayReceipt(protocol, change, node, skill, artifactPath);
    if (receipt.remediated) {
      const refreshedEvidence = await readOverlayEvidence(protocol, change);
      const remediation = [...overlayLedger(refreshedEvidence).invalidations]
        .reverse()
        .find((entry) => entry.from === node.id) ?? null;
      console.error(
        'REMEDIATION ' +
          String(remediation?.status ?? 'REQUIRED').toUpperCase() +
          ': QA changed code or requires fixes; current verify evidence is invalid.',
      );
      console.log('NEXT: ' + (remediation?.status === 'applied' ? 'auto' : 'retry-remediation'));
      if (remediation?.status !== 'applied') {
        console.log('RETRY: ' + remediationRetryCommand(node.id));
      }
      console.log('REMEDIATION_NODE: ' + String(remediation?.to ?? 'execute'));
      console.log('NODE: ' + String(remediation?.to ?? 'execute'));
      console.log(
        'SKILL: ' + generatedNodeSkillName(protocol, String(remediation?.to ?? 'execute')),
      );
      process.exitCode = 1;
      return;
    }
    console.log('RECEIPT: ' + receipt.id);
    console.log('CHECK: ' + receipt.check);
    console.log('REPORT DIGEST: ' + receipt.reportDigest);
    return;
  }
  if (command === 'consume-archive') {
    if (!nodeId) throw new Error('consume-archive requires the archive Node id.');
    const node = findNode(protocol, nodeId);
    if (!node || node.id !== 'archive') {
      throw new Error('consume-archive is supported only for the archive Node.');
    }
    if (!isCometOverlay(protocol)) {
      throw new Error('consume-archive is currently supported only for comet-five-phase-overlay.');
    }
    const token = process.argv[4];
    if (!token) throw new Error('consume-archive requires an authorization token.');
    const actionIndex = process.argv.indexOf('--action-id');
    const actionId = actionIndex >= 0 ? process.argv[actionIndex + 1] : null;
    if (!actionId) throw new Error('consume-archive requires --action-id <pending-action-id>.');
    if (!process.argv.includes('--user-approved')) {
      throw new Error(
        'consume-archive requires --user-approved after the user explicitly approves the irreversible archive action.',
      );
    }
    const change = await resolveCometOverlayChange();
    await checkStartApproval(change.name);
    const transaction = await acquireArchiveTransaction(
      protocol,
      change,
      token,
      actionId,
    );
    try {
      await completeArchiveTransactionStep(transaction, 'journal');
      maybeArchiveFault('journal');
      const boundaryFile = archiveBoundaryClaimPath(protocol, change);
      const tokenFile = archiveAuthorizationClaimPath(protocol, change, token);
      await ensureArchiveTransactionClaim(boundaryFile, transaction.transaction);
      await completeArchiveTransactionStep(transaction, 'boundary');
      maybeArchiveFault('boundary');
      await ensureArchiveTransactionClaim(tokenFile, transaction.transaction);
      await completeArchiveTransactionStep(transaction, 'token');
      maybeArchiveFault('token');
      const evidence = await readOverlayEvidence(protocol, change);
      let validatedArchive;
      try {
        validatedArchive = await validateAuthorizedArchive(
          protocol,
          change,
          evidence,
          token,
          actionId,
        );
      } catch (error) {
        throw archiveQualityPreflightFailure(error);
      }
      const ledger = overlayLedger(evidence);
      const authorization = validatedArchive.authorization;
      const codeStateHash = await currentCodeStateHash();
      const draftHash = await currentBundleDraftHash(protocol);
      if (
        authorization.protocolHash !== currentProtocolHash(protocol) ||
        authorization.codeStateHash !== codeStateHash ||
        authorization.draftHash !== draftHash
      ) {
        throw archiveQualityPreflightFailure(
          'Archive authorization is stale because code state, Bundle draft, or protocol changed.',
        );
      }
      const healthRequired = (node.requiredSkillCalls ?? []).some((binding) => binding.skill === 'health');
      const healthReceipt = healthRequired ? ledger.receipts.find(
        (receipt) => receipt.id === authorization.healthReceiptId,
      ) : null;
      if (healthRequired && (
        !healthReceipt || healthReceipt.reportDigest !== authorization.healthReportDigest ||
        !(await receiptArtifactMatches(healthReceipt))
      )) {
        throw archiveQualityPreflightFailure(
          'Archive authorization health receipt or report digest is no longer valid.',
        );
      }
      const archiveEvidence = evidenceFor({ evidence }, node.id);
      if (!archiveEvidence) {
        throw archiveQualityPreflightFailure(
          'Archive authorization evidence is no longer present.',
        );
      }
      const currentMissingSchema = missingRequiredSchemaEvidence(
        protocol,
        node,
        archiveEvidence,
        evidence,
      ).filter((failure) => !failure.startsWith('comet.archive.v1.'));
      if (currentMissingSchema.length > 0) {
        throw archiveQualityPreflightFailure(
          'Archive authorization Output Schema evidence is no longer valid: ' +
            currentMissingSchema.join(', '),
        );
      }
      const currentArtifacts = await invalidRequiredArtifacts(
        protocol,
        node,
        archiveEvidence,
        evidence,
        change,
      );
      if (currentArtifacts.length > 0) {
        throw archiveQualityPreflightFailure(
          'Archive authorization Output Schema artifacts are no longer valid: ' +
            currentArtifacts.join(', '),
        );
      }
      const currentReceipts = healthRequired ? await validReceipts(protocol, node, evidence, change) : [];
      if (healthRequired && !currentReceipts.some((receipt) => receipt.id === healthReceipt.id)) {
        throw archiveQualityPreflightFailure(
          'Archive authorization health receipt is no longer current and valid.',
        );
      }
      const currentSemanticFailures = await semanticRuleFailures(
        protocol,
        node,
        archiveEvidence,
        evidence,
        change,
      );
      if (currentSemanticFailures.length > 0) {
        throw archiveQualityPreflightFailure(
          'Archive authorization semantic evidence is no longer valid: ' +
            currentSemanticFailures.map((failure) => failure.ruleId).join(', '),
        );
      }
      const startedAt = new Date().toISOString();
      if (healthRequired && Date.parse(healthReceipt.mintedAt) > Date.parse(startedAt)) {
        throw archiveQualityPreflightFailure(
          'Health receipt must be minted before archive starts.',
        );
      }
      authorization.status = 'prepared';
      authorization.actionId = actionId;
      authorization.attemptId = transaction.transaction.attemptId;
      authorization.preparedAt = startedAt;
      await writeOverlayEvidence(protocol, change, evidence);
      await completeArchiveTransactionStep(transaction, 'evidence');
      maybeArchiveFault('evidence');
      const claim = {
        file: tokenFile,
        boundaryFile,
        claim: {
          ...transaction.transaction,
          attemptId: transaction.transaction.attemptId,
        },
        boundaryOwned: true,
        tokenOwned: true,
      };
      await finishArchiveAuthorizationClaim(claim, 'prepared', {
        actionId,
        codeStateHash,
        draftHash,
        ...(healthReceipt ? { healthReceiptId: healthReceipt.id,
          healthReportDigest: healthReceipt.reportDigest } : {}),
        preparedAt: startedAt,
      });
      transaction.transaction.status = 'prepared';
      transaction.transaction.preparedAt = startedAt;
      transaction.transaction.codeStateHash = codeStateHash;
      transaction.transaction.draftHash = draftHash;
      if (healthReceipt) {
        transaction.transaction.healthReceiptId = healthReceipt.id;
        transaction.transaction.healthReportDigest = healthReceipt.reportDigest;
      }
      await writeJsonAtomic(transaction.file, transaction.transaction);
      console.log('ARCHIVE PREPARED');
      console.log('AUTHORIZATION: ' + authorization.id);
      console.log('ACTION_ID: ' + actionId);
      console.log('ATTEMPT_ID: ' + transaction.transaction.attemptId);
      console.log('OWNER_ID: ' + transaction.lease.lease.ownerId);
      console.log('PREPARED_AT: ' + startedAt);
      return;
    } catch (error) {
      transaction.transaction.lastError = String(
        error instanceof Error ? error.message : error,
      );
      transaction.transaction.updatedAt = new Date().toISOString();
      if (isArchiveQualityPreflightFailure(error)) {
        transaction.transaction.status = 'quality-blocked';
        transaction.transaction.qualityBlockedAt = transaction.transaction.updatedAt;
      }
      await writeJsonAtomic(transaction.file, transaction.transaction);
      if (isArchiveQualityPreflightFailure(error)) {
        const failedClaim = {
          ...transaction.transaction,
          status: 'quality-blocked',
          failedAt: transaction.transaction.updatedAt,
          error: transaction.transaction.lastError,
        };
        await finalizeOwnedClaimFile(
          archiveAuthorizationClaimPath(protocol, change, token),
          transaction.transaction.attemptId,
          failedClaim,
          true,
        );
        await finalizeOwnedClaimFile(
          archiveBoundaryClaimPath(protocol, change),
          transaction.transaction.attemptId,
          failedClaim,
          true,
        );
      }
      await releaseArchiveTransactionLease(transaction.lease);
      if (isArchiveQualityPreflightFailure(error)) {
        await applyOverlayRemediation(protocol, change, node, [
          {
            schemaId: 'archive-preflight',
            ruleId: 'consume-archive',
            remediation: 'archive-quality-blocked',
            message: String(error instanceof Error ? error.message : error),
          },
        ]);
      }
      throw error;
    }
  }
  if (command === 'finalize-archive') {
    if (!nodeId) throw new Error('finalize-archive requires the archive Node id.');
    const node = findNode(protocol, nodeId);
    if (!node || node.id !== 'archive' || !isCometOverlay(protocol)) {
      throw new Error('finalize-archive is supported only for an overlay archive Node.');
    }
    const token = process.argv[4];
    const actionId = process.argv[5];
    const attemptId = process.argv[6];
    const changeName = process.env.COMET_OVERLAY_CHANGE;
    if (!token || !actionId || !attemptId || !changeName) {
      throw new Error(
        'finalize-archive requires token, action id, attempt id, and COMET_OVERLAY_CHANGE.',
      );
    }
    const change = { name: changeName };
    const evidence = await readOverlayEvidence(protocol, change);
    const ledger = overlayLedger(evidence);
    const authorization = ledger.archiveAuthorizations.find(
      (entry) =>
        entry.id === token &&
        entry.change === changeName &&
        (entry.status === 'prepared' || entry.status === 'consumed') &&
        entry.actionId === actionId &&
        entry.attemptId === attemptId,
    );
    if (!authorization) {
      throw new Error('Prepared archive authorization does not match this pending action.');
    }
    const transaction = await acquireArchiveTransaction(
      protocol,
      change,
      token,
      actionId,
      attemptId,
    );
    if (transaction.transaction.status === 'consumed') {
      await releaseArchiveTransactionLease(transaction.lease);
      console.log('ARCHIVE FINALIZED');
      console.log('AUTHORIZATION: ' + token);
      console.log('ACTION_ID: ' + actionId);
      console.log('ATTEMPT_ID: ' + attemptId);
      return;
    }
    if (
      transaction.transaction.status !== 'prepared' &&
      transaction.transaction.status !== 'consumed'
    ) {
      await releaseArchiveTransactionLease(transaction.lease);
      throw new Error('Prepared archive claim ownership does not match this finalize attempt.');
    }
    const claim = {
      file: archiveAuthorizationClaimPath(protocol, change, token),
      boundaryFile: archiveBoundaryClaimPath(protocol, change),
      claim: transaction.transaction,
      boundaryOwned: true,
      tokenOwned: true,
    };
    const finalizedAt = new Date().toISOString();
    authorization.status = 'consumed';
    authorization.startedAt = authorization.preparedAt;
    authorization.finalizedAt = finalizedAt;
    await writeOverlayEvidence(protocol, change, evidence);
    await finishArchiveAuthorizationClaim(claim, 'consumed', {
      actionId,
      finalizedAt,
    });
    transaction.transaction.status = 'consumed';
    transaction.transaction.finalizedAt = finalizedAt;
    transaction.transaction.consumedAt = finalizedAt;
    await writeJsonAtomic(transaction.file, transaction.transaction);
    await releaseArchiveTransactionLease(transaction.lease);
    console.log('ARCHIVE FINALIZED');
    console.log('AUTHORIZATION: ' + token);
    console.log('ACTION_ID: ' + actionId);
    console.log('ATTEMPT_ID: ' + attemptId);
    console.log('FINALIZED_AT: ' + finalizedAt);
    return;
  }
  if (command === 'recover-archive') {
    const actionId = process.argv[4];
    const changeName = process.env.COMET_OVERLAY_CHANGE;
    if (!actionId || !changeName) {
      throw new Error('recover-archive requires an action id and COMET_OVERLAY_CHANGE.');
    }
    const change = { name: changeName };
    const file = archiveTransactionPath(protocol, change, actionId);
    const recorded = JSON.parse(await fs.readFile(file, 'utf8'));
    const transaction = await acquireArchiveTransaction(
      protocol,
      change,
      recorded.authorizationId,
      actionId,
      recorded.attemptId,
    );
    if (
      transaction.transaction.status !== 'prepared' &&
      transaction.transaction.status !== 'consumed'
    ) {
      await releaseArchiveTransactionLease(transaction.lease);
      throw new Error('Archive recovery requires a prepared transaction.');
    }
    console.log('ARCHIVE RECOVERED');
    console.log('AUTHORIZATION: ' + transaction.transaction.authorizationId);
    console.log('ACTION_ID: ' + transaction.transaction.actionId);
    console.log('ATTEMPT_ID: ' + transaction.transaction.attemptId);
    console.log('OWNER_ID: ' + transaction.lease.lease.ownerId);
    return;
  }
  if (command === 'release-archive') {
    const token = process.argv[4];
    const actionId = process.argv[5];
    const attemptId = process.argv[6];
    const changeName = process.env.COMET_OVERLAY_CHANGE;
    if (!token || !actionId || !attemptId || !changeName) {
      throw new Error('release-archive requires token, action id, attempt id, and change.');
    }
    const change = { name: changeName };
    const transaction = await acquireArchiveTransaction(
      protocol,
      change,
      token,
      actionId,
      attemptId,
    );
    transaction.transaction.releasedAt = new Date().toISOString();
    transaction.transaction.lastError =
      process.env.COMET_ARCHIVE_RELEASE_REASON || 'Classic archive attempt released for retry.';
    await writeJsonAtomic(transaction.file, transaction.transaction);
    await releaseArchiveTransactionLease(transaction.lease);
    console.log('ARCHIVE RELEASED');
    console.log('ATTEMPT_ID: ' + attemptId);
    return;
  }
  if (command !== 'entry' && command !== 'exit' && command !== 'authorize') {
    throw new Error('Unknown command: ' + command);
  }
  if (!nodeId) throw new Error(command + ' requires a Node id.');
  const node = findNode(protocol, nodeId);
  if (!node) throw new Error('Unknown workflow Node: ' + nodeId);
  if (command === 'authorize' && node.id !== 'archive') {
    throw new Error('authorize is supported only for the archive Node.');
  }
  if (command === 'authorize' && !isCometOverlay(protocol)) {
    throw new Error('authorize is currently supported only for comet-five-phase-overlay.');
  }
  if (isCometOverlay(protocol)) {
    const change = await resolveCometOverlayChange();
    if (node.id !== 'open' && node.id !== 'design') await checkStartApproval(change.name);
    const overlayEvidence = await readOverlayEvidence(protocol, change);
    const pendingRemediation =
      [...overlayLedger(overlayEvidence).invalidations]
        .reverse()
        .find(
          (entry) =>
            entry.from === node.id &&
            (entry.status === 'applying' || entry.status === 'retry'),
        ) ?? null;
    if (command === 'exit' && apply && pendingRemediation) {
      await applyOverlayRemediation(protocol, change, node, []);
      const refreshedEvidence = await readOverlayEvidence(protocol, change);
      const refreshedRemediation = overlayLedger(refreshedEvidence).invalidations.find(
        (entry) => entry.id === pendingRemediation.id,
      );
      if (refreshedRemediation?.status === 'applied') {
        console.error('REMEDIATION APPLIED: ' + refreshedRemediation.transitionId + '.');
        console.log('NEXT: auto');
      } else if (refreshedRemediation) {
        console.error(
          'REMEDIATION RETRY: ' +
            String(refreshedRemediation.lastError ?? refreshedRemediation.transitionId),
        );
        console.log('NEXT: retry-remediation');
        console.log('RETRY: ' + remediationRetryCommand(refreshedRemediation.from));
      }
      console.log('REMEDIATION_NODE: ' + pendingRemediation.to);
      console.log('NODE: ' + pendingRemediation.to);
      console.log('SKILL: ' + generatedNodeSkillName(protocol, pendingRemediation.to));
      process.exitCode = 1;
      return;
    }
    const current = await currentOverlayNode(protocol, change, overlayEvidence);
    if (command === 'entry') {
      if (current !== node.id) {
        console.error('BLOCKED: current Node is ' + String(current) + ', cannot enter ' + node.id + '.');
        process.exit(1);
      }
      console.log('ENTRY OK: ' + node.id);
      return;
    }
    const evidenceState = { evidence: overlayEvidence };
    const evidence = evidenceFor(evidenceState, node.id);
    if (!evidence) {
      await blockOverlay(protocol, change, node, 'BLOCKED: missing evidence for Node ' + node.id + '.');
      process.exit(1);
    }
    let missingSchemaEvidence = missingRequiredSchemaEvidence(
      protocol,
      node,
      evidence,
      overlayEvidence,
    );
    if (command === 'authorize' && node.id === 'archive') {
      missingSchemaEvidence = missingSchemaEvidence.filter(
        (failure) => !failure.startsWith('comet.archive.v1.'),
      );
    }
    if (missingSchemaEvidence.length > 0) {
      await blockOverlay(
        protocol,
        change,
        node,
        'BLOCKED: missing Output Schema evidence: ' + missingSchemaEvidence.join(', '),
      );
      process.exit(1);
    }
    const invalidArtifacts = await invalidRequiredArtifacts(
      protocol,
      node,
      evidence,
      overlayEvidence,
      change,
    );
    if (invalidArtifacts.length > 0) {
      await blockOverlay(
        protocol,
        change,
        node,
        'BLOCKED: invalid Output Schema artifacts: ' + invalidArtifacts.join(', '),
      );
      process.exit(1);
    }
    const missingRequired = await missingRequiredSkillChecks(protocol, node, overlayEvidence, change);
    if (missingRequired.length > 0) {
      await blockOverlay(
        protocol,
        change,
        node,
        'BLOCKED: missing required Skill evidence: ' + missingRequired.join(', '),
      );
      process.exit(1);
    }
    const currentReceipts = await validReceipts(protocol, node, overlayEvidence, change);
    const missingReceiptCoverage = missingReceiptSchemaCoverage(
      protocol,
      node,
      currentReceipts,
      overlayEvidence,
    );
    if (missingReceiptCoverage.length > 0) {
      await blockOverlay(
        protocol,
        change,
        node,
        'BLOCKED: Required Skill receipts do not jointly cover current Output Schema evidence: ' +
          missingReceiptCoverage.join(', '),
      );
      process.exit(1);
    }
    const segmentCoverageFailures = implementationSegmentCoverageFailures(
      protocol,
      node,
      currentReceipts,
      overlayEvidence,
    );
    if (segmentCoverageFailures.length > 0) {
      await blockOverlay(
        protocol,
        change,
        node,
        'BLOCKED: execute review receipts do not exactly cover completed implementation segments: ' +
          segmentCoverageFailures.join(', '),
      );
      process.exit(1);
    }
    const missingAugmentations = await missingAugmentationChecks(
      protocol,
      node,
      overlayEvidence,
      change,
    );
    if (missingAugmentations.length > 0) {
      await blockOverlay(
        protocol,
        change,
        node,
        'BLOCKED: missing augmentation evidence: ' + missingAugmentations.join(', '),
      );
      process.exit(1);
    }
    if (await blockOnSemanticFailures(protocol, node, evidence, evidenceState.evidence, change)) {
      process.exit(1);
    }
    if (node.id === 'review' && evidenceValue(evidence, 'review-spec-digest', evidenceState.evidence) !==
      (await checkStartApproval(change.name)).specDigest) {
      await blockOverlay(protocol, change, node, 'BLOCKED: review is bound to an old spec digest.');
      process.exit(1);
    }
    if (node.id === 'review') await checkSecondReview(change.name);
    if (node.id === 'verify' || node.id === 'archive') await checkWebQa(change.name);
    if (command === 'authorize') {
      const ledger = overlayLedger(evidenceState.evidence);
      const healthRequired = (node.requiredSkillCalls ?? []).some((binding) => binding.skill === 'health');
      const healthReceipt = healthRequired ? [...(await validReceipts(protocol, node, overlayEvidence, change))]
        .reverse().find((receipt) => receipt.check === 'required-skill:' + node.id + '.health') : null;
      if (healthRequired && !healthReceipt) {
        await blockOverlay(protocol, change, node, 'BLOCKED: archive authorization requires a valid current health receipt.');
        process.exit(1);
      }
      const codeStateHash = await currentCodeStateHash();
      const draftHash = await currentBundleDraftHash(protocol);
      if (healthRequired && (healthReceipt.codeStateHash !== codeStateHash || healthReceipt.draftHash !== draftHash)) {
        await blockOverlay(
          protocol,
          change,
          node,
          'BLOCKED: health receipt does not match the current code state and Bundle draft.',
        );
        process.exit(1);
      }
      let verifyAuthorization;
      try {
        verifyAuthorization = await currentVerifyAuthorization(
          protocol,
          change,
          evidenceState.evidence,
        );
      } catch (error) {
        await blockOverlay(
          protocol,
          change,
          node,
          'BLOCKED: archive authorization requires the current ledger-backed verify chain: ' +
            String(error instanceof Error ? error.message : error),
        );
        process.exit(1);
      }
      try {
        const boundaryClaim = JSON.parse(
          await fs.readFile(archiveBoundaryClaimPath(protocol, change), 'utf8'),
        );
        if (
          boundaryClaim.status === 'claimed' ||
          boundaryClaim.status === 'prepared' ||
          boundaryClaim.status === 'consumed'
        ) {
          throw new Error(
            'Archive boundary is already claimed or consumed; a new authorization cannot be issued.',
          );
        }
      } catch (error) {
        if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
      }
      const authorizedAt = new Date().toISOString();
      const protocolHash = currentProtocolHash(protocol);
      const artifactSnapshots = {
        health: await requiredArtifactSnapshots(protocol, node, change),
        verify: verifyAuthorization?.artifactSnapshots ?? [],
      };
      const snapshotDigest = artifactSnapshotDigest(artifactSnapshots);
      const authorizationFingerprint = createHash('sha256')
        .update(
          [
            protocol.name,
            change.name,
            protocolHash,
            healthReceipt?.id ?? '',
            healthReceipt?.reportDigest ?? '',
            codeStateHash,
            draftHash,
            verifyAuthorization?.guardResultId ?? '',
            ...(verifyAuthorization?.receiptIds ?? []),
            ...(verifyAuthorization?.reportDigests ?? []),
            snapshotDigest,
          ].join('\0'),
        )
        .digest('hex');
      let authorization = ledger.archiveAuthorizations.find(
        (entry) =>
          entry.fingerprint === authorizationFingerprint &&
          entry.change === change.name &&
          entry.protocolHash === protocolHash &&
          entry.status === 'authorized',
      );
      const generation = ledger.archiveAuthorizations.filter(
        (entry) =>
          entry.fingerprint === authorizationFingerprint &&
          entry.change === change.name &&
          entry.protocolHash === protocolHash,
      ).length;
      const authorizationId = authorization?.id ??
        createHash('sha256')
          .update(authorizationFingerprint + '\0generation:' + String(generation))
          .digest('hex');
      for (const entry of ledger.archiveAuthorizations) {
        if (
          entry !== authorization &&
          entry.node === 'archive' &&
          entry.change === change.name &&
          entry.protocolHash === protocolHash &&
          entry.status === 'authorized'
        ) {
          entry.status = 'revoked';
          entry.revokedAt = authorizedAt;
          entry.revokedBy = authorizationId;
        }
      }
      authorization ??= {
        id: authorizationId,
        fingerprint: authorizationFingerprint,
        node: node.id,
        change: change.name,
        ...(healthReceipt ? { healthReceiptId: healthReceipt.id,
          healthReportDigest: healthReceipt.reportDigest } : {}),
        protocolHash,
        codeStateHash,
        draftHash,
        artifactSnapshots,
        snapshotDigest,
        ...(verifyAuthorization
          ? {
              verifyGuardResultId: verifyAuthorization.guardResultId,
              verifyReceiptIds: verifyAuthorization.receiptIds,
              verifyReportDigests: verifyAuthorization.reportDigests,
            }
          : {}),
        status: 'authorized',
        authorizedAt,
      };
      if (!ledger.archiveAuthorizations.includes(authorization)) {
        ledger.archiveAuthorizations.push(authorization);
      }
      await writeOverlayEvidence(protocol, change, evidenceState.evidence);
      console.log('ARCHIVE AUTHORIZED');
      console.log('AUTHORIZATION: ' + authorization.id);
      if (healthReceipt) console.log('HEALTH RECEIPT: ' + healthReceipt.id);
      return;
    }
    if (node.id === 'archive') {
      const ledger = overlayLedger(evidenceState.evidence);
      const currentAuthorization = [...ledger.archiveAuthorizations]
        .reverse()
        .find(
          (authorization) =>
            authorization.status === 'consumed' &&
            authorization.change === change.name &&
            authorization.protocolHash === currentProtocolHash(protocol),
        );
      if (!currentAuthorization) {
        await blockOverlay(
          protocol,
          change,
          node,
          'BLOCKED: archive completion requires a consumed pre-archive authorization.',
        );
        process.exit(1);
      }
    }
    const guardResult = await recordOverlayGuardSuccess(
      protocol,
      change,
      node,
      evidenceState.evidence,
    );
    console.log('ALL CHECKS PASSED');
    console.log('GUARD RESULT: ' + guardResult.id);
    if (apply) {
      const routedNodeId = await currentOverlayNode(protocol, change, evidenceState.evidence);
      const classicPhase = classicPhaseForOverlayNode(node.id, change.state);
      if (
        classicPhase &&
        (
          routedNodeId === node.id ||
          remediationRequiresClassicBuildAdvance(
            change,
            evidenceState.evidence,
            node.id,
            routedNodeId,
          )
        )
      ) {
        const classicResult = runClassicGuardApply(change, classicPhase);
        if (classicResult.stdout) process.stdout.write(classicResult.stdout);
        if (classicResult.stderr) process.stderr.write(classicResult.stderr);
        if (classicResult.status !== 0) {
          console.error(
            'BLOCKED: original Classic guard did not advance after the overlay gate: ' +
              String(classicResult.error?.message || 'exit ' + classicResult.status),
          );
          process.exitCode = classicResult.status ?? 1;
          return;
        }
        console.log('COMET STATE: original Classic guard applied after overlay success.');
        const refreshedChange = await resolveCometOverlayChange();
        const refreshedEvidence = await readOverlayEvidence(protocol, refreshedChange);
        const refreshedNodeId = await currentOverlayNode(
          protocol,
          refreshedChange,
          refreshedEvidence,
        );
        printNext(
          protocol,
          route(protocol).find((candidate) => candidate.id === refreshedNodeId) ?? null,
        );
        return;
      }
      console.log('COMET STATE: unchanged; continue the next overlay quality Node before Classic progression.');
      printNext(
        protocol,
        route(protocol).find((candidate) => candidate.id === routedNodeId) ?? null,
      );
      return;
    }
    console.log('APPLY: rerun with --apply to update workflow state');
    return;
  }
  const file = statePath(protocol);
  const state = await readJson(file);
  state.completedNodes = Array.isArray(state.completedNodes) ? state.completedNodes : [];
  state.evidence = state.evidence && typeof state.evidence === 'object' ? state.evidence : {};
  if (command === 'entry') {
    const current = state.currentNode ?? nextNode(protocol, state)?.id ?? null;
    if (current !== node.id && !state.completedNodes.includes(node.id)) {
      console.error('BLOCKED: current Node is ' + String(current) + ', cannot enter ' + node.id + '.');
      process.exit(1);
    }
    console.log('ENTRY OK: ' + node.id);
    return;
  }
  const evidence = evidenceFor(state, node.id);
  if (!evidence) {
    console.error('BLOCKED: missing evidence for Node ' + node.id + '.');
    process.exit(1);
  }
  const missingSchemaEvidence = missingRequiredSchemaEvidence(protocol, node, evidence, state.evidence);
  if (missingSchemaEvidence.length > 0) {
    console.error('BLOCKED: missing Output Schema evidence: ' + missingSchemaEvidence.join(', '));
    process.exit(1);
  }
  const invalidArtifacts = await invalidRequiredArtifacts(
    protocol,
    node,
    evidence,
    state.evidence,
  );
  if (invalidArtifacts.length > 0) {
    console.error('BLOCKED: invalid Output Schema artifacts: ' + invalidArtifacts.join(', '));
    process.exit(1);
  }
  const missingRequired = await missingRequiredSkillChecks(protocol, node, state.evidence);
  if (missingRequired.length > 0) {
    console.error('BLOCKED: missing required Skill evidence: ' + missingRequired.join(', '));
    process.exit(1);
  }
  const missingAugmentations = await missingAugmentationChecks(protocol, node, state.evidence);
  if (missingAugmentations.length > 0) {
    console.error('BLOCKED: missing augmentation evidence: ' + missingAugmentations.join(', '));
    process.exit(1);
  }
  if (await blockOnSemanticFailures(protocol, node, evidence, state.evidence)) {
    process.exit(1);
  }
  if (apply) {
    const completed = completedSet(state);
    completed.add(node.id);
    state.completedNodes = route(protocol).filter((item) => completed.has(item.id)).map((item) => item.id);
    const next = nextNode(protocol, state);
    state.currentNode = next?.id ?? null;
    state.status = next ? 'running' : 'completed';
    state.history = Array.isArray(state.history) ? state.history : [];
    state.history.push({ event: 'exit-applied', node: node.id, at: new Date().toISOString() });
    await writeJson(file, state);
    console.log('ALL CHECKS PASSED');
    printNext(protocol, next);
    return;
  }
  console.log('ALL CHECKS PASSED');
  console.log('APPLY: rerun with --apply to update workflow state');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

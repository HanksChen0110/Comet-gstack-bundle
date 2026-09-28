#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCometChangeResolver } from './change-selection.mjs';

const root = process.env.COMET_RUN_ROOT ? path.resolve(process.env.COMET_RUN_ROOT) : process.cwd();
const digest = (value) => createHash('sha256').update(value).digest('hex');
const policyPath = (change) => path.join(root, '.comet', 'workflow-evidence', change, 'start-approval.json');
const guardPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflow-guard.mjs');

function codeStateHash() {
  const result = spawnSync(process.execPath, [guardPath, 'context'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error('Cannot read current code hash: ' + (result.stderr || result.error?.message));
  return JSON.parse(result.stdout).codeStateHash;
}

async function specSnapshot(change) {
  const base = path.join(root, 'openspec', 'changes', change);
  const files = [];
  for (const name of ['proposal.md', 'design.md', 'tasks.md']) {
    const file = path.join(base, name);
    try { await fs.access(file); files.push(file); } catch { /* optional OpenSpec artifact */ }
  }
  async function collect(directory) {
    try {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, item.name);
        if (item.isDirectory()) await collect(file);
        else if (item.isFile() && item.name === 'spec.md') files.push(file);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await collect(path.join(base, 'specs'));
  if (!files.some((file) => file.endsWith('spec.md')) || !files.some((file) => file.endsWith('proposal.md'))) {
    throw new Error('OpenSpec proposal and at least one delta spec are required before approval.');
  }
  const entries = [];
  for (const file of files.sort()) {
    let content = await fs.readFile(file, 'utf8');
    if (file.endsWith('tasks.md')) content = content.replace(/\[[ xX]\]/gu, '[ ]');
    entries.push([path.relative(root, file).replaceAll('\\', '/'), digest(content)]);
  }
  return { digest: digest(JSON.stringify(entries)), files: entries };
}

async function rulesSnapshot() {
  const entries = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(root, name);
    try { entries.push([name, digest(await fs.readFile(file))]); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  if (entries.length === 0) throw new Error('Project AGENTS.md or CLAUDE.md is required.');
  return { digest: digest(JSON.stringify(entries)), files: entries };
}

async function readApproval(change) {
  const value = JSON.parse(await fs.readFile(policyPath(change), 'utf8'));
  if (value.schema !== 'comet.start-approval.v1' || value.change !== change) throw new Error('Invalid start approval.');
  return value;
}

async function writeApproval(change, value) {
  const file = policyPath(change);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temp, file);
}

function substantive(value) { return typeof value === 'string' && value.trim().length > 0; }
function validateBrief(input) {
  if (input.userConfirmation?.kind !== 'explicit-user' || !substantive(input.userConfirmation?.text)) {
    throw new Error('A concrete user confirmation of this spec version is required.');
  }
  if (!substantive(input.goal) || !Array.isArray(input.nonGoals) || input.nonGoals.length === 0 ||
      !['document', 'web', 'code'].includes(input.taskType) || !Array.isArray(input.scenarios) ||
      input.scenarios.length === 0 || !Array.isArray(input.checks) || input.checks.length === 0) {
    throw new Error('Approval needs goal, nonGoals, taskType, scenarios and verification checks.');
  }
  if (!Array.isArray(input.rules) || input.rules.length === 0 || input.rules.some((item) =>
    !substantive(item.text) || !substantive(item.source) || item.status !== 'confirmed')) {
    throw new Error('Each applicable rule needs a source and confirmed status.');
  }
  if (!Array.isArray(input.unknowns) || input.unknowns.some((item) =>
    !substantive(item.text) || !['resolved', 'nonblocking'].includes(item.status))) {
    throw new Error('Unresolved implementation unknowns or rule conflicts block approval.');
  }
  if (input.conflicts?.length) throw new Error('Rule conflicts must be resolved before approval.');
  if (input.riskLevel !== undefined && !['normal', 'high'].includes(input.riskLevel)) {
    throw new Error('riskLevel must be normal or high.');
  }
  if (input.scenarios.some((item) => !substantive(item))) throw new Error('Acceptance scenarios must be concrete.');
  if (input.checks.some((item) => !substantive(item))) throw new Error('Verification commands must be concrete.');
}

export async function checkStartApproval(change, { budget = true } = {}) {
  let approval;
  try { approval = await readApproval(change); }
  catch { throw new Error('No valid start approval. Stop before code, tests or review.'); }
  const [spec, rules] = await Promise.all([specSnapshot(change), rulesSnapshot()]);
  if (spec.digest !== approval.specDigest || rules.digest !== approval.rulesDigest) {
    if (!approval.invalidatedAt) {
      approval.invalidatedAt = new Date().toISOString();
      approval.invalidationReason = 'spec-or-project-rules-changed';
      await writeApproval(change, approval);
    }
    throw new Error('Spec or project rules changed. Obtain approval for the new version before code, tests or review.');
  }
  if (approval.invalidatedAt) throw new Error('This start approval was invalidated; confirm the current version again.');
  validateBrief(approval);
  if (budget && Date.now() >= Date.parse(approval.expiresAt)) {
    throw new Error('Time budget exhausted. Save handoff evidence and obtain a new budget confirmation.');
  }
  if (budget && approval.repairRounds > approval.maxRepairRounds) {
    throw new Error('Repair budget exhausted. Save handoff evidence and obtain a new budget confirmation.');
  }
  return approval;
}

export async function consumeRepairRound(change) {
  const approval = await checkStartApproval(change);
  if (approval.repairRounds >= approval.maxRepairRounds) throw new Error('Repair budget exhausted.');
  approval.repairRounds += 1;
  await writeApproval(change, approval);
  return approval.repairRounds;
}

export async function checkWebQa(change) {
  const approval = await checkStartApproval(change);
  if (approval.taskType !== 'web') return;
  const record = approval.webQa;
  if (!record || record.specDigest !== approval.specDigest || record.codeStateHash !== codeStateHash()) {
    throw new Error('Web task needs current read-only QA evidence for approved scenarios.');
  }
  const raw = await fs.readFile(path.join(root, record.path));
  if (digest(raw) !== record.sha256) throw new Error('Read-only QA report changed.');
}

export async function checkSecondReview(change) {
  const approval = await checkStartApproval(change);
  if (approval.riskLevel !== 'high') return;
  const record = approval.secondReview;
  if (!record || record.specDigest !== approval.specDigest || record.codeStateHash !== codeStateHash()) {
    throw new Error('High-risk change needs an independent second review on current code and spec.');
  }
  const raw = await fs.readFile(path.join(root, record.path));
  if (digest(raw) !== record.sha256) throw new Error('Second review report changed.');
}

async function main() {
  const command = process.argv[2] ?? 'snapshot';
  const change = (await createCometChangeResolver(root).resolveCometOverlayChange()).name;
  if (command === 'snapshot') {
    console.log(JSON.stringify({ change, spec: await specSnapshot(change), rules: await rulesSnapshot() }, null, 2));
    return;
  }
  if (command === 'approve') {
    const input = JSON.parse(await fs.readFile(path.resolve(process.argv[3]), 'utf8'));
    validateBrief(input);
    const [spec, rules] = await Promise.all([specSnapshot(change), rulesSnapshot()]);
    if (input.specDigest !== spec.digest || input.rulesDigest !== rules.digest) {
      throw new Error('Approval does not match the current OpenSpec and project rules digests.');
    }
    const minutes = input.budgetMinutes ?? 240;
    const maxRepairRounds = input.maxRepairRounds ?? 1;
    if (!Number.isInteger(minutes) || minutes < 1 || !Number.isInteger(maxRepairRounds) || maxRepairRounds < 0) {
      throw new Error('Budget minutes and repair rounds must be nonnegative integers.');
    }
    const approvedAt = new Date().toISOString();
    const approval = { ...input, schema: 'comet.start-approval.v1', change,
      riskLevel: input.riskLevel ?? 'normal', specFiles: spec.files,
      ruleFiles: rules.files, approvedAt, expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
      budgetMinutes: minutes, maxRepairRounds, repairRounds: 0, checksRun: [], handoff: null };
    await writeApproval(change, approval);
    console.log('START APPROVED: ' + spec.digest);
    console.log('EXPIRES: ' + approval.expiresAt);
    return;
  }
  if (command === 'handoff') {
    const approval = await readApproval(change);
    approval.handoff = { at: new Date().toISOString(), note: process.argv.slice(3).join(' ') };
    await writeApproval(change, approval);
    console.log('HANDOFF SAVED');
    return;
  }
  const approval = await checkStartApproval(change);
  if (command === 'check') { console.log('START APPROVAL OK: ' + approval.specDigest); return; }
  if (command === 'check-qa') { await checkWebQa(change); console.log('SCOPED QA OK'); return; }
  if (command === 'check-second-review') {
    await checkSecondReview(change);
    console.log('SECOND REVIEW OK');
    return;
  }
  if (command === 'repair') {
    const rounds = await consumeRepairRound(change);
    console.log('REPAIR ROUND: ' + rounds + '/' + approval.maxRepairRounds);
    return;
  }
  if (command === 'record-qa') {
    if (approval.taskType !== 'web') throw new Error('Browser QA applies only to approved web tasks.');
    const file = path.resolve(process.argv[3]);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA report must stay inside the project.');
    const raw = await fs.readFile(file);
    const report = JSON.parse(raw.toString('utf8'));
    if (report.readOnly !== true || report.passed !== true || !Array.isArray(report.scenarios) ||
        approval.scenarios.some((item) => !report.scenarios.includes(item)) ||
        report.scenarios.some((item) => !approval.scenarios.includes(item))) {
      throw new Error('QA report must pass, be read-only, and cover only approved scenarios.');
    }
    approval.webQa = { path: relative.replaceAll('\\', '/'), sha256: digest(raw),
      specDigest: approval.specDigest, codeStateHash: codeStateHash(), recordedAt: new Date().toISOString() };
    await writeApproval(change, approval);
    console.log('READ-ONLY QA RECORDED');
    return;
  }
  if (command === 'record-second-review') {
    if (approval.riskLevel !== 'high') throw new Error('Second review is reserved for high-risk changes.');
    const file = path.resolve(process.argv[3]);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Second review report must stay inside the project.');
    const raw = await fs.readFile(file);
    const report = JSON.parse(raw.toString('utf8'));
    if (report.independent !== true || report.passed !== true || !substantive(report.reviewer)) {
      throw new Error('Second review needs an identified independent reviewer and pass result.');
    }
    approval.secondReview = { path: relative.replaceAll('\\', '/'), sha256: digest(raw),
      specDigest: approval.specDigest, codeStateHash: codeStateHash(), recordedAt: new Date().toISOString() };
    await writeApproval(change, approval);
    console.log('SECOND REVIEW RECORDED');
    return;
  }
  if (command === 'run-check') {
    const separator = process.argv.indexOf('--');
    const args = process.argv.slice(separator + 1);
    if (separator < 0 || args.length === 0) throw new Error('run-check requires -- <command> [args].');
    const commandText = args.join(' ');
    if (!approval.checks.includes(commandText)) throw new Error('Check was not approved: ' + commandText);
    const currentCode = codeStateHash();
    const prior = approval.checksRun.findLast((item) => item.command === commandText &&
      item.codeStateHash === currentCode && item.specDigest === approval.specDigest);
    if (prior?.exitCode === 0) { console.log('CHECK REUSED: ' + commandText); return; }
    if (prior && prior.exitCode !== 0) throw new Error('Repeated failed check on unchanged code. Investigate and pause.');
    const executable = process.platform === 'win32' && /^(npm|pnpm|yarn|npx)$/iu.test(args[0])
      ? args[0] + '.cmd' : args[0];
    const result = spawnSync(executable, args.slice(1), { cwd: root, encoding: 'utf8', timeout: 600000,
      maxBuffer: 8 * 1024 * 1024, shell: process.platform === 'win32' && /\.(cmd|bat)$/iu.test(executable) });
    approval.checksRun.push({ command: commandText, at: new Date().toISOString(), exitCode: result.status,
      timedOut: result.error?.code === 'ETIMEDOUT', codeStateHash: currentCode,
      specDigest: approval.specDigest });
    await writeApproval(change, approval);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
    return;
  }
  throw new Error('Unknown policy command: ' + command);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error('BLOCKED: ' + error.message); process.exitCode = 1; });
}

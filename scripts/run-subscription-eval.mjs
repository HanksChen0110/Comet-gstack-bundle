#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const handoffScript = path.join(project, 'scripts', 'bundle-eval-handoff.mjs');
const pilot = path.resolve(project, '..', 'Comet-gstack-pilot', 'pilot-report.md');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
const dryRun = process.argv.includes('--dry-run');

function runLocal(args) {
  const result = spawnSync(process.execPath, [handoffScript, ...args], {
    cwd: project, encoding: 'utf8', timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim());
  return JSON.parse(result.stdout);
}

function claudeExecutable() {
  if (process.env.CLAUDE_CLI) return path.resolve(process.env.CLAUDE_CLI);
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? '', 'npm', 'node_modules',
      '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  }
  return 'claude';
}

function readPacket(stdout) {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const value = JSON.parse(line);
      if (value?.type === 'result') return value;
    } catch { /* CLI notices are not result JSON. */ }
  }
  throw new Error('Agent did not return a machine-readable result.');
}

function assessment(packet, ids) {
  const raw = packet.structured_output ?? packet.result;
  const value = typeof raw === 'string'
    ? JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gu, '')) : raw;
  if (!value || !Array.isArray(value.scenarioVerdicts) ||
      value.scenarioVerdicts.length !== ids.length ||
      ids.some((id) => value.scenarioVerdicts.filter((item) => item.id === id).length !== 1) ||
      value.scenarioVerdicts.some((item) =>
        !['pass', 'fail', 'inconclusive'].includes(item.verdict) ||
        typeof item.evidence !== 'string' || !item.evidence.trim()) ||
      typeof value.summary !== 'string' || !value.summary.trim() ||
      typeof value.reviewMarkdown !== 'string' || !value.reviewMarkdown.trim()) {
    throw new Error('Agent assessment is incomplete.');
  }
  return value;
}

async function invokeClaude(prompt, maxMinutes) {
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['summary', 'scenarioVerdicts', 'reviewMarkdown'],
    properties: {
      summary: { type: 'string' }, reviewMarkdown: { type: 'string' },
      scenarioVerdicts: { type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'verdict', 'evidence'],
        properties: { id: { type: 'string' },
          verdict: { type: 'string', enum: ['pass', 'fail', 'inconclusive'] },
          evidence: { type: 'string' } },
      } },
    },
  };
  const args = ['-p', '--model', 'deepseek-v4-flash',
    '--system-prompt', '你是独立只读评测者。只按可核对证据判断，输出要求的 JSON。',
    '--tools', 'Read', '--strict-mcp-config',
    '--permission-mode', 'dontAsk', '--no-session-persistence',
    '--max-budget-usd', '1', '--output-format', 'json',
    '--json-schema', JSON.stringify(schema), prompt];
  const child = spawn(claudeExecutable(), args, { cwd: path.dirname(project), windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, maxMinutes * 60_000);
  child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 2_000_000) child.kill(); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject); child.on('close', resolve);
  });
  clearTimeout(timer);
  if (timedOut) throw new Error('Agent time budget exhausted.');
  const packet = readPacket(stdout);
  if (exitCode !== 0 || packet.is_error || packet.terminal_reason !== 'completed') {
    const error = new Error(`Agent stopped: reason=${packet.terminal_reason}, ` +
      `estimatedCostUsd=${packet.total_cost_usd}, ` +
      `detail=${String(packet.result ?? stderr).slice(-200)}`);
    error.packet = packet;
    throw error;
  }
  return packet;
}

async function main() {
  const prepared = runLocal(['prepare', '--project', project]);
  const request = JSON.parse(await fs.readFile(prepared.requestPath, 'utf8'));
  const directory = path.dirname(prepared.requestPath);
  const priorReceipt = path.join(directory, 'verified.json');
  try {
    const prior = JSON.parse(await fs.readFile(priorReceipt, 'utf8'));
    if (prior.outcome === 'passed' && prior.mode === 'external-agent' &&
        prior.requestId === request.requestId) {
      for (const name of await fs.readdir(directory)) {
        if (!/^result\..+\.json$/u.test(name)) continue;
        const resultPath = path.join(directory, name);
        if (sha256(await fs.readFile(resultPath)) !== prior.resultSha256) continue;
        const checked = runLocal(['verify', '--project', project,
          '--request', prepared.requestPath, '--result', resultPath]);
        if (checked.outcome === 'passed') {
          console.log(JSON.stringify({ status: 'reused', requestId: request.requestId,
            resultPath, verifiedPath: priorReceipt }));
          return;
        }
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const draft = path.join(project, request.snapshot.draftPath);
  const isolation = path.join(directory, 'isolation', stamp);
  const isolated = path.join(isolation, 'bundle');
  const pilotCopy = path.join(isolation, 'pilot-report.md');
  if (!dryRun) {
    await fs.cp(draft, isolated, { recursive: true, errorOnExist: true });
    await fs.copyFile(pilot, pilotCopy);
  }
  if (dryRun) {
    console.log(JSON.stringify({ status: 'ready', requestId: request.requestId,
      agent: 'claude-code', source: draft, pilot, plannedIsolation: isolated }));
    return;
  }
  const ids = request.scenarios.map((item) => item.id);
  const prompt = [
    '你是独立只读评测 Agent。只使用 Read，不修改文件、不运行命令、不调用其他 Agent。',
    `读取请求 ${prepared.requestPath} 和本次冻结的试点报告 ${pilotCopy}。`,
    `在隔离 Bundle ${isolated} 中定向检查六项场景。优先读 SKILL.md、reference/start-approval.md、scripts/workflow-policy.mjs 和 scripts/workflow-guard.mjs 的相关行；总计最多 8 次 Read，不做全树浏览。`,
    '试点报告中的命令输出可作为历史证据，但不要把未执行的测试说成自己运行过。文件未覆盖的判断须标 inconclusive。',
    '每项给 pass、fail 或 inconclusive 和具体文件/证据；证据不足必须 inconclusive。',
    '返回符合 JSON schema 的对象，reviewMarkdown 写简短中文评测报告；不声称 Comet 官方 eval 或 ready 已通过。',
  ].join('\n');
  let packet;
  let value;
  let errorSummary = null;
  try {
    packet = await invokeClaude(prompt, Math.min(request.budget.maxMinutes, 45));
    value = assessment(packet, ids);
  } catch (error) {
    packet = error.packet ?? packet;
    errorSummary = String(error.message ?? error).slice(0, 500);
  }
  const outcome = errorSummary ? 'blocked' :
    value.scenarioVerdicts.some((item) => item.verdict === 'fail') ? 'failed' :
      value.scenarioVerdicts.every((item) => item.verdict === 'pass') ? 'passed' : 'blocked';
  const reviewPath = path.join(directory, `review.${stamp}.md`);
  const reviewText = errorSummary
    ? `# 外部评测未完成\n\n${errorSummary}\n` : value.reviewMarkdown.trim() + '\n';
  await fs.writeFile(reviewPath, reviewText, 'utf8');
  if (packet) {
    const statusPath = path.join(directory, `agent-status.${stamp}.json`);
    await fs.writeFile(statusPath, JSON.stringify({
      terminalReason: packet.terminal_reason,
      estimatedCostUsd: packet.total_cost_usd,
      modelUsage: packet.modelUsage,
      usage: packet.usage,
      isError: packet.is_error,
    }, null, 2) + '\n', 'utf8');
  }
  const models = Object.keys(packet?.modelUsage ?? {});
  const result = {
    schemaVersion: 2, kind: 'comet.bundle-eval-return',
    requestId: request.requestId, snapshot: request.snapshot,
    mode: 'external-agent', outcome, agent: 'claude-code',
    model: models.join(', ') || 'unknown-cli-model',
    summary: errorSummary ?? value.summary,
    scenarioVerdicts: errorSummary
      ? ids.map((id) => ({ id, verdict: 'inconclusive', evidence: errorSummary }))
      : value.scenarioVerdicts,
    review: { path: path.basename(reviewPath),
      sha256: sha256(await fs.readFile(reviewPath)) },
    pilotEvidence: { path: path.relative(directory, pilotCopy).replaceAll('\\', '/'),
      sha256: sha256(await fs.readFile(pilotCopy)) },
    officialResult: null,
    usage: packet ? { totalCostUsd: packet.total_cost_usd,
      inputTokens: packet.usage?.input_tokens,
      outputTokens: packet.usage?.output_tokens } : null,
  };
  const resultPath = path.join(directory, `result.${stamp}.json`);
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  const verified = runLocal(['verify', '--project', project,
    '--request', prepared.requestPath, '--result', resultPath]);
  console.log(JSON.stringify({ status: outcome, requestId: request.requestId,
    resultPath, reviewPath, verifiedPath: priorReceipt,
    eligibleForCometRecord: verified.eligibleForCometRecord,
    usage: result.usage }));
  if (outcome !== 'passed') process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

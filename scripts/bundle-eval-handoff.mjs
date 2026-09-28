#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const bundleName = 'comet-gstack-quality-gates';
const schemaVersion = 2;
const scenarios = [
  { id: 'start-gate', check: '未确认规格、关键未知项或规则冲突时，代码、测试和审查调用均被阻止。' },
  { id: 'stale-approval', check: '规格、验收场景或适用规则实质变化后，旧开工确认失效。' },
  { id: 'document-replay', check: '四段文档任务不运行网页 QA，同一代码与规格摘要只审查一次完整 diff。' },
  { id: 'web-readonly', check: '网页任务只读检查批准的核心流程与受影响页面，QA 不自行改码。' },
  { id: 'bounded-repair', check: '新 change 默认总计 4 小时、最多 1 轮实现返工，超限留下可恢复交接；旧 change 沿用原预算。' },
  { id: 'evidence-integrity', check: '测试与审查证据绑定当前摘要，过期证据不能授权归档。' },
];

function options(argv) {
  const [action, ...rest] = argv;
  if (!['prepare', 'verify'].includes(action)) throw new Error('Use prepare or verify.');
  const result = { action, project: process.cwd() };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!['--project', '--request', '--result'].includes(flag) || !rest[index + 1]) {
      throw new Error('Expected --project, --request, or --result with a value.');
    }
    result[flag.slice(2)] = rest[index + 1];
  }
  return result;
}

function within(root, file) {
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Evidence path must stay inside .comet/eval-handoffs.');
  }
  return file;
}

async function filesIn(root, directory = root) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error('Bundle contains a symbolic link: ' + file);
    if (stat.isDirectory()) files.push(...await filesIn(root, file));
    else if (stat.isFile()) {
      files.push({
        path: path.relative(root, file).replaceAll('\\', '/'),
        sha256: hash(await fs.readFile(file)),
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

async function snapshot(project) {
  const source = path.join(project, '.comet', 'bundles', bundleName);
  const draft = path.join(project, '.comet', 'bundle-drafts', bundleName);
  const sourceFiles = await filesIn(source);
  const draftFiles = await filesIn(draft);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(draftFiles)) {
    throw new Error('Bundle source and draft differ; reconcile them before preparing eval.');
  }
  const manifest = path.join(draft, 'skills', bundleName, 'comet', 'eval.yaml');
  return {
    bundleTreeSha256: hash(JSON.stringify(draftFiles)),
    evalManifestSha256: hash(await fs.readFile(manifest)),
    draftPath: path.relative(project, draft).replaceAll('\\', '/'),
    evalManifestPath: path.relative(project, manifest).replaceAll('\\', '/'),
  };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temporary, file);
}

function sameSnapshot(left, right) {
  return left?.bundleTreeSha256 === right?.bundleTreeSha256 &&
    left?.evalManifestSha256 === right?.evalManifestSha256;
}

function filled(value) {
  return typeof value === 'string' && value.trim() !== '' && !/^<[^>]+>$/u.test(value.trim());
}

async function prepare(project, evidenceRoot) {
  const current = await snapshot(project);
  const requestId = hash(JSON.stringify({ schemaVersion, bundleName, ...current })).slice(0, 24);
  const directory = path.join(evidenceRoot, requestId);
  const requestPath = path.join(directory, 'request.json');
  let request;
  try {
    request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
    if (request.requestId !== requestId || !sameSnapshot(request.snapshot, current)) {
      throw new Error('Existing eval request does not match the current snapshot.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    request = {
      schemaVersion,
      kind: 'comet.bundle-eval-request',
      bundleName,
      requestId,
      createdAt: new Date().toISOString(),
      snapshot: current,
      scenarios,
      instructions: [
        'Use an isolated copy of this exact Bundle draft and eval manifest.',
        'With a subscription Agent, assess every scenario and return review.md plus result.json; mark mode external-agent.',
        'If using official Comet eval, run --collect first and return its unmodified repository-eval-result.json; mark mode comet-eval.',
        'Comet 0.4.3 official eval requires a supported API key in the evaluator environment; a Codex subscription login alone is insufficient.',
        'Never include credentials in evidence, edit Bundle authoring, mark ready, or publish.',
      ],
      budget: { maxMinutes: 45, maxReworkRounds: 1, maxTestCommandMinutes: 10 },
    };
    await writeJson(requestPath, request);
  }
  const templatePath = path.join(directory, 'result.template.json');
  try {
    await fs.access(templatePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeJson(templatePath, {
      schemaVersion,
      kind: 'comet.bundle-eval-return',
      requestId,
      snapshot: current,
      mode: 'external-agent',
      outcome: 'blocked',
      agent: '<agent-name>',
      model: '<model-name>',
      summary: '<observed result>',
      scenarioVerdicts: scenarios.map(({ id }) => ({ id, verdict: 'inconclusive', evidence: '' })),
      review: null,
      officialResult: null,
    });
  }
  const handoffPath = path.join(directory, 'EVAL-HANDOFF.md');
  try {
    await fs.access(handoffPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const lines = [
      '# Comet + gstack 评测交接',
      '',
      `请求 ID：${requestId}`,
      `维护仓库：${project}`,
      `试点记录：${path.join(path.dirname(project), 'Comet-gstack-pilot', 'pilot-report.md')}`,
      `Bundle draft：${current.draftPath}`,
      `Eval manifest：${current.evalManifestPath}`,
      `Bundle 快照 SHA-256：${current.bundleTreeSha256}`,
      `Manifest SHA-256：${current.evalManifestSha256}`,
      '',
      '## 给订阅 Agent 的任务',
      '',
      '在隔离副本中读取 request.json、Bundle 和试点证据；按下面场景评审。不要修改真源或发布状态。',
      '',
      ...scenarios.map(({ id, check }) => `- ${id}：${check}`),
      '',
      '把逐项判断、实际检查的路径和命令写进 review.md；按 result.template.json 填写 result.json，mode 保持 external-agent。只有六项均有可核对证据时才能写 passed。result.review 填为 {"path":"review.md","sha256":"<review.md 的 SHA-256>"}。认证缺失或证据不足时写 blocked 或 failed。',
      '',
      '预算：45 分钟、最多 1 轮返工、单条测试命令最多 10 分钟。到限保存已有证据并停止。不要把密钥或 token 写入任何交接文件。',
      '',
      '## Comet 官方 eval 路径',
      '',
      '只有评测环境自有 Comet 支持的 API 凭据时才运行官方 eval。先 --collect，再做限额评测；返回原样 repository-eval-result.json，并把 mode 设为 comet-eval。订阅登录本身不能满足 Comet 0.4.3 的凭据检查。外部 Agent 评审通过不解锁 Comet 原生 ready。',
      '',
    ];
    await fs.writeFile(handoffPath, lines.join('\n'), { encoding: 'utf8', flag: 'wx' });
  }
  console.log(JSON.stringify({ handoffPath, requestPath, requestId, snapshot: current }, null, 2));
}

async function verify(project, evidenceRoot, requestArg, resultArg) {
  if (!requestArg || !resultArg) throw new Error('verify requires --request and --result.');
  const requestPath = within(evidenceRoot, path.resolve(project, requestArg));
  const resultPath = within(evidenceRoot, path.resolve(project, resultArg));
  if (path.dirname(requestPath) !== path.dirname(resultPath)) {
    throw new Error('Request and result must use the same handoff directory.');
  }
  const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
  const resultRaw = await fs.readFile(resultPath);
  const result = JSON.parse(resultRaw.toString('utf8'));
  const current = await snapshot(project);
  if (request.schemaVersion !== schemaVersion || request.kind !== 'comet.bundle-eval-request' ||
      request.bundleName !== bundleName || !sameSnapshot(request.snapshot, current)) {
    throw new Error('Eval request is stale or invalid for the current Bundle.');
  }
  const expectedId = hash(JSON.stringify({ schemaVersion, bundleName, ...current })).slice(0, 24);
  if (request.requestId !== expectedId || result.schemaVersion !== schemaVersion ||
      result.kind !== 'comet.bundle-eval-return' || result.requestId !== expectedId ||
      !sameSnapshot(result.snapshot, current) ||
      !['passed', 'failed', 'blocked'].includes(result.outcome) ||
      !['external-agent', 'comet-eval'].includes(result.mode) ||
      !filled(result.agent) || !filled(result.model) || !filled(result.summary)) {
    throw new Error('Eval return has missing fields or does not match the request.');
  }
  if (result.mode === 'external-agent' && result.outcome === 'passed') {
    if (!Array.isArray(result.scenarioVerdicts) ||
        result.scenarioVerdicts.length !== scenarios.length ||
        scenarios.some(({ id }) => {
          const matches = result.scenarioVerdicts.filter((item) => item.id === id);
          return matches.length !== 1 || matches[0].verdict !== 'pass' ||
            typeof matches[0].evidence !== 'string' || !matches[0].evidence.trim();
        }) || !result.review) {
      throw new Error('External pass requires all scenario verdicts and a review artifact.');
    }
    const reviewPath = within(path.dirname(requestPath),
      path.resolve(path.dirname(requestPath), result.review.path));
    if (hash(await fs.readFile(reviewPath)) !== result.review.sha256) {
      throw new Error('External review SHA-256 does not match.');
    }
  }
  if (result.pilotEvidence) {
    const pilotPath = within(path.dirname(requestPath),
      path.resolve(path.dirname(requestPath), result.pilotEvidence.path));
    if (hash(await fs.readFile(pilotPath)) !== result.pilotEvidence.sha256) {
      throw new Error('Pilot evidence SHA-256 does not match.');
    }
  }
  let official = null;
  if (result.officialResult) {
    const officialPath = within(path.dirname(requestPath),
      path.resolve(path.dirname(requestPath), result.officialResult.path));
    const raw = await fs.readFile(officialPath);
    if (hash(raw) !== result.officialResult.sha256) {
      throw new Error('Official eval result SHA-256 does not match.');
    }
    official = JSON.parse(raw.toString('utf8'));
    if (official.schemaVersion !== 2 || official.provider !== 'comet-eval' ||
        !/^[a-f0-9]{64}$/i.test(String(official.draftHash)) ||
        !/^[a-f0-9]{64}$/i.test(String(official.evalManifestHash)) ||
        typeof official.passed !== 'boolean' || !Array.isArray(official.failures)) {
      throw new Error('Official eval result does not have the Comet result shape.');
    }
  }
  if (result.mode === 'comet-eval' && result.outcome === 'passed' &&
      (!official || !official.passed || official.failures.length !== 0)) {
    throw new Error('A passed return requires a passing official Comet eval result.');
  }
  const receipt = {
    schemaVersion,
    requestId: expectedId,
    mode: result.mode,
    outcome: result.outcome,
    eligibleForCometRecord: result.mode === 'comet-eval' && result.outcome === 'passed',
    resultSha256: hash(resultRaw),
    checkedAt: new Date().toISOString(),
    note: 'Evidence consistency only; Comet bundle eval-record must verify official hashes and gates.',
  };
  await writeJson(path.join(path.dirname(requestPath), 'verified.json'), receipt);
  console.log(JSON.stringify(receipt, null, 2));
}

async function main() {
  const args = options(process.argv.slice(2));
  const project = path.resolve(args.project);
  const evidenceRoot = path.join(project, '.comet', 'eval-handoffs', bundleName);
  if (args.action === 'prepare') await prepare(project, evidenceRoot);
  else await verify(project, evidenceRoot, args.request, args.result);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

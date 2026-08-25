import { promises as fs } from 'node:fs';
import path from 'node:path';

export function parseSimpleYaml(raw) {
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

async function readCurrentSelection(runRoot) {
  const selectionPath = path.join(runRoot, '.comet', 'current-change.json');
  let raw;
  try {
    raw = await fs.readFile(selectionPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }

  let selection;
  try {
    selection = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `current change selection contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (
    !selection ||
    typeof selection !== 'object' ||
    Array.isArray(selection) ||
    selection.schema !== 'comet.selection.v2' ||
    selection.workflow !== 'classic' ||
    typeof selection.change !== 'string' ||
    selection.change.trim() === ''
  ) {
    throw new Error(
      'current change selection must use schema comet.selection.v2 with workflow classic and a non-empty change.',
    );
  }
  return selection.change.trim();
}

export function createCometChangeResolver(runRoot) {
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
      const archived =
        state.archived === true || String(state.archived ?? '').toLowerCase() === 'true';
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
    if (changes.length === 1) return changes[0];

    const selectedName = await readCurrentSelection(runRoot);
    if (selectedName) {
      const selected = changes.find((change) => change.name === selectedName);
      if (!selected) {
        throw new Error(`selected Classic change '${selectedName}' is not active.`);
      }
      return selected;
    }

    throw new Error(
      'Multiple active Comet changes: ' +
        changes.map((change) => change.name).join(', ') +
        '. Ask the user which change to resume.',
    );
  }

  return { activeCometChanges, resolveCometOverlayChange };
}

import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function readStructuredArtifact(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }

  if (path.extname(file).toLowerCase() === '.md') {
    if (!/^#{1,6}\s+\S+/mu.test(raw)) return null;
    return { format: 'markdown' };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import type { HistoryEntry, HistoryRecord } from '../shared/ipc';

const MAX_RECORDS = 50;

function historyFile(): string {
  return path.join(app.getPath('userData'), 'history.json');
}

async function readRecords(): Promise<HistoryRecord[]> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(historyFile(), 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (entry): entry is HistoryRecord =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as HistoryRecord).timestamp === 'number' &&
        typeof (entry as HistoryRecord).outputPath === 'string',
    );
  } catch {
    return [];
  }
}

/** Append one finished run; the file keeps only the last MAX_RECORDS. */
export async function appendHistory(record: HistoryRecord): Promise<void> {
  const records = await readRecords();
  records.push(record);
  const capped = records.slice(-MAX_RECORDS);
  await fs.mkdir(path.dirname(historyFile()), { recursive: true });
  await fs.writeFile(historyFile(), JSON.stringify(capped, null, 2));
}

/** Newest-first, each enriched with whether the output folder still exists. */
export async function listHistory(): Promise<HistoryEntry[]> {
  const records = await readRecords();
  records.reverse();
  return Promise.all(
    records.map(async (record) => {
      let outputExists = false;
      try {
        outputExists = (await fs.stat(record.outputPath)).isDirectory();
      } catch {
        outputExists = false;
      }
      return { ...record, outputExists };
    }),
  );
}

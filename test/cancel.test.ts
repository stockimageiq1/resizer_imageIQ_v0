import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runShrink } from '../src/engine';
import { ShrinkError } from '../src/engine/types';
import { buildFixtures } from './fixtures';

async function treeChecksums(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  async function walk(abs: string, rel: string): Promise<void> {
    for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
      const entryAbs = path.join(abs, entry.name);
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(entryAbs, entryRel);
      else {
        map.set(entryRel.normalize('NFC'), createHash('sha256').update(await fs.readFile(entryAbs)).digest('hex'));
      }
    }
  }
  await walk(root, '');
  return map;
}

test('cancellation (engine orchestration)', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'iq-shrink-cancel-'));
  t.after(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });
  const inputDir = path.join(scratch, 'Cancel Shoot');
  await buildFixtures(inputDir);
  const before = await treeChecksums(inputDir);

  await t.test('abort mid-run rejects with CANCELLED and kills the video encode', async () => {
    const controller = new AbortController();
    await assert.rejects(
      runShrink({
        inputDir,
        signal: controller.signal,
        onProgress: (event) => {
          // abort the moment the first video starts encoding
          if (event.type === 'file-start' && event.kind === 'video') controller.abort();
        },
      }),
      (err: unknown) => err instanceof ShrinkError && err.code === 'CANCELLED',
    );
    assert.deepEqual([...(await treeChecksums(inputDir)).entries()].sort(), [...before.entries()].sort());
  });

  await t.test('already-aborted signal rejects immediately, before touching any output', async () => {
    const controller = new AbortController();
    controller.abort();
    const outDir = path.join(scratch, 'preexisting_out');
    await fs.mkdir(outDir, { recursive: true });
    const sentinel = path.join(outDir, 'sentinel.txt');
    await fs.writeFile(sentinel, 'must survive: cancel-before-start must not delete existing output');
    await assert.rejects(
      runShrink({ inputDir, outDir, overwrite: true, signal: controller.signal }),
      (err: unknown) => err instanceof ShrinkError && err.code === 'CANCELLED',
    );
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'must survive: cancel-before-start must not delete existing output');
  });
});

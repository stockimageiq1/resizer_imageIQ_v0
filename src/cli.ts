#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runShrink } from './engine';
import { ProgressEvent, ShrinkError, ShrinkSummary } from './engine/types';

const USAGE = `Usage: iq-shrink <input-folder> [options]

Creates a lowres proxy tree "{inputName}_lowres" next to the input folder.
Originals are never modified. File names are preserved exactly (HEIC/HEIF copies become .jpg).

Options:
  --zip           also create {inputName}_lowres.zip next to the output folder
  --out <path>    output folder (default: sibling "{inputName}_lowres")
  --overwrite     delete an existing output folder/zip and recreate from scratch
  -h, --help      show this help
`;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 'B';
  for (const next of ['KB', 'MB', 'GB', 'TB']) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

function createRenderer(): (event: ProgressEvent) => void {
  const tty = process.stdout.isTTY === true;
  const clearLine = (): void => {
    if (tty) process.stdout.write('\r\x1b[2K');
  };
  let total = 0;
  let done = 0;
  return (event) => {
    switch (event.type) {
      case 'scan':
        total = event.totalFiles;
        console.log(`Scanned ${event.totalFiles} files (${formatBytes(event.totalBytes)})`);
        break;
      case 'file-start':
        break;
      case 'video-progress':
        if (tty) {
          process.stdout.write(`\r\x1b[2K  encoding ${event.relPath} — ${Math.round(event.percent)}%`);
        }
        break;
      case 'file-done': {
        done += 1;
        clearLine();
        if (event.outcome === 'processed') {
          console.log(`[${done}/${total}] ok      ${event.relPath}`);
        } else {
          console.log(`[${done}/${total}] COPIED  ${event.relPath} — ${event.reason ?? 'unknown reason'}`);
        }
        break;
      }
      case 'zip-start':
        clearLine();
        console.log(`Zipping → ${event.zipPath}`);
        break;
      case 'zip-done':
        break;
    }
  };
}

function printSummary(summary: ShrinkSummary): void {
  console.log('');
  console.log(`Done in ${(summary.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  images processed:   ${summary.imagesProcessed}`);
  console.log(`  videos processed:   ${summary.videosProcessed}`);
  console.log(`  copied unprocessed: ${summary.copiedUnprocessed.length}`);
  for (const copied of summary.copiedUnprocessed) {
    console.log(`    - ${copied.relPath} — ${copied.reason}`);
  }
  console.log(
    `  size: ${formatBytes(summary.inputBytes)} → ${formatBytes(summary.outputBytes)}` +
      ` (${summary.percentSaved.toFixed(1)}% saved)`,
  );
  console.log(`  output: ${summary.outputPath}`);
  if (summary.zipPath !== undefined) console.log(`  zip:    ${summary.zipPath}`);
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        zip: { type: 'boolean', default: false },
        out: { type: 'string' },
        overwrite: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    process.exit(1);
  }

  if (parsed.values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const inputDir = parsed.positionals[0];
  if (inputDir === undefined || parsed.positionals.length !== 1) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const summary = await runShrink({
    inputDir,
    ...(parsed.values.out !== undefined ? { outDir: parsed.values.out } : {}),
    zip: parsed.values.zip === true,
    overwrite: parsed.values.overwrite === true,
    onProgress: createRenderer(),
  });
  printSummary(summary);
}

main().catch((err: unknown) => {
  if (err instanceof ShrinkError) {
    process.stderr.write(`error: ${err.message}\n`);
  } else {
    process.stderr.write(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }
  process.exit(1);
});

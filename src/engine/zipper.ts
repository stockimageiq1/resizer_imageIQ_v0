import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import archiver from 'archiver';
import { isJunkDir, isJunkFile } from './scanner';

/**
 * Zip the contents of outDir so the single root folder inside the archive is
 * `rootName` — the ORIGINAL input folder name. The "_lowres" suffix must not
 * leak into the archive: the downstream system parses folder names as
 * semantic context. Junk entries (.DS_Store, __MACOSX, …) are filtered again
 * here in case the OS dropped any into the output tree after processing.
 */
export async function zipOutput(outDir: string, zipPath: string, rootName: string): Promise<void> {
  const files: string[] = [];
  const emptyDirs: string[] = [];

  async function walk(abs: string, rel: string): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    let hasChild = false;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isJunkDir(entry.name)) continue;
        hasChild = true;
        await walk(path.join(abs, entry.name), rel === '' ? entry.name : `${rel}/${entry.name}`);
      } else if (entry.isFile()) {
        if (isJunkFile(entry.name)) continue;
        hasChild = true;
        files.push(rel === '' ? entry.name : `${rel}/${entry.name}`);
      }
    }
    if (!hasChild && rel !== '') emptyDirs.push(rel);
  }

  await walk(outDir, '');

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', reject);
    archive.pipe(output);
    for (const rel of files) {
      archive.file(path.join(outDir, ...rel.split('/')), { name: `${rootName}/${rel}` });
    }
    for (const rel of emptyDirs) {
      archive.append('', { name: `${rootName}/${rel}/` });
    }
    void archive.finalize();
  });
}

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { CopiedUnprocessed, FileKind, ScanResult, ScannedFile } from './types';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.tiff', '.tif', '.webp']);
const VIDEO_EXTS = new Set(['.mov', '.mp4', '.m4v', '.avi', '.mkv', '.mts', '.m2ts']);
const JUNK_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const JUNK_DIRS = new Set(['__macosx']);

export function isJunkFile(name: string): boolean {
  return name.startsWith('.') || JUNK_FILES.has(name.toLowerCase());
}

export function isJunkDir(name: string): boolean {
  return name.startsWith('.') || JUNK_DIRS.has(name.toLowerCase());
}

export function classify(name: string): FileKind {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'other';
}

export async function scanInput(root: string): Promise<ScanResult> {
  const files: ScannedFile[] = [];
  const dirs: string[] = [];
  const unreadable: CopiedUnprocessed[] = [];
  let totalBytes = 0;

  async function walk(dirAbs: string, relPosix: string): Promise<void> {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      const rel = relPosix === '' ? entry.name : `${relPosix}/${entry.name}`;

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // File symlinks are processed via their target; directory symlinks are
        // not followed (cycle/escape risk) but must not disappear silently.
        let target;
        try {
          target = await fs.stat(abs);
        } catch {
          unreadable.push({ relPath: rel, reason: 'broken symlink — nothing copied' });
          continue;
        }
        if (target.isDirectory()) {
          unreadable.push({ relPath: rel, reason: 'symlinked directory — links are not followed, nothing copied' });
          continue;
        }
        isDir = false;
        isFile = target.isFile();
      }

      if (isDir) {
        if (isJunkDir(entry.name)) continue;
        dirs.push(rel);
        await walk(abs, rel);
      } else if (isFile) {
        if (isJunkFile(entry.name)) continue;
        const stat = await fs.stat(abs);
        files.push({ absPath: abs, relPath: rel, kind: classify(entry.name), bytes: stat.size });
        totalBytes += stat.size;
      } else {
        unreadable.push({ relPath: rel, reason: 'not a regular file (socket/fifo/device) — nothing copied' });
      }
    }
  }

  await walk(root, '');
  return { files, dirs, unreadable, totalBytes };
}

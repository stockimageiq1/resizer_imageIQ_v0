import { createHash } from 'node:crypto';
import { constants, createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Release files for the update feed (same method as the Mac app).
 *
 * electron-builder writes release/latest-mac.yml for the build it made. The
 * Apple silicon build (npm run dist:mac) and the Intel one (npm run
 * package:mac:x64, in ../wt-resizer-x64) are two runs, so there are two such
 * files, each naming only its own zip. electron-updater on a Mac picks the
 * zip whose name contains "arm64" (or not) from ONE latest-mac.yml, so the
 * feed needs both entries in one file. prepareRelease checks both builds,
 * joins the two files and puts the seven files of a release in one folder,
 * ready to be dragged into a GitHub release by the owner. It uploads nothing.
 */

export interface LatestFile {
  url: string;
  sha512: string;
  size: number;
  /** Any other field electron-builder wrote for this file, kept as text. */
  extra: [string, string][];
}

export interface LatestMac {
  version: string;
  files: LatestFile[];
  releaseDate: string;
}

const unquote = (value: string): string => {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return JSON.parse(v) as string;
  return v;
};

/**
 * Reads the latest-mac.yml electron-builder 26 writes: top-level `key: value`
 * lines and a `files:` list of `- url: …` blocks. Anything else is refused,
 * rather than guessed at.
 */
export function parseLatestMac(text: string): LatestMac {
  const top = new Map<string, string>();
  const files: LatestFile[] = [];
  let current: Partial<LatestFile> & { extra: [string, string][] } | null = null;
  let inFiles = false;
  const finish = (): void => {
    if (current === null) return;
    if (!current.url || !current.sha512 || current.size === undefined) throw new Error('latest-mac.yml: a file without url, sha512 or size');
    files.push({ url: current.url, sha512: current.sha512, size: current.size, extra: current.extra });
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    const item = /^ {2}- ([A-Za-z0-9]+): (.*)$/.exec(raw);
    const field = /^ {4}([A-Za-z0-9]+): (.*)$/.exec(raw);
    const key = /^([A-Za-z0-9]+):(?: (.*))?$/.exec(raw);
    if (inFiles && item) {
      finish();
      current = { extra: [] };
      setField(current, item[1]!, item[2]!);
    } else if (inFiles && field && current !== null) {
      setField(current, field[1]!, field[2]!);
    } else if (key) {
      finish();
      inFiles = key[1] === 'files' && (key[2] ?? '') === '';
      if (!inFiles) {
        if (key[2] === undefined) throw new Error(`latest-mac.yml: unexpected block "${key[1]}"`);
        top.set(key[1]!, unquote(key[2]));
      }
    } else {
      throw new Error(`latest-mac.yml: unexpected line "${raw.slice(0, 80)}"`);
    }
  }
  finish();
  const version = top.get('version');
  const releaseDate = top.get('releaseDate');
  if (!version) throw new Error('latest-mac.yml: no version');
  if (files.length === 0) throw new Error('latest-mac.yml: no files');
  return { version, files, releaseDate: releaseDate ?? '' };
}

function setField(file: Partial<LatestFile> & { extra: [string, string][] }, name: string, value: string): void {
  if (name === 'url') file.url = unquote(value);
  else if (name === 'sha512') file.sha512 = unquote(value);
  else if (name === 'size') {
    const size = Number(unquote(value));
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`latest-mac.yml: bad size "${value}"`);
    file.size = size;
  } else file.extra.push([name, value.trim()]);
}

/** In electron-builder's own layout; path/sha512 at the top name the Intel zip (see joinLatestMac). */
export function serializeLatestMac(latest: LatestMac, legacy: LatestFile): string {
  const lines = [`version: ${latest.version}`, 'files:'];
  for (const file of latest.files) {
    lines.push(`  - url: ${file.url}`, `    sha512: ${file.sha512}`, `    size: ${file.size}`);
    for (const [name, value] of file.extra) lines.push(`    ${name}: ${value}`);
  }
  lines.push(`path: ${legacy.url}`, `sha512: ${legacy.sha512}`, `releaseDate: '${latest.releaseDate}'`);
  return `${lines.join('\n')}\n`;
}

export const isArm64 = (file: LatestFile): boolean => file.url.includes('arm64');

/**
 * One feed from the two builds: both of the same version, each with exactly
 * its own zip. The top-level path/sha512 (read only by updaters older than
 * electron-updater 4) name the Intel zip, which an Apple silicon Mac can run
 * too; the arm64 one would not start on an Intel Mac.
 */
export function joinLatestMac(arm: LatestMac, intel: LatestMac): { latest: LatestMac; text: string } {
  if (arm.version !== intel.version) throw new Error(`the two builds have different versions: arm64 ${arm.version}, x64 ${intel.version}`);
  const armZip = onlyZip(arm, 'arm64');
  const intelZip = onlyZip(intel, 'x64');
  if (!isArm64(armZip)) throw new Error(`the Apple silicon build's zip is not named …arm64…: ${armZip.url}`);
  if (isArm64(intelZip)) throw new Error(`the Intel build's zip is named …arm64…: ${intelZip.url}`);
  const releaseDate = [arm.releaseDate, intel.releaseDate].sort().at(-1) ?? '';
  const latest: LatestMac = { version: arm.version, files: [armZip, intelZip], releaseDate };
  return { latest, text: serializeLatestMac(latest, intelZip) };
}

function onlyZip(latest: LatestMac, label: string): LatestFile {
  if (latest.files.length !== 1) throw new Error(`the ${label} latest-mac.yml names ${latest.files.length} files, expected its one zip`);
  const file = latest.files[0]!;
  if (!file.url.endsWith('.zip') || file.url.includes('/')) throw new Error(`the ${label} latest-mac.yml names "${file.url}", expected a zip beside it`);
  return file;
}

export async function sha512Base64(file: string): Promise<{ sha512: string; size: number }> {
  const hash = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha512: hash.digest('base64'), size };
}

export interface Build {
  label: 'arm64' | 'x64';
  /** The release/ folder electron-builder wrote. */
  releaseDir: string;
  app: string;
  dmg: string;
}

export interface ReleaseChecks {
  /** The version inside the built app (CFBundleShortVersionString). */
  appVersion(app: string): Promise<string>;
  /** Signed, notarised, stapled — scripts/verify-mac-sign.sh; throws when not. */
  verifySigned(build: Build): Promise<void>;
}

export interface PreparedRelease {
  version: string;
  dir: string;
  files: { name: string; size: number }[];
}

/**
 * Checks both builds and fills `<arm64 release>/upload-<version>/` with the
 * seven files of the release. Nothing is written until every check passed;
 * an existing upload folder is never overwritten.
 */
export async function prepareRelease(version: string, arm: Build, intel: Build, checks: ReleaseChecks): Promise<PreparedRelease> {
  const builds = [arm, intel];
  const latest: LatestMac[] = [];
  for (const build of builds) {
    const appVersion = await checks.appVersion(build.app);
    if (appVersion !== version) throw new Error(`the ${build.label} app is version ${appVersion}, package.json says ${version} — build it again`);
    const yml = path.join(build.releaseDir, 'latest-mac.yml');
    const text = await fs.readFile(yml, 'utf8').catch(() => {
      throw new Error(`no ${yml} — build the ${build.label} app again (electron-builder writes it next to the zip)`);
    });
    const parsed = parseLatestMac(text);
    if (parsed.version !== version) throw new Error(`the ${build.label} latest-mac.yml is for ${parsed.version}, package.json says ${version}`);
    latest.push(parsed);
  }
  const { latest: joined, text } = joinLatestMac(latest[0]!, latest[1]!);

  const copies: { from: string; name: string }[] = [];
  for (const [i, build] of builds.entries()) {
    const zip = joined.files[i]!;
    const zipPath = path.join(build.releaseDir, zip.url);
    const actual = await sha512Base64(zipPath);
    if (actual.sha512 !== zip.sha512 || actual.size !== zip.size) throw new Error(`${zip.url} is not the file latest-mac.yml describes (changed after the build?)`);
    await fs.access(`${zipPath}.blockmap`);
    await fs.access(build.dmg);
    await checks.verifySigned(build);
    copies.push({ from: build.dmg, name: path.basename(build.dmg) }, { from: zipPath, name: zip.url }, { from: `${zipPath}.blockmap`, name: `${zip.url}.blockmap` });
  }
  const names = copies.map((c) => c.name);
  if (new Set(names).size !== names.length) throw new Error(`two release files share a name: ${names.join(', ')}`);

  const dir = path.join(arm.releaseDir, `upload-${version}`);
  await fs.mkdir(dir); // fails if it exists: never mixes two attempts
  for (const copy of copies) await fs.copyFile(copy.from, path.join(dir, copy.name), constants.COPYFILE_FICLONE);
  await fs.writeFile(path.join(dir, 'latest-mac.yml'), text, { flag: 'wx' });
  const files = await Promise.all([...names, 'latest-mac.yml'].map(async (name) => ({ name, size: (await fs.stat(path.join(dir, name))).size })));
  return { version, dir, files };
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { joinLatestMac, parseLatestMac, prepareRelease } from '../src/feed/latestMac';
import type { Build, ReleaseChecks } from '../src/feed/latestMac';
import * as os from 'node:os';

// ── One update feed from the Apple silicon and the Intel build ──

const tempDir = (prefix: string): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), prefix));

/** latest-mac.yml as electron-builder 26.15.3 wrote it for the unsigned build of 31. 10. */
const builderYml = (zip: string, sha512: string, size: number, version = '1.0.0', date = '2026-10-31T22:24:50.901Z'): string =>
  `version: ${version}\nfiles:\n  - url: ${zip}\n    sha512: ${sha512}\n    size: ${size}\npath: ${zip}\nsha512: ${sha512}\nreleaseDate: '${date}'\n`;

test('release: latest-mac.yml as electron-builder writes it is read back exactly; anything unexpected is refused', () => {
  const parsed = parseLatestMac(builderYml('ImageIQ-Resizer-mac-arm64.zip', 'abc+/==', 156101114));
  assert.deepEqual(parsed, {
    version: '1.0.0',
    files: [{ url: 'ImageIQ-Resizer-mac-arm64.zip', sha512: 'abc+/==', size: 156101114, extra: [] }],
    releaseDate: '2026-10-31T22:24:50.901Z',
  });
  const withExtra = parseLatestMac('version: 1.0.0\nfiles:\n  - url: a-arm64.zip\n    sha512: x\n    size: 5\n    blockMapSize: 9\npath: a-arm64.zip\nsha512: x\nreleaseDate: \'d\'\n');
  assert.deepEqual(withExtra.files[0]!.extra, [['blockMapSize', '9']]);
  assert.throws(() => parseLatestMac('version: 1.0.0\nfiles:\n  - url: a.zip\n    size: 5\n'), /without url, sha512 or size/);
  assert.throws(() => parseLatestMac('version: 1.0.0\nfiles:\n  - url: a.zip\n    sha512: x\n    size: -1\n'), /bad size/);
  assert.throws(() => parseLatestMac('files:\n  - url: a.zip\n    sha512: x\n    size: 1\n'), /no version/);
  assert.throws(() => parseLatestMac('version: 1.0.0\nstagingPercentage:\n  x: 1\n'), /unexpected/);
});

test('release: the two builds join into one feed — arm64 and Intel zips both listed, the legacy top-level path names the Intel zip', () => {
  const arm = parseLatestMac(builderYml('ImageIQ-Resizer-mac-arm64.zip', 'ARM==', 100, '1.0.0', '2026-11-03T10:00:00.000Z'));
  const intel = parseLatestMac(builderYml('ImageIQ-Resizer-mac-x64.zip', 'X64==', 200, '1.0.0', '2026-11-03T10:30:00.000Z'));
  const { latest, text } = joinLatestMac(arm, intel);
  assert.deepEqual(latest.files.map((f) => f.url), ['ImageIQ-Resizer-mac-arm64.zip', 'ImageIQ-Resizer-mac-x64.zip']);
  assert.equal(
    text,
    [
      'version: 1.0.0',
      'files:',
      '  - url: ImageIQ-Resizer-mac-arm64.zip',
      '    sha512: ARM==',
      '    size: 100',
      '  - url: ImageIQ-Resizer-mac-x64.zip',
      '    sha512: X64==',
      '    size: 200',
      'path: ImageIQ-Resizer-mac-x64.zip',
      'sha512: X64==',
      "releaseDate: '2026-11-03T10:30:00.000Z'",
      '',
    ].join('\n'),
  );
  assert.deepEqual(parseLatestMac(text).files, latest.files, 'the joined file reads back the same');

  assert.throws(() => joinLatestMac(arm, parseLatestMac(builderYml('ImageIQ-Resizer-mac-x64.zip', 'X', 1, '1.0.1'))), /different versions/);
  assert.throws(() => joinLatestMac(intel, intel), /not named …arm64…/);
  assert.throws(() => joinLatestMac(arm, arm), /Intel build's zip is named …arm64…/);
  const two = parseLatestMac('version: 1.0.0\nfiles:\n  - url: a-arm64.zip\n    sha512: a\n    size: 1\n  - url: b.dmg\n    sha512: b\n    size: 2\n');
  assert.throws(() => joinLatestMac(two, intel), /names 2 files/);
});

async function fakeBuild(root: string, label: 'arm64' | 'x64', version: string, content: string): Promise<Build> {
  const releaseDir = path.join(root, label, 'release');
  const app = path.join(releaseDir, label === 'arm64' ? 'mac-arm64' : 'mac', 'ImageIQ Resizer.app');
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(path.join(app, 'version'), version);
  const zip = `ImageIQ-Resizer-mac-${label}.zip`;
  const bytes = Buffer.from(content);
  await fs.writeFile(path.join(releaseDir, zip), bytes);
  await fs.writeFile(path.join(releaseDir, `${zip}.blockmap`), `blockmap of ${label}`);
  const dmg = path.join(releaseDir, `ImageIQ-Resizer-mac-${label}.dmg`);
  await fs.writeFile(dmg, `dmg of ${label}`);
  await fs.writeFile(path.join(releaseDir, 'latest-mac.yml'), builderYml(zip, createHash('sha512').update(bytes).digest('base64'), bytes.length, version));
  return { label, releaseDir, app, dmg };
}

function checks(unsigned: string[] = []): ReleaseChecks & { verified: string[] } {
  const verified: string[] = [];
  return {
    verified,
    appVersion: async (app) => fs.readFile(path.join(app, 'version'), 'utf8'),
    verifySigned: async (build) => {
      if (unsigned.includes(build.label)) throw new Error(`the ${build.label} build did not pass verify-mac-sign.sh`);
      verified.push(build.label);
    },
  };
}

test('release: prepareRelease checks both builds and puts the seven release files in upload-<version>; nothing is written when a check fails', async () => {
  const root = await tempDir('release');
  try {
    const arm = await fakeBuild(root, 'arm64', '1.0.0', 'arm zip');
    const intel = await fakeBuild(root, 'x64', '1.0.0', 'intel zip, longer');
    // an old blockmap of the dmg lies around (APPLE-PODPIS): never published
    await fs.writeFile(path.join(arm.releaseDir, 'ImageIQ-Resizer-mac-arm64.dmg.blockmap'), 'stale');
    const c = checks();
    const prepared = await prepareRelease('1.0.0', arm, intel, c);
    assert.deepEqual(c.verified, ['arm64', 'x64']);
    assert.equal(prepared.dir, path.join(arm.releaseDir, 'upload-1.0.0'));
    assert.deepEqual((await fs.readdir(prepared.dir)).sort(), [
      'ImageIQ-Resizer-mac-arm64.dmg',
      'ImageIQ-Resizer-mac-arm64.zip',
      'ImageIQ-Resizer-mac-arm64.zip.blockmap',
      'ImageIQ-Resizer-mac-x64.dmg',
      'ImageIQ-Resizer-mac-x64.zip',
      'ImageIQ-Resizer-mac-x64.zip.blockmap',
      'latest-mac.yml',
    ]);
    assert.equal(await fs.readFile(path.join(prepared.dir, 'ImageIQ-Resizer-mac-x64.zip'), 'utf8'), 'intel zip, longer');
    const feed = parseLatestMac(await fs.readFile(path.join(prepared.dir, 'latest-mac.yml'), 'utf8'));
    assert.deepEqual(feed.files.map((f) => [f.url, f.size]), [['ImageIQ-Resizer-mac-arm64.zip', 7], ['ImageIQ-Resizer-mac-x64.zip', 17]]);
    await assert.rejects(prepareRelease('1.0.0', arm, intel, checks()), /EEXIST/, 'an existing upload folder is never overwritten');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('release: refused — an app of another version, a zip changed after the build, an unsigned build, a build without latest-mac.yml; no upload folder is made', async () => {
  const root = await tempDir('release-refused');
  try {
    const arm = await fakeBuild(root, 'arm64', '1.0.1', 'arm zip');
    const intel = await fakeBuild(root, 'x64', '1.0.0', 'intel zip');
    await assert.rejects(prepareRelease('1.0.1', arm, intel, checks()), /the x64 app is version 1\.0\.0, package\.json says 1\.0\.1/);

    const intel2 = await fakeBuild(path.join(root, 'b'), 'x64', '1.0.1', 'intel zip');
    await fs.writeFile(path.join(intel2.releaseDir, 'ImageIQ-Resizer-mac-x64.zip'), 'intel zip, rebuilt');
    await assert.rejects(prepareRelease('1.0.1', arm, intel2, checks()), /ImageIQ-Resizer-mac-x64\.zip is not the file latest-mac\.yml describes/);

    const intel3 = await fakeBuild(path.join(root, 'c'), 'x64', '1.0.1', 'intel zip');
    await assert.rejects(prepareRelease('1.0.1', arm, intel3, checks(['x64'])), /x64 build did not pass verify-mac-sign/);

    const intel4 = await fakeBuild(path.join(root, 'd'), 'x64', '1.0.1', 'intel zip');
    await fs.rm(path.join(intel4.releaseDir, 'latest-mac.yml'));
    await assert.rejects(prepareRelease('1.0.1', arm, intel4, checks()), /no .*latest-mac\.yml — build the x64 app again/);

    await assert.rejects(fs.access(path.join(arm.releaseDir, 'upload-1.0.1')), /ENOENT/);
    // all checks pass → made
    assert.equal((await prepareRelease('1.0.1', arm, intel3, checks())).files.length, 7);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { prepareRelease } from './latestMac';
import type { Build } from './latestMac';

/**
 * npm run release:mac — after npm run dist:mac and npm run package:mac:x64
 * (both signed), from the main checkout: checks both builds (version, the
 * signature and notarisation through scripts/verify-mac-sign.sh, zips against
 * their latest-mac.yml), joins the two latest-mac.yml and puts the seven
 * release files in release/upload-<version>/. Uploads nothing: the owner
 * drags the folder's files into a GitHub release (README, "Releasing an
 * update"). macOS only.
 */

const run = promisify(execFile);
const REPO = path.resolve(__dirname, '..', '..', '..');

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('macOS only');
  const version = (JSON.parse(await fs.readFile(path.join(REPO, 'package.json'), 'utf8')) as { version: string }).version;
  // the Intel build's worktree: where scripts/package-mac-x64.sh puts it
  const x64Root = path.join(path.dirname(await fs.realpath(REPO)), 'wt-resizer-x64');
  const arm: Build = {
    label: 'arm64',
    releaseDir: path.join(REPO, 'release'),
    app: path.join(REPO, 'release', 'mac-arm64', 'ImageIQ Resizer.app'),
    dmg: path.join(REPO, 'release', 'ImageIQ-Resizer-mac-arm64.dmg'),
  };
  const intel: Build = {
    label: 'x64',
    releaseDir: path.join(x64Root, 'release'),
    app: path.join(x64Root, 'release', 'mac', 'ImageIQ Resizer.app'),
    dmg: path.join(x64Root, 'release', 'ImageIQ-Resizer-mac-x64.dmg'),
  };
  console.log(`release:mac — version ${version}`);
  const prepared = await prepareRelease(version, arm, intel, {
    appVersion: async (app) => (await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')])).stdout.trim(),
    verifySigned: async (build) => {
      const arch = build.label === 'arm64' ? 'arm64' : 'x86_64';
      try {
        await run('bash', [path.join(REPO, 'scripts', 'verify-mac-sign.sh'), build.app, build.dmg, arch], { maxBuffer: 16 * 1024 * 1024 });
        console.log(`  ${build.label}: signed, notarised and stapled (verify-mac-sign PASS)`);
      } catch {
        throw new Error(`the ${build.label} build did not pass verify-mac-sign.sh — run: bash scripts/verify-mac-sign.sh "${build.app}" "${build.dmg}" ${arch}`);
      }
    },
  });
  console.log(`\nready to publish: ${prepared.dir}`);
  for (const file of prepared.files) console.log(`  ${file.name}  ${(file.size / 1_000_000).toFixed(1)} MB`);
  console.log(`\nnext: GitHub → stockimageiq1/stockimageiq-resizer-releases → Releases → Draft a new release`);
  console.log(`      tag v${version}, title "ImageIQ Resizer ${version}", drag all ${prepared.files.length} files above, Save draft, check, Publish release.`);
}

main().catch((err: unknown) => {
  console.error(`release:mac: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(__dirname, '..', '..');
const builderYml = (): Promise<string> => fs.readFile(path.join(ROOT, 'electron-builder.yml'), 'utf8');

test('packaging: the fuses that keep outside code out of the signed app stay off', async () => {
  const yml = await builderYml();
  for (const fuse of ['runAsNode', 'enableNodeOptionsEnvironmentVariable', 'enableNodeCliInspectArguments']) {
    assert.match(yml, new RegExp(`^  ${fuse}: false$`, 'm'), fuse);
  }
});

test('packaging: unsigned builds re-sign ad hoc after the fuse flip, or Apple silicon kills them at launch', async () => {
  const flag = '-c.electronFuses.resetAdHocDarwinSignature=true';
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts['dist:mac:unsigned']?.includes(flag));
  assert.ok((await fs.readFile(path.join(ROOT, 'scripts', 'package-mac-x64.sh'), 'utf8')).includes(flag));
});

test('packaging: macOS explains folder access in the words the owner approved', async () => {
  const yml = await builderYml();
  const text =
    'ImageIQ Resizer reads the photos and videos in the folder you choose and saves resized copies in a new folder next to it, or where you choose. Your originals are not changed.';
  assert.ok(yml.includes(`NSDesktopFolderUsageDescription: &folderAccess ${text}\n`));
  for (const key of ['Documents', 'Downloads']) assert.ok(yml.includes(`NS${key}FolderUsageDescription: *folderAccess`), key);
  for (const key of ['RemovableVolumes', 'NetworkVolumes']) assert.ok(yml.includes(`NS${key}UsageDescription: *folderAccess`), key);
});

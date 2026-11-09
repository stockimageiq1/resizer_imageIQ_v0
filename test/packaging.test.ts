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

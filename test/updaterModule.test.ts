import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { updaterExports } from '../src/main/updaterModule';

test('electron-updater: autoUpdater is reachable the way the app takes it', async () => {
  // `in` does not run the getter, which needs Electron
  assert.ok('autoUpdater' in (await updaterExports()));
});

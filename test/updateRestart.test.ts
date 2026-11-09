import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { restartWhenIdle } from '../src/main/updateRestart';

test('update restart: immediately when nothing runs', () => {
  let restarts = 0;
  restartWhenIdle(() => false, () => (restarts += 1), () => assert.fail('must not wait'));
  assert.equal(restarts, 1);
});

test('update restart: waits for a running resize, then restarts once', () => {
  let busy = true;
  let restarts = 0;
  let pending: (() => void) | null = null;
  const after = (_ms: number, run: () => void): void => {
    pending = run;
  };
  restartWhenIdle(() => busy, () => (restarts += 1), after);
  assert.equal(restarts, 0);
  (pending as unknown as () => void)();
  assert.equal(restarts, 0, 'still running: no restart');
  busy = false;
  (pending as unknown as () => void)();
  assert.equal(restarts, 1);
});

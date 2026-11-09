const RETRY_MS = 5_000;

/**
 * Restarts for a downloaded update, but never in the middle of a resize: the
 * restart closes the window, which cancels the run and deletes its output.
 * The offer comes at launch, so a run can start while the update downloads.
 * Plain code, so it runs in the Node tests (no Electron).
 */
export function restartWhenIdle(
  isBusy: () => boolean,
  restart: () => void,
  after: (ms: number, run: () => void) => void = (ms, run) => void setTimeout(run, ms),
): void {
  if (isBusy()) {
    after(RETRY_MS, () => restartWhenIdle(isBusy, restart, after));
    return;
  }
  restart();
}

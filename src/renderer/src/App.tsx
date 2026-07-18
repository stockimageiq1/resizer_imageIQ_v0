import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ShrinkErrorCode, ShrinkSummary } from '../../engine/types';
import { DEFAULT_SETTINGS, type Capabilities, type ScanPreview, type Settings } from '../../shared/ipc';
import { STR } from '../../shared/strings';
import { formatBytes, formatDuration } from './format';
import { etaMs, initialRunState, overallFraction, reduceRunState, RunState } from './runState';
import { SettingsModal } from './SettingsModal';

type Screen =
  | { kind: 'idle' }
  | { kind: 'preview'; preview: ScanPreview }
  | { kind: 'running'; preview: ScanPreview }
  | { kind: 'done'; summary: ShrinkSummary }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string; code: ShrinkErrorCode | 'UNKNOWN' };

export function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>({ kind: 'idle' });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runState, dispatchRun] = useReducer(reduceRunState, initialRunState(Date.now()));
  const runStartRef = useRef(0);

  useEffect(() => {
    void window.iqShrink.getSettings().then(setSettings);
    void window.iqShrink.getCapabilities().then(setCapabilities);
  }, []);

  // a missed drop must never navigate the window
  useEffect(() => {
    const prevent = (event: DragEvent): void => event.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  useEffect(() => {
    const offProgress = window.iqShrink.onProgress((message) => dispatchRun(message));
    const offDone = window.iqShrink.onDone((message) => {
      if (message.status === 'done') setScreen({ kind: 'done', summary: message.summary });
      else if (message.status === 'cancelled') setScreen({ kind: 'cancelled' });
      else setScreen({ kind: 'error', message: message.message, code: message.code });
    });
    return () => {
      offProgress();
      offDone();
    };
  }, []);

  const pickFolder = useCallback(
    async (folderPath: string) => {
      setDropError(null);
      setStartError(null);
      setBusy(true);
      try {
        if (!(await window.iqShrink.isDirectory(folderPath))) {
          setDropError(STR.drop.singleFolderHint);
          return;
        }
        const preview = await window.iqShrink.scanPreview(folderPath, settings.outputParentDir);
        setScreen({ kind: 'preview', preview });
      } catch (err) {
        setDropError(STR.drop.readError(err instanceof Error ? err.message : String(err)));
      } finally {
        setBusy(false);
      }
    },
    [settings.outputParentDir],
  );

  const refreshResolvedOut = useCallback((preview: ScanPreview, outputParentDir: string | null) => {
    void (async () => {
      const resolvedOutDir = await window.iqShrink.resolveOutDir(preview.inputDir, outputParentDir);
      setScreen({ kind: 'preview', preview: { ...preview, resolvedOutDir } });
    })();
  }, []);

  const updateSettings = useCallback(
    (patch: Partial<Settings>, previewToRefresh?: ScanPreview) => {
      void (async () => {
        const next = await window.iqShrink.setSettings(patch);
        setSettings(next);
        if (previewToRefresh !== undefined) refreshResolvedOut(previewToRefresh, next.outputParentDir);
      })();
    },
    [refreshResolvedOut],
  );

  const startRun = useCallback((preview: ScanPreview) => {
    void (async () => {
      setBusy(true);
      setStartError(null);
      try {
        const result = await window.iqShrink.startRun({ inputDir: preview.inputDir });
        if (result.started) {
          runStartRef.current = Date.now();
          dispatchRun({ reset: runStartRef.current });
          setScreen({ kind: 'running', preview });
        } else if (result.reason !== 'user-cancelled') {
          setStartError(result.message ?? STR.dialogs.startFailed);
        }
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">{STR.appName}</span>
        <span className="tagline">{STR.tagline}</span>
        <span className="spacer" />
        <button
          className="icon-button"
          title={STR.settings.open}
          aria-label={STR.settings.open}
          onClick={() => setSettingsOpen(true)}
        >
          ⚙
        </button>
      </header>

      {capabilities !== null && !capabilities.heicSupported && <div className="banner warn">{STR.banners.noHeic}</div>}
      {capabilities !== null && !capabilities.ffmpegAvailable && (
        <div className="banner warn">{STR.banners.noFfmpeg}</div>
      )}

      {screen.kind === 'idle' && (
        <DropScreen busy={busy} error={dropError} onError={setDropError} onPicked={(p) => void pickFolder(p)} />
      )}

      {screen.kind === 'preview' && (
        <PreviewScreen
          preview={screen.preview}
          settings={settings}
          busy={busy}
          startError={startError}
          onBack={() => {
            setDropError(null);
            setStartError(null);
            setScreen({ kind: 'idle' });
          }}
          onSettingsChange={(patch) => updateSettings(patch, screen.preview)}
          onStart={() => startRun(screen.preview)}
        />
      )}

      {screen.kind === 'running' && (
        <RunningScreen
          preview={screen.preview}
          state={runState}
          startedAt={runStartRef.current}
          onCancel={() => void window.iqShrink.cancelRun()}
        />
      )}

      {screen.kind === 'done' && (
        <DoneScreen summary={screen.summary} onRestart={() => setScreen({ kind: 'idle' })} />
      )}

      {screen.kind === 'cancelled' && (
        <main className="card centered">
          <h1>{STR.cancelled.title}</h1>
          <p>{STR.cancelled.body}</p>
          <button className="primary" onClick={() => setScreen({ kind: 'idle' })}>
            {STR.cancelled.back}
          </button>
        </main>
      )}

      {screen.kind === 'error' && <ErrorScreen code={screen.code} raw={screen.message} onRestart={() => setScreen({ kind: 'idle' })} />}

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next) => {
            setSettings(next);
            setSettingsOpen(false);
            if (screen.kind === 'preview') refreshResolvedOut(screen.preview, next.outputParentDir);
          }}
        />
      )}
    </div>
  );
}

function DropScreen(props: {
  busy: boolean;
  error: string | null;
  onError: (message: string) => void;
  onPicked: (path: string) => void;
}): React.JSX.Element {
  const [hover, setHover] = useState(false);

  const handleDrop = (event: React.DragEvent): void => {
    event.preventDefault();
    setHover(false);
    const { files, items } = event.dataTransfer;
    if (files.length !== 1 || items.length !== 1) {
      props.onError(STR.drop.singleFolderHint);
      return;
    }
    const entry = items[0]?.webkitGetAsEntry();
    const file = files[0];
    if (entry === null || entry === undefined || !entry.isDirectory || file === undefined) {
      props.onError(STR.drop.singleFolderHint);
      return;
    }
    props.onPicked(window.iqShrink.getPathForFile(file));
  };

  return (
    <main
      className={`dropzone ${hover ? 'hover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={handleDrop}
    >
      <div className="drop-icon" aria-hidden="true">
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          <path d="M12 10v6M9 13l3-3 3 3" />
        </svg>
      </div>
      <h1>{STR.drop.title}</h1>
      <p className="muted">{STR.drop.subtitle}</p>
      <button
        className="secondary"
        disabled={props.busy}
        onClick={() => {
          void (async () => {
            const picked = await window.iqShrink.selectFolder();
            if (picked !== null) props.onPicked(picked);
          })();
        }}
      >
        {STR.drop.chooseFolder}
      </button>
      {props.busy && <p className="muted">{STR.drop.scanning}</p>}
      {props.error !== null && <p className="inline-error">{props.error}</p>}
    </main>
  );
}

function PreviewScreen(props: {
  preview: ScanPreview;
  settings: Settings;
  busy: boolean;
  startError: string | null;
  onBack: () => void;
  onStart: () => void;
  onSettingsChange: (patch: Partial<Settings>) => void;
}): React.JSX.Element {
  const { preview, settings } = props;
  return (
    <main className="card">
      <button className="linklike" onClick={props.onBack}>
        {STR.preview.back}
      </button>
      <h1 className="folder-name">{preview.folderName}</h1>
      <div className="stat-grid">
        <Stat label={STR.preview.images} value={String(preview.imageCount)} />
        <Stat label={STR.preview.videos} value={String(preview.videoCount)} />
        <Stat label={STR.preview.otherFiles} value={String(preview.otherCount)} />
        <Stat label={STR.preview.totalSize} value={formatBytes(preview.totalBytes)} />
        <Stat
          label={STR.preview.estimatedOutput}
          value={`${STR.preview.estimatedPrefix}${formatBytes(preview.estimatedOutputBytes)}`}
        />
        <Stat label={STR.preview.files} value={String(preview.totalFiles)} />
      </div>
      {preview.unreadableCount > 0 && <p className="muted">{STR.preview.unreadableNote(preview.unreadableCount)}</p>}

      <div className="options">
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.createZip}
            onChange={(e) => props.onSettingsChange({ createZip: e.target.checked })}
          />
          {STR.preview.createZip}
        </label>

        <div className="out-location">
          <span className="muted">{STR.preview.outputLabel}</span>
          <code className="path">{preview.resolvedOutDir}</code>
          <span className="out-buttons">
            <button
              className="linklike"
              onClick={() => {
                void (async () => {
                  const picked = await window.iqShrink.selectFolder();
                  if (picked !== null) props.onSettingsChange({ outputParentDir: picked });
                })();
              }}
            >
              {STR.preview.changeLocation}
            </button>
            {settings.outputParentDir !== null && (
              <button className="linklike" onClick={() => props.onSettingsChange({ outputParentDir: null })}>
                {STR.preview.resetLocation}
              </button>
            )}
          </span>
        </div>
      </div>

      <button className="primary" disabled={props.busy || preview.totalFiles === 0} onClick={props.onStart}>
        {STR.preview.start}
      </button>
      {preview.totalFiles === 0 && <p className="muted">{STR.preview.emptyFolder}</p>}
      {props.startError !== null && <p className="inline-error">{props.startError}</p>}
    </main>
  );
}

function RunningScreen(props: {
  preview: ScanPreview;
  state: RunState;
  startedAt: number;
  onCancel: () => void;
}): React.JSX.Element {
  const { state, preview } = props;
  const [now, setNow] = useState(() => Date.now());
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const fraction = overallFraction(state);
  const eta = etaMs({ ...state, startedAt: props.startedAt }, now);
  const elapsed = now - props.startedAt;

  return (
    <main className="card">
      <h1 className="folder-name">{preview.folderName}</h1>

      <div className="progress-track" role="progressbar" aria-valuenow={Math.round(fraction * 100)}>
        <div className="progress-fill" style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
      </div>
      <div className="progress-row">
        <span>{STR.running.filesLine(state.filesDone, state.totalFiles, Math.round(fraction * 100))}</span>
        <span className="muted">
          {STR.running.elapsedLine(formatDuration(elapsed), eta !== null ? formatDuration(eta) : null)}
        </span>
      </div>

      <div className="activity">
        <div className="activity-line">
          {STR.running.imagesLine(state.imagesDone, preview.imageCount)}
          {state.othersDone > 0 ? ` · ${STR.running.othersLine(state.othersDone, preview.otherCount)}` : ''}
          {state.copied > 0 ? ` · ${STR.running.copiedLine(state.copied)}` : ''}
        </div>
        {state.activeVideo !== null && (
          <div className="activity-line video">
            <span className="video-name">{state.activeVideo.relPath.split('/').pop()}</span>
            <span> — {Math.round(state.activeVideo.percent)}%</span>
            <div className="progress-track small">
              <div className="progress-fill" style={{ width: `${state.activeVideo.percent.toFixed(1)}%` }} />
            </div>
          </div>
        )}
        {state.activeVideo === null && state.videosDone < preview.videoCount && preview.videoCount > 0 && (
          <div className="activity-line muted">{STR.running.videosLine(state.videosDone, preview.videoCount)}</div>
        )}
        {state.zipping && <div className="activity-line">{STR.running.zipping}</div>}
        {cancelRequested && <div className="activity-line">{STR.running.cancelling}</div>}
      </div>

      {!confirmingCancel && !cancelRequested && (
        <button className="secondary danger" onClick={() => setConfirmingCancel(true)}>
          {STR.running.cancel}
        </button>
      )}
      {confirmingCancel && !cancelRequested && (
        <div className="confirm-row">
          <span>{STR.running.cancelConfirm}</span>
          <button
            className="secondary danger"
            onClick={() => {
              setCancelRequested(true);
              setConfirmingCancel(false);
              props.onCancel();
            }}
          >
            {STR.running.cancelYes}
          </button>
          <button className="secondary" onClick={() => setConfirmingCancel(false)}>
            {STR.running.cancelNo}
          </button>
        </div>
      )}
    </main>
  );
}

function DoneScreen(props: { summary: ShrinkSummary; onRestart: () => void }): React.JSX.Element {
  const { summary } = props;
  // spec: reveal the zip when one was created, else the output folder
  const revealTarget = summary.zipPath ?? summary.outputPath;
  return (
    <main className="card centered">
      <h1 className="headline">
        {STR.done.headline(
          formatBytes(summary.inputBytes),
          formatBytes(summary.outputBytes),
          summary.percentSaved.toFixed(1),
        )}
      </h1>
      <p className="muted">
        {STR.done.elapsed(formatDuration(summary.elapsedMs))} ·{' '}
        {STR.done.counts(summary.imagesProcessed, summary.videosProcessed)}
      </p>

      {summary.copiedUnprocessed.length > 0 && (
        <div className="copied-warning">
          <div className="copied-warning-title">{STR.done.copiedWarningTitle}</div>
          <ul className="copied-list">
            {summary.copiedUnprocessed.map((c) => (
              <li key={c.relPath}>
                <code>{c.relPath}</code> — {c.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="button-row">
        <button className="primary" onClick={() => void window.iqShrink.showItemInFolder(revealTarget)}>
          {STR.done.showInFolder}
        </button>
        <button className="secondary" onClick={props.onRestart}>
          {STR.done.startAnother}
        </button>
      </div>
    </main>
  );
}

function ErrorScreen(props: {
  code: ShrinkErrorCode | 'UNKNOWN';
  raw: string;
  onRestart: () => void;
}): React.JSX.Element {
  const mapped = STR.errors.map[props.code];
  return (
    <main className="card centered">
      <h1 className="error-title">{STR.errors.title}</h1>
      <p>{mapped.message}</p>
      <p className="muted">{mapped.action}</p>
      <p className="technical">{STR.errors.technicalDetail(props.raw)}</p>
      <button className="primary" onClick={props.onRestart}>
        {STR.errors.back}
      </button>
    </main>
  );
}

function Stat(props: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="stat">
      <div className="stat-value">{props.value}</div>
      <div className="stat-label">{props.label}</div>
    </div>
  );
}

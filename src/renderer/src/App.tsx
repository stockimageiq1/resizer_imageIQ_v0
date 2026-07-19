import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ShrinkErrorCode, ShrinkSummary } from '../../engine/types';
import { DEFAULT_SETTINGS, type Capabilities, type ScanPreview, type Settings } from '../../shared/ipc';
import { STR } from '../../shared/strings';
import logoWhite from '../../../assets/logo-white.svg';
import markIqWhite from '../../../assets/mark-iq-white.svg';
import { formatBytes, formatDuration } from './format';
import { SettingsPage } from './SettingsPage';
import { etaMs, initialRunState, overallFraction, reduceRunState, RunState } from './runState';

type Page = 'new-run' | 'settings';

type Screen =
  | { kind: 'idle' }
  | { kind: 'preview'; preview: ScanPreview }
  | { kind: 'running'; preview: ScanPreview }
  | { kind: 'done'; summary: ShrinkSummary }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string; code: ShrinkErrorCode | 'UNKNOWN' };

interface StartChoice {
  outputParentDir: string | null;
  createZip: boolean;
  remember: boolean;
}

export function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('new-run');
  const [screen, setScreen] = useState<Screen>({ kind: 'idle' });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
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

  const startRun = useCallback((preview: ScanPreview, choice: StartChoice) => {
    void (async () => {
      setBusy(true);
      setStartError(null);
      try {
        if (choice.remember) {
          const next = await window.iqShrink.setSettings({
            outputParentDir: choice.outputParentDir,
            createZip: choice.createZip,
          });
          setSettings(next);
        }
        const result = await window.iqShrink.startRun({
          inputDir: preview.inputDir,
          outputParentDir: choice.outputParentDir,
          createZip: choice.createZip,
        });
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
      {/* FP-style top bar — visible in dark theme only (CSS-scoped) */}
      <header className="topbar">
        <span className="brand-main">{STR.brandName}</span>
        <span className="brand-sub">{STR.nav.subtitle}</span>
      </header>

      <div className="app-body">
        <Sidebar page={page} onNavigate={setPage} version={capabilities?.appVersion ?? null} />

        <div className="content">
        {capabilities !== null && !capabilities.heicSupported && (
          <div className="banner warn">{STR.banners.noHeic}</div>
        )}
        {capabilities !== null && !capabilities.ffmpegAvailable && (
          <div className="banner warn">{STR.banners.noFfmpeg}</div>
        )}

        <div className="safe-column">
          {page === 'new-run' && (
            <>
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
                  onStart={(choice) => startRun(screen.preview, choice)}
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
                  <h1 className="status-row">
                    <span className="status-dot grey" />
                    {STR.cancelled.title}
                  </h1>
                  <p className="muted">{STR.cancelled.body}</p>
                  <button className="btn btn-outline" onClick={() => setScreen({ kind: 'idle' })}>
                    {STR.cancelled.back}
                  </button>
                </main>
              )}
              {screen.kind === 'error' && (
                <ErrorScreen code={screen.code} raw={screen.message} onRestart={() => setScreen({ kind: 'idle' })} />
              )}
            </>
          )}

          {page === 'settings' && <SettingsPage settings={settings} onSaved={setSettings} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function NavIcon(props: { kind: Page }): React.JSX.Element {
  const paths: Record<Page, React.JSX.Element> = {
    'new-run': <path d="M12 5v14M5 12h14" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M19.1 4.9l-2.2 2.2M7.1 16.9l-2.2 2.2" />
      </>
    ),
  };
  return (
    <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[props.kind]}
    </svg>
  );
}

function Sidebar(props: { page: Page; onNavigate: (page: Page) => void; version: string | null }): React.JSX.Element {
  const items: { key: Page; label: string }[] = [
    { key: 'new-run', label: STR.nav.newRun },
    { key: 'settings', label: STR.nav.settings },
  ];
  return (
    <nav className="sidebar">
      <div className="brand-block">
        <div className="brand-lockup">
          <img className="brand-logo" src={logoWhite} alt={STR.brandName} />
          <div className="brand-subtitle">{STR.nav.subtitle}</div>
        </div>
        <img className="brand-mark" src={markIqWhite} alt={STR.brandName} />
      </div>
      <div className="nav-items">
        {items.map((item) => (
          <button
            key={item.key}
            className={`nav-item ${props.page === item.key ? 'active' : ''}`}
            onClick={() => props.onNavigate(item.key)}
          >
            <NavIcon kind={item.key} />
            <span className="nav-label">{item.label}</span>
          </button>
        ))}
      </div>
      <div className="sidebar-footer">{props.version !== null ? STR.nav.version(props.version) : ''}</div>
    </nav>
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
      className={`card dropzone ${hover ? 'hover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={handleDrop}
    >
      <div className="drop-icon" aria-hidden="true">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          <path d="M12 16v-6M9 13l3 3 3-3" />
        </svg>
      </div>
      <h1 className="drop-title">{STR.drop.title}</h1>
      <p className="muted">{STR.drop.subtitle}</p>
      <button
        className="btn btn-navy"
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
  onStart: (choice: StartChoice) => void;
}): React.JSX.Element {
  const { preview } = props;
  const [parentDir, setParentDir] = useState<string | null>(props.settings.outputParentDir);
  const [resolvedOut, setResolvedOut] = useState(preview.resolvedOutDir);
  const [createZip, setCreateZip] = useState(props.settings.createZip);
  const [remember, setRemember] = useState(false);

  const selectDefault = (): void => {
    void (async () => {
      setParentDir(null);
      setResolvedOut(await window.iqShrink.resolveOutDir(preview.inputDir, null));
    })();
  };

  const selectCustom = (): void => {
    void (async () => {
      const picked = await window.iqShrink.selectFolder();
      if (picked !== null) {
        setParentDir(picked);
        setResolvedOut(await window.iqShrink.resolveOutDir(preview.inputDir, picked));
      }
    })();
  };

  return (
    <main className="card">
      <button className="linklike" onClick={props.onBack}>
        {STR.preview.back}
      </button>

      <div className="preview-header">
        <h1 className="mono folder-name">{preview.folderName}</h1>
        <div className="chip-row">
          <span className="status-row">
            <span className="status-dot navy" />
            <span className="mono count-text">{STR.preview.photosChip(preview.imageCount)}</span>
          </span>
          <span className="status-row">
            <span className="status-dot navy" />
            <span className="mono count-text">{STR.preview.videosChip(preview.videoCount)}</span>
          </span>
          {preview.otherCount > 0 && (
            <span className="status-row">
              <span className="status-dot grey" />
              <span className="mono count-text">{STR.preview.otherChip(preview.otherCount)}</span>
            </span>
          )}
          <span className="mono total-size">{formatBytes(preview.totalBytes)}</span>
        </div>
      </div>
      <p className="muted mono">{STR.preview.estimatedOutput(formatBytes(preview.estimatedOutputBytes))}</p>
      {preview.unreadableCount > 0 && <p className="muted">{STR.preview.unreadableNote(preview.unreadableCount)}</p>}

      <section className="save-to">
        <h2 className="section-label">{STR.preview.saveTo}</h2>
        <label className="radio-row">
          <input type="radio" name="save-to" checked={parentDir === null} onChange={selectDefault} />
          <span className="radio-body">
            <span>{STR.preview.saveToNextToSource}</span>
            {parentDir === null && <code className="mono path">{resolvedOut}</code>}
          </span>
        </label>
        <label className="radio-row">
          <input type="radio" name="save-to" checked={parentDir !== null} onChange={selectCustom} />
          <span className="radio-body">
            <span>
              {STR.preview.saveToChoose}
              {parentDir !== null && (
                <button className="linklike change-link" onClick={selectCustom}>
                  {STR.preview.saveToChange}
                </button>
              )}
            </span>
            {parentDir !== null && <code className="mono path">{resolvedOut}</code>}
          </span>
        </label>
        <label className="toggle small">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {STR.preview.rememberChoice}
        </label>
      </section>

      <label className="toggle">
        <input type="checkbox" checked={createZip} onChange={(e) => setCreateZip(e.target.checked)} />
        {STR.preview.createZip}
      </label>

      <button
        className="btn btn-yellow cta"
        disabled={props.busy || preview.totalFiles === 0}
        onClick={() => props.onStart({ outputParentDir: parentDir, createZip, remember })}
      >
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
      <h1 className="mono folder-name">{preview.folderName}</h1>

      <div className="track" role="progressbar" aria-valuenow={Math.round(fraction * 100)}>
        <div className="fill fill-yellow" style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
      </div>
      <div className="progress-row mono">
        <span>{STR.running.filesLine(state.filesDone, state.totalFiles, Math.round(fraction * 100))}</span>
        <span className="muted">
          {STR.running.elapsedLine(formatDuration(elapsed), eta !== null ? formatDuration(eta) : null)}
        </span>
      </div>

      <div className="activity">
        <div className="activity-line mono">
          {STR.running.imagesLine(state.imagesDone, preview.imageCount)}
          {state.othersDone > 0 ? ` · ${STR.running.othersLine(state.othersDone, preview.otherCount)}` : ''}
          {state.copied > 0 ? ` · ${STR.running.copiedLine(state.copied)}` : ''}
        </div>
        {state.activeVideo !== null && (
          <div className="activity-line mono">
            <span>{state.activeVideo.relPath.split('/').pop()}</span>
            <span> — {Math.round(state.activeVideo.percent)}%</span>
            <div className="track small">
              <div className="fill fill-mint" style={{ width: `${state.activeVideo.percent.toFixed(1)}%` }} />
            </div>
          </div>
        )}
        {state.activeVideo === null && state.videosDone < preview.videoCount && preview.videoCount > 0 && (
          <div className="activity-line mono muted">{STR.running.videosLine(state.videosDone, preview.videoCount)}</div>
        )}
        {state.zipping && <div className="activity-line">{STR.running.zipping}</div>}
        {cancelRequested && <div className="activity-line">{STR.running.cancelling}</div>}
      </div>

      {!confirmingCancel && !cancelRequested && (
        <button className="btn btn-grey" onClick={() => setConfirmingCancel(true)}>
          {STR.running.cancel}
        </button>
      )}
      {confirmingCancel && !cancelRequested && (
        <div className="confirm-row">
          <span className="confirm-warning">{STR.running.cancelConfirm}</span>
          <button
            className="btn btn-grey confirm-danger"
            onClick={() => {
              setCancelRequested(true);
              setConfirmingCancel(false);
              props.onCancel();
            }}
          >
            {STR.running.cancelYes}
          </button>
          <button className="btn btn-grey" onClick={() => setConfirmingCancel(false)}>
            {STR.running.cancelNo}
          </button>
        </div>
      )}
    </main>
  );
}

function DoneScreen(props: { summary: ShrinkSummary; onRestart: () => void }): React.JSX.Element {
  const { summary } = props;
  const revealTarget = summary.zipPath ?? summary.outputPath;
  return (
    <main className="card done-card">
      <div className="done-band">
        <h1 className="done-headline mono">
          {STR.done.headline(
            formatBytes(summary.inputBytes),
            formatBytes(summary.outputBytes),
            summary.percentSaved.toFixed(1),
          )}
        </h1>
        <p className="done-sub">
          {STR.done.elapsed(formatDuration(summary.elapsedMs))} ·{' '}
          {STR.done.counts(summary.imagesProcessed, summary.videosProcessed)}
        </p>
      </div>

      {summary.copiedUnprocessed.length > 0 && (
        <div className="copied-warning">
          <div className="copied-warning-title">{STR.done.copiedWarningTitle}</div>
          <ul className="copied-list mono">
            {summary.copiedUnprocessed.map((c) => (
              <li key={c.relPath}>
                <code>{c.relPath}</code> — {c.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="button-row">
        <button className="btn btn-yellow" onClick={() => void window.iqShrink.showItemInFolder(revealTarget)}>
          {STR.done.showInFolder}
        </button>
        <button className="btn btn-outline" onClick={props.onRestart}>
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
      <h1 className="error-title status-row">
        <span className="status-dot red" />
        {STR.errors.title}
      </h1>
      <p>{mapped.message}</p>
      <p className="muted">{mapped.action}</p>
      <p className="technical mono">{STR.errors.technicalDetail(props.raw)}</p>
      <button className="btn btn-outline" onClick={props.onRestart}>
        {STR.errors.back}
      </button>
    </main>
  );
}

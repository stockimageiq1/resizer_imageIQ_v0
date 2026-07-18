import { useEffect, useState } from 'react';
import type { HistoryEntry } from '../../shared/ipc';
import { STR } from '../../shared/strings';
import { formatBytes } from './format';

function outcomeChip(outcome: HistoryEntry['outcome']): React.JSX.Element {
  if (outcome === 'done') return <span className="chip chip-mint">{STR.history.outcomeDone}</span>;
  if (outcome === 'cancelled') return <span className="chip chip-neutral">{STR.history.outcomeCancelled}</span>;
  return <span className="chip chip-red">{STR.history.outcomeError}</span>;
}

export function HistoryPage(): React.JSX.Element {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    void window.iqShrink.listHistory().then(setEntries);
  }, []);

  return (
    <main className="card">
      <h1>{STR.history.title}</h1>

      {entries !== null && entries.length === 0 && <p className="muted">{STR.history.empty}</p>}

      {entries !== null && entries.length > 0 && (
        <ul className="history-list">
          {entries.map((entry) => (
            <li key={`${entry.timestamp}-${entry.outputPath}`} className={`history-row ${entry.outputExists ? '' : 'gone'}`}>
              <span className="history-date muted">
                {new Date(entry.timestamp).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}{' '}
                {new Date(entry.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="mono history-name">{entry.folderName}</span>
              {outcomeChip(entry.outcome)}
              <span className="mono history-size">
                {entry.inputBytes !== undefined && entry.outputBytes !== undefined
                  ? `${formatBytes(entry.inputBytes)} → ${formatBytes(entry.outputBytes)}`
                  : '—'}
              </span>
              {entry.copiedUnprocessed > 0 && (
                <span className="mono history-copied">{STR.history.copiedCount(entry.copiedUnprocessed)}</span>
              )}
              {entry.outputExists ? (
                <button
                  className="linklike"
                  onClick={() => void window.iqShrink.showItemInFolder(entry.zipPath ?? entry.outputPath)}
                >
                  {STR.history.showInFolder}
                </button>
              ) : (
                <span className="muted">{STR.history.movedOrDeleted}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

import { useState } from 'react';
import { DEFAULT_SETTINGS, SETTING_RANGES, Settings } from '../../shared/ipc';
import { STR } from '../../shared/strings';

function NumberField(props: {
  label: string;
  hint: string;
  value: number;
  range: { min: number; max: number };
  onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <input
        type="number"
        className="mono"
        value={props.value}
        min={props.range.min}
        max={props.range.max}
        onChange={(e) => {
          const parsed = Number(e.target.value);
          if (Number.isFinite(parsed)) props.onChange(parsed);
        }}
        onBlur={(e) => {
          const parsed = Number(e.target.value);
          if (Number.isFinite(parsed)) {
            props.onChange(Math.min(props.range.max, Math.max(props.range.min, Math.round(parsed))));
          }
        }}
      />
      <span className="field-hint">{props.hint}</span>
    </label>
  );
}

export function SettingsPage(props: {
  settings: Settings;
  onSaved: (next: Settings) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Settings>(props.settings);
  const [savedNote, setSavedNote] = useState(false);

  const save = (): void => {
    void (async () => {
      const next = await window.iqShrink.setSettings(draft);
      setDraft(next);
      props.onSaved(next);
      setSavedNote(true);
      setTimeout(() => setSavedNote(false), 2000);
    })();
  };

  return (
    <main className="card">
      <h1>{STR.settings.title}</h1>
      <p className="muted">{STR.settings.defaultsNote}</p>

      <h2 className="section-label">{STR.settings.sectionAppearance}</h2>
      <div className="chip-row">
        {(
          [
            ['dark', STR.settings.appearanceDark],
            ['light', STR.settings.appearanceLight],
            ['system', STR.settings.appearanceSystem],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="toggle">
            <input
              type="radio"
              name="appearance"
              checked={draft.appearance === value}
              onChange={() => setDraft({ ...draft, appearance: value })}
            />
            {label}
          </label>
        ))}
        <span className="field-hint">{STR.settings.appearanceHint}</span>
      </div>

      <h2 className="section-label">{STR.settings.sectionImages}</h2>
      <NumberField
        label={STR.settings.imageMaxDimension}
        hint={STR.settings.imageMaxDimensionHint}
        value={draft.imageMaxDimension}
        range={SETTING_RANGES.imageMaxDimension}
        onChange={(imageMaxDimension) => setDraft({ ...draft, imageMaxDimension })}
      />
      <NumberField
        label={STR.settings.jpegQuality}
        hint={STR.settings.jpegQualityHint}
        value={draft.jpegQuality}
        range={SETTING_RANGES.jpegQuality}
        onChange={(jpegQuality) => setDraft({ ...draft, jpegQuality })}
      />

      <h2 className="section-label">{STR.settings.sectionVideos}</h2>
      <NumberField
        label={STR.settings.videoMaxHeight}
        hint={STR.settings.videoMaxHeightHint}
        value={draft.videoMaxHeight}
        range={SETTING_RANGES.videoMaxHeight}
        onChange={(videoMaxHeight) => setDraft({ ...draft, videoMaxHeight })}
      />
      <NumberField
        label={STR.settings.videoCrf}
        hint={STR.settings.videoCrfHint}
        value={draft.videoCrf}
        range={SETTING_RANGES.videoCrf}
        onChange={(videoCrf) => setDraft({ ...draft, videoCrf })}
      />
      <label className="toggle">
        <input
          type="checkbox"
          checked={draft.keepAudio}
          onChange={(e) => setDraft({ ...draft, keepAudio: e.target.checked })}
        />
        {STR.settings.keepAudio}
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={draft.hardwareAcceleration}
          onChange={(e) => setDraft({ ...draft, hardwareAcceleration: e.target.checked })}
        />
        <span>
          {STR.settings.hardwareAcceleration}
          <span className="field-hint block">{STR.settings.hardwareAccelerationHint}</span>
        </span>
      </label>

      <h2 className="section-label">{STR.settings.sectionOutput}</h2>
      <label className="toggle">
        <input
          type="checkbox"
          checked={draft.createZip}
          onChange={(e) => setDraft({ ...draft, createZip: e.target.checked })}
        />
        {STR.settings.createZipDefault}
      </label>
      <div className="out-location">
        <span className="field-label">{STR.settings.outputLocation}</span>
        <code className="mono path">{draft.outputParentDir ?? STR.settings.outputLocationDefault}</code>
        <span className="out-buttons">
          <button
            className="linklike"
            onClick={() => {
              void (async () => {
                const picked = await window.iqShrink.selectFolder();
                if (picked !== null) setDraft({ ...draft, outputParentDir: picked });
              })();
            }}
          >
            {STR.settings.changeLocation}
          </button>
          {draft.outputParentDir !== null && (
            <button className="linklike" onClick={() => setDraft({ ...draft, outputParentDir: null })}>
              {STR.settings.resetLocation}
            </button>
          )}
        </span>
      </div>

      <p className="muted">{STR.settings.appliesNextRun}</p>

      <div className="button-row">
        <button className="btn btn-grey" onClick={() => setDraft({ ...DEFAULT_SETTINGS })}>
          {STR.settings.resetAll}
        </button>
        <button className="btn btn-navy" onClick={save}>
          {STR.settings.save}
        </button>
        {savedNote && <span className="chip chip-mint">{STR.settings.saved}</span>}
      </div>
    </main>
  );
}

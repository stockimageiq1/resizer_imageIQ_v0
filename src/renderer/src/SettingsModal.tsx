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

export function SettingsModal(props: {
  settings: Settings;
  onClose: () => void;
  onSaved: (next: Settings) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Settings>(props.settings);

  const save = (): void => {
    void (async () => {
      const next = await window.iqShrink.setSettings(draft);
      props.onSaved(next);
    })();
  };

  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={STR.settings.title}>
        <h2>{STR.settings.title}</h2>

        <h3>{STR.settings.sectionImages}</h3>
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

        <h3>{STR.settings.sectionVideos}</h3>
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

        <h3>{STR.settings.sectionOutput}</h3>
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
          <code className="path">{draft.outputParentDir ?? STR.settings.outputLocationDefault}</code>
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

        <div className="button-row modal-buttons">
          <button className="secondary" onClick={() => setDraft({ ...DEFAULT_SETTINGS })}>
            {STR.settings.resetAll}
          </button>
          <span className="spacer" />
          <button className="secondary" onClick={props.onClose}>
            {STR.settings.cancel}
          </button>
          <button className="primary" onClick={save}>
            {STR.settings.save}
          </button>
        </div>
      </div>
    </div>
  );
}

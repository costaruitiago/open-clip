import React from 'react';
import type { CaptionSettings, CaptionStyle } from '../../api';

/**
 * The caption form itself, with no opinion about who owns the values.
 *
 * The project settings and a single clip's overrides are the same set of
 * controls over the same contract, so they are this one component driven by
 * different state. Anything that differs between the two — the lock, where the
 * values are stored, what a save means — belongs to the caller.
 */
interface CaptionControlsProps {
  value: CaptionSettings;
  onChange: (next: CaptionSettings) => void;
  presets: Record<string, CaptionStyle> | undefined;
  /** Resolved style to read from when a field has no override. */
  base: CaptionStyle | undefined;
  /** Set while the controls are showing inherited values that cannot be edited. */
  disabled?: boolean;
  idPrefix: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * `<input type="color">` accepts `#rrggbb` and nothing else. Anything it cannot
 * parse — a named colour, an `rgba()`, a malformed preset — is silently shown
 * as black, which reads as "the outline is black" rather than "this value is
 * not displayable". Presets also carry an alpha pair (`#000000CC`) that has to
 * be trimmed before the control sees it.
 */
const toColorInputValue = (raw: unknown, fallback: string): string => {
  if (typeof raw !== 'string') return fallback;
  const hex = raw.trim();
  return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex) ? hex.slice(0, 7).toUpperCase() : fallback;
};

// Only the fields worth a control. The rest of the contract stays where the
// preset put it, which is the point of presets.
const SLIDERS: Array<{ key: keyof CaptionStyle; label: string; min: number; max: number; step: number; unit: string }> = [
  { key: 'font_size_pct', label: 'Size', min: 2, max: 18, step: 0.5, unit: '% of frame' },
  // "Height" read as the height of the text, which is what "Size" already is.
  { key: 'position_pct', label: 'Position', min: 20, max: 98, step: 1, unit: '% from top' },
  { key: 'max_width_pct', label: 'Width', min: 40, max: 100, step: 2, unit: '% of frame' },
  { key: 'words_per_cue', label: 'Words on screen', min: 1, max: 10, step: 1, unit: '' },
  { key: 'outline_pct', label: 'Outline', min: 0, max: 2, step: 0.1, unit: '% of frame' },
  // "Pop" named a feeling. This scales the word currently being spoken.
  { key: 'active_scale', label: 'Emphasis', min: 1, max: 1.6, step: 0.02, unit: '× on the spoken word' },
];

const COLORS: Array<{ key: keyof CaptionStyle; label: string }> = [
  { key: 'text_color', label: 'Text' },
  { key: 'active_color', label: 'Spoken word' },
  { key: 'outline_color', label: 'Outline' },
];

const labelStyle: React.CSSProperties = {
  fontWeight: 500,
  fontSize: '0.75rem',
};

const controlStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.4rem',
  border: 'var(--border)', borderRadius: 'var(--radius)',
  background: 'var(--bg)',
  color: 'var(--text)',
  fontWeight: 500,
  fontSize: '0.8rem',
  minHeight: '44px',
};

export const CaptionControls: React.FC<CaptionControlsProps> = ({
  value: settings,
  onChange,
  presets,
  base,
  disabled = false,
  idPrefix,
}) => {
  const read = <K extends keyof CaptionStyle>(key: K): CaptionStyle[K] | undefined =>
    (settings.overrides[key] as CaptionStyle[K] | undefined) ?? base?.[key];

  const setOverride = (key: keyof CaptionStyle, next: unknown) =>
    onChange({ ...settings, overrides: { ...settings.overrides, [key]: next } });

  const presetEntries = Object.entries(presets ?? {});
  const hasOverrides = Object.keys(settings.overrides).length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', opacity: disabled ? 0.5 : 1 }}>
      <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', minHeight: '44px', cursor: disabled ? 'not-allowed' : 'pointer' }}>
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={disabled}
          onChange={(event) => onChange({ ...settings, enabled: event.target.checked })}
          style={{ width: '20px', height: '20px', accentColor: 'var(--accent)' }}
        />
        Burn captions into rendered clips
      </label>

      <div>
        <label htmlFor={`${idPrefix}-preset`} style={labelStyle}>Preset</label>
        <select
          id={`${idPrefix}-preset`}
          value={settings.preset}
          disabled={disabled}
          // A preset is a starting point; keeping stale overrides on top of a
          // new one would mean picking "Word Punch" and not seeing it.
          onChange={(event) => onChange({ ...settings, preset: event.target.value, overrides: {} })}
          style={controlStyle}
        >
          {/* A project can hold a preset name that has since been removed from
              caption_styles.json. Without a matching option the select falls
              back to showing the first entry, which claims a style it does
              not use. */}
          {presets && !presets[settings.preset] && (
            <option value={settings.preset}>{settings.preset} (unavailable)</option>
          )}
          {presetEntries.map(([name, preset]) => (
            <option key={name} value={name}>{preset.label}</option>
          ))}
        </select>
        <p style={{ margin: 'var(--space-sm) 0 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {presets?.[settings.preset]?.description}
        </p>
      </div>

      <details className="caption-tuning">
        <summary>
          <span>Fine-tune</span>
          {hasOverrides && (
            <span className="status-badge" style={{ background: 'var(--accent)', color: 'var(--bg)' }}>
              {Object.keys(settings.overrides).length} changed
            </span>
          )}
        </summary>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)' }}>
          {SLIDERS.map((slider) => {
            const raw = read(slider.key);
            // A stored value outside the slider's range is clamped by the input
            // but not by the readout, so the number beside the label used to
            // disagree with the thumb — and with what the render would use.
            const numeric = clamp(
              typeof raw === 'number' && Number.isFinite(raw) ? raw : slider.min,
              slider.min,
              slider.max
            );
            return (
              <div key={slider.key}>
                <label htmlFor={`${idPrefix}-${slider.key}`} style={labelStyle}>
                  {slider.label}
                  {/* Logical, not `right`: this label is a row of two things and
                      should flip with the writing direction. */}
                  <span style={{ float: 'inline-end', color: 'var(--text-muted)' }}>
                    {numeric}{slider.unit ? ` ${slider.unit}` : ''}
                  </span>
                </label>
                <input
                  id={`${idPrefix}-${slider.key}`}
                  type="range"
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  value={numeric}
                  disabled={disabled}
                  onChange={(event) => setOverride(slider.key, Number(event.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer', minHeight: '44px' }}
                />
              </div>
            );
          })}

          <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
            {COLORS.map((color) => (
              <div key={color.key} style={{ flex: '1 1 30%' }}>
                <label htmlFor={`${idPrefix}-${color.key}`} style={labelStyle}>{color.label}</label>
                <input
                  id={`${idPrefix}-${color.key}`}
                  type="color"
                  value={toColorInputValue(read(color.key), '#FFFFFF')}
                  disabled={disabled}
                  onChange={(event) => setOverride(color.key, event.target.value.toUpperCase())}
                  style={{ ...controlStyle, padding: '2px', cursor: 'pointer' }}
                />
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', minHeight: '44px', cursor: disabled ? 'not-allowed' : 'pointer' }}>
              <input
                type="checkbox"
                checked={Boolean(read('uppercase'))}
                disabled={disabled}
                onChange={(event) => setOverride('uppercase', event.target.checked)}
                style={{ width: '20px', height: '20px', accentColor: 'var(--accent)' }}
              />
              Uppercase
            </label>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', minHeight: '44px', cursor: disabled ? 'not-allowed' : 'pointer' }}>
              <input
                type="checkbox"
                checked={Boolean(read('box_color'))}
                disabled={disabled}
                // The box colour doubles as its on/off switch, here and in the
                // ASS style: no colour means no block behind the text.
                onChange={(event) => setOverride('box_color', event.target.checked ? '#000000CC' : null)}
                style={{ width: '20px', height: '20px', accentColor: 'var(--accent)' }}
              />
              Background block
            </label>
          </div>

          {/* Styled as a form control rather than as a `Button` variant on
              purpose: it belongs to the row of inputs above it. The dimming and
              the cursor come from the base `button:disabled` rule — they were
              inline here, at a fourth different opacity. */}
          <button
            type="button"
            onClick={() => onChange({ ...settings, overrides: {} })}
            disabled={disabled || !hasOverrides}
            style={{
              ...controlStyle,
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Reset to preset
          </button>
        </div>
      </details>
    </div>
  );
};

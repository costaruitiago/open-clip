import React from 'react';
import { Button } from '../Button';
import { splitHighlights } from './TextOverlay';
import type { OverlayText } from '../../api';

/**
 * The overlay title form itself, with no opinion about who owns the values.
 *
 * The project's configuration and one clip's own title are the same set of
 * controls over the same object, so they are this one component driven by
 * different state — the same split the captions make between `CaptionControls`
 * and the two dialogs that use it. The words are the exception, and the only
 * one: they belong to the clip, so the project's form leaves them out.
 * Everything else that differs between the two — the lock, where the values are
 * stored, what a save means — belongs to the caller.
 */
interface OverlayControlsProps {
  value: OverlayText;
  onChange: (next: OverlayText, immediate?: boolean) => void;
  /** Set while the controls are showing an inherited title that cannot be edited. */
  disabled?: boolean;
  idPrefix: string;
  /** Focused when the dialog opens: the words are what anyone came here for. */
  textRef?: React.RefObject<HTMLTextAreaElement | null>;
  /**
   * Whether the words are this form's business.
   *
   * False for the project, which holds how a title is drawn and nothing about
   * what it says: one line stored there would be one line over every clip in
   * the project at once. The words belong to the clip.
   */
  showText?: boolean;
  /** Reported by the preview: a word is wider than the frame at this size. */
  clipped?: boolean;
}

const SLIDERS: Array<{ key: keyof OverlayText; label: string; min: number; max: number; step: number; unit: string }> = [
  { key: 'start', label: 'Starts at', min: 0, max: 30, step: 0.5, unit: 's into the clip' },
  { key: 'duration', label: 'Stays for', min: 0.5, max: 30, step: 0.5, unit: 's' },
  // Listed, and zero by default: a title that ramps up is invisible on the one
  // frame most likely to be seen, so the fade has to be a decision.
  { key: 'fade_in', label: 'Fades in over', min: 0, max: 5, step: 0.1, unit: 's' },
  { key: 'fade_out', label: 'Fades out over', min: 0, max: 5, step: 0.1, unit: 's' },
  { key: 'font_size_pct', label: 'Size', min: 2, max: 20, step: 0.5, unit: '% of frame' },
  { key: 'position_pct', label: 'Position', min: 0, max: 85, step: 1, unit: '% from top' },
  { key: 'max_width_pct', label: 'Width', min: 40, max: 100, step: 2, unit: '% of frame' },
  { key: 'outline_pct', label: 'Outline', min: 0, max: 2, step: 0.1, unit: '% of frame' },
  // The hard offset shadow. It is here rather than assumed because the same
  // title is drawn on the thumbnail, where a heavier one earns its place, and
  // over busy footage, where it is the thing separating the words from what is
  // behind them.
  { key: 'shadow_pct', label: 'Shadow', min: 0, max: 3, step: 0.1, unit: '% of frame' },
];

/**
 * Three looks that are known to survive a phone feed, as one press each.
 *
 * They are not themes. Each one is a contrast decision: white-on-black is the
 * default every thumbnail guide starts from, yellow-on-black is the pairing
 * that measures highest, and black-on-white is what to reach for when the
 * footage behind the words is dark. Every one of them sets the whole group —
 * text, outline, shadow and the highlight — because half a look applied over
 * the other half of the last one is how a title ends up unreadable.
 */
const PRESETS: Array<{ name: string; patch: Partial<OverlayText> }> = [
  {
    name: 'Outlined',
    patch: {
      text_color: '#FFFFFF', outline_color: '#000000', outline_pct: 0.9,
      shadow_color: '#000000', shadow_pct: 0.8, highlight_color: '#FFE000',
      box_color: null,
    },
  },
  {
    name: 'Yellow on black',
    patch: {
      text_color: '#FFE000', outline_color: '#000000', outline_pct: 0.6,
      shadow_color: '#000000', shadow_pct: 0.8, highlight_color: '#FFFFFF',
      box_color: '#000000E6',
    },
  },
  {
    name: 'Black on white',
    patch: {
      text_color: '#121212', outline_color: '#FFFFFF', outline_pct: 0.6,
      shadow_color: '#121212', shadow_pct: 0.8, highlight_color: '#D40000',
      box_color: '#FFFFFFF2',
    },
  },
];

const COLORS: Array<{ key: keyof OverlayText; label: string }> = [
  { key: 'text_color', label: 'Text colour' },
  { key: 'outline_color', label: 'Outline colour' },
  { key: 'highlight_color', label: 'Marked word' },
  { key: 'shadow_color', label: 'Shadow colour' },
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

export const OverlayControls: React.FC<OverlayControlsProps> = ({
  value,
  onChange,
  disabled = false,
  idPrefix,
  textRef,
  clipped = false,
  showText = true,
}) => {
  const set = <K extends keyof OverlayText>(key: K, next: OverlayText[K]) =>
    onChange({ ...value, [key]: next });

  // Sent at once rather than debounced: a preset is one deliberate press, and
  // there is no second one coming in 300ms.
  const apply = (patch: Partial<OverlayText>) => onChange({ ...value, ...patch }, true);

  // The marks are instructions to the renderer, so they are not part of what
  // anyone reads and must not be counted as if they were.
  const visible = splitHighlights(value.text).map(([run]) => run).join('');
  const words = visible.trim() ? visible.trim().split(/\s+/).length : 0;
  const longestLine = visible
    .split('\n')
    .reduce((longest, line) => Math.max(longest, line.trim().length), 0);
  // Three to five words, and a line short enough to be taken in at a glance:
  // past that a thumbnail is read as a paragraph, which is to say not read.
  const overlong = words > 5 || longestLine > 24;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-md)',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {showText && (
        <div>
          <label htmlFor={`${idPrefix}-text`} style={labelStyle}>Text</label>
          <textarea
            id={`${idPrefix}-text`}
            ref={textRef}
            value={value.text}
            rows={2}
            maxLength={200}
            disabled={disabled}
            placeholder="The line that opens the clip"
            onChange={(event) => set('text', event.target.value)}
            style={{ ...controlStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
          <p style={{ margin: 'var(--space-sm) 0 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            A line break here is a line break on the video. Wrap a word in
            {' '}<code>*asterisks*</code>{' '}to colour it — one word, so the eye has somewhere to land.
          </p>
          {words > 0 && (
            <p
              style={{
                margin: 'var(--space-sm) 0 0 0',
                fontSize: '0.75rem',
                fontWeight: 500,
                color: overlong ? 'var(--accent)' : 'var(--text-muted)',
              }}
            >
              {words} {words === 1 ? 'word' : 'words'}, longest line {longestLine} characters
              {overlong ? '. Three to five words is what gets clicked; past that it is a paragraph.' : ''}
            </p>
          )}
        </div>
      )}

      <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', minHeight: '44px', cursor: disabled ? 'not-allowed' : 'pointer' }}>
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={disabled}
          onChange={(event) => set('enabled', event.target.checked)}
          style={{ width: '20px', height: '20px', accentColor: 'var(--accent)' }}
        />
        {showText ? 'Burn this title into rendered clips' : 'Burn titles into rendered clips'}
      </label>

      <div>
        <span style={labelStyle}>Look</span>
        <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap', marginTop: 'var(--space-sm)' }}>
          {PRESETS.map((preset) => (
            <Button
              key={preset.name}
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => apply(preset.patch)}
              style={{ flex: '1 1 auto' }}
            >
              {preset.name}
            </Button>
          ))}
        </div>
        <p style={{ margin: 'var(--space-sm) 0 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          Sets the colours, the outline and the shadow together. Yellow on black is the
          pairing that measures highest; black on white is the one for dark footage.
        </p>
      </div>

      {SLIDERS.map((slider) => {
        const raw = value[slider.key];
        const numeric = typeof raw === 'number' && Number.isFinite(raw)
          ? Math.min(slider.max, Math.max(slider.min, raw))
          : slider.min;
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
              onChange={(event) => set(slider.key, Number(event.target.value) as never)}
              style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer', minHeight: '44px' }}
            />
          </div>
        );
      })}

      {clipped && (
        <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 500, color: 'var(--accent)' }}>
          A word is wider than the frame at this size, and the burn cuts it off rather than
          breaking it. Make it smaller, widen it, or put a line break in the text.
        </p>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
        {COLORS.map((color) => (
          <div key={color.key} style={{ flex: '1 1 40%' }}>
            <label htmlFor={`${idPrefix}-${color.key}`} style={labelStyle}>{color.label}</label>
            <input
              id={`${idPrefix}-${color.key}`}
              type="color"
              value={value[color.key] as string}
              disabled={disabled}
              onChange={(event) => set(color.key, event.target.value.toUpperCase() as never)}
              style={{ ...controlStyle, padding: '2px', cursor: 'pointer' }}
            />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', minHeight: '44px', cursor: disabled ? 'not-allowed' : 'pointer' }}>
          <input
            type="checkbox"
            checked={value.uppercase}
            disabled={disabled}
            onChange={(event) => set('uppercase', event.target.checked)}
            style={{ width: '20px', height: '20px', accentColor: 'var(--accent)' }}
          />
          Uppercase
        </label>
        <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', minHeight: '44px', cursor: disabled ? 'not-allowed' : 'pointer' }}>
          <input
            type="checkbox"
            checked={Boolean(value.box_color)}
            disabled={disabled}
            // The box colour doubles as its on/off switch, here and in the ASS
            // style: no colour means no block behind the text.
            onChange={(event) => set('box_color', event.target.checked ? '#000000CC' : null)}
            style={{ width: '20px', height: '20px', accentColor: 'var(--accent)' }}
          />
          Background block
        </label>
      </div>
    </div>
  );
};

import { describe, it, expect } from 'vitest';
import { targetAspectRatio, formatTimecode, matchesOutputSettings } from './aspectRatio';

const ASPECT_RATIOS = { '16:9': '16:9', '9:16': '9:16', '1:1': '1:1' };
const RESOLUTIONS = { '1080p': '1920x1080', '720p': '1280x720' };

const ratio = (settings: { resolution?: string; aspect_ratio?: string }) =>
  targetAspectRatio(settings, ASPECT_RATIOS, RESOLUTIONS);

describe('targetAspectRatio', () => {
  it('uses the configured aspect ratio when the resolution is left alone', () => {
    expect(ratio({ resolution: 'keep original', aspect_ratio: '9:16' })).toBeCloseTo(9 / 16);
  });

  // The backend resolves a named resolution to fixed pixel dimensions and stops
  // there, so the aspect ratio setting is ignored. Whether or not that is the
  // intent, the preview has to show the frame that will actually be rendered.
  it('lets a fixed resolution override the aspect ratio, as the render does', () => {
    expect(ratio({ resolution: '1080p', aspect_ratio: '9:16' })).toBeCloseTo(1920 / 1080);
  });

  it('keeps the source framing when neither setting constrains it', () => {
    expect(ratio({ resolution: 'keep original', aspect_ratio: 'keep original' })).toBeNull();
  });

  it('falls back to the source framing for a ratio it does not recognise', () => {
    expect(ratio({ resolution: 'keep original', aspect_ratio: 'widescreen-ish' })).toBeNull();
  });

  it('reads a raw ratio that is not in the config', () => {
    expect(ratio({ resolution: 'keep original', aspect_ratio: '4:3' })).toBeCloseTo(4 / 3);
  });

  it('treats missing settings as source framing', () => {
    expect(targetAspectRatio(undefined, ASPECT_RATIOS, RESOLUTIONS)).toBeNull();
  });
});

describe('matchesOutputSettings', () => {
  const settings = { resolution: 'keep original', aspect_ratio: '9:16' };

  it('accepts a file cut with the settings still in force', () => {
    expect(
      matchesOutputSettings(settings, {
        rendered_aspect_ratio: '9:16',
        rendered_resolution: 'keep original',
      })
    ).toBe(true);
  });

  it('rejects a file cut before the ratio was changed', () => {
    expect(
      matchesOutputSettings(settings, {
        rendered_aspect_ratio: '16:9',
        rendered_resolution: 'keep original',
      })
    ).toBe(false);
  });

  it('rejects a file cut before the resolution was changed', () => {
    expect(
      matchesOutputSettings(settings, {
        rendered_aspect_ratio: '9:16',
        rendered_resolution: '1080p',
      })
    ).toBe(false);
  });

  // Changing a setting and changing it back leaves the file matching again,
  // which is the point of comparing values rather than stamping a time.
  it('accepts a file again once the setting is put back', () => {
    expect(
      matchesOutputSettings(
        { resolution: '1080p', aspect_ratio: '16:9' },
        { rendered_aspect_ratio: '16:9', rendered_resolution: '1080p' }
      )
    ).toBe(true);
  });

  it('reads an unset setting and "keep original" as the same instruction', () => {
    expect(
      matchesOutputSettings(
        { aspect_ratio: '9:16' },
        { rendered_aspect_ratio: '9:16', rendered_resolution: 'keep original' }
      )
    ).toBe(true);
  });

  it('rejects a file cut before the layout was changed', () => {
    expect(
      matchesOutputSettings(
        { ...settings, layout: 'stacked' },
        { rendered_aspect_ratio: '9:16', rendered_resolution: 'keep original' }
      )
    ).toBe(false);
    expect(
      matchesOutputSettings(settings, {
        rendered_aspect_ratio: '9:16',
        rendered_resolution: 'keep original',
        rendered_layout: 'stacked',
      })
    ).toBe(false);
  });

  it('accepts a stacked file under a stacked project', () => {
    expect(
      matchesOutputSettings(
        { ...settings, layout: 'stacked' },
        { rendered_aspect_ratio: '9:16', rendered_resolution: 'keep original', rendered_layout: 'stacked' }
      )
    ).toBe(true);
  });

  // Every clip cut before this was recorded, which must not all read as stale.
  it('takes a file that recorded nothing at its word', () => {
    expect(matchesOutputSettings(settings, {})).toBe(true);
    expect(matchesOutputSettings(settings, undefined)).toBe(true);
  });
});

describe('formatTimecode', () => {
  it('drops the hour until there is one', () => {
    expect(formatTimecode(65)).toBe('1:05');
    expect(formatTimecode(3725)).toBe('1:02:05');
  });

  it('clamps a negative position rather than printing a minus sign', () => {
    expect(formatTimecode(-4)).toBe('0:00');
  });
});

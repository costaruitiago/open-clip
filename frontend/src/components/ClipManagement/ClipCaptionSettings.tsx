import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { CaptionControls } from './CaptionControls';
import { CaptionOverlay } from './CaptionOverlay';
import { ClipPlayer } from './ClipPlayer';
import {
  getCaptionStyles,
  updateClipCaptions,
  type CaptionPreview,
  type CaptionSettings,
  type CaptionStyle,
} from '../../api';

/**
 * The picture to place the captions against.
 *
 * Whatever the next render will look like: the cut file when it has no captions
 * in it yet, otherwise the source played inside the highlight's window. A file
 * that already carries burned words is the one thing that must not be used —
 * the overlay would draw a second set over the first, and the pair would only
 * agree while the settings went untouched.
 */
export interface CaptionPreviewSource {
  src: string;
  /** Offset of the clip inside `src`. Zero for a file that is already the cut. */
  start: number;
  /** End of the window inside `src`, or null to play it to its end. */
  end: number | null;
  /** True while `src` is the uncut source and the window is being simulated. */
  isPreview: boolean;
  aspectRatio: number | null;
  label: string;
}

interface ClipCaptionSettingsProps {
  projectId: string;
  clipIndex: number;
  /** The clip's resolved preview, which carries its lock state. */
  captions: CaptionPreview | undefined;
  isOpen: boolean;
  onClose: () => void;
  /** The clip's own picture, or null when there is nothing to play. */
  preview: CaptionPreviewSource | null;
}

/**
 * One clip's captions, and whether it has any of its own.
 *
 * Locked is the default and means the clip has no stored settings at all — it
 * reads the project's, including changes made to them later. Unlocking copies
 * the project's current values onto the clip as a starting point, so unlocking
 * changes nothing by itself; it only stops the clip listening. Re-locking
 * discards the clip's copy and hands it back to the project.
 *
 * The clip plays above the controls, with the captions drawn over it exactly
 * where the burn would put them. Placement is the whole reason to open this —
 * whether the words clear a face, a lower third, or the platform's own UI is a
 * question about *this* footage, and answering it against a slider labelled
 * "% from top" alone means rendering the clip to find out.
 */
export const ClipCaptionSettings: React.FC<ClipCaptionSettingsProps> = ({
  projectId,
  clipIndex,
  captions,
  isOpen,
  onClose,
  preview,
}) => {
  const queryClient = useQueryClient();
  const { data: presets } = useQuery({ queryKey: ['captionStyles'], queryFn: getCaptionStyles });
  const [pending, setPending] = useState<CaptionSettings | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isLocked = captions ? captions.locked && !pending : true;
  const stored = pending ?? captions?.settings ?? null;

  const mutation = useMutation({
    mutationFn: (next: CaptionSettings | null) => updateClipCaptions(projectId, clipIndex, next),
    onSuccess: () => {
      // Both the clip's own cues and the card that draws them.
      queryClient.invalidateQueries({ queryKey: ['clipCaptions', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
    },
  });

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // The dialog closing ends this editing session; anything typed into it has
  // already been sent, and holding the draft would show it again on a clip
  // whose stored answer has since changed. Dropped here rather than in an
  // effect watching `isOpen`: every way out of the dialog — the button, the
  // scrim, Escape — is this one handler.
  const close = () => {
    setPending(null);
    onClose();
  };

  const commit = (next: CaptionSettings, immediate = false) => {
    setPending(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => mutation.mutate(next), immediate ? 0 : 250);
  };

  const unlock = () => {
    // Seeded from what this clip resolves to right now, so unlocking is a
    // promise about nothing changing until the user changes it.
    const seed: CaptionSettings = captions?.settings ?? {
      enabled: captions?.enabled ?? false,
      preset: captions?.style?.label ? findPresetName(presets, captions) : 'karaoke_pop',
      overrides: {},
    };
    commit(seed, true);
  };

  const relock = () => {
    setPending(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    mutation.mutate(null);
  };

  // The resolved style is the right base whether the clip is locked (it is the
  // project's) or unlocked (it is the clip's own).
  const base = stored ? presets?.[stored.preset] ?? captions?.style : captions?.style;

  // What the overlay draws, resolved here rather than waited for: the backend
  // lays the overrides over the preset and hands back the result, but that is a
  // save and a refetch away, and a slider has to move the words under the thumb
  // now. Same order the backend resolves in, so the two agree once it lands.
  //
  // Cues are the exception — which words share one is decided by
  // caption_builder.py — so `words_per_cue` only reflows once the save comes
  // back, a beat after the rest.
  const draftStyle: CaptionStyle | undefined = base
    ? { ...base, ...(stored?.overrides ?? {}) }
    : captions?.style;
  const hasCues = (captions?.cues.length ?? 0) > 0;
  const enabled = stored?.enabled ?? captions?.enabled ?? false;

  return (
    <Modal
      isOpen={isOpen}
      title={`Captions for clip ${clipIndex + 1}`}
      onClose={close}
      // Wider than the default dialog: this one has a picture in it, and at
      // 520px a 9:16 clip left the controls a column narrower than the video.
      maxWidth="620px"
      footer={
        <Button variant={isLocked ? 'primary' : 'ghost'} onClick={isLocked ? unlock : relock}>
          {isLocked ? 'Use custom settings' : 'Follow the project again'}
        </Button>
      }
    >
      {/* Sticky, and pulled up over the panel's own top padding, so the picture
          stays on screen while the controls under it are scrolled and dragged.
          A preview you have to scroll away from to reach the slider that moves
          it is not a preview. */}
      <div
        style={{
          position: 'sticky',
          top: 'calc(-1 * var(--space-md))',
          zIndex: 1,
          background: 'var(--bg)',
          margin: 'calc(-1 * var(--space-md)) 0 var(--space-md) 0',
          padding: 'var(--space-md) 0 var(--space-sm) 0',
        }}
      >
        {preview ? (
          <div
            style={{
              border: 'var(--border)', borderRadius: 'var(--radius-lg)',
              marginInline: 'auto',
              // Capped by height rather than width: the dialog is portrait-hostile,
              // and a 9:16 clip given the full 620px would be taller than the screen.
              maxWidth: preview.aspectRatio
                ? `calc(min(300px, 40vh) * ${preview.aspectRatio})`
                : undefined,
            }}
          >
            <ClipPlayer
              src={preview.src}
              start={preview.start}
              end={preview.end}
              isPreview={preview.isPreview}
              aspectRatio={preview.aspectRatio}
              label={preview.label}
              cues={captions?.cues}
              renderOverlay={
                hasCues && draftStyle
                  ? (position) => (
                      <CaptionOverlay
                        cues={captions!.cues}
                        style={draftStyle}
                        font={captions!.font}
                        time={position}
                        // Paused on a gap between cues, this dialog would show a
                        // bare frame and nothing to place.
                        holdWhenSilent
                      />
                    )
                  : undefined
              }
            />
          </div>
        ) : (
          <p
            role="status"
            style={{
              margin: 0,
              padding: 'var(--space-md)',
              border: '1px dashed var(--hairline-strong)', borderRadius: 'var(--radius-lg)',
              textAlign: 'center',
              fontSize: '0.75rem',
            }}
          >
            No video to place these captions against. Re-upload the source to this project.
          </p>
        )}
      </div>

      <p style={{ margin: '0 0 var(--space-md) 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        {isLocked
          ? 'This clip follows the project’s caption settings, including any later changes to them.'
          : 'This clip has its own caption settings. The project’s no longer affect it.'}
        {preview && !hasCues
          ? ' There are no words to draw on it — run the Transcribe step to caption this clip.'
          : preview && !enabled
            ? ' Captions are off, so the preview shows what turning them on would burn in.'
            : ''}
      </p>

      <CaptionControls
        idPrefix={`clip-${clipIndex}-caption`}
        value={stored ?? {
          enabled: captions?.enabled ?? false,
          preset: 'karaoke_pop',
          overrides: {},
        }}
        onChange={commit}
        presets={presets}
        base={base}
        // Shown but not editable while locked: the values are real, they just
        // belong to the project. Editing them here would silently unlock.
        disabled={isLocked}
      />

      {mutation.isError && (
        <p role="alert" style={{ margin: 'var(--space-md) 0 0 0', fontSize: '0.75rem', color: 'var(--error)' }}>
          Could not save this clip’s caption settings. It will render with whatever was last saved.
        </p>
      )}
    </Modal>
  );
};

/**
 * Which preset the clip's resolved style came from.
 *
 * The preview reports a flattened style rather than the name behind it, so the
 * name is recovered by matching labels. A miss falls back to the default, which
 * is what an unknown or removed preset should resolve to anyway.
 */
const findPresetName = (
  presets: Record<string, { label: string }> | undefined,
  captions: CaptionPreview
): string => {
  const match = Object.entries(presets ?? {}).find(
    ([, preset]) => preset.label === captions.style.label
  );
  return match?.[0] ?? 'karaoke_pop';
};

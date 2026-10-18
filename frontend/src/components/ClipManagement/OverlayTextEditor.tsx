import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { ClipPlayer } from './ClipPlayer';
import { TextOverlay } from './TextOverlay';
import { OverlayControls } from './OverlayControls';
import type { CaptionPreviewSource } from './ClipCaptionSettings';
import {
  updateClipOverlay,
  type CaptionFont,
  type OverlayText,
} from '../../api';

interface OverlayTextEditorProps {
  projectId: string;
  clipIndex: number;
  isOpen: boolean;
  onClose: () => void;
  /**
   * A picture to place the title against, shown inside the dialog.
   *
   * The clip grid passes one because the card it was opened from may be
   * anywhere on a scrolled page, or behind the scrim entirely. The clip detail
   * page passes none: its player is already on screen behind this dialog and
   * draws the same draft.
   */
  preview?: CaptionPreviewSource | null;
  /** The face the burn will use, for the dialog's own preview. */
  font?: CaptionFont | null;
  /** What the preview is currently drawing: the draft if there is one, else what is stored. */
  value: OverlayText;
  /** Reports the edit so the player behind the dialog redraws as it is typed. */
  onChange: (next: OverlayText) => void;
  /** True once the rendered file already has this title in its pixels. */
  isBurned?: boolean;
  /**
   * True while this clip has no title of its own.
   *
   * The same lock the caption settings keep: the clip stores nothing, so the
   * project's configuration keeps reaching it, and the controls show the look
   * it would be drawn in until the user writes a line of their own.
   */
  isLocked?: boolean;
}

/**
 * How wide a thumbnail actually is in a phone's feed.
 *
 * The one test the whole craft comes down to: shrink it to this and see if the
 * words still land. A title that needs the 300px preview to be read is a title
 * nobody reads.
 */
const FEED_WIDTH_PX = 120;

/**
 * One clip's overlay title: the text, when it shows, and how it looks.
 *
 * Every change is written to the clip rather than held here, the same contract
 * the caption settings keep: the clipper burns from what is stored, so what the
 * preview draws is a promise about the next render. Writes are debounced
 * because typing a title would otherwise be one request per keystroke.
 *
 * A clip that has never been given a title of its own has none: the controls
 * show the project's configuration, which is the look any title here would be
 * drawn in, until it is unlocked. Unlocking copies that look onto the clip, so
 * writing a title never means restyling one.
 *
 * Saving does not touch the rendered file — nothing does until the clip is
 * re-cut — so the dialog says so rather than letting a saved title look burned.
 */
export const OverlayTextEditor: React.FC<OverlayTextEditorProps> = ({
  projectId,
  clipIndex,
  isOpen,
  onClose,
  value,
  onChange,
  isBurned = false,
  isLocked = false,
  preview = null,
  font = null,
}) => {
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the debounce is holding. Kept in a ref rather than read from `value`
  // on the way out: the dialog can be closed from a scrim click, which does not
  // re-render this component first.
  const unsavedRef = useRef<OverlayText | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Not persisted: it is a way of looking at the title, not part of it.
  const [feedSize, setFeedSize] = useState(false);
  // Reported by the preview, which is the only thing here that knows how wide
  // the real face draws these particular words.
  const [clipped, setClipped] = useState(false);
  // Set the moment the clip is unlocked, so the controls come alive on the same
  // press rather than a request and a refetch later.
  const [unlocked, setUnlocked] = useState(false);
  const locked = isLocked && !unlocked;

  const invalidate = () => {
    // The stored overlay travels on the project; the face it will be drawn
    // with travels on the clip's caption preview.
    queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
    queryClient.invalidateQueries({ queryKey: ['clipCaptions', projectId] });
  };

  const mutation = useMutation({
    mutationFn: (next: OverlayText | null) => updateClipOverlay(projectId, clipIndex, next),
    onSuccess: invalidate,
  });

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const commit = (next: OverlayText, immediate = false) => {
    onChange(next);
    unsavedRef.current = next;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flush(), immediate ? 0 : 300);
  };

  /**
   * Sends whatever the debounce is still holding, now.
   *
   * Every way out of this dialog goes through here, because the last keystroke
   * before a close would otherwise be sitting in a timer nobody waits for — a
   * title typed and closed in the same second was simply lost.
   */
  const flush = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const unsaved = unsavedRef.current;
    unsavedRef.current = null;
    if (unsaved) mutation.mutate(unsaved);
  };

  const close = () => {
    flush();
    // The lock is a property of the clip, so the next time this dialog opens —
    // on a different clip, or on the same one after the project came back — it
    // starts from what that clip says rather than from this session's answer.
    setUnlocked(false);
    onClose();
  };

  /**
   * Gives this clip a title of its own.
   *
   * Seeded from the project's configuration, so the words are the only thing
   * left to decide: a new title arrives in the look the rest of the project
   * already uses.
   */
  const unlock = () => {
    setUnlocked(true);
    commit({ ...value }, true);
    textRef.current?.focus();
  };

  /** Takes the title off this clip; the project's configuration is all that is left. */
  const relock = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    // Dropped rather than flushed: the pending edit is to a title the clip is
    // about to stop owning, and sending it would race the removal.
    unsavedRef.current = null;
    setUnlocked(false);
    mutation.mutate(null);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      title={`Overlay text for clip ${clipIndex + 1}`}
      onClose={close}
      maxWidth={preview ? '620px' : undefined}
      initialFocusRef={textRef}
      footer={
        locked ? (
          <Button variant="primary" onClick={unlock}>
            Give this clip its own title
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={relock}>
              Remove this title
            </Button>
            {/* Redundant against the autosave, and worth having anyway: a form
                with no button to press gives the user nothing to believe. It
                sends what the debounce is still holding rather than a copy of
                what is already stored. */}
            <Button variant="primary" onClick={close}>
              Save and close
            </Button>
          </>
        )
      }
    >
      {preview && (
        // Sticky, like the caption dialog's: the picture is what the sliders
        // are aimed at, so it stays put while they are scrolled to.
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
          <div
            style={{
              border: 'var(--border)',
              marginInline: 'auto',
              // The whole frame shrinks, so the overlay shrinks with it: every
              // size on a title is a percentage of the frame, and the preview
              // measures the box it is actually drawn in.
              maxWidth: feedSize
                ? `${FEED_WIDTH_PX}px`
                : preview.aspectRatio
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
              renderOverlay={(position) => (
                <TextOverlay
                  overlay={value}
                  font={font}
                  time={position}
                  // The title is the subject of this dialog, so it is drawn
                  // whatever the playhead is doing — including at the exact
                  // moment its fade starts, where it is otherwise invisible.
                  forceVisible
                  onOverflow={setClipped}
                />
              )}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--space-sm)' }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFeedSize(!feedSize)}
              aria-pressed={feedSize}
            >
              {feedSize ? 'Back to full size' : `Feed size (${FEED_WIDTH_PX}px)`}
            </Button>
          </div>
        </div>
      )}
      <p style={{ margin: '0 0 var(--space-md) 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        {locked
          ? 'This clip has no title of its own. Write one and it is drawn in the project\u2019s look, which you set under Overlay titles.'
          : isBurned
            ? 'This title is already burned into the rendered file. Changing it here changes the next render, not the file you have.'
            : preview
              ? 'Saved as you type, and drawn on the clip above. Regenerate the clip to burn it into the video.'
              : 'Saved as you type, and drawn over the player behind this dialog. Regenerate the clip to burn it into the video.'}
      </p>

      <OverlayControls
        idPrefix={`clip-${clipIndex}-overlay`}
        value={value}
        onChange={commit}
        disabled={locked}
        textRef={textRef}
        clipped={clipped}
      />

      {mutation.isError && (
        <p role="alert" style={{ margin: 'var(--space-md) 0 0 0', fontSize: '0.75rem', color: 'var(--error)' }}>
          Could not save this title. The clip would render with whatever was last saved, not what is on screen.
        </p>
      )}
    </Modal>
  );
};

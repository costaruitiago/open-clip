import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getClipPublication, getStudioEditUrl, type UploadPrivacy } from '../../api';
import { formatPublishAt } from '../../utils/uploadSchedule';
import { Button } from '../Button';
import { ConfirmationModal } from '../ConfirmationModal';
import { describeRequestFailure, useClipRender } from '../../hooks/useClipRender';
import { useClipUpload } from '../../hooks/useClipUpload';
import { useClipPostiz } from '../../hooks/useClipPostiz';

interface ClipActionsProps {
  projectId: string;
  clipIndex: number;
  /** What the upload will be called on YouTube, so the confirmation can say. */
  clipTitle?: string;
  /**
   * False while the clip is still only a preview, with no file on disk. It no
   * longer gates the upload — publishing cuts the clip itself — and only
   * decides whether the render button offers a first cut or another one.
   */
  isRendered?: boolean;
  /**
   * Where this clip already lives on YouTube, when it has been published.
   *
   * Uploading again is allowed — a re-rendered clip is a legitimate reason —
   * but it publishes a second video rather than replacing the first, so the
   * confirmation has to say so.
   */
  youtubeUrl?: string | null;
  /** The published video's id, which is what addresses its Studio edit page. */
  youtubeVideoId?: string | null;
  /**
   * What the video is on YouTube, and — for a scheduled one — when YouTube
   * turns it public. The only thing that tells a scheduled short from a
   * private one: following the link shows the same page until the hour comes.
   */
  youtubePrivacy?: UploadPrivacy | null;
  youtubePublishAt?: string | null;
  /**
   * When this clip was last published, which is how a finished upload job is
   * told from one that gave up: the job leaves `/active_processes` either way.
   */
  uploadedAt?: string | null;
  /**
   * When the current file was written, which is how a finished re-cut is told
   * from one that fell over: the job leaves `/active_processes` either way.
   */
  renderedAt?: string | null;
  /**
   * Where this clip's Postiz post sits, once it has been imported. Unlike the
   * YouTube record this points at a draft on the user's own calendar, so the
   * link is an invitation to go and send it rather than a published thing.
   */
  postizUrl?: string | null;
  /**
   * When this clip was last imported, which is how a finished import job is
   * told from one that gave up: the job leaves `/active_processes` either way.
   */
  postizImportedAt?: string | null;
  /**
   * What Postiz has since done with the post, from the last sync: `published`,
   * `scheduled`, `error`, or absent for one it will not talk about — which is
   * every draft, since its public API returns none. So absent is "waiting, as
   * far as anyone here can tell", not "gone".
   */
  postizState?: string | null;
  /** Each channel the post went to, and where it landed once it is out. */
  postizChannels?: { id: string; name?: string; platform?: string; state?: string | null; url?: string | null }[];
  /** Opens the overlay-text editor, which the page owns because it draws into the player. */
  onEditOverlay: () => void;
  /** True once this clip has a title, so the button can say which it does. */
  hasOverlay?: boolean;
  /** Opens the trimmer: where in the source this clip starts and ends. */
  onTrim?: () => void;
  /**
   * True when the window has moved since the file was cut.
   *
   * A trim renders nothing, so the file can be playing footage the timecodes no
   * longer describe. The button says so rather than leaving it to be noticed.
   */
  needsRecut?: boolean;
}

export const ClipActions: React.FC<ClipActionsProps> = ({
  projectId,
  clipIndex,
  clipTitle,
  isRendered = true,
  youtubeUrl,
  youtubeVideoId,
  youtubePrivacy,
  youtubePublishAt,
  uploadedAt,
  renderedAt,
  postizUrl,
  postizImportedAt,
  postizState,
  postizChannels = [],
  onEditOverlay,
  hasOverlay = false,
  onTrim,
  needsRecut = false,
}) => {
  const queryClient = useQueryClient();

  // Nothing tells this application when a video it published is deleted, so
  // the record outlives the video — a dead link here. The server checks with YouTube and clears the record
  // if it has gone, so asking is also the fix; the project is refetched to
  // pick the correction up.
  const { data: publication } = useQuery({
    queryKey: ['clipPublication', projectId, clipIndex],
    queryFn: () => getClipPublication(projectId, clipIndex),
    enabled: !!youtubeVideoId,
    // The answer changes on YouTube, not here, so it is not worth re-asking on
    // every remount of this page.
    staleTime: 5 * 60_000,
    retry: false,
  });

  React.useEffect(() => {
    if (publication && publication.checked && !publication.published) {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
    }
  }, [publication, projectId, queryClient]);

  // What the page may claim. A record the server has just told us is stale is
  // not shown for the moment it takes the project to come back without it.
  const isPublished = !!youtubeVideoId && !(publication?.checked && !publication.published);

  const [isConfirming, setIsConfirming] = useState(false);
  const [actionResult, setActionResult] = useState<{ ok: boolean; message: string } | null>(null);

  // The re-cut itself lives in a hook, because the clip card on the project
  // page offers the same action and the two have to agree about when a render
  // is running and what finishing means.
  const { isRendering, start: startRender } = useClipRender({
    projectId,
    clipIndex,
    renderedAt,
    onFinished: setActionResult,
  });

  // Publishing is watched the same way a re-cut is, because it now starts with
  // one: the clip is cut afresh so the video that goes up is the video the page
  // was showing, which takes far longer than a request can be held open.
  const { isUploading, start: startUpload } = useClipUpload({
    projectId,
    clipIndex,
    uploadedAt,
    onFinished: setActionResult,
  });

  // The Postiz import is the same shape of job as the upload — it re-cuts the
  // clip first — and differs in what it produces: a draft on a calendar the
  // user owns rather than a public video.
  const { isImporting, start: startPostizImport } = useClipPostiz({
    projectId,
    clipIndex,
    importedAt: postizImportedAt,
    onFinished: setActionResult,
  });

  const handlePostizImport = () => {
    if (isImporting) return;
    setActionResult(null);
    void startPostizImport();
  };

  const handleRegenerate = () => {
    setActionResult(null);
    void startRender();
  };

  const handleUpload = () => {
    // The dialog closes on confirm, but a second confirm can still land while
    // the first request is in flight — and this one publishes.
    if (isUploading) return;
    setIsConfirming(false);
    setActionResult(null);
    void startUpload();
  };

  // A column of full-width rows rather than the default centred pill: these sit
  // in a 320px aside above the Captions panel button, and reading down a
  // left-aligned edge is what makes the group read as one list of actions.
  // Everything visual past that comes from the variant classes.
  const rowStyle: React.CSSProperties = {
    width: '100%',
    minHeight: '44px',
    textAlign: 'left',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', marginTop: 'var(--space-md)' }}>
      {/* h2, not h3. This is a section of the page in its own right; as an h3
          it read to a screen reader as a subsection of Social Posts, which is
          simply the heading that happened to precede it. */}
      <h2 style={{ margin: '0 0 var(--space-sm) 0', fontSize: '1.2rem' }}>Actions</h2>
      {/* The page's one consequential action, so it is the only primary. */}
      <Button
        variant="primary"
        size="sm"
        style={rowStyle}
        onClick={() => setIsConfirming(true)}
        // Available for a clip nobody has rendered: the upload cuts it first.
        disabled={isUploading || isRendering || isImporting}
      >
        {isUploading
          ? 'Rendering, then uploading…'
          : youtubeUrl
            ? 'Upload to YouTube again'
            : 'Upload to YouTube'}
      </Button>
      {isUploading && (
        // The same promise the re-cut makes, and worth repeating here: the job
        // is the backend's, so a user who navigates away has not cancelled a
        // publish halfway through.
        <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
          Cutting the clip again, then publishing it. This keeps going if you leave the page.
        </p>
      )}
      {isPublished && youtubeUrl && (
        // The published video, named as such. Publishing cannot be undone from
        // here, so the page has to show that it already happened rather than
        // leaving the button looking untouched.
        <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
          Published:{' '}
          <a href={youtubeUrl} target="_blank" rel="noreferrer">
            {youtubeUrl}
          </a>
        </p>
      )}
      {isPublished && youtubePrivacy && youtubePrivacy !== 'public' && (
        // What it is up as. Worth a line of its own because the link above
        // looks the same whether the video is private forever, unlisted, or
        // waiting for an hour that has been chosen — and only one of those
        // means anybody will ever see it without being sent the URL.
        <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
          {youtubePrivacy === 'schedule' && youtubePublishAt
            ? `Private until ${formatPublishAt(youtubePublishAt)}, when YouTube publishes it.`
            : youtubePrivacy === 'unlisted'
              ? 'Unlisted: anyone with the link can watch it.'
              : 'Private: only you can watch it.'}
        </p>
      )}
      {isPublished && youtubeVideoId && (
        // The one part of publishing this app cannot finish. A Short's related
        // video is set in Studio and nowhere else — the API has no field for
        // it, and the link in the description does not create it — so the step
        // is named here rather than left to be discovered as a thing that did
        // not happen.
        <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
          YouTube only lets the related video be attached in Studio, so the link
          back to the full episode has to be set there:{' '}
          <a href={getStudioEditUrl(youtubeVideoId)} target="_blank" rel="noreferrer">
            edit this Short in Studio
          </a>
          .
        </p>
      )}
      {/* Not behind a confirmation, unlike the upload: what this makes is a
          draft on the user's own Postiz calendar, which reaches nobody until
          they open it and press send. Importing twice makes a second draft
          rather than doing anything irreversible. */}
      <Button
        variant="ghost"
        size="sm"
        style={rowStyle}
        onClick={handlePostizImport}
        // Every one of these cuts this same clip into the same file.
        disabled={isImporting || isUploading || isRendering}
      >
        {isImporting
          ? 'Rendering, then importing…'
          : postizUrl
            ? 'Import to Postiz again'
            : 'Import to Postiz'}
      </Button>
      {isImporting && (
        <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
          Cutting the clip again, then filing it in Postiz. This keeps going if you leave the page.
        </p>
      )}
      {postizUrl && !isImporting && (
        // What Postiz says now, not what this app did once. A clip whose draft
        // went out an hour ago said "waiting in Postiz" forever until the sync
        // existed, and a live post is exactly the thing a second import would
        // duplicate.
        <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
          {postizState === 'published'
            ? 'Published from Postiz'
            : postizState === 'scheduled'
              ? 'Scheduled in Postiz'
              : postizState === 'error'
                ? 'Postiz could not send this'
                : 'Waiting in Postiz'}
          {': '}
          <a href={postizUrl} target="_blank" rel="noreferrer">
            {postizUrl}
          </a>
        </p>
      )}
      {postizUrl && !isImporting && postizChannels.length > 0 && (
        // Every channel the clip went to, not only the ones that are out. A
        // list of the published ones alone silently loses the others: a clip
        // filed to two accounts and published on one showed a single name, and
        // nothing said the second account existed, let alone what it was doing.
        <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
          {postizChannels.map((channel) => (
            <li key={channel.id} style={{ overflowWrap: 'anywhere' }}>
              {channel.url ? (
                // Out, so the post itself is where anyone wants to be sent.
                <a href={channel.url} target="_blank" rel="noreferrer">
                  {channel.name || channel.platform || channel.id}
                </a>
              ) : (
                channel.name || channel.platform || channel.id
              )}
              {' — '}
              {channel.state === 'published'
                ? 'published'
                : channel.state === 'error'
                  ? 'failed to send'
                  : channel.state === 'queue' || channel.state === 'scheduled'
                    ? 'scheduled'
                    : 'waiting'}
            </li>
          ))}
        </ul>
      )}
      {/* Always available, whether or not there is a file yet: this is the one
          action that turns the settings on this page — captions, the title, the
          project's aspect ratio — into an actual clip. */}
      <Button
        variant="ghost"
        size="sm"
        style={rowStyle}
        onClick={handleRegenerate}
        // An upload or a Postiz import is cutting this same clip, into the
        // same file.
        disabled={isRendering || isUploading || isImporting}
      >
        {isRendering ? 'Rendering this clip…' : isRendered ? 'Regenerate clip' : 'Render this clip'}
      </Button>
      {isRendering && (
        // The encode outlives this page, so leaving is safe and worth saying:
        // a user who navigates away has not cancelled anything.
        <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
          Cutting and encoding the clip. This keeps going if you leave the page.
        </p>
      )}
      {/* Subtitles are not a button here any more: the Captions panel below
          styles them and the clipper burns them in. A disabled "Add Subtitles
          (not available yet)" next to working caption controls only reads as
          the feature being broken. */}
      <Button variant="ghost" size="sm" style={rowStyle} onClick={onEditOverlay}>
        {hasOverlay ? 'Edit overlay text' : 'Add overlay text'}
      </Button>
      {onTrim && (
        // Accent when the file has fallen behind the window, the same mark the
        // grid card puts on this, and the words say it too rather than leaving
        // a colour to carry it alone.
        <Button
          variant="ghost"
          size="sm"
          style={{
            ...rowStyle,
            ...(needsRecut ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : {}),
          }}
          onClick={onTrim}
        >
          {needsRecut ? 'Trim — moved since this was cut' : 'Trim start and end'}
        </Button>
      )}

      {/* Mounted whether or not there is anything to say. A live region added
          to the document at the same moment as its first content is one some
          screen readers never announce, because there was no region there to
          watch when the text arrived. */}
      <div aria-live="polite" aria-atomic="true">
        {actionResult && (
          <div
            // A failed publish is not a passing status: `alert` interrupts,
            // `status` waits for a gap that a user who has already navigated on
            // may never leave.
            role={actionResult.ok ? 'status' : 'alert'}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--space-sm)',
              padding: 'var(--space-sm)',
              border: `var(--border-width) solid ${actionResult.ok ? 'var(--success)' : 'var(--error)'}`,
              color: actionResult.ok ? 'var(--text)' : 'var(--error)',
              fontSize: '0.8rem',
              fontWeight: 900,
            }}
          >
            {/* A server message can be a sentence or a bare identifier, and it
                sits in a column as narrow as 180px on a phone. */}
            <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{actionResult.message}</span>
            <button
              type="button"
              onClick={() => setActionResult(null)}
              aria-label="Dismiss message"
              style={{
                flexShrink: 0,
                minWidth: '44px',
                minHeight: '44px',
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                fontWeight: 900,
              }}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Publishing is outward-facing and cannot be undone from this app, so it
          gets the same guard the project delete gets. The title is quoted back
          because it is written by an LLM step and is what viewers will see. */}
      <ConfirmationModal
        isOpen={isConfirming}
        title="Upload to YouTube"
        message={[
          clipTitle
            ? `Publish this clip to YouTube as "${clipTitle}"?`
            : 'Publish this clip to YouTube?',
          // Said before the click, because it is why the button takes minutes
          // and why the file on disk is about to be replaced.
          'The clip is cut again from its current settings first, so what goes up is what this page shows.',
          // Uploading twice does not replace the first video, and that is not
          // obvious from a button that simply works again.
          youtubeUrl
            ? 'This clip has already been published; uploading adds a second video rather than replacing it.'
            : '',
          'It goes to your channel straight away and cannot be taken down from here.',
        ].filter(Boolean).join(' ')}
        confirmText="UPLOAD"
        onConfirm={handleUpload}
        onCancel={() => setIsConfirming(false)}
      />
    </div>
  );
};

import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  getProjectMetadata,
  getClipCaptions,
  getClipDescription,
  getClipVideoUrl,
  getClipThumbnail,
  getSourceVideoUrl,
  getAspectRatioMap,
  getResolutionMap,
  syncPostiz,
  DEFAULT_OVERLAY_TEXT,
  type OverlayText,
  type ProjectMetadata,
} from '../../api';
import { ClipActions } from './ClipActions';
import { ClipPlayer } from './ClipPlayer';
import { CaptionOverlay } from './CaptionOverlay';
import { CaptionStyler } from './CaptionStyler';
import { TextOverlay } from './TextOverlay';
import { OverlayTextEditor } from './OverlayTextEditor';
import { OverlayStyler } from './OverlayStyler';
import { ThumbnailEditor } from './ThumbnailEditor';
import { ClipTrimmer } from './ClipTrimmer';
import { ThumbnailPreview } from './ThumbnailPreview';
import { StackLayoutContext, stackLayoutFor } from './StackedBands';
import type { CaptionPreviewSource } from './ClipCaptionSettings';
import { Button } from '../Button';
import { matchesOutputSettings, targetAspectRatio } from '../../utils/aspectRatio';

/**
 * A state this page cannot get itself out of.
 *
 * Announced, not merely drawn. The route is lazy, so by the time one of these
 * renders the Suspense fallback has already said "Loading…" out loud; without a
 * live region here a screen reader user is told the page is loading and then
 * never told how it turned out. Every one of them also carries a way back,
 * because the only other exit from this route is a breadcrumb.
 */
const DeadEnd: React.FC<{
  title: string;
  detail?: string;
  onRetry?: () => void;
  onBack: () => void;
}> = ({ title, detail, onRetry, onBack }) => (
  <div
    role="alert"
    style={{
      width: '100%',
      border: 'var(--border-width) solid var(--error)',
      padding: 'var(--space-md)',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-sm)',
      alignItems: 'flex-start',
    }}
  >
    <strong style={{ fontWeight: 900, textTransform: 'uppercase' }}>{title}</strong>
    {/* Not uppercased and free to break anywhere: this is a server message,
        which may be a full sentence, an identifier, or a URL. */}
    {detail && <span style={{ overflowWrap: 'anywhere' }}>{detail}</span>}
    <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
      {/* Retrying is the recommended way out, so it is the primary and the
          fallback is a ghost. Not every button is primary. */}
      {onRetry && (
        <Button variant="primary" onClick={onRetry} style={{ minHeight: '44px' }}>
          Try again
        </Button>
      )}
      <Button variant="ghost" onClick={onBack} style={{ minHeight: '44px' }}>
        Back to project
      </Button>
    </div>
  </div>
);

/**
 * A field label: the small uppercase caption above a piece of model output.
 *
 * DESIGN.md's label spec, in one place rather than retyped over each field —
 * these had drifted to `<strong>`'s bold where the project page uses 900.
 */
const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.65rem',
  fontWeight: 900,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  marginBottom: 'var(--space-sm)',
};

/** A flat region under a rule. The system's alternative to a nested card. */
const fieldStyle: React.CSSProperties = {
  borderTop: 'var(--border)',
  paddingTop: 'var(--space-sm)',
  minWidth: 0,
};

const bodyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '0.85rem',
  lineHeight: 1.4,
  overflowWrap: 'anywhere',
};

const sectionHeadingStyle: React.CSSProperties = { margin: 0, fontSize: '1.2rem' };

/** Absent model output, said the same way wherever it happens. */
const Missing: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ color: 'var(--text-muted)' }}>{children}</span>
);

/**
 * The page's own shape while it loads, rather than the word "Loading".
 *
 * Sized like what replaces it so the video does not shove the transcript down
 * the moment metadata arrives.
 */
const DetailSkeleton: React.FC = () => (
  <div style={{ width: '100%' }}>
    {/* One status node for the whole page. Marking each block would announce
        the skeleton four times. */}
    <p role="status" className="visually-hidden">
      Loading clip…
    </p>
    <div className="split-grid" aria-hidden="true">
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <div className="skeleton-block" style={{ width: '60%', height: '1.5rem' }} />
        <div className="skeleton-block" style={{ width: '100%', aspectRatio: '16 / 9', maxHeight: '320px' }} />
        <div className="skeleton-block" style={{ width: '100%', height: '4rem' }} />
      </div>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
        <div className="skeleton-block" style={{ width: '40%', height: '1.2rem' }} />
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="skeleton-block" style={{ width: '100%', height: '3rem' }} />
        ))}
      </div>
    </div>
  </div>
);

export const ClipDetail: React.FC = () => {
  const { id: projectId, clipIndex } = useParams<{ id: string; clipIndex: string }>();
  const navigate = useNavigate();
  const [isEditingOverlay, setIsEditingOverlay] = useState(false);
  const [isEditingThumbnail, setIsEditingThumbnail] = useState(false);
  const [isTrimming, setIsTrimming] = useState(false);
  // What the editor is typing, held here rather than in the dialog so the
  // player behind it redraws on every keystroke instead of waiting for the
  // saved value to come back from the backend.
  const [overlayDraft, setOverlayDraft] = useState<OverlayText | null>(null);

  const { data: projectMetadata, isLoading, error, refetch } = useQuery<ProjectMetadata>({
    queryKey: ['project', projectId],
    queryFn: () => getProjectMetadata(projectId!) as Promise<ProjectMetadata>,
    enabled: !!projectId,
  });

  const { data: aspectRatiosData } = useQuery({ queryKey: ['aspectRatios'], queryFn: getAspectRatioMap });
  const { data: resolutionsData } = useQuery({ queryKey: ['resolutions'], queryFn: getResolutionMap });

  // What Postiz has done with this project's posts since they were filed.
  //
  // Asked here as well as on the project page, because this is a route of its
  // own rather than a child of that one: opening a clip's URL directly — a
  // bookmark, a reload, a link — rendered whatever was last written, so a clip
  // published an hour ago went on saying it was waiting, and one whose post had
  // been deleted went on claiming to be filed.
  //
  // Same key as the project page's, so navigating from the grid reuses that
  // answer instead of asking again, and the sync's own writes land once.
  const hasPostizPosts = (projectMetadata?.highlights ?? []).some((h) => h.postiz_post_id);
  const { data: postizSync } = useQuery({
    queryKey: ['postizSync', projectId],
    queryFn: () => syncPostiz(projectId!),
    enabled: !!projectId && hasPostizPosts,
    staleTime: 5 * 60_000,
    retry: false,
  });

  React.useEffect(() => {
    // The sync writes what it learned onto the clips, so the copy this page is
    // drawing from is now the stale one.
    if (postizSync?.checked) {
      void refetch();
    }
  }, [postizSync, refetch]);

  // Base 10, and NaN for anything that is not a number at all. A hand-typed or
  // stale URL used to reach the captions request as `clip/NaN/captions` before
  // the not-found branch below ever rendered.
  const parsedIndex = parseInt(clipIndex ?? '', 10);
  const clipIndexNum = Number.isInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : -1;
  const backToProject = () => navigate(projectId ? `/project/${projectId}` : '/history');

  // Cues and style come from the backend rather than being derived here, so the
  // overlay and the burned render cannot drift apart.
  const { data: captions } = useQuery({
    queryKey: ['clipCaptions', projectId, clipIndexNum],
    queryFn: () => getClipCaptions(projectId!, clipIndexNum),
    enabled: !!projectId && clipIndexNum >= 0,
  });

  // The finished description, template and all, rendered by the backend. This
  // is the exact text an upload would carry, not an approximation of it.
  // Which frame this clip's thumbnail is, and what is written on it. The page
  // draws it rather than fetching a picture: none is made until the clip is
  // published, and a frame with text over it is what this page already draws.
  const { data: thumbnail } = useQuery({
    queryKey: ['clipThumbnail', projectId, clipIndexNum],
    queryFn: () => getClipThumbnail(projectId!, clipIndexNum),
    enabled: !!projectId && clipIndexNum >= 0,
  });

  const { data: description } = useQuery({
    queryKey: ['clipDescription', projectId, clipIndexNum],
    queryFn: () => getClipDescription(projectId!, clipIndexNum),
    enabled: !!projectId && clipIndexNum >= 0,
  });

  if (isLoading) return <DetailSkeleton />;

  if (error) {
    return (
      <DeadEnd
        title="Could not load this clip"
        detail={error instanceof Error ? error.message : 'Please try again.'}
        onRetry={() => void refetch()}
        onBack={backToProject}
      />
    );
  }

  if (!projectMetadata) {
    return <DeadEnd title="Project not found" detail="It may have been deleted." onBack={backToProject} />;
  }

  // The clip grid renders one card per highlight, rendered or not, so the route
  // index is a position in `highlights` directly.
  const highlight = clipIndexNum >= 0 ? (projectMetadata.highlights ?? [])[clipIndexNum] : undefined;

  if (!highlight) {
    return (
      <DeadEnd
        title="Clip not found"
        detail="This project has no highlight at that position. Re-running the highlights step can return fewer than it did before."
        onBack={backToProject}
      />
    );
  }

  const label = highlight.viral_hook_text || `CLIP ${clipIndexNum + 1}`;
  // Narrowed to the filename rather than to a boolean, so the branches below
  // carry a `string` instead of a `string | null | undefined` that only a
  // separate flag claims is present.
  const renderedFilename = highlight.is_clip_generated ? highlight.generated_clip_filename : null;
  const isRendered = !!renderedFilename;
  // The title as it stands: what is being typed, or what the clip resolves to
  // — its own if it has one, otherwise the project's — or the values a new one
  // starts from. Read from the caption preview rather than from the highlight,
  // because only the backend knows which of the two a locked clip inherits.
  const overlay = overlayDraft ?? captions?.overlay ?? DEFAULT_OVERLAY_TEXT;
  const hasTitle = !!overlay.text.trim();
  // Same rule as the captions: a title already in the file's pixels is not
  // drawn again on top of itself. While the editor is open it is drawn anyway,
  // because that is the only way to see what is being changed.
  const sourceUrl = projectMetadata.files?.original_file
    ? getSourceVideoUrl(projectMetadata.project_id, projectMetadata.files.original_file)
    : null;
  const aspectRatio = targetAspectRatio(projectMetadata.settings, aspectRatiosData, resolutionsData);
  // A trim moves the window and cuts nothing, so the file can be playing
  // footage the timecodes no longer describe. Both stamps are ISO, so the later
  // string is the later edit.
  const needsRecut =
    isRendered &&
    !!highlight.trimmed_at &&
    (!highlight.rendered_at || highlight.trimmed_at > highlight.rendered_at);
  // The project's aspect ratio or resolution can change after a clip is cut,
  // and nothing re-cuts it when they do. The player below is boxed to the
  // settings now in force, so the old file played inside it is a crop this
  // project will never render — the honest picture is the source window under
  // the new shape, which is what the next render will be cut from. A project
  // whose source has gone has no such window, so there the old cut stands.
  const outputStale = isRendered && !matchesOutputSettings(projectMetadata.settings, highlight);
  const playsRendered = !!renderedFilename && (!outputStale || !sourceUrl);
  // Drawn over the video unless the file already carries them, in which case
  // overlaying would double every word. A page back on the source preview is
  // not showing those pixels at all, so the words go back on top.
  const showOverlay = !!captions?.cues.length && (!playsRendered || !highlight.captions_burned);
  // Same rule as the captions: a title already in the file's pixels is not
  // drawn again on top of itself. While the editor is open it is drawn anyway,
  // because that is the only way to see what is being changed.
  const showTitle =
    hasTitle &&
    overlay.enabled &&
    (isEditingOverlay || !playsRendered || !highlight.overlay_burned);
  // The thumbnail dialog picks a frame, so it needs a player of its own: the
  // one on this page is behind the scrim and cannot be scrubbed through it.
  //
  // Pointed at the source rather than the cut file, because that is where the
  // frame is actually taken from — the thumbnail is one frame of the source
  // under the clipper's crop, and a cut file already carrying burned words
  // would show them twice over the dialog's own drawing. The rendered clip
  // only stands in when the source has gone.
  const thumbnailPreview: CaptionPreviewSource | null = sourceUrl
    ? {
        src: sourceUrl,
        start: highlight.start,
        end: highlight.end,
        isPreview: true,
        aspectRatio,
        label,
      }
    : renderedFilename
      ? {
          src: getClipVideoUrl(projectId!, renderedFilename, highlight.rendered_at),
          start: 0,
          end: null,
          isPreview: false,
          aspectRatio,
          label,
        }
      : null;
  // Project-wide, not per clip: whether a still clip shows its thumbnail or the
  // frame it is parked on is a decision about reviewing this project.
  const showThumbnailWhenIdle = (projectMetadata.settings?.clip_preview ?? 'thumbnail') === 'thumbnail';
  // The still is cut from the source, not from this clip's file, so a project
  // whose original video has gone cannot show one.
  const thumbnailWhileStill = showThumbnailWhenIdle && !!thumbnail && !!sourceUrl;

  const socialPosts = [
    { label: 'YouTube title', content: highlight.video_title_for_youtube_short },
    // Not a post, but written by the same step and read for the same reason:
    // it is what the still says, and the still is what anyone decides to click.
    // Shown with its asterisks in, because the marked word is the point.
    { label: 'Thumbnail text', content: highlight.thumbnail_text },
    { label: 'X post', content: highlight.video_description_for_x },
    { label: 'Reddit', content: highlight.video_description_for_reddit },
    { label: 'LinkedIn', content: highlight.video_description_for_linkedin },
  ];

  return (
    // The project's layout, for every player and still below that previews
    // from the source — dialogs included, which React reaches through portals.
    <StackLayoutContext.Provider value={stackLayoutFor(projectMetadata.settings)}>
    {/* Full width, not content width: <main> is a column flex container with
    // `align-items: flex-start`, which cancels the default stretch, so without
    // this the page was as wide as whatever the model happened to write.
    //
    // Flat and edge-to-edge rather than one big card. Wrapping the page in a
    // `.brutalist-card` put six bordered blocks inside a bordered block, which
    // is the one composition DESIGN.md rules out — and with 4px borders and no
    // radius it left every region weighted the same. The picture is now the
    // only framed object on the page; everything else is text under a rule. */}
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      <div className="split-grid">
        {/* min-width on both columns: a grid item's floor is its content, so
            one unbroken string — a URL in a hook, an unspaced CJK run — would
            otherwise widen the track and push the page into a sideways
            scroll. */}
        <section style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
          <h1
            style={{
              // Fluid, and decisively above the 1.2rem section headings. At the
              // previous flat 1.5rem the page had an h1 and an h2 that were
              // near enough the same size to read as one level.
              fontSize: 'clamp(1.75rem, 4vw, 2.5rem)',
              margin: 0,
              // Model output, so there is no promise of a break opportunity.
              overflowWrap: 'anywhere',
            }}
          >
            {label}
          </h1>
          {renderedFilename || sourceUrl ? (
            <div style={{ border: 'var(--border)' }}>
              {/* The same player before and after the render, so the page does
                  not change shape or swap its controls when the clipper
                  finishes. Before, it plays the highlight's window inside the
                  source; after, the cut file. Where the file was cut before
                  captions were on, they are drawn over it here until the
                  clipper is re-run. */}
              <ClipPlayer
                src={
                  playsRendered
                    // Versioned by when it was cut: a regenerated clip keeps
                    // its filename, so without this the browser replays the
                    // copy it already has and the re-cut looks like it did
                    // nothing.
                    ? getClipVideoUrl(projectId!, renderedFilename as string, highlight.rendered_at)
                    : (sourceUrl as string)
                }
                start={playsRendered ? 0 : highlight.start}
                end={playsRendered ? null : highlight.end}
                isPreview={!playsRendered}
                aspectRatio={aspectRatio}
                label={label}
                cues={captions?.cues}
                renderOverlay={
                  showOverlay || showTitle || thumbnailWhileStill
                    ? (position, isPlaying) => {
                        // Before anyone presses play, this page shows the
                        // thumbnail: its own frame of the source, with the text
                        // the burn would draw on it. Playing, or scrubbing
                        // anywhere, hands the picture back to the video. The
                        // overlay editor is the exception — it is placing the
                        // video's own title, and has to see the video.
                        if (
                          thumbnailWhileStill &&
                          !isEditingOverlay &&
                          !isPlaying &&
                          position < 0.05
                        ) {
                          return (
                            <ThumbnailPreview
                              src={sourceUrl as string}
                              sourceTime={highlight.start + thumbnail!.settings.frame_time}
                              aspectRatio={aspectRatio}
                              settings={thumbnail!.settings}
                              title={thumbnail!.title}
                              font={thumbnail!.title_font}
                              captions={captions}
                            />
                          );
                        }
                        return (
                          <>
                            {showOverlay && (
                              <CaptionOverlay
                                cues={captions!.cues}
                                style={captions!.style}
                                font={captions!.font}
                                time={position}
                              />
                            )}
                            {showTitle && (
                              <TextOverlay
                                overlay={overlay}
                                font={captions?.overlay_font}
                                time={position}
                                // A title fading in from zero is invisible at
                                // the exact moment a paused preview sits on, so
                                // while the editor is open it is simply shown.
                                forceVisible={isEditingOverlay}
                                // And once the editor is closed the player is
                                // still parked on that same frame: a stopped
                                // picture has no fade to show, so the title is
                                // drawn solid rather than at the zero opacity
                                // the ramp is at.
                                still={!isPlaying}
                              />
                            )}
                          </>
                        );
                      }
                    : undefined
                }
              />
            </div>
          ) : (
            // Dashed, which is how the app already draws a region waiting on a
            // pipeline step — see the empty clip grid. An empty panel should
            // also name the step that fills it.
            <div
              role="status"
              style={{
                padding: 'var(--space-xl)',
                border: 'var(--border-width) dashed var(--border-color)',
                textAlign: 'center',
                fontSize: '0.8rem',
              }}
            >
              No source video to preview from. Re-upload the video to this project to see this moment.
            </div>
          )}

          <section style={fieldStyle}>
            {/* Uppercased by the stylesheet, so the source stays sentence case
                and the string is translatable. */}
            <h2 style={{ ...sectionHeadingStyle, marginBottom: 'var(--space-sm)' }}>Transcript</h2>
            <p style={{ ...bodyStyle, fontSize: '0.9rem' }}>
              {highlight.highlight_text || (
                <Missing>No transcript for this moment. Run the Transcribe step to fill it in.</Missing>
              )}
            </p>
          </section>
        </section>

        <section style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
          <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <h2 style={sectionHeadingStyle}>Social posts</h2>
            {/* Flat columns under a rule, the same treatment the project page
                gives these. */}
            <div className="social-grid">
              {socialPosts.map((item) => (
                <div key={item.label} style={fieldStyle}>
                  <span style={fieldLabelStyle}>{item.label}</span>
                  <p style={bodyStyle}>
                    {/* The copy is written by a later pipeline step, so a
                        project that has only found its highlights has none of
                        it. Four boxes containing nothing but their own labels
                        read as the feature being broken. */}
                    {item.content || <Missing>Not written yet. Run the Highlights step.</Missing>}
                  </p>
                </div>
              ))}
            </div>
            {/* Full width under the grid of short posts: this one is many lines
                long, and it is the text that actually gets published. */}
            <div style={fieldStyle}>
              <span style={fieldLabelStyle}>YouTube description</span>
              {/* The template's own line breaks are part of the description. */}
              <p style={{ ...bodyStyle, whiteSpace: 'pre-wrap' }}>
                {description?.description || (
                  <Missing>
                    Nothing to describe this clip with yet. Run the Highlights step, or add the
                    original video and your own text under Description on the project page.
                  </Missing>
                )}
              </p>
            </div>
          </section>

          <ClipActions
            projectId={projectId!}
            clipIndex={clipIndexNum}
            clipTitle={highlight.video_title_for_youtube_short || label}
            isRendered={isRendered}
            youtubeUrl={highlight.youtube_url}
            youtubeVideoId={highlight.youtube_video_id}
            youtubePrivacy={highlight.youtube_privacy}
            youtubePublishAt={highlight.youtube_publish_at}
            uploadedAt={highlight.uploaded_at}
            renderedAt={highlight.rendered_at}
            postizUrl={highlight.postiz_url}
            postizImportedAt={highlight.postiz_imported_at}
            postizState={highlight.postiz_state}
            postizChannels={highlight.postiz_channels}
            hasOverlay={hasTitle}
            onEditOverlay={() => setIsEditingOverlay(true)}
            onEditThumbnail={() => setIsEditingThumbnail(true)}
            onTrim={() => setIsTrimming(true)}
            needsRecut={needsRecut}
          />

          <OverlayTextEditor
            projectId={projectId!}
            clipIndex={clipIndexNum}
            isOpen={isEditingOverlay}
            // The draft is dropped with the dialog: everything typed into it has
            // already been sent, and holding it would show it again over a clip
            // whose stored title has since changed.
            onClose={() => {
              setIsEditingOverlay(false);
              setOverlayDraft(null);
            }}
            value={overlay}
            onChange={setOverlayDraft}
            isBurned={!!highlight.overlay_burned}
            isLocked={captions?.overlay_locked ?? false}
          />
          <ThumbnailEditor
            projectId={projectId!}
            clipIndex={clipIndexNum}
            isOpen={isEditingThumbnail}
            onClose={() => setIsEditingThumbnail(false)}
            // Its own picture to scrub: the player on this page is behind the
            // dialog's scrim, and picking a frame means moving the playhead.
            preview={thumbnailPreview}
            captions={captions}
          />
          <ClipTrimmer
            projectId={projectId!}
            clipIndex={clipIndexNum}
            isOpen={isTrimming}
            onClose={() => setIsTrimming(false)}
            start={highlight.start}
            end={highlight.end}
            // Its own picture, like the thumbnail dialog: the player on this
            // page is behind the scrim, and trimming means watching the edges.
            // Always the source — the window is a position in it, and a cut
            // file has nothing outside itself to trim back into.
            sourceUrl={sourceUrl}
            aspectRatio={aspectRatio}
            label={label}
            isRendered={isRendered}
            // No re-cut passed: this page's own Regenerate button owns that job
            // and reports it, so the dialog points at it rather than starting a
            // second one it could not report on.
          />
          {isRendered && hasTitle && overlay.enabled && !highlight.overlay_burned && (
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              This title is not in the rendered file yet. Regenerate the clip to burn it in.
            </p>
          )}

          <section style={{ display: 'flex', flexDirection: 'column' }}>
            {/* No heading above this one: the panel button is itself labelled
                "Captions", and a heading of the same word directly above it is
                the same word twice. */}
            <CaptionStyler
              projectId={projectId!}
              settings={projectMetadata.settings?.captions}
              style={captions?.style}
            />
            <div style={{ marginTop: 'var(--space-md)' }}>
              <OverlayStyler
                projectId={projectId!}
                overlay={projectMetadata.settings?.overlay}
              />
            </div>
            {isRendered && (
              <p style={{ margin: 'var(--space-sm) 0 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                This clip is already rendered. Re-run the clipper to apply caption changes to the file.
              </p>
            )}
          </section>
        </section>
      </div>
    </div>
    </StackLayoutContext.Provider>
  );
};

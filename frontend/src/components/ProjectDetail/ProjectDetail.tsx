import React, { useId } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PipelineActivity, PipelineController } from '../PipelineController/PipelineController';
import type { StepStatus } from '../PipelineController/PipelineController';
import { ClipManager } from '../ClipManagement/ClipManager';
import {
  getResolutionMap,
  getAspectRatioMap,
  getExecutionStatus,
  getSourceVideoUrl,
  syncPostiz,
  type ClipPreview,
  type Highlight,
  type ProjectMetadata,
  type StepActivity,
} from '../../api';
import { matchesOutputSettings, targetAspectRatio } from '../../utils/aspectRatio';
import { useClipSelection } from '../../hooks/useClipSelection';
import { displayScore } from '../../utils/jevSelection';
import { stepLabel } from '../../utils/stepLabels';
import { StackLayoutContext, stackLayoutFor } from '../ClipManagement/StackedBands';

/**
 * How far into the clips a run has got.
 *
 * Accent, not muted grey: this is the pipeline running, which is what accent
 * means in the step row above it. It is also the only line on the page that
 * changes by itself, and it used to be the same colour as the labels that do
 * not.
 */
const ProgressLine: React.FC<{ progress: { generated: number; total: number } }> = ({ progress }) => (
  <p
    role="status"
    aria-live="polite"
    style={{ margin: 'var(--space-sm) 0 0 0', fontSize: '0.8rem', color: 'var(--text-accent)', fontWeight: 700 }}
  >
    Rendered {progress.generated} of {progress.total} clips
  </p>
);

interface ProjectDetailProps {
  metadata: ProjectMetadata;
  pipelineConfig: {
    execution_order: string[];
    steps?: Record<string, { auto_run?: boolean; llm?: boolean; depends_on?: string[] }>;
  };
  activeProcesses: string[];
  onExecuteAction: (action: 'START' | 'STOP', step: string) => void;
  onDeleteClip: (index: number) => void;
}

export const ProjectDetail: React.FC<ProjectDetailProps> = ({ metadata, pipelineConfig, activeProcesses, onExecuteAction, onDeleteClip }) => {
  const pipelineHeadingId = useId();
  const clipsHeadingId = useId();

  const { data: resolutionsData } = useQuery({
    queryKey: ['resolutions'],
    queryFn: getResolutionMap,
  });

  const { data: aspectRatiosData } = useQuery({
    queryKey: ['aspectRatios'],
    queryFn: getAspectRatioMap,
  });

  // Only poll while this project actually has a process running. Previously
  // this refetched every 2s for as long as the page was open.
  const isActive = activeProcesses.some((processId) => processId.startsWith(`${metadata.project_id}_`));
  const isClipperRunning = activeProcesses.includes(`${metadata.project_id}_clipper`);

  const { data: allStatuses } = useQuery({
    queryKey: ['executionStatus', metadata.project_id],
    queryFn: () => getExecutionStatus(metadata.project_id),
    refetchInterval: isActive ? 1000 : (false as const),
  });

  // The metadata itself is already polled by App while the project is active;
  // a second query on its own key just doubled the requests and let the two
  // copies drift apart mid-run.
  const displayMetadata = metadata;

  // What Postiz has done with the drafts this project filed. Nothing tells this
  // application when one is sent, so a clip that went out an hour ago reads as
  // "waiting in Postiz" until Postiz is asked — and asking is also what records
  // the answer.
  //
  // Only for a project that has something in Postiz, and not on every remount:
  // the answer changes on Postiz's side, not here.
  const queryClient = useQueryClient();
  const hasPostizPosts = (metadata.highlights ?? []).some((h) => h.postiz_post_id);
  const { data: postizSync } = useQuery({
    queryKey: ['postizSync', metadata.project_id],
    queryFn: () => syncPostiz(metadata.project_id),
    enabled: hasPostizPosts,
    staleTime: 5 * 60_000,
    retry: false,
  });

  React.useEffect(() => {
    // The sync writes what it learned onto the clips, so the project on screen
    // is now the stale copy.
    if (postizSync?.checked) {
      queryClient.invalidateQueries({ queryKey: ['project', metadata.project_id] });
      queryClient.invalidateQueries({ queryKey: ['projectMetadata', metadata.project_id] });
    }
  }, [postizSync, metadata.project_id, queryClient]);

  // execution_status carries a `progress` object alongside the per-step
  // strings, which is the only per-clip feedback available during a run.
  const clipProgress = allStatuses?.progress as unknown as
    | { generated: number; total: number }
    | undefined;

  // Same shape of cast: what each running step is doing, and the backend's own
  // clock to measure it against.
  const activity = allStatuses?.activity as unknown as
    | Record<string, StepActivity>
    | undefined;
  const serverNow = allStatuses?.now as unknown as number | undefined;
  // And why the failed steps failed, which unlike `activity` survives the step
  // ending — it is written on the project rather than held for the run.
  const stepErrors = allStatuses?.step_errors as unknown as
    | Record<string, string>
    | undefined;

  const sourceUrl = displayMetadata.files?.original_file
    ? getSourceVideoUrl(displayMetadata.project_id, displayMetadata.files.original_file)
    : null;

  // Clips are previewed from the source before anything is cut, so the preview
  // has to box itself to whatever these two settings resolve to.
  const previewAspectRatio = targetAspectRatio(displayMetadata.settings, aspectRatiosData, resolutionsData);

  const highlightCount = displayMetadata.highlights?.length ?? 0;
  const hasHighlights = highlightCount > 0;

  // What a clip shows while it sits still, for every clip in this project: its
  // thumbnail, or the video frame under it. Read from the project rather than
  // held here — the control that changes it is in the header now, and this
  // follows the saved value.
  const currentClipPreview: ClipPreview =
    metadata.settings?.clip_preview === 'video' ? 'video' : 'thumbnail';

  // Every highlight is a card from the moment the highlights step finishes;
  // the clipper only swaps a preview for a rendered file.
  //
  // Memoised because this page polls twice a second while a step runs. Rebuilt
  // inline, the array and every object in it were new identities on each tick,
  // which defeated any memo on the cards downstream.
  const clips = React.useMemo(
    () =>
      (displayMetadata.highlights ?? []).map((h: Highlight, index: number) => ({
        index,
        filename: h.generated_clip_filename ?? null,
        isRendered: !!h.is_clip_generated,
        // Whether the file already carries captions decides whether the card
        // draws them over it or leaves them to the pixels.
        captionsBurned: !!h.captions_burned,
        // Same for the overlay title, which is burned on its own schedule: a
        // clip cut before it was written carries the words and not the title.
        overlayBurned: !!h.overlay_burned,
        // A re-cut clip keeps its filename, so the card needs this to stop
        // playing the copy the browser already has.
        renderedAt: h.rendered_at ?? null,
        // A trim moves the window without touching the file, so the card needs
        // both stamps to say whether the cut still matches its own timecodes.
        trimmedAt: h.trimmed_at ?? null,
        // Changing the project's aspect ratio re-shapes the preview and re-cuts
        // nothing, so a card whose file was made for the old shape has to go
        // back to previewing from the source rather than present the old crop
        // as the finished clip.
        outputStale: !matchesOutputSettings(displayMetadata.settings, h),
        // A published clip is not republished by accident: the card says it is
        // live, and its upload button asks before adding a second video.
        youtubeUrl: h.youtube_url ?? null,
        youtubeVideoId: h.youtube_video_id ?? null,
        // What a finished upload job is judged against: it leaves
        // /active_processes whether or not it published anything.
        uploadedAt: h.uploaded_at ?? null,
        // The draft waiting in Postiz, and what a finished import job is judged
        // against — it leaves /active_processes whether or not it filed one.
        postizUrl: h.postiz_url ?? null,
        postizImportedAt: h.postiz_imported_at ?? null,
        // What the sync last heard. The card offers to import again either way,
        // but a clip that is already out is a duplicate rather than a fix.
        postizState: h.postiz_state ?? null,
        jevScores: h.jev_scores ?? null,
        original_start: h.start,
        original_end: h.end,
        // The card is named by what the clip would be published as; the hook is
        // what it falls back to before the video meta step has run.
        title: h.video_title_for_youtube_short,
        hook: h.viral_hook_text,
        // Defaulted, not passed through: `highlight_text` is absent until the
        // highlights step has written it, and the card's type promises a
        // string. `any` on this map hid the mismatch.
        text: h.highlight_text ?? '',
      })),
    // The output settings are read per clip here, so a change to them has to
    // rebuild this list — that is the whole point of `outputStale`.
    [displayMetadata.highlights, displayMetadata.settings]
  );

  // Scored highlights split into the project's clips and the lower-scoring
  // rest, which go behind "show more". The header's clips menu moves the line.
  // Both lists run from the highest score down.
  const { selected } = useClipSelection(displayMetadata);
  const { mainClips, belowClips } = React.useMemo(() => {
    if (!selected) return { mainClips: clips, belowClips: [] };
    const byScore = (a: (typeof clips)[number], b: (typeof clips)[number]) =>
      (displayScore(b.jevScores) ?? 0) - (displayScore(a.jevScores) ?? 0);
    return {
      mainClips: clips.filter((c) => selected.has(c.index)).sort(byScore),
      belowClips: clips.filter((c) => !selected.has(c.index)).sort(byScore),
    };
  }, [clips, selected]);

  // Memoised for the same reason `clips` is: this page rebuilds twice a second
  // while a step runs, and an array rebuilt inline is a new prop identity on
  // every tick — which is a `React.memo` on the pipeline row that can never
  // hold. The status strings are what actually change during a run, and they
  // change perhaps four times over a whole pipeline.
  //
  // Keyed on the statuses themselves rather than on the object that carries
  // them: `execution_status` also carries the per-clip `progress` counter,
  // which ticks on every single poll, so depending on the query object would
  // rebuild this list forty times for a run in which the statuses changed
  // three times.
  const statusKey = (pipelineConfig?.execution_order || [])
    .map((stepName) => {
      const status = allStatuses?.[stepName] ?? 'locked';
      // The reason a step failed is part of what this list draws, so a run
      // that fails differently the second time has to rebuild it.
      return `${status}:${stepErrors?.[stepName] ?? ''}`;
    })
    .join('|');

  const steps = React.useMemo(
    () =>
      (pipelineConfig?.execution_order || []).map((stepName: string) => ({
        name: stepName,
        label: stepLabel(stepName),
        status: (allStatuses?.[stepName] as StepStatus) || 'locked',
        isLlm: pipelineConfig?.steps?.[stepName]?.llm === true,
        // A locked step can now say what is blocking it instead of just that it
        // is blocked. The config already carries this; nothing read it before.
        dependsOn: (pipelineConfig?.steps?.[stepName]?.depends_on ?? []).map(stepLabel),
        // Why it stopped, for a step that says. Read from the project rather
        // than from the transient activity notes: those are dropped when the
        // step ends, which is exactly when the reason starts mattering.
        error: stepErrors?.[stepName],
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statusKey is
    // exactly the part of allStatuses this reads; see above.
    [pipelineConfig, statusKey]
  );

  return (
    <div className="project-detail">
      {/* The title is not painted, because it is already on the page.
          ------------------------------------------------------------------
          The breadcrumb directly above renders HOME / PROJECTS / <name>, in
          accent, bold, carrying `aria-current="page"`. The h1 under it printed
          the same filename again, larger, thirty pixels lower — two lines of
          heading plus a facts line, some sixty pixels of page, to say a thing
          the page had already said.

          It stays as a heading because the document needs one and a screen
          reader navigates by it; it just stops being drawn twice. The facts it
          used to sit above move into the row of triggers below, which was
          already there and already had the room. */}
      <h1 className="visually-hidden">{displayMetadata.name}</h1>

      {/* Two shapes, one page.
          ------------------------------------------------------------------
          A project with nothing in it is not the same page as a project with
          forty clips in it, and it used to be laid out as though it were.

          With no highlights there is nothing to review, so the pipeline is the
          page and it leads at full size.

          Once there are clips the pipeline has done its job. It runs once —
          and then it is a tool you reach for on the rare occasion you re-cut
          something, which is exactly what the settings beside it are. So it
          folds into the same row and takes no height at all until it is asked
          for, or until it has something to say. Shrinking it was not enough:
          a strip is still a permanent band across a page about clips. */}
      {!hasHighlights && (
        <section aria-labelledby={pipelineHeadingId}>
          <h2 id={pipelineHeadingId} className="visually-hidden">Pipeline</h2>
          <PipelineController onExecute={onExecuteAction} steps={steps} prominence="lead" />
          <PipelineActivity steps={steps} activity={activity} now={serverNow} />
        </section>
      )}

      {/* What the page is for. The source video used to sit beside all of this
          in a sticky 400px column — the one video on the page nobody needs to
          watch, holding the fold against the clips cut out of it. The grid
          still previews from the source; it just no longer plays it twice. */}
      <section aria-labelledby={clipsHeadingId} className="project-clips">
        <h2 id={clipsHeadingId} className="visually-hidden">Clips</h2>
        {/* Counts clips, so it reads above the clips rather than inside a
            pipeline menu in the header. */}
        {/* Only while clips are actually being cut: other work running for the
            project (titles filling in, an upload) renders nothing. */}
        {isClipperRunning && clipProgress && clipProgress.total > 0 && <ProgressLine progress={clipProgress} />}
        <StackLayoutContext.Provider value={stackLayoutFor(displayMetadata.settings)}>
          <ClipManager
            projectId={displayMetadata.project_id}
            clips={mainClips}
            belowClips={belowClips}
            sourceUrl={sourceUrl}
            aspectRatio={previewAspectRatio}
            clipPreview={currentClipPreview}
            onDeleteClip={onDeleteClip}
            isLoading={isClipperRunning}
          />
        </StackLayoutContext.Provider>
      </section>

    </div>
  );
};

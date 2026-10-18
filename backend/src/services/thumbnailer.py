"""Build the still picture that stands for a clip.

A thumbnail here is a frame of the clip with text drawn on it, produced by the
same pipeline the video is: the same crop, the same styles, the same font
files, burned by libass through ffmpeg. That is the point — a thumbnail made
some other way looks like a different video than the one it opens.

The defaults are what a user who does nothing gets: the first frame of the
clip, no subtitles, and the clip's title over it. Everything in
`ThumbnailSettings` is a departure from that.
"""

import logging
import shutil
import tempfile
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from backend.src.dataclasses.data import Highlight, OverlayText, Project, ThumbnailSettings
from backend.src.infrastructure.progress import report
from backend.src.infrastructure.video_engine import OpenCVVideoEngine
from backend.src.services import highlight_options
from backend.src.services.ass_writer import render_still_ass
from backend.src.services.captions import CaptionService

logger = logging.getLogger(__name__)


class SourceVideoMissingError(Exception):
    """There is no source video to take a frame out of."""


class Thumbnailer:
    """Renders and stores one thumbnail per clip."""

    # Beside clips/ rather than inside it: the clip directory is emptied every
    # time the clipper starts, and a thumbnail outlives a re-cut.
    DIRECTORY = "thumbnails"

    def __init__(self, caption_service: Optional[CaptionService] = None):
        self.captions = caption_service or CaptionService()

    def settings(self, highlight: Highlight) -> ThumbnailSettings:
        """This clip's thumbnail settings, or the defaults it has never left."""
        stored = getattr(highlight, "thumbnail", None)
        return stored if stored is not None else ThumbnailSettings()

    def title(self, project: Optional[Project], highlight: Highlight) -> Optional[OverlayText]:
        """The text drawn over the still, worked out rather than asked for.

        The clip's own title first, if it has one: a user who typed a line has
        said what it should say, and a thumbnail is not the place to argue.

        Failing that, `thumbnail_text` — the line the model wrote for this job
        specifically: a handful of words, one of them marked, meant to be read
        at the size a feed gives a still. Then the hook, which was written to be
        heard over a video that is already playing and only stands in here, and
        then the YouTube title. A thumbnail with no words on it is the one
        outcome worth avoiding.

        Whichever line wins, it is drawn in the project's overlay configuration
        — its font, size, placement and colours. That is what makes the project
        setting worth having: a project's stills look like one project without
        anybody typing a title on any of them. Only the words are decided here.

        The stored title is used even when it is switched off for the video.
        `enabled` there answers "burn this into the clip"; whether the
        thumbnail carries text is `show_overlay`'s question, and a user who
        wrote a line and chose not to burn it still wrote the line.
        """
        stored = self.captions.overlay_settings(project, highlight)
        if stored is not None and stored.text.strip():
            return stored

        text = (
            getattr(highlight, "thumbnail_text", "")
            or highlight.viral_hook_text
            or highlight.video_title_for_youtube_short
            or ""
        ).strip()
        if not text:
            return None
        # The project's look with the model's words in it. Built by replacing
        # the text rather than by constructing a fresh OverlayText: a default
        # one ignored every choice made on the project, so a restyled project
        # kept drawing its automatic titles in the factory colours.
        base = stored if stored is not None else OverlayText()
        return replace(base, enabled=True, text=text[:200])

    def overlays(self, project: Optional[Project], highlight: Highlight,
                 settings: ThumbnailSettings) -> List[OverlayText]:
        """Everything with words in it, bottom layer first."""
        drawn: List[OverlayText] = []
        if settings.show_overlay:
            title = self.title(project, highlight)
            if title is not None:
                drawn.append(title)
        # The extra line is the user's alone and has no `enabled` to consult:
        # it exists on the thumbnail because they added it there.
        if settings.extra is not None and settings.extra.text.strip():
            drawn.append(settings.extra)
        return drawn

    def frame_time(self, highlight: Highlight, settings: ThumbnailSettings) -> float:
        """The chosen moment, clamped inside the clip.

        A frame asked for past the end of the clip would come back as whatever
        the source happens to show there — the next speaker, the next scene —
        which is not a frame of this clip at all.
        """
        duration = max(0.0, float(highlight.end) - float(highlight.start))
        if duration <= 0:
            return 0.0
        # Backed off the very end, where seeking lands past the last frame.
        return max(0.0, min(settings.frame_time, max(0.0, duration - 0.05)))

    def directory(self, project: Project) -> Path:
        return Path(project.base_directory) / project.project_id / self.DIRECTORY

    def path(self, project: Project, highlight: Highlight) -> Optional[Path]:
        """Where this clip's rendered thumbnail is, or None if there is none."""
        settings = self.settings(highlight)
        if not settings.generated_filename:
            return None
        return self.directory(project) / settings.generated_filename

    def _write_ass(self, project: Project, highlight: Highlight, settings: ThumbnailSettings,
                   index: int, width: int, height: int, at: float) -> Optional[str]:
        """Writes the frozen subtitle script for one still, or nothing to draw.

        Written to a temporary file, not into the project: this is scratch for
        one ffmpeg run and nothing reads it afterwards. The clip's own `.ass`
        is a different thing — that one is the burn, and it is offered as a
        download for use in an editor.

        A caption failure costs the text, not the picture: a thumbnail of the
        frame alone is still a thumbnail, so this degrades rather than raising.
        """
        overlays = self.overlays(project, highlight, settings)
        cues: List[Any] = []
        if settings.show_captions:
            try:
                cues = self.captions.cues(project, highlight)
            except Exception as e:
                logger.error(f"Could not build thumbnail captions for clip {index}: {e}")

        if not overlays and not cues:
            return None

        try:
            style = self.captions.style(project, highlight)
            handle = tempfile.NamedTemporaryFile(
                mode="w", suffix=".ass", prefix=f"openclip_thumb_{index:03d}_",
                encoding="utf-8", delete=False,
            )
            with handle as scratch:
                scratch.write(render_still_ass(cues, style, width, height, overlays, at))
        except Exception as e:
            logger.error(f"Could not write thumbnail overlay for clip {index}: {e}")
            return None
        # Absolute: it is going into an ffmpeg filter argument, which is
        # resolved against the working directory of the encode, not this one.
        return str(Path(handle.name).resolve())

    def generate(self, project: Project, index: int, engine: Optional[Any] = None) -> ThumbnailSettings:
        """Renders this clip's thumbnail and records it on the highlight.

        Raises IndexError when there is no highlight at `index`, and
        SourceVideoMissingError when the video it would be cut from is gone.
        """
        if index < 0 or index >= len(project.highlights):
            raise IndexError(f"No highlight at index {index}")

        highlight = project.highlights[index]
        input_path = Path(project.get_artifact_path("original_file"))
        if not input_path.exists():
            raise SourceVideoMissingError(
                "The source video for this project is missing, so no frame can be taken from it."
            )

        settings = self.settings(highlight)
        engine = engine or OpenCVVideoEngine("root/yolov8n.pt")
        width, height = engine.resolve_output_dimensions(
            str(input_path), project.settings.aspect_ratio, project.settings.resolution
        )

        at = self.frame_time(highlight, settings)
        subtitle_path = self._write_ass(project, highlight, settings, index, width, height, at)

        filename = f"clip_{index:03d}.jpg"
        output_path = self.directory(project) / filename
        output_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            engine.extract_frame(
                str(input_path),
                str(output_path.resolve()),
                float(highlight.start) + at,
                project.settings.aspect_ratio,
                project.settings.resolution,
                subtitle_path=subtitle_path,
                # Framed on the start of the clip, which is where the clip
                # itself is cropped: a thumbnail centred on a different moment
                # would show a different part of the frame than the video it
                # belongs to.
                framing_timestamp=float(highlight.start),
                layout=project.settings.layout,
                stack_darkness=project.settings.stack_darkness,
                split_position=project.settings.split_position,
                split_swap=project.settings.split_swap,
                split_divider=project.settings.split_divider,
            )
        finally:
            # The script has done its one job. Kept even on failure would mean a
            # temp file per attempt, none of which anything reads again.
            if subtitle_path:
                Path(subtitle_path).unlink(missing_ok=True)
            # An earlier version wrote this beside the picture, where it was
            # never anything but litter in the user's project.
            (self.directory(project) / f"clip_{index:03d}.ass").unlink(missing_ok=True)

        settings.generated_filename = filename
        settings.generated_at = datetime.now().isoformat()
        highlight.thumbnail = settings
        project.set_property("highlights", project.highlights)
        logger.info(f"Wrote thumbnail for clip {index} at {at}s into the clip")
        return settings

    # --- The step -----------------------------------------------------------

    STEP = "thumbnails"

    def has_thumbnail(self, project: Project, highlight: Highlight) -> bool:
        """Whether this clip's still is on disk right now.

        Both halves, the way the clipper asks it of a cut: the metadata alone
        lies after a thumbnails directory is deleted from under the project,
        and a file alone says nothing about which clip it belongs to.
        """
        path = self.path(project, highlight)
        return path is not None and path.exists()

    def reset_metadata(self, project: Project) -> None:
        """Throws away every rendered still, keeping what was asked of them.

        The settings are the user's — the frame they picked, the extra line
        they wrote — and survive. Only the render is dropped, because that is
        the thing this step makes.
        """
        directory = self.directory(project)
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir(parents=True, exist_ok=True)

        for highlight in project.highlights:
            settings = getattr(highlight, "thumbnail", None)
            if settings is None:
                continue
            settings.generated_filename = None
            settings.generated_at = None

        project.set_property("highlights", project.highlights)
        project.set_step_status(self.STEP, "pending")

    def start_service(self, project: Project, full: bool = True) -> None:
        if full:
            self.reset_metadata(project)
        project.set_step_status(self.STEP, "running")

    def end_service(self, project: Project) -> None:
        project.set_step_status(self.STEP, "completed")

    def execute(self, project: Project, full: bool = False,
                engine: Optional[Any] = None) -> List[Dict[str, Any]]:
        """Redraws the still for every clip in the project.

        Every one of them, every time — unlike the clipper, which resumes. A
        still is one frame rather than a minute of encoding, and the reason to
        press this is that the pictures on disk were drawn in an older look:
        skipping the ones that exist would skip exactly the clips the run is
        for. Each is redrawn from the settings that clip already carries, so a
        picture made in the editor comes back as itself.

        `full` additionally empties the directory first, which is what takes
        the stills of highlights that no longer exist off the disk.

        Nothing here reaches YouTube. The pictures are for the user to attach
        in Studio, and for the cards and clip pages to show.
        """
        logger.info(
            f"Thumbnailer executing for project={project.project_id}, "
            f"clip_count={len(project.highlights)}, full={full}"
        )
        self.start_service(project, full=full)
        try:
            # One engine for the whole run: each one loads a detection model,
            # and doing that per clip is most of the time a batch would take.
            engine = engine or OpenCVVideoEngine("root/yolov8n.pt")

            # Only the project's clips, not the moments below a Jev cutoff.
            selected = sorted(highlight_options.selected_indices(project))
            total = len(selected)
            failures: List[str] = []
            # Indexes, not the highlights themselves: every render writes back
            # onto its highlight, which replaces the list.
            for number, index in enumerate(selected, 1):
                report(f"Drawing thumbnail {number} of {total}")
                try:
                    self.generate(project, index, engine=engine)
                except Exception as e:
                    # One still that will not draw must not cost the ones after
                    # it, and the step reports itself as partly done rather than
                    # failing whole.
                    message = str(e) or e.__class__.__name__
                    logger.warning(
                        f"Skipping the thumbnail for clip {index} of {project.project_id}: {message}"
                    )
                    failures.append(message)

            self._settle(project, failures)
            logger.info(
                f"Thumbnailer finished for project={project.project_id}: "
                f"{total - len(failures)} drawn, {len(failures)} failed"
            )
            return [h.to_dict() for h in project.highlights]
        except Exception as e:
            # Everything outside the per-clip loop: no source video, no engine,
            # nothing that drawing one more still would have fixed.
            logger.error(f"Error executing the thumbnails step: {e}")
            project.fail_step(self.STEP, str(e) or e.__class__.__name__)
            return []

    def _settle(self, project: Project, failures: List[str]) -> None:
        """Records how many clips actually have a picture.

        Judged on the files, not on this run's tally: a resume that drew
        nothing because everything was there is a finished step, and a run that
        drew nine of ten is not, however well the nine went.
        """
        selected = highlight_options.selected_indices(project)
        missing = [
            index
            for index, highlight in enumerate(project.highlights)
            if index in selected and not self.has_thumbnail(project, highlight)
        ]
        if not missing:
            self.end_service(project)
            return
        if len(missing) == len(selected):
            project.fail_step(
                self.STEP,
                f"No thumbnail could be drawn. The first failure was: {failures[0]}"
                if failures
                else "No thumbnail was drawn.",
            )
            return
        reason = f" The first failure was: {failures[0]}" if failures else ""
        project.partial_step(
            self.STEP,
            f"{len(missing)} of {len(selected)} clips have no thumbnail."
            f"{reason} Run this step again to try them again.",
        )

    def preview(self, project: Project, highlight: Highlight) -> Dict[str, Any]:
        """What the browser needs to draw this thumbnail before it is rendered.

        The automatic title travels with it, because the page cannot work out
        for itself which of the model's fields would have been used.
        """
        settings = self.settings(highlight)
        title = self.title(project, highlight)
        return {
            "settings": settings.to_dict(),
            # Named `title` rather than `overlay`: this is the resolved text,
            # which may have come from the clip's title or from the model.
            "title": title.to_dict() if title is not None else None,
            "title_font": (
                self.captions.font({
                    "font_family": title.font_family,
                    "bold": title.bold,
                    "italic": title.italic,
                })
                if title is not None
                else None
            ),
            "duration": max(0.0, float(highlight.end) - float(highlight.start)),
        }

import os
import shutil
import logging
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Callable, List, Dict, Any, Optional, Tuple
from backend.src.dataclasses.data import Highlight, Project, Clip
from backend.src.infrastructure.progress import report
from backend.src.infrastructure.video_engine import OpenCVVideoEngine
from backend.src.services.captions import CaptionService

logger = logging.getLogger(__name__)

class Clipper:
    def __init__(self, caption_service: CaptionService = None,
                 on_clip_rendered: Optional[Callable[[Project, int], None]] = None):
        self.captions = caption_service or CaptionService()
        self.on_clip_rendered = on_clip_rendered

    def reset_metadata(self, project: Project) -> None:
        """Clears the clips/ directory and resets clip state."""
        clips_dir = os.path.join(project.base_directory, project.project_id, project.clip_base_directory)
        if os.path.exists(clips_dir):
            shutil.rmtree(clips_dir)
        os.makedirs(clips_dir, exist_ok=True)
        
        # Reset highlight states
        for h in project.highlights:
            h.is_clip_generated = False
            h.generated_clip_filename = None
        
        # Field-scoped rather than a full save: metadata/chapters can still be
        # running, and a whole-file write from this snapshot would undo them.
        project.set_property("highlights", project.highlights)
        project.set_step_status("clipper", "pending")

    def start_service(self, project: Project, full: bool = True) -> None:
        """Initializes the service and resets metadata.

        `full` throws away everything the last run produced. A resume does not:
        the clips already on disk are the whole point of resuming, and wiping
        the directory to re-cut two missing files out of twenty is the bug this
        parameter exists to avoid.
        """
        if full:
            self.reset_metadata(project)
        project.set_step_status("clipper", "running")

    def has_clip(self, project: Project, highlight: Highlight) -> bool:
        """Whether this highlight's cut is on disk right now.

        Both halves are needed. The metadata alone lies after a clips directory
        is deleted from under the project, and the file alone says nothing about
        which highlight it belongs to.
        """
        if not highlight.is_clip_generated or not highlight.generated_clip_filename:
            return False
        path = (
            Path(project.base_directory)
            / project.project_id
            / project.clip_base_directory
            / highlight.generated_clip_filename
        )
        return path.exists()

    def _write_captions(self, project: Project, highlight, clips_dir: str, clip_filename: str,
                        width: int, height: int) -> Optional[str]:
        """Writes the clip's .ass file next to it and returns its path.

        A caption failure must not cost the clip: the highlight is still worth
        cutting without captions, so this degrades to no subtitles rather than
        failing the step.
        """
        path = Path(clips_dir) / f"{Path(clip_filename).stem}.ass"
        try:
            written = self.captions.write_ass(project, highlight, path, width, height)
        except Exception as e:
            logger.error(f"Could not build captions for {clip_filename}: {e}")
            return None
        return os.path.abspath(str(written)) if written else None

    def _burns_anything(self, project: Project, highlight: Highlight) -> bool:
        """Whether this clip needs a subtitle file at all.

        Captions and the overlay title are independent reasons to write one, and
        a clip can want the title with captions switched off.
        """
        return (
            self.captions.is_enabled(project, highlight)
            or self.captions.overlay(project, highlight) is not None
        )

    def _render_highlight(self, project: Project, engine, input_path: str, clips_dir: str,
                          index: int, highlight: Highlight,
                          dimensions: Optional[Tuple[int, int]]) -> str:
        """Cuts one highlight and records what the file ended up carrying."""
        start = max(0.0, float(highlight.start))
        end = float(highlight.end)
        filename = f"clip_{index:03d}.mp4"
        output_path = os.path.abspath(os.path.join(clips_dir, filename))

        subtitle_path = None
        if self._burns_anything(project, highlight) and dimensions:
            subtitle_path = self._write_captions(
                project, highlight, clips_dir, filename, dimensions[0], dimensions[1]
            )

        logger.info(f"Clipper processing clip={index} ({filename}), range={start}-{end}")
        engine.process_clip(
            input_path,
            output_path,
            start,
            end,
            project.settings.aspect_ratio,
            project.settings.resolution,
            subtitle_path=subtitle_path,
            layout=project.settings.layout,
            stack_darkness=project.settings.stack_darkness,
        )

        highlight.is_clip_generated = True
        highlight.generated_clip_filename = filename
        # Recorded per clip rather than per project: captions can be
        # turned on between runs, so two clips in one project can
        # legitimately disagree.
        highlight.captions_burned = bool(subtitle_path) and self.captions.is_enabled(project, highlight)
        highlight.overlay_burned = bool(subtitle_path) and self.captions.overlay(project, highlight) is not None
        # The filename is the same on every render, so this is what tells a
        # browser holding the old file that there is a new one.
        highlight.rendered_at = datetime.now().isoformat()
        # What this file was shaped to. The project's aspect ratio and
        # resolution can be changed afterwards, and nothing re-cuts the clips
        # when they are, so this is how the page tells a file that still matches
        # the settings from one that only used to.
        highlight.rendered_aspect_ratio = project.settings.aspect_ratio
        highlight.rendered_resolution = project.settings.resolution
        highlight.rendered_layout = project.settings.layout
        project.set_property("highlights", project.highlights)
        return filename

    async def execute(self, project: Project, full: bool = False) -> List[Dict[str, Any]]:  # pragma: no cover
        """Executes clipping logic.

        `full` cuts every highlight from scratch, throwing the clips directory
        away first — what "run the whole pipeline" means. Left off, the run is a
        resume: highlights whose file is already on disk are left alone and only
        the ones still missing are cut. That is what makes pressing the step
        again after two clips failed finish the job in a minute rather than
        re-encoding the eighteen that were already fine.
        """
        logger.info(f"Clipper executing for project={project.project_id}, highlight_count={len(project.highlights)}")
        self.start_service(project, full=full)
        try:
            engine = OpenCVVideoEngine("root/yolov8n.pt")
            input_path = str(project.get_artifact_path("original_file"))
            clips_dir = os.path.join(os.path.dirname(input_path), "clips")
            os.makedirs(clips_dir, exist_ok=True)
            logger.info(f"Clipper clips_dir={clips_dir}, exists={os.path.exists(clips_dir)}")

            # A clip that has unlocked its captions can turn them on when the
            # project has them off, and off when the project has them on, so
            # the decision belongs to each clip rather than to the run.
            dimensions = None
            if any(self._burns_anything(project, short) for short in project.highlights):
                # Burned sizes are percentages of the output frame, so the
                # render size has to be resolved before any clip is written.
                dimensions = engine.resolve_output_dimensions(
                    input_path, project.settings.aspect_ratio, project.settings.resolution
                )

            total = len(project.highlights)
            skipped = 0
            failures: List[str] = []
            # Indexes, not the highlights themselves: each render is written
            # back onto its highlight, which reloads the list from disk.
            for i in range(total):
                short = project.highlights[i]
                if not full and self.has_clip(project, short):
                    skipped += 1
                    continue
                report(f"Cutting clip {i + 1} of {total}")
                try:
                    self._render_highlight(project, engine, input_path, clips_dir, i, short, dimensions)
                except Exception as e:
                    # One highlight that will not cut must not abandon the ones
                    # after it. The clips that do come out are worth having, and
                    # the step reports itself as partly done rather than failing
                    # whole — which is also what lets the next press pick up
                    # exactly the ones still missing.
                    message = str(e) or e.__class__.__name__
                    logger.warning(f"Skipping clip {i} for {project.project_id}: {message}")
                    failures.append(message)
                    continue
                self._announce_clip(project, i)

            if skipped:
                report(f"{skipped} clip(s) were already cut and were left alone")
            self._settle(project, failures)
            logger.info(
                f"Clipper finished for project={project.project_id}: "
                f"{total - skipped - len(failures)} cut, {skipped} already on disk, "
                f"{len(failures)} failed"
            )
            return [h.to_dict() for h in project.highlights]
        except Exception as e:
            # Everything outside the per-clip loop: no source video, no engine,
            # nothing that cutting one more highlight would have fixed.
            logger.error(f"Error executing clipper: {e}")
            project.fail_step("clipper", str(e) or e.__class__.__name__)
            return []

    def _settle(self, project: Project, failures: List[str]) -> None:
        """Records how much of the project actually has a clip.

        Judged on the files rather than on this run's tally: a resume that cut
        nothing because everything was already there is a completed step, and a
        run that cut nine of ten is not, however well the nine went.
        """
        missing = [
            index
            for index, highlight in enumerate(project.highlights)
            if not self.has_clip(project, highlight)
        ]
        if not missing:
            self.end_service(project)
            return
        if len(missing) == len(project.highlights):
            project.fail_step(
                "clipper",
                f"No clip could be cut. The first failure was: {failures[0]}"
                if failures
                else "No clip was cut.",
            )
            return
        reason = f" The first failure was: {failures[0]}" if failures else ""
        project.partial_step(
            "clipper",
            f"{len(missing)} of {len(project.highlights)} clips have no file yet."
            f"{reason} Run this step again to cut only those.",
        )

    def _announce_clip(self, project: Project, index: int) -> None:
        """Hands a finished clip to whoever asked to hear about it.
        """
        if self.on_clip_rendered is None:
            return
        try:
            self.on_clip_rendered(project, index)
        except Exception as e:
            logger.warning(f"Handler for clip {index} of {project.project_id} failed: {e}")

    def render_one(self, project: Project, index: int) -> Dict[str, Any]:
        """Re-cuts a single clip, leaving every other clip on disk alone.

        This is the clip page's "regenerate": a clip whose captions or title
        have changed needs the file rewritten, and re-running the whole step
        would throw away every other rendered clip to do it.

        Raises IndexError when there is no highlight at `index`.
        """
        if index < 0 or index >= len(project.highlights):
            raise IndexError(f"No highlight at index {index}")

        highlight = project.highlights[index]
        engine = OpenCVVideoEngine("root/yolov8n.pt")
        input_path = str(project.get_artifact_path("original_file"))
        if not os.path.exists(input_path):
            raise FileNotFoundError(
                "The source video for this project is missing, so the clip cannot be re-cut."
            )
        clips_dir = os.path.join(os.path.dirname(input_path), "clips")
        os.makedirs(clips_dir, exist_ok=True)

        dimensions = None
        if self._burns_anything(project, highlight):
            dimensions = engine.resolve_output_dimensions(
                input_path, project.settings.aspect_ratio, project.settings.resolution
            )

        self._render_highlight(project, engine, input_path, clips_dir, index, highlight, dimensions)

        # The step badge is about the project, not this clip: one clip being
        # re-cut only completes the step if it was the last one missing. A
        # failed render leaves the status alone rather than claiming an error
        # for clips that are still perfectly good.
        if all(self.has_clip(project, h) for h in project.highlights):
            project.set_step_status("clipper", "completed")
        return highlight.to_dict()

    def end_service(self, project: Project) -> None:
        """Finalizes the service."""
        project.set_step_status("clipper", "completed")

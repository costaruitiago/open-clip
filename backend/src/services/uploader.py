import logging
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Dict, Any, List, Optional, Tuple
from pathlib import Path
from backend.src.dataclasses.data import UPLOAD_PRIVACY_CHOICES, Highlight, Project
from backend.src.infrastructure.progress import report
from backend.src.infrastructure.youtube_client import YoutubeClient
from backend.src.services import highlight_options
from backend.src.services.clipper import Clipper
from backend.src.services.description_builder import build_description
from backend.src.services.schedule import day_window, slot_time

logger = logging.getLogger(__name__)


# What an upload makes when nobody has said otherwise. Private, because it is
# the only one of the four that cannot reach an audience by accident, and
# because it is what every upload did before there was a choice.
DEFAULT_PRIVACY = "private"

# The hours a day's scheduled clips are spread between. Nine to nine, like the
# Postiz window and for the same reason: dividing a day evenly lands posts in
# the small hours, and nobody schedules a short for four in the morning.
DEFAULT_DAY_START_HOUR = 9
DEFAULT_DAY_END_HOUR = 21

# How far ahead of now the earliest slot may be. A publish time in the past is
# refused by YouTube, and the upload it belongs to is minutes of encoding away
# from being sent, so "now" is never the answer even when the user asks for it.
SCHEDULE_LEAD_MINUTES = 15


class ClipNotRenderedError(Exception):
    """The cut this upload was supposed to publish did not produce a file.

    Not the same as a render that fell over — that arrives as whatever the
    engine raised. This is the render reporting success while leaving the
    highlight with no filename on it, which there is nothing to publish from.
    """


class ClipFileMissingError(Exception):
    """The metadata says this clip was rendered, but the file is not on disk."""


class UploadInProgressError(Exception):
    """This clip is already being published by another request."""


class Uploader:
    def __init__(self, client_factory: Optional[Callable[[], YoutubeClient]] = None,
                 clipper: Optional[Clipper] = None,
                 settings_reader: Optional[Callable[[str, Any], Any]] = None,
                 now: Optional[Callable[[], datetime]] = None):
        # Held because publishing a clip means producing the file first, not
        # finding one somebody else left behind.
        self.clipper = clipper or Clipper()
        self.client_factory = client_factory or YoutubeClient
        self._settings_reader = settings_reader
        # Local time, with its offset attached: the hours a user picks are the
        # hours on their own clock, and YouTube is told the same instant in UTC.
        # Injectable because a schedule is a function of "now", and a test that
        # cannot say when now is can only assert that something is in the future.
        self._now = now or (lambda: datetime.now().astimezone())

    # --- What an upload makes ------------------------------------------------

    def _setting(self, key: str, default: Any = None) -> Any:
        """One application-wide setting, which is the default for every project."""
        if self._settings_reader is not None:
            return self._settings_reader(key, default)
        from backend.src.settings_manager import settings_manager

        value = settings_manager.get(key, default)
        return default if value is None else value

    @staticmethod
    def _project_upload(project: Optional[Project]):
        """This project's own upload settings, or None.

        Defensive about the attribute rather than the value: a project written
        before these settings existed still loads and `ProjectSettings` fills
        them in, but a test double standing in for a project need not.
        """
        settings = getattr(project, "settings", None)
        return getattr(settings, "upload", None)

    def privacy(self, project: Optional[Project] = None) -> str:
        """What this project's uploads are on YouTube: the four the user picks from.

        The project's answer, then the application's, then private. "schedule"
        is returned as itself rather than resolved here — `publish_at` is what
        turns it into private-plus-a-time, and the page wants the word.
        """
        own = self._project_upload(project)
        if own is not None and own.privacy in UPLOAD_PRIVACY_CHOICES:
            return str(own.privacy)
        value = self._setting("youtube_privacy", DEFAULT_PRIVACY)
        return str(value) if value in UPLOAD_PRIVACY_CHOICES else DEFAULT_PRIVACY

    def _schedule_number(self, project: Optional[Project], attribute: str, key: str,
                         default: int) -> int:
        """One number of the schedule: the project's, the application's, or the default."""
        own = self._project_upload(project)
        value = getattr(own, attribute, None) if own is not None else None
        if value is None:
            value = self._setting(key, default)
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    def per_day(self, project: Optional[Project] = None) -> int:
        """How many of this project's clips are published per day.

        0 is all of them at the same moment — everything at nine on Friday,
        which is a schedule somebody may well want — and is the default,
        because it is what an upload did before it could be spread at all.
        """
        return max(0, self._schedule_number(project, "per_day", "youtube_schedule_per_day", 0))

    def _day_window(self, project: Optional[Project] = None) -> Tuple[int, int]:
        """The hours of the day this project's clips are published between."""
        return day_window(
            self._schedule_number(
                project, "day_start_hour", "youtube_schedule_day_start_hour", DEFAULT_DAY_START_HOUR
            ),
            self._schedule_number(
                project, "day_end_hour", "youtube_schedule_day_end_hour", DEFAULT_DAY_END_HOUR
            ),
        )

    def _start_date(self, project: Optional[Project] = None) -> Optional[date]:
        """The day this project's schedule begins, if a day was named."""
        own = self._project_upload(project)
        value = getattr(own, "start_date", None) if own is not None else None
        if not value:
            value = self._setting("youtube_schedule_start_date", "")
        try:
            return date.fromisoformat(str(value)) if value else None
        except ValueError:
            # A date nobody can parse is not a date. Falling back to "as soon
            # as the upload is done" beats refusing to publish over it.
            logger.warning(f"Ignoring an unreadable upload schedule start date: {value!r}")
            return None

    def _schedule_start(self, project: Optional[Project] = None) -> datetime:
        """The earliest moment this project's schedule may place a clip.

        The named day at the first hour of the window, or now plus the lead if
        no day was named — and never earlier than that lead, because YouTube
        refuses a publish time in the past and a date chosen last week is one.
        """
        now = self._now()
        earliest = now + timedelta(minutes=SCHEDULE_LEAD_MINUTES)
        start_date = self._start_date(project)
        if start_date is None:
            return earliest
        first_hour, _ = self._day_window(project)
        named = now.replace(
            year=start_date.year, month=start_date.month, day=start_date.day,
            hour=first_hour, minute=0, second=0, microsecond=0,
        )
        return max(named, earliest)

    def publish_at(self, project: Optional[Project], index: int) -> Optional[str]:
        """When YouTube turns this clip public, as YouTube wants it told.

        None unless the project is on a schedule, because that is the only
        state the field means anything in: a video that goes up public has
        nothing left to publish.

        Keyed on the clip's own position rather than on the order the uploads
        happened in, so the same clip lands on the same slot whether the whole
        project went up at once or one card's button was pressed twice.
        Re-publishing a clip moves nothing.
        """
        if self.privacy(project) != "schedule":
            return None
        first_hour, last_hour = self._day_window(project)
        when = slot_time(
            self._schedule_start(project), index, self.per_day(project), first_hour, last_hour
        )
        return (
            when.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        )

    def reset_metadata(self, project: Project) -> None:
        """Clears upload-related artifacts and updates project state."""
        project.set_property("uploads", [])
        project.set_step_status("upload", "pending")

    def start_service(self, project: Project, full: bool = True) -> None:
        """Initializes the service.

        `full` forgets the list of what the last run published. A resume must
        not: the videos it names are still on YouTube, and the run about to
        happen is only going to add the clips missing from it.
        """
        if full:
            self.reset_metadata(project)
        project.set_step_status("upload", "running")

    def end_service(self, project: Project) -> None:
        """Finalizes the service."""
        project.set_step_status("upload", "completed")

    @staticmethod
    def is_published(highlight: Highlight) -> bool:
        """Whether this clip already has a video on YouTube.

        The stored id is taken at its word here. Whether the video is still
        there is `verify_publication`'s question, and it costs an API call per
        clip — worth it when a clip is opened, not worth it before every one of
        twenty uploads.
        """
        return bool(highlight.youtube_video_id)

    def clip_path(self, project: Project, highlight: Highlight) -> Path:
        return Path(project.base_directory) / project.project_id / "clips" / highlight.generated_clip_filename

    def open_client(self) -> YoutubeClient:
        """Opens the handle an upload will go through.

        Called before anything is cut, so a missing or expired authorisation is
        reported as itself and at once, rather than after minutes of encoding
        spent on an upload that was never going to happen.
        """
        return self.client_factory()

    def begin_attempt(self, project: Project, index: int) -> None:
        """Clears the last failure, because this attempt is about to replace it."""
        self._set_upload_error(project, index, None)

    def record_failure(self, project: Project, index: int, message: str) -> None:
        """Stores why this attempt produced no video.

        The publish runs in the background, so the response to the click is a
        job key rather than an outcome. This is where the outcome goes.
        """
        logger.warning(f"Upload of clip {index} in {project.project_id} failed: {message}")
        self._set_upload_error(project, index, message)

    def _set_upload_error(self, project: Project, index: int, message: Optional[str]) -> None:
        highlights = project.highlights
        if index >= len(highlights):
            return
        if highlights[index].upload_error == message:
            return
        highlights[index].upload_error = message
        project.set_property("highlights", highlights)

    def _record_upload(self, project: Project, index: int, result: Dict[str, Any]) -> None:
        """Writes the published video back onto the highlight it came from.

        Stored so the clip page can say a clip is already live and link to it —
        publishing is the one action here that cannot be undone from this app,
        and a second click on a button that looks untouched is how it happens
        twice.
        """
        highlights = project.highlights
        if index >= len(highlights):
            return
        highlights[index].youtube_video_id = result.get("video_id")
        highlights[index].youtube_url = result.get("url")
        highlights[index].uploaded_at = datetime.now().isoformat()
        # What it went up as, and when it turns public. Stored rather than
        # re-derived from the settings, because the settings can change
        # afterwards and the video on YouTube cannot.
        highlights[index].youtube_privacy = result.get("privacy")
        highlights[index].youtube_publish_at = result.get("publish_at")
        # Whatever the previous attempt failed with is no longer true of this
        # clip, and a live video sitting next to an error message reads as one.
        highlights[index].upload_error = None
        project.set_property("highlights", highlights)

    def upload_one(
        self,
        project: Project,
        index: int,
        client: Optional[YoutubeClient] = None,
    ) -> Dict[str, Any]:
        """Cuts a single clip afresh, publishes it, and returns its id and URL.

        The cut is not conditional on there being no file: the clip the user
        approved is the one drawn from the settings as they stand now — its
        captions, its overlay title, the project's aspect ratio — and a file cut
        before the last of those changes is a different clip. Re-cutting is what
        makes the video on YouTube the video that was on the page.

        Raises IndexError for a position with no highlight, whatever the render
        raised when it could not produce a file, and ClipFileMissingError when
        the file it reported writing is not there.
        """
        # Checked before anything expensive happens, so a position with no
        # highlight is refused rather than rendered.
        if index < 0 or index >= len(project.highlights):
            raise IndexError(f"No highlight at index {index}")

        # Before the render, not after: an authorisation that cannot upload is
        # worth knowing about now rather than at the end of an encode.
        client = client or self.client_factory()

        self.clipper.render_one(project, index)
        # Re-read: the render writes the filename and the timestamp onto the
        # highlight, and the copy taken above predates both.
        highlight = project.highlights[index]

        if not highlight.is_clip_generated or not highlight.generated_clip_filename:
            raise ClipNotRenderedError(
                "The render finished without producing a file for this clip. "
                "The backend log has what ffmpeg reported."
            )

        path = self.clip_path(project, highlight)
        if not path.exists():
            raise ClipFileMissingError(
                f"The file this render reported writing is not there ({path})."
            )

        # The title is the one written for YouTube; the hook is the overlay
        # burned into the frame and only stands in when there is no title.
        title = highlight.video_title_for_youtube_short or highlight.viral_hook_text
        # Built from the template rather than from a single model field, so the
        # link back to the full episode and the user's standing text travel with
        # every upload.
        description = build_description(project, highlight)

        # A scheduled upload is a private one with a time on it; the other
        # three are what they say. Worked out here rather than in the client so
        # what was decided can be written back onto the clip.
        privacy = self.privacy(project)
        scheduled_for = self.publish_at(project, index)
        privacy_status = "private" if scheduled_for else privacy

        logger.info(f"Uploader uploading clip={highlight.generated_clip_filename} to YouTube")
        logger.info(
            f"Uploading with title: '{title}', privacy={privacy}"
            + (f", publishing at {scheduled_for}" if scheduled_for else "")
        )
        result = client.upload_video(
            file_path=str(path),
            title=title,
            description=description,
            privacy_status=privacy_status,
            publish_at=scheduled_for,
        )
        result["privacy"] = privacy
        result["publish_at"] = scheduled_for
        logger.info(
            f"Uploader uploaded clip={highlight.generated_clip_filename}, "
            f"video_id={result.get('video_id')}"
        )
        self._record_upload(project, index, result)
        return result

    def verify_publication(
        self, project: Project, index: int, client: Optional[YoutubeClient] = None
    ) -> Optional[bool]:
        """Whether this clip's published video is still on YouTube.

        Nothing tells this application when a video it published is deleted, so
        the record outlives the video: the clip page goes on offering a dead
        link. This is the only way to find out, and it is asked lazily — when a
        clip is opened.

        A video that has gone takes its record with it: the id, the url and the
        upload timestamp are cleared, so the clip reads as unpublished
        everywhere and can be published again as though for the first time.

        Returns True if it is there, False if it is gone or was never
        published, and None when the question could not be asked — no read
        scope, no network, a quota refusal. None leaves the record alone: not
        being able to check is not evidence of anything.
        """
        highlight = project.highlights[index]
        if not highlight.youtube_video_id:
            return False

        client = client or self.open_client()
        exists = client.video_exists(highlight.youtube_video_id)
        if exists is None:
            return None
        if exists:
            return True

        logger.info(
            f"Clip {index} of {project.project_id} points at {highlight.youtube_video_id}, "
            "which is no longer on YouTube; clearing the record"
        )
        self._clear_publication(project, index)
        return False

    def _clear_publication(self, project: Project, index: int) -> None:
        """Forgets everything this application knew about a published video."""
        highlights = project.highlights
        highlight = highlights[index]
        highlight.youtube_video_id = None
        highlight.youtube_url = None
        highlight.uploaded_at = None
        highlight.youtube_privacy = None
        highlight.youtube_publish_at = None
        highlight.upload_error = None
        project.set_property("highlights", highlights)

    def replace_one(self, project: Project, index: int, client: YoutubeClient) -> Dict[str, Any]:
        """Publishes this clip afresh and deletes the video it had before.

        New first, old second: an upload that fails leaves the old video up
        rather than leaving the clip with no video at all. A delete that fails
        leaves both up, and the clip says so — the new one is live, so this is
        not a failed upload, but the old one has to come down by hand.
        """
        old_id = project.highlights[index].youtube_video_id
        result = self.upload_one(project, index, client=client)
        if old_id and old_id != result.get("video_id"):
            try:
                client.delete_video(old_id)
                logger.info(f"Replaced {old_id} with {result.get('video_id')} for clip {index}")
            except Exception as e:
                self._set_upload_error(
                    project, index,
                    f"The new cut is live, but the old video ({old_id}) could not be deleted: "
                    f"{str(e) or e.__class__.__name__}. Delete it in YouTube Studio.",
                )
        return result

    async def execute(self, project: Project, full: bool = False,
                      replace: bool = False) -> List[Dict[str, Any]]:  # pragma: no cover
        """Publishes the project's clips to YouTube, as a pipeline step.

        `full` publishes every highlight, including the ones already live —
        what "run the whole pipeline from the start" asks for. Left off, the run
        is a resume: a clip that already has a video is left alone and only the
        ones still unpublished go up, so pressing the step again after three of
        twenty failed publishes three clips rather than seventeen duplicates.

        `replace` is the user choosing to regenerate: every clip is re-cut and
        published, and a clip that already had a video has that video deleted
        once the new one is up.
        """
        logger.info(f"Uploader executing for project={project.project_id}, highlight_count={len(project.highlights)}")
        self.start_service(project, full=full)
        # One client for the whole run: building it is an OAuth refresh, and
        # doing that per clip is both slower and one more thing to fail halfway.
        # Through the factory rather than `YoutubeClient()` directly, so this
        # loop can be driven in a test without an OAuth token.
        client = self.open_client()

        # Refused before anything is cut or published: without the delete
        # permission every replacement would be a duplicate.
        if replace and any(self.is_published(h) for h in project.highlights) and not client.can_delete():
            project.fail_step(
                "upload",
                "Replacing a clip's YouTube video needs permission to delete videos, which this "
                "channel's authorisation does not have. Open Settings and connect the channel "
                "again, then press Upload and choose Regenerate.",
            )
            return []

        uploads_list = []
        failures: List[str] = []
        skipped = 0
        # Every one of the project's clips, cut or not: each one is re-cut on
        # its way up, so this step no longer needs the clipper to have run
        # first — it only needs the source video and the highlights. Moments
        # below a Jev cutoff are not the project's clips and are never
        # published by this step; each can still be published from its card.
        selected = sorted(highlight_options.selected_indices(project))
        total = len(selected)
        #
        # Indexes, not the highlights themselves: each upload is written back
        # onto its highlight, which reloads the list from disk.
        for number, index in enumerate(selected, 1):
            if not (full or replace) and self.is_published(project.highlights[index]):
                # Already on YouTube. Publishing it again does not replace that
                # video, it makes a second one — and nothing in this app can
                # take either of them down.
                skipped += 1
                continue
            report(f"Clip {number} of {total}: cutting, then publishing")
            try:
                if replace:
                    uploads_list.append(self.replace_one(project, index, client))
                else:
                    uploads_list.append(self.upload_one(project, index, client=client))
            except Exception as e:
                # One clip that will not cut or will not publish must not
                # abandon the clips after it; the step is judged on how many of
                # them ended up live, and the clip carries its own reason.
                message = str(e) or e.__class__.__name__
                logger.warning(f"Skipping clip {index} for {project.project_id}: {message}")
                self.record_failure(project, index, message)
                failures.append(message)

        if skipped:
            report(f"{skipped} clip(s) were already on YouTube and were left alone")
        self._settle(project, failures)
        logger.info(
            f"Uploader finished for project={project.project_id}: "
            f"{len(uploads_list)} published, {skipped} already live, {len(failures)} failed"
        )
        return uploads_list

    def _settle(self, project: Project, failures: List[str]) -> None:
        """Records how much of the project is actually on YouTube.

        Judged on the highlights rather than on this run's tally, so a resume
        that published the last two missing clips completes the step, and a run
        that published nine of ten does not.
        """
        selected = highlight_options.selected_indices(project)
        missing = [
            h for i, h in enumerate(project.highlights) if i in selected and not self.is_published(h)
        ]
        if not missing:
            self.end_service(project)
            return
        if len(missing) == len(selected):
            project.fail_step(
                "upload",
                f"No clip could be published. The first failure was: {failures[0]}"
                if failures
                else "No clip was published.",
            )
            return
        reason = f" The first failure was: {failures[0]}" if failures else ""
        project.partial_step(
            "upload",
            f"{len(missing)} of {len(selected)} clips are not on YouTube yet."
            f"{reason} Run this step again to publish only those.",
        )

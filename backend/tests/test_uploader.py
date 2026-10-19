"""Cover for publishing one clip: what it refuses, what it sends, what it records."""

import json
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from backend.src.dataclasses.data import Project
from backend.src.orchestrator import ClipRegenerationInProgressError, PipelineOrchestrator
from backend.src.settings_manager import settings_manager
from backend.src.services.uploader import (
    ClipFileMissingError,
    ClipNotRenderedError,
    UploadInProgressError,
    Uploader,
)

PIPELINE_CONFIG = Path(__file__).resolve().parents[1] / "config" / "pipeline.json"

PROJECT_ID = "test-project"


class FakeClipper:
    """Stands in for the cut every upload now begins with.

    Writes the file the uploader is about to send and records the highlight it
    was asked for, so a test can say whether the clip was cut afresh rather than
    picked up off disk.
    """

    def __init__(self, project_dir: Path, error: Exception = None, writes: bool = True):
        self.calls = []
        self.error = error
        self.writes = writes
        self.project_dir = project_dir

    def render_one(self, project, index):
        self.calls.append(index)
        if self.error:
            raise self.error
        if not self.writes:
            return {}
        filename = f"clip_{index:03d}.mp4"
        write_clip(self.project_dir, filename, b"the cut this upload made")
        highlights = project.highlights
        highlights[index].is_clip_generated = True
        highlights[index].generated_clip_filename = filename
        highlights[index].rendered_at = datetime.now().isoformat()
        project.set_property("highlights", highlights)
        return highlights[index].to_dict()


def uploader(project_dir: Path, **overrides) -> Uploader:
    """An uploader whose cut is a fake, which is every test that publishes."""
    options = {"clipper": FakeClipper(project_dir)}
    options.update(overrides)
    return Uploader(**options)


class FakeYoutube:
    """Stands in for the API handle. Records what it was asked to publish."""

    def __init__(self):
        self.calls = []
        # What `video_exists` answers. None is "could not ask" — no read scope,
        # no network, a quota refusal — which is not the same as a "no".
        self.exists = True
        self.exists_calls = []
        self.started = threading.Event()
        self.release = threading.Event()
        self.block = False

    def upload_video(self, file_path, title, description, privacy_status="private", publish_at=None):
        self.calls.append({
            "file_path": file_path,
            "title": title,
            "description": description,
            "privacy_status": privacy_status,
            "publish_at": publish_at,
        })
        if self.block:
            self.started.set()
            self.release.wait(timeout=5)
        return {"video_id": "vid-1", "url": "https://youtube.com/watch?v=vid-1"}

    def video_exists(self, video_id):
        self.exists_calls.append(video_id)
        return self.exists

    # Whether the token could delete, and what was deleted with it.
    deletable = True
    delete_error = None

    def can_delete(self):
        return self.deletable

    def delete_video(self, video_id):
        if self.delete_error:
            raise self.delete_error
        self.deleted = getattr(self, "deleted", []) + [video_id]


def highlight(**overrides):
    data = {
        "highlight_text": "the quote",
        "viral_hook_text": "the hook",
        "video_title_for_youtube_short": "The Title",
        "video_description_for_youtube_short": "what the short is about",
        "video_description_for_x": "",
        "video_description_for_reddit": "",
        "video_description_for_linkedin": "",
        "start": 0,
        "end": 30,
        "is_clip_generated": True,
        "generated_clip_filename": "clip_000.mp4",
    }
    data.update(overrides)
    return data


def write_project(root: Path, highlights, description=None, upload=None):
    project_dir = root / "projects" / PROJECT_ID
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "metadata.json").write_text(json.dumps({
        "project_id": PROJECT_ID,
        "name": "Test Project",
        "created_at": datetime.now().isoformat(),
        "files": {},
        "highlights": highlights,
        "video_metadata": {"components": [], "top_recommendations": []},
        "settings": {
            "aspect_ratio": "9:16",
            "resolution": "1080p",
            "description": description or {},
            "upload": upload or {},
        },
        "status": None,
        "step_statuses": {},
    }))
    return project_dir


def write_clip(project_dir: Path, filename="clip_000.mp4", content=b"not really an mp4"):
    clips = project_dir / "clips"
    clips.mkdir(exist_ok=True)
    (clips / filename).write_bytes(content)


@pytest.fixture
def project_root(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


def read_metadata() -> dict:
    return json.loads((Path("projects") / PROJECT_ID / "metadata.json").read_text())


def test_a_clip_nobody_has_rendered_is_cut_and_then_published(project_root):
    # The clipper is not a step an upload waits for any more: a highlight the
    # user never rendered is cut on its way up.
    project_dir = write_project(
        project_root, [highlight(is_clip_generated=False, generated_clip_filename=None)]
    )
    clipper = FakeClipper(project_dir)
    client = FakeYoutube()

    result = uploader(project_dir, clipper=clipper).upload_one(Project(PROJECT_ID), 0, client=client)

    assert clipper.calls == [0]
    assert result["url"] == "https://youtube.com/watch?v=vid-1"
    assert client.calls[0]["file_path"].endswith("clips/clip_000.mp4")


def test_a_clip_that_already_has_a_file_is_cut_again_before_it_goes_up(project_root):
    # What the page shows is drawn from the settings as they stand now, so a
    # file cut before the last caption or title change is a different clip. The
    # upload is what makes the two the same.
    project_dir = write_project(project_root, [highlight()])
    write_clip(project_dir, content=b"the cut from before the last change")
    clipper = FakeClipper(project_dir)
    client = FakeYoutube()

    uploader(project_dir, clipper=clipper).upload_one(Project(PROJECT_ID), 0, client=client)

    assert clipper.calls == [0]
    assert (project_dir / "clips" / "clip_000.mp4").read_bytes() == b"the cut this upload made"


def test_a_render_that_produced_no_file_publishes_nothing(project_root):
    project_dir = write_project(project_root, [highlight()])  # metadata says rendered, no file
    client = FakeYoutube()

    with pytest.raises(ClipFileMissingError):
        uploader(project_dir, clipper=FakeClipper(project_dir, writes=False)).upload_one(
            Project(PROJECT_ID), 0, client=client
        )

    assert client.calls == []


def test_a_render_that_left_the_highlight_uncut_publishes_nothing(project_root):
    project_dir = write_project(
        project_root, [highlight(is_clip_generated=False, generated_clip_filename=None)]
    )
    client = FakeYoutube()

    with pytest.raises(ClipNotRenderedError):
        uploader(project_dir, clipper=FakeClipper(project_dir, writes=False)).upload_one(
            Project(PROJECT_ID), 0, client=client
        )

    assert client.calls == []


def test_a_render_that_fell_over_publishes_nothing(project_root):
    project_dir = write_project(project_root, [highlight()])
    write_clip(project_dir)  # the previous cut, which must not be published in its place
    client = FakeYoutube()
    failing = FakeClipper(project_dir, error=FileNotFoundError("The source video is missing."))

    with pytest.raises(FileNotFoundError):
        uploader(project_dir, clipper=failing).upload_one(Project(PROJECT_ID), 0, client=client)

    assert client.calls == []


def test_no_highlight_at_that_index_raises_index_error(project_root):
    project_dir = write_project(project_root, [highlight()])
    clipper = FakeClipper(project_dir)

    with pytest.raises(IndexError):
        uploader(project_dir, clipper=clipper).upload_one(Project(PROJECT_ID), 7, client=FakeYoutube())

    # Refused before the expensive part, not after it.
    assert clipper.calls == []


def test_upload_sends_the_youtube_title_and_the_built_description(project_root):
    project_dir = write_project(
        project_root,
        [highlight()],
        description={"source_title": "The Podcast", "source_url": "https://youtu.be/abc123"},
    )
    client = FakeYoutube()

    result = uploader(project_dir).upload_one(Project(PROJECT_ID), 0, client=client)

    assert result["url"] == "https://youtube.com/watch?v=vid-1"
    sent = client.calls[0]
    assert sent["title"] == "The Title"
    assert sent["file_path"].endswith("projects/test-project/clips/clip_000.mp4")
    # The description is the template's output, not one model field.
    assert sent["description"].startswith("what the short is about")
    assert "The Podcast" in sent["description"]
    assert "https://youtu.be/abc123" in sent["description"]


# Nothing tells this application when a video it published is deleted on
# YouTube. Without a check the record outlives the video, and the clip page
# goes on offering a dead link.


def test_a_video_deleted_on_youtube_takes_its_record_with_it(project_root):
    project_dir = write_project(
        project_root, [highlight(youtube_video_id="vid-1", youtube_url="https://youtu.be/vid-1")]
    )
    client = FakeYoutube()
    client.exists = False

    gone = uploader(project_dir).verify_publication(Project(PROJECT_ID), 0, client=client)

    assert gone is False
    stored = Project(PROJECT_ID).highlights[0]
    # The clip reads as unpublished everywhere now, and can be published again
    # as though for the first time.
    assert stored.youtube_video_id is None
    assert stored.youtube_url is None
    assert stored.uploaded_at is None


def test_a_video_that_is_still_there_is_left_alone(project_root):
    project_dir = write_project(
        project_root, [highlight(youtube_video_id="vid-1", youtube_url="https://youtu.be/vid-1")]
    )
    client = FakeYoutube()
    client.exists = True

    assert uploader(project_dir).verify_publication(Project(PROJECT_ID), 0, client=client) is True
    assert Project(PROJECT_ID).highlights[0].youtube_video_id == "vid-1"


def test_not_being_able_to_ask_is_not_a_no(project_root):
    # No read scope, no network, a quota refusal. Clearing a good record on the
    # strength of a question that could not be asked would lose the link to a
    # video that is still there.
    project_dir = write_project(
        project_root, [highlight(youtube_video_id="vid-1", youtube_url="https://youtu.be/vid-1")]
    )
    client = FakeYoutube()
    client.exists = None

    assert uploader(project_dir).verify_publication(Project(PROJECT_ID), 0, client=client) is None
    assert Project(PROJECT_ID).highlights[0].youtube_video_id == "vid-1"


def test_the_hook_is_the_title_only_when_no_youtube_title_was_written(project_root):
    project_dir = write_project(project_root, [highlight(video_title_for_youtube_short="")])
    client = FakeYoutube()

    uploader(project_dir).upload_one(Project(PROJECT_ID), 0, client=client)

    assert client.calls[0]["title"] == "the hook"


def test_the_published_video_is_recorded_on_the_highlight(project_root):
    project_dir = write_project(
        project_root,
        # Carrying the reason the last attempt gave up, which this one answers.
        [highlight(upload_error="YouTube would not take it.")],
    )

    uploader(project_dir).upload_one(Project(PROJECT_ID), 0, client=FakeYoutube())

    stored = read_metadata()["highlights"][0]
    assert stored["youtube_video_id"] == "vid-1"
    assert stored["youtube_url"] == "https://youtube.com/watch?v=vid-1"
    assert stored["uploaded_at"]
    # A live video sitting next to an error message reads as one.
    assert stored["upload_error"] is None
    # And it survives a reload, so the clip page can say the clip is live.
    assert Project(PROJECT_ID).highlights[0].youtube_url == "https://youtube.com/watch?v=vid-1"


def wait_for(predicate, timeout=5.0, interval=0.02):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


def publishing_orchestrator(project_dir, client, clipper=None) -> PipelineOrchestrator:
    """An orchestrator whose upload cuts a fake clip and talks to a fake YouTube."""
    service = uploader(
        project_dir,
        clipper=clipper or FakeClipper(project_dir),
        client_factory=lambda: client,
    )
    return PipelineOrchestrator(config_path=str(PIPELINE_CONFIG), services={"upload": service})


def test_orchestrator_publishes_through_the_upload_service(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakeYoutube()
    orchestrator = publishing_orchestrator(project_dir, client)

    job = orchestrator.upload_clip(PROJECT_ID, 0)

    # A key to watch, not an outcome: the cut this begins with outlives the
    # request that asked for it.
    assert job == f"{PROJECT_ID}_upload_clip_0"
    assert job in orchestrator.active_processes
    assert wait_for(lambda: not orchestrator.active_processes)
    # The outcome is on the highlight, which is where the page reads it.
    assert read_metadata()["highlights"][0]["youtube_url"] == "https://youtube.com/watch?v=vid-1"


def test_why_an_upload_published_nothing_is_written_onto_the_clip(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakeYoutube()
    orchestrator = publishing_orchestrator(
        project_dir,
        client,
        clipper=FakeClipper(project_dir, error=RuntimeError("The source video is missing.")),
    )

    orchestrator.upload_clip(PROJECT_ID, 0)

    assert wait_for(lambda: not orchestrator.active_processes)
    stored = read_metadata()["highlights"][0]
    assert stored["upload_error"] == "The source video is missing."
    assert stored["youtube_url"] is None
    assert client.calls == []


def test_an_authorisation_that_cannot_publish_is_refused_before_anything_is_cut(project_root):
    project_dir = write_project(project_root, [highlight()])
    clipper = FakeClipper(project_dir)
    service = uploader(
        project_dir,
        clipper=clipper,
        client_factory=lambda: (_ for _ in ()).throw(RuntimeError("No credentials.")),
    )
    orchestrator = PipelineOrchestrator(
        config_path=str(PIPELINE_CONFIG), services={"upload": service}
    )

    with pytest.raises(RuntimeError):
        orchestrator.upload_clip(PROJECT_ID, 0)

    assert clipper.calls == []
    # And the registration goes with it, so the next attempt is not refused as
    # a duplicate of one that never started.
    assert orchestrator.active_processes == {}


def test_a_second_request_for_the_same_clip_is_refused_while_one_is_running(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakeYoutube()
    client.block = True
    orchestrator = publishing_orchestrator(project_dir, client)

    orchestrator.upload_clip(PROJECT_ID, 0)
    assert client.started.wait(timeout=5)

    try:
        with pytest.raises(UploadInProgressError):
            orchestrator.upload_clip(PROJECT_ID, 0)
    finally:
        client.release.set()

    assert wait_for(lambda: not orchestrator.active_processes)
    # One upload, not two.
    assert len(client.calls) == 1


def test_a_clip_being_uploaded_cannot_be_re_cut_at_the_same_time(project_root):
    # The upload cuts the clip itself, into the file a re-cut would write.
    project_dir = write_project(project_root, [highlight()])
    client = FakeYoutube()
    client.block = True
    orchestrator = publishing_orchestrator(project_dir, client)

    orchestrator.upload_clip(PROJECT_ID, 0)
    assert client.started.wait(timeout=5)

    try:
        with pytest.raises(UploadInProgressError):
            orchestrator.regenerate_clip(PROJECT_ID, 0)
    finally:
        client.release.set()

    assert wait_for(lambda: not orchestrator.active_processes)


def test_a_clip_being_re_cut_cannot_be_uploaded_at_the_same_time(project_root):
    project_dir = write_project(project_root, [highlight()])
    orchestrator = publishing_orchestrator(project_dir, FakeYoutube())
    orchestrator.active_processes[f"{PROJECT_ID}_clip_0"] = time.time()

    with pytest.raises(ClipRegenerationInProgressError):
        orchestrator.upload_clip(PROJECT_ID, 0)


def test_no_highlight_at_that_index_is_refused_before_a_job_is_registered(project_root):
    project_dir = write_project(project_root, [highlight()])
    orchestrator = publishing_orchestrator(project_dir, FakeYoutube())

    with pytest.raises(IndexError):
        orchestrator.upload_clip(PROJECT_ID, 7)

    assert orchestrator.active_processes == {}


# --- The step across the whole project --------------------------------------

def run_step(service, full=False, replace=False):
    import asyncio

    return asyncio.run(service.execute(Project(PROJECT_ID), full=full, replace=replace))


def test_regenerating_replaces_every_clip_s_video(project_root):
    # The new cut goes up, then the old video comes down: one video per clip.
    project_dir = write_project(project_root, [
        highlight(youtube_video_id="vid-old", youtube_url="https://youtu.be/vid-old"),
        highlight(),
    ])
    client = FakeYoutube()

    assert len(run_step(uploader(project_dir, client_factory=lambda: client), replace=True)) == 2

    assert len(client.calls) == 2
    assert client.deleted == ["vid-old"]
    metadata = read_metadata()
    assert metadata["highlights"][0]["youtube_video_id"] == "vid-1"
    assert metadata["step_statuses"]["upload"] == "completed"


def test_regenerating_without_delete_permission_publishes_nothing(project_root):
    # Every replacement would be a duplicate, so nothing is cut or sent.
    project_dir = write_project(project_root, [
        highlight(youtube_video_id="vid-old", youtube_url="https://youtu.be/vid-old"),
    ])
    client = FakeYoutube()
    client.deletable = False

    assert run_step(uploader(project_dir, client_factory=lambda: client), replace=True) == []

    assert client.calls == []
    metadata = read_metadata()
    assert metadata["step_statuses"]["upload"] == "error"
    assert "connect the channel again" in metadata["step_errors"]["upload"]


def test_an_old_video_that_will_not_delete_is_reported_on_the_clip(project_root):
    project_dir = write_project(project_root, [
        highlight(youtube_video_id="vid-old", youtube_url="https://youtu.be/vid-old"),
    ])
    client = FakeYoutube()
    client.delete_error = RuntimeError("quota exceeded")

    run_step(uploader(project_dir, client_factory=lambda: client), replace=True)

    stored = read_metadata()["highlights"][0]
    # The new cut is live, so this is not a failed upload — but the old one
    # has to come down by hand, and the clip is where that is said.
    assert stored["youtube_video_id"] == "vid-1"
    assert "vid-old" in stored["upload_error"]
    assert "quota exceeded" in stored["upload_error"]


def test_a_second_press_publishes_only_the_clips_with_no_video(project_root):
    # A clip already on YouTube cannot be republished, only duplicated, and
    # nothing in this app can take either copy down.
    project_dir = write_project(project_root, [
        highlight(youtube_video_id="vid-old", youtube_url="https://youtu.be/vid-old"),
        highlight(),
    ])
    client = FakeYoutube()
    service = uploader(project_dir, client_factory=lambda: client)

    assert len(run_step(service)) == 1

    assert len(client.calls) == 1
    metadata = read_metadata()
    assert metadata["step_statuses"]["upload"] == "completed"
    assert metadata["highlights"][0]["youtube_video_id"] == "vid-old"


def test_a_full_run_publishes_every_clip(project_root):
    # What the whole-pipeline run asks for: start from nothing.
    project_dir = write_project(project_root, [
        highlight(youtube_video_id="vid-old", youtube_url="https://youtu.be/vid-old"),
        highlight(),
    ])
    client = FakeYoutube()

    assert len(run_step(uploader(project_dir, client_factory=lambda: client), full=True)) == 2
    assert len(client.calls) == 2


def test_a_run_that_publishes_some_of_the_clips_is_partial(project_root):
    project_dir = write_project(project_root, [highlight(), highlight()])
    client = FakeYoutube()
    service = uploader(project_dir, client_factory=lambda: client)
    original = service.upload_one

    def flaky(project, index, **kwargs):
        if index == 0:
            raise RuntimeError("ffmpeg fell over")
        return original(project, index, **kwargs)

    service.upload_one = flaky

    assert len(run_step(service)) == 1

    metadata = read_metadata()
    assert metadata["step_statuses"]["upload"] == "partial"
    assert "1 of 2 clips are not on YouTube yet" in metadata["step_errors"]["upload"]
    assert metadata["highlights"][0]["upload_error"] == "ffmpeg fell over"


def test_a_run_that_publishes_nothing_fails_the_step(project_root):
    project_dir = write_project(project_root, [highlight()])
    service = uploader(
        project_dir,
        client_factory=lambda: FakeYoutube(),
        clipper=FakeClipper(project_dir, error=RuntimeError("ffmpeg fell over")),
    )

    assert run_step(service) == []

    metadata = read_metadata()
    assert metadata["step_statuses"]["upload"] == "error"
    assert "ffmpeg fell over" in metadata["step_errors"]["upload"]


# --- What an upload makes: privacy, and the schedule that publishes it -------

# A fixed "now" in a timezone that is not UTC, so a test that gets the offset
# wrong cannot pass by accident: 2 p.m. on a Saturday, two hours ahead.
TZ = timezone(timedelta(hours=2))
NOW = datetime(2026, 8, 22, 14, 0, tzinfo=TZ)


def scheduling_uploader(project_dir: Path, app_settings=None, **overrides) -> Uploader:
    """An uploader whose settings and clock are the test's, not the machine's."""
    settings = app_settings or {}
    return uploader(
        project_dir,
        settings_reader=lambda key, default=None: settings.get(key, default),
        now=lambda: NOW,
        **overrides,
    )


def publish(project_dir: Path, app_settings=None, index=0, client=None) -> dict:
    """Publishes one clip and hands back what the API was asked to do."""
    client = client or FakeYoutube()
    scheduling_uploader(project_dir, app_settings).upload_one(
        Project(PROJECT_ID), index, client=client
    )
    return client.calls[-1]


def test_an_upload_nobody_has_configured_is_private(project_root):
    # What every upload did before there was a choice, and the only one of the
    # four that cannot reach an audience by accident.
    project_dir = write_project(project_root, [highlight()])

    call = publish(project_dir)

    assert call["privacy_status"] == "private"
    assert call["publish_at"] is None


def test_the_privacy_from_settings_is_what_the_video_goes_up_as(project_root):
    project_dir = write_project(project_root, [highlight()])

    assert publish(project_dir, {"youtube_privacy": "unlisted"})["privacy_status"] == "unlisted"
    assert publish(project_dir, {"youtube_privacy": "public"})["privacy_status"] == "public"


def test_a_privacy_youtube_has_never_heard_of_is_refused_rather_than_sent(project_root):
    # The value reaches this from settings.json, which a user can edit by hand.
    project_dir = write_project(project_root, [highlight()])

    assert publish(project_dir, {"youtube_privacy": "friends only"})["privacy_status"] == "private"


def test_a_project_publishes_at_its_own_privacy_rather_than_the_applications(project_root):
    # One install cuts a company's podcast and somebody's side project, and the
    # two do not go public on the same terms.
    project_dir = write_project(project_root, [highlight()], upload={"privacy": "public"})

    assert publish(project_dir, {"youtube_privacy": "private"})["privacy_status"] == "public"


def test_a_project_that_has_chosen_nothing_follows_the_application(project_root):
    project_dir = write_project(project_root, [highlight()], upload={"privacy": None})

    assert publish(project_dir, {"youtube_privacy": "unlisted"})["privacy_status"] == "unlisted"


def test_a_scheduled_upload_goes_up_private_with_a_time_on_it(project_root):
    # "Scheduled" is not a fourth privacy — YouTube has no such state. It is
    # private plus a publish time, which YouTube itself turns public.
    project_dir = write_project(project_root, [highlight()])

    call = publish(project_dir, {"youtube_privacy": "schedule"})

    assert call["privacy_status"] == "private"
    # No day named, nothing per day: as soon as the upload can be published,
    # which is the lead ahead of now — 14:00+02:00, so 12:15 UTC.
    assert call["publish_at"] == "2026-08-22T12:15:00Z"


def test_a_named_day_publishes_at_the_first_hour_of_the_window(project_root):
    project_dir = write_project(project_root, [highlight()])

    call = publish(project_dir, {
        "youtube_privacy": "schedule",
        "youtube_schedule_start_date": "2026-08-25",
        "youtube_schedule_day_start_hour": 9,
    })

    # 09:00 on the 25th, on the user's clock, which is 07:00 UTC.
    assert call["publish_at"] == "2026-08-25T07:00:00Z"


def test_clips_are_spread_over_the_days_they_were_given(project_root):
    project_dir = write_project(project_root, [highlight(), highlight(), highlight()])
    settings = {
        "youtube_privacy": "schedule",
        "youtube_schedule_start_date": "2026-08-25",
        "youtube_schedule_per_day": 2,
        "youtube_schedule_day_start_hour": 9,
        "youtube_schedule_day_end_hour": 21,
    }
    service = scheduling_uploader(project_dir, settings)

    assert [service.publish_at(Project(PROJECT_ID), i) for i in range(3)] == [
        "2026-08-25T07:00:00Z",  # 09:00 local
        "2026-08-25T19:00:00Z",  # 21:00 local
        "2026-08-26T07:00:00Z",  # the next day, back at the first hour
    ]


def test_a_clip_keeps_its_slot_however_it_was_published(project_root):
    # The slot is a function of the clip's own position, so publishing one card
    # on its own puts it exactly where the whole-project run would have.
    project_dir = write_project(project_root, [highlight(), highlight()])
    settings = {
        "youtube_privacy": "schedule",
        "youtube_schedule_start_date": "2026-08-25",
        "youtube_schedule_per_day": 1,
    }

    assert publish(project_dir, settings, index=1)["publish_at"] == (
        scheduling_uploader(project_dir, settings).publish_at(Project(PROJECT_ID), 1)
    )


def test_clips_are_scheduled_by_score_not_by_position(project_root, monkeypatch):
    # 4 moments, a cutoff of 50: the clips are positions 1 and 3, and the
    # better of them goes first. Neither waits behind the moments under the
    # cutoff, which is what scheduling by position did.
    monkeypatch.setattr(settings_manager, "settings", {"jev_min_score": 0.5})
    project_dir = write_project(project_root, [
        highlight(jev_scores={"relative": 0.1}),
        highlight(jev_scores={"relative": 0.6}),
        highlight(jev_scores={"relative": 0.2}),
        highlight(jev_scores={"relative": 0.9}),
    ])
    settings = {
        "youtube_privacy": "schedule",
        "youtube_schedule_start_date": "2026-08-25",
        "youtube_schedule_per_day": 1,
        "youtube_schedule_day_start_hour": 9,
    }
    service = scheduling_uploader(project_dir, settings)

    assert service.publish_at(Project(PROJECT_ID), 3) == "2026-08-25T07:00:00Z"
    assert service.publish_at(Project(PROJECT_ID), 1) == "2026-08-26T07:00:00Z"


def test_a_day_that_has_already_begun_starts_the_run_tomorrow(project_root):
    # Nine has passed by two in the afternoon. Deciding this per clip put the
    # ones whose slot had gone onto the day the next clip already had.
    project_dir = write_project(project_root, [highlight(), highlight()])
    service = scheduling_uploader(project_dir, {
        "youtube_privacy": "schedule",
        "youtube_schedule_start_date": "2026-08-22",
        "youtube_schedule_per_day": 1,
        "youtube_schedule_day_start_hour": 9,
    })

    assert [service.publish_at(Project(PROJECT_ID), i) for i in range(2)] == [
        "2026-08-23T07:00:00Z",
        "2026-08-24T07:00:00Z",
    ]


def test_a_day_that_has_gone_is_never_published_in_the_past(project_root):
    # YouTube refuses a publish time behind it, and a date chosen last week is
    # one. The lead ahead of now is the earliest anything can be.
    project_dir = write_project(project_root, [highlight()])

    call = publish(project_dir, {
        "youtube_privacy": "schedule",
        "youtube_schedule_start_date": "2020-01-01",
    })

    assert call["publish_at"] == "2026-08-22T12:15:00Z"


def test_a_date_nobody_can_parse_publishes_as_soon_as_it_can(project_root):
    project_dir = write_project(project_root, [highlight()])

    call = publish(project_dir, {
        "youtube_privacy": "schedule",
        "youtube_schedule_start_date": "next tuesday",
    })

    assert call["publish_at"] == "2026-08-22T12:15:00Z"


def test_a_project_may_keep_its_own_calendar(project_root):
    project_dir = write_project(project_root, [highlight()], upload={
        "privacy": "schedule",
        "start_date": "2026-09-01",
        "day_start_hour": 8,
    })
    service = scheduling_uploader(project_dir, {
        "youtube_privacy": "private",
        "youtube_schedule_start_date": "2026-08-25",
        "youtube_schedule_day_start_hour": 17,
    })

    assert service.publish_at(Project(PROJECT_ID), 0) == "2026-09-01T06:00:00Z"


def test_nothing_is_scheduled_unless_the_project_is_on_a_schedule(project_root):
    # The calendar is kept while the privacy is not "schedule", so a week on
    # private does not cost the user their dates — but it publishes nothing.
    project_dir = write_project(project_root, [highlight()], upload={
        "privacy": "unlisted",
        "start_date": "2026-09-01",
    })

    assert publish(project_dir)["publish_at"] is None


def test_what_the_video_went_up_as_is_recorded_on_the_clip(project_root):
    # A scheduled short and a private one are the same page on YouTube until
    # the hour comes; this is the only thing that says which one it is.
    project_dir = write_project(project_root, [highlight()])

    publish(project_dir, {
        "youtube_privacy": "schedule",
        "youtube_schedule_start_date": "2026-08-25",
    })

    stored = read_metadata()["highlights"][0]
    assert stored["youtube_privacy"] == "schedule"
    assert stored["youtube_publish_at"] == "2026-08-25T07:00:00Z"


def test_a_project_written_by_hand_cannot_publish_something_youtube_refuses(project_root):
    # metadata.json is a file on the user's disk. A privacy YouTube has never
    # heard of, and an hour that is not one, read as no opinion at all.
    project_dir = write_project(project_root, [highlight()], upload={
        "privacy": "friends only",
        "day_start_hour": 39,
        "start_date": "the first of never",
    })
    service = scheduling_uploader(project_dir, {
        "youtube_privacy": "schedule",
        "youtube_schedule_day_start_hour": 9,
    })

    assert service.privacy(Project(PROJECT_ID)) == "schedule"
    assert service.publish_at(Project(PROJECT_ID), 0) == "2026-08-22T12:15:00Z"


def test_a_video_that_is_gone_takes_its_schedule_with_it(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakeYoutube()
    service = scheduling_uploader(project_dir, {"youtube_privacy": "public"})
    service.upload_one(Project(PROJECT_ID), 0, client=client)

    client.exists = False
    service.verify_publication(Project(PROJECT_ID), 0, client=client)

    stored = read_metadata()["highlights"][0]
    assert stored["youtube_privacy"] is None
    assert stored["youtube_publish_at"] is None

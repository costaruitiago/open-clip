"""Cover for importing one clip into Postiz: what it sends, and what it records."""

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from backend.src.dataclasses.data import Project
from backend.src.infrastructure import postiz_client
from backend.src.infrastructure.postiz_client import (
    CLOUD_API_URL,
    MAX_UPLOAD_BYTES,
    MissingPostizCredentialsError,
    PostizClient,
    PostizError,
    PostizRejectedPostsError,
    normalize_api_url,
)
from backend.src.orchestrator import ClipRegenerationInProgressError, PipelineOrchestrator
from backend.src.services.postiz_publisher import (
    NoPostizChannelsError,
    PostizImportInProgressError,
    PostizPublisher,
)
from backend.src.services.uploader import ClipFileMissingError, ClipNotRenderedError

PIPELINE_CONFIG = Path(__file__).resolve().parents[1] / "config" / "pipeline.json"

PROJECT_ID = "test-project"


class FakeClipper:
    """Stands in for the cut every import begins with."""

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
        write_clip(self.project_dir, filename, b"the cut this import made")
        highlights = project.highlights
        highlights[index].is_clip_generated = True
        highlights[index].generated_clip_filename = filename
        highlights[index].rendered_at = datetime.now().isoformat()
        project.set_property("highlights", highlights)
        return highlights[index].to_dict()


class FakePostiz:
    """Stands in for the API handle. Records what it was asked to file."""

    def __init__(self, integrations=None):
        self.integrations = integrations if integrations is not None else [
            {"id": "chan-x", "name": "My X", "identifier": "x"},
            {"id": "chan-li", "name": "My LinkedIn", "identifier": "linkedin"},
        ]
        self.uploads = []
        self.posts = []
        self.upload_error = None
        self.post_error = None
        # Positions in the `posts` array Postiz refuses on the first attempt,
        # the way it refuses a Discord with no channel id configured. Cleared
        # once refused, so the retry without them goes through.
        self.reject_positions = None
        # What `GET /posts` answers. Drafts are deliberately absent from it, as
        # they are from the real endpoint, which is the whole reason a missing
        # post cannot be read as a deleted one.
        self.filed_posts = []
        self.windows = []
        # Whether Postiz still holds a given post. Default True — a post that
        # is merely a draft is still there — so a test has to say otherwise to
        # describe one that has gone.
        self.existence = {}
        self.existence_default = True
        self.existence_asked = []

    def list_integrations(self):
        return self.integrations

    def upload_file(self, path):
        if self.upload_error:
            raise self.upload_error
        self.uploads.append(path)
        return {"id": "media-1", "path": "https://uploads.postiz.com/clip.mp4"}

    def create_post(self, payload):
        if self.post_error:
            raise self.post_error
        if self.reject_positions:
            positions, self.reject_positions = self.reject_positions, None
            self.posts.append(payload)
            raise PostizRejectedPostsError(
                "posts.1.settings.channel should not be null or undefined", positions
            )
        self.posts.append(payload)
        # One entry per channel, which is what the client now keeps all of:
        # every channel's post id arrives here, at creation, for free.
        return [
            {
                "id": "post-1" if position == 0 else f"post-{position + 1}",
                "group": "grp-1",
                "integration": {"id": post["integration"]["id"]},
            }
            for position, post in enumerate(payload["posts"])
        ]

    def list_posts(self, start, end):
        self.windows.append((start, end))
        return self.filed_posts

    def post_exists(self, post_id):
        # What the real client answers from the route the web app renders
        # `/p/{id}` from: True for a post Postiz holds, False for one it does
        # not — a draft is held, a deleted post is not — and None when the
        # question could not be asked at all.
        self.existence_asked.append(post_id)
        return self.existence.get(post_id, self.existence_default)

    def post_url(self, post_id):
        # The calendar, like the real client: Postiz's `/p/{id}` preview page
        # answers 200 for ids that never existed and renders nothing for a
        # draft, so it is not a link worth handing anybody.
        return "https://postiz.example.com"


# The two channels `FakePostiz` offers. Ticked in every test that does not say
# otherwise, because nothing is imported anywhere the user has not chosen.
BOTH_CHANNELS = ["chan-x", "chan-li"]


def publisher(project_dir: Path, client: FakePostiz, settings=None, **overrides) -> PostizPublisher:
    """A publisher whose cut and whose Postiz are both fakes."""
    values = {"postiz_channels": BOTH_CHANNELS}
    values.update(settings or {})
    options = {
        "clipper": FakeClipper(project_dir),
        "client_factory": lambda: client,
        "settings_reader": lambda key, default=None: values.get(key, default),
    }
    options.update(overrides)
    return PostizPublisher(**options)


def highlight(**overrides):
    data = {
        "highlight_text": "the quote",
        "viral_hook_text": "the hook",
        "video_title_for_youtube_short": "The Title",
        "video_description_for_youtube_short": "what the short is about",
        "video_description_for_x": "the X post",
        "video_description_for_reddit": "the Reddit post",
        "video_description_for_linkedin": "the LinkedIn post",
        "start": 0,
        "end": 30,
        "is_clip_generated": True,
        "generated_clip_filename": "clip_000.mp4",
    }
    data.update(overrides)
    return data


def write_project(root: Path, highlights, description=None, postiz=None):
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
            "postiz": postiz or {},
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


# --- The base URL a user pastes in -----------------------------------------

def test_an_empty_url_is_the_cloud_api():
    assert normalize_api_url(None) == CLOUD_API_URL
    assert normalize_api_url("  ") == CLOUD_API_URL


def test_a_self_hosted_host_gets_the_api_prefix():
    assert normalize_api_url("https://postiz.example.com") == (
        "https://postiz.example.com/api/public/v1"
    )
    assert normalize_api_url("postiz.example.com/") == (
        "https://postiz.example.com/api/public/v1"
    )


def test_the_cloud_host_does_not_get_the_api_prefix():
    assert normalize_api_url("https://api.postiz.com") == CLOUD_API_URL


def test_a_url_that_already_names_the_version_is_left_alone():
    # The way out of the guess, for an instance behind a rewriting proxy.
    assert normalize_api_url("https://proxy.example.com/postiz/public/v1") == (
        "https://proxy.example.com/postiz/public/v1"
    )


def test_no_api_key_is_refused_as_something_the_user_can_fix():
    with pytest.raises(MissingPostizCredentialsError):
        PostizClient(api_url="https://postiz.example.com", api_key="")


# --- How big a clip may be --------------------------------------------------

def sparse_clip(tmp_path, size, name="clip_001.mp4"):
    """A file of `size` bytes that costs nothing to write."""
    path = tmp_path / name
    with open(path, "wb") as handle:
        handle.truncate(size)
    return path


def answering(monkeypatch, status, payload=None):
    """Every request answered with one status. Returns the calls it collected."""
    calls = []

    def fake_request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return httpx.Response(
            status,
            json=payload if payload is not None else {},
            request=httpx.Request(method, url),
        )

    monkeypatch.setattr(postiz_client.httpx, "request", fake_request)
    return calls


def test_a_clip_over_the_old_fifty_megabytes_is_still_sent(tmp_path, monkeypatch):
    # 50MB is the JSON body cap on the post routes, not what `/upload` takes:
    # most rendered clips of any length are past it.
    path = sparse_clip(tmp_path, 60 * 1024 * 1024)
    calls = answering(monkeypatch, 200, {"id": "media-1", "path": "https://u/1.mp4"})

    client = PostizClient(api_url="https://postiz.example.com", api_key="key")
    assert client.upload_file(str(path))["id"] == "media-1"
    assert calls[0][1].endswith("/upload")


def test_a_clip_past_what_postiz_holds_is_refused_before_the_transfer(
    tmp_path, monkeypatch
):
    path = sparse_clip(tmp_path, MAX_UPLOAD_BYTES + 1)
    calls = answering(monkeypatch, 200, {"id": "media-1"})

    client = PostizClient(api_url="https://postiz.example.com", api_key="key")
    with pytest.raises(PostizError, match="1024MB"):
        client.upload_file(str(path))
    assert calls == []


def test_an_upload_refused_as_too_large_names_the_proxy(tmp_path, monkeypatch):
    # Postiz itself takes 1GB, so a 413 is something in front of it.
    path = sparse_clip(tmp_path, 60 * 1024 * 1024)
    answering(monkeypatch, 413)

    client = PostizClient(api_url="https://postiz.example.com", api_key="key")
    with pytest.raises(PostizError, match="client_max_body_size"):
        client.upload_file(str(path))


# --- What gets filed --------------------------------------------------------

def test_a_clip_nobody_has_rendered_is_cut_and_then_filed(project_root):
    project_dir = write_project(
        project_root, [highlight(is_clip_generated=False, generated_clip_filename=None)]
    )
    clipper = FakeClipper(project_dir)
    client = FakePostiz()

    result = publisher(project_dir, client, clipper=clipper).import_one(Project(PROJECT_ID), 0)

    assert clipper.calls == [0]
    assert client.uploads[0].endswith("clips/clip_000.mp4")
    assert result["post_id"] == "post-1"


def test_a_clip_that_already_has_a_file_is_cut_again_before_it_is_filed(project_root):
    # Same promise the YouTube upload makes: what goes to Postiz is the clip the
    # page was showing, not a file cut before the last caption change.
    project_dir = write_project(project_root, [highlight()])
    write_clip(project_dir, content=b"the cut from before the last change")
    clipper = FakeClipper(project_dir)

    publisher(project_dir, FakePostiz(), clipper=clipper).import_one(Project(PROJECT_ID), 0)

    assert clipper.calls == [0]
    assert (project_dir / "clips" / "clip_000.mp4").read_bytes() == b"the cut this import made"


def test_every_channel_is_one_post_with_the_video_attached(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    assert len(client.posts) == 1, "one request covers every channel"
    payload = client.posts[0]
    assert [post["integration"]["id"] for post in payload["posts"]] == ["chan-x", "chan-li"]
    for post in payload["posts"]:
        assert post["value"][0]["image"] == [
            {"id": "media-1", "path": "https://uploads.postiz.com/clip.mp4"}
        ]


def test_each_channel_says_what_the_model_wrote_for_its_platform(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    said = {
        post["integration"]["id"]: post["value"][0]["content"]
        for post in client.posts[0]["posts"]
    }
    assert said == {"chan-x": "the X post", "chan-li": "the LinkedIn post"}


def test_a_platform_the_model_writes_nothing_for_gets_the_description(project_root):
    project_dir = write_project(
        project_root,
        [highlight()],
        description={"source_title": "Episode 4", "source_url": "https://example.com/ep4"},
    )
    client = FakePostiz([{"id": "chan-fb", "name": "Page", "identifier": "facebook"}])

    publisher(
        project_dir, client, settings={"postiz_channels": ["chan-fb"]}
    ).import_one(Project(PROJECT_ID), 0)

    content = client.posts[0]["posts"][0]["value"][0]["content"]
    assert "what the short is about" in content
    assert "https://example.com/ep4" in content


def test_the_platform_is_named_in_the_settings_postiz_requires(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    types = [post["settings"]["__type"] for post in client.posts[0]["posts"]]
    assert types == ["x", "linkedin"]


def test_a_draft_is_what_an_import_makes_unless_asked_otherwise(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    assert client.posts[0]["type"] == "draft"


def test_the_post_type_can_be_set_in_settings(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(
        project_dir, client, settings={"postiz_post_type": "schedule"}
    ).import_one(Project(PROJECT_ID), 0)

    assert client.posts[0]["type"] == "schedule"


def test_an_unknown_post_type_files_a_draft_rather_than_guessing(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(
        project_dir, client, settings={"postiz_post_type": "publish-everywhere"}
    ).import_one(Project(PROJECT_ID), 0)

    assert client.posts[0]["type"] == "draft"


# --- Which channels ---------------------------------------------------------

def test_nothing_is_imported_until_channels_are_chosen(project_root):
    # An earlier version read an empty choice as "every connected channel",
    # which sent a project's clips to six accounts across two companies and a
    # personal profile that nobody had ticked. Posting somewhere is a decision,
    # not something to infer from an account being connected.
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()
    clipper = FakeClipper(project_dir)

    with pytest.raises(NoPostizChannelsError):
        publisher(
            project_dir, client, settings={"postiz_channels": []}, clipper=clipper
        ).import_one(Project(PROJECT_ID), 0)

    assert client.posts == []
    assert clipper.calls == []


def test_a_channel_the_user_ticked_is_used_even_if_postiz_marks_it_disabled(project_root):
    # Their call: a draft they can see beats a channel that silently vanished.
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz([
        {"id": "chan-x", "name": "My X", "identifier": "x"},
        {"id": "chan-off", "name": "Expired", "identifier": "linkedin", "disabled": True},
    ])

    publisher(
        project_dir, client, settings={"postiz_channels": ["chan-x", "chan-off"]}
    ).import_one(Project(PROJECT_ID), 0)

    assert [post["integration"]["id"] for post in client.posts[0]["posts"]] == [
        "chan-x", "chan-off"
    ]


def test_the_selection_in_settings_narrows_it(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(
        project_dir, client, settings={"postiz_channels": ["chan-li"]}
    ).import_one(Project(PROJECT_ID), 0)

    assert [post["integration"]["id"] for post in client.posts[0]["posts"]] == ["chan-li"]


def test_a_chosen_channel_that_has_gone_is_skipped_rather_than_failing(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(
        project_dir, client, settings={"postiz_channels": ["chan-li", "chan-deleted"]}
    ).import_one(Project(PROJECT_ID), 0)

    assert [post["integration"]["id"] for post in client.posts[0]["posts"]] == ["chan-li"]


def test_an_account_with_nowhere_to_file_is_refused_before_anything_is_cut(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz([])
    clipper = FakeClipper(project_dir)

    with pytest.raises(NoPostizChannelsError):
        publisher(project_dir, client, clipper=clipper).import_one(Project(PROJECT_ID), 0)

    assert clipper.calls == []
    assert client.uploads == []


# --- What a render that produced nothing does -------------------------------

def test_a_render_that_produced_no_file_files_nothing(project_root):
    project_dir = write_project(project_root, [highlight()])  # metadata says rendered, no file
    client = FakePostiz()

    with pytest.raises(ClipFileMissingError):
        publisher(
            project_dir, client, clipper=FakeClipper(project_dir, writes=False)
        ).import_one(Project(PROJECT_ID), 0)

    assert client.uploads == []


def test_a_render_that_left_the_highlight_uncut_files_nothing(project_root):
    project_dir = write_project(
        project_root, [highlight(is_clip_generated=False, generated_clip_filename=None)]
    )
    client = FakePostiz()

    with pytest.raises(ClipNotRenderedError):
        publisher(
            project_dir, client, clipper=FakeClipper(project_dir, writes=False)
        ).import_one(Project(PROJECT_ID), 0)

    assert client.uploads == []


def test_no_highlight_at_that_index_is_refused(project_root):
    project_dir = write_project(project_root, [highlight()])

    with pytest.raises(IndexError):
        publisher(project_dir, FakePostiz()).import_one(Project(PROJECT_ID), 3)


# --- What is written back ---------------------------------------------------

def test_the_filed_post_is_recorded_on_the_highlight(project_root):
    project_dir = write_project(project_root, [highlight()])

    publisher(project_dir, FakePostiz()).import_one(Project(PROJECT_ID), 0)

    stored = read_metadata()["highlights"][0]
    assert stored["postiz_post_id"] == "post-1"
    # The calendar, not a per-post page: Postiz's `/p/{id}` answers 200 for an
    # id that never existed and shows nothing for a draft.
    assert stored["postiz_url"] == "https://postiz.example.com"
    assert stored["postiz_imported_at"]
    assert [entry["id"] for entry in stored["postiz_channels"]] == ["chan-x", "chan-li"]
    assert stored["postiz_error"] is None


def test_a_failure_is_recorded_as_the_sentence_the_page_reads_back(project_root):
    project_dir = write_project(project_root, [highlight()])

    publisher(project_dir, FakePostiz()).record_failure(
        Project(PROJECT_ID), 0, "Postiz answered 500"
    )

    assert read_metadata()["highlights"][0]["postiz_error"] == "Postiz answered 500"


def test_a_new_attempt_clears_the_last_failure(project_root):
    project_dir = write_project(project_root, [highlight(postiz_error="the last one broke")])
    service = publisher(project_dir, FakePostiz())

    service.begin_attempt(Project(PROJECT_ID), 0)

    assert read_metadata()["highlights"][0]["postiz_error"] is None


def test_a_successful_import_clears_the_error_beside_it(project_root):
    project_dir = write_project(project_root, [highlight(postiz_error="the last one broke")])

    publisher(project_dir, FakePostiz()).import_one(Project(PROJECT_ID), 0)

    stored = read_metadata()["highlights"][0]
    assert stored["postiz_error"] is None
    assert stored["postiz_post_id"] == "post-1"


def test_a_youtube_upload_is_not_disturbed_by_an_import(project_root):
    # The two destinations are independent records of the same clip.
    project_dir = write_project(project_root, [highlight(
        youtube_video_id="vid-1", youtube_url="https://youtu.be/vid-1"
    )])

    publisher(project_dir, FakePostiz()).import_one(Project(PROJECT_ID), 0)

    stored = read_metadata()["highlights"][0]
    assert stored["youtube_video_id"] == "vid-1"
    assert stored["postiz_post_id"] == "post-1"


# --- The job the orchestrator runs ------------------------------------------

def orchestrator(publisher_service) -> PipelineOrchestrator:
    return PipelineOrchestrator(
        config_path=str(PIPELINE_CONFIG),
        services={"postiz": publisher_service, "clipper": None, "upload": None},
    )


def test_a_second_import_of_the_same_clip_is_refused(project_root):
    project_dir = write_project(project_root, [highlight()])
    pipeline = orchestrator(publisher(project_dir, FakePostiz()))
    pipeline.active_processes[f"{PROJECT_ID}_postiz_clip_0"] = 1.0

    with pytest.raises(PostizImportInProgressError):
        pipeline.import_clip_to_postiz(PROJECT_ID, 0)


def test_an_import_is_refused_while_the_clip_is_being_re_cut(project_root):
    # Both cut the clip into the same file.
    project_dir = write_project(project_root, [highlight()])
    pipeline = orchestrator(publisher(project_dir, FakePostiz()))
    pipeline.active_processes[f"{PROJECT_ID}_clip_0"] = 1.0

    with pytest.raises(ClipRegenerationInProgressError):
        pipeline.import_clip_to_postiz(PROJECT_ID, 0)


def test_a_re_cut_is_refused_while_the_clip_is_being_imported(project_root):
    project_dir = write_project(project_root, [highlight()])
    pipeline = orchestrator(publisher(project_dir, FakePostiz()))
    pipeline.active_processes[f"{PROJECT_ID}_postiz_clip_0"] = 1.0

    with pytest.raises(PostizImportInProgressError):
        pipeline.regenerate_clip(PROJECT_ID, 0)


def test_an_account_with_no_channels_is_reported_to_the_click_that_asked(project_root):
    # Rather than in the background, minutes later, on the highlight.
    project_dir = write_project(project_root, [highlight()])
    pipeline = orchestrator(publisher(project_dir, FakePostiz([])))

    with pytest.raises(NoPostizChannelsError):
        pipeline.import_clip_to_postiz(PROJECT_ID, 0)

    assert f"{PROJECT_ID}_postiz_clip_0" not in pipeline.active_processes


def test_the_import_job_leaves_the_post_on_the_highlight(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()
    pipeline = orchestrator(publisher(project_dir, client))

    key = pipeline.import_clip_to_postiz(PROJECT_ID, 0)
    for thread in list(pipeline.active_project_orchestrators.values()):
        thread.join(timeout=5)
    deadline = 5.0
    while key in pipeline.active_processes and deadline > 0:
        import time as _time
        _time.sleep(0.05)
        deadline -= 0.05

    assert key not in pipeline.active_processes
    assert read_metadata()["highlights"][0]["postiz_post_id"] == "post-1"


# --- The pipeline step ------------------------------------------------------

def run_step(service, project_id=PROJECT_ID, full=False):
    return asyncio.run(service.execute(Project(project_id), full=full))


def unconfigured(exc):
    """A publisher whose Postiz cannot be opened at all."""
    def factory():
        raise exc
    return factory


def test_the_step_stops_at_once_when_no_api_key_is_configured(project_root):
    # The whole complaint this covers: the step said "running" forever, because
    # the failure happened after the status was set and nothing moved it off.
    project_dir = write_project(project_root, [highlight()])
    clipper = FakeClipper(project_dir)
    service = publisher(
        project_dir,
        FakePostiz(),
        clipper=clipper,
        client_factory=unconfigured(
            MissingPostizCredentialsError("No Postiz API key is configured.")
        ),
    )

    assert run_step(service) == []

    metadata = read_metadata()
    assert metadata["step_statuses"]["postiz"] == "error"
    assert "API key" in metadata["step_errors"]["postiz"]
    # Nothing was encoded on the way to finding that out.
    assert clipper.calls == []


def test_an_account_with_no_channels_stops_the_step_with_the_reason(project_root):
    project_dir = write_project(project_root, [highlight()])
    clipper = FakeClipper(project_dir)
    service = publisher(project_dir, FakePostiz([]), clipper=clipper)

    assert run_step(service) == []

    metadata = read_metadata()
    assert metadata["step_statuses"]["postiz"] == "error"
    assert "on the account any more" in metadata["step_errors"]["postiz"]
    assert clipper.calls == []


def test_a_step_that_imported_everything_completes_and_says_nothing(project_root):
    project_dir = write_project(project_root, [highlight(), highlight()])
    service = publisher(project_dir, FakePostiz())

    assert len(run_step(service)) == 2

    metadata = read_metadata()
    assert metadata["step_statuses"]["postiz"] == "completed"
    assert "postiz" not in metadata.get("step_errors", {})


def test_a_step_that_filed_nothing_is_not_reported_as_completed(project_root):
    # Otherwise the user goes looking in Postiz for drafts that were never made.
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()
    client.post_error = RuntimeError("Postiz answered 500")
    service = publisher(project_dir, client)

    assert run_step(service) == []

    metadata = read_metadata()
    assert metadata["step_statuses"]["postiz"] == "error"
    assert "Postiz answered 500" in metadata["step_errors"]["postiz"]
    # And the clip carries its own copy, which is what its card reads back.
    assert metadata["highlights"][0]["postiz_error"] == "Postiz answered 500"


def test_one_clip_failing_does_not_abandon_the_rest(project_root):
    project_dir = write_project(project_root, [highlight(), highlight()])
    client = FakePostiz()
    service = publisher(project_dir, client, clipper=FakeClipper(project_dir))

    original = service.import_one

    def flaky(project, index, **kwargs):
        if index == 0:
            raise RuntimeError("the first one broke")
        return original(project, index, **kwargs)

    service.import_one = flaky
    assert len(run_step(service)) == 1

    metadata = read_metadata()
    # Partly done, not done: one of the two clips has no draft, and a step that
    # called that "completed" is how someone goes looking for a draft that was
    # never made.
    assert metadata["step_statuses"]["postiz"] == "partial"
    assert "1 of 2 clips are not in Postiz yet" in metadata["step_errors"]["postiz"]
    assert metadata["highlights"][0]["postiz_error"] == "the first one broke"
    assert metadata["highlights"][1]["postiz_post_id"] == "post-1"


def test_running_the_step_again_clears_the_last_reason(project_root):
    project_dir = write_project(project_root, [highlight()])
    failing = publisher(
        project_dir,
        FakePostiz(),
        client_factory=unconfigured(MissingPostizCredentialsError("No Postiz API key.")),
    )
    run_step(failing)
    assert read_metadata()["step_errors"]["postiz"]

    run_step(publisher(project_dir, FakePostiz()))

    metadata = read_metadata()
    assert metadata["step_statuses"]["postiz"] == "completed"
    # A green badge with last time's reason under it is worse than no reason.
    assert "postiz" not in metadata["step_errors"]


def test_the_channel_list_is_asked_for_once_per_run(project_root):
    # Not once per clip: it is one HTTP call against a rate-limited API, and a
    # project of twenty clips made twenty of them.
    project_dir = write_project(project_root, [highlight(), highlight(), highlight()])
    client = FakePostiz()
    asked = []
    original = client.list_integrations
    client.list_integrations = lambda: (asked.append(1), original())[1]

    run_step(publisher(project_dir, client))

    assert len(asked) == 1


# --- A step run again after everything is already filed ---------------------

def test_a_clip_filed_since_its_last_cut_is_not_filed_twice(project_root):
    # Otherwise running the step a second time puts a second identical draft
    # on the calendar for every clip in the project.
    project_dir = write_project(project_root, [highlight(
        rendered_at="2026-01-01T10:00:00",
        postiz_imported_at="2026-01-01T10:00:05",
        postiz_post_id="post-1",
    )])
    client = FakePostiz()

    assert run_step(publisher(project_dir, client)) == []

    assert client.posts == []
    assert read_metadata()["step_statuses"]["postiz"] == "completed"


def test_a_clip_re_cut_since_it_was_filed_is_filed_again(project_root):
    # Its draft carries the previous video, so it is not current.
    project_dir = write_project(project_root, [highlight(
        postiz_imported_at="2026-01-01T10:00:00",
        rendered_at="2026-01-01T11:00:00",
        postiz_post_id="post-old",
    )])
    client = FakePostiz()

    assert len(run_step(publisher(project_dir, client))) == 1
    assert len(client.posts) == 1


def test_a_clip_nobody_has_filed_is_filed_by_the_step(project_root):
    project_dir = write_project(project_root, [highlight(rendered_at="2026-01-01T10:00:00")])

    assert len(run_step(publisher(project_dir, FakePostiz()))) == 1


def test_a_second_press_files_only_the_clips_that_are_missing(project_root):
    # The complaint this covers: one draft in Postiz, nineteen clips with none,
    # and a step that said "done". Pressing it again has to file the nineteen
    # and leave the one alone.
    project_dir = write_project(project_root, [
        highlight(
            rendered_at="2026-01-01T10:00:00",
            postiz_imported_at="2026-01-01T10:00:05",
            postiz_post_id="post-1",
        ),
        highlight(rendered_at="2026-01-01T10:00:00"),
    ])
    client = FakePostiz()

    assert len(run_step(publisher(project_dir, client))) == 1

    # One request, for the clip that had no draft.
    assert len(client.posts) == 1
    metadata = read_metadata()
    assert metadata["step_statuses"]["postiz"] == "completed"
    # And the draft that was already there kept its id rather than gaining a twin.
    assert metadata["highlights"][0]["postiz_post_id"] == "post-1"


def test_a_resume_that_finds_nothing_left_still_reads_as_done(project_root):
    # A run that files nothing is "everything is already there" as often as it
    # is "nothing worked", and the two are told apart by the highlights rather
    # than by the tally — which is why `_settle` reads the clips, not the run.
    project_dir = write_project(project_root, [highlight(rendered_at="2026-01-01T10:00:00")])
    client = FakePostiz()
    service = publisher(project_dir, client)

    assert len(run_step(service)) == 1
    assert read_metadata()["highlights"][0]["postiz_post_id"] == "post-1"

    assert run_step(service) == []
    assert len(client.posts) == 1
    assert read_metadata()["step_statuses"]["postiz"] == "completed"


# --- What each channel travels with -----------------------------------------

def test_x_is_told_who_may_reply_because_the_answer_is_obvious(project_root):
    # Postiz refuses the whole request without it, and a clip going out
    # publicly has one sensible answer.
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    x_post = client.posts[0]["posts"][0]
    assert x_post["settings"]["__type"] == "x"
    assert x_post["settings"]["who_can_reply_post"] == "everyone"


def test_what_only_the_user_knows_comes_from_settings(project_root):
    # A Discord channel id is not something this app can work out, and a table
    # of Postiz's required fields kept here would be wrong within a release.
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz([{"id": "chan-dc", "name": "Samantha", "identifier": "discord"}])

    publisher(project_dir, client, settings={
        "postiz_channels": ["chan-dc"],
        "postiz_channel_settings": {"chan-dc": {"channel": "1234567890"}},
    }).import_one(Project(PROJECT_ID), 0)

    settings = client.posts[0]["posts"][0]["settings"]
    assert settings == {"__type": "discord", "channel": "1234567890"}


def test_a_user_who_disagrees_with_a_default_overrides_it(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(project_dir, client, settings={
        "postiz_channels": ["chan-x"],
        "postiz_channel_settings": {"chan-x": {"who_can_reply_post": "following"}},
    }).import_one(Project(PROJECT_ID), 0)

    assert client.posts[0]["posts"][0]["settings"]["who_can_reply_post"] == "following"


def test_an_empty_override_does_not_blank_a_default(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(project_dir, client, settings={
        "postiz_channels": ["chan-x"],
        "postiz_channel_settings": {"chan-x": {"who_can_reply_post": ""}},
    }).import_one(Project(PROJECT_ID), 0)

    assert client.posts[0]["posts"][0]["settings"]["who_can_reply_post"] == "everyone"


# --- One bad channel must not lose the others -------------------------------

def test_a_channel_postiz_refuses_is_dropped_and_the_rest_are_filed(project_root):
    # Every channel travels in one request, so Postiz validating the request as
    # a whole meant one misconfigured Discord filed nothing at all — for every
    # clip in the project.
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()
    client.reject_positions = {1}

    result = publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    assert len(client.posts) == 2, "refused once, then sent without that channel"
    assert [post["integration"]["id"] for post in client.posts[1]["posts"]] == ["chan-x"]
    assert result["post_id"] == "post-1"
    assert [entry["id"] for entry in result["channels"]] == ["chan-x"]
    assert [entry["id"] for entry in result["refused"]] == ["chan-li"]


def test_the_clip_records_only_the_channels_it_actually_reached(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()
    client.reject_positions = {1}

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    stored = read_metadata()["highlights"][0]
    assert [entry["id"] for entry in stored["postiz_channels"]] == ["chan-x"]


def test_a_refusal_of_every_channel_fails_the_clip_with_postiz_s_own_words(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()
    client.reject_positions = {0, 1}

    with pytest.raises(PostizError) as refusal:
        publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    assert "settings.channel" in str(refusal.value)
    assert len(client.posts) == 1, "nothing is retried when nothing is left"


# --- Sending the same forty megabytes twice ---------------------------------

def test_the_video_survives_a_post_that_failed(project_root):
    # What happened to a whole project: the upload succeeded, the post was
    # refused, and the next attempt sent the same forty megabytes again. Postiz
    # kept a copy per attempt and the user paid for every one of them.
    project_dir = write_project(project_root, [highlight()])
    write_clip(project_dir)
    client = FakePostiz()
    client.post_error = RuntimeError("Postiz answered 400")

    service = publisher(project_dir, client, clipper=FakeClipper(project_dir, writes=False))
    with pytest.raises(RuntimeError):
        service.import_one(Project(PROJECT_ID), 0, render=False)

    assert len(client.uploads) == 1
    stored = read_metadata()["highlights"][0]
    assert stored["postiz_media_id"] == "media-1"

    # The retry, once the channel is configured: same file, so no second upload.
    client.post_error = None
    service.import_one(Project(PROJECT_ID), 0, render=False)

    assert len(client.uploads) == 1, "the video Postiz already has is not sent again"
    assert client.posts[-1]["posts"][0]["value"][0]["image"] == [
        {"id": "media-1", "path": "https://uploads.postiz.com/clip.mp4"}
    ]


def test_a_clip_re_cut_since_it_was_uploaded_is_sent_again(project_root):
    # A stale video must never be posted: the file is different, so the copy in
    # Postiz is of the previous cut.
    project_dir = write_project(project_root, [highlight()])
    write_clip(project_dir)
    client = FakePostiz()
    service = publisher(project_dir, client, clipper=FakeClipper(project_dir))

    service.import_one(Project(PROJECT_ID), 0, render=False)
    # The re-cut writes a different file, which is what `render=True` does.
    service.import_one(Project(PROJECT_ID), 0)

    assert len(client.uploads) == 2


def test_a_re_cut_that_produced_the_same_video_is_not_uploaded_again(project_root):
    # Pressing Import twice re-cuts the clip both times, so the file is new and
    # its timestamp is new — but the video in it is the one Postiz already has,
    # and sending it again buys nothing but the transfer.
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()
    service = publisher(project_dir, client, clipper=FakeClipper(project_dir))

    service.import_one(Project(PROJECT_ID), 0)
    service.import_one(Project(PROJECT_ID), 0)

    assert len(client.uploads) == 1
    assert len(client.posts) == 2, "two drafts were asked for, and two were made"


def test_the_same_untouched_clip_is_never_uploaded_twice_by_the_step(project_root):
    project_dir = write_project(project_root, [highlight(), highlight()])
    client = FakePostiz()

    run_step(publisher(project_dir, client))
    # Nothing has changed, so the second run has nothing to do at all.
    run_step(publisher(project_dir, client))

    assert len(client.uploads) == 2, "one per clip, not one per run"
    assert len(client.posts) == 2


# --- One machine, several projects ------------------------------------------

def test_a_project_posts_where_the_application_says_until_it_disagrees(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    assert [post["integration"]["id"] for post in client.posts[0]["posts"]] == BOTH_CHANNELS


def test_a_project_s_own_channels_win_over_the_application_s(project_root):
    # A company podcast and a side project are cut on the same install and must
    # not go to the same accounts.
    project_dir = write_project(project_root, [highlight()], postiz={"channels": ["chan-li"]})
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    assert [post["integration"]["id"] for post in client.posts[0]["posts"]] == ["chan-li"]


def test_a_project_that_chose_nowhere_imports_nowhere(project_root):
    # An empty list on the project is a choice, not an absence: it must not
    # fall through to the application's channels.
    project_dir = write_project(project_root, [highlight()], postiz={"channels": []})
    client = FakePostiz()

    with pytest.raises(NoPostizChannelsError):
        publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    assert client.posts == []


def test_a_project_can_send_to_a_different_discord_channel(project_root):
    project_dir = write_project(
        project_root, [highlight()],
        postiz={"channels": ["chan-dc"], "channel_settings": {"chan-dc": {"channel": "999"}}},
    )
    client = FakePostiz([{"id": "chan-dc", "name": "Samantha", "identifier": "discord"}])

    publisher(project_dir, client, settings={
        "postiz_channel_settings": {"chan-dc": {"channel": "111"}},
    }).import_one(Project(PROJECT_ID), 0)

    assert client.posts[0]["posts"][0]["settings"]["channel"] == "999"


def test_a_project_override_does_not_wipe_the_rest_of_a_channel_s_settings(project_root):
    project_dir = write_project(
        project_root, [highlight()],
        postiz={"channels": ["chan-x"], "channel_settings": {"chan-x": {"thread_finisher": "yes"}}},
    )
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    settings = client.posts[0]["posts"][0]["settings"]
    assert settings["thread_finisher"] == "yes"
    # Still there, from the platform defaults, rather than replaced wholesale.
    assert settings["who_can_reply_post"] == "everyone"


def test_a_project_can_schedule_while_the_application_drafts(project_root):
    project_dir = write_project(project_root, [highlight()], postiz={"post_type": "schedule"})
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    assert client.posts[0]["type"] == "schedule"


def test_a_project_that_says_nothing_about_post_type_follows_the_application(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(
        project_dir, client, settings={"postiz_post_type": "now"}
    ).import_one(Project(PROJECT_ID), 0)

    assert client.posts[0]["type"] == "now"


def test_a_post_type_the_project_file_should_not_hold_is_ignored(project_root):
    # Straight into a request body otherwise, and Postiz has three values.
    project_dir = write_project(project_root, [highlight()], postiz={"post_type": "publish"})
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    assert client.posts[0]["type"] == "draft"


# --- When the drafts land ---------------------------------------------------

# The clock these run on: a Saturday in a timezone that is not UTC, so a test
# that gets the offset wrong cannot pass by accident. The same clock the
# uploader's schedule tests use, because the two schedules answer the same
# questions and are asserted against the same arithmetic.
TZ = timezone(timedelta(hours=2))


def at_hour(hour: int, minute: int = 0):
    """A clock pinned to one moment of that Saturday, on the user's own zone.

    Every assertion about which day a clip lands on depends on the time of day
    the run happens at, so left to the real clock these tests pass all morning
    and fail after tea — which is exactly how the day-shifting bug reached the
    suite unnoticed.
    """
    pinned = datetime(2026, 8, 22, hour, minute, tzinfo=TZ)
    return lambda: pinned


def as_local(value: str) -> datetime:
    """One Postiz date back on the clock the schedule was built on.

    Postiz is told UTC; the hours the user picked are theirs. Asserting on the
    wire format instead would make every expectation here a fact about the
    machine running the suite.
    """
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.000Z").replace(
        tzinfo=timezone.utc
    ).astimezone(TZ)


def local_days(dates):
    return [as_local(value).strftime("%Y-%m-%d") for value in dates]


def local_hours(dates):
    return [as_local(value).hour for value in dates]


def dates_for(project_dir, client, count, now=None, **settings):
    """The scheduled date of each clip, in clip order."""
    service = publisher(project_dir, client, settings=settings, now=now or at_hour(12))
    project = Project(PROJECT_ID)
    return [
        service.build_payload(project, project.highlights[i], client.integrations, {"id": "m"}, i)["date"]
        for i in range(count)
    ]


def test_everything_lands_at_once_unless_a_cadence_is_asked_for(project_root):
    # What an import did before there was a choice, and still the default.
    project_dir = write_project(project_root, [highlight(), highlight(), highlight()])

    dates = dates_for(project_dir, FakePostiz(), 3)

    assert len(set(dates)) == 1


def test_a_run_after_the_day_s_first_slot_moves_the_whole_schedule(project_root):
    # Shifting only the clips whose own slot had passed put them on the day the
    # next clip already had: an afternoon run of three at one a day produced
    # tomorrow, tomorrow, the day after — two clips on one day, from a setting
    # that says one.
    project_dir = write_project(project_root, [highlight(), highlight(), highlight()])

    days = local_days(dates_for(project_dir, FakePostiz(), 3, now=at_hour(15), postiz_per_day=1))

    assert days == ["2026-08-23", "2026-08-24", "2026-08-25"]


def test_a_run_before_the_day_s_first_slot_starts_today(project_root):
    project_dir = write_project(project_root, [highlight(), highlight()])

    days = local_days(dates_for(project_dir, FakePostiz(), 2, now=at_hour(6), postiz_per_day=1))

    assert days == ["2026-08-22", "2026-08-23"]


def test_no_two_clips_ever_share_a_slot(project_root):
    # Whatever the hour, `n` clips at `per_day` produce `n` distinct moments.
    project_dir = write_project(project_root, [highlight() for _ in range(6)])

    for hour in (0, 6, 9, 12, 15, 21, 23):
        dates = dates_for(project_dir, FakePostiz(), 6, now=at_hour(hour), postiz_per_day=2)
        assert len(set(dates)) == 6, f"a {hour}:00 run put two clips on one slot"
        assert dates == sorted(dates), f"a {hour}:00 run put the clips out of order"


def test_one_a_day_puts_each_clip_on_its_own_day(project_root):
    project_dir = write_project(project_root, [highlight(), highlight(), highlight()])

    days = local_days(dates_for(project_dir, FakePostiz(), 3, postiz_per_day=1))

    assert len(set(days)) == 3
    assert days == sorted(days)


def test_two_a_day_puts_two_on_each_day_at_different_hours(project_root):
    project_dir = write_project(project_root, [highlight() for _ in range(4)])

    dates = dates_for(project_dir, FakePostiz(), 4, postiz_per_day=2)
    days = local_days(dates)

    assert days[0] == days[1] and days[2] == days[3]
    assert days[0] != days[2]
    assert dates[0] != dates[1], "two on one day are not at the same minute"


def test_the_slots_are_hours_a_person_would_post_at(project_root):
    # Dividing a day evenly would put the second of two posts at 3am. The hours
    # are read back on the user's clock, which is the clock they were picked on.
    project_dir = write_project(project_root, [highlight(), highlight()])

    hours = local_hours(dates_for(project_dir, FakePostiz(), 2, postiz_per_day=2))

    assert hours == [9, 21]


def test_the_day_window_can_be_moved(project_root):
    project_dir = write_project(project_root, [highlight(), highlight(), highlight()])

    hours = local_hours(dates_for(
        project_dir, FakePostiz(), 3,
        postiz_per_day=3, postiz_day_start_hour=8, postiz_day_end_hour=16,
    ))

    assert hours == [8, 12, 16]


def test_a_project_can_drip_while_the_application_posts_everything_at_once(project_root):
    project_dir = write_project(project_root, [highlight(), highlight()], postiz={"per_day": 1})

    days = local_days(dates_for(project_dir, FakePostiz(), 2))

    assert len(set(days)) == 2


def test_a_project_can_say_all_at_once_while_the_application_drips(project_root):
    # 0 is an answer, not an absent one: it must not fall through to the app.
    project_dir = write_project(project_root, [highlight(), highlight()], postiz={"per_day": 0})

    days = dates_for(project_dir, FakePostiz(), 2, postiz_per_day=1)

    assert len(set(days)) == 1


# --- The calendar the project asked for -------------------------------------
#
# The same questions the YouTube panel asks, answered the same way: a project
# spread "two a day between nine and nine from Monday" has to land on one
# calendar whichever platform the clips go to.

def test_a_named_day_starts_the_run_at_the_first_hour_of_the_window(project_root):
    project_dir = write_project(project_root, [highlight()])

    dates = dates_for(
        project_dir, FakePostiz(), 1,
        postiz_schedule_start_date="2026-09-01", postiz_day_start_hour=8,
    )

    assert as_local(dates[0]).strftime("%Y-%m-%d %H:%M") == "2026-09-01 08:00"


def test_a_project_can_name_its_own_first_day(project_root):
    project_dir = write_project(
        project_root, [highlight()], postiz={"start_date": "2026-09-05"}
    )

    dates = dates_for(project_dir, FakePostiz(), 1, postiz_schedule_start_date="2026-09-01")

    assert local_days(dates) == ["2026-09-05"]


def test_a_project_can_move_its_own_day_window(project_root):
    project_dir = write_project(
        project_root, [highlight(), highlight()],
        postiz={"day_start_hour": 7, "day_end_hour": 11},
    )

    hours = local_hours(dates_for(
        project_dir, FakePostiz(), 2,
        postiz_per_day=2, postiz_day_start_hour=9, postiz_day_end_hour=21,
    ))

    assert hours == [7, 11]


def test_a_day_already_gone_does_not_file_posts_behind_the_user(project_root):
    # A date chosen last week is a calendar the user cannot cancel from. The
    # offset ahead of now is the floor, exactly as the upload lead is.
    project_dir = write_project(project_root, [highlight()])

    dates = dates_for(
        project_dir, FakePostiz(), 1, now=at_hour(14), postiz_schedule_start_date="2020-01-01"
    )

    assert as_local(dates[0]).strftime("%Y-%m-%d %H:%M") == "2026-08-22 15:00"


def test_a_date_nobody_can_read_imports_anyway(project_root):
    project_dir = write_project(project_root, [highlight()], postiz={"start_date": "next tuesday"})

    dates = dates_for(project_dir, FakePostiz(), 1, now=at_hour(14))

    assert as_local(dates[0]).strftime("%Y-%m-%d %H:%M") == "2026-08-22 15:00"


def test_a_clip_keeps_its_slot_however_it_was_imported(project_root):
    # The slot is the clip's position, not the order things happened in, so
    # re-importing one clip does not move it or land on top of another.
    project_dir = write_project(project_root, [highlight() for _ in range(3)])
    client = FakePostiz()

    first = dates_for(project_dir, client, 3, postiz_per_day=1)
    again = dates_for(project_dir, client, 3, postiz_per_day=1)

    assert first == again


# --- What the post says -----------------------------------------------------

def test_without_a_template_the_model_s_words_for_that_platform_are_used(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    said = [post["value"][0]["content"] for post in client.posts[0]["posts"]]
    assert said == ["the X post", "the LinkedIn post"]


def test_a_template_writes_every_post(project_root):
    project_dir = write_project(
        project_root, [highlight()],
        description={"source_title": "Episode 4", "source_url": "https://example.com/ep4"},
    )
    client = FakePostiz()

    publisher(project_dir, client, settings={
        "postiz_text_template": "{platform.post}\n\nFrom {project.source_title}",
    }).import_one(Project(PROJECT_ID), 0)

    said = [post["value"][0]["content"] for post in client.posts[0]["posts"]]
    assert said[0] == "the X post\n\nFrom Episode 4"
    assert said[1] == "the LinkedIn post\n\nFrom Episode 4"


def test_a_line_whose_fields_are_all_empty_disappears(project_root):
    # The same rule the YouTube description follows: no dangling label over an
    # empty space.
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(project_dir, client, settings={
        "postiz_text_template": "{platform.post}\nWatch it all: {project.source_url}",
    }).import_one(Project(PROJECT_ID), 0)

    assert client.posts[0]["posts"][0]["value"][0]["content"] == "the X post"


def test_a_project_can_write_its_posts_differently(project_root):
    project_dir = write_project(
        project_root, [highlight()], postiz={"text_template": "{highlights.viral_hook_text}"}
    )
    client = FakePostiz()

    publisher(project_dir, client, settings={
        "postiz_text_template": "the application's template",
    }).import_one(Project(PROJECT_ID), 0)

    assert client.posts[0]["posts"][0]["value"][0]["content"] == "the hook"


# --- The comment under the post ---------------------------------------------

def test_no_comment_unless_one_is_configured(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    assert len(client.posts[0]["posts"][0]["value"]) == 1


def test_the_link_goes_in_a_comment_under_the_post(project_root):
    # Platforms bury a post carrying an outbound link, so the video goes in the
    # post and the link goes underneath it.
    project_dir = write_project(
        project_root, [highlight()],
        description={"source_url": "https://example.com/ep4"},
    )
    client = FakePostiz()

    publisher(project_dir, client, settings={
        "postiz_comment_template": "Full episode: {project.source_url}",
    }).import_one(Project(PROJECT_ID), 0)

    value = client.posts[0]["posts"][0]["value"]
    assert len(value) == 2
    assert value[1]["content"] == "Full episode: https://example.com/ep4"
    # The video belongs to the post, not to its comment.
    assert value[1]["image"] == []


def test_a_comment_with_nothing_to_say_is_not_posted(project_root):
    # A project with no source URL must not get a comment reading "Full episode:".
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(project_dir, client, settings={
        "postiz_comment_template": "Full episode: {project.source_url}",
    }).import_one(Project(PROJECT_ID), 0)

    assert len(client.posts[0]["posts"][0]["value"]) == 1


def test_a_project_can_comment_differently(project_root):
    project_dir = write_project(
        project_root, [highlight()], postiz={"comment_template": "{highlights.viral_hook_text}"}
    )
    client = FakePostiz()

    publisher(project_dir, client, settings={
        "postiz_comment_template": "the application's comment",
    }).import_one(Project(PROJECT_ID), 0)

    assert client.posts[0]["posts"][0]["value"][1]["content"] == "the hook"


# --- Asking Postiz what became of the drafts --------------------------------

def filed(post_id, integration="chan-li", state="PUBLISHED", group="grp-1", release=None):
    """One entry as `GET /posts` returns it."""
    return {
        "id": post_id,
        "group": group,
        "state": state,
        "publishDate": "2026-08-22T06:38:00.000Z",
        "releaseURL": release,
        "integration": {
            "id": integration,
            "providerIdentifier": "linkedin",
            "name": "Coffee and Bytes",
        },
    }


def imported(**overrides):
    """A highlight that has already been filed in Postiz."""
    data = {
        "postiz_post_id": "post-1",
        "postiz_group": "grp-1",
        "postiz_url": "https://postiz.example.com",
        "postiz_imported_at": "2026-08-22T08:37:12",
        "postiz_channels": [{"id": "chan-li", "name": "Coffee and Bytes", "platform": "linkedin"}],
    }
    data.update(overrides)
    return highlight(**data)


def test_a_project_with_nothing_in_postiz_is_not_asked_about(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    result = publisher(project_dir, client).sync(Project(PROJECT_ID))

    assert result["checked"] is False
    assert client.windows == [], "no request is made about a project with no posts"


def test_a_published_clip_stops_reading_as_waiting(project_root):
    # The whole point: a draft that went out an hour ago said "waiting in
    # Postiz" forever, because nothing tells this application when one is sent.
    live = "https://www.linkedin.com/feed/update/urn:li:ugcPost:7496818227612880896"
    project_dir = write_project(project_root, [imported()])
    client = FakePostiz()
    client.filed_posts = [filed("post-1", state="PUBLISHED", release=live)]

    publisher(project_dir, client).sync(Project(PROJECT_ID))

    stored = read_metadata()["highlights"][0]
    assert stored["postiz_state"] == "published"
    assert stored["postiz_synced_at"]
    # The post on the platform itself, which is the only link worth following
    # once something is out.
    assert stored["postiz_channels"][0]["url"] == live
    assert stored["postiz_channels"][0]["state"] == "published"


def test_a_post_still_waiting_its_turn_reads_as_scheduled(project_root):
    project_dir = write_project(project_root, [imported()])
    client = FakePostiz()
    client.filed_posts = [filed("post-1", state="QUEUE")]

    publisher(project_dir, client).sync(Project(PROJECT_ID))

    assert read_metadata()["highlights"][0]["postiz_state"] == "scheduled"


def test_a_send_that_failed_is_the_state_that_wins(project_root):
    # A post whose channels disagree is described by the one the user has to
    # act on, not by an average.
    project_dir = write_project(project_root, [imported(
        postiz_channels=[
            {"id": "chan-li", "name": "Page", "platform": "linkedin"},
            {"id": "chan-x", "name": "My X", "platform": "x"},
        ],
    )])
    client = FakePostiz()
    client.filed_posts = [
        filed("post-1", integration="chan-li", state="PUBLISHED", release="https://li.example/1"),
        filed("post-2", integration="chan-x", state="ERROR"),
    ]

    publisher(project_dir, client).sync(Project(PROJECT_ID))

    stored = read_metadata()["highlights"][0]
    assert stored["postiz_state"] == "error"
    states = {entry["id"]: entry["state"] for entry in stored["postiz_channels"]}
    assert states == {"chan-li": "published", "chan-x": "error"}


def test_a_link_to_a_page_that_shows_nothing_is_replaced_even_when_unmatched(project_root):
    # Records filed by an earlier version carry `/p/{id}`, which answers 200 and
    # renders an empty page. Healing it only on matched clips left every draft
    # in the project pointing at nowhere — which is where they mostly are, since
    # drafts are exactly what Postiz will not talk about.
    project_dir = write_project(project_root, [imported(
        postiz_url="https://postiz.example.com/p/post-1",
    )])
    client = FakePostiz()
    client.filed_posts = []

    publisher(project_dir, client).sync(Project(PROJECT_ID))

    assert read_metadata()["highlights"][0]["postiz_url"] == "https://postiz.example.com"


def test_a_clip_whose_post_is_not_in_postiz_stops_claiming_to_be(project_root):
    # The failure this exists for: nine clips read as filed in Postiz, each
    # linking to a page that showed nothing, when Postiz held no such post.
    # Missing from the window was treated as "probably a draft" and the record
    # was kept — so the clip looked done, and the only thing that would have
    # actually filed it was the re-import nobody knew to do.
    project_dir = write_project(project_root, [imported()])
    client = FakePostiz()
    client.filed_posts = []
    client.existence_default = False

    result = publisher(project_dir, client).sync(Project(PROJECT_ID))

    stored = read_metadata()["highlights"][0]
    assert stored["postiz_post_id"] is None
    assert stored["postiz_url"] is None
    assert stored["postiz_channels"] == []
    assert stored["postiz_imported_at"] is None
    assert result["clips"][0]["gone"] is True


def test_the_video_already_in_postiz_survives_the_post_being_forgotten(project_root):
    # Postiz still holds the upload; a re-import should not send forty
    # megabytes again to replace something that is already there.
    project_dir = write_project(project_root, [imported(
        postiz_media_id="media-1",
        postiz_media_fingerprint="1:abc",
    )])
    client = FakePostiz()
    client.existence_default = False

    publisher(project_dir, client).sync(Project(PROJECT_ID))

    stored = read_metadata()["highlights"][0]
    assert stored["postiz_media_id"] == "media-1"
    assert stored["postiz_media_fingerprint"] == "1:abc"


def test_a_real_draft_is_kept_even_though_it_is_missing_from_the_window(project_root):
    # The other side of the same coin: drafts are never in `GET /posts`, and a
    # draft that is really there must not be thrown away with the ones that are
    # not.
    project_dir = write_project(project_root, [imported()])
    client = FakePostiz()
    client.filed_posts = []
    client.existence_default = True

    result = publisher(project_dir, client).sync(Project(PROJECT_ID))

    stored = read_metadata()["highlights"][0]
    assert stored["postiz_post_id"] == "post-1"
    assert result["clips"][0]["known"] is False


def test_a_post_that_could_not_be_asked_about_is_left_alone(project_root):
    # A network fault is not evidence that anything was deleted.
    project_dir = write_project(project_root, [imported()])
    client = FakePostiz()
    client.filed_posts = []
    client.existence_default = None

    publisher(project_dir, client).sync(Project(PROJECT_ID))

    assert read_metadata()["highlights"][0]["postiz_post_id"] == "post-1"


def test_a_clip_deleted_from_one_channel_only_is_still_in_postiz(project_root):
    # Any, not all: one channel's post surviving means the clip is still filed.
    project_dir = write_project(project_root, [imported(
        postiz_channels=[
            {"id": "chan-li", "name": "Page", "platform": "linkedin", "post_id": "post-1"},
            {"id": "chan-x", "name": "My X", "platform": "x", "post_id": "post-2"},
        ],
    )])
    client = FakePostiz()
    client.filed_posts = []
    client.existence = {"post-1": False, "post-2": True}

    publisher(project_dir, client).sync(Project(PROJECT_ID))

    assert read_metadata()["highlights"][0]["postiz_post_id"] == "post-1"


def test_a_clip_answered_for_by_the_window_is_never_asked_about_again(project_root):
    # The existence check costs a request per clip, and a post that came back
    # in the window has already proved it exists.
    project_dir = write_project(project_root, [imported()])
    client = FakePostiz()
    client.filed_posts = [filed("post-1", state="PUBLISHED", release="https://li.example/1")]

    publisher(project_dir, client).sync(Project(PROJECT_ID))

    assert client.existence_asked == []


def test_a_draft_postiz_will_not_talk_about_is_left_exactly_as_it_was(project_root):
    # Drafts come back from nothing: not `GET /posts`, and there is no per-post
    # route to ask instead. Absence is silence, not deletion — clearing on it
    # would throw away every draft in the project.
    project_dir = write_project(project_root, [imported()])
    client = FakePostiz()
    client.filed_posts = []

    result = publisher(project_dir, client).sync(Project(PROJECT_ID))

    stored = read_metadata()["highlights"][0]
    assert stored["postiz_post_id"] == "post-1"
    assert stored["postiz_state"] is None
    assert result["clips"][0]["known"] is False


def test_a_clip_is_found_by_any_of_the_ids_its_channels_were_given(project_root):
    # The first channel's post can still be a draft — invisible to Postiz's API
    # — while the second is out. Matching only on the first id would report a
    # published clip as unanswered-for.
    project_dir = write_project(project_root, [imported(
        postiz_group=None,
        postiz_post_id="post-1",
        postiz_channels=[
            {"id": "chan-x", "name": "My X", "platform": "x", "post_id": "post-1"},
            {"id": "chan-li", "name": "Page", "platform": "linkedin", "post_id": "post-2"},
        ],
    )])
    client = FakePostiz()
    # Only the LinkedIn one comes back; the X one is still a draft.
    client.filed_posts = [
        filed("post-2", integration="chan-li", state="PUBLISHED", release="https://li.example/2")
    ]

    publisher(project_dir, client).sync(Project(PROJECT_ID))

    stored = read_metadata()["highlights"][0]
    assert stored["postiz_state"] == "published"
    states = {entry["id"]: entry.get("state") for entry in stored["postiz_channels"]}
    assert states == {"chan-x": None, "chan-li": "published"}


def test_a_clip_with_only_one_stored_id_is_still_matched_by_it(project_root):
    project_dir = write_project(project_root, [imported(postiz_group=None)])
    client = FakePostiz()
    client.filed_posts = [filed("post-1", state="PUBLISHED", release="https://li.example/1")]

    publisher(project_dir, client).sync(Project(PROJECT_ID))

    assert read_metadata()["highlights"][0]["postiz_state"] == "published"


# A clip filed before every channel's id was kept knows one of them. Its
# siblings cannot be found by group — Postiz gives each channel its own — so
# they are recognised by sharing the matched post's exact publish time on a
# channel this clip was filed to.
def test_the_other_channels_of_an_old_record_are_found_by_their_publish_time(project_root):
    live = "https://www.linkedin.com/feed/update/urn:li:ugcPost:749"
    project_dir = write_project(project_root, [imported(
        postiz_channels=[
            {"id": "chan-li", "name": "Page", "platform": "linkedin"},
            {"id": "chan-me", "name": "Me", "platform": "linkedin"},
        ],
    )])
    client = FakePostiz()
    client.filed_posts = [
        # The one the record knows about, and its sibling under another group.
        filed("post-1", integration="chan-li", state="PUBLISHED", release=live),
        filed("post-2", integration="chan-me", state="PUBLISHED", group="grp-2",
              release="https://li.example/me"),
    ]

    publisher(project_dir, client).sync(Project(PROJECT_ID))

    stored = read_metadata()["highlights"][0]
    states = {entry["id"]: entry.get("state") for entry in stored["postiz_channels"]}
    assert states == {"chan-li": "published", "chan-me": "published"}
    # And its id is kept, so the next sync finds it without the correlation.
    assert [entry.get("post_id") for entry in stored["postiz_channels"]] == ["post-1", "post-2"]


def test_a_post_at_another_time_is_not_claimed_as_this_clip_s(project_root):
    # The correlation is exact on the minute for a reason: anything looser
    # starts claiming other posts on the same account.
    project_dir = write_project(project_root, [imported(
        postiz_channels=[
            {"id": "chan-li", "name": "Page", "platform": "linkedin"},
            {"id": "chan-me", "name": "Me", "platform": "linkedin"},
        ],
    )])
    client = FakePostiz()
    other = filed("post-9", integration="chan-me", state="PUBLISHED", group="grp-9")
    other["publishDate"] = "2026-08-19T11:00:00.000Z"
    client.filed_posts = [filed("post-1", integration="chan-li", state="PUBLISHED"), other]

    publisher(project_dir, client).sync(Project(PROJECT_ID))

    stored = read_metadata()["highlights"][0]
    states = {entry["id"]: entry.get("state") for entry in stored["postiz_channels"]}
    assert states == {"chan-li": "published", "chan-me": None}


def test_one_request_covers_the_whole_project(project_root):
    # Not one per clip: a project is twenty clips and the window is the same
    # for all of them.
    project_dir = write_project(project_root, [imported(), imported(postiz_post_id="post-2")])
    client = FakePostiz()
    client.filed_posts = [filed("post-1"), filed("post-2", group="grp-2")]

    publisher(project_dir, client).sync(Project(PROJECT_ID))

    assert len(client.windows) == 1


def test_the_window_reaches_back_before_now_and_well_past_it(project_root):
    # Back for a post published before anybody asked, forward for a project
    # dripped out at one clip a day.
    project_dir = write_project(project_root, [imported()])
    client = FakePostiz()

    publisher(project_dir, client).sync(Project(PROJECT_ID))

    start, end = client.windows[0]
    now = datetime.now(timezone.utc)
    assert start < now < end
    assert (end - start).days > 365


def test_a_fresh_import_forgets_what_the_last_sync_said(project_root):
    # The state described a post that no longer exists.
    project_dir = write_project(project_root, [imported(
        postiz_state="published", postiz_synced_at="2026-08-22T09:00:00",
    )])
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    stored = read_metadata()["highlights"][0]
    assert stored["postiz_state"] is None
    assert stored["postiz_synced_at"] is None


# --- What creating the post already told us ---------------------------------

def test_every_channel_keeps_the_post_id_it_was_given(project_root):
    # Postiz answers a create with one entry per channel. An earlier version
    # kept the first and dropped the rest, so five ids out of six were lost the
    # moment they arrived — and then had to be asked for again by a sync.
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    stored = read_metadata()["highlights"][0]
    assert [(entry["id"], entry["post_id"]) for entry in stored["postiz_channels"]] == [
        ("chan-x", "post-1"),
        ("chan-li", "post-2"),
    ]


def test_the_group_is_kept_from_the_creation_rather_than_asked_for_later(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    assert read_metadata()["highlights"][0]["postiz_group"] == "grp-1"


def test_ids_are_matched_to_channels_by_position_when_that_is_all_there_is(project_root):
    # A Postiz that answers without naming the integration. The entries come
    # back in the order the channels were sent, and a wrong pairing here would
    # point a clip's LinkedIn record at its X post.
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()
    client.create_post = lambda payload: [{"id": "first"}, {"id": "second"}]

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    stored = read_metadata()["highlights"][0]
    assert [(entry["id"], entry["post_id"]) for entry in stored["postiz_channels"]] == [
        ("chan-x", "first"),
        ("chan-li", "second"),
    ]


def test_a_channel_the_answer_says_nothing_about_is_not_given_another_s_id(project_root):
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz()
    client.create_post = lambda payload: [
        {"id": "only-one", "integration": {"id": "chan-li"}}
    ]

    publisher(project_dir, client).import_one(Project(PROJECT_ID), 0)

    stored = read_metadata()["highlights"][0]
    by_channel = {entry["id"]: entry.get("post_id") for entry in stored["postiz_channels"]}
    assert by_channel == {"chan-x": None, "chan-li": "only-one"}


def test_an_answer_that_is_a_bare_object_still_works(project_root):
    # Whatever shape a given Postiz version answers in, one entry is a list of
    # one as far as this app is concerned.
    project_dir = write_project(project_root, [highlight()])
    client = FakePostiz([{"id": "chan-x", "name": "My X", "identifier": "x"}])
    client.create_post = lambda payload: {"id": "solo", "group": "grp-9"}

    publisher(
        project_dir, client, settings={"postiz_channels": ["chan-x"]}
    ).import_one(Project(PROJECT_ID), 0)

    stored = read_metadata()["highlights"][0]
    assert stored["postiz_post_id"] == "solo"
    assert stored["postiz_group"] == "grp-9"

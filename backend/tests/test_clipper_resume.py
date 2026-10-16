"""Cover for the clipper picking up where it left off, and for saying so.

`execute` itself needs a real video and a real engine, so what is covered here
is the two pieces of judgement it delegates: which highlights still need cutting
(`has_clip`) and what the step badge says afterwards (`_settle`).
"""

import json
from datetime import datetime
from pathlib import Path

import pytest

from backend.src.dataclasses.data import Project
from backend.src.services.clipper import Clipper

PROJECT_ID = "test-project"


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
        "is_clip_generated": False,
        "generated_clip_filename": None,
    }
    data.update(overrides)
    return data


def cut(index: int):
    """A highlight whose metadata says it has been cut."""
    return highlight(is_clip_generated=True, generated_clip_filename=f"clip_{index:03d}.mp4")


def write_project(root: Path, highlights):
    project_dir = root / "projects" / PROJECT_ID
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "metadata.json").write_text(json.dumps({
        "project_id": PROJECT_ID,
        "name": "Test Project",
        "created_at": datetime.now().isoformat(),
        "files": {},
        "highlights": highlights,
        "video_metadata": {"components": [], "top_recommendations": []},
        "settings": {"aspect_ratio": "9:16", "resolution": "1080p"},
        "status": None,
        "step_statuses": {},
    }))
    return project_dir


def write_clip(project_dir: Path, index: int):
    clips = project_dir / "clips"
    clips.mkdir(exist_ok=True)
    (clips / f"clip_{index:03d}.mp4").write_bytes(b"not really an mp4")


@pytest.fixture
def project_root(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


def read_metadata() -> dict:
    return json.loads((Path("projects") / PROJECT_ID / "metadata.json").read_text())


# --- Which highlights still need cutting ------------------------------------

def test_a_cut_under_the_current_settings_matches(project_root):
    write_project(project_root, [cut(0) | {"rendered_aspect_ratio": "9:16", "rendered_resolution": "1080p"}])
    project = Project(PROJECT_ID)
    assert Clipper.matches_output(project, project.highlights[0]) is True


def test_a_crop_cut_does_not_match_a_stacked_project(project_root):
    """Switching to stacked has to re-cut on resume, or the files stay crops."""
    write_project(project_root, [cut(0) | {"rendered_aspect_ratio": "9:16", "rendered_resolution": "1080p"}])
    project = Project(PROJECT_ID)
    project.settings.layout = "stacked"
    assert Clipper.matches_output(project, project.highlights[0]) is False


def test_a_cut_under_another_ratio_does_not_match(project_root):
    write_project(project_root, [cut(0) | {"rendered_aspect_ratio": "16:9", "rendered_resolution": "1080p"}])
    project = Project(PROJECT_ID)
    assert Clipper.matches_output(project, project.highlights[0]) is False


def test_a_cut_that_recorded_nothing_is_taken_at_its_word(project_root):
    write_project(project_root, [cut(0)])
    project = Project(PROJECT_ID)
    project.settings.layout = "stacked"
    assert Clipper.matches_output(project, project.highlights[0]) is True


def test_a_highlight_with_its_file_on_disk_is_already_cut(project_root):
    project_dir = write_project(project_root, [cut(0)])
    write_clip(project_dir, 0)

    project = Project(PROJECT_ID)
    assert Clipper().has_clip(project, project.highlights[0]) is True


def test_a_highlight_whose_file_was_deleted_is_not_cut(project_root):
    # The metadata alone lies after a clips directory is removed from under the
    # project, which is exactly when a resume most needs to re-cut.
    write_project(project_root, [cut(0)])

    project = Project(PROJECT_ID)
    assert Clipper().has_clip(project, project.highlights[0]) is False


def test_a_highlight_nobody_has_cut_is_not_cut(project_root):
    write_project(project_root, [highlight()])

    project = Project(PROJECT_ID)
    assert Clipper().has_clip(project, project.highlights[0]) is False


# --- What the badge says afterwards -----------------------------------------

def test_every_clip_on_disk_completes_the_step(project_root):
    project_dir = write_project(project_root, [cut(0), cut(1)])
    write_clip(project_dir, 0)
    write_clip(project_dir, 1)

    Clipper()._settle(Project(PROJECT_ID), [])

    assert read_metadata()["step_statuses"]["clipper"] == "completed"


def test_some_clips_on_disk_leaves_the_step_partial(project_root):
    # The bug this exists for: two of three cut used to read as "done", and
    # nothing on the page said the third was never made.
    project_dir = write_project(project_root, [cut(0), cut(1), highlight()])
    write_clip(project_dir, 0)
    write_clip(project_dir, 1)

    Clipper()._settle(Project(PROJECT_ID), ["ffmpeg fell over"])

    metadata = read_metadata()
    assert metadata["step_statuses"]["clipper"] == "partial"
    reason = metadata["step_errors"]["clipper"]
    assert "1 of 3 clips have no file yet" in reason
    assert "ffmpeg fell over" in reason
    assert "Run this step again" in reason


def test_no_clip_on_disk_fails_the_step(project_root):
    write_project(project_root, [highlight(), highlight()])

    Clipper()._settle(Project(PROJECT_ID), ["ffmpeg fell over"])

    metadata = read_metadata()
    assert metadata["step_statuses"]["clipper"] == "error"
    assert "ffmpeg fell over" in metadata["step_errors"]["clipper"]


def test_a_resume_that_cut_nothing_because_nothing_was_missing_is_done(project_root):
    # No failures and no work: judged on the files, not on the tally.
    project_dir = write_project(project_root, [cut(0)])
    write_clip(project_dir, 0)

    Clipper()._settle(Project(PROJECT_ID), [])

    assert read_metadata()["step_statuses"]["clipper"] == "completed"


# --- What a resume must not throw away --------------------------------------

def test_a_resume_leaves_the_clips_already_on_disk_alone(project_root):
    project_dir = write_project(project_root, [cut(0), highlight()])
    write_clip(project_dir, 0)

    Clipper().start_service(Project(PROJECT_ID), full=False)

    assert (project_dir / "clips" / "clip_000.mp4").exists()
    metadata = read_metadata()
    assert metadata["step_statuses"]["clipper"] == "running"
    assert metadata["highlights"][0]["generated_clip_filename"] == "clip_000.mp4"


def test_a_full_run_throws_the_clips_directory_away(project_root):
    project_dir = write_project(project_root, [cut(0)])
    write_clip(project_dir, 0)

    Clipper().start_service(Project(PROJECT_ID), full=True)

    assert not (project_dir / "clips" / "clip_000.mp4").exists()
    assert read_metadata()["highlights"][0]["is_clip_generated"] is False

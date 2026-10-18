"""Nudging one clip's start and end without disturbing anything else.

A highlight the model picked is usually a second or two off at one edge, and the
fix is to move that edge — not to re-run the step and lose every other clip. The
window is the only thing a trim may touch: the file on disk still holds the old
cut until somebody renders it again, which is what `trimmed_at` is there to say.
"""

import json
from datetime import datetime
from pathlib import Path

import pytest

from backend.src.dataclasses.data import CLIP_MIN_DURATION, Project

PROJECT_ID = "test-project"


def highlight(text: str, start: float, end: float, **extra):
    return {
        "highlight_text": text,
        "viral_hook_text": "hook",
        "video_description_for_x": "",
        "video_description_for_reddit": "",
        "video_description_for_linkedin": "",
        "video_title_for_youtube_short": "",
        "start": start,
        "end": end,
        **extra,
    }


@pytest.fixture
def project_root(tmp_path, monkeypatch):
    project_dir = tmp_path / "projects" / PROJECT_ID
    project_dir.mkdir(parents=True)
    metadata = {
        "project_id": PROJECT_ID,
        "name": "Test Project",
        "created_at": datetime.now().isoformat(),
        "files": {},
        "highlights": [
            highlight("first", 10.0, 30.0),
            highlight(
                "second",
                60.0,
                80.0,
                is_clip_generated=True,
                generated_clip_filename="clip_001.mp4",
                rendered_at="2026-01-01T00:00:00",
            ),
        ],
        "video_metadata": {"components": [], "top_recommendations": []},
        "settings": {"aspect_ratio": "16:9", "resolution": "1080p"},
        "status": None,
        "step_statuses": {},
    }
    (project_dir / "metadata.json").write_text(json.dumps(metadata))
    monkeypatch.chdir(tmp_path)
    return tmp_path


def read_highlights() -> list:
    return json.loads((Path("projects") / PROJECT_ID / "metadata.json").read_text())["highlights"]


def test_moves_both_edges_of_the_clip_the_grid_pointed_at(project_root):
    Project(PROJECT_ID).trim_highlight(0, 12.5, 28.0)

    stored = read_highlights()
    assert (stored[0]["start"], stored[0]["end"]) == (12.5, 28.0)
    # The neighbour is untouched: a trim is about one card.
    assert (stored[1]["start"], stored[1]["end"]) == (60.0, 80.0)


def test_the_in_memory_project_matches_what_was_written(project_root):
    project = Project(PROJECT_ID)
    project.trim_highlight(0, 11.0, 29.0)

    assert (project.highlights[0].start, project.highlights[0].end) == (11.0, 29.0)


def test_a_trim_stamps_the_clip_as_ahead_of_its_rendered_file(project_root):
    Project(PROJECT_ID).trim_highlight(1, 61.0, 79.0)

    stored = read_highlights()[1]
    # The file is untouched, so the grid has to be able to see that the numbers
    # beside it have moved on.
    assert stored["generated_clip_filename"] == "clip_001.mp4"
    assert stored["is_clip_generated"] is True
    assert stored["trimmed_at"] > stored["rendered_at"]


def test_a_negative_start_is_pulled_up_to_the_start_of_the_source(project_root):
    Project(PROJECT_ID).trim_highlight(0, -4.0, 20.0)

    assert read_highlights()[0]["start"] == 0.0


def test_a_window_shorter_than_the_minimum_is_refused(project_root):
    before = read_highlights()

    with pytest.raises(ValueError):
        Project(PROJECT_ID).trim_highlight(0, 10.0, 10.0 + CLIP_MIN_DURATION / 2)

    assert read_highlights() == before


def test_an_inverted_window_is_refused(project_root):
    with pytest.raises(ValueError):
        Project(PROJECT_ID).trim_highlight(0, 30.0, 10.0)

    assert read_highlights()[0]["start"] == 10.0


def test_a_missing_number_is_refused_rather_than_stored(project_root):
    before = read_highlights()

    with pytest.raises(ValueError):
        Project(PROJECT_ID).trim_highlight(0, None, 30.0)

    assert read_highlights() == before


def test_out_of_range_index_changes_nothing(project_root):
    before = read_highlights()

    with pytest.raises(IndexError):
        Project(PROJECT_ID).trim_highlight(5, 1.0, 9.0)

    assert read_highlights() == before


def test_negative_index_changes_nothing(project_root):
    before = read_highlights()

    with pytest.raises(IndexError):
        Project(PROJECT_ID).trim_highlight(-1, 1.0, 9.0)

    assert read_highlights() == before


def test_a_concurrent_status_write_is_not_rolled_back(project_root):
    project = Project(PROJECT_ID)  # snapshot taken before the status write
    Project(PROJECT_ID).set_step_status("clipper", "completed")

    project.trim_highlight(0, 12.0, 28.0)

    stored = json.loads((Path("projects") / PROJECT_ID / "metadata.json").read_text())
    assert stored["step_statuses"] == {"clipper": "completed"}
    assert stored["highlights"][0]["start"] == 12.0

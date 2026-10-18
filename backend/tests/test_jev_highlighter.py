"""Jev highlight finding, against a fake Jev: windows, selection, loop cut, client retries."""

import io
import json
import urllib.error
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.src.dataclasses.data import Highlight, HighlightSettings
from backend.src.infrastructure import typesafe_client
from backend.src.infrastructure.typesafe_client import TypeSafeClient, TypeSafeError
from backend.src.services import highlight_options
from backend.src.services.highlight_options import HighlightOptions
from backend.src.services.jev_highlighter import (
    SCORES_FILE,
    JevHighlighter,
    build_sentences,
    build_windows,
    combined_score,
    relative_scores,
    select_moments,
    tags_for,
)
from backend.src.services.llm_query import JEV_TEXTS_TEMPLATE, LLMQuery, build_prompt
from backend.src.services.llm_tasks import discover_tasks


def words(text, start=0.0, step=0.5, pause_after=()):
    """Word-map entries for `text`, one word every `step` seconds."""
    entries, t = [], start
    for index, word in enumerate(text.split()):
        entries.append(SimpleNamespace(word=word, start=t, end=t + step * 0.8))
        t += step + (2.0 if index in pause_after else 0.0)
    return entries


class FakeProject:
    def __init__(self, entries, folder: Path):
        self.word_map = SimpleNamespace(entries=entries)
        self.folder = folder
        self.project_id = "fake"

    def metadata_path(self):
        return self.folder / "metadata.json"


class FakeJev:
    """Says yes to any clip mentioning 'secret', and picks the loop word 'why'."""

    def __init__(self):
        self.requests = []

    def system_one(self, state, questions):
        self.requests.append(questions)
        answers = {}
        for key, question in questions.items():
            if question["type"] == "noul":
                answers[key] = {"type": "noul", "noul": 0.9 if "secret" in question["instructions"] else 0.1}
            else:
                why = [k for k, text in question["criteria"].items() if text.startswith('"why ')]
                probabilities = {k: 0.0 for k in question["criteria"]}
                if why:
                    probabilities[why[0]] = 0.8
                    probabilities["none"] = 0.2
                else:
                    probabilities["none"] = 1.0
                answers[key] = {"type": "choice", "probabilities": probabilities}
        return {"answers": answers, "usage": {"input_tokens": 1}}


OPTIONS = HighlightOptions(min_clips=1, max_clips=3, min_duration=4.0, max_duration=12.0, guidance="")


def test_sentences_split_on_punctuation_and_long_pauses():
    entries = words("one two. three four five six", pause_after=(3,))

    assert [s["text"] for s in build_sentences(entries)] == ["one two.", "three four", "five six"]


def test_windows_stay_inside_the_duration_limits():
    entries = words(" ".join(f"w{i}." for i in range(60)))
    windows = build_windows(build_sentences(entries), 4.0, 12.0)

    assert windows
    assert all(4.0 <= w["end"] - w["start"] <= 12.0 for w in windows)


def test_selection_is_best_first_without_overlaps():
    windows = [
        {"start": 0, "end": 10, "score": 0.9},
        {"start": 5, "end": 15, "score": 0.8},  # overlaps the best one
        {"start": 20, "end": 30, "score": 0.5},
    ]

    assert [w["start"] for w in select_moments(windows, 1, 3)] == [0, 20]


def test_min_score_stops_the_list_but_never_below_the_fewest_clips():
    windows = [
        {"start": 0, "end": 10, "score": 0.2},
        {"start": 20, "end": 30, "score": 0.1},
    ]

    assert len(select_moments(windows, 1, 3, min_score=0.5)) == 1
    assert len(select_moments(windows, 2, 3, min_score=0.5)) == 2


def test_the_interesting_moment_ranks_first_and_cuts_on_the_loop_word(tmp_path):
    dull = " ".join(f"filler{i}." for i in range(40))
    interesting = "nobody patches their routers. the secret is out. that is exactly why"
    entries = words(f"{dull} {interesting} {dull}")
    highlighter = JevHighlighter(FakeJev())

    moments = highlighter.find_moments(FakeProject(entries, tmp_path), OPTIONS)
    best = max(moments, key=lambda m: m["score"])
    highlighter.choose_cut(best, OPTIONS)
    payload = highlighter.payload(best, "run-1")

    assert "secret" in payload["highlight_text"]
    assert payload["highlight_text"].endswith("why")
    assert payload["jev_scores"]["loop_used"] is True
    assert payload["jev_scores"]["run"] == "run-1"
    assert payload["jev_scores"]["relative"] == 1.0
    assert payload["jev_scores"]["tags"] == ["great_hook", "attention_grabber", "stands_alone"]
    assert payload["end"] == next(e.end for e in entries if e.word == "why")
    saved = json.loads((tmp_path / SCORES_FILE).read_text())
    assert saved["windows"] and saved["moments"]


def test_the_score_weights_hook_50_attention_40_standalone_10():
    score = combined_score({"hook": 0.60, "attention": 0.80, "standalone": 0.30})

    assert score == pytest.approx(0.5 * 0.60 + 0.4 * 0.80 + 0.1 * 0.30)


def test_scores_are_stretched_so_the_videos_best_is_1_and_weakest_0():
    moments = [{"score": 0.3}, {"score": 0.45}, {"score": 0.6}]

    relative_scores(moments)

    assert [m["relative"] for m in moments] == pytest.approx([0.0, 0.5, 1.0])


def test_tags_go_to_raw_answers_of_80_or_more():
    assert tags_for({"hook": 0.81, "attention": 0.79, "standalone": 0.80}) == ["great_hook", "stands_alone"]


def test_the_loop_decides_the_cut_but_not_the_score(tmp_path):
    entries = words(" ".join(f"filler{i}." for i in range(40)) + " the secret is out. that is exactly why")
    highlighter = JevHighlighter(FakeJev())
    moments = highlighter.find_moments(FakeProject(entries, tmp_path), OPTIONS)
    best = max(moments, key=lambda m: m["score"])
    before = best["score"]

    highlighter.choose_cut(best, OPTIONS)

    assert best["loop"]["loop_used"] is True
    assert best["score"] == before == pytest.approx(combined_score(best["parts"]))
    assert set(best["parts"]) == {"hook", "standalone", "attention"}


def test_every_non_overlapping_moment_is_kept(tmp_path):
    entries = words(" ".join(f"plain{i}." for i in range(60)))

    moments = JevHighlighter(FakeJev()).find_moments(FakeProject(entries, tmp_path), OPTIONS)

    # More than max_clips (3): the cutoff, not the run, decides which are clips.
    assert len(moments) > OPTIONS.max_clips
    spans = sorted((m["start"], m["end"]) for m in moments)
    assert all(a_end <= b_start for (_, a_end), (b_start, _) in zip(spans, spans[1:]))


def test_a_moment_without_a_good_loop_keeps_its_natural_end(tmp_path):
    entries = words(" ".join(f"plain{i}." for i in range(60)))
    highlighter = JevHighlighter(FakeJev())

    moments = highlighter.find_moments(FakeProject(entries, tmp_path), OPTIONS)
    for moment in moments:
        highlighter.choose_cut(moment, OPTIONS)

    assert all(m["loop"]["loop_used"] is False and m["cut_end"] == m["end"] for m in moments)


def test_the_cutoff_compares_the_score_relative_to_the_video(monkeypatch):
    monkeypatch.setattr(highlight_options.settings_manager, "get", lambda key, default=None: None)
    project = scored_project([0.3, 0.4], cutoff=0.5)
    project.highlights[0].jev_scores["relative"] = 1.0
    project.highlights[1].jev_scores["relative"] = 0.0

    assert highlight_options.selected_indices(project) == {0}


def scored_project(scores, cutoff=None, min_clips=None):
    highlights = [SimpleNamespace(jev_scores={"score": s} if s is not None else None) for s in scores]
    own = HighlightSettings(min_clips=min_clips, jev_min_score=cutoff)
    return SimpleNamespace(highlights=highlights, settings=SimpleNamespace(highlights=own))


def test_clips_are_the_moments_at_or_above_the_cutoff(monkeypatch):
    monkeypatch.setattr(highlight_options.settings_manager, "get", lambda key, default=None: None)

    assert highlight_options.selected_indices(scored_project([0.6, 0.2, 0.5, 0.1], cutoff=0.5, min_clips=1)) == {0, 2}


def test_no_clip_below_the_cutoff_is_added_however_few_pass(monkeypatch):
    monkeypatch.setattr(highlight_options.settings_manager, "get", lambda key, default=None: None)

    assert highlight_options.selected_indices(scored_project([0.49, 0.37, 0.4], cutoff=0.5, min_clips=7)) == set()


def test_the_project_cutoff_falls_back_to_the_application_one(monkeypatch):
    monkeypatch.setattr(
        highlight_options.settings_manager, "get",
        lambda key, default=None: 0.3 if key == "jev_min_score" else None,
    )

    assert highlight_options.selected_indices(scored_project([0.6, 0.2, 0.4], min_clips=1)) == {0, 2}


def test_highlights_without_jev_scores_are_always_clips():
    assert highlight_options.selected_indices(scored_project([None, None])) == {0, 1}


def test_a_batch_fills_in_titles_but_leaves_a_trimmed_window_alone(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    folder = tmp_path / "projects" / "p1"
    folder.mkdir(parents=True)
    run = {"score": 0.5, "loop": None, "loop_used": False, "run": "r1"}
    folder.joinpath("metadata.json").write_text(json.dumps({
        "project_id": "p1", "name": "p", "created_at": "2026-10-17T09:00:00",
        "files": {}, "settings": {}, "step_statuses": {},
        "video_metadata": {"components": [], "top_recommendations": []},
        "highlights": [
            {"highlight_text": "a b", "start": 1.0, "end": 9.0, "jev_scores": run},
            {"highlight_text": "c d", "start": 20.0, "end": 29.0, "jev_scores": run,
             "trimmed_at": "2026-10-17T10:00:00"},
            {"highlight_text": "old run", "start": 40.0, "end": 49.0, "jev_scores": {**run, "run": "r0"}},
        ],
    }))
    looped = {**run, "loop": 0.7, "loop_used": True}
    LLMQuery._merge_jev_batch("p1", "r1", [
        {"start": 1.0, "end": 10.0, "highlight_text": "a b c", "jev_scores": looped,
         "video_title_for_youtube_short": "First"},
        {"start": 20.0, "end": 30.0, "highlight_text": "c d e", "jev_scores": looped,
         "video_title_for_youtube_short": "Second"},
        {"start": 40.0, "end": 50.0, "highlight_text": "x", "jev_scores": looped,
         "video_title_for_youtube_short": "Never"},
    ])

    saved = json.loads(folder.joinpath("metadata.json").read_text())["highlights"]
    assert (saved[0]["end"], saved[0]["video_title_for_youtube_short"]) == (10.0, "First")
    assert (saved[1]["end"], saved[1]["video_title_for_youtube_short"]) == (29.0, "Second")
    assert not saved[2].get("video_title_for_youtube_short")


def test_jev_scores_survive_a_save_and_load():
    highlight = Highlight.from_json({"start": 1, "end": 5, "jev_scores": {"score": 0.5, "loop_used": True}})

    assert Highlight.from_json(highlight.to_dict()).jev_scores == {"score": 0.5, "loop_used": True}


def test_the_titles_prompt_is_not_a_pipeline_step():
    assert all(Path(task.template).resolve() != JEV_TEXTS_TEMPLATE.resolve() for task in discover_tasks().values())


def test_the_titles_prompt_renders():
    project = SimpleNamespace(
        settings=SimpleNamespace(description=SimpleNamespace(source_title="Show"), highlights=None)
    )

    prompt = build_prompt(JEV_TEXTS_TEMPLATE.read_text(encoding="utf-8"), project)

    assert "Show" in prompt
    assert prompt.rstrip().endswith("SEGMENTS (JSON list; `index` identifies each one):")


def http_error(code):
    return urllib.error.HTTPError("https://api.typesafe.ai", code, "error", {}, io.BytesIO(b"busy"))


def test_client_retries_when_jev_is_overloaded(monkeypatch):
    monkeypatch.setattr(typesafe_client.time, "sleep", lambda _: None)
    replies = [http_error(529), {"answers": {}}]

    def post(self, body):
        reply = replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(TypeSafeClient, "_post", post)

    assert TypeSafeClient("key").system_one("state", {}) == {"answers": {}}


def test_client_does_not_retry_a_rejected_key(monkeypatch):
    calls = []

    def post(self, body):
        calls.append(body)
        raise http_error(401)

    monkeypatch.setattr(TypeSafeClient, "_post", post)

    with pytest.raises(TypeSafeError, match="401"):
        TypeSafeClient("key").system_one("state", {})
    assert len(calls) == 1


def test_client_needs_a_key():
    with pytest.raises(TypeSafeError, match="key"):
        TypeSafeClient("")

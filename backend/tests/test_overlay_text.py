"""The overlay title: what is stored, what is drawn, and what re-cuts a clip.

The title is one piece of text the user writes for one clip, drawn from the
start of the clip and faded out. It shares the ASS file with the captions but
nothing else, so these cover the two staying independent — captions off with a
title on has to burn the title and no words.
"""

import json
from datetime import datetime
from pathlib import Path

import pytest

from backend.src.dataclasses.data import Highlight, OverlayText, Project
from backend.src.services.ass_writer import (
    OVERLAY_STYLE_NAME,
    build_overlay_event,
    build_overlay_style_line,
    render_ass,
)
from backend.src.services.captions import CaptionService
from backend.src.services.caption_styles import resolve_style
from backend.src.services.clipper import Clipper

PROJECT_ID = "overlay-project"

WORD_MAP = "\n".join([
    "word,start,end",
    "And,10.0,10.3",
    "we,10.3,10.5",
    "just,10.5,10.8",
    "lost,10.8,11.2",
])


def write_project(root: Path, captions=None, overlay=None, project_overlay=None):
    project_dir = root / "projects" / PROJECT_ID
    project_dir.mkdir(parents=True, exist_ok=True)
    highlight = {
        "highlight_text": "And we just lost", "viral_hook_text": "",
        "video_description_for_x": "", "video_description_for_reddit": "",
        "video_description_for_linkedin": "", "video_title_for_youtube_short": "",
        "start": 10.0, "end": 14.0,
    }
    if overlay is not None:
        highlight["overlay"] = overlay
    settings = {"aspect_ratio": "9:16", "resolution": "1080p"}
    if captions is not None:
        settings["captions"] = captions
    if project_overlay is not None:
        settings["overlay"] = project_overlay
    metadata = {
        "project_id": PROJECT_ID,
        "name": "Overlay Project",
        "created_at": datetime.now().isoformat(),
        "files": {},
        "highlights": [highlight],
        "video_metadata": {"components": [], "top_recommendations": []},
        "settings": settings,
        "status": None,
        "step_statuses": {},
    }
    (project_dir / "metadata.json").write_text(json.dumps(metadata))
    (project_dir / "word_map.csv").write_text(WORD_MAP)


@pytest.fixture
def project_root(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


def titled(**changes):
    return {"enabled": True, "text": "Cold open", **changes}


class TestOverlayPersistence:
    def test_round_trips_through_metadata(self, project_root):
        write_project(project_root, overlay=titled(duration=5.0, position_pct=20.0))
        overlay = Project(PROJECT_ID).highlights[0].overlay

        assert overlay.enabled is True
        assert overlay.text == "Cold open"
        assert overlay.duration == 5.0
        assert overlay.position_pct == 20.0

    def test_a_clip_saved_before_overlays_existed_has_none(self, project_root):
        write_project(project_root, overlay=None)
        highlight = Project(PROJECT_ID).highlights[0]

        assert highlight.overlay is None

    def test_garbage_does_not_break_loading(self, project_root):
        write_project(project_root, overlay="a nice title please")
        assert Project(PROJECT_ID).highlights[0].overlay is None

    def test_survives_a_write(self, project_root):
        write_project(project_root)
        project = Project(PROJECT_ID)
        project.highlights[0].overlay = OverlayText(enabled=True, text="Chapter one")
        project.set_property("highlights", project.highlights)

        stored = json.loads(Path("projects", PROJECT_ID, "metadata.json").read_text())
        assert stored["highlights"][0]["overlay"]["text"] == "Chapter one"
        assert Project(PROJECT_ID).highlights[0].overlay.text == "Chapter one"


class TestOverlaySanitizing:
    def test_numbers_outside_the_bounds_are_clamped(self):
        overlay = OverlayText.from_dict(titled(font_size_pct=400.0, duration=-5.0))
        assert overlay.font_size_pct == 25.0
        assert overlay.duration == 0.1

    def test_unreadable_numbers_fall_back_rather_than_reaching_the_renderers(self):
        overlay = OverlayText.from_dict(titled(font_size_pct="huge", start=None))
        assert overlay.font_size_pct == OverlayText().font_size_pct
        assert overlay.start == 0.0

    def test_a_colour_that_is_not_one_keeps_the_default(self):
        assert OverlayText.from_dict(titled(text_color="red")).text_color == "#FFFFFF"
        assert OverlayText.from_dict(titled(text_color="#0f0")).text_color == "#00FF00"

    def test_no_box_colour_means_no_background_block(self):
        assert OverlayText.from_dict(titled()).box_color is None
        assert OverlayText.from_dict(titled(box_color="#000000CC")).box_color == "#000000CC"

    def test_an_empty_title_draws_nothing_even_when_enabled(self):
        assert OverlayText.from_dict({"enabled": True, "text": "   "}).is_visible() is False
        assert OverlayText.from_dict(titled()).is_visible() is True

    def test_a_disabled_title_draws_nothing(self):
        assert OverlayText.from_dict(titled(enabled=False)).is_visible() is False


class TestOverlayRendering:
    def test_the_title_is_anchored_to_the_top_of_the_frame(self):
        line = build_overlay_style_line(OverlayText.from_dict(titled(position_pct=10.0)), 1080, 1920)
        fields = line.split(",")
        # Alignment 8 is top-centre; MarginV is then measured from the top.
        assert fields[18] == "8"
        assert fields[21] == "192"

    def test_the_outline_is_halved_like_the_caption_one(self):
        line = build_overlay_style_line(OverlayText.from_dict(titled(outline_pct=1.0)), 1080, 1920)
        assert line.split(",")[16] == "9.6"

    def test_the_shadow_is_a_frame_percentage_and_is_not_halved(self):
        # Unlike the outline: an ASS Shadow and the preview's `text-shadow` are
        # both a plain pixel offset, so the two already agree.
        line = build_overlay_style_line(OverlayText.from_dict(titled(shadow_pct=1.0)), 1080, 1920)
        assert line.split(",")[17] == "19.2"

    def test_the_shadow_takes_its_own_colour(self):
        line = build_overlay_style_line(OverlayText.from_dict(titled(shadow_color="#FF7A52")), 1080, 1920)
        # BackColour is where libass reads the shadow from.
        assert line.split(",")[6] == "&H00527AFF"

    def test_a_title_nobody_configured_still_has_one(self):
        # The lift is the default rather than an option: it is what separates
        # the words from the picture.
        line = build_overlay_style_line(OverlayText.from_dict(titled()), 1080, 1920)
        assert float(line.split(",")[17]) > 0

    def test_a_box_colour_switches_to_the_opaque_box_border_style(self):
        boxed = build_overlay_style_line(OverlayText.from_dict(titled(box_color="#000000")), 1080, 1920)
        plain = build_overlay_style_line(OverlayText.from_dict(titled()), 1080, 1920)
        assert boxed.split(",")[15] == "3"
        assert plain.split(",")[15] == "1"

    def test_the_event_starts_at_the_top_of_the_clip_and_fades(self):
        event = build_overlay_event(OverlayText.from_dict(titled(duration=4.0, fade_in=0.2, fade_out=0.5)))
        assert event.startswith("Dialogue: 1,0:00:00.00,0:00:04.00")
        assert "\\fad(200,500)" in event

    def test_a_new_title_is_solid_on_the_first_frame(self):
        # No fade in unless one is asked for: the opening frame is the one most
        # likely to be seen, and a ramp spends it on an invisible title.
        assert "\\fad(0," in build_overlay_event(OverlayText.from_dict(titled()))

    def test_it_draws_above_the_captions(self):
        # Layer 1 against the captions' layer 0.
        assert build_overlay_event(OverlayText.from_dict(titled())).startswith("Dialogue: 1,")

    def test_a_marked_word_is_drawn_in_the_highlight_colour(self):
        event = build_overlay_event(OverlayText.from_dict(titled(
            text="we *lost* everything", highlight_color="#FFE000", text_color="#FFFFFF",
        )))
        # Yellow on, then the title's own colour back on: the rest of the line
        # is not part of the mark.
        assert "{\\c&H0000E0FF&}LOST{\\c&H00FFFFFF&}" in event
        assert "*" not in event

    def test_a_title_with_no_marks_is_drawn_exactly_as_before(self):
        event = build_overlay_event(OverlayText.from_dict(titled(text="we lost everything")))
        assert "\\c" not in event.split(",", 9)[-1].replace("\\fad", "")

    def test_a_lone_asterisk_is_text_rather_than_a_mark(self):
        event = build_overlay_event(OverlayText.from_dict(titled(text="rated 5*")))
        assert "RATED 5*" in event

    def test_uppercase_is_applied_to_the_rendered_text(self):
        assert "COLD OPEN" in build_overlay_event(OverlayText.from_dict(titled(uppercase=True)))
        assert "Cold open" in build_overlay_event(OverlayText.from_dict(titled(uppercase=False)))

    def test_a_typed_line_break_stays_a_line_break(self):
        event = build_overlay_event(OverlayText.from_dict(titled(text="two\nlines", uppercase=False)))
        assert "two\\Nlines" in event
        assert "\n" not in event

    def test_text_cannot_open_an_override_block(self):
        event = build_overlay_event(OverlayText.from_dict(titled(text="{\\c&HFF0000&}nope")))
        # The one brace pair in the line is the fade this writer put there.
        assert event.count("{") == 1

    def test_nothing_is_emitted_for_a_title_that_would_not_draw(self):
        assert build_overlay_event(OverlayText.from_dict(titled(enabled=False))) is None


class TestRenderAss:
    def test_a_title_with_captions_off_still_produces_a_file(self):
        text = render_ass([], resolve_style("karaoke_pop"), 1080, 1920,
                          OverlayText.from_dict(titled()))
        assert f"Style: {OVERLAY_STYLE_NAME}," in text
        assert "COLD OPEN" in text

    def test_a_clip_with_no_title_declares_no_overlay_style(self):
        text = render_ass([], resolve_style("karaoke_pop"), 1080, 1920, None)
        assert OVERLAY_STYLE_NAME not in text


class TestCaptionServiceWiring:
    def test_a_title_alone_is_reason_enough_to_write_a_subtitle_file(self, project_root, tmp_path):
        write_project(project_root, captions={"enabled": False, "preset": "karaoke_pop", "overrides": {}},
                      overlay=titled())
        project = Project(PROJECT_ID)
        path = tmp_path / "clip_000.ass"

        assert CaptionService().write_ass(project, project.highlights[0], path, 1080, 1920) == path
        text = path.read_text()
        assert "COLD OPEN" in text
        # Captions are off, so none of the spoken words may be in the burn.
        assert "JUST" not in text

    def test_captions_off_and_no_title_writes_nothing(self, project_root, tmp_path):
        write_project(project_root, captions={"enabled": False, "preset": "karaoke_pop", "overrides": {}})
        project = Project(PROJECT_ID)

        assert CaptionService().write_ass(project, project.highlights[0], tmp_path / "x.ass", 1080, 1920) is None
        assert not (tmp_path / "x.ass").exists()

    def test_both_end_up_in_the_same_file(self, project_root, tmp_path):
        write_project(project_root, captions={"enabled": True, "preset": "karaoke_pop", "overrides": {}},
                      overlay=titled())
        project = Project(PROJECT_ID)
        path = tmp_path / "clip_000.ass"
        CaptionService().write_ass(project, project.highlights[0], path, 1080, 1920)

        text = path.read_text()
        assert "COLD OPEN" in text
        assert "JUST" in text

    def test_the_preview_carries_the_title_and_the_face_it_will_be_drawn_with(self, project_root):
        write_project(project_root, overlay=titled())
        project = Project(PROJECT_ID)
        payload = CaptionService().preview(project, project.highlights[0])

        assert payload["overlay"]["text"] == "Cold open"
        assert payload["overlay_font"]["height_ratio"] > 0

    def test_a_clip_with_no_title_of_its_own_falls_back_on_the_project_s(self, project_root):
        write_project(project_root)
        project = Project(PROJECT_ID)
        payload = CaptionService().preview(project, project.highlights[0])

        # The project's own default: switched off, no words, so nothing draws.
        assert payload["overlay"]["text"] == ""
        assert payload["overlay"]["enabled"] is False
        assert payload["overlay_locked"] is True


class TestProjectConfiguration:
    """The project setting is how a title is drawn, never what it says."""

    def test_the_project_stores_no_text(self, project_root):
        # A project saved before this was configuration-only carries a line
        # that would otherwise reappear over every clip at once.
        write_project(project_root, project_overlay=titled())
        project = Project(PROJECT_ID)

        assert project.settings.overlay.text == ""
        assert project.settings.overlay.enabled is True

    def test_a_clip_with_no_title_of_its_own_draws_nothing(self, project_root):
        write_project(project_root, project_overlay=titled(position_pct=40.0))
        project = Project(PROJECT_ID)

        # The configuration is what it would be drawn in, not a title in itself.
        assert CaptionService().overlay(project, project.highlights[0]) is None

    def test_a_locked_clip_reports_the_look_a_title_would_take(self, project_root):
        write_project(project_root, project_overlay=titled(position_pct=40.0))
        project = Project(PROJECT_ID)
        service = CaptionService()

        resolved = service.overlay_settings(project, project.highlights[0])
        assert resolved.position_pct == 40.0
        assert resolved.text == ""
        assert service.overlay_locked(project.highlights[0]) is True

    def test_a_clip_with_its_own_title_speaks_for_itself(self, project_root):
        write_project(
            project_root,
            project_overlay=titled(position_pct=40.0),
            overlay={**titled(), "text": "Its own line"},
        )
        project = Project(PROJECT_ID)
        service = CaptionService()

        assert service.overlay(project, project.highlights[0]).text == "Its own line"
        assert service.overlay_locked(project.highlights[0]) is False

    def test_a_clip_can_switch_its_own_title_off(self, project_root):
        write_project(
            project_root,
            project_overlay=titled(),
            overlay={**titled(), "enabled": False},
        )
        project = Project(PROJECT_ID)

        assert CaptionService().overlay(project, project.highlights[0]) is None

    def test_a_project_written_before_the_setting_existed_has_no_title(self, project_root):
        write_project(project_root)
        project = Project(PROJECT_ID)

        assert CaptionService().overlay(project, project.highlights[0]) is None


class FakeEngine:
    """Records what would have been encoded, without encoding anything."""

    def __init__(self):
        self.calls = []

    def resolve_output_dimensions(self, input_path, aspect_ratio, resolution):
        return 1080, 1920

    def process_clip(self, input_path, output_path, start, end, aspect_ratio, resolution,
                     subtitle_path=None, layout="crop", stack_darkness=50,
                     split_position=50, split_swap=False, split_divider=False):
        self.calls.append({"output": output_path, "start": start, "end": end,
                           "subtitle_path": subtitle_path, "layout": layout,
                           "stack_darkness": stack_darkness, "split_position": split_position,
                           "split_swap": split_swap, "split_divider": split_divider})
        Path(output_path).write_bytes(b"")


class TestSingleClipRender:
    """Regenerating one clip must not disturb the others."""

    def _project_with_two_clips(self, root):
        write_project(root, captions={"enabled": True, "preset": "karaoke_pop", "overrides": {}},
                      overlay=titled())
        project = Project(PROJECT_ID)
        stored = json.loads(Path("projects", PROJECT_ID, "metadata.json").read_text())
        second = dict(stored["highlights"][0])
        second.update({"start": 20.0, "end": 24.0, "overlay": None,
                       "is_clip_generated": True, "generated_clip_filename": "clip_001.mp4"})
        stored["highlights"].append(second)
        Path("projects", PROJECT_ID, "metadata.json").write_text(json.dumps(stored))
        (root / "projects" / PROJECT_ID / "original.mp4").write_bytes(b"")
        # The second clip's file, not just its metadata. "Already cut" is now
        # read off the disk — a highlight naming a file nobody wrote is exactly
        # the case a resume has to re-cut.
        clips = root / "projects" / PROJECT_ID / "clips"
        clips.mkdir(parents=True, exist_ok=True)
        (clips / "clip_001.mp4").write_bytes(b"")
        return Project(PROJECT_ID)

    def test_renders_only_the_clip_it_was_asked_for(self, project_root, monkeypatch):
        project = self._project_with_two_clips(project_root)
        engine = FakeEngine()
        clipper = Clipper()
        monkeypatch.setattr("backend.src.services.clipper.OpenCVVideoEngine", lambda path: engine)

        clipper.render_one(project, 0)

        assert len(engine.calls) == 1
        assert engine.calls[0]["output"].endswith("clip_000.mp4")
        assert engine.calls[0]["start"] == 10.0
        # The clip nobody asked about keeps the file it already had.
        assert Project(PROJECT_ID).highlights[1].generated_clip_filename == "clip_001.mp4"

    def test_records_what_the_new_file_carries(self, project_root, monkeypatch):
        project = self._project_with_two_clips(project_root)
        monkeypatch.setattr("backend.src.services.clipper.OpenCVVideoEngine", lambda path: FakeEngine())

        clipper = Clipper()
        clipper.render_one(project, 0)
        stored = Project(PROJECT_ID).highlights[0]

        assert stored.is_clip_generated is True
        # What tells a Postiz draft filed from an older cut that it is stale.
        assert stored.rendered_at is not None

    def test_a_stacked_project_cuts_stacked(self, project_root, monkeypatch):
        project = self._project_with_two_clips(project_root)
        project.settings.layout = "stacked"
        project.settings.stack_darkness = 70
        project.set_property("settings", project.settings)
        engine = FakeEngine()
        monkeypatch.setattr("backend.src.services.clipper.OpenCVVideoEngine", lambda path: engine)

        Clipper().render_one(Project(PROJECT_ID), 0)

        assert engine.calls[0]["layout"] == "stacked"
        assert engine.calls[0]["stack_darkness"] == 70

    def test_no_highlight_at_that_index_is_refused(self, project_root, monkeypatch):
        project = self._project_with_two_clips(project_root)
        monkeypatch.setattr("backend.src.services.clipper.OpenCVVideoEngine", lambda path: FakeEngine())

        with pytest.raises(IndexError):
            Clipper().render_one(project, 7)

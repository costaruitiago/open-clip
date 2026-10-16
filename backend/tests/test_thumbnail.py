"""The clip thumbnail: which frame, what is drawn on it, and what publishes it.

The promise these cover is the one the feature is built on: a user who does
nothing gets the first frame of the clip, no subtitles, and the clip's title
over it — and everything else is a departure from that, chosen per clip.
"""

import json
from datetime import datetime
from pathlib import Path

import pytest

from backend.src.dataclasses.data import OverlayText, Project, ThumbnailSettings
from backend.src.services.ass_writer import OVERLAY_STYLE_NAME, render_still_ass
from backend.src.services.caption_builder import CaptionCue, CaptionWord
from backend.src.services.caption_styles import resolve_style
from backend.src.services.thumbnailer import SourceVideoMissingError, Thumbnailer

PROJECT_ID = "thumbnail-project"

WORD_MAP = "\n".join([
    "word,start,end",
    "And,10.0,10.3",
    "we,10.3,10.5",
    "just,10.5,10.8",
    "lost,10.8,11.2",
])


def write_project(root: Path, overlay=None, thumbnail=None, hook="The moment it turned",
                  captions_enabled=False, with_source=True, thumbnail_text="",
                  project_overlay=None):
    project_dir = root / "projects" / PROJECT_ID
    project_dir.mkdir(parents=True, exist_ok=True)
    highlight = {
        "highlight_text": "And we just lost", "viral_hook_text": hook,
        "thumbnail_text": thumbnail_text,
        "video_description_for_x": "", "video_description_for_reddit": "",
        "video_description_for_linkedin": "", "video_title_for_youtube_short": "A title",
        "start": 10.0, "end": 14.0,
    }
    if overlay is not None:
        highlight["overlay"] = overlay
    if thumbnail is not None:
        highlight["thumbnail"] = thumbnail
    metadata = {
        "project_id": PROJECT_ID,
        "name": "Thumbnail Project",
        "created_at": datetime.now().isoformat(),
        "files": {},
        "highlights": [highlight],
        "video_metadata": {"components": [], "top_recommendations": []},
        "settings": {
            "aspect_ratio": "9:16", "resolution": "1080p",
            "captions": {"enabled": captions_enabled, "preset": "karaoke_pop", "overrides": {}},
            **({"overlay": project_overlay} if project_overlay is not None else {}),
        },
        "status": None,
        "step_statuses": {},
    }
    (project_dir / "metadata.json").write_text(json.dumps(metadata))
    (project_dir / "word_map.csv").write_text(WORD_MAP)
    if with_source:
        (project_dir / "original.mp4").write_bytes(b"")


@pytest.fixture
def project_root(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


class FakeEngine:
    """Records what would have been extracted, without running ffmpeg."""

    def __init__(self):
        self.frames = []

    def resolve_output_dimensions(self, input_path, aspect_ratio, resolution):
        return 1080, 1920

    def extract_frame(self, input_path, output_path, timestamp, aspect_ratio, resolution,
                      subtitle_path=None, framing_timestamp=None, layout="crop", stack_darkness=50):
        self.frames.append({
            "output": output_path, "timestamp": timestamp,
            "subtitle_path": subtitle_path, "framing_timestamp": framing_timestamp,
            "layout": layout, "stack_darkness": stack_darkness,
            # Read here rather than after the fact: the script is scratch for
            # this one call and is deleted as soon as it returns.
            "subtitles": Path(subtitle_path).read_text() if subtitle_path else None,
        })
        Path(output_path).write_bytes(b"jpeg")


def cue(*words):
    entries = [CaptionWord(text=text, start=start, end=end) for text, start, end in words]
    return CaptionCue(start=entries[0].start, end=entries[-1].end, words=entries)


class TestDefaults:
    def test_a_clip_nobody_has_touched_uses_the_first_frame_with_its_title(self, project_root):
        write_project(project_root, overlay={"enabled": True, "text": "Cold open"})
        project = Project(PROJECT_ID)
        highlight = project.highlights[0]
        thumbnailer = Thumbnailer()

        settings = thumbnailer.settings(highlight)
        assert highlight.thumbnail is None
        assert settings.frame_time == 0.0
        assert settings.show_captions is False
        assert settings.show_overlay is True
        assert [overlay.text for overlay in thumbnailer.overlays(project, highlight, settings)] == ["Cold open"]

    def test_the_title_is_automatic_when_the_clip_has_none_of_its_own(self, project_root):
        write_project(project_root, overlay=None, hook="This is the hook")
        highlight = Project(PROJECT_ID).highlights[0]

        assert Thumbnailer().title(Project(PROJECT_ID), highlight).text == "This is the hook"

    # The hook is written to be heard over a video already playing. The
    # thumbnail line is written to be read at feed size with no sound, which is
    # a different sentence, so it wins wherever the model wrote one.
    def test_the_model_s_thumbnail_line_beats_the_hook(self, project_root):
        write_project(project_root, overlay=None, hook="This is the hook",
                      thumbnail_text="we *lost* it")
        highlight = Project(PROJECT_ID).highlights[0]

        assert Thumbnailer().title(Project(PROJECT_ID), highlight).text == "we *lost* it"

    def test_a_title_the_user_typed_still_beats_the_model_s(self, project_root):
        write_project(project_root, overlay={"enabled": True, "text": "Cold open"},
                      thumbnail_text="we *lost* it")
        highlight = Project(PROJECT_ID).highlights[0]

        assert Thumbnailer().title(Project(PROJECT_ID), highlight).text == "Cold open"

    def test_the_hook_stands_in_for_a_clip_written_before_the_field_existed(self, project_root):
        write_project(project_root, overlay=None, hook="This is the hook", thumbnail_text="")
        highlight = Project(PROJECT_ID).highlights[0]

        assert Thumbnailer().title(Project(PROJECT_ID), highlight).text == "This is the hook"

    def test_the_youtube_title_stands_in_when_there_is_no_hook(self, project_root):
        write_project(project_root, overlay=None, hook="")
        highlight = Project(PROJECT_ID).highlights[0]

        assert Thumbnailer().title(Project(PROJECT_ID), highlight).text == "A title"

    def test_a_title_switched_off_for_the_video_still_names_the_still(self, project_root):
        # `enabled` answers "burn this into the clip". Whether the thumbnail
        # carries text is `show_overlay`, and the user wrote the line either way.
        write_project(project_root, overlay={"enabled": False, "text": "Cold open"})
        highlight = Project(PROJECT_ID).highlights[0]

        assert Thumbnailer().title(Project(PROJECT_ID), highlight).text == "Cold open"

    # The project setting is how a title is drawn. An automatic title that
    # ignored it meant a restyled project kept turning out stills in the
    # factory colours, which is the whole reason to have the setting.
    def test_an_automatic_title_is_drawn_in_the_project_s_look(self, project_root):
        write_project(
            project_root,
            overlay=None,
            thumbnail_text="we *lost* it",
            project_overlay={"position_pct": 40.0, "highlight_color": "#FF0000"},
        )
        title = Thumbnailer().title(Project(PROJECT_ID), Project(PROJECT_ID).highlights[0])

        assert title.text == "we *lost* it"
        assert title.position_pct == 40.0
        assert title.highlight_color == "#FF0000"

    # `enabled` on the project answers "burn titles into the video". The still
    # carries text either way — that is `show_overlay`'s question — so the
    # automatic title is drawn whatever the project says about burning.
    def test_an_automatic_title_is_drawn_even_with_burning_switched_off(self, project_root):
        write_project(
            project_root,
            overlay=None,
            thumbnail_text="we *lost* it",
            project_overlay={"enabled": False, "position_pct": 40.0},
        )
        title = Thumbnailer().title(Project(PROJECT_ID), Project(PROJECT_ID).highlights[0])

        assert title.enabled is True
        assert title.position_pct == 40.0

    def test_nothing_is_drawn_when_the_overlay_is_switched_off_for_the_still(self, project_root):
        write_project(project_root, overlay={"enabled": True, "text": "Cold open"})
        highlight = Project(PROJECT_ID).highlights[0]
        settings = ThumbnailSettings(show_overlay=False)

        assert Thumbnailer().overlays(Project(PROJECT_ID), highlight, settings) == []


class TestSettingsPersistence:
    def test_round_trips_through_metadata(self, project_root):
        write_project(project_root, thumbnail={
            "frame_time": 2.5, "show_captions": True, "show_overlay": False,
            "extra": {"enabled": True, "text": "Part two"},
        })
        stored = Project(PROJECT_ID).highlights[0].thumbnail

        assert stored.frame_time == 2.5
        assert stored.show_captions is True
        assert stored.show_overlay is False
        assert stored.extra.text == "Part two"

    def test_a_clip_saved_before_thumbnails_existed_has_none(self, project_root):
        write_project(project_root)
        assert Project(PROJECT_ID).highlights[0].thumbnail is None

    def test_garbage_does_not_break_loading(self, project_root):
        write_project(project_root, thumbnail="frame 7 please")
        assert Project(PROJECT_ID).highlights[0].thumbnail is None

    def test_unreadable_numbers_fall_back_rather_than_reaching_ffmpeg(self):
        assert ThumbnailSettings.from_dict({"frame_time": "halfway"}).frame_time == 0.0
        assert ThumbnailSettings.from_dict({"frame_time": -4}).frame_time == 0.0


class TestFrameChoice:
    def test_a_frame_past_the_end_of_the_clip_is_pulled_back_inside_it(self, project_root):
        write_project(project_root)
        highlight = Project(PROJECT_ID).highlights[0]

        # The clip is four seconds long, so a frame asked for at 30s would come
        # back as whatever the source shows there — not this clip at all.
        assert Thumbnailer().frame_time(highlight, ThumbnailSettings(frame_time=30.0)) == pytest.approx(3.95)

    def test_a_chosen_frame_inside_the_clip_is_kept(self, project_root):
        write_project(project_root)
        highlight = Project(PROJECT_ID).highlights[0]

        assert Thumbnailer().frame_time(highlight, ThumbnailSettings(frame_time=2.0)) == 2.0


class TestStillScript:
    """Everything on a still is drawn at time zero: one frame has no timeline."""

    def test_the_caption_covering_the_moment_is_the_one_drawn(self):
        text = render_still_ass(
            [cue(("and", 0.0, 0.4), ("we", 0.4, 0.8)), cue(("just", 2.0, 2.4))],
            resolve_style("karaoke_pop"), 1080, 1920, [], 2.1,
        )
        assert "JUST" in text
        assert "AND" not in text

    def test_events_start_at_zero_however_far_into_the_clip_the_frame_is(self):
        # The frame is extracted by seeking, which rebases it to zero; a script
        # timed from the clip would draw nothing on it.
        text = render_still_ass(
            [cue(("just", 2.0, 2.4))], resolve_style("karaoke_pop"), 1080, 1920, [], 2.1,
        )
        assert "Dialogue: 0,0:00:00.00," in text

    def test_a_still_has_no_fade_to_show(self):
        text = render_still_ass(
            [], resolve_style("karaoke_pop"), 1080, 1920,
            [OverlayText(enabled=True, text="Cold open", fade_in=1.0, fade_out=1.0)], 0.0,
        )
        assert "\\fad" not in text

    def test_two_pieces_of_text_get_a_style_each(self):
        text = render_still_ass(
            [], resolve_style("karaoke_pop"), 1080, 1920,
            [OverlayText(enabled=True, text="Title"), OverlayText(enabled=True, text="Extra")], 0.0,
        )
        assert f"Style: {OVERLAY_STYLE_NAME}0," in text
        assert f"Style: {OVERLAY_STYLE_NAME}1," in text
        assert "TITLE" in text and "EXTRA" in text

    def test_the_word_being_spoken_keeps_its_colour(self):
        style = resolve_style("karaoke_pop")
        text = render_still_ass([cue(("and", 0.0, 0.4), ("we", 0.4, 0.8))], style, 1080, 1920, [], 0.5)
        # The second word is the active one at 0.5s, and it is the only one
        # carrying an override — but nothing is scaled, because a still frame
        # has no 120ms ramp to be part-way through.
        assert text.count("{\\c") == 1
        assert "\\t(" not in text
        assert "}WE{" in text


class TestGenerate:
    def test_writes_the_picture_and_records_it_on_the_clip(self, project_root):
        write_project(project_root, overlay={"enabled": True, "text": "Cold open"})
        project = Project(PROJECT_ID)
        engine = FakeEngine()

        settings = Thumbnailer().generate(project, 0, engine=engine)

        assert settings.generated_filename == "clip_000.jpg"
        assert settings.generated_at is not None
        assert Path("projects", PROJECT_ID, "thumbnails", "clip_000.jpg").exists()
        assert Project(PROJECT_ID).highlights[0].thumbnail.generated_filename == "clip_000.jpg"

    def test_the_frame_is_taken_from_inside_the_clip(self, project_root):
        write_project(project_root, thumbnail={"frame_time": 1.5})
        engine = FakeEngine()

        Thumbnailer().generate(Project(PROJECT_ID), 0, engine=engine)

        # The clip starts at 10s in the source, so 1.5s into it is 11.5s.
        assert engine.frames[0]["timestamp"] == pytest.approx(11.5)

    def test_the_crop_is_the_clip_s_own(self, project_root):
        # A still centred on its own moment would show a different part of the
        # picture than the video it belongs to.
        write_project(project_root, thumbnail={"frame_time": 3.0})
        engine = FakeEngine()

        Thumbnailer().generate(Project(PROJECT_ID), 0, engine=engine)

        assert engine.frames[0]["framing_timestamp"] == 10.0

    def test_a_stacked_project_gets_a_stacked_thumbnail(self, project_root):
        write_project(project_root)
        project = Project(PROJECT_ID)
        project.settings.layout = "stacked"
        project.settings.stack_darkness = 30
        project.set_property("settings", project.settings)
        engine = FakeEngine()

        Thumbnailer().generate(Project(PROJECT_ID), 0, engine=engine)

        assert engine.frames[0]["layout"] == "stacked"
        assert engine.frames[0]["stack_darkness"] == 30

    def test_subtitles_stay_off_unless_they_are_asked_for(self, project_root):
        write_project(project_root, captions_enabled=True,
                      overlay={"enabled": True, "text": "Cold open"})
        engine = FakeEngine()

        Thumbnailer().generate(Project(PROJECT_ID), 0, engine=engine)

        drawn = engine.frames[0]["subtitles"]
        assert "COLD OPEN" in drawn
        # The clip burns these words; the thumbnail does not, because nobody
        # asked it to.
        assert "JUST" not in drawn

    def test_subtitles_are_drawn_when_they_are(self, project_root):
        write_project(project_root, captions_enabled=True,
                      thumbnail={"frame_time": 0.6, "show_captions": True})
        engine = FakeEngine()

        Thumbnailer().generate(Project(PROJECT_ID), 0, engine=engine)

        assert "JUST" in engine.frames[0]["subtitles"]

    def test_extra_text_is_drawn_alongside_the_title(self, project_root):
        write_project(project_root, overlay={"enabled": True, "text": "Cold open"},
                      thumbnail={"extra": {"enabled": True, "text": "Part two"}})
        engine = FakeEngine()

        Thumbnailer().generate(Project(PROJECT_ID), 0, engine=engine)

        drawn = engine.frames[0]["subtitles"]
        assert "COLD OPEN" in drawn and "PART TWO" in drawn

    def test_a_clip_with_nothing_to_draw_still_gets_a_picture(self, project_root):
        write_project(project_root, overlay=None, hook="")
        project = Project(PROJECT_ID)
        # No hook and no YouTube title either: the frame alone is the thumbnail.
        stored = json.loads(Path("projects", PROJECT_ID, "metadata.json").read_text())
        stored["highlights"][0]["video_title_for_youtube_short"] = ""
        Path("projects", PROJECT_ID, "metadata.json").write_text(json.dumps(stored))
        engine = FakeEngine()

        Thumbnailer().generate(Project(PROJECT_ID), 0, engine=engine)

        assert engine.frames[0]["subtitle_path"] is None
        assert Path("projects", PROJECT_ID, "thumbnails", "clip_000.jpg").exists()

    def test_the_subtitle_script_is_scratch_and_does_not_survive_the_render(self, project_root):
        # It exists for one ffmpeg call. Left behind it is litter in the user's
        # project — beside the picture, which is the one file there worth
        # keeping. The clip's own .ass is a different thing and stays.
        write_project(project_root, overlay={"enabled": True, "text": "Cold open"})
        engine = FakeEngine()

        Thumbnailer().generate(Project(PROJECT_ID), 0, engine=engine)

        assert not Path(engine.frames[0]["subtitle_path"]).exists()
        assert list(Path("projects", PROJECT_ID, "thumbnails").glob("*.ass")) == []

    def test_a_script_left_by_an_earlier_version_is_swept_up(self, project_root):
        write_project(project_root, overlay={"enabled": True, "text": "Cold open"})
        stale = Path("projects", PROJECT_ID, "thumbnails", "clip_000.ass")
        stale.parent.mkdir(parents=True, exist_ok=True)
        stale.write_text("[Script Info]")

        Thumbnailer().generate(Project(PROJECT_ID), 0, engine=FakeEngine())

        assert not stale.exists()

    def test_no_source_video_is_refused_rather_than_encoded(self, project_root):
        write_project(project_root, with_source=False)

        with pytest.raises(SourceVideoMissingError):
            Thumbnailer().generate(Project(PROJECT_ID), 0, engine=FakeEngine())

    def test_no_highlight_at_that_index_is_refused(self, project_root):
        write_project(project_root)

        with pytest.raises(IndexError):
            Thumbnailer().generate(Project(PROJECT_ID), 0 + 5, engine=FakeEngine())


class TestClipPreviewSetting:
    """Whether a still clip shows its thumbnail or the frame under it."""

    def test_thumbnail_is_what_a_project_shows_unless_it_says_otherwise(self, project_root):
        write_project(project_root)
        assert Project(PROJECT_ID).settings.clip_preview == "thumbnail"

    def test_a_project_can_ask_for_the_footage_instead(self, project_root):
        write_project(project_root)
        project = Project(PROJECT_ID)
        project.settings.clip_preview = "video"
        project.set_property("settings", project.settings)

        assert Project(PROJECT_ID).settings.clip_preview == "video"

    def test_a_value_the_page_cannot_draw_falls_back(self, project_root):
        write_project(project_root)
        stored = json.loads(Path("projects", PROJECT_ID, "metadata.json").read_text())
        stored["settings"]["clip_preview"] = "hologram"
        Path("projects", PROJECT_ID, "metadata.json").write_text(json.dumps(stored))

        assert Project(PROJECT_ID).settings.clip_preview == "thumbnail"


class TestPreview:
    def test_carries_the_resolved_title_so_the_page_draws_what_the_burn_will(self, project_root):
        write_project(project_root, overlay=None, hook="This is the hook")
        project = Project(PROJECT_ID)

        payload = Thumbnailer().preview(project, project.highlights[0])

        assert payload["title"]["text"] == "This is the hook"
        assert payload["title_font"]["height_ratio"] > 0
        assert payload["duration"] == 4.0
        assert payload["settings"]["show_captions"] is False


def write_clips_project(root: Path, count: int, thumbnails=None):
    """A project of `count` clips, for the step that draws all of them."""
    project_dir = root / "projects" / PROJECT_ID
    project_dir.mkdir(parents=True, exist_ok=True)
    highlights = []
    for index in range(count):
        highlight = {
            "highlight_text": f"clip {index}", "viral_hook_text": f"hook {index}",
            "thumbnail_text": "", "video_description_for_x": "",
            "video_description_for_reddit": "", "video_description_for_linkedin": "",
            "video_title_for_youtube_short": f"Title {index}",
            "start": 10.0 * index, "end": 10.0 * index + 4.0,
        }
        if thumbnails and thumbnails.get(index) is not None:
            highlight["thumbnail"] = thumbnails[index]
        highlights.append(highlight)
    (project_dir / "metadata.json").write_text(json.dumps({
        "project_id": PROJECT_ID,
        "name": "Thumbnail Project",
        "created_at": datetime.now().isoformat(),
        "files": {},
        "highlights": highlights,
        "video_metadata": {"components": [], "top_recommendations": []},
        "settings": {"aspect_ratio": "9:16", "resolution": "1080p"},
        "status": None,
        "step_statuses": {},
    }))
    (project_dir / "original.mp4").write_bytes(b"")
    return project_dir


class FailingEngine(FakeEngine):
    """Draws every frame except the ones it was told to refuse."""

    def __init__(self, refuse):
        super().__init__()
        self.refuse = set(refuse)

    def extract_frame(self, input_path, output_path, timestamp, aspect_ratio, resolution,
                      subtitle_path=None, framing_timestamp=None, **layout):
        if Path(output_path).name in self.refuse:
            raise RuntimeError("ffmpeg fell over")
        super().extract_frame(input_path, output_path, timestamp, aspect_ratio, resolution,
                              subtitle_path=subtitle_path, framing_timestamp=framing_timestamp,
                              **layout)


class TestStep:
    """Drawing every clip's still in one press, and re-drawing them all."""

    def test_draws_one_still_per_clip(self, project_root):
        write_clips_project(project_root, 3)
        engine = FakeEngine()

        Thumbnailer().execute(Project(PROJECT_ID), engine=engine)

        assert len(engine.frames) == 3
        directory = Path("projects", PROJECT_ID, "thumbnails")
        assert sorted(path.name for path in directory.iterdir()) == [
            "clip_000.jpg", "clip_001.jpg", "clip_002.jpg"
        ]
        assert Project(PROJECT_ID).step_statuses["thumbnails"] == "completed"

    def test_a_second_press_redraws_the_stills_that_are_already_there(self, project_root):
        # Unlike the clipper, this does not resume: the reason to press it is
        # that the pictures on disk were drawn in an older look, and skipping
        # the ones that exist would skip exactly the clips the run is for.
        write_clips_project(project_root, 3)
        Thumbnailer().execute(Project(PROJECT_ID), engine=FakeEngine())
        engine = FakeEngine()

        Thumbnailer().execute(Project(PROJECT_ID), engine=engine)

        assert [Path(frame["output"]).name for frame in engine.frames] == [
            "clip_000.jpg", "clip_001.jpg", "clip_002.jpg"
        ]

    def test_full_takes_the_stills_of_clips_that_are_gone_off_the_disk(self, project_root):
        write_clips_project(project_root, 2)
        Thumbnailer().execute(Project(PROJECT_ID), engine=FakeEngine())
        # A still left behind by a highlight that no longer exists.
        Path("projects", PROJECT_ID, "thumbnails", "clip_009.jpg").write_bytes(b"jpeg")

        Thumbnailer().execute(Project(PROJECT_ID), full=True, engine=FakeEngine())

        directory = Path("projects", PROJECT_ID, "thumbnails")
        assert sorted(path.name for path in directory.iterdir()) == ["clip_000.jpg", "clip_001.jpg"]

    def test_the_settings_survive_the_redraw(self, project_root):
        # The frame the user picked is theirs. Only the render belongs to this
        # step, so a redraw takes the same frame again.
        write_clips_project(project_root, 1, thumbnails={0: {"frame_time": 2.5}})
        engine = FakeEngine()

        Thumbnailer().execute(Project(PROJECT_ID), full=True, engine=engine)

        assert Project(PROJECT_ID).highlights[0].thumbnail.frame_time == 2.5
        assert engine.frames[0]["timestamp"] == pytest.approx(2.5)

    def test_one_still_that_will_not_draw_does_not_cost_the_others(self, project_root):
        write_clips_project(project_root, 3)
        engine = FailingEngine(refuse=["clip_001.jpg"])

        Thumbnailer().execute(Project(PROJECT_ID), engine=engine)

        project = Project(PROJECT_ID)
        assert project.step_statuses["thumbnails"] == "partial"
        assert "1 of 3 clips have no thumbnail" in project.step_errors["thumbnails"]
        assert Path("projects", PROJECT_ID, "thumbnails", "clip_002.jpg").exists()

    def test_a_run_that_drew_nothing_is_a_failure(self, project_root):
        write_clips_project(project_root, 2)
        engine = FailingEngine(refuse=["clip_000.jpg", "clip_001.jpg"])

        Thumbnailer().execute(Project(PROJECT_ID), engine=engine)

        project = Project(PROJECT_ID)
        assert project.step_statuses["thumbnails"] == "error"
        assert "ffmpeg fell over" in project.step_errors["thumbnails"]

    def test_no_source_video_fails_the_step_rather_than_every_clip_in_it(self, project_root):
        project_dir = write_clips_project(project_root, 2)
        (project_dir / "original.mp4").unlink()

        Thumbnailer().execute(Project(PROJECT_ID), engine=FakeEngine())

        assert Project(PROJECT_ID).step_statuses["thumbnails"] == "error"

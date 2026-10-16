"""The project's layout: crop, or the whole frame stacked between darkened copies."""

from backend.src.dataclasses.data import Highlight, ProjectSettings


def test_a_project_saved_before_layouts_existed_crops():
    settings = ProjectSettings.from_dict({"aspect_ratio": "9:16", "resolution": "1080p"})
    assert settings.layout == "crop"
    assert settings.stack_darkness == 50


def test_layout_round_trips():
    stored = ProjectSettings.from_dict({"aspect_ratio": "9:16", "resolution": "1080p",
                                        "layout": "stacked", "stack_darkness": 65}).to_dict()
    settings = ProjectSettings.from_dict(stored)
    assert (settings.layout, settings.stack_darkness) == ("stacked", 65)


def test_an_unknown_layout_reads_as_crop():
    assert ProjectSettings.from_dict({"layout": "mosaic"}).layout == "crop"


def test_darkness_is_clamped_and_junk_falls_back():
    assert ProjectSettings.from_dict({"stack_darkness": 140}).stack_darkness == 100
    assert ProjectSettings.from_dict({"stack_darkness": -3}).stack_darkness == 0
    assert ProjectSettings.from_dict({"stack_darkness": "dark"}).stack_darkness == 50
    assert ProjectSettings.from_dict({"stack_darkness": True}).stack_darkness == 50


def test_split_settings_round_trip():
    stored = ProjectSettings.from_dict({"layout": "split", "split_position": 40,
                                        "split_swap": True, "split_divider": True}).to_dict()
    settings = ProjectSettings.from_dict(stored)
    assert (settings.layout, settings.split_position, settings.split_swap, settings.split_divider) == (
        "split", 40, True, True)


def test_split_defaults_and_junk():
    settings = ProjectSettings.from_dict({})
    assert (settings.split_position, settings.split_swap, settings.split_divider) == (50, False, False)
    assert ProjectSettings.from_dict({"split_position": 5}).split_position == 20
    assert ProjectSettings.from_dict({"split_position": 95}).split_position == 80
    assert ProjectSettings.from_dict({"split_position": "left"}).split_position == 50
    assert ProjectSettings.from_dict({"split_swap": "yes"}).split_swap is False


def test_a_highlight_records_its_layout():
    highlight = Highlight.from_json({"start": 0, "end": 1, "rendered_layout": "stacked"})
    assert Highlight.from_json(highlight.to_dict()).rendered_layout == "stacked"

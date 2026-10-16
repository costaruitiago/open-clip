import shutil
import subprocess

import cv2
import pytest

from backend.src.infrastructure.video_engine import (
    OpenCVVideoEngine,
    build_encoder_args,
    build_picture_args,
    calculate_crop_rect,
    escape_filter_path,
    probe_video,
)
from backend.src.services.ass_writer import render_ass
from backend.src.services.caption_builder import CaptionCue, CaptionWord
from backend.src.services.caption_styles import resolve_style

requires_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg not installed"
)


def _has_libass() -> bool:
    if shutil.which("ffmpeg") is None:
        return False
    listing = subprocess.run(
        ["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True
    ).stdout
    return any(line.split()[1:2] == ["subtitles"] for line in listing.splitlines() if line.strip())


requires_libass = pytest.mark.skipif(
    not _has_libass(), reason="ffmpeg built without libass, so it has no subtitles filter"
)


def legacy_crop_params(src_w, src_h, target_w, target_h, subject_x=0.5, subject_y=0.5):
    """The original scale-then-crop math, kept here as the reference the
    crop-then-scale implementation must agree with."""
    scale = max(target_w / src_w, target_h / src_h)
    scaled_w, scaled_h = src_w * scale, src_h * scale
    x1 = max(0, min(subject_x * scaled_w - (target_w / 2), scaled_w - target_w))
    y1 = max(0, min(subject_y * scaled_h - (target_h / 2), scaled_h - target_h))
    return float(scale), int(x1), int(y1)


FRAMING_CASES = [
    # src_w, src_h, target_w, target_h, subject_x, subject_y
    (1920, 1080, 1080, 1920, 0.5, 0.5),
    (1920, 1080, 1080, 1920, 0.2, 0.5),
    (1920, 1080, 1080, 1920, 0.9, 0.5),
    (1920, 1080, 1920, 1080, 0.5, 0.5),
    (1080, 1920, 1920, 1080, 0.5, 0.3),
    (3840, 2160, 1080, 1920, 0.7, 0.4),
    (1280, 720, 720, 720, 0.35, 0.5),
]


@pytest.mark.parametrize("src_w,src_h,target_w,target_h,subject_x,subject_y", FRAMING_CASES)
def test_crop_rect_matches_legacy_framing(src_w, src_h, target_w, target_h, subject_x, subject_y):
    """Cropping in source space then scaling must select the same region of the
    source that scaling then cropping did, within even-pixel rounding."""
    scale, legacy_x, legacy_y = legacy_crop_params(
        src_w, src_h, target_w, target_h, subject_x, subject_y
    )
    crop_w, crop_h, crop_x, crop_y = calculate_crop_rect(
        src_w, src_h, target_w, target_h, subject_x, subject_y
    )

    assert crop_w == pytest.approx(target_w / scale, abs=2)
    assert crop_h == pytest.approx(target_h / scale, abs=2)
    assert crop_x == pytest.approx(legacy_x / scale, abs=2)
    assert crop_y == pytest.approx(legacy_y / scale, abs=2)


@pytest.mark.parametrize("src_w,src_h,target_w,target_h,subject_x,subject_y", FRAMING_CASES)
def test_crop_rect_stays_inside_source(src_w, src_h, target_w, target_h, subject_x, subject_y):
    crop_w, crop_h, crop_x, crop_y = calculate_crop_rect(
        src_w, src_h, target_w, target_h, subject_x, subject_y
    )

    assert crop_w > 0 and crop_h > 0
    assert crop_x >= 0 and crop_y >= 0
    assert crop_x + crop_w <= src_w
    assert crop_y + crop_h <= src_h


@pytest.mark.parametrize("src_w,src_h,target_w,target_h,subject_x,subject_y", FRAMING_CASES)
def test_crop_rect_dimensions_are_even(src_w, src_h, target_w, target_h, subject_x, subject_y):
    """Odd crop dimensions or offsets shift chroma planes in yuv420p output."""
    for value in calculate_crop_rect(src_w, src_h, target_w, target_h, subject_x, subject_y):
        assert value % 2 == 0


def test_crop_rect_is_smaller_than_full_scaled_frame():
    """The point of the refactor: the scaler input must shrink, not grow."""
    src_w, src_h, target_w, target_h = 1920, 1080, 1080, 1920
    scale, _, _ = legacy_crop_params(src_w, src_h, target_w, target_h)
    crop_w, crop_h, _, _ = calculate_crop_rect(src_w, src_h, target_w, target_h)

    legacy_pixels = (src_w * scale) * (src_h * scale)
    assert crop_w * crop_h < legacy_pixels / 5


def test_subject_at_edge_clamps_without_letterboxing():
    crop_w, crop_h, crop_x, crop_y = calculate_crop_rect(1920, 1080, 1080, 1920, 1.0, 1.0)

    assert crop_x + crop_w == 1920 - (1920 - crop_w) % 2 or crop_x + crop_w <= 1920
    assert crop_h == 1080


@pytest.fixture
def engine():
    """Builds the engine without running __init__, which would load YOLO."""
    return OpenCVVideoEngine.__new__(OpenCVVideoEngine)


def test_resolve_dimensions_keep_original_applies_aspect_ratio(engine):
    assert engine._resolve_target_dimensions(1920, 1080, "9:16", "keep original") == (606, 1080)


def test_resolve_dimensions_named_resolution(engine):
    assert engine._resolve_target_dimensions(1920, 1080, "16:9", "1080p") == (1920, 1080)


def test_resolve_dimensions_explicit_resolution_string(engine):
    assert engine._resolve_target_dimensions(1920, 1080, "1:1", "720x720") == (720, 720)


def test_resolve_dimensions_unknown_aspect_ratio_keeps_source_framing(engine):
    """The default settings ship aspect_ratio="keep original", which is not a
    W:H string and previously raised ValueError."""
    assert engine._resolve_target_dimensions(1920, 1080, "keep original", "keep original") == (1920, 1080)


def test_resolve_dimensions_are_even(engine):
    width, height = engine._resolve_target_dimensions(1919, 1081, "9:16", "keep original")
    assert width % 2 == 0 and height % 2 == 0


def test_encoder_args_use_crf_for_software_codecs():
    args = build_encoder_args("libx264", 1080, 1920, 30.0)
    assert "-crf" in args
    assert "-preset" in args
    assert "-b:v" not in args


def test_encoder_args_use_bitrate_for_hardware_codecs():
    """Hardware encoders ignore CRF and default to a low bitrate without -b:v."""
    args = build_encoder_args("h264_videotoolbox", 1080, 1920, 30.0)
    assert "-b:v" in args
    assert "-crf" not in args


@pytest.fixture
def sample_video(tmp_path):
    """A 3 second 1920x1080 clip with an audio track."""
    path = tmp_path / "source.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=3",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", str(path),
        ],
        check=True,
        capture_output=True,
    )
    return str(path)


@requires_ffmpeg
def test_process_clip_produces_requested_dimensions(engine, sample_video, tmp_path, monkeypatch):
    """End-to-end check that the assembled ffmpeg command actually runs and
    that crop-then-scale lands on the requested output size."""
    monkeypatch.setattr(engine, "get_subject_center", lambda *a, **k: None, raising=False)
    output = tmp_path / "clip.mp4"

    engine.process_clip(sample_video, str(output), 0.5, 2.0, "9:16", "keep original")

    assert output.exists()
    width, height, _ = probe_video(str(output))
    assert (width, height) == (606, 1080)


@requires_ffmpeg
@requires_libass
def test_process_clip_burns_subtitles_without_failing(engine, sample_video, tmp_path, monkeypatch):
    """The real burn. Skipped on an ffmpeg built without libass, which has no
    `subtitles` filter to burn with."""
    monkeypatch.setattr(engine, "get_subject_center", lambda *a, **k: None, raising=False)
    subtitles = tmp_path / "clip.ass"
    subtitles.write_text(
        render_ass(
            [CaptionCue(start=0.0, end=1.0, words=[CaptionWord("hello", 0.0, 1.0)])],
            resolve_style("karaoke_pop"),
            606,
            1080,
        ),
        encoding="utf-8",
    )
    output = tmp_path / "clip.mp4"

    engine.process_clip(
        sample_video, str(output), 0.5, 2.0, "9:16", "keep original",
        subtitle_path=str(subtitles),
    )

    assert output.exists() and output.stat().st_size > 0
    assert probe_video(str(output))[:2] == (606, 1080)


@requires_ffmpeg
def test_process_clip_raises_on_ffmpeg_failure(engine, tmp_path, monkeypatch):
    monkeypatch.setattr(engine, "get_subject_center", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(
        "backend.src.infrastructure.video_engine.probe_video",
        lambda path: (1920, 1080, 30.0),
    )

    with pytest.raises(subprocess.CalledProcessError):
        engine.process_clip(
            str(tmp_path / "missing.mp4"), str(tmp_path / "out.mp4"),
            0.0, 1.0, "9:16", "keep original",
        )


def captured_ffmpeg_command(engine, monkeypatch, **kwargs):
    """Runs process_clip with ffmpeg stubbed out, returning the command it built."""
    monkeypatch.setattr(engine, "get_subject_center", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(
        "backend.src.infrastructure.video_engine.probe_video",
        lambda path: (1920, 1080, 30.0),
    )
    captured = {}

    def fake_run(cmd, **_):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr("backend.src.infrastructure.video_engine.subprocess.run", fake_run)
    engine.process_clip("in.mp4", "out.mp4", 0.0, 1.0, "9:16", "keep original", **kwargs)
    return captured["cmd"]


def video_filters(cmd):
    return cmd[cmd.index("-vf") + 1] if "-vf" in cmd else ""


def test_escape_filter_path_survives_the_filter_graph_parser():
    escaped = escape_filter_path("/tmp/a b:c/d'e.ass")
    assert escaped == "/tmp/a b\\:c/d\\'e.ass"


def test_subtitles_are_burned_after_crop_and_scale(engine, monkeypatch):
    """Drawn at output scale: a caption cropped or resampled with the picture
    would not match what the preview showed."""
    filters = video_filters(captured_ffmpeg_command(engine, monkeypatch, subtitle_path="/tmp/c.ass"))

    assert filters.split(",")[-1] == "subtitles='/tmp/c.ass'"
    assert filters.startswith("crop=")


def test_no_subtitle_path_leaves_the_filter_chain_alone(engine, monkeypatch):
    assert "subtitles" not in video_filters(captured_ffmpeg_command(engine, monkeypatch))


def stacked_graph(**kwargs):
    args = build_picture_args(1920, 1080, 1080, 1920, layout="stacked", **kwargs)
    assert args[2:] == ["-map", "[v]"]
    return args[args.index("-filter_complex") + 1]


def test_stacked_keeps_the_whole_frame_in_the_middle():
    graph = stacked_graph()
    # 1920x1080 at 1080 wide is 607.5, rounded to an even 608; the two bands
    # share what is left of 1920 equally.
    assert "[full]scale=1080:608,setsar=1[mid]" in graph
    assert "scale=1080:656," in graph
    assert "[top][mid][bottom]vstack=inputs=3" in graph


def test_stacked_bands_are_darkened_by_the_setting():
    assert "color=black@0.7:t=fill" in stacked_graph(stack_darkness=70)


def test_stacked_darkness_is_clamped():
    assert "color=black@1.0:t=fill" in stacked_graph(stack_darkness=250)
    assert "color=black@0.0:t=fill" in stacked_graph(stack_darkness=-5)


def test_stacked_burns_subtitles_over_the_whole_stack():
    assert stacked_graph(subtitle_path="/tmp/c.ass").endswith("vstack=inputs=3,subtitles='/tmp/c.ass'[v]")


def test_stacked_falls_back_to_crop_when_there_is_no_band_to_fill():
    """A landscape target is no taller than the scaled source."""
    args = build_picture_args(1920, 1080, 1920, 1080, layout="stacked")
    assert "-filter_complex" not in args
    assert args[:2] == ["-map", "0:v:0"]


def test_stacked_process_clip_maps_the_stack_and_the_audio(engine, monkeypatch):
    cmd = captured_ffmpeg_command(engine, monkeypatch, layout="stacked")
    assert "-vf" not in cmd
    assert cmd[cmd.index("-filter_complex") + 2:cmd.index("-filter_complex") + 6] == [
        "-map", "[v]", "-map", "0:a:0?",
    ]


@requires_ffmpeg
def test_stacked_process_clip_produces_requested_dimensions(engine, sample_video, tmp_path, monkeypatch):
    monkeypatch.setattr(engine, "get_subject_center", lambda *a, **k: None, raising=False)
    output = tmp_path / "clip.mp4"

    engine.process_clip(sample_video, str(output), 0.5, 2.0, "9:16", "keep original",
                        layout="stacked", stack_darkness=60)

    assert probe_video(str(output))[:2] == (606, 1080)


@requires_ffmpeg
def test_stacked_extract_frame_darkens_only_the_bands(engine, sample_video, tmp_path, monkeypatch):
    monkeypatch.setattr(engine, "get_subject_center", lambda *a, **k: None, raising=False)
    output = tmp_path / "still.png"

    engine.extract_frame(sample_video, str(output), 1.0, "9:16", "keep original",
                         layout="stacked", stack_darkness=80)

    frame = cv2.imread(str(output), cv2.IMREAD_GRAYSCALE)
    height = frame.shape[0]
    top, middle = frame[: height // 5].mean(), frame[2 * height // 5: 3 * height // 5].mean()
    assert middle > top * 2


def split_graph(**kwargs):
    args = build_picture_args(1920, 1080, 1080, 1920, layout="split", **kwargs)
    assert args[2:] == ["-map", "[v]"]
    return args[args.index("-filter_complex") + 1]


def test_split_puts_the_left_half_on_top_and_the_right_below():
    graph = split_graph()
    # Each 960x1080 half is cover-cropped to the 1080x960 slot it fills: full
    # width, 852 of its height, centred.
    assert "[top_in]crop=960:852:0:114,scale=1080:960,setsar=1[top]" in graph
    assert "[bottom_in]crop=960:852:960:114,scale=1080:960,setsar=1[bottom]" in graph
    assert graph.endswith("[top][bottom]vstack=inputs=2[v]")


def test_split_swap_puts_the_right_half_on_top():
    assert "[top_in]crop=960:852:960:114," in split_graph(split_swap=True)


def test_split_position_moves_the_cut():
    graph = split_graph(split_position=30)
    # The cut lands at 576; the narrower left part keeps less of its height.
    assert "[top_in]crop=576:512:0:284," in graph
    assert "[bottom_in]crop=1214:1080:640:0," in graph


def test_split_divider_is_drawn_on_the_seam_only_when_asked():
    assert "drawbox" not in split_graph()
    assert "vstack=inputs=2,drawbox=x=0:y=956:w=iw:h=8:color=white:t=fill[v]" in split_graph(split_divider=True)


def test_split_burns_subtitles_over_both_halves():
    assert split_graph(subtitle_path="/tmp/c.ass").endswith("vstack=inputs=2,subtitles='/tmp/c.ass'[v]")


def test_split_falls_back_to_crop_for_a_target_that_is_not_portrait():
    args = build_picture_args(1920, 1080, 1080, 1080, layout="split")
    assert "-filter_complex" not in args


@requires_ffmpeg
def test_split_process_clip_produces_requested_dimensions(engine, sample_video, tmp_path, monkeypatch):
    monkeypatch.setattr(engine, "get_subject_center", lambda *a, **k: None, raising=False)
    output = tmp_path / "clip.mp4"

    engine.process_clip(sample_video, str(output), 0.5, 2.0, "9:16", "keep original",
                        layout="split", split_position=40, split_divider=True)

    assert probe_video(str(output))[:2] == (606, 1080)


def test_resolve_output_dimensions_matches_what_process_clip_renders(engine, monkeypatch):
    monkeypatch.setattr(
        "backend.src.infrastructure.video_engine.probe_video",
        lambda path: (1920, 1080, 30.0),
    )
    assert engine.resolve_output_dimensions("in.mp4", "9:16", "keep original") == (606, 1080)


def test_encoder_bitrate_scales_with_output_size():
    small = build_encoder_args("h264_videotoolbox", 854, 480, 30.0)
    large = build_encoder_args("h264_videotoolbox", 3840, 2160, 30.0)
    to_kbps = lambda args: int(args[args.index("-b:v") + 1].rstrip("k"))

    assert to_kbps(large) > to_kbps(small)
    assert to_kbps(small) >= 2000

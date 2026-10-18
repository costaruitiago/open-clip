import cv2
import subprocess
import json
import logging
from functools import lru_cache
from typing import Tuple, Optional, List
from abc import ABC, abstractmethod
from pathlib import Path
from backend.src.settings_manager import settings_manager

logger = logging.getLogger(__name__)

CONFIG_DIR = Path(__file__).resolve().parents[2] / "config"


@lru_cache(maxsize=None)
def _load_config(name: str) -> dict:
    """Loads and caches a JSON config file from backend/config."""
    with open(CONFIG_DIR / name, "r") as f:
        return json.load(f)


@lru_cache(maxsize=8)
def _probe_video_cached(input_path: str, mtime: float, size: int) -> Tuple[int, int, float]:
    """Reads width/height/fps from a video file. Keyed on mtime+size so the
    cache invalidates if the file is replaced."""
    cap = cv2.VideoCapture(input_path)
    try:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = float(cap.get(cv2.CAP_PROP_FPS)) or 30.0
    finally:
        cap.release()
    return width, height, fps


def probe_video(input_path: str) -> Tuple[int, int, float]:
    """Returns (width, height, fps) for a video, cached per file version."""
    stat = Path(input_path).stat()
    return _probe_video_cached(input_path, stat.st_mtime, stat.st_size)


def _make_even(value: int) -> int:
    return value - (value % 2)


def calculate_crop_rect(
    src_w: int, src_h: int, target_w: int, target_h: int,
    subject_x: float = 0.5, subject_y: float = 0.5,
) -> Tuple[int, int, int, int]:
    """Returns the crop rectangle (w, h, x, y) *in source coordinates* that,
    once scaled to target_w x target_h, frames the subject.

    Cropping before scaling means the scaler only touches pixels that survive
    into the output, instead of resizing the whole frame and discarding most
    of it.
    """
    scale = max(target_w / src_w, target_h / src_h)

    crop_w = _make_even(min(src_w, round(target_w / scale)))
    crop_h = _make_even(min(src_h, round(target_h / scale)))

    crop_x = _make_even(int(max(0, min(subject_x * src_w - crop_w / 2, src_w - crop_w))))
    crop_y = _make_even(int(max(0, min(subject_y * src_h - crop_h / 2, src_h - crop_h))))

    return crop_w, crop_h, crop_x, crop_y


def build_picture_args(
    src_w: int, src_h: int, target_w: int, target_h: int,
    subject_x: float = 0.5, subject_y: float = 0.5,
    layout: str = "crop", stack_darkness: int = 50,
    split_position: int = 50, split_swap: bool = False, split_divider: bool = False,
    subtitle_path: Optional[str] = None,
) -> List[str]:
    """Returns the ffmpeg arguments that select and shape the video stream.

    "crop" cuts one window of the source around the subject. "stacked" keeps
    the whole source frame in the middle at full brightness, with darkened
    copies of it filling the bands above and below — the way broadcast news
    turns a widescreen shot into a vertical short. A target no taller than the
    scaled source leaves no band to fill, so it falls back to cropping.

    "split" cuts the source at `split_position` percent of its width and puts
    the left part on top and the right part below (the other way round with
    `split_swap`), each cover-cropped around its own centre to fill its half
    of the frame. It only applies to a portrait target; anything else crops.

    Subtitles are burned last either way, at output scale.
    """
    subtitles = f"subtitles='{escape_filter_path(str(subtitle_path))}'" if subtitle_path else None

    if layout == "split" and target_h > target_w:
        # The top takes the even half, the bottom whatever is left, so an odd
        # half of an even height still adds back up to the target.
        top_h = _make_even(target_h // 2)
        cut = _make_even(round(src_w * max(1, min(int(split_position), 99)) / 100))
        parts = [(0, cut), (cut, src_w - cut)]
        if split_swap:
            parts.reverse()
        chains = []
        for name, (part_x, part_w), slot_h in zip(("top", "bottom"), parts, (top_h, target_h - top_h)):
            crop_w, crop_h, crop_x, crop_y = calculate_crop_rect(part_w, src_h, target_w, slot_h)
            chains.append(
                f"[{name}_in]crop={crop_w}:{crop_h}:{part_x + crop_x}:{crop_y},"
                f"scale={target_w}:{slot_h},setsar=1[{name}]"
            )
        graph = "[0:v:0]split=2[top_in][bottom_in];" + ";".join(chains) + ";[top][bottom]vstack=inputs=2"
        if split_divider:
            thickness = max(2, _make_even(target_h // 240))
            graph += f",drawbox=x=0:y={top_h - thickness // 2}:w=iw:h={thickness}:color=white:t=fill"
        if subtitles:
            graph += f",{subtitles}"
        return ['-filter_complex', graph + "[v]", '-map', '[v]']

    mid_h = _make_even(round(target_w * src_h / src_w))
    band_h = _make_even((target_h - mid_h) // 2)
    if layout == "stacked" and band_h > 0:
        # The middle absorbs the even-rounding, so both bands are the same and
        # one band can be rendered once and split.
        mid_h = target_h - 2 * band_h
        band_w, band_crop_h, band_x, band_y = calculate_crop_rect(
            src_w, src_h, target_w, band_h, subject_x, subject_y
        )
        opacity = max(0, min(int(stack_darkness), 100)) / 100
        graph = (
            "[0:v:0]split=2[full][band];"
            f"[full]scale={target_w}:{mid_h},setsar=1[mid];"
            f"[band]crop={band_w}:{band_crop_h}:{band_x}:{band_y},"
            f"scale={target_w}:{band_h},setsar=1,"
            f"drawbox=x=0:y=0:w=iw:h=ih:color=black@{opacity}:t=fill,"
            "split=2[top][bottom];"
            "[top][mid][bottom]vstack=inputs=3"
        )
        if subtitles:
            graph += f",{subtitles}"
        return ['-filter_complex', graph + "[v]", '-map', '[v]']

    crop_w, crop_h, crop_x, crop_y = calculate_crop_rect(
        src_w, src_h, target_w, target_h, subject_x, subject_y
    )
    # Crop first, then scale, so the scaler only processes surviving pixels.
    filters = []
    if (crop_w, crop_h) != (src_w, src_h):
        filters.append(f"crop={crop_w}:{crop_h}:{crop_x}:{crop_y}")
    if (crop_w, crop_h) != (target_w, target_h):
        filters.append(f"scale={target_w}:{target_h}")
    if subtitles:
        filters.append(subtitles)

    args = ['-map', '0:v:0']
    if filters:
        args += ['-vf', ','.join(filters)]
    return args


def build_encoder_args(codec: str, target_w: int, target_h: int, fps: float) -> List[str]:
    """Returns codec-appropriate quality flags.

    Software x264/x265 use CRF; hardware encoders (videotoolbox, nvenc, qsv,
    vaapi) ignore CRF and fall back to a low default bitrate unless one is
    given explicitly, so a target bitrate is derived from the output size.
    """
    if codec.startswith("libx264"):
        return ["-preset", settings_manager.get("x264_preset") or "veryfast",
                "-crf", str(settings_manager.get("crf") or 21)]
    if codec.startswith("libx265"):
        return ["-preset", settings_manager.get("x264_preset") or "veryfast",
                "-crf", str(settings_manager.get("crf") or 26)]

    configured = settings_manager.get("video_bitrate")
    if configured:
        bitrate_kbps = int(configured)
    else:
        # ~0.1 bits per pixel per second is a reasonable h264 quality target.
        bitrate_kbps = max(2000, int(target_w * target_h * fps * 0.1 / 1000))
    return ["-b:v", f"{bitrate_kbps}k"]


def escape_filter_path(path: str) -> str:
    """Escapes a path for use as a value inside an ffmpeg filter argument.

    The filter graph parser eats backslashes, colons and quotes before the
    filter ever sees them, so each has to survive two rounds of unescaping.
    """
    return path.replace('\\', '\\\\').replace(':', '\\:').replace("'", "\\'")


class VideoEngine(ABC):
    @abstractmethod
    def get_subject_center(self, input_path: str, timestamp: float) -> Optional[Tuple[float, float]]:
        pass

    @abstractmethod
    def process_clip(
        self, input_path: str, output_path: str, start: float, end: float,
        aspect_ratio: str, resolution: str, subtitle_path: Optional[str] = None,
        layout: str = "crop", stack_darkness: int = 50,
        split_position: int = 50, split_swap: bool = False, split_divider: bool = False,
    ) -> None:
        pass

class OpenCVVideoEngine(VideoEngine):
    def __init__(self, model_path: str):
        from ultralytics import YOLO
        self.model = YOLO(model_path)

    def get_subject_center(self, input_path: str, timestamp: float) -> Optional[Tuple[float, float]]:
        _, _, fps = probe_video(input_path)
        cap = cv2.VideoCapture(input_path)
        try:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(timestamp * fps))
            ret, frame = cap.read()
        finally:
            cap.release()
        if not ret: return None
        h, w = frame.shape[:2]
        results = self.model(frame, classes=[0], verbose=False)
        if len(results) > 0 and len(results[0].boxes) > 0:
            box = results[0].boxes[0].xywh[0]
            return (float(box[0]) / w, float(box[1]) / h)
        return None

    def _resolve_target_dimensions(self, src_w: int, src_h: int, aspect_ratio: str, resolution: str) -> Tuple[int, int]:
        """Resolves the output dimensions from the configured aspect ratio and resolution."""
        ar_map = _load_config("aspect_ratios.json")
        ratio = ar_map.get(aspect_ratio, aspect_ratio)
        if ":" in ratio:
            ar_w, ar_h = map(int, ratio.split(":"))
        else:
            # "keep original" or anything unrecognised: keep the source framing.
            ar_w, ar_h = src_w, src_h

        if resolution == "keep original":
            # Use source dimensions but apply the aspect ratio
            if ar_w / ar_h >= src_w / src_h:
                target_w, target_h = src_w, int(src_w * ar_h / ar_w)
            else:
                target_w, target_h = int(src_h * ar_w / ar_h), src_h
        else:
            res_map = _load_config("resolutions.json")
            target_w, target_h = map(int, res_map.get(resolution, resolution).split("x"))

        # Ensure dimensions are even (required by most codecs)
        return _make_even(target_w), _make_even(target_h)

    def resolve_output_dimensions(self, input_path: str, aspect_ratio: str, resolution: str) -> Tuple[int, int]:
        """The frame size `process_clip` would render at, without rendering it.

        Captions are sized as percentages of the output frame, so whatever
        builds the subtitle file has to resolve these first.
        """
        src_w, src_h, _ = probe_video(input_path)
        return self._resolve_target_dimensions(src_w, src_h, aspect_ratio, resolution)

    def process_clip(
        self, input_path: str, output_path: str, start: float, end: float,
        aspect_ratio: str, resolution: str, subtitle_path: Optional[str] = None,
        layout: str = "crop", stack_darkness: int = 50,
        split_position: int = 50, split_swap: bool = False, split_divider: bool = False,
    ) -> None:
        src_w, src_h, fps = probe_video(input_path)
        target_w, target_h = self._resolve_target_dimensions(src_w, src_h, aspect_ratio, resolution)

        # Smart Center
        subj_x, subj_y = self.get_subject_center(input_path, start) or (0.5, 0.5)

        # Captions are burned last, so they are drawn at output scale rather
        # than being cropped or resampled along with the picture.
        picture = build_picture_args(
            src_w, src_h, target_w, target_h, subj_x, subj_y,
            layout=layout, stack_darkness=stack_darkness, split_position=split_position,
            split_swap=split_swap, split_divider=split_divider, subtitle_path=subtitle_path,
        )

        codec = settings_manager.get("codec") or "libx264"
        logger.info(f"Encoding clip with codec: {codec}, target={target_w}x{target_h}, layout={layout}")

        cmd = [
            'ffmpeg', '-y', '-nostdin', '-loglevel', 'error',
            '-ss', str(start),
            '-to', str(end),
            '-i', input_path,
            *picture,
            '-map', '0:a:0?',
        ]
        cmd += ['-c:v', codec]
        cmd += build_encoder_args(codec, target_w, target_h, fps)
        cmd += [
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            output_path,
        ]

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            logger.error(f"ffmpeg failed for {output_path}: {result.stderr.strip()}")
            raise subprocess.CalledProcessError(result.returncode, cmd, stderr=result.stderr)

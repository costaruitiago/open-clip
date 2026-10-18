from dataclasses import dataclass, asdict, field
from typing import Callable, List, Dict, Any, Optional
from datetime import datetime
from pathlib import Path
import json
import csv
import logging
import math
import os
import re
import threading

logger = logging.getLogger(__name__)

# One lock per project id, so writes from concurrently running steps serialize
# instead of overwriting each other.
_METADATA_LOCKS: Dict[str, threading.RLock] = {}
_METADATA_LOCKS_GUARD = threading.Lock()


def _metadata_lock(project_id: str) -> threading.RLock:
    with _METADATA_LOCKS_GUARD:
        lock = _METADATA_LOCKS.get(project_id)
        if lock is None:
            lock = threading.RLock()
            _METADATA_LOCKS[project_id] = lock
        return lock

@dataclass
class WordMapEntry:
    word: str
    start: float
    end: float

@dataclass
class WordMap:
    entries: List[WordMapEntry] = field(default_factory=list)

    def load(self, project: 'Project'):
        path = project.get_artifact_path("word_map_file")
        self.entries = []
        with open(path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                self.entries.append(WordMapEntry(
                    word=row["word"],
                    start=float(row["start"]),
                    end=float(row["end"])
                ))

@dataclass
class ProjectFileSettings:
    transcription_file: str = "transcription.txt"
    word_map_file: str = "word_map.csv"
    original_file: str = "original.mp4"
    marker_file: str = "markers.edl"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

# ... inside Project class ...

@dataclass
class Highlights:
    items: List[Dict[str, Any]]
    total_highlights: int = 0
    total_clips: int = 0

    def __post_init__(self):
        self.highlights = []
        for index, item in enumerate(self.items):
            if not isinstance(item, dict):
                logger.warning(f"Dropping highlight {index}: not an object")
                continue
            h = Highlight.from_json(item)
            if h.end <= h.start:
                logger.warning(
                    f"Dropping highlight {index} with unusable range "
                    f"start={item.get('start')!r} end={item.get('end')!r}"
                )
                continue
            self.highlights.append(h)
        self.total_highlights = len(self.highlights)
        self.total_clips = len([h for h in self.highlights if h.is_clip_generated])

def _as_seconds(value: Any) -> float:
    """Coerces an LLM- or file-supplied timestamp to non-negative seconds.

    Anything unreadable becomes 0.0, which `Highlights` then drops as an empty
    range rather than cutting a clip at the top of the video.
    """
    if isinstance(value, bool) or value is None:
        return 0.0
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        logger.warning(f"Unreadable highlight timestamp {value!r}")
        return 0.0
    if seconds != seconds or seconds in (float("inf"), float("-inf")):
        return 0.0
    return max(0.0, seconds)


def _bounded(value: Any, low: float, high: float, fallback: float) -> float:
    """Coerces a user- or file-supplied number into `[low, high]`.

    Overlay numbers reach an ASS file and inline CSS, so anything unreadable
    falls back rather than propagating a NaN into either renderer.
    """
    if isinstance(value, bool) or value is None:
        return fallback
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number or number in (float("inf"), float("-inf")):
        return fallback
    return max(low, min(high, number))


def _hex_color(value: Any, fallback: Optional[str]) -> Optional[str]:
    """Accepts `#RGB`, `#RRGGBB` or `#RRGGBBAA`; anything else keeps `fallback`.

    None passes through, which is what "no background block" means.
    """
    if value is None:
        return None
    if not isinstance(value, str) or not value.startswith("#"):
        return fallback
    digits = value.strip()[1:]
    if len(digits) not in (3, 6, 8) or any(c not in "0123456789abcdefABCDEF" for c in digits):
        return fallback
    if len(digits) == 3:
        digits = "".join(c * 2 for c in digits)
    return f"#{digits.upper()}"


@dataclass
class OverlayText:
    """A title drawn over one clip for the first few seconds, then faded out.

    Separate from captions on purpose: captions are the spoken words, timed by
    the word map and styled per project, while this is one piece of text the
    user writes for one clip. They share a renderer — both end up as events in
    the same ASS file — but nothing else.

    Sizes are percentages of the output frame, like a caption style, so the
    browser preview and the burned render draw the same thing at different
    sizes. Times are seconds from the start of the clip, not from the start of
    the source video.
    """

    enabled: bool = False
    text: str = ""
    # Defaulted to the top of the clip because that is what a title is for; the
    # field exists so a user who wants it later is not blocked.
    start: float = 0.0
    duration: float = 3.0
    # No fade in by default: a title is meant to be readable on the first frame,
    # and a clip whose opening second is spent ramping one up has thrown that
    # frame away. It is a field rather than a constant so a fade can be asked
    # for; it is simply not assumed.
    fade_in: float = 0.0
    fade_out: float = 0.6
    font_family: str = "Arial Black"
    # Thumbnail guidance says as large as possible, and the frame says how
    # large that is: libass wraps at spaces but cannot break a word, so a title
    # sized past what its longest word can fit is a word cut off at the frame
    # edge. Eight percent of a 1080x1920 short holds about eight uppercase
    # characters a line in Arial Black, which most hooks clear. Anything longer
    # is a size decision on that clip, and the editor says when one is due.
    font_size_pct: float = 8.0
    bold: bool = True
    italic: bool = False
    uppercase: bool = True
    text_color: str = "#FFFFFF"
    outline_color: str = "#000000"
    # Toward the heavy end of the 4-8px advised for a 720-high still, because a
    # video frame is the busy background the same guidance says to go heavier
    # on: whatever is behind these words is moving footage, never a flat colour.
    outline_pct: float = 0.9
    # A hard offset shadow, drawn down and right with no blur, the way the
    # caption style's is. It is what makes a title read as sitting *over* the
    # picture rather than printed onto it — and, unlike a fade or a scale-up,
    # it is still there in one frame. That matters because this same object is
    # drawn on the thumbnail, which is a single frame and has no motion to
    # show: any pop that depends on time is a pop the thumbnail never gets.
    shadow_color: str = "#000000"
    shadow_pct: float = 0.8
    # One word in a second colour is what a thumbnail that gets clicked does:
    # the eye lands on the marked word and reads out from it. The user marks it
    # by wrapping it in asterisks, so the mark lives in the text they already
    # type rather than in a second field they have to keep in step with it. A
    # title with no asterisks in it is drawn exactly as before.
    highlight_color: str = "#FFE000"
    box_color: Optional[str] = None
    # Distance from the *top* of the frame to the top of the text. Captions
    # measure from the bottom because that is where captions live; a title is
    # placed from the edge it hangs off.
    position_pct: float = 12.0
    max_width_pct: float = 86.0

    @property
    def end(self) -> float:
        return self.start + self.duration

    def is_visible(self) -> bool:
        """Whether this would actually draw anything."""
        return bool(self.enabled and self.text.strip() and self.duration > 0)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Any) -> 'OverlayText':
        if not isinstance(data, dict):
            return cls()
        defaults = cls()
        return cls(
            enabled=bool(data.get("enabled", False)),
            # Trimmed of nothing: leading spaces are the user's business. Only
            # the length is capped, because this is drawn on a video frame.
            text=str(data.get("text") or "")[:200],
            start=_bounded(data.get("start", defaults.start), 0.0, 3600.0, defaults.start),
            duration=_bounded(data.get("duration", defaults.duration), 0.1, 600.0, defaults.duration),
            fade_in=_bounded(data.get("fade_in", defaults.fade_in), 0.0, 10.0, defaults.fade_in),
            fade_out=_bounded(data.get("fade_out", defaults.fade_out), 0.0, 10.0, defaults.fade_out),
            font_family=str(data.get("font_family") or defaults.font_family)[:100],
            font_size_pct=_bounded(data.get("font_size_pct", defaults.font_size_pct), 1.0, 25.0, defaults.font_size_pct),
            bold=bool(data.get("bold", defaults.bold)),
            italic=bool(data.get("italic", defaults.italic)),
            uppercase=bool(data.get("uppercase", defaults.uppercase)),
            text_color=_hex_color(data.get("text_color"), defaults.text_color) or defaults.text_color,
            outline_color=_hex_color(data.get("outline_color"), defaults.outline_color) or defaults.outline_color,
            outline_pct=_bounded(data.get("outline_pct", defaults.outline_pct), 0.0, 3.0, defaults.outline_pct),
            shadow_color=_hex_color(data.get("shadow_color"), defaults.shadow_color) or defaults.shadow_color,
            shadow_pct=_bounded(data.get("shadow_pct", defaults.shadow_pct), 0.0, 3.0, defaults.shadow_pct),
            highlight_color=_hex_color(data.get("highlight_color"), defaults.highlight_color) or defaults.highlight_color,
            box_color=_hex_color(data.get("box_color"), defaults.box_color),
            position_pct=_bounded(data.get("position_pct", defaults.position_pct), 0.0, 100.0, defaults.position_pct),
            max_width_pct=_bounded(data.get("max_width_pct", defaults.max_width_pct), 10.0, 100.0, defaults.max_width_pct),
        )


@dataclass
class ThumbnailSettings:
    """The still picture that stands for one clip, and how it is built.

    Every field has a default that produces something publishable without the
    user touching anything: the first frame of the clip, no subtitles, and the
    clip's own title drawn over it. That is the whole point of the defaults —
    a clip that is never opened still gets a thumbnail, and the settings here
    only describe departures from it.

    `frame_time` is seconds from the start of the clip, like an overlay's
    times, not a position in the source video. `extra` is a second piece of
    text the user adds for the thumbnail alone; it never reaches the video.
    """

    frame_time: float = 0.0
    # Off by default: a caption caught mid-sentence is the one thing a
    # thumbnail does not need, and the words are legible in the video itself.
    show_captions: bool = False
    show_overlay: bool = True
    extra: Optional[OverlayText] = None
    # What the last render produced, or None while none has been made. The
    # filename does not change between renders, so `generated_at` is what a
    # browser holding the previous image is told about the new one.
    generated_filename: Optional[str] = None
    generated_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["extra"] = self.extra.to_dict() if self.extra else None
        return data

    @classmethod
    def from_dict(cls, data: Any) -> 'ThumbnailSettings':
        if not isinstance(data, dict):
            return cls()
        defaults = cls()
        extra = data.get("extra")
        return cls(
            # An hour is well past any short; the clip's own length bounds it
            # again at render time, where the duration is actually known.
            frame_time=_bounded(data.get("frame_time", defaults.frame_time), 0.0, 3600.0, defaults.frame_time),
            show_captions=bool(data.get("show_captions", defaults.show_captions)),
            show_overlay=bool(data.get("show_overlay", defaults.show_overlay)),
            extra=OverlayText.from_dict(extra) if isinstance(extra, dict) else None,
            generated_filename=data.get("generated_filename") or None,
            generated_at=data.get("generated_at") or None,
        )


# The shortest window a trim may leave behind. The model picks a highlight worth
# publishing; the trim only nudges its edges, and a window shorter than this is
# a slip of a nudge button rather than an edit anybody meant.
CLIP_MIN_DURATION = 0.5


@dataclass
class Highlight:
    highlight_text: str
    viral_hook_text: str
    video_description_for_x: str
    video_description_for_reddit: str
    video_description_for_linkedin: str
    video_title_for_youtube_short: str
    start: float
    end: float
    # The model's description of this short on its own. It carries no link and
    # no boilerplate: the sentence pointing back at the source video and any
    # standing text come from the description template, which is the user's to
    # edit. Defaulted because it sits after `start`/`end` and because every
    # highlight produced before this field existed simply has none.
    video_description_for_youtube_short: str = ""
    # The words for the still image, which is the thing anyone decides to click
    # on. Separate from `viral_hook_text` because the two are read under
    # different conditions: the hook is laid over the opening seconds of a video
    # that is already playing, while this is read at about 120 pixels wide in a
    # feed, with no sound and no context. That makes it shorter, blunter, and
    # carrying one word marked with asterisks for the renderer to colour.
    # Defaulted because every highlight produced before this field existed has
    # none, and the thumbnail falls back to the hook for those.
    thumbnail_text: str = ""
    is_clip_generated: bool = False
    generated_clip_filename: Optional[str] = None
    # What a YouTube upload of this clip produced, or None while it has never
    # been published. Kept per highlight rather than in a project-level list
    # because publishing is irreversible from here: the clip page has to be able
    # to say "this one is already live" before the user clicks again.
    youtube_video_id: Optional[str] = None
    youtube_url: Optional[str] = None
    uploaded_at: Optional[str] = None
    # What the video is on YouTube — private, unlisted or public — and, for a
    # scheduled one, when YouTube itself turns it public. Recorded because it
    # is the one thing about a published clip this app cannot show by linking
    # to it: a scheduled short and a private one are the same page until the
    # hour comes, and only this says which is which.
    youtube_privacy: Optional[str] = None
    youtube_publish_at: Optional[str] = None
    # Why the last publish attempt did not produce a video, or None when the
    # last attempt worked or none has been made. Publishing runs in the
    # background — it re-cuts the clip first, which outlives a browser request —
    # so the sentence the user needs cannot be the response to their click; it
    # is written here and read back when the job leaves /active_processes.
    upload_error: Optional[str] = None
    # What importing this clip into Postiz produced, or None while it has never
    # been imported. Kept beside the YouTube record rather than replacing it:
    # the two are different destinations for the same clip — YouTube is
    # published from here, Postiz is a draft somebody still has to send — and a
    # clip can legitimately be in both.
    postiz_post_id: Optional[str] = None
    postiz_url: Optional[str] = None
    postiz_imported_at: Optional[str] = None
    # Which channels the last import filed against, as {id, name, platform}.
    # Stored because the clip page has to be able to say where the draft went:
    # the channel selection lives in application settings and can change between
    # one import and the next.
    postiz_channels: List[Dict[str, Any]] = field(default_factory=list)
    # Why the last import filed nothing, or None when it worked or none has been
    # made. Written for the same reason `upload_error` is: the import runs in
    # the background, so the sentence the user needs cannot be the response to
    # their click.
    postiz_error: Optional[str] = None
    # What Postiz stored this clip's video as, and which version of the file
    # that was. The video is uploaded before the post is created, so a post
    # that fails — a channel missing a required setting, a rate limit — leaves
    # the bytes already there. Remembering them means the next attempt sends a
    # request instead of forty megabytes again, and Postiz keeps one copy of
    # the clip rather than one per attempt.
    #
    # The fingerprint is the file's own — size and last-written time — rather
    # than anything this app maintains, so a clip re-cut by any route
    # invalidates it without needing to remember to.
    postiz_media_id: Optional[str] = None
    postiz_media_path: Optional[str] = None
    postiz_media_fingerprint: Optional[str] = None
    # What Postiz has done with the post since, as of the last time it was
    # asked: "published", "scheduled", "error", or None for a post it will not
    # talk about — which is every draft, because the public API does not return
    # them. None therefore means "not sent, or deleted, and Postiz will not say
    # which", never "gone".
    postiz_state: Optional[str] = None
    postiz_synced_at: Optional[str] = None
    # The group Postiz filed the first of this clip's channels under. Recorded
    # because Postiz reports it, and for nothing else: it does not tie a clip's
    # channels together. One clip filed to two accounts comes back as two posts
    # with two different groups, so what identifies this clip's posts is the
    # per-channel ids in `postiz_channels`, not this.
    postiz_group: Optional[str] = None
    # Whether the rendered file has captions in its pixels. The preview overlay
    # keys off this: drawing captions over a clip that already has them burned
    # in would show every word twice.
    captions_burned: bool = False
    # Caption settings belonging to this clip alone, or None to follow the
    # project. None is the locked state: the clip has no opinion and inherits
    # whatever the project currently says, including later changes to it.
    # Storing None rather than a copy is what makes that inheritance live.
    captions: Optional[CaptionSettings] = None
    # The title drawn over this clip, or None for a clip that has never had one.
    # Per clip rather than per project: it is text about this moment.
    overlay: Optional[OverlayText] = None
    # Whether the rendered file already has the overlay in its pixels, the same
    # promise `captions_burned` makes about the captions. The preview draws the
    # overlay only while this is false, so a re-render does not show it twice.
    overlay_burned: bool = False
    # When the file on disk was last written. The filename does not change
    # between renders, so this is what a browser cache is busted with after a
    # clip is regenerated.
    rendered_at: Optional[str] = None
    # The output geometry the file on disk was actually cut with. Changing the
    # project's aspect ratio or resolution re-shapes every clip without touching
    # a file, so without these a card boxed to the new shape goes on playing a
    # cut made for the old one — a crop nobody asked for, presented as the
    # finished clip. None means a file cut before this was recorded, which reads
    # as "matches" rather than as stale.
    rendered_aspect_ratio: Optional[str] = None
    rendered_resolution: Optional[str] = None
    # The layout the file was cut with, for the same reason. None is a file cut
    # before layouts existed, which was always a crop.
    rendered_layout: Optional[str] = None
    # When somebody last moved this clip's start or end, or None for a window
    # nobody has touched. Kept because a trim does not re-cut anything: the file
    # on disk still holds the old window, and a card showing the new timecodes
    # over the old footage is a lie the user has no way to spot. Later than
    # `rendered_at` is what "this clip needs cutting again" means.
    trimmed_at: Optional[str] = None
    # How this clip's thumbnail is built, or None for a clip nobody has chosen
    # a frame for. None is not "no thumbnail": it means the defaults, which is
    # exactly what a thumbnail rendered without any input uses.
    thumbnail: Optional[ThumbnailSettings] = None
    # What Jev answered about this clip when Jev picked it — hook, arc, the
    # combined score, and the loop probability with whether the cut used it —
    # or None for a clip Gemini picked.
    jev_scores: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        # asdict turns a None dataclass field into None and a present one into
        # a plain dict, which is exactly the shape from_json reads back.
        data["captions"] = self.captions.to_dict() if self.captions else None
        data["overlay"] = self.overlay.to_dict() if self.overlay else None
        data["thumbnail"] = self.thumbnail.to_dict() if self.thumbnail else None
        return data

    @classmethod
    def from_json(cls, data: Dict[str, Any]) -> 'Highlight':
        """Builds a Highlight from stored or LLM-returned JSON.

        `start`/`end` are taken verbatim from the payload. The highlights prompt
        picks them straight out of the word map and the schema requires them, so
        there is no text-matching step: a clip and its EDL marker are always cut
        from the same two numbers, whenever either is produced.
        """
        return cls(
            highlight_text=data.get("highlight_text", ""),
            viral_hook_text=data.get("viral_hook_text", ""),
            video_description_for_x=data.get("video_description_for_x", ""),
            video_description_for_reddit=data.get("video_description_for_reddit", ""),
            video_description_for_linkedin=data.get("video_description_for_linkedin", ""),
            video_title_for_youtube_short=data.get("video_title_for_youtube_short", ""),
            video_description_for_youtube_short=data.get("video_description_for_youtube_short", ""),
            thumbnail_text=data.get("thumbnail_text", ""),
            start=_as_seconds(data.get("start")),
            end=_as_seconds(data.get("end")),
            is_clip_generated=data.get("is_clip_generated", False),
            generated_clip_filename=data.get("generated_clip_filename"),
            youtube_video_id=data.get("youtube_video_id"),
            youtube_url=data.get("youtube_url"),
            uploaded_at=data.get("uploaded_at"),
            # Absent for every clip published before an upload could be
            # anything but private, which is what the reader assumes for one.
            youtube_privacy=data.get("youtube_privacy"),
            youtube_publish_at=data.get("youtube_publish_at"),
            upload_error=data.get("upload_error"),
            # Absent for every clip nobody has imported, which is every clip
            # written before Postiz was wired in.
            postiz_post_id=data.get("postiz_post_id"),
            postiz_url=data.get("postiz_url"),
            postiz_imported_at=data.get("postiz_imported_at"),
            postiz_channels=(
                [entry for entry in data["postiz_channels"] if isinstance(entry, dict)]
                if isinstance(data.get("postiz_channels"), list)
                else []
            ),
            postiz_error=data.get("postiz_error"),
            postiz_media_id=data.get("postiz_media_id"),
            postiz_media_path=data.get("postiz_media_path"),
            postiz_media_fingerprint=data.get("postiz_media_fingerprint"),
            postiz_state=data.get("postiz_state"),
            postiz_synced_at=data.get("postiz_synced_at"),
            postiz_group=data.get("postiz_group"),
            # Clips cut before captions existed have none burned in, which is
            # exactly what the default says.
            captions_burned=data.get("captions_burned", False),
            # Absent or null means locked to the project, which is what every
            # highlight written before this field existed will say.
            captions=(
                CaptionSettings.from_dict(data["captions"])
                if isinstance(data.get("captions"), dict)
                else None
            ),
            # Absent for every clip that has never been given a title, which is
            # every clip written before this field existed.
            overlay=(
                OverlayText.from_dict(data["overlay"])
                if isinstance(data.get("overlay"), dict)
                else None
            ),
            overlay_burned=data.get("overlay_burned", False),
            rendered_at=data.get("rendered_at"),
            # Absent for every clip cut before the geometry was recorded, which
            # is read as matching the current settings: the alternative is
            # declaring every already-rendered clip in every project stale.
            rendered_aspect_ratio=data.get("rendered_aspect_ratio"),
            rendered_resolution=data.get("rendered_resolution"),
            rendered_layout=data.get("rendered_layout"),
            # Absent for every clip whose window is still the one the model
            # picked, which is every clip written before trimming existed.
            trimmed_at=data.get("trimmed_at"),
            # Absent for every clip whose thumbnail has never been touched,
            # which reads as "the defaults" rather than as "none".
            thumbnail=(
                ThumbnailSettings.from_dict(data["thumbnail"])
                if isinstance(data.get("thumbnail"), dict)
                else None
            ),
            jev_scores=data.get("jev_scores") if isinstance(data.get("jev_scores"), dict) else None,
        )

@dataclass
class VideoComponent:
    index: int
    title: str
    summary: str
    post_for_x: str
    post_for_reddit: str
    post_for_linkedin: str
    reason: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
@dataclass
class VideoMetadata:
    components: List[VideoComponent] = field(default_factory=list)
    top_recommendations: List[Dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_llm(cls, data: Dict[str, Any]) -> 'VideoMetadata':
        """Builds the stored shape from whatever the metadata prompt returned.

        The prompt returns one overall `summary`, a flat list of `titles`, and a
        `top_2` list referring back to those titles by index. Older prompts
        returned `components`/`top_recommendations` with the summary and reason
        repeated on every item, so both are accepted.
        """
        if isinstance(data, list):
            data = {"components": data}

        items = data.get("components") or data.get("titles") or []
        recommendations = data.get("top_recommendations") or data.get("top_2") or []

        # The reason lives on the recommendation, not on the title it points at.
        reasons: Dict[int, str] = {}
        for entry in recommendations:
            if isinstance(entry, dict) and isinstance(entry.get("index"), int):
                reasons[entry["index"]] = str(entry.get("reason", ""))

        overall_summary = str(data.get("summary", ""))
        components = []
        for position, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            index = item.get("index")
            if not isinstance(index, int) or isinstance(index, bool):
                index = position
            components.append(VideoComponent(
                index=index,
                title=str(item.get("title", "")),
                summary=str(item.get("summary") or overall_summary),
                post_for_x=str(item.get("post_for_x", "")),
                post_for_reddit=str(item.get("post_for_reddit", "")),
                post_for_linkedin=str(item.get("post_for_linkedin", "")),
                reason=str(item.get("reason") or reasons.get(index, "")),
            ))

        return cls(components=components, top_recommendations=list(recommendations))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "components": [c.to_dict() for c in self.components],
            "top_recommendations": self.top_recommendations
        }

@dataclass
class CaptionSettings:
    """Per-project caption choice: a named preset plus any tweaks on top of it.

    Only the preset name and the fields the user actually changed are stored.
    Keeping overrides sparse means a preset can be improved in config and every
    project that did not deliberately override that field picks the change up.
    """
    enabled: bool = False
    preset: str = "karaoke_pop"
    overrides: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Any) -> 'CaptionSettings':
        if not isinstance(data, dict):
            return cls()
        overrides = data.get("overrides")
        return cls(
            enabled=bool(data.get("enabled", False)),
            preset=str(data.get("preset") or "karaoke_pop"),
            overrides=dict(overrides) if isinstance(overrides, dict) else {},
        )


@dataclass
class DescriptionSettings:
    """What this project contributes to the YouTube description of its clips.

    `source_url` is the full episode the shorts were cut from. It becomes a
    link in the description of every clip, so it is a project fact rather than
    something the model can invent, and `source_title` is how the episode is
    named in prose. It is not YouTube's "Related video" chip: that has no field
    in the Data API and is set per short in Studio.

    `text` is the project's standing text — a call to action, links, credits —
    and `template` overrides the application-wide description template for this
    project alone. Both are empty by default, meaning "use the global one".
    """
    source_url: str = ""
    source_title: str = ""
    text: str = ""
    template: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Any) -> 'DescriptionSettings':
        if not isinstance(data, dict):
            return cls()
        return cls(
            source_url=str(data.get("source_url") or ""),
            source_title=str(data.get("source_title") or ""),
            text=str(data.get("text") or ""),
            template=str(data.get("template") or ""),
        )


# The widest a project may ask the highlights prompt for. Not what anything
# defaults to — see `backend/src/services/highlight_options.py` — only what
# stops a typo in a number field from becoming a prompt asking for a thousand
# ten-hour clips.
HIGHLIGHT_MAX_CLIPS = 100
HIGHLIGHT_MAX_DURATION = 3600.0


def _as_count(value: Any, low: int, high: int) -> Optional[int]:
    """A whole number inside `[low, high]`, or None for anything that is not one.

    None is "the project has no opinion", which is how every field of
    `HighlightSettings` keeps following the application.
    """
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if low <= number <= high else None


def _as_duration(value: Any, low: float, high: float) -> Optional[float]:
    """A length in seconds inside `[low, high]`, or None when it is not one."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number if low <= number <= high else None


@dataclass
class HighlightSettings:
    """What this project asks the highlights prompt for, when it differs from the app's.

    The prompt used to hard-code how many segments to find and how long they
    may run, which made every project a podcast cut into 7–12 shorts. A
    two-hour interview and a ten-minute talk do not have the same number of
    good moments in them, and TikTok and a conference reel do not want the same
    lengths — so these are settings rather than sentences in a file.

    Every field is None while the project has no opinion, which is what keeps
    the application default live: change it in Settings and a project that
    never chose follows it. `guidance` is free text appended to the prompt —
    what this project counts as a highlight, in the user's own words — and is
    empty by default, meaning the prompt says nothing extra.
    """
    min_clips: Optional[int] = None
    max_clips: Optional[int] = None
    min_duration: Optional[float] = None
    max_duration: Optional[float] = None
    guidance: str = ""
    # The Jev score a clip needs to count as one of this project's clips rather
    # than one of the moments below the cutoff. None follows the application's
    # `jev_min_score`. Moved freely after a run: every moment is already scored.
    jev_min_score: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Any) -> 'HighlightSettings':
        if not isinstance(data, dict):
            return cls()
        return cls(
            # Bounded rather than trusted: these numbers are written into a
            # prompt, and "find 4000 segments" is a bill rather than a request.
            min_clips=_as_count(data.get("min_clips"), 1, HIGHLIGHT_MAX_CLIPS),
            max_clips=_as_count(data.get("max_clips"), 1, HIGHLIGHT_MAX_CLIPS),
            min_duration=_as_duration(data.get("min_duration"), 1, HIGHLIGHT_MAX_DURATION),
            max_duration=_as_duration(data.get("max_duration"), 1, HIGHLIGHT_MAX_DURATION),
            guidance=str(data.get("guidance") or ""),
            jev_min_score=_as_duration(data.get("jev_min_score"), 0, 1),
        )


def _as_hour(value: Any) -> Optional[int]:
    """An hour of the day, or None for anything that is not one."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 <= value <= 23 else None


def _as_start_date(value: Any) -> Optional[str]:
    """A YYYY-MM-DD day, or None for anything that is not one.

    Checked for shape rather than parsed: this is written back into a date
    input, and a string that is not a date empties it silently instead of
    showing the user something they never typed.
    """
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    return value


@dataclass
class PostizSettings:
    """Where this project's clips are imported, when it differs from the app's.

    A machine has one Postiz account, and projects on it are not one thing: a
    company's podcast and somebody's side project are cut on the same install
    and must not go to the same accounts. So the application settings are the
    default, and a project may disagree.

    `channels` is None while the project has no opinion, which is what every
    project says until somebody chooses for it — and it is not the same as an
    empty list, which is a project that has chosen to import nowhere. Storing
    None rather than a copy of the global list is what keeps the inheritance
    live: change the default later and a project that never chose follows it.

    `channel_settings` is layered over the global one per channel rather than
    replacing it, so a project can send to a different Discord channel without
    restating everything else about that account.
    """
    channels: Optional[List[str]] = None
    post_type: Optional[str] = None
    channel_settings: Dict[str, Dict[str, str]] = field(default_factory=dict)
    # How many of this project's clips land per day, or None to follow the
    # application. 0 means all of them on the same day, which is what an import
    # did before anybody could say otherwise.
    per_day: Optional[int] = None
    # The rest of the calendar, shaped exactly like `UploadSettings` and read
    # by the same arithmetic: a project spread "two a day between nine and
    # nine" has to mean one thing whether the clips go to YouTube or to Postiz,
    # and two panels that disagree about which questions can be asked is how it
    # stops meaning one thing.
    #
    # `start_date` is the day the run begins, as YYYY-MM-DD; None is "as soon
    # as the import is allowed to place one", which is the only answer a run
    # with no date can give. The hours are the window a day's posts are spread
    # between, first and last, on the clock of the machine running this.
    start_date: Optional[str] = None
    day_start_hour: Optional[int] = None
    day_end_hour: Optional[int] = None
    # What each post says, and what goes in the comment under it. Empty means
    # "use the application's", the same way the description template does.
    text_template: str = ""
    comment_template: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Any) -> 'PostizSettings':
        if not isinstance(data, dict):
            return cls()
        channels = data.get("channels")
        if isinstance(channels, list):
            # Coerced on the way in: these are ids that end up in a request
            # body, and a number among them is a channel Postiz cannot match.
            channels = [str(entry) for entry in channels if entry]
        else:
            channels = None

        post_type = data.get("post_type")
        if post_type not in ("draft", "schedule", "now"):
            post_type = None

        per_channel: Dict[str, Dict[str, str]] = {}
        raw = data.get("channel_settings")
        if isinstance(raw, dict):
            for channel_id, values in raw.items():
                if isinstance(values, dict):
                    per_channel[str(channel_id)] = {
                        str(k): str(v) for k, v in values.items() if v not in (None, "")
                    }

        per_day = data.get("per_day")
        if isinstance(per_day, bool) or not isinstance(per_day, int) or per_day < 0:
            per_day = None

        return cls(
            channels=channels,
            post_type=post_type,
            channel_settings=per_channel,
            per_day=per_day,
            start_date=_as_start_date(data.get("start_date")),
            day_start_hour=_as_hour(data.get("day_start_hour")),
            day_end_hour=_as_hour(data.get("day_end_hour")),
            text_template=str(data.get("text_template") or ""),
            comment_template=str(data.get("comment_template") or ""),
        )


# What an upload makes on YouTube. The first three are what the video is the
# moment it lands. "schedule" is not a fourth privacy — YouTube has no such
# state — it is private plus a publish time, which YouTube itself turns public
# when the hour comes; it is offered as a fourth choice because that is how the
# user thinks about it, and the uploader takes it apart again.
UPLOAD_PRIVACY_CHOICES = ("private", "unlisted", "public", "schedule")


@dataclass
class UploadSettings:
    """How this project's clips go up on YouTube, when it differs from the app's.

    Shaped like `PostizSettings`, and for the same reason: one install cuts a
    company's podcast and somebody's side project, and the two do not go public
    on the same terms. Every field is None while the project has no opinion,
    which is what keeps the default live — change it in Settings later and a
    project that never chose follows it.

    The four schedule fields mean nothing unless `privacy` is "schedule", and
    they are kept anyway: a user who switches to private for a week and back
    should not have to type their calendar out again.
    """
    privacy: Optional[str] = None
    # How many of this project's clips are published per day. 0 means all of
    # them at the same moment, which is a legitimate schedule — everything at
    # nine on Friday — and not the same as having no opinion.
    per_day: Optional[int] = None
    # The day the schedule begins, as YYYY-MM-DD. None is "as soon as the
    # upload is done", which is the only answer a run with no date can give.
    start_date: Optional[str] = None
    # The hours of the day the clips are spread between, first and last, read
    # in the timezone of the machine running this.
    day_start_hour: Optional[int] = None
    day_end_hour: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Any) -> 'UploadSettings':
        if not isinstance(data, dict):
            return cls()

        privacy = data.get("privacy")
        if privacy not in UPLOAD_PRIVACY_CHOICES:
            privacy = None

        per_day = data.get("per_day")
        if isinstance(per_day, bool) or not isinstance(per_day, int) or per_day < 0:
            per_day = None

        return cls(
            privacy=privacy,
            per_day=per_day,
            start_date=_as_start_date(data.get("start_date")),
            day_start_hour=_as_hour(data.get("day_start_hour")),
            day_end_hour=_as_hour(data.get("day_end_hour")),
        )


# What a clip shows while it is sitting still: its thumbnail, or the video
# frame it is parked on. A project chooses once for all of its clips, because
# the choice is about how the project is reviewed rather than about one clip.
CLIP_PREVIEW_CHOICES = ("thumbnail", "video")

# How a widescreen source fills a taller frame: one window cropped around the
# subject, the whole frame in the middle with darkened copies of it stacked
# above and below, or the source cut into a left and a right part stacked one
# above the other — two people side by side become two people one on top.
LAYOUT_CHOICES = ("crop", "stacked", "split")
DEFAULT_STACK_DARKNESS = 50
DEFAULT_SPLIT_POSITION = 50
# Past these the narrower part is a sliver, cropped to almost nothing in height.
SPLIT_POSITION_RANGE = (20, 80)


def _as_clamped_int(value: Any, low: int, high: int, fallback: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    return max(low, min(int(value), high))


def as_stack_darkness(value: Any, fallback: int = DEFAULT_STACK_DARKNESS) -> int:
    """A darkness percentage clamped to 0-100, or `fallback` for anything else."""
    return _as_clamped_int(value, 0, 100, fallback)


def as_split_position(value: Any, fallback: int = DEFAULT_SPLIT_POSITION) -> int:
    """Where the source is cut, as a percentage of its width from the left,
    clamped to SPLIT_POSITION_RANGE, or `fallback` for anything else."""
    return _as_clamped_int(value, *SPLIT_POSITION_RANGE, fallback)


@dataclass
class ProjectSettings:
    aspect_ratio: str
    resolution: str
    captions: CaptionSettings = field(default_factory=CaptionSettings)
    # How a title is drawn across this project — font, size, placement,
    # colours, timing — and nothing about what it says. The words belong to the
    # clip: they are the one thing about a title that cannot be the same on
    # every short, whether the user typed them or the model wrote them. `text`
    # is carried only because this is an `OverlayText` and is held empty.
    #
    # Default-constructed rather than optional, so a project always has a look
    # to draw with; switched off, so a project nobody has touched burns nothing
    # into its clips.
    overlay: OverlayText = field(default_factory=OverlayText)
    description: DescriptionSettings = field(default_factory=DescriptionSettings)
    # What this project asks the highlights prompt for: how many segments, how
    # long they may run, and anything else it counts as a highlight. Empty
    # means "follow Settings" — see HighlightSettings.
    highlights: HighlightSettings = field(default_factory=HighlightSettings)
    # Where this project's clips are imported, when it differs from the
    # application's. Default-constructed and empty, which means "follow the
    # application settings" — see PostizSettings.
    postiz: PostizSettings = field(default_factory=PostizSettings)
    # How this project's clips go up on YouTube — private, unlisted, public or
    # scheduled — when that differs from the application's answer. Empty means
    # "follow Settings", the way the Postiz block does.
    upload: UploadSettings = field(default_factory=UploadSettings)
    # Thumbnail by default: a grid of stills is what the shorts will look like
    # in a feed, which is the question being asked while reviewing them. The
    # video frame is one click away either way.
    clip_preview: str = "thumbnail"
    # Crop by default, which is what every project rendered before stacking
    # existed. Stacking only changes a render whose frame is taller than the
    # source; anything else is cropped whatever this says.
    layout: str = "crop"
    # How dark the stacked bands are drawn, as a percentage: 0 leaves them at
    # full brightness, 100 is black.
    stack_darkness: int = DEFAULT_STACK_DARKNESS
    # The split layout: where the source is cut (percent of its width from the
    # left), whether the right part goes on top instead of the left, and
    # whether a line is drawn along the seam.
    split_position: int = DEFAULT_SPLIT_POSITION
    split_swap: bool = False
    split_divider: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'ProjectSettings':
        """Builds settings from stored metadata, ignoring keys it does not own.

        Projects created before a settings field existed simply do not carry it,
        so every field other than the two originals has a default.
        """
        preview = data.get("clip_preview")
        return cls(
            aspect_ratio=data.get("aspect_ratio", "keep original"),
            resolution=data.get("resolution", "keep original"),
            captions=CaptionSettings.from_dict(data.get("captions")),
            # Text stripped on the way in as well as on the way out: a project
            # saved before this was configuration-only carries a line that
            # would otherwise reappear over every clip at once.
            overlay=OverlayText.from_dict({**(data.get("overlay") or {}), "text": ""}),
            description=DescriptionSettings.from_dict(data.get("description")),
            highlights=HighlightSettings.from_dict(data.get("highlights")),
            postiz=PostizSettings.from_dict(data.get("postiz")),
            upload=UploadSettings.from_dict(data.get("upload")),
            # Anything else — a typo, a value from a later version — reads as
            # the default rather than reaching the page as a state it cannot
            # draw.
            clip_preview=preview if preview in CLIP_PREVIEW_CHOICES else "thumbnail",
            layout=data.get("layout") if data.get("layout") in LAYOUT_CHOICES else "crop",
            stack_darkness=as_stack_darkness(data.get("stack_darkness")),
            split_position=as_split_position(data.get("split_position")),
            split_swap=data.get("split_swap") is True,
            split_divider=data.get("split_divider") is True,
        )

@dataclass
class Clip:
    filename: str
    original_start: float
    original_end: float
    processed_start: float
    processed_end: float
    text: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def __getitem__(self, key):
        return getattr(self, key)


@dataclass
class Project:
    project_id: str = None
    name: str = None
    created_at: datetime = field(default_factory=datetime.now)
    files: ProjectFileSettings = field(default_factory=ProjectFileSettings)
    highlights: List[Highlight] = field(default_factory=list)
    video_metadata: VideoMetadata = field(default_factory=lambda: VideoMetadata([], []))
    # Output of config-driven LLM tasks that have no typed field of their own,
    # keyed by task name.
    llm_outputs: Dict[str, Any] = field(default_factory=dict)
    settings: ProjectSettings = field(default_factory=lambda: ProjectSettings("16:9", "1080p"))
    status: Optional[str] = None
    step_statuses: Dict[str, str] = field(default_factory=dict)
    # Why each failed step failed, by step name, for the steps that say. A
    # status of "error" is a colour and nothing else: the reason lived only in
    # the backend log, and a step that stops because no API key was configured
    # is a step the user could have fixed in ten seconds had anyone told them.
    # Kept beside the statuses rather than in the transient step notes, because
    # those are dropped the moment the step stops — which is exactly when the
    # reason starts mattering.
    step_errors: Dict[str, str] = field(default_factory=dict)
    base_path: Path = field(default=Path("projects"))
    base_directory: str = "projects"
    clip_base_directory: str = "clips"
    _word_map: Optional[WordMap] = field(default=None, init=False, repr=False)

    def get_artifact_path(self, key: str) -> Path:
        base = self.base_path / (self.project_id or "")
        return base / getattr(self.files, key)

    @property
    def word_map(self) -> WordMap:
        if self._word_map is None:
            self._word_map = WordMap()
            self._word_map.load(self)
        return self._word_map

    def __post_init__(self):
        if self.project_id:
            self.load(self.project_id)
        else:
            import uuid
            from backend.src.utils import generate_random_name
            self.project_id = str(uuid.uuid4())
            self.name = generate_random_name()
            self.save()  # Persist the new project immediately


    def load(self, project_id: str):
        project_path = Path(self.base_directory) / project_id / "metadata.json"
        with open(project_path, 'r') as f:
            metadata = json.load(f)
        self.from_dict(metadata)

        #load static paths

    def get_clip_path(self, clip: str) -> str:
        return self.base_directory + "/" + self.project_id + "/" + self.clip_base_directory + "/" + clip

    def get_artifact_path(self, field: str) -> Path:
        """Returns the full Path for a file artifact defined in files."""
        filename = getattr(self.files, field)
        return Path(self.base_directory) / self.project_id / filename

    def metadata_path(self) -> Path:
        return Path(self.base_directory) / self.project_id / "metadata.json"

    def _write_metadata(self, data: Dict[str, Any]):
        path = self.metadata_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        # Written to a temporary file and swapped in, so a concurrent reader
        # never sees a half-written metadata.json.
        tmp = path.with_name(f"{path.name}.tmp")
        with open(tmp, 'w') as f:
            json.dump(data, f, indent=4)
        os.replace(tmp, path)

    def _read_metadata(self) -> Dict[str, Any]:
        path = self.metadata_path()
        if not path.exists():
            return self.to_dict()
        with open(path, 'r') as f:
            return json.load(f)

    def _mutate_metadata(self, mutate: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
        """Applies a change to metadata.json without rewriting the whole file.

        Pipeline steps run concurrently, each holding the Project snapshot it
        loaded when it started. A full save from one step would roll back
        everything the others wrote after that snapshot was taken, which is how
        a completed step could reappear as running and its output vanish.
        """
        with _metadata_lock(self.project_id):
            data = self._read_metadata()
            mutate(data)
            self._write_metadata(data)
            return data

    def save(self):
        """Writes this snapshot in full. Only safe when nothing else is running."""
        with _metadata_lock(self.project_id):
            self._write_metadata(self.to_dict())

    def to_dict(self) -> Dict[str, Any]:
        return {
            "project_id": self.project_id,
            "name": self.name,
            "created_at": self.created_at.isoformat(),
            "files": self.files.to_dict(),
            "highlights": [h.to_dict() for h in self.highlights],
            "video_metadata": self.video_metadata.to_dict(),
            "llm_outputs": self.llm_outputs,
            "settings": self.settings.to_dict(),
            "status": self.status,
            "step_statuses": self.step_statuses,
            "step_errors": self.step_errors,
        }

    def from_dict(self, metadata: Dict[str, Any]):
        self.project_id = metadata["project_id"]
        self.name = metadata["name"]
        self.created_at = datetime.fromisoformat(metadata["created_at"])
        self.files = ProjectFileSettings(**metadata["files"])
        self.highlights = [Highlight.from_json(h) for h in metadata["highlights"]]

        comp = [VideoComponent(**c) for c in metadata["video_metadata"]["components"]]
        self.video_metadata = VideoMetadata(comp, metadata["video_metadata"]["top_recommendations"])

        self.llm_outputs = metadata.get("llm_outputs", {})

        self.settings = ProjectSettings.from_dict(metadata.get("settings") or {})
        
        self.status = metadata.get("status")
        self.step_statuses = metadata.get("step_statuses", {})
        self.step_errors = metadata.get("step_errors", {})

    def set_step_status(self, step: str, status: str):
        def mutate(data: Dict[str, Any]):
            statuses = data.get("step_statuses") or {}
            statuses[step] = status
            data["step_statuses"] = statuses
            # A step that is starting again, or that has just succeeded, is no
            # longer described by why it failed last time. Cleared here rather
            # than at each call site so no step can leave a stale reason behind
            # a green badge. "partial" keeps its reason for the same reason
            # "error" does: the badge says some of it did not happen, and the
            # sentence is the only thing that says which part and why.
            if status not in ("error", "partial"):
                errors = data.get("step_errors") or {}
                errors.pop(step, None)
                data["step_errors"] = errors

        # Only this step's entry is touched; the statuses of steps running in
        # parallel are read back from disk rather than from a stale snapshot.
        metadata = self._mutate_metadata(mutate)
        self.step_statuses = metadata["step_statuses"]
        self.step_errors = metadata.get("step_errors", {})

    def fail_step(self, step: str, message: str):
        """Marks a step failed and says why, in a sentence the user can act on.

        Both at once because they are one fact: a red badge with no reason is
        what sends someone to the backend log, and the log is not where a
        missing API key should have to be discovered.
        """
        self._mark_step(step, "error", message)

    def partial_step(self, step: str, message: str):
        """Marks a step as having done some of its work but not all of it.

        A step that cuts, publishes or files one thing per clip can finish with
        eighteen of twenty done, and neither "completed" nor "error" is true of
        that. Reported as itself so the badge stops claiming a job is finished
        when a clip is still missing from it, and so pressing the step again is
        an obvious thing to do — the run that follows picks up only what is
        left.
        """
        self._mark_step(step, "partial", message)

    def _mark_step(self, step: str, status: str, message: str):
        def mutate(data: Dict[str, Any]):
            statuses = data.get("step_statuses") or {}
            statuses[step] = status
            data["step_statuses"] = statuses
            errors = data.get("step_errors") or {}
            errors[step] = message
            data["step_errors"] = errors

        metadata = self._mutate_metadata(mutate)
        self.step_statuses = metadata["step_statuses"]
        self.step_errors = metadata["step_errors"]

    def set_property(self, key: str, value: Any):
        setattr(self, key, value)
        serialized = self.to_dict()
        payload = serialized[key] if key in serialized else value
        self._mutate_metadata(lambda data: data.__setitem__(key, payload))

    def set_llm_output(self, task: str, value: Any):
        """Stores the output of an LLM task that has no typed field of its own."""
        def mutate(data: Dict[str, Any]):
            outputs = data.get("llm_outputs") or {}
            outputs[task] = value
            data["llm_outputs"] = outputs

        self.llm_outputs = self._mutate_metadata(mutate)["llm_outputs"]

    def clear_llm_output(self, task: str):
        def mutate(data: Dict[str, Any]):
            outputs = data.get("llm_outputs") or {}
            outputs.pop(task, None)
            data["llm_outputs"] = outputs

        self.llm_outputs = self._mutate_metadata(mutate)["llm_outputs"]

    def trim_highlight(self, index: int, start: float, end: float) -> Dict[str, Any]:
        """Moves one highlight's start and end, in seconds into the source video.

        The whole window is written rather than a delta, because that is what the
        editor holds: the user nudges an edge a second at a time and the numbers
        on screen are the ones that must end up stored.

        Nothing is re-cut here. The clip file, if there is one, still holds the
        old window until the user asks for a render — which is exactly why
        `trimmed_at` is stamped: it is what tells the grid the file has fallen
        behind the numbers beside it.

        Everything timed from the start of the clip moves with it. The caption
        cues are rebuilt from the word map on every read, so they follow by
        themselves; the thumbnail's chosen frame is stored, so it is pulled back
        inside the new window here rather than silently pointing past the end.

        Only the near edge is bounded: `start` cannot go negative, and the window
        cannot close below `CLIP_MIN_DURATION`. The far edge is not, because
        nothing here knows how long the source is — ffmpeg cuts to the end of the
        file, and the browser, which does know, clamps before it ever asks.

        Raises IndexError when there is no highlight at `index`, and ValueError
        for a window that is not two usable numbers.
        """
        try:
            new_start = max(0.0, float(start))
            new_end = float(end)
        except (TypeError, ValueError):
            raise ValueError("start and end must be numbers")
        if not (math.isfinite(new_start) and math.isfinite(new_end)):
            raise ValueError("start and end must be numbers")
        if new_end - new_start < CLIP_MIN_DURATION:
            raise ValueError(
                f"A clip has to be at least {CLIP_MIN_DURATION} seconds long."
            )

        stamp = datetime.now().isoformat()
        trimmed: Dict[str, Any] = {}

        def mutate(data: Dict[str, Any]):
            highlights = data.get("highlights", [])
            if index < 0 or index >= len(highlights):
                raise IndexError(f"No highlight at index {index}")
            entry = highlights[index]
            entry["start"] = new_start
            entry["end"] = new_end
            entry["trimmed_at"] = stamp
            thumbnail = entry.get("thumbnail")
            if isinstance(thumbnail, dict):
                thumbnail["frame_time"] = _bounded(
                    thumbnail.get("frame_time", 0.0), 0.0, new_end - new_start, 0.0
                )
            trimmed.update(entry)
            data["highlights"] = highlights

        self._mutate_metadata(mutate)

        # The in-memory copy is what the caller answers the request from, so it
        # is moved to match rather than left on the window that was replaced.
        if 0 <= index < len(self.highlights):
            highlight = self.highlights[index]
            highlight.start = new_start
            highlight.end = new_end
            highlight.trimmed_at = stamp
            if highlight.thumbnail is not None:
                highlight.thumbnail.frame_time = _bounded(
                    highlight.thumbnail.frame_time, 0.0, new_end - new_start, 0.0
                )
        return trimmed

    def delete_highlight(self, index: int):
        """Removes the highlight at `index` along with any clip cut from it.

        `index` is a position in `highlights`, which is exactly what the clip
        grid renders: every highlight is a card from the moment the highlights
        step finishes, whether or not a clip has been rendered for it yet.

        The highlight is dropped outright rather than just losing its clip, so
        it also stops appearing in the marker and chapter exports.

        Raises IndexError when no highlight exists at that position.
        """
        removed: Dict[str, Any] = {}

        def mutate(data: Dict[str, Any]):
            highlights = data.get("highlights", [])
            if index < 0 or index >= len(highlights):
                raise IndexError(f"No highlight at index {index}")
            removed["filename"] = highlights[index].get("generated_clip_filename")
            thumbnail = highlights[index].get("thumbnail")
            if isinstance(thumbnail, dict):
                removed["thumbnail"] = thumbnail.get("generated_filename")
            del highlights[index]
            data["highlights"] = highlights

        self._mutate_metadata(mutate)

        # metadata.json is what the grid renders, so the file is unlinked only
        # after the entry is gone: a failed unlink must not leave behind a clip
        # the UI still lists but cannot play. `missing_ok` covers the file
        # already being gone, which is not a reason to fail the request.
        filename = removed.get("filename")
        if filename:
            Path(self.get_clip_path(filename)).unlink(missing_ok=True)

        # The still goes with the clip it stood for, by the same rule: the
        # entry is gone from metadata.json first, so a failed unlink cannot
        # leave a picture the UI still lists. The directory is named here
        # rather than imported from Thumbnailer, which imports this module.
        thumbnail = removed.get("thumbnail")
        if thumbnail:
            (Path(self.base_directory) / self.project_id / "thumbnails" / thumbnail).unlink(missing_ok=True)

        if index < len(self.highlights):
            del self.highlights[index]
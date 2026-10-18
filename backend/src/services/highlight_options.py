"""What the highlights prompt is asked for: how many segments, and how long.

Three layers, the same way the upload and Postiz schedules resolve: what the
project decided, then what the application decides, then what the app ships
with. A project that never chose keeps following Settings, so changing the
default there moves every project that has no opinion of its own.

The resolved numbers reach the prompt as `{min_clips}`, `{max_clips}`,
`{min_duration}`, `{max_duration}` and `{highlight_guidance}` — see
`backend/src/services/llm_query.py`.
"""

import logging
from dataclasses import dataclass
from typing import Any, Optional, Set, Tuple

from backend.src.dataclasses.data import (
    HIGHLIGHT_MAX_CLIPS,
    HIGHLIGHT_MAX_DURATION,
    HighlightSettings,
    Project,
)
from backend.src.settings_manager import settings_manager

logger = logging.getLogger(__name__)

# What a project asks for when nobody has said otherwise: the numbers the
# prompt carried in its own text before any of this was configurable.
DEFAULT_MIN_CLIPS = 7
DEFAULT_MAX_CLIPS = 12
DEFAULT_MIN_DURATION = 18.0
DEFAULT_MAX_DURATION = 110.0

# Where the application-wide answer is stored, shaped like the project's.
SETTINGS_KEY = "highlight_defaults"


@dataclass
class HighlightOptions:
    """The numbers a prompt is rendered with, after every layer has spoken."""
    min_clips: int
    max_clips: int
    min_duration: float
    max_duration: float
    guidance: str = ""


def _app_defaults() -> HighlightSettings:
    """The application's answer, coerced by the same rules as a project's."""
    return HighlightSettings.from_dict(settings_manager.get(SETTINGS_KEY) or {})


def _project_settings(project: Optional[Project]) -> Optional[HighlightSettings]:
    settings = getattr(project, "settings", None)
    own = getattr(settings, "highlights", None)
    return own if isinstance(own, HighlightSettings) else None


# How specific an answer was, lowest first. Carried alongside the value so a
# range built out of two different layers can be reconciled — see `_ordered`.
PROJECT_LAYER, APPLICATION_LAYER, SHIPPED_LAYER = 0, 1, 2


def _layered(own: Optional[HighlightSettings], app: HighlightSettings,
             attribute: str, default: Any) -> Tuple[Any, int]:
    """One number and where it came from: the project, the application, the default."""
    value = getattr(own, attribute, None) if own is not None else None
    if value is not None:
        return value, PROJECT_LAYER
    value = getattr(app, attribute, None)
    if value is not None:
        return value, APPLICATION_LAYER
    return default, SHIPPED_LAYER


def _ordered(low: Tuple[Any, int], high: Tuple[Any, int]) -> Tuple[Any, Any]:
    """The two ends of a range, put in an order something can satisfy.

    A minimum above its maximum is a range no segment fits, and the prompt
    would then reject everything it found — so it is never sent as typed. Which
    end gives way depends on where each came from, because the two ends of one
    range are not always answered by the same person: a project asking for
    clips of at least 90 seconds against an application maximum of 60 means the
    project's 90, not a silent swap back into the default it overrode. When
    both ends come from the same place the user typed a range backwards, and
    swapping is what they meant.

    Silent either way: the panel shows what is stored, and correcting it there
    is the user's to do.
    """
    (low_value, low_layer), (high_value, high_layer) = low, high
    if low_value <= high_value:
        return low_value, high_value
    if low_layer < high_layer:
        return low_value, low_value
    if high_layer < low_layer:
        return high_value, high_value
    return high_value, low_value


def resolve(project: Optional[Project] = None) -> HighlightOptions:
    """What this project's highlights run should ask for."""
    app = _app_defaults()
    own = _project_settings(project)

    min_clips, max_clips = _ordered(
        _layered(own, app, "min_clips", DEFAULT_MIN_CLIPS),
        _layered(own, app, "max_clips", DEFAULT_MAX_CLIPS),
    )
    min_duration, max_duration = _ordered(
        _layered(own, app, "min_duration", DEFAULT_MIN_DURATION),
        _layered(own, app, "max_duration", DEFAULT_MAX_DURATION),
    )
    min_clips, max_clips = int(min_clips), int(max_clips)
    min_duration, max_duration = float(min_duration), float(max_duration)

    # Empty is "no opinion" here rather than "say nothing", so a project that
    # never typed anything still follows the application's line. A project's
    # own words then win outright rather than being appended to it: two sets of
    # instructions in one prompt is how a model is told to do two things.
    guidance = (getattr(own, "guidance", "") or "").strip() or (app.guidance or "").strip()

    return HighlightOptions(
        min_clips=max(1, min(min_clips, HIGHLIGHT_MAX_CLIPS)),
        max_clips=max(1, min(max_clips, HIGHLIGHT_MAX_CLIPS)),
        min_duration=max(1.0, min(min_duration, HIGHLIGHT_MAX_DURATION)),
        max_duration=max(1.0, min(max_duration, HIGHLIGHT_MAX_DURATION)),
        guidance=guidance,
    )


# The application's cutoff, which a project follows until it moves its own.
JEV_MIN_SCORE_KEY = "jev_min_score"


def jev_min_score(project: Optional[Project] = None) -> float:
    """The Jev score a clip needs to count as one of this project's clips."""
    own = _project_settings(project)
    value = getattr(own, "jev_min_score", None) if own is not None else None
    if value is None:
        value = settings_manager.get(JEV_MIN_SCORE_KEY)
    try:
        return min(1.0, max(0.0, float(value or 0.0)))
    except (TypeError, ValueError):
        return 0.0


def jev_display_score(scores: dict) -> Optional[float]:
    """The score a card shows and the cutoff is compared against.

    The score relative to the video (its best moment 1, its weakest 0), or the
    raw score for a clip scored before relative scores existed.
    """
    relative = scores.get("relative")
    return relative if isinstance(relative, (int, float)) else scores.get("score")


def selected_indices(project: Project) -> Set[int]:
    """Which highlights are this project's clips, by position.

    A Jev run keeps every moment it scored, so the list holds the clips the
    user wants and the moments below the cutoff together. The ones scoring at
    or above the cutoff are the clips, and only those: the cutoff is the whole
    rule, so a clip under it never appears among them. Steps that work through
    every clip (cutting, publishing) skip the others; each one can
    still be cut or published on its own from its card.

    A highlight without a Jev score — every Gemini highlight — is always a clip.
    The frontend mirrors this in `frontend/src/utils/jevSelection.ts`.
    """
    scored = {
        index: jev_display_score(h.jev_scores)
        for index, h in enumerate(project.highlights)
        if isinstance(getattr(h, "jev_scores", None), dict)
        and isinstance(jev_display_score(h.jev_scores), (int, float))
    }
    unscored = {i for i in range(len(project.highlights)) if i not in scored}
    if not scored:
        return unscored
    # Compared as the 0–100 whole numbers the page shows, so a clip labelled
    # 50 is never on the wrong side of a cutoff of 50.
    cutoff = round(jev_min_score(project) * 100)
    return {i for i, score in scored.items() if round(score * 100) >= cutoff} | unscored


def format_seconds(value: float) -> str:
    """Seconds as they read in a sentence: `20`, not `20.0`."""
    return str(int(value)) if float(value).is_integer() else f"{value:g}"

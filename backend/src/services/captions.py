"""One place that answers "what captions does this clip have, and how do they look".

The preview in the browser and the burned render must not disagree, so both go
through here: the same cues, from the same word map, under the same resolved
style. The only difference downstream is the renderer — CSS in the page, libass
in ffmpeg.
"""

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

from backend.src.infrastructure.font_metrics import face_for_style
from backend.src.services.ass_writer import render_ass
from backend.src.services.caption_builder import CaptionCue, build_project_cues
from backend.src.services.caption_styles import get_presets, resolve_style

logger = logging.getLogger(__name__)


class CaptionService:
    """Builds caption cues, styles and ASS files for a project's clips."""

    def presets(self) -> Dict[str, Dict[str, Any]]:
        return get_presets()

    def settings(self, project, highlight=None) -> Any:
        """The caption settings that govern one clip, or the project's own.

        A highlight carrying its own `captions` is unlocked and speaks for
        itself. One carrying None is locked and defers, which is why the
        project's later changes keep reaching it.
        """
        own = getattr(highlight, "captions", None) if highlight is not None else None
        if own is not None:
            return own
        return getattr(project.settings, "captions", None)

    def is_enabled(self, project, highlight=None) -> bool:
        settings = self.settings(project, highlight)
        return bool(settings and settings.enabled)

    def style(self, project, highlight=None) -> Dict[str, Any]:
        """The resolved caption style for a clip, defaults included."""
        settings = self.settings(project, highlight)
        if settings is None:
            return resolve_style()
        return resolve_style(settings.preset, settings.overrides)

    def cues(self, project, highlight, style: Optional[Dict[str, Any]] = None) -> List[CaptionCue]:
        """Cues for one highlight, timed from the start of its clip."""
        # words_per_cue can differ per clip, so the clip's own style decides
        # how its words are grouped.
        style = style or self.style(project, highlight)
        return build_project_cues(
            project, highlight.start, highlight.end, words_per_cue=style["words_per_cue"]
        )

    def font(self, style: Dict[str, Any]) -> Dict[str, Any]:
        """The face the burn will use, described so the page can use it too.

        `url` points back at this API rather than at a path on disk: the browser
        loads the very file libass will draw with, which is the only way the two
        agree when the backend runs somewhere the browser cannot see — a
        container with different fonts installed, most of the time.
        """
        face = face_for_style(style)
        query = urlencode({
            "family": style["font_family"],
            "bold": int(bool(style["bold"])),
            "italic": int(bool(style["italic"])),
        })
        return {
            "family": face.family,
            # CSS `line-height` for the overlay: libass spaces lines by exactly
            # the ascent-to-descent height it sized the font against.
            "height_ratio": face.height_ratio,
            "url": f"/caption_font?{query}" if face.path else None,
        }

    def overlay_locked(self, highlight) -> bool:
        """Whether this clip follows the project's title rather than its own."""
        return getattr(highlight, "overlay", None) is None

    def overlay_settings(self, project, highlight=None) -> Optional[Any]:
        """The title that governs one clip: its own, or the project's look.

        The same lock the caption settings keep, for the same reason: the look
        of a title is a project decision — one font, one placement, one pair of
        colours across every short — while the words on any one clip are not.
        A highlight carrying its own `overlay` has unlocked and speaks for
        itself; one carrying None defers to the project's configuration, which
        holds no text, so it draws nothing over the video until a line is
        written for it.
        """
        own = getattr(highlight, "overlay", None) if highlight is not None else None
        if own is not None:
            return own
        return getattr(project.settings, "overlay", None) if project is not None else None

    def overlay(self, project, highlight=None) -> Optional[Any]:
        """The title drawn over this clip, or None when it would draw nothing.

        Kept here rather than in the clipper because this is the object that
        already answers "what gets drawn over this clip" for both renderers.
        """
        overlay = self.overlay_settings(project, highlight)
        return overlay if overlay is not None and overlay.is_visible() else None

    def preview(self, project, highlight) -> Dict[str, Any]:
        """The payload the browser preview overlay renders from."""
        style = self.style(project, highlight)
        cues = self.cues(project, highlight, style)
        # Resolved, not stored: a clip that has never been given a title of its
        # own still reports the project's configuration, so the editor opens on
        # the look it would inherit rather than on an empty form. The face is
        # resolved the same way the caption face is, so the preview draws with
        # the file libass will.
        resolved_overlay = self.overlay_settings(project, highlight)
        overlay_font = self.font({
            "font_family": resolved_overlay.font_family,
            "bold": resolved_overlay.bold,
            "italic": resolved_overlay.italic,
        }) if resolved_overlay is not None else None
        return {
            "overlay": resolved_overlay.to_dict() if resolved_overlay is not None else None,
            "overlay_font": overlay_font,
            # Whether the title above is this clip's own or the project's, so
            # the editor can show the lock without a second request.
            "overlay_locked": self.overlay_locked(highlight),
            "enabled": self.is_enabled(project, highlight),
            "style": style,
            "font": self.font(style),
            "duration": max(0.0, highlight.end - highlight.start),
            "cues": [cue.to_dict() for cue in cues],
            # Whether this clip speaks for itself, so the card can show the
            # lock without a second request.
            "locked": getattr(highlight, "captions", None) is None,
            "settings": (
                highlight.captions.to_dict()
                if getattr(highlight, "captions", None) is not None
                else None
            ),
        }

    def write_ass(self, project, highlight, path: Path, width: int, height: int) -> Optional[Path]:
        """Writes the ASS file for one clip, or nothing if there is nothing to draw.

        Captions and the overlay title are independent: a clip can have either,
        both, or neither, and a clip with captions switched off but a title still
        needs a subtitle file. Cues are only included when captions are actually
        on, so turning them off does not leave the words in the burn.

        Returned even when the burn is later skipped: the file is useful on its
        own in an editor, and it is what makes a failed burn recoverable without
        re-running the whole step.
        """
        style = self.style(project, highlight)
        cues = self.cues(project, highlight, style) if self.is_enabled(project, highlight) else []
        overlay = self.overlay(project, highlight)
        if not cues and overlay is None:
            return None
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(render_ass(cues, style, width, height, overlay), encoding="utf-8")
        logger.info(f"Wrote {len(cues)} caption cues and {int(overlay is not None)} overlay to {path}")
        return path

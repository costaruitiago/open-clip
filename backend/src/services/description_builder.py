"""Builds the YouTube description of one clip from a user-owned template.

A description is not a single piece of text anyone owns end to end. Part of it
is written per clip by the model, part of it is the same on every project the
user ever publishes, part of it belongs to this project alone, and part of it —
the link back to the full episode — is a fact only the project knows.

So the description is a template. It is plain text the user writes, and a
`{placeholder}` in it is replaced by one of the values listed in `FIELD_HELP`.
Anything that is not a placeholder is emitted exactly as typed: writing
`{highlights.ai_video_description}` yields the model's description for that
clip, and writing `this is a text` yields `this is a text`.

Two rules keep a half-filled template readable:

- A line that contains placeholders and nothing but empty ones is dropped, so a
  project with no source URL does not publish "Watch the full episode:" over an
  empty space.
- Runs of blank lines left behind by those drops collapse to one.
"""

import logging
import re
from typing import Any, Dict, List, Optional

from backend.src.dataclasses.data import Highlight, Project

logger = logging.getLogger(__name__)


# The description shipped with the app, and what a project falls back to when
# neither it nor the application settings define one. The source line is a
# separate line from the URL on purpose: each disappears on its own when the
# project has not filled that field in.
DEFAULT_TEMPLATE = """{highlights.ai_video_description}

This is a short from the original podcast {project.source_title}.
Watch the full episode: {project.source_url}

{global.text}

{project.text}"""


# Shown in the settings UI next to the template box. Ordered as a person would
# read it: what the model wrote, then what the project knows, then the standing
# text.
FIELD_HELP: List[Dict[str, str]] = [
    {"field": "highlights.ai_video_description", "description": "The description the model wrote for this clip"},
    {"field": "highlights.video_title_for_youtube_short", "description": "The clip's YouTube title"},
    {"field": "highlights.viral_hook_text", "description": "The clip's on-screen hook"},
    {"field": "highlights.highlight_text", "description": "The clip's transcript"},
    {"field": "highlights.video_description_for_x", "description": "The clip's X post"},
    {"field": "highlights.video_description_for_reddit", "description": "The clip's Reddit post"},
    {"field": "highlights.video_description_for_linkedin", "description": "The clip's LinkedIn post"},
    {"field": "project.source_title", "description": "Name of the original video or podcast episode"},
    {"field": "project.source_url", "description": "Link to the original video, as a link in the description"},
    {"field": "project.text", "description": "This project's own standing text"},
    {"field": "project.name", "description": "The project name"},
    {"field": "global.text", "description": "The text added to every description in every project"},
]


# `{{`/`}}` escape a literal brace. A placeholder is a dotted identifier in
# single braces and nothing else, so JSON or code pasted into a template is left
# alone rather than read as fields.
_FIELD_PATTERN = re.compile(r"\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}")

_BLANK_RUN = re.compile(r"\n{3,}")

# The model writes this one; `ai_video_description` is the shorter name the
# template offers for it.
_DESCRIPTION_FIELD = "video_description_for_youtube_short"

# Highlight fields a template may read. The rest of the highlight is machinery
# (timestamps, filenames, caption settings) with no place in a description.
_HIGHLIGHT_FIELDS = (
    _DESCRIPTION_FIELD,
    "video_title_for_youtube_short",
    "viral_hook_text",
    "highlight_text",
    "video_description_for_x",
    "video_description_for_reddit",
    "video_description_for_linkedin",
)


def _global_defaults(settings: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The application-wide description settings, whatever shape they are in."""
    if isinstance(settings, dict):
        return settings
    # Imported here rather than at module scope: the settings manager reads a
    # file on import, and the renderer is used by tests that supply their own.
    from backend.src.settings_manager import settings_manager

    defaults = settings_manager.get("description_defaults")
    return defaults if isinstance(defaults, dict) else {}


def resolve_template(project: Project, global_defaults: Optional[Dict[str, Any]] = None) -> str:
    """The template this project renders with: its own, the global one, or the default."""
    defaults = _global_defaults(global_defaults)
    project_template = (project.settings.description.template or "").strip()
    if project_template:
        return project_template
    global_template = str(defaults.get("template") or "").strip()
    return global_template or DEFAULT_TEMPLATE


def build_fields(
    project: Project,
    highlight: Highlight,
    global_defaults: Optional[Dict[str, Any]] = None,
) -> Dict[str, str]:
    """Every placeholder a template may use, already resolved to a string."""
    defaults = _global_defaults(global_defaults)
    description = project.settings.description

    fields: Dict[str, str] = {
        "project.name": project.name or "",
        "project.source_title": description.source_title,
        "project.source_url": description.source_url,
        "project.text": description.text,
        "global.text": str(defaults.get("text") or ""),
    }

    for name in _HIGHLIGHT_FIELDS:
        value = str(getattr(highlight, name, "") or "")
        # `highlight.` reads better in prose, `highlights.` matches the key the
        # metadata file uses. Both work so neither is a mistake to type.
        fields[f"highlight.{name}"] = value
        fields[f"highlights.{name}"] = value

    ai_description = fields[f"highlight.{_DESCRIPTION_FIELD}"]
    fields["highlight.ai_video_description"] = ai_description
    fields["highlights.ai_video_description"] = ai_description

    return fields


def render_template(template: str, fields: Dict[str, str]) -> str:
    """Fills `template` with `fields`, dropping lines whose fields are all empty."""
    kept: List[str] = []
    for line in template.splitlines():
        placeholders: List[str] = []

        def substitute(match: "re.Match") -> str:
            token = match.group(0)
            if token == "{{":
                return "{"
            if token == "}}":
                return "}"
            name = match.group(1)
            if name not in fields:
                # Left in the output rather than blanked: an unknown field is a
                # typo, and a description that silently loses a paragraph is
                # harder to notice than one that shows `{project.sorce_url}`.
                logger.warning(f"Description template uses unknown field '{{{name}}}'")
                return token
            value = fields[name]
            placeholders.append(value)
            return value

        rendered = _FIELD_PATTERN.sub(substitute, line)
        if placeholders and not any(value.strip() for value in placeholders):
            # The line existed to carry fields that turned out to be empty.
            continue
        kept.append(rendered.rstrip())

    return _BLANK_RUN.sub("\n\n", "\n".join(kept)).strip()


def build_description(
    project: Project,
    highlight: Highlight,
    global_defaults: Optional[Dict[str, Any]] = None,
) -> str:
    """The finished YouTube description for one clip."""
    template = resolve_template(project, global_defaults)
    return render_template(template, build_fields(project, highlight, global_defaults))

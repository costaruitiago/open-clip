"""Imports finished clips into Postiz as posts that are ready to send.

The uploader publishes to YouTube: one channel, irreversibly, from this app.
This does the other half of the job — every other platform — by handing the
clip to the scheduler the user already runs. A clip imported here arrives in
Postiz as a draft against each connected channel, with the video attached and
the text already written, so the remaining work is reading it and pressing
send.

Drafts rather than immediate posts by default, and that default matters: an
import is meant to be safe to run over a whole project. `postiz_post_type` in
settings can make it `schedule` (at a time this computes) or `now` for a user
who wants the pipeline to end at published, but nothing here reaches an
audience unless that was asked for explicitly.

What each channel says comes from the highlight. The model already writes a
post per platform — X, LinkedIn, Reddit — so a channel gets its own text where
there is one, and the clip's YouTube description, rendered through the user's
template, where there is not.
"""

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

from pathlib import Path

from backend.src.dataclasses.data import Highlight, Project
from backend.src.infrastructure.postiz_client import (
    PostizClient,
    PostizError,
    PostizRejectedPostsError,
)
from backend.src.infrastructure.progress import report
from backend.src.services import highlight_options
from backend.src.services.clipper import Clipper
from backend.src.services.description_builder import (
    build_description,
    build_fields,
    render_template,
)
from backend.src.services.schedule import day_window, slot_time
from backend.src.services.uploader import ClipFileMissingError, ClipNotRenderedError

logger = logging.getLogger(__name__)


# Postiz's own name for each platform, as it appears on an integration's
# `identifier`, mapped to the field on the highlight written for it. Anything
# not named here falls back to the rendered description, which is the longest
# and most complete text a clip has.
PLATFORM_TEXT_FIELDS = {
    "x": "video_description_for_x",
    "twitter": "video_description_for_x",
    "reddit": "video_description_for_reddit",
    "linkedin": "video_description_for_linkedin",
    "linkedin-page": "video_description_for_linkedin",
}

# What each platform requires in its `settings` block beyond naming itself.
# Postiz validates per channel and refuses the whole request when one is wrong,
# so a value it will accept has to be sent rather than left out.
#
# Only what can be answered for the user is here. `who_can_reply_post` has an
# obvious answer for a clip going out publicly; a Discord channel id does not,
# which is what `PLATFORM_REQUIRED_FIELDS` is for.
PLATFORM_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "x": {"who_can_reply_post": "everyone"},
    # A vertical clip is a reel, not a feed post; Instagram refuses video any
    # other way.
    "instagram": {"post_type": "reel"},
    "instagram-standalone": {"post_type": "reel"},
}

# How far either side of now a sync looks for this project's posts. Back far
# enough to catch one published before anybody asked, forward far enough to
# cover a project dripped out at one clip a day for half a year.
SYNC_LOOKBACK_DAYS = 90
SYNC_LOOKAHEAD_DAYS = 400

# The hours a day's posts are spread between, first and last. Nine to nine:
# dividing a day evenly instead would put the second of two posts at 3am.
DEFAULT_DAY_START_HOUR = 9
DEFAULT_DAY_END_HOUR = 21

# Where a scheduled import lands, in minutes from now. Far enough ahead that a
# post scheduled by a project-wide import is still cancellable when the user
# gets to the calendar, and near enough to be today's.
DEFAULT_SCHEDULE_OFFSET_MINUTES = 60


def _fingerprint(path: Path) -> str:
    """Which video this is, by its contents.

    Contents rather than size and modification time, because the commonest way
    to import a clip re-cuts it first: pressing Import twice with nothing
    changed in between produces a second file, at a second moment, holding the
    same video. Keyed on the timestamp that is a fresh upload of forty
    megabytes Postiz already has; keyed on the bytes it is not.

    Reading the file costs a fraction of the encode that has just written it,
    and far less than sending it over a home connection.
    """
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return f"{path.stat().st_size}:{digest.hexdigest()}"


def _as_postiz_date(when: datetime) -> str:
    """A moment in the shape Postiz reads: UTC, milliseconds, trailing Z.

    Converted rather than assumed. The schedule is built on the machine's own
    clock — "nine to nine" is nine where the user is, which is what the same
    words mean on the YouTube side — and the wire format is UTC.
    """
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _as_entries(created: Any) -> List[Dict[str, Any]]:
    """Whatever a create answered, as a list of entries.

    The client already normalises this; it is done again here because the client
    is injectable, and one Postiz answering with a bare object rather than a
    list of one must not reach the rest of this file as a string being asked for
    its keys.
    """
    entries = created if isinstance(created, list) else [created]
    return [entry for entry in entries if isinstance(entry, dict)]


def _first_of(entries: List[Dict[str, Any]], *keys: str) -> Optional[str]:
    """The first of `keys` any entry carries, as a string.

    Written over the whole answer rather than over its first entry, because
    which entry holds a given field is Postiz's business: the group in
    particular is the same for all of them and need not be on the first.
    """
    for entry in entries:
        for key in keys:
            value = entry.get(key)
            if value:
                return str(value)
    return None


def _summarize(posts: List[Dict[str, Any]]) -> Optional[str]:
    """One word for what became of a post that went to several channels.

    Ordered by what the user needs to know first: something that failed to send
    is the only state anyone has to act on, then something that is out, then
    something still waiting. A post whose channels disagree is described by its
    most urgent one rather than by an average.
    """
    states = {str(post.get("state") or "").upper() for post in posts}
    if "ERROR" in states:
        return "error"
    if "PUBLISHED" in states:
        return "published"
    if "QUEUE" in states:
        return "scheduled"
    return None


def channel_platform(channel: Dict[str, Any]) -> str:
    """Which platform a channel posts to, as Postiz names it."""
    return str(channel.get("identifier") or channel.get("providerIdentifier") or "")


def channel_name(channel: Dict[str, Any]) -> str:
    """What to call a channel in a sentence the user reads."""
    return str(channel.get("name") or channel_platform(channel) or channel.get("id") or "?")


class NoPostizChannelsError(Exception):
    """There is nowhere to import this clip to.

    Either the Postiz account has no channels connected, or every channel named
    in settings has since been removed from it. Its own type because the fix is
    in Postiz rather than here, and the message has to say so.
    """


class PostizImportInProgressError(Exception):
    """This clip is already being imported by another request."""


class PostizPublisher:
    """Renders a clip and files it in Postiz.

    Shaped like `Uploader` on purpose — same lifecycle hooks, same per-clip
    error recording, same "cut it again first" rule — because the orchestrator
    drives both the same way and a clip has to mean the same thing whichever
    one sends it.
    """

    def __init__(
        self,
        clipper: Optional[Clipper] = None,
        client_factory: Optional[Callable[[], PostizClient]] = None,
        settings_reader: Optional[Callable[[str, Any], Any]] = None,
        now: Optional[Callable[[], datetime]] = None,
    ):
        # Held for the reason the uploader holds one: importing a clip means
        # producing the file first, not finding one somebody else left behind.
        self.clipper = clipper or Clipper()
        self.client_factory = client_factory or PostizClient
        self._settings_reader = settings_reader
        # Local rather than UTC, and injectable, for the reasons the uploader's
        # clock is both: the user picks hours on their own clock, Postiz is told
        # the same instant in UTC, and a schedule is a function of "now" that a
        # test which cannot say when now is can only assert vaguely about.
        self._now = now or (lambda: datetime.now().astimezone())

    def _setting(self, key: str, default: Any = None) -> Any:
        """One application-wide setting, which is the default for every project."""
        if self._settings_reader is not None:
            return self._settings_reader(key, default)
        from backend.src.settings_manager import settings_manager

        value = settings_manager.get(key, default)
        return default if value is None else value

    @staticmethod
    def _project_postiz(project: Optional[Project]):
        """This project's own Postiz settings, or the empty ones.

        Defensive about the attribute rather than the value: a project written
        before these settings existed still loads, and `ProjectSettings` fills
        them in, but a test double standing in for a project need not.
        """
        settings = getattr(project, "settings", None)
        return getattr(settings, "postiz", None)

    def chosen_channels(self, project: Optional[Project] = None) -> List[str]:
        """Which channel ids this project imports to.

        The project first, the application settings second. A project that has
        never chosen carries None, which is what makes the default live: change
        it in Settings and every project that never disagreed follows.

        An empty list on the project is a choice, not an absence — it means
        this project imports nowhere — so it is returned as it stands rather
        than falling through to the global one.
        """
        own = self._project_postiz(project)
        if own is not None and own.channels is not None:
            return [str(entry) for entry in own.channels if entry]
        chosen = self._setting("postiz_channels", []) or []
        if not isinstance(chosen, list):
            return []
        return [str(entry) for entry in chosen if entry]

    # --- Pipeline lifecycle -------------------------------------------------

    def reset_metadata(self, project: Project) -> None:
        """Clears import artifacts and updates project state."""
        project.set_property("postiz_posts", [])
        project.set_step_status("postiz", "pending")

    def start_service(self, project: Project, full: bool = True) -> None:
        """Puts the step into "running", and on a full run forgets the last one.

        A resume must keep `postiz_posts`: the drafts it names are still in
        Postiz, and the run about to happen only adds the clips missing from
        them.
        """
        if full:
            self.reset_metadata(project)
        project.set_step_status("postiz", "running")

    def end_service(self, project: Project) -> None:
        project.set_step_status("postiz", "completed")

    # --- Per-clip bookkeeping ----------------------------------------------

    def clip_path(self, project: Project, highlight: Highlight) -> Path:
        return (
            Path(project.base_directory)
            / project.project_id
            / "clips"
            / highlight.generated_clip_filename
        )

    def open_client(self) -> PostizClient:
        """Opens the handle an import will go through.

        Called before anything is cut, so a missing or rejected API key is
        reported as itself and at once, rather than after minutes of encoding
        spent on an import that was never going to happen.
        """
        return self.client_factory()

    def begin_attempt(self, project: Project, index: int) -> None:
        """Clears the last failure, because this attempt is about to replace it."""
        self._set_error(project, index, None)

    def record_failure(self, project: Project, index: int, message: str) -> None:
        """Stores why this attempt filed nothing.

        The import runs in the background, so the response to the click is a job
        key rather than an outcome. This is where the outcome goes.
        """
        logger.warning(
            f"Postiz import of clip {index} in {project.project_id} failed: {message}"
        )
        self._set_error(project, index, message)

    def _set_error(self, project: Project, index: int, message: Optional[str]) -> None:
        highlights = project.highlights
        if index >= len(highlights):
            return
        if highlights[index].postiz_error == message:
            return
        highlights[index].postiz_error = message
        project.set_property("highlights", highlights)

    def _record_import(self, project: Project, index: int, result: Dict[str, Any]) -> None:
        """Writes the created post back onto the highlight it came from.

        Stored so the clip page can say a clip is already in Postiz and link to
        it. Importing twice is not destructive — it makes a second draft — but a
        button that looks untouched is how a calendar fills with duplicates.
        """
        highlights = project.highlights
        if index >= len(highlights):
            return
        highlights[index].postiz_post_id = result.get("post_id")
        highlights[index].postiz_group = result.get("group")
        highlights[index].postiz_url = result.get("url")
        highlights[index].postiz_imported_at = datetime.now().isoformat()
        highlights[index].postiz_channels = result.get("channels") or []
        # A post that has only just been filed has not been anywhere yet, and
        # last time's answer describes a post that no longer exists.
        highlights[index].postiz_state = None
        highlights[index].postiz_synced_at = None
        # Whatever the previous attempt failed with is no longer true of this
        # clip, and a filed post sitting next to an error message reads as one.
        highlights[index].postiz_error = None
        project.set_property("highlights", highlights)

    # --- Building the post --------------------------------------------------

    def resolve_channels(
        self, client: PostizClient, project: Optional[Project] = None
    ) -> List[Dict[str, Any]]:
        """The channels this import goes to: the ones the user picked, and no others.

        `postiz_channels` in settings is that choice, by integration id. An
        empty choice means nothing gets imported, and that is deliberate — an
        earlier version read it as "all of them", which sent ten clips to six
        accounts nobody had ticked, across two companies and a personal
        LinkedIn. Posting somewhere is the user's decision to make and cannot
        be inferred from an account merely being connected to Postiz.

        The choice is checked against what Postiz currently has, so a channel
        disconnected since it was ticked is dropped rather than making the
        whole post fail.
        """
        available = client.list_integrations()
        wanted = set(self.chosen_channels(project))

        if not wanted:
            raise NoPostizChannelsError(
                "No Postiz channels are selected, so there is nowhere to import to. "
                "Tick them for this project, or in Settings for every project."
            )

        channels = [entry for entry in available if str(entry.get("id")) in wanted]
        missing = wanted - {str(entry.get("id")) for entry in channels}
        if missing:
            logger.warning(
                f"{len(missing)} Postiz channel(s) chosen in settings are no longer "
                "on the account and were skipped"
            )

        # A disabled channel is one Postiz will not send from. Kept if it was
        # ticked — the user asked for it, and a draft they can see is better
        # than a channel silently missing — but never chosen for them.
        if not channels:
            raise NoPostizChannelsError(
                "None of the selected Postiz channels are on the account any more. "
                "Choose them again in Settings."
            )
        return channels

    def platform_text(self, highlight: Highlight, platform: str) -> str:
        """What the model wrote for this platform, if it wrote anything."""
        field = PLATFORM_TEXT_FIELDS.get((platform or "").lower())
        if not field:
            return ""
        return str(getattr(highlight, field, "") or "").strip()

    def template_fields(
        self, project: Project, highlight: Highlight, platform: str
    ) -> Dict[str, str]:
        """Everything a Postiz template may reference.

        The description template's fields, so one vocabulary covers both, plus
        two that only mean something here: `platform.post` is what the model
        wrote for the platform this post is going to, which is how one template
        can carry the right words to every channel, and `platform.name` is the
        platform itself.
        """
        fields = build_fields(project, highlight)
        fields["platform.name"] = platform or ""
        fields["platform.post"] = self.platform_text(highlight, platform) or fields.get(
            "highlight.ai_video_description", ""
        )
        return fields

    def text_template(self, project: Optional[Project] = None) -> str:
        """The template each post is written from: the project's, or the app's.

        Empty means there is no template at all, and the post falls back to what
        the model wrote — which is what every import did before templates
        existed, and is a perfectly good answer.
        """
        own = self._project_postiz(project)
        if own is not None and (own.text_template or "").strip():
            return own.text_template.strip()
        return str(self._setting("postiz_text_template", "") or "").strip()

    def comment_template(self, project: Optional[Project] = None) -> str:
        """What goes in the comment under the post, if anything."""
        own = self._project_postiz(project)
        if own is not None and (own.comment_template or "").strip():
            return own.comment_template.strip()
        return str(self._setting("postiz_comment_template", "") or "").strip()

    def build_text(self, project: Project, highlight: Highlight, platform: str) -> str:
        """What this clip says on one platform.

        A template, when the user has written one: the same renderer the YouTube
        description uses, so `{platform.post}` and `{project.source_url}` mean
        the same thing in both and a line whose fields are all empty disappears
        rather than leaving a dangling label.

        Without a template, what the model wrote for this platform — it writes a
        post per platform for exactly this — and failing that the clip's full
        description, which is the one piece of writing about a clip that is
        always there.
        """
        template = self.text_template(project)
        if template:
            rendered = render_template(
                template, self.template_fields(project, highlight, platform)
            ).strip()
            if rendered:
                return rendered

        own = self.platform_text(highlight, platform)
        if own:
            return own
        description = build_description(project, highlight).strip()
        if description:
            return description
        # Every text a clip could carry is empty — a highlight from before the
        # metadata step ran. The hook is what the clip itself says on screen.
        return str(highlight.viral_hook_text or "").strip()

    def build_comment(self, project: Project, highlight: Highlight, platform: str) -> str:
        """The comment posted under this one, or empty for none.

        The usual reason to want one is the link: platforms bury a post that
        carries an outbound URL, so the video goes in the post and the link to
        the full episode goes underneath it. Postiz models that as the second
        entry of a post's `value` — a thread on X, a first comment on LinkedIn —
        so this becomes exactly that where the platform has one.
        """
        template = self.comment_template(project)
        if not template:
            return ""
        return render_template(
            template, self.template_fields(project, highlight, platform)
        ).strip()

    def channel_settings(
        self, channel: Dict[str, Any], project: Optional[Project] = None
    ) -> Dict[str, Any]:
        """The `settings` block one channel travels with.

        Postiz validates this per platform and refuses the whole request when
        one channel's block is wrong, so what goes in it matters to every other
        channel in the same post.

        Four layers, and deliberately thin ones. The platform names itself,
        because Postiz needs to know which validator to run. `PLATFORM_DEFAULTS`
        answers the handful of questions that have an obvious answer for a
        public clip. Everything else — a Discord channel id, a subreddit, a
        Pinterest board — is the user's, from `postiz_channel_settings` in
        settings and then from this project's own, each keyed by the channel's
        id, so one project can post to a different Discord channel than the
        rest without restating the account.

        No table of Postiz's required fields is kept here. Which fields a
        platform demands is Postiz's business and changes with Postiz; a copy of
        it in this repository would be wrong within a release. When something is
        missing, Postiz says so, and that message is what reaches the user.
        """
        platform = channel_platform(channel)
        settings: Dict[str, Any] = {"__type": platform} if platform else {}
        settings.update(PLATFORM_DEFAULTS.get(platform, {}))

        channel_id = str(channel.get("id"))
        overrides = self._setting("postiz_channel_settings", {}) or {}
        if isinstance(overrides, dict):
            per_channel = overrides.get(channel_id)
            if isinstance(per_channel, dict):
                # Over the defaults, so a user who disagrees with one can say so.
                settings.update({k: v for k, v in per_channel.items() if v not in (None, "")})

        own = self._project_postiz(project)
        if own is not None:
            # Over the application's, and merged rather than replacing it: a
            # project that posts to a different Discord channel should not have
            # to restate everything else about that account.
            settings.update({
                k: v for k, v in (own.channel_settings.get(channel_id) or {}).items()
                if v not in (None, "")
            })
        return settings

    def build_payload(
        self,
        project: Project,
        highlight: Highlight,
        channels: List[Dict[str, Any]],
        media: Dict[str, Any],
        index: int = 0,
    ) -> Dict[str, Any]:
        """The body Postiz creates the post from.

        One request covers every channel: Postiz groups them into a single post
        on the calendar, which is what a clip is — one thing, going to several
        places — and it costs one call against the rate limit instead of five.
        """
        post_type = str(self.post_type(project) or "draft").lower()
        if post_type not in ("draft", "schedule", "now"):
            logger.warning(f"Unknown postiz_post_type {post_type!r}; filing a draft")
            post_type = "draft"

        posts = []
        for channel in channels:
            platform = channel_platform(channel)
            value = [{
                "content": self.build_text(project, highlight, platform),
                # The rendered mp4, by the id Postiz stored it under. Postiz
                # calls the media array `image` whatever is in it.
                "image": [{"id": media.get("id"), "path": media.get("path")}],
            }]
            comment = self.build_comment(project, highlight, platform)
            if comment:
                # The second entry of `value` is the post under the post: a
                # thread on X, a first comment on LinkedIn. No media on it —
                # the video belongs to the post, not to its comment.
                value.append({"content": comment, "image": []})
            posts.append({
                "integration": {"id": channel.get("id")},
                "value": value,
                "settings": self.channel_settings(channel, project),
            })

        return {
            "type": post_type,
            "date": self._post_date(project, index),
            "shortLink": False,
            "tags": [],
            "posts": posts,
        }

    def post_type(self, project: Optional[Project] = None) -> str:
        """Draft, scheduled or sent — this project's answer, or the app's."""
        own = self._project_postiz(project)
        if own is not None and own.post_type:
            return str(own.post_type)
        return str(self._setting("postiz_post_type", "draft") or "draft")

    def _schedule_number(self, project: Optional[Project], attribute: str, key: str,
                         default: int) -> int:
        """One number of the schedule: the project's, the application's, or the default.

        The same resolution the uploader makes, field for field. A project that
        has not answered carries None — not a copy of the application's answer —
        which is what keeps the default live.
        """
        own = self._project_postiz(project)
        value = getattr(own, attribute, None) if own is not None else None
        if value is None:
            value = self._setting(key, default)
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    def per_day(self, project: Optional[Project] = None) -> int:
        """How many of a project's clips land per day. 0 is all of them at once.

        The project's answer, or the application's. Zero is what an import did
        before there was a choice — ten clips at the same minute, which is a
        calendar nobody can read and a feed nobody wants.
        """
        return max(0, self._schedule_number(project, "per_day", "postiz_per_day", 0))

    def _day_window(self, project: Optional[Project] = None) -> Tuple[int, int]:
        """The hours of the day posts are spread between, as (first, last).

        Nine to nine by default: the slots this produces are when a person
        would post, rather than the small hours that dividing a day evenly
        would land on.
        """
        return day_window(
            self._schedule_number(
                project, "day_start_hour", "postiz_day_start_hour", DEFAULT_DAY_START_HOUR
            ),
            self._schedule_number(
                project, "day_end_hour", "postiz_day_end_hour", DEFAULT_DAY_END_HOUR
            ),
        )

    def _start_date(self, project: Optional[Project] = None) -> Optional[date]:
        """The day this project's imports begin, if a day was named."""
        own = self._project_postiz(project)
        value = getattr(own, "start_date", None) if own is not None else None
        if not value:
            value = self._setting("postiz_schedule_start_date", "")
        try:
            return date.fromisoformat(str(value)) if value else None
        except ValueError:
            # A date nobody can parse is not a date. Falling back to "as soon
            # as the import can place one" beats refusing to import over it.
            logger.warning(f"Ignoring an unreadable Postiz schedule start date: {value!r}")
            return None

    def _schedule_start(self, project: Optional[Project] = None) -> datetime:
        """The earliest moment this project's posts may be placed at.

        The named day at the first hour of the window, or now plus the offset
        if no day was named — and never earlier than that offset, because a
        post filed behind the user's own calendar is one they cannot cancel,
        and a date chosen last week is behind it.
        """
        try:
            offset = int(self._setting("postiz_schedule_offset_minutes", DEFAULT_SCHEDULE_OFFSET_MINUTES))
        except (TypeError, ValueError):
            offset = DEFAULT_SCHEDULE_OFFSET_MINUTES

        now = self._now()
        earliest = now + timedelta(minutes=max(0, offset))
        start_date = self._start_date(project)
        if start_date is None:
            return earliest
        first_hour, _ = self._day_window(project)
        named = now.replace(
            year=start_date.year, month=start_date.month, day=start_date.day,
            hour=first_hour, minute=0, second=0, microsecond=0,
        )
        return max(named, earliest)

    def _post_date(self, project: Optional[Project] = None, index: int = 0) -> str:
        """When this clip's post says it is for, as Postiz wants it.

        Sent for a draft too: Postiz requires the field, and it is where the
        draft sits on the calendar the user is about to look at — which is the
        whole point of spacing them.

        Keyed on the clip's own position rather than on the order things
        happened in, so the same clip lands on the same slot whichever way it
        was imported: the whole-project step, the clipper handing clips over as
        it cuts them, or one button on one card. Re-importing a clip moves it
        nowhere.
        """
        first_hour, last_hour = self._day_window(project)
        # The same arithmetic, the same questions and the same clock the YouTube
        # upload schedules by, so a project spread "two a day between nine and
        # nine from Monday" lands on one calendar rather than on two that
        # disagree about what it was asked.
        return _as_postiz_date(
            slot_time(
                self._schedule_start(project), index, self.per_day(project), first_hour, last_hour
            )
        )

    # --- What became of what was filed --------------------------------------

    def sync(
        self, project: Project, client: Optional[PostizClient] = None
    ) -> Dict[str, Any]:
        """Asks Postiz what became of this project's posts, and records it.

        Nothing tells this application when a draft it filed is sent, so without
        this a clip that went out on LinkedIn an hour ago still reads as
        "waiting in Postiz" forever. One request covers the whole project:
        Postiz answers with every post in a window, and the clips are matched
        against it by the post ids they carry.

        Matching is by id, and only by id. `group` looked like the thing that
        ties a clip's channels together — it is not. Postiz gives every channel
        its own group: one clip filed to two accounts came back as two posts, at
        the same minute, with two different groups. Matching on it found one
        channel and reported the other as still waiting when it had been
        published an hour earlier.

        For a clip filed before every channel's id was kept, the ids alone are
        not enough either, so a post is also claimed when it is on a channel
        this clip was filed to and shares its exact publish time with a post
        already matched. Postiz stamps the channels of one import with the same
        minute, and two imports never share one.

        What can be learned is exact — `PUBLISHED` and the platform's own URL,
        `QUEUE` for something still due, `ERROR` for a send that failed.

        A post missing from that answer is not necessarily gone, because drafts
        are never in it, so each one is asked about directly. That question has
        three outcomes and they are kept apart: the post is really there and is
        a draft, in which case the clip goes on saying it is waiting; the post
        is not there, in which case the clip stops claiming it — an id that
        resolves to nothing is worse than no id, because it reads as filed and
        the only thing that would actually file it is a re-import; or Postiz
        could not be asked, in which case nothing is touched.
        """
        indices = [
            index for index, highlight in enumerate(project.highlights)
            if self._known_post_ids(highlight)
        ]
        if not indices:
            return {"checked": False, "reason": "No clip of this project is in Postiz.", "clips": {}}

        client = client or self.client_factory()
        # Wide enough to cover a project dripped out over months, and anchored
        # before the earliest import so a post that was published early is
        # still in it.
        start = datetime.now(timezone.utc) - timedelta(days=SYNC_LOOKBACK_DAYS)
        end = datetime.now(timezone.utc) + timedelta(days=SYNC_LOOKAHEAD_DAYS)
        posts = client.list_posts(start, end)

        by_id = {str(post.get("id")): post for post in posts if post.get("id")}

        highlights = project.highlights
        seen: Dict[int, Dict[str, Any]] = {}
        stamp = datetime.now().isoformat()

        for index in indices:
            highlight = highlights[index]
            # Every id this clip was given when it was filed — one per channel,
            # not just the first. A clip whose X post is still a draft and whose
            # LinkedIn post is out is found by the second.
            matched = [
                by_id[post_id] for post_id in self._known_post_ids(highlight)
                if post_id in by_id
            ]
            matched += self._siblings_of(matched, highlight, posts)

            # Before the matching decides anything, and for every clip: records
            # filed by an earlier version carry a per-post link, `/p/{id}`, and
            # that page answers 200 while showing nothing — it is a link to
            # nowhere on every clip that has one, matched or not.
            highlight.postiz_url = client.post_url(highlight.postiz_post_id)

            if not matched:
                # Missing from the window is not an answer by itself — drafts
                # are never in it — so the post is asked about directly. A post
                # Postiz does not have is one this clip must stop claiming: the
                # record was pointing at nothing, and the clip read as filed
                # when re-importing it was the only thing that would file it.
                exists = self._still_there(highlight, client)
                if exists is False:
                    self._forget_post(highlight)
                    seen[index] = {"state": None, "known": True, "gone": True}
                    continue
                # True means a real draft; None means Postiz could not be asked,
                # and neither is grounds for touching the record.
                seen[index] = {"state": highlight.postiz_state, "known": False}
                continue

            highlight.postiz_channels = self._merge_channel_states(
                highlight.postiz_channels, matched
            )
            highlight.postiz_state = _summarize(matched)
            highlight.postiz_synced_at = stamp
            seen[index] = {"state": highlight.postiz_state, "known": True}

        project.set_property("highlights", highlights)
        logger.info(
            f"Postiz sync for {project.project_id}: {len(seen)} clip(s) checked, "
            f"{sum(1 for entry in seen.values() if entry['known'])} answered for"
        )
        return {"checked": True, "clips": seen, "synced_at": stamp}

    @staticmethod
    def _still_there(highlight: Highlight, client: PostizClient) -> Optional[bool]:
        """Whether any of this clip's posts is still in Postiz.

        Any, not all: a clip filed to two channels and deleted from one is
        still in Postiz. Only when every id it knows about comes back empty is
        the clip actually gone.

        None the moment one id cannot be asked about, because "some of them are
        missing and one is unknown" is not enough to throw a record away.
        """
        answers = [client.post_exists(post_id) for post_id in PostizPublisher._known_post_ids(highlight)]
        if not answers or None in answers:
            return None
        return True if any(answers) else False

    @staticmethod
    def _forget_post(highlight: Highlight) -> None:
        """Forgets a post Postiz does not have, so the clip reads as unfiled.

        Everything about where it went goes with it: an id that resolves to
        nothing, a link to an empty page, a list of channels it is not on. What
        stays is the uploaded video — Postiz still holds that, and a re-import
        should not send forty megabytes again to replace something that is
        already there.
        """
        highlight.postiz_post_id = None
        highlight.postiz_group = None
        highlight.postiz_url = None
        highlight.postiz_imported_at = None
        highlight.postiz_channels = []
        highlight.postiz_state = None
        highlight.postiz_synced_at = None

    @staticmethod
    def _siblings_of(
        matched: List[Dict[str, Any]],
        highlight: Highlight,
        posts: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """This clip's other channels, for a record that never kept their ids.

        A clip filed before every channel's id was stored knows one of them.
        Its siblings cannot be found by group — Postiz gives each channel its
        own — so they are recognised by the two things that are certainly true
        of them: they are on a channel this clip was filed to, and they carry
        the same publish time as the post already matched, because Postiz stamps
        one import's channels with one minute.

        Deliberately exact on the timestamp rather than a window. A minute is
        specific enough that two separate imports never collide, and anything
        looser would start claiming other people's posts.
        """
        if not matched:
            return []

        stamps = {post.get("publishDate") for post in matched if post.get("publishDate")}
        taken = {str(post.get("id")) for post in matched}
        wanted = {
            str(channel.get("id")) for channel in highlight.postiz_channels
            if isinstance(channel, dict) and channel.get("id")
        }
        if not stamps or not wanted:
            return []

        siblings = []
        for post in posts:
            if str(post.get("id")) in taken:
                continue
            if post.get("publishDate") not in stamps:
                continue
            integration = post.get("integration")
            if not isinstance(integration, dict):
                continue
            if str(integration.get("id")) in wanted:
                siblings.append(post)
        return siblings

    @staticmethod
    def _known_post_ids(highlight: Highlight) -> List[str]:
        """Every Postiz post id this clip carries, in the order worth trying.

        The per-channel ids come from the creation itself and are the most
        precise thing there is; the single `postiz_post_id` is the older
        record's one id, kept for clips filed before the rest were stored.
        """
        ids = [
            str(entry["post_id"]) for entry in highlight.postiz_channels
            if isinstance(entry, dict) and entry.get("post_id")
        ]
        if highlight.postiz_post_id and str(highlight.postiz_post_id) not in ids:
            ids.append(str(highlight.postiz_post_id))
        return ids

    def _merge_channel_states(
        self, stored: List[Dict[str, Any]], posts: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Lays what Postiz says over what this app recorded when it filed.

        Matched on the integration id, because that is the one thing both sides
        name the same way. A channel this app filed against and Postiz says
        nothing about keeps what it had — that is the draft case again.
        """
        states = {
            str(post.get("integration", {}).get("id")): post
            for post in posts
            if isinstance(post.get("integration"), dict)
        }
        merged = []
        for channel in stored:
            entry = dict(channel)
            post = states.pop(str(channel.get("id")), None)
            if post is not None:
                entry["state"] = str(post.get("state") or "").lower() or None
                # The post on the platform itself, which is the only link worth
                # following once something is out.
                entry["url"] = post.get("releaseURL") or None
                entry["post_id"] = post.get("id")
            merged.append(entry)

        # A channel Postiz knows about that this app never recorded — the post
        # was edited in Postiz to add one. Worth showing rather than hiding.
        for channel_id, post in states.items():
            integration = post.get("integration", {})
            merged.append({
                "id": channel_id,
                "name": integration.get("name") or channel_id,
                "platform": integration.get("providerIdentifier"),
                "state": str(post.get("state") or "").lower() or None,
                "url": post.get("releaseURL") or None,
                "post_id": post.get("id"),
                "added_in_postiz": True,
            })
        return merged

    # --- The import ---------------------------------------------------------

    def _media_for(
        self, project: Project, index: int, path: Path, client: PostizClient
    ) -> Dict[str, Any]:
        """The clip's video in Postiz's storage, uploaded only if it is not there.

        The video goes up before the post is created, so everything that can go
        wrong after that — a channel missing a required setting, a rate limit,
        a dropped connection — leaves the bytes already uploaded. Sending them
        again on the next attempt costs the user forty megabytes for nothing and
        leaves Postiz holding a copy per attempt.

        So the media is remembered against a fingerprint of the video itself.
        A clip re-cut into a different video gets a different fingerprint and is
        uploaded; a clip re-cut into the same video — which is what pressing
        Import twice does — is not. A stale video can never be posted, because
        the fingerprint is of the bytes rather than of anything this app
        promises about them.
        """
        fingerprint = _fingerprint(path)
        highlight = project.highlights[index]
        if (
            highlight.postiz_media_id
            and highlight.postiz_media_fingerprint
            and highlight.postiz_media_fingerprint == fingerprint
        ):
            logger.info(
                f"Reusing the video already in Postiz for clip {index} "
                f"({highlight.postiz_media_id})"
            )
            report(f"Clip {index + 1}: video is already in Postiz")
            return {"id": highlight.postiz_media_id, "path": highlight.postiz_media_path}

        media = client.upload_file(str(path))
        # Written before the post is attempted, which is the whole point: the
        # attempt is what fails, and the upload it already paid for has to
        # survive that failure.
        self._record_media(project, index, media, fingerprint)
        return media

    def _record_media(
        self, project: Project, index: int, media: Dict[str, Any], fingerprint: str
    ) -> None:
        highlights = project.highlights
        if index >= len(highlights):
            return
        highlights[index].postiz_media_id = media.get("id")
        highlights[index].postiz_media_path = media.get("path")
        highlights[index].postiz_media_fingerprint = fingerprint
        project.set_property("highlights", highlights)

    def _create_post(
        self,
        project: Project,
        highlight: Highlight,
        channels: List[Dict[str, Any]],
        media: Dict[str, Any],
        client: PostizClient,
        index: int = 0,
    ):
        """Creates the post, without letting one bad channel lose the others.

        Every channel travels in one request — one call against a rate limit
        that is 30 an hour on some instances, and one post on the calendar
        rather than six. The cost is that Postiz validates the request as a
        whole: a Discord with no channel id configured, an X missing a reply
        setting, and nothing at all is filed, which is what happened to every
        clip of a ten-clip project.

        So a refusal that names the offending entries is answered by dropping
        exactly those and sending the rest, once. Postiz's own words travel
        back with them — it is the only thing that knows which field it wanted,
        and copying that knowledge into this repository would only rot.

        Returns what Postiz created, the channels it was created for, and the
        ones it refused with the reason.
        """
        payload = self.build_payload(project, highlight, channels, media, index)
        try:
            return _as_entries(client.create_post(payload)), channels, []
        except PostizRejectedPostsError as e:
            refused = [
                {
                    "id": channels[position].get("id"),
                    "name": channel_name(channels[position]),
                    "platform": channel_platform(channels[position]),
                    "reason": str(e),
                }
                for position in sorted(e.positions)
                if position < len(channels)
            ]
            kept = [
                channel for position, channel in enumerate(channels)
                if position not in e.positions
            ]

        names = ", ".join(entry["name"] for entry in refused) or "some channels"
        if not kept:
            # Nothing left to send. The clip is not filed, and the reason is
            # Postiz's, which is the one that says which field was missing.
            raise PostizError(
                f"Postiz would not accept any of the channels for this clip. {names}: {refused[0]['reason'] if refused else ''}"
            )

        logger.warning(
            f"Postiz refused {names} for clip {highlight.generated_clip_filename}; "
            f"filing the remaining {len(kept)} channel(s)"
        )
        report(f"Postiz would not take {names}; filing the other {len(kept)}")
        payload = self.build_payload(project, highlight, kept, media, index)
        # Not retried again: a second refusal is about the channels that were
        # already accepted once, which is a different problem and belongs in
        # front of the user rather than in another round trip.
        return _as_entries(client.create_post(payload)), kept, refused

    def _channels_created(
        self, filed: List[Dict[str, Any]], created: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """The channels this clip was filed to, carrying the post ids Postiz gave.

        Postiz answers a create with one entry per channel, and those ids are
        the certain, free answer to "where did this clip go" — no later request
        needed. An earlier version kept the first entry and discarded the rest,
        so five of six ids were lost the moment they arrived.

        Matched on the integration id where the answer carries one, and by
        position otherwise: the entries come back in the order the channels were
        sent. A channel with no entry keeps what it had rather than being given
        somebody else's id.
        """
        by_integration: Dict[str, Dict[str, Any]] = {}
        for entry in created:
            integration = entry.get("integration")
            key = (
                integration.get("id") if isinstance(integration, dict)
                else entry.get("integrationId") or entry.get("integration")
            )
            if key:
                by_integration[str(key)] = entry

        channels = []
        for position, channel in enumerate(filed):
            entry = by_integration.get(str(channel.get("id")))
            if entry is None and not by_integration and position < len(created):
                entry = created[position]
            record = {
                "id": channel.get("id"),
                "name": channel_name(channel),
                "platform": channel_platform(channel),
            }
            if entry is not None:
                record["post_id"] = _first_of([entry], "id", "postId")
            channels.append(record)
        return channels

    def import_one(
        self,
        project: Project,
        index: int,
        client: Optional[PostizClient] = None,
        channels: Optional[List[Dict[str, Any]]] = None,
        render: bool = True,
    ) -> Dict[str, Any]:
        """Cuts one clip afresh, files it in Postiz, and returns what it made.

        The cut is not conditional on there being no file, for the reason the
        uploader re-cuts: the clip the user approved is the one drawn from the
        settings as they stand now — its captions, its overlay title, the
        project's aspect ratio — and a file cut before the last of those changes
        is a different clip.

        `render` is only false when the caller has just cut the clip itself —
        the clipper handing over a file it wrote a moment ago. Cutting it again
        there would encode the same clip twice for one import.

        Raises IndexError for a position with no highlight, NoPostizChannelsError
        when the account has nowhere to file it, whatever the render raised when
        it could not produce a file, ClipFileMissingError when the file it
        reported writing is not there, and PostizError for anything Postiz
        itself refused.
        """
        if index < 0 or index >= len(project.highlights):
            raise IndexError(f"No highlight at index {index}")

        # Before the render, not after: a key that cannot file a post, or an
        # account with no channels, is worth knowing about now rather than at
        # the end of an encode.
        client = client or self.client_factory()
        # Passed in by a run that has already asked — one listing for a whole
        # project rather than one per clip.
        channels = channels or self.resolve_channels(client, project)

        if render:
            self.clipper.render_one(project, index)
        # Re-read: the render writes the filename and the timestamp onto the
        # highlight, and the copy taken above predates both.
        highlight = project.highlights[index]

        if not highlight.is_clip_generated or not highlight.generated_clip_filename:
            raise ClipNotRenderedError(
                "The render finished without producing a file for this clip. "
                "The backend log has what ffmpeg reported."
            )

        path = self.clip_path(project, highlight)
        if not path.exists():
            raise ClipFileMissingError(
                f"The file this render reported writing is not there ({path})."
            )

        logger.info(
            f"Postiz import sending clip={highlight.generated_clip_filename} to "
            f"{len(channels)} channel(s)"
        )
        media = self._media_for(project, index, path, client)
        created, filed, refused = self._create_post(
            project, highlight, channels, media, client, index
        )

        result = {
            "post_id": _first_of(created, "id", "postId"),
            # What ties this clip's channels together in Postiz. Kept from the
            # creation itself where it is there, because that is the certain
            # answer; the sync only has to work it out for records filed before
            # this was stored.
            "group": _first_of(created, "group"),
            "url": client.post_url(_first_of(created, "id", "postId")),
            "channels": self._channels_created(filed, created),
            # The channels Postiz would not take, and what it said about each.
            # Reported rather than swallowed: a draft that quietly went to four
            # of six accounts is a draft the user thinks went to six.
            "refused": refused,
        }
        logger.info(
            f"Postiz import filed clip={highlight.generated_clip_filename} as "
            f"{[entry.get('id') for entry in result['channels']]}"
        )
        self._record_import(project, index, result)
        return result

    def is_enabled(self) -> bool:
        """Whether a freshly cut clip should be filed without being asked.

        Two things have to be true: Postiz has to be configured at all, and the
        user has to want clips filed as they are cut rather than in one pass at
        the end. Default on, because a configured Postiz is a Postiz somebody
        set up in order to send things to it — and a clip that is ready an hour
        before the drafts appear helped nobody.
        """
        if not str(self._setting("postiz_api_key", "") or "").strip():
            return False
        return self._setting("postiz_import_on_render", True) is not False

    def import_rendered(self, project: Project, index: int) -> Optional[Dict[str, Any]]:
        """Files a clip the clipper has just finished cutting.

        This is what makes the first clip reach Postiz while the twentieth is
        still encoding, instead of every clip waiting for the whole step. The
        file is on disk and current — it was written a second ago — so nothing
        is re-cut.

        Returns None when Postiz is not set up for this, which is not a
        failure: it is the ordinary state of a project whose owner does not use
        it. Failures are recorded on the clip and swallowed, because the clip
        itself is fine and the run that produced it must not be failed by a
        scheduler being down.
        """
        if not self.is_enabled():
            return None

        try:
            client = self.client_factory()
            channels = self.resolve_channels(client, project)
        except Exception as e:
            message = str(e) or e.__class__.__name__
            logger.warning(f"Not filing clip {index} of {project.project_id}: {message}")
            self.record_failure(project, index, message)
            return None

        report(f"Clip {index + 1}: sending to Postiz")
        try:
            result = self.import_one(
                project, index, client=client, channels=channels, render=False
            )
        except Exception as e:
            message = str(e) or e.__class__.__name__
            logger.warning(f"Could not file clip {index} of {project.project_id}: {message}")
            self.record_failure(project, index, message)
            return None
        return result

    def is_current(self, highlight: Highlight) -> bool:
        """Whether this clip's draft is of the file that is on disk now.

        A clip filed and then re-cut has a draft carrying the previous video, so
        it is not current and is worth filing again. A clip filed after its last
        cut is done, and re-filing it only puts a second identical draft on the
        calendar — which is what a run of the step after a run of the clipper
        would otherwise do to every clip in the project.
        """
        if not highlight.postiz_imported_at:
            return False
        if not highlight.rendered_at:
            return True
        return highlight.postiz_imported_at >= highlight.rendered_at

    async def execute(self, project: Project, full: bool = False) -> List[Dict[str, Any]]:  # pragma: no cover
        """Imports every clip in the project, as a pipeline step.

        This is the "automatically import the clips" case: one run, and the
        whole project is sitting in Postiz waiting to be read and sent.

        A clip already filed since its last cut is left alone in either mode:
        filing it again does not replace the draft, it puts a second identical
        one on the calendar, and `full` cannot undo the first. What `full`
        changes is only the project's own record of the last run.

        Everything that can be known before any encoding starts — that there is
        an API key, that it works, that the account has channels — is checked
        first, and a step that fails there fails immediately with the reason
        rather than claiming to run. A step that says "running" for ten minutes
        because nobody has configured Postiz is worse than one that says why in
        the first second.
        """
        logger.info(
            f"PostizPublisher executing for project={project.project_id}, "
            f"highlight_count={len(project.highlights)}"
        )

        # Before `start_service`, which is what puts the step into "running".
        # An exception raised after that point left the step running forever:
        # the orchestrator logs it and unregisters the job, and nothing ever
        # moves the status off "running".
        try:
            client = self.client_factory()
            channels = self.resolve_channels(client, project)
        except Exception as e:
            message = str(e) or e.__class__.__name__
            logger.warning(f"Postiz step refused for {project.project_id}: {message}")
            project.fail_step("postiz", message)
            return []

        self.start_service(project, full=full)

        imported: List[Dict[str, Any]] = []
        failures: List[str] = []
        # Only the project's clips; moments below a Jev cutoff are imported
        # one at a time from their card, never by this step.
        selected = sorted(highlight_options.selected_indices(project))
        total = len(selected)
        # Indexes, not the highlights themselves: each import is written back
        # onto its highlight, which reloads the list from disk.
        skipped = 0
        for number, index in enumerate(selected, 1):
            if self.is_current(project.highlights[index]):
                # Already filed since it was last cut — by the clipper handing
                # it over as it finished, most often. Filing it again would put
                # a second identical draft on the calendar.
                skipped += 1
                continue
            # The one thing the page can say about a step that spends minutes
            # per clip. Without it the whole run looks identical to a hang.
            report(f"Clip {number} of {total}: cutting, then sending to Postiz")
            try:
                imported.append(
                    self.import_one(project, index, client=client, channels=channels)
                )
            except Exception as e:
                # One clip that will not cut or will not file must not abandon
                # the clips after it; the clip carries its own reason, and the
                # step is judged on whether anything got through at all.
                message = str(e) or e.__class__.__name__
                logger.warning(f"Skipping clip {index} for {project.project_id}: {message}")
                self.record_failure(project, index, message)
                failures.append(message)

        # What this run produced, which is all this key has ever meant. The
        # durable record of a filed clip is on the highlight — `postiz_post_id`
        # and the channel states beside it — and that is what a resume reads and
        # what the clip page draws.
        project.set_property("postiz_posts", imported)

        if failures:
            report(f"Imported {len(imported)} of {total} clips; {len(failures)} failed")
        elif skipped:
            report(f"{skipped} clip(s) were already in Postiz and were left alone")
        self._settle(project, failures)
        logger.info(
            f"PostizPublisher finished for project={project.project_id}: "
            f"{len(imported)} imported, {skipped} already current, {len(failures)} failed"
        )
        return imported

    def _settle(self, project: Project, failures: List[str]) -> None:
        """Records how much of the project is actually sitting in Postiz.

        Judged on the highlights rather than on this run's tally, so a resume
        that filed the last two missing clips completes the step, and a run that
        filed nine of ten does not — which was the whole bug: `end_service` used
        to be called unconditionally, so one draft out of twenty read as "done"
        and nothing said the other nineteen were never made.
        """
        selected = highlight_options.selected_indices(project)
        missing = [
            h for i, h in enumerate(project.highlights) if i in selected and not self.is_current(h)
        ]
        if not missing:
            self.end_service(project)
            return
        if len(missing) == len(selected):
            # Nothing is filed. Reporting that as a completed step is how a
            # user ends up looking for drafts that were never made.
            project.fail_step(
                "postiz",
                f"No clip could be imported. The first failure was: {failures[0]}"
                if failures
                else "No clip was imported.",
            )
            logger.warning(f"PostizPublisher imported nothing for {project.project_id}")
            return
        reason = f" The first failure was: {failures[0]}" if failures else ""
        project.partial_step(
            "postiz",
            f"{len(missing)} of {len(selected)} clips are not in Postiz yet."
            f"{reason} Run this step again to import only those.",
        )

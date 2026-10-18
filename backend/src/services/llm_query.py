import json
import logging
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from backend.src.dataclasses.data import Project, Highlights, VideoMetadata
from backend.src.infrastructure.credentials import LocalCredentialProvider
from backend.src.infrastructure.gemini_client import GeminiClient, describe_error
from backend.src.infrastructure.progress import StepStopped, report, stop_requested
from backend.src.infrastructure.schema_validator import validate
from backend.src.infrastructure.typesafe_client import TypeSafeClient
from backend.src.services import highlight_options
from backend.src.services.highlight_options import format_seconds
from backend.src.services.jev_highlighter import JevHighlighter
from backend.src.services.llm_tasks import LLMTask, SchemaNotFoundError, discover_tasks
from backend.src.settings_manager import settings_manager

logger = logging.getLogger(__name__)

# Which model finds the highlights: "gemini" (the HIGHLIGHTS.md prompt) or
# "jev" (see backend/src/services/jev_highlighter.py).
HIGHLIGHT_PROVIDER_KEY = "highlight_provider"
# Kept in a subfolder so discover_tasks, which reads only the top level of
# backend/config/prompts, does not turn it into a pipeline step of its own.
JEV_TEXTS_TEMPLATE = Path("backend/config/prompts/jev/HIGHLIGHT_TEXTS.md")
# Clips cut and titled per round of a Jev run, so titles appear as they come.
JEV_TITLE_BATCH = 10
# What Gemini writes for each Jev clip.
JEV_TEXT_FIELDS = (
    "viral_hook_text",
    "thumbnail_text",
    "video_title_for_youtube_short",
    "video_description_for_youtube_short",
    "video_description_for_x",
    "video_description_for_reddit",
    "video_description_for_linkedin",
)


@dataclass
class ResultAdapter:
    """Routes a validated LLM result into a typed field on the project."""
    apply: Callable[[Project, Any], None]
    reset: Callable[[Project], None]


def _apply_highlights(project: Project, result: Any) -> None:
    items = result
    if isinstance(result, dict):
        # The prompt asks for "shorts"; older prompts and schemas say "highlights".
        items = result.get("shorts", result.get("highlights", result))
    project.set_property("highlights", Highlights(items).highlights)


def _apply_video_metadata(project: Project, result: Any) -> None:
    project.set_property("video_metadata", VideoMetadata.from_llm(result))


RESULT_ADAPTERS: Dict[str, ResultAdapter] = {
    "highlights": ResultAdapter(
        apply=_apply_highlights,
        reset=lambda project: project.set_property("highlights", []),
    ),
    "video_metadata": ResultAdapter(
        apply=_apply_video_metadata,
        reset=lambda project: project.set_property("video_metadata", VideoMetadata([], [])),
    ),
}


def _render_word_map(project: Project) -> str:
    return "\n".join(
        f"{entry.start:.2f}\t{entry.end:.2f}\t{entry.word}" for entry in project.word_map.entries
    )


def _read_transcript(project: Project) -> str:
    path = project.get_artifact_path("transcription_file")
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


# Every placeholder a prompt template is allowed to use. Each one is resolved
# lazily, so a prompt that does not ask for the word map never pays for loading
# it.
CONTEXT_PROVIDERS: Dict[str, Callable[[Project], Any]] = {
    "transcript_text": _read_transcript,
    "word_map": _render_word_map,
    "project_name": lambda project: project.name,
    # The video the clips were cut from. Empty until the user fills it in on
    # the project page, which is why every prompt using them must treat them as
    # optional context rather than something to quote.
    "source_title": lambda project: project.settings.description.source_title,
    "source_url": lambda project: project.settings.description.source_url,
    "highlights": lambda project: json.dumps([h.to_dict() for h in project.highlights], indent=2),
    "video_metadata": lambda project: json.dumps(project.video_metadata.to_dict(), indent=2),
    # What this project asks a highlights run for, after the project, the
    # application and the shipped defaults have each had their say. Resolved
    # per placeholder so a prompt asking only for the clip counts never has to
    # mention the lengths.
    "min_clips": lambda project: highlight_options.resolve(project).min_clips,
    "max_clips": lambda project: highlight_options.resolve(project).max_clips,
    "min_duration": lambda project: format_seconds(
        highlight_options.resolve(project).min_duration
    ),
    "max_duration": lambda project: format_seconds(
        highlight_options.resolve(project).max_duration
    ),
    # Free text the user wrote for this project — what it counts as a
    # highlight. Empty when nobody has written any, which leaves the line it
    # sits on blank rather than putting an empty heading in the prompt.
    "highlight_guidance": lambda project: highlight_options.resolve(project).guidance,
}


# `{{`/`}}` stay supported for prompts written against str.format, but only an
# identifier between single braces is treated as a placeholder. A prompt that
# shows the model the JSON it must return is full of `{` and `"key": value`, and
# none of that should be mistaken for a field to fill.
_FIELD_PATTERN = re.compile(r"\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}")


def template_placeholders(template: str) -> List[str]:
    """The `{name}` fields a template asks for, ignoring braces used as text."""
    names = []
    for match in _FIELD_PATTERN.finditer(template):
        name = match.group(1)
        if name and name not in names:
            names.append(name)
    return names


def build_prompt(template: str, project: Project) -> str:
    """Fills a template with the project context it asks for."""
    context = {}
    for name in template_placeholders(template):
        provider = CONTEXT_PROVIDERS.get(name)
        if provider is None:
            raise ValueError(
                f"Prompt uses unknown placeholder '{{{name}}}'. "
                f"Available placeholders: {', '.join(sorted(CONTEXT_PROVIDERS))}."
            )
        context[name] = provider(project)

    def substitute(match: "re.Match") -> str:
        token = match.group(0)
        if token == "{{":
            return "{"
        if token == "}}":
            return "}"
        return str(context[match.group(1)])

    # Substituted in one pass over the template, so braces inside a transcript
    # are never re-read as placeholders.
    return _FIELD_PATTERN.sub(substitute, template)


class LLMQuery:
    """
    Service for executing LLM queries to process project content.
    Autonomous and self-contained per ADR-001.

    The task is entirely config-driven: the prompt, its schema, and where the
    result lands all come from the task definition, so a new prompt file needs
    no change here.
    """

    # The orchestrator may stop this step: a stopped run writes nothing, so a
    # model answer arriving after the user pressed stop is thrown away.
    supports_stop = True

    def __init__(self, task_name: str, task: Optional[LLMTask] = None):
        self.task_name = task_name
        self._task = task

    @property
    def task(self) -> Optional[LLMTask]:
        if self._task is None:
            self._task = discover_tasks().get(self.task_name)
        return self._task

    @property
    def adapter(self) -> Optional[ResultAdapter]:
        task = self.task
        if task is None or not task.result_adapter:
            return None
        adapter = RESULT_ADAPTERS.get(task.result_adapter)
        if adapter is None:
            logger.warning(
                f"Task '{self.task_name}' names unknown result_adapter "
                f"'{task.result_adapter}'; storing output in llm_outputs instead."
            )
        return adapter

    def reset_metadata(self, project: Project) -> None:
        """Clears this task's output and returns its step to pending."""
        adapter = self.adapter
        if adapter is not None:
            adapter.reset(project)
        else:
            project.clear_llm_output(self.task_name)
        project.set_step_status(self.task_name, "pending")

    def start_service(self, project: Project) -> None:
        """Initializes service and resets metadata."""
        self.reset_metadata(project)
        project.set_step_status(self.task_name, "running")

    def end_service(self, project: Project) -> None:
        """Finalizes the service."""
        project.set_step_status(self.task_name, "completed")

    def fail(self, project: Project, message: str) -> Dict[str, str]:
        project.set_step_status(self.task_name, "error")
        return {"status": "error", "message": message}

    async def execute(self, project: Project) -> Any:  # pragma: no cover
        logger.info(f"LLMQuery executing task={self.task_name} for project={project.project_id}")
        self.start_service(project)
        try:
            task = self.task
            if task is None:
                raise ValueError(
                    f"Task '{self.task_name}' has no prompt in backend/config/prompts."
                )

            if self.task_name == "highlights" and settings_manager.get(HIGHLIGHT_PROVIDER_KEY) == "jev":
                return self._execute_jev(project, task)

            template = task.load_template()

            # Resolved before any API call so a task with no schema fails
            # immediately instead of after paying for a generation.
            schema = task.load_schema() if task.is_json else None

            prompt = build_prompt(template, project)

            credential_provider = LocalCredentialProvider()
            api_key = credential_provider.load("gemini_api_key")
            if not api_key:
                raise ValueError("Gemini API key not found in secrets.")
            client = GeminiClient(api_key=api_key)

            logger.info(
                f"LLMQuery sending prompt to Gemini for task={self.task_name}. Prompt length={len(prompt)}"
            )
            logger.debug(f"LLMQuery prompt content: {prompt}")

            response = client.generate_content(prompt, is_json=task.is_json)
            logger.info(
                f"LLMQuery received response from Gemini for task={self.task_name}. Response length={len(response)}"
            )
            logger.debug(f"LLMQuery response content: {response}")
            if stop_requested():
                raise StepStopped()

            if not task.is_json:
                project.set_llm_output(self.task_name, response)
                self.end_service(project)
                return {"status": "completed"}

            result = json.loads(response)

            errors = validate(result, schema)
            if errors:
                detail = "; ".join(errors[:10])
                logger.error(
                    f"LLMQuery output for task={self.task_name} does not match {task.schema}: {detail}"
                )
                return self.fail(project, f"Response failed schema validation: {detail}")

            adapter = self.adapter
            if adapter is not None:
                adapter.apply(project, result)
            else:
                project.set_llm_output(self.task_name, result)

            self.end_service(project)
            logger.info(f"LLMQuery completed task={self.task_name} for project={project.project_id}")
            return {"status": "completed"}
        except StepStopped:
            logger.info(f"LLMQuery task={self.task_name} stopped; discarding its result")
            return {"status": "stopped"}
        except SchemaNotFoundError as e:
            logger.warning(f"Task '{self.task_name}' cannot run: {e}")
            return self.fail(project, str(e))
        except Exception as e:
            if stop_requested():
                # Stopped already: the step's status belongs to whatever ran
                # after, and an error from the abandoned request is not news.
                logger.info(f"LLMQuery task={self.task_name} failed after being stopped: {describe_error(e)}")
                return {"status": "stopped"}
            logger.error(f"Error executing {self.task_name}: {describe_error(e)}", exc_info=True)
            return self.fail(project, describe_error(e))

    def _execute_jev(self, project: Project, task: LLMTask) -> Dict[str, str]:
        """Jev picks and cuts the clips; Gemini then writes their titles and descriptions."""
        schema = task.load_schema()
        gemini_key = LocalCredentialProvider().load("gemini_api_key")
        if not gemini_key:
            # Checked before Jev is paid: Jev picks the clips, but their
            # titles and descriptions still come from Gemini.
            raise ValueError("Gemini API key not found in secrets. It writes the titles for Jev's clips.")

        client = TypeSafeClient(
            api_key=settings_manager.get("typesafe_api_key"),
            base_url=settings_manager.get("typesafe_api_url") or None,
        )
        options = highlight_options.resolve(project)
        highlighter = JevHighlighter(client)
        moments = highlighter.find_moments(project, options)
        run_id = uuid.uuid4().hex
        payloads = [highlighter.payload(m, run_id) for m in moments]
        logger.info(f"Jev found {len(moments)} moments for project={project.project_id}")

        # Saved before any title exists, so the cards appear while the rest of
        # the run fills them in.
        result = {"shorts": payloads}
        errors = validate(result, schema)
        if errors:
            return self.fail(project, f"Jev highlights failed schema validation: {'; '.join(errors[:10])}")
        self.adapter.apply(project, result)
        # Done as far as anything downstream is concerned: the clips exist and
        # can be cut. Their loop cuts and titles are filled in afterwards, in the
        # background, so nothing waits on Gemini.
        self.end_service(project)

        gemini = GeminiClient(api_key=gemini_key)

        def fill_in() -> None:
            self._fill_in_jev_clips(project, highlighter, options, gemini, run_id, moments, payloads)

        return {"status": "completed", "background": fill_in}

    def _fill_in_jev_clips(self, project: Project, highlighter: JevHighlighter, options,
                           gemini: GeminiClient, run_id: str, moments, payloads) -> None:
        """Chooses each Jev clip's cut and has Gemini title it, best first, in batches.

        Runs after the step has finished. Each batch is written as soon as it is
        done, so the cards fill in while the user works. Stops when the
        orchestrator says so — a new highlights run — or when the highlights on
        disk no longer belong to this run.
        """
        order = sorted(range(len(moments)), key=lambda i: -moments[i]["score"])
        untitled = 0
        for first in range(0, len(order), JEV_TITLE_BATCH):
            if stop_requested():
                return
            batch = order[first:first + JEV_TITLE_BATCH]
            try:
                for i in batch:
                    highlighter.choose_cut(moments[i], options)
                    payloads[i] = highlighter.payload(moments[i], run_id)
            except StepStopped:
                return
            try:
                texts = self._write_jev_texts(project, [payloads[i] for i in batch], gemini)
            except Exception as e:
                # The clips are already Jev's work; a batch Gemini will not title
                # stays untitled rather than costing the rest.
                logger.warning(f"Gemini could not title a batch of Jev clips: {describe_error(e)}")
                texts = {}
                untitled += len(batch)
            for position, i in enumerate(batch):
                payloads[i].update(texts.get(position, {}))
            if stop_requested():
                return
            if self._merge_jev_batch(project.project_id, run_id, [payloads[i] for i in batch]) == 0:
                logger.info(f"Highlights of {project.project_id} were replaced; stopping Jev run {run_id}")
                return

        if untitled:
            Project(project.project_id).partial_step(
                self.task_name,
                f"Gemini could not write titles for {untitled} of {len(order)} clips. "
                "Run Highlights again to retry.",
            )
        logger.info(f"Jev run {run_id} filled in {len(order) - untitled} of {len(order)} clips")

    @staticmethod
    def _merge_jev_batch(project_id: str, run_id: str, payloads: List[Dict[str, Any]]) -> int:
        """Writes one batch's cuts and titles onto the highlights saved earlier.

        Read fresh from disk and matched by run and start, because the user can
        edit a card while the run goes on. A clip that has been trimmed or cut
        meanwhile keeps its window: only its texts and scores are filled in.
        Returns how many highlights it matched; none means the run was replaced.

        Done inside the metadata lock on the stored dicts, not by loading a
        Project and saving its list: the clipper may be writing a clip it just
        cut at the same moment, and a whole-list save from an older read would
        undo it.
        """
        by_start = {p["start"]: p for p in payloads}
        matched = 0

        def merge(data: Dict[str, Any]) -> None:
            nonlocal matched
            for stored in data.get("highlights") or []:
                scores = stored.get("jev_scores") or {}
                payload = by_start.get(stored.get("start"))
                if payload is None or scores.get("run") != run_id:
                    continue
                matched += 1
                for field in JEV_TEXT_FIELDS:
                    if payload.get(field):
                        stored[field] = payload[field]
                stored["jev_scores"] = payload["jev_scores"]
                if not stored.get("trimmed_at") and not stored.get("is_clip_generated"):
                    stored["end"] = payload["end"]
                    stored["highlight_text"] = payload["highlight_text"]

        Project(project_id)._mutate_metadata(merge)
        return matched

    @staticmethod
    def _write_jev_texts(project: Project, picks: List[Dict[str, Any]],
                         client: GeminiClient) -> Dict[int, Dict[str, Any]]:
        """Titles, hooks and descriptions for already-chosen segments, keyed by index."""
        segments = [{"index": i, "text": pick["highlight_text"]} for i, pick in enumerate(picks)]
        prompt = build_prompt(JEV_TEXTS_TEMPLATE.read_text(encoding="utf-8"), project)
        prompt += json.dumps(segments, ensure_ascii=False, indent=1)
        response = json.loads(client.generate_content(prompt, is_json=True))
        items = response.get("shorts", []) if isinstance(response, dict) else []
        return {
            item["index"]: {k: v for k, v in item.items() if k != "index" and isinstance(v, str)}
            for item in items
            if isinstance(item, dict) and isinstance(item.get("index"), int)
        }

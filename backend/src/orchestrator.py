import json
import logging
import threading
import time
from pathlib import Path
from typing import Dict, Any, List, Optional
from backend.src.dataclasses.data import Project
from backend.src.infrastructure.progress import reporting_to, stoppable

from backend.src.services.transcriber import Transcriber
from backend.src.services.llm_query import LLMQuery
from backend.src.services.llm_tasks import discover_tasks
from backend.src.services.clipper import Clipper
from backend.src.services.thumbnailer import Thumbnailer
from backend.src.services.postiz_publisher import PostizImportInProgressError, PostizPublisher
from backend.src.services.uploader import Uploader, UploadInProgressError

logger = logging.getLogger(__name__)

# Statuses that mean a step has nothing left for the pipeline to trigger. A
# step that did some of its clips and not the rest is one of them: the run that
# would finish it is a resume the user asks for by pressing the step, not
# something to loop on here.
DONE_STATUSES = ("completed", "partial")

# Appended to a step's process key for the work it left running after it
# finished (see `_start_background`).
BACKGROUND_SUFFIX = "_background"


class ClipRegenerationInProgressError(Exception):
    """A clip was asked to re-cut while its previous re-cut is still running."""


class ThumbnailInProgressError(Exception):
    """A thumbnail was asked for while the previous one is still rendering."""


class PipelineOrchestrator:
    def __init__(self, config_path: str = "backend/config/pipeline.json", active_processes: Dict[str, Any] = None, services: Dict[str, Any] = None, thumbnailer: Optional[Thumbnailer] = None):
        self.config_path = Path(config_path)
        # Not a pipeline step and deliberately not in `services`: a thumbnail
        # is made per clip, on request or alongside a cut, never as a stage of
        # its own.
        self.thumbnailer = thumbnailer or Thumbnailer()
        self.llm_tasks = discover_tasks()
        self.pipeline_config = self._load_pipeline_config()
        self.active_project_orchestrators: Dict[str, threading.Thread] = {}
        self.active_processes = active_processes if active_processes is not None else {}
        # The last thing each running step said about itself, keyed the same
        # way `active_processes` is. Kept beside that dict rather than in the
        # project file: it describes this attempt, not the project, and it is
        # worthless the moment the step ends.
        self.step_notes: Dict[str, Dict[str, Any]] = {}
        # One event per running step, keyed like `active_processes`. Setting it
        # is how a step is stopped; comparing it is how a stopped run's thread
        # knows the key now belongs to the run that replaced it.
        self._run_events: Dict[str, threading.Event] = {}
        self._lock = threading.Lock()

        # Injectable services. Every discovered prompt contributes its own
        # LLMQuery, so a new prompt file needs no wiring here.
        self.services = services or self._build_services()

    def _build_services(self) -> Dict[str, Any]:
        postiz = PostizPublisher()
        services: Dict[str, Any] = {
            "transcription": Transcriber(),
            # Each clip is handed to Postiz the moment its file exists, rather
            # than waiting for the whole step to finish. A project of twenty
            # clips is twenty minutes of encoding, and there is no reason the
            # first clip's draft should wait for the twentieth clip's encode.
            #
            # Wired here because this is the one place that knows about both:
            # the clipper takes a callback and never learns what Postiz is, and
            # the publisher decides for itself whether it is configured to act.
            "clipper": Clipper(on_clip_rendered=postiz.import_rendered),
            # The same object `generate_thumbnail` renders one still with. As a
            # step it draws them all, which is the way to redraw a project after
            # the overlay look changed.
            "thumbnails": self.thumbnailer,
            # The same thumbnailer the clip pages render stills with, so an
            # upload's still is drawn by the one that has the caption service
            # this orchestrator was given.
            "upload": Uploader(thumbnailer=self.thumbnailer),
            "postiz": postiz,
        }
        for name, task in self.llm_tasks.items():
            services[name] = LLMQuery(task_name=name, task=task)
        return services

    def _load_pipeline_config(self) -> Dict[str, Any]:
        if not self.config_path.exists():
            raise FileNotFoundError(f"Pipeline config not found at {self.config_path}")
        with open(self.config_path, 'r') as f:
            config = json.load(f)
        return self._merge_llm_tasks(config)

    def _merge_llm_tasks(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Adds discovered prompt tasks to the pipeline so each one gets a button.

        pipeline.json stays authoritative for the steps it already declares; a
        prompt with no entry there is appended using the defaults from its task
        definition.
        """
        steps = config.setdefault('steps', {})
        order = config.setdefault('execution_order', list(steps))
        for name, task in self.llm_tasks.items():
            if name in steps:
                # Declared in pipeline.json, but the UI still needs to know it
                # belongs behind the single LLM button.
                steps[name]['llm'] = True
                continue
            steps[name] = task.to_step_config()
            if name not in order:
                # Placed straight after the last step it depends on, so the
                # button row still reads as the flow it belongs to.
                positions = [order.index(dep) for dep in task.depends_on if dep in order]
                order.insert(max(positions) + 1 if positions else len(order), name)
            logger.info(f"Registered LLM task '{name}' from {task.template} as a pipeline step")
        return config

    def _exec_service(self, project: Project, step_name: str, full: bool = False,
                      replace: bool = False):
        """Helper to run service execution synchronously within a thread.

        `full` is offered to the services that know what it means — the ones
        that do a piece of work per clip and can therefore resume — and left off
        the call for every other service, so a step whose `execute` takes only a
        project is not broken by a keyword it never asked for.
        """
        service = self.services.get(step_name)
        if service:
            import asyncio
            import inspect
            parameters = inspect.signature(service.execute).parameters
            kwargs = {"full": full} if "full" in parameters else {}
            # Only the upload knows what replacing is; offered the same way.
            if replace and "replace" in parameters:
                kwargs["replace"] = True
            if inspect.iscoroutinefunction(service.execute):
                result = asyncio.run(service.execute(project, **kwargs))
            else:
                result = service.execute(project, **kwargs)

            if project.step_statuses.get(step_name) == "error":
                raise RuntimeError(f"Service {step_name} failed.")
            return result
        return None

    def _record_step_failure(self, project_id: str, step_name: str, error: BaseException):
        """Writes why a step stopped, when the step itself never got to say.

        A service that fails a clip at a time records its own reason, and that
        sentence is better than anything known here, so it is left alone. What
        is left is the failure that escaped before any of that ran — an
        authorisation that will not refresh, a source file that has been moved,
        a bug — and until now it wrote nothing at all: the step stayed
        "running" on disk with nobody running it, and `execution_status` turned
        that into "the server was restarted", which is the one explanation that
        was never true. The page then sent the user to the backend log for a
        sentence the exception was already carrying.

        Read back from disk rather than through the caller's Project: the step
        has been writing to that file throughout, so the object the thread
        started with no longer knows what is on it.
        """
        try:
            project = Project(project_id)
            if project.step_errors.get(step_name):
                return
            # A bare `raise SomeError` carries no message; the class name is
            # then the only thing that says anything about what stopped.
            project.fail_step(step_name, str(error).strip() or error.__class__.__name__)
        except Exception:
            logger.exception(f"Could not record why {step_name} failed for project {project_id}")

    def _register_process(self, key: str):
        with self._lock:
            self.active_processes[key] = time.time()

    def _unregister_process(self, key: str):
        with self._lock:
            self.active_processes.pop(key, None)
            # A note about a step that has stopped is a note about the past.
            self.step_notes.pop(key, None)

    def _note_progress(self, key: str, message: str):
        """Records what the step behind `key` is doing now."""
        with self._lock:
            # Only for a step that is still registered: a report arriving as
            # the step ends must not resurrect an entry `_unregister_process`
            # has already dropped.
            if key not in self.active_processes:
                return
            self.step_notes[key] = {"message": message, "at": time.time()}

    def activity(self, project_id: str) -> Dict[str, Dict[str, Any]]:
        """What each of this project's running steps is doing, by step name.

        `since` is when the step was triggered, which is the number the page
        turns into "running for six minutes" — the single most useful thing to
        show about a step that has said nothing else yet.
        """
        prefix = f"{project_id}_"
        with self._lock:
            running = {
                key[len(prefix):]: started
                for key, started in self.active_processes.items()
                if key.startswith(prefix)
            }
            notes = dict(self.step_notes)

        steps = self.pipeline_config.get("steps", {})
        activity: Dict[str, Dict[str, Any]] = {}
        for step_name, started in running.items():
            # The per-clip jobs (`<id>_clip_3`, `<id>_upload_clip_3`) and the
            # pipeline's own key are registered here too and are not steps.
            if step_name not in steps:
                continue
            entry: Dict[str, Any] = {"since": started}
            note = notes.get(f"{prefix}{step_name}")
            if note:
                entry["message"] = note["message"]
                entry["at"] = note["at"]
            activity[step_name] = entry
        return activity

    def _has_running_step(self, project_id: str) -> bool:
        prefix = f"{project_id}_"
        with self._lock:
            # Background work is not a step the pipeline could be waiting on.
            return any(
                key.startswith(prefix) and not key.endswith(("_pipeline", BACKGROUND_SUFFIX))
                for key in self.active_processes
            )

    def _dependents(self, step_name: str) -> List[str]:
        """Every step downstream of `step_name`, directly or through another step."""
        steps = self.pipeline_config['steps']
        stale = {step_name}
        # Iterated to a fixed point rather than walked in execution order, so a
        # step declared out of dependency order is still reached.
        changed = True
        while changed:
            changed = False
            for name, config in steps.items():
                if name in stale:
                    continue
                if any(dep in stale for dep in config.get('depends_on', [])):
                    stale.add(name)
                    changed = True
        order = self.pipeline_config.get('execution_order', list(steps))
        return [name for name in order if name in stale and name != step_name]

    def _invalidate_dependents(self, project: Project, step_name: str):
        """Marks everything downstream of a re-run step as not done.

        Re-running highlights replaces the list every clip was cut from, so the
        clips on disk belong to highlights that no longer exist. Without this
        the clipper keeps its "completed" badge while its output has silently
        gone, and the orphaned files stay in clips/ forever.
        """
        for name in self._dependents(step_name):
            if f"{project.project_id}_{name}" in self.active_processes:
                # Already running: it will write its own status, and resetting
                # it here would only fight that.
                continue
            if project.step_statuses.get(name) in (None, "todo", "locked"):
                continue
            service = self.services.get(name)
            if service is not None and hasattr(service, 'reset_metadata'):
                service.reset_metadata(project)
            # reset_metadata leaves its own step "pending"; "todo" is what
            # execution_status re-evaluates against the dependency graph, so a
            # step whose inputs just vanished shows as locked rather than ready.
            project.set_step_status(name, "todo")
            logger.info(f"Reset step '{name}' for {project.project_id}: '{step_name}' is re-running")

    def run_step(self, project_id: str, step_name: str, full: bool = False, replace: bool = False):
        """Triggers a step in the background.

        A step pressed on its own resumes: it does the work still missing and
        leaves alone whatever the last run already produced, which is what makes
        a second press after a partial run finish the job rather than repeat it.
        `full` is what the whole-pipeline run passes, and it starts from
        nothing.
        """
        key = f"{project_id}_{step_name}"
        if key in self.active_processes:
            logger.info(f"Step {step_name} already running for {project_id}, ignoring trigger.")
            return

        project = Project(project_id)
        # A new run replaces what the last one's background work was filling in.
        self._stop_background(f"{key}{BACKGROUND_SUFFIX}")
        self._invalidate_dependents(project, step_name)
        # Registered before the thread starts so the request that triggered the
        # step returns with the process already visible on /active_processes.
        # The frontend gates its polling on that list, so a late registration
        # means the UI never starts refreshing.
        self._register_process(key)
        stop_event = threading.Event()
        with self._lock:
            self._run_events[key] = stop_event

        def runner():
            try:
                # Everything this step reports on this thread lands on the
                # step's own entry, which is what /execution_status hands to
                # the page while the step runs.
                with reporting_to(lambda message: self._note_progress(key, message)), stoppable(stop_event):
                    result = self._exec_service(project, step_name, full=full, replace=replace)
                # A step may finish with work still to do that nothing waits
                # for — Jev's titles — and hands it back to run on its own.
                background = result.get("background") if isinstance(result, dict) else None
                if callable(background) and not stop_event.is_set():
                    self._start_background(f"{key}{BACKGROUND_SUFFIX}", background)
            except Exception as e:
                if stop_event.is_set():
                    logger.info(f"Stopped step {step_name} for project {project_id} ended: {e}")
                else:
                    logger.exception(f"Step {step_name} failed for project {project_id}")
                    self._record_step_failure(project_id, step_name, e)
            finally:
                # A stopped run's key may already belong to a new run of the
                # same step; only the run that still owns it lets it go.
                with self._lock:
                    owns_key = self._run_events.get(key) is stop_event
                    if owns_key:
                        self._run_events.pop(key, None)
                if owns_key:
                    self._unregister_process(key)

        thread = threading.Thread(target=runner)
        with self._lock:
            self.active_project_orchestrators[project_id] = thread
        thread.start()

    def _start_background(self, key: str, work) -> None:
        """Runs work a finished step left behind, on its own thread.

        Registered like a step, so the page keeps polling and shows its results
        as they land, but under a key that is not a step: nothing waits on it,
        and the steps after the one that started it are already free to run.
        """
        event = threading.Event()
        with self._lock:
            self._run_events[key] = event
        self._register_process(key)

        def runner():
            try:
                with stoppable(event):
                    work()
            except Exception:
                logger.exception(f"Background work {key} failed")
            finally:
                with self._lock:
                    owns_key = self._run_events.get(key) is event
                    if owns_key:
                        self._run_events.pop(key, None)
                if owns_key:
                    self._unregister_process(key)

        threading.Thread(target=runner, daemon=True).start()

    def _stop_background(self, key: str) -> None:
        with self._lock:
            event = self._run_events.pop(key, None)
        if event is not None:
            event.set()
            self._unregister_process(key)

    def stop_step(self, project_id: str, step_name: str) -> bool:
        """Stops a running step, for services that honour a stop. True if it stopped.

        The thread is not killed — Python cannot — but it is told, and it
        discards whatever it was about to write. The step is released at once,
        so pressing it again starts a fresh run instead of waiting for the old
        one's request to come back.
        """
        if not getattr(self.services.get(step_name), "supports_stop", False):
            logger.info(f"Step {step_name} cannot be stopped; ignoring stop for {project_id}")
            return False
        key = f"{project_id}_{step_name}"
        with self._lock:
            event = self._run_events.pop(key, None)
        if event is None:
            return False
        event.set()
        self._unregister_process(key)
        try:
            Project(project_id).set_step_status(step_name, "pending")
        except Exception:
            logger.exception(f"Could not mark {step_name} stopped for project {project_id}")
        logger.info(f"Stopped step {step_name} for project {project_id}")
        return True

    def upload_clip(self, project_id: str, clip_index: int) -> str:
        """Re-cuts one clip and publishes it in the background; returns its job key.

        Backgrounded rather than synchronous, because the upload now starts with
        a fresh cut of the clip and an encode outlives a browser request. What
        the user is owed is still the outcome, so it is written onto the
        highlight — the published URL, or `upload_error` — and read back when
        this key leaves /active_processes.

        The connection to YouTube is opened here rather than in the thread, so
        an authorisation that cannot publish is reported to the click that asked
        rather than after minutes of encoding.

        Registered as an active process so a second request for the same clip is
        refused rather than publishing it twice — the guard in the UI covers one
        browser tab, and this covers the rest.

        Raises IndexError when there is no highlight at `clip_index`,
        UploadInProgressError when this clip is already going up, and
        ClipRegenerationInProgressError when a re-cut of it is already running.
        """
        project = Project(project_id)
        if clip_index < 0 or clip_index >= len(project.highlights):
            raise IndexError(f"No highlight at index {clip_index}")

        uploader = self.services.get("upload")
        if uploader is None:
            raise RuntimeError("No upload service is configured.")

        key = f"{project_id}_upload_clip_{clip_index}"
        with self._lock:
            if key in self.active_processes:
                raise UploadInProgressError("This clip is already being uploaded.")
            # The upload cuts the clip itself, so it writes the same file a
            # re-cut does. Two of them at once would interleave in it.
            if f"{project_id}_clip_{clip_index}" in self.active_processes:
                raise ClipRegenerationInProgressError(
                    "This clip is being re-cut. Wait for that to finish, then upload it."
                )
            # An import cuts the clip as well, into the same file.
            if f"{project_id}_postiz_clip_{clip_index}" in self.active_processes:
                raise PostizImportInProgressError(
                    "This clip is being imported into Postiz, which re-cuts it. "
                    "Wait for that to finish, then upload it."
                )
            self.active_processes[key] = time.time()

        try:
            client = uploader.open_client()
        except Exception:
            self._unregister_process(key)
            raise
        # Whatever the last attempt failed with is about to be answered by this
        # one, and a stale message is what the page would otherwise read back.
        uploader.begin_attempt(project, clip_index)

        def runner():
            try:
                uploader.upload_one(project, clip_index, client=client)
            except Exception as e:
                logger.exception(f"Uploading clip {clip_index} failed for project {project_id}")
                uploader.record_failure(project, clip_index, str(e) or e.__class__.__name__)
            finally:
                self._unregister_process(key)

        thread = threading.Thread(target=runner)
        thread.start()
        return key

    def import_clip_to_postiz(self, project_id: str, clip_index: int) -> str:
        """Re-cuts one clip and files it in Postiz in the background.

        Backgrounded and keyed exactly like `upload_clip`, and for the same
        reasons: the import begins with a fresh cut, which outlives a browser
        request, and the outcome the user is owed is written onto the highlight
        — `postiz_url`, or `postiz_error` — to be read back when this key
        leaves /active_processes.

        The Postiz handle is opened here rather than in the thread, so a missing
        or rejected API key, and an account with no channels, are reported to
        the click that asked rather than after minutes of encoding.

        Raises IndexError when there is no highlight at `clip_index`,
        PostizImportInProgressError when this clip is already being imported,
        UploadInProgressError while it is being published to YouTube, and
        ClipRegenerationInProgressError when a re-cut of it is already running —
        all three cut the same clip into the same file.
        """
        project = Project(project_id)
        if clip_index < 0 or clip_index >= len(project.highlights):
            raise IndexError(f"No highlight at index {clip_index}")

        publisher = self.services.get("postiz")
        if publisher is None:
            raise RuntimeError("No Postiz service is configured.")

        key = f"{project_id}_postiz_clip_{clip_index}"
        with self._lock:
            if key in self.active_processes:
                raise PostizImportInProgressError(
                    "This clip is already being imported into Postiz."
                )
            if f"{project_id}_upload_clip_{clip_index}" in self.active_processes:
                raise UploadInProgressError(
                    "This clip is being published to YouTube. Wait for that to finish, "
                    "then import it."
                )
            if f"{project_id}_clip_{clip_index}" in self.active_processes:
                raise ClipRegenerationInProgressError(
                    "This clip is being re-cut. Wait for that to finish, then import it."
                )
            self.active_processes[key] = time.time()

        try:
            client = publisher.open_client()
            # Asked before anything is encoded: an account with nothing
            # connected is the commonest first-run failure, and it is the one
            # the user can act on immediately.
            publisher.resolve_channels(client, project)
        except Exception:
            self._unregister_process(key)
            raise
        # Whatever the last attempt failed with is about to be answered by this
        # one, and a stale message is what the page would otherwise read back.
        publisher.begin_attempt(project, clip_index)

        def runner():
            try:
                publisher.import_one(project, clip_index, client=client)
            except Exception as e:
                logger.exception(
                    f"Importing clip {clip_index} into Postiz failed for project {project_id}"
                )
                publisher.record_failure(project, clip_index, str(e) or e.__class__.__name__)
            finally:
                self._unregister_process(key)

        thread = threading.Thread(target=runner)
        thread.start()
        return key

    def regenerate_clip(self, project_id: str, clip_index: int) -> str:
        """Re-cuts one clip in the background and returns the job key to watch.

        Backgrounded like `upload_clip`, which begins with this same cut: an
        encode can run for minutes, which is longer than a browser will hold a
        request open. The key is registered before this returns, so the page that
        triggered it sees the job on /active_processes on its first poll rather
        than deciding it has already finished.

        Raises IndexError when there is no highlight at `clip_index`,
        ClipRegenerationInProgressError when this clip is already being cut, and
        UploadInProgressError while it is going up — an upload cuts the clip
        first, so it is already writing the file this would write.
        """
        project = Project(project_id)
        if clip_index < 0 or clip_index >= len(project.highlights):
            raise IndexError(f"No highlight at index {clip_index}")

        key = f"{project_id}_clip_{clip_index}"
        with self._lock:
            if key in self.active_processes:
                raise ClipRegenerationInProgressError("This clip is already being re-cut.")
            if f"{project_id}_upload_clip_{clip_index}" in self.active_processes:
                raise UploadInProgressError(
                    "This clip is being uploaded, which re-cuts it. Wait for that to finish."
                )
            # A Postiz import cuts the clip too, into the same file.
            if f"{project_id}_postiz_clip_{clip_index}" in self.active_processes:
                raise PostizImportInProgressError(
                    "This clip is being imported into Postiz, which re-cuts it. "
                    "Wait for that to finish."
                )
            self.active_processes[key] = time.time()

        clipper = self.services.get("clipper")
        if clipper is None:
            self._unregister_process(key)
            raise RuntimeError("No clipper service is configured.")

        def runner():
            try:
                clipper.render_one(project, clip_index)
            except Exception:
                logger.exception(f"Regenerating clip {clip_index} failed for project {project_id}")
            finally:
                self._unregister_process(key)

        thread = threading.Thread(target=runner)
        thread.start()
        return key

    def generate_thumbnail(self, project_id: str, clip_index: int) -> Dict[str, Any]:
        """Renders one clip's thumbnail and returns what it produced.

        Synchronous, unlike a re-cut: this is one frame and the picture is what
        the user is waiting to look at, so a job id would only make the page
        poll for something that has already happened.

        Registered as an active process all the same, so two clicks do not run
        two ffmpeg passes over the same output file.

        Raises IndexError when there is no highlight at `clip_index`, and
        ThumbnailInProgressError while one is already being made.
        """
        key = f"{project_id}_thumbnail_{clip_index}"
        with self._lock:
            if key in self.active_processes:
                raise ThumbnailInProgressError("This thumbnail is already being made.")
            self.active_processes[key] = time.time()

        try:
            project = Project(project_id)
            return self.thumbnailer.generate(project, clip_index).to_dict()
        finally:
            self._unregister_process(key)

    def run_pipeline(self, project_id: str):
        """Triggers the full pipeline in the background using dependency graph."""
        project = Project(project_id)
        # Global reset: each service resets only its own state
        for service in self.services.values():
            if hasattr(service, 'reset_metadata'):
                service.reset_metadata(project)

        pipeline_key = f"{project_id}_pipeline"
        self._register_process(pipeline_key)

        def pipeline_runner():
            steps = self.pipeline_config['steps']
            while True:
                project.load(project.project_id)

                # Check for failure in pipeline
                if any(project.step_statuses.get(s) == "error" for s in steps):
                    break

                # Check if pipeline finished. A step that got some of its clips
                # done and not the rest is as finished as this run is going to
                # make it — the pipeline has nothing further to trigger for it,
                # and the badge on the page is what asks the user to press it
                # again.
                if all(project.step_statuses.get(s) in DONE_STATUSES for s in steps):
                    break

                triggered = False
                for step_name, config in steps.items():
                    # Only trigger if status is not started
                    if project.step_statuses.get(step_name) not in [None, "todo", "pending"]:
                        continue

                    # Strict dependency check. "partial" counts: a step whose
                    # input is nineteen of twenty clips can still do nineteen
                    # clips' worth of work, and holding it back would leave the
                    # user with nothing rather than with most of it.
                    dependencies = config.get('depends_on', [])
                    if all(project.step_statuses.get(dep) in DONE_STATUSES for dep in dependencies):
                        # Only trigger auto-run
                        if config.get('auto_run', True):
                            # From the start: this is the whole-pipeline run,
                            # not a resume of one step.
                            self.run_step(project.project_id, step_name, full=True)
                            triggered = True

                # Nothing left to trigger and nothing still running means the
                # pipeline is waiting on a manual step. Stop instead of holding
                # the process registration open forever.
                if not triggered and not self._has_running_step(project.project_id):
                    break

                time.sleep(1.0)

        def runner():
            try:
                pipeline_runner()
            except Exception:
                logger.exception(f"Pipeline failed for project {project_id}")
            finally:
                self._unregister_process(pipeline_key)

        thread = threading.Thread(target=runner)
        with self._lock:
            self.active_project_orchestrators[project_id] = thread
        thread.start()

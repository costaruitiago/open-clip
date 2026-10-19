import json
import threading
import time
from datetime import datetime
from pathlib import Path

import pytest

from backend.src.infrastructure.progress import report
from backend.src.orchestrator import PipelineOrchestrator

PIPELINE_CONFIG = Path(__file__).resolve().parents[1] / "config" / "pipeline.json"

PROJECT_ID = "test-project"


class BlockingService:
    """Service whose execute() blocks until the test releases it."""

    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0

    def execute(self, project):
        self.calls += 1
        self.started.set()
        self.release.wait(timeout=5)


def write_project(root: Path, step_statuses=None):
    project_dir = root / "projects" / PROJECT_ID
    project_dir.mkdir(parents=True)
    metadata = {
        "project_id": PROJECT_ID,
        "name": "Test Project",
        "created_at": datetime.now().isoformat(),
        "files": {},
        "highlights": [],
        "video_metadata": {"components": [], "top_recommendations": []},
        "settings": {"aspect_ratio": "16:9", "resolution": "1080p"},
        "status": None,
        "step_statuses": step_statuses or {},
    }
    (project_dir / "metadata.json").write_text(json.dumps(metadata))


@pytest.fixture
def project_root(tmp_path, monkeypatch):
    write_project(tmp_path)
    monkeypatch.chdir(tmp_path)
    return tmp_path


def make_orchestrator(services, clipper=None):
    return PipelineOrchestrator(
        config_path=str(PIPELINE_CONFIG), services=services, clipper=clipper or RecordingService()
    )


def test_run_step_registers_process_before_returning(project_root):
    service = BlockingService()
    orchestrator = make_orchestrator({"upload": service})

    orchestrator.run_step(PROJECT_ID, "upload")

    # The frontend gates its polling on this list, so the key has to be there
    # by the time the triggering request returns, not once the thread starts.
    assert f"{PROJECT_ID}_upload" in orchestrator.active_processes

    service.release.set()
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)
    assert orchestrator.active_processes == {}


# A step that says "running" for six minutes and nothing else is
# indistinguishable from one that has hung. These cover the channel that
# carries the difference to the page.
def test_a_running_step_reports_how_long_it_has_been_going(project_root):
    service = BlockingService()
    orchestrator = make_orchestrator({"upload": service})

    orchestrator.run_step(PROJECT_ID, "upload")
    assert service.started.wait(timeout=5)

    activity = orchestrator.activity(PROJECT_ID)
    # Present before anything has been reported: the elapsed time is already
    # more than "running" said.
    assert "since" in activity["upload"]
    assert "message" not in activity["upload"]

    service.release.set()
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)


def test_what_a_step_reports_reaches_the_page(project_root):
    class TalkingService:
        def __init__(self):
            self.started = threading.Event()
            self.release = threading.Event()

        def execute(self, project):
            report("Waiting for model-a to answer.")
            self.started.set()
            self.release.wait(timeout=5)

    service = TalkingService()
    orchestrator = make_orchestrator({"upload": service})

    orchestrator.run_step(PROJECT_ID, "upload")
    assert service.started.wait(timeout=5)

    assert orchestrator.activity(PROJECT_ID)["upload"]["message"] == "Waiting for model-a to answer."

    service.release.set()
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)
    # A note about a step that has stopped is a note about the past.
    assert orchestrator.activity(PROJECT_ID) == {}
    assert orchestrator.step_notes == {}


def test_per_clip_jobs_are_not_reported_as_steps(project_root):
    orchestrator = make_orchestrator({})
    orchestrator._register_process(f"{PROJECT_ID}_clip_3")
    orchestrator._register_process(f"{PROJECT_ID}_pipeline")

    # Both are registered processes; neither is a step, and reading their
    # trailing segment as one is what put entries like "3" into this payload.
    assert orchestrator.activity(PROJECT_ID) == {}


def test_run_step_clears_process_when_service_raises(project_root):
    class FailingService:
        def execute(self, project):
            raise RuntimeError("boom")

    orchestrator = make_orchestrator({"upload": FailingService()})

    orchestrator.run_step(PROJECT_ID, "upload")
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)

    assert orchestrator.active_processes == {}


def test_a_step_that_dies_says_why_on_the_project(project_root):
    """The sentence the page shows instead of sending the user to the log."""

    class FailingService:
        def execute(self, project):
            raise RuntimeError("YouTube has rejected the stored authorisation.")

    orchestrator = make_orchestrator({"upload": FailingService()})

    orchestrator.run_step(PROJECT_ID, "upload")
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)

    metadata = json.loads((project_root / "projects" / PROJECT_ID / "metadata.json").read_text())
    assert metadata["step_statuses"]["upload"] == "error"
    assert metadata["step_errors"]["upload"] == "YouTube has rejected the stored authorisation."


def test_a_failure_carrying_no_message_is_named_by_its_type(project_root):
    class FailingService:
        def execute(self, project):
            raise TimeoutError()

    orchestrator = make_orchestrator({"upload": FailingService()})

    orchestrator.run_step(PROJECT_ID, "upload")
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)

    metadata = json.loads((project_root / "projects" / PROJECT_ID / "metadata.json").read_text())
    assert metadata["step_errors"]["upload"] == "TimeoutError"


def test_a_service_that_reported_its_own_reason_keeps_it(project_root):
    """A per-clip reason beats anything the thread that caught it could say."""

    class PartlyFailingService:
        def execute(self, project):
            project.fail_step("upload", "3 of 10 clips could not be cut: the source is gone.")

    orchestrator = make_orchestrator({"upload": PartlyFailingService()})

    orchestrator.run_step(PROJECT_ID, "upload")
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)

    metadata = json.loads((project_root / "projects" / PROJECT_ID / "metadata.json").read_text())
    assert metadata["step_errors"]["upload"] == "3 of 10 clips could not be cut: the source is gone."


def test_run_step_ignores_duplicate_trigger_while_running(project_root):
    service = BlockingService()
    orchestrator = make_orchestrator({"upload": service})

    orchestrator.run_step(PROJECT_ID, "upload")
    assert service.started.wait(timeout=5)
    orchestrator.run_step(PROJECT_ID, "upload")

    service.release.set()
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)
    assert service.calls == 1


def test_run_pipeline_registers_pipeline_and_step_processes(project_root):
    service = BlockingService()
    orchestrator = make_orchestrator({"transcription": service})

    orchestrator.run_pipeline(PROJECT_ID)

    # The pipeline registration is what keeps the UI polling across the gaps
    # between individual steps.
    assert f"{PROJECT_ID}_pipeline" in orchestrator.active_processes
    assert service.started.wait(timeout=5)
    assert f"{PROJECT_ID}_transcription" in orchestrator.active_processes

    # Mark everything done on disk so the runner loop exits, then release.
    metadata_path = project_root / "projects" / PROJECT_ID / "metadata.json"
    metadata = json.loads(metadata_path.read_text())
    steps = json.loads(PIPELINE_CONFIG.read_text())["steps"]
    metadata["step_statuses"] = {step: "completed" for step in steps}
    metadata_path.write_text(json.dumps(metadata))
    service.release.set()

    assert wait_for(lambda: not orchestrator.active_processes)


def wait_for(predicate, timeout=5.0, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class RecordingService:
    """Service that records whether the orchestrator reset it."""

    def __init__(self):
        self.reset_calls = 0

    def reset_metadata(self, project):
        self.reset_calls += 1

    def execute(self, project):
        pass


def write_statuses(root: Path, statuses: dict):
    metadata_path = root / "projects" / PROJECT_ID / "metadata.json"
    metadata = json.loads(metadata_path.read_text())
    metadata["step_statuses"] = statuses
    metadata_path.write_text(json.dumps(metadata))


def read_statuses(root: Path) -> dict:
    return json.loads((root / "projects" / PROJECT_ID / "metadata.json").read_text())["step_statuses"]


def test_rerunning_a_step_resets_everything_downstream(project_root):
    """Re-running highlights must not leave the upload showing "done".

    Every clip is cut from the highlight list this step is about to replace, so
    those clips stop existing the moment highlights re-runs.
    """
    clipper = RecordingService()
    upload = RecordingService()
    orchestrator = make_orchestrator({
        "highlights": RecordingService(),
        "upload": upload,
    }, clipper=clipper)
    write_statuses(project_root, {
        "transcription": "completed",
        "highlights": "completed",
        "upload": "completed",
    })

    orchestrator.run_step(PROJECT_ID, "highlights")
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)

    statuses = read_statuses(project_root)
    # Published from the highlight list this step replaces, so it is stale.
    assert statuses["upload"] == "todo"
    # Untouched: transcription is what highlights reads, not what it feeds.
    assert statuses["transcription"] == "completed"
    # The clips on disk were cut from the old list.
    assert clipper.reset_calls == 1
    assert upload.reset_calls == 1


def test_rerunning_a_step_leaves_downstream_steps_that_never_ran(project_root):
    upload = RecordingService()
    orchestrator = make_orchestrator({"highlights": RecordingService(), "upload": upload})
    write_statuses(project_root, {"transcription": "completed", "highlights": "completed"})

    orchestrator.run_step(PROJECT_ID, "highlights")
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)

    # Nothing to invalidate: a step that never ran has no output to reset.
    assert upload.reset_calls == 0


def test_a_step_after_highlights_leaves_the_clips_alone(project_root):
    clipper = RecordingService()
    orchestrator = make_orchestrator({"upload": RecordingService()}, clipper=clipper)
    write_statuses(project_root, {"transcription": "completed", "highlights": "completed"})

    orchestrator.run_step(PROJECT_ID, "upload")
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)

    assert clipper.reset_calls == 0


# --- Resuming a step versus starting it over --------------------------------

class ResumableService(RecordingService):
    """A service that can tell a resume from a run that starts over."""

    def __init__(self):
        super().__init__()
        self.full_calls = []

    def execute(self, project, full=False):
        self.full_calls.append(full)


def test_a_step_pressed_on_its_own_resumes(project_root):
    # The clips already cut, the videos already published and the drafts
    # already filed are the point of pressing it again: it finishes the job
    # rather than repeating it.
    upload = ResumableService()
    orchestrator = make_orchestrator({"upload": upload})
    write_statuses(project_root, {"transcription": "completed", "highlights": "completed"})

    orchestrator.run_step(PROJECT_ID, "upload")
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)

    assert upload.full_calls == [False]


def test_the_whole_pipeline_run_starts_from_nothing(project_root):
    transcription = ResumableService()
    orchestrator = make_orchestrator({"transcription": transcription})

    orchestrator.run_pipeline(PROJECT_ID)
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)

    # A fake that never writes a status is re-triggered by the loop until it
    # gives up, so what matters is that every one of those runs was a full one.
    assert transcription.full_calls
    assert all(transcription.full_calls)


class PlainService(RecordingService):
    """A service whose `execute` takes nothing but the project, like most."""

    def __init__(self):
        super().__init__()
        self.calls = 0

    def execute(self, project):
        self.calls += 1


def test_a_service_whose_execute_takes_only_a_project_is_not_handed_the_flag(project_root):
    # Most steps do one thing once and have nothing to resume. Passing them a
    # keyword they never declared would be a TypeError on every run — swallowed
    # by the thread's own except, so the step would just silently never happen.
    plain = PlainService()
    orchestrator = make_orchestrator({"upload": plain})
    write_statuses(project_root, {"transcription": "completed", "highlights": "completed"})

    orchestrator.run_step(PROJECT_ID, "upload", full=True)
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)

    assert plain.calls == 1


# Stop. A thread cannot be killed, so a stop releases the step at once and the
# abandoned run is told to write nothing when its request finally returns.
class StoppableService(BlockingService):
    supports_stop = True

    def __init__(self):
        super().__init__()
        self.saw_stop = []

    def execute(self, project):
        from backend.src.infrastructure.progress import stop_requested
        super().execute(project)
        self.saw_stop.append(stop_requested())


def test_stopping_a_step_releases_it_at_once(project_root):
    service = StoppableService()
    orchestrator = make_orchestrator({"highlights": service})
    orchestrator.run_step(PROJECT_ID, "highlights")
    service.started.wait(timeout=5)
    old_run = orchestrator.active_project_orchestrators[PROJECT_ID]

    assert orchestrator.stop_step(PROJECT_ID, "highlights") is True

    assert f"{PROJECT_ID}_highlights" not in orchestrator.active_processes
    service.release.set()
    old_run.join(timeout=5)
    assert service.saw_stop == [True]


def test_a_stopped_run_finishing_late_does_not_release_the_run_that_replaced_it(project_root):
    service = StoppableService()
    orchestrator = make_orchestrator({"highlights": service})
    orchestrator.run_step(PROJECT_ID, "highlights")
    service.started.wait(timeout=5)
    old_run = orchestrator.active_project_orchestrators[PROJECT_ID]
    orchestrator.stop_step(PROJECT_ID, "highlights")

    orchestrator.run_step(PROJECT_ID, "highlights")  # the new run, still blocked
    service.release.set()
    old_run.join(timeout=5)
    # The new run took the same release; wait for it to finish too, then check
    # the old run never removed the new run's key while it was still going.
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)

    assert service.calls == 2
    assert service.saw_stop.count(True) == 1


class LeavesWorkBehind:
    """A step that finishes at once and hands back work to run afterwards."""

    def __init__(self):
        self.release = threading.Event()
        # One entry per run: (finished, whether it saw a stop).
        self.runs = []

    def execute(self, project):
        run = {"done": threading.Event(), "saw_stop": None}
        self.runs.append(run)

        def work():
            from backend.src.infrastructure.progress import stop_requested
            self.release.wait(timeout=5)
            run["saw_stop"] = stop_requested()
            run["done"].set()
        return {"status": "completed", "background": work}


def test_background_work_runs_after_the_step_has_finished(project_root):
    service = LeavesWorkBehind()
    orchestrator = make_orchestrator({"highlights": service})

    orchestrator.run_step(PROJECT_ID, "highlights")
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)

    # The step itself is done; its leftover work is still registered so the
    # page keeps polling, but it is not something the pipeline waits on.
    assert f"{PROJECT_ID}_highlights" not in orchestrator.active_processes
    assert f"{PROJECT_ID}_highlights_background" in orchestrator.active_processes
    assert not orchestrator._has_running_step(PROJECT_ID)

    service.release.set()
    assert service.runs[0]["done"].wait(timeout=5)
    assert service.runs[0]["saw_stop"] is False


def test_a_new_run_stops_the_last_runs_background_work(project_root):
    service = LeavesWorkBehind()
    orchestrator = make_orchestrator({"highlights": service})
    orchestrator.run_step(PROJECT_ID, "highlights")
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)

    orchestrator.run_step(PROJECT_ID, "highlights")
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)
    service.release.set()

    first, second = service.runs
    assert first["done"].wait(timeout=5) and first["saw_stop"] is True
    assert second["done"].wait(timeout=5) and second["saw_stop"] is False


def test_a_step_that_cannot_stop_is_left_running(project_root):
    service = BlockingService()
    orchestrator = make_orchestrator({"upload": service})
    write_statuses(project_root, {"transcription": "completed", "highlights": "completed"})
    orchestrator.run_step(PROJECT_ID, "upload")
    service.started.wait(timeout=5)

    assert orchestrator.stop_step(PROJECT_ID, "upload") is False
    assert f"{PROJECT_ID}_upload" in orchestrator.active_processes

    service.release.set()
    orchestrator.active_project_orchestrators[PROJECT_ID].join(timeout=5)

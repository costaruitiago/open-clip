"""The endpoint the project page polls while a pipeline runs.

It is hit every couple of seconds by every open page, and it is the only thing
that reports a running step, so a handler that raises here is silent in the log
— the request line is written before the exception — and shows up only as a
traceback on the server's terminal and an empty reply in the browser. That is
what this covers: the response has to actually come back.
"""

import json
import threading
import urllib.request
from datetime import datetime
from http.server import ThreadingHTTPServer

import pytest

from backend.api import SimpleHandler

PROJECT_ID = "test-project"


@pytest.fixture
def serve(tmp_path, monkeypatch):
    """Serves one project with a rendered clip, at the step statuses given."""
    servers = []

    def start(step_statuses):
        project_dir = tmp_path / "projects" / PROJECT_ID
        project_dir.mkdir(parents=True, exist_ok=True)
        (project_dir / "metadata.json").write_text(json.dumps({
            "project_id": PROJECT_ID,
            "name": "Test Project",
            "created_at": datetime.now().isoformat(),
            "files": {},
            "highlights": [{
                "highlight_text": "And we just lost", "viral_hook_text": "",
                "video_description_for_x": "", "video_description_for_reddit": "",
                "video_description_for_linkedin": "", "video_title_for_youtube_short": "",
                "start": 10.0, "end": 14.0, "is_clip_generated": True,
            }],
            "video_metadata": {"components": [], "top_recommendations": []},
            "settings": {"aspect_ratio": "9:16", "resolution": "1080p"},
            "status": None,
            "step_statuses": step_statuses,
            "step_errors": {},
        }))
        monkeypatch.chdir(tmp_path)

        server = ThreadingHTTPServer(('127.0.0.1', 0), SimpleHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        servers.append((server, thread))
        host, port = server.server_address[:2]
        return f"http://{host}:{port}/project/{PROJECT_ID}/execution_status"

    try:
        yield start
    finally:
        for server, thread in servers:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


@pytest.fixture
def status_url(serve):
    """One project with a rendered clip and a step already finished."""
    return serve({"transcript": "completed", "postiz": "running"})


def test_answers_with_the_project_s_step_statuses(status_url):
    response = urllib.request.urlopen(status_url)
    payload = json.loads(response.read())

    assert response.status == 200
    assert payload["transcript"] == "completed"


def test_carries_the_clock_the_page_measures_elapsed_time_against(status_url):
    """`now` is `time.time()` on the server.

    It went out through a `time` the module never imported, so every poll was a
    NameError: the page got an empty reply and the terminal got a traceback,
    while the log recorded nothing but the request.
    """
    payload = json.loads(urllib.request.urlopen(status_url).read())

    assert isinstance(payload["now"], float)
    assert payload["now"] > 0


def test_reports_what_each_running_step_is_doing(status_url):
    payload = json.loads(urllib.request.urlopen(status_url).read())

    # Nothing is running in a freshly loaded project, but the key is always
    # there: the page reads it without checking, and a missing one is a crash
    # in the browser rather than an empty panel.
    assert payload["activity"] == {}


def test_a_step_left_mid_run_by_a_restart_is_not_reported_as_running(status_url):
    """"running" is written by the step and cleared by the step.

    Anything that stops in between — this process being restarted, a crash, an
    exception raised before the status could be moved — leaves that word on
    disk with nothing running it, and the page then shows a step that never
    finishes and a button offering to stop something that is not there.
    """
    payload = json.loads(urllib.request.urlopen(status_url).read())

    assert payload["postiz"] == "error"
    assert "stopped without finishing" in payload["step_errors"]["postiz"]


def test_a_step_that_failed_says_why(status_url):
    payload = json.loads(urllib.request.urlopen(status_url).read())

    # Always present, like `activity`: the page reads it without checking.
    assert isinstance(payload["step_errors"], dict)


def test_a_partly_done_step_is_reported_as_partial(serve):
    payload = json.loads(urllib.request.urlopen(serve({"upload": "partial"})).read())

    # Passed through rather than folded into "completed" or "error": the page
    # paints it amber and offers to finish it.
    assert payload["upload"] == "partial"


def test_a_partly_done_dependency_does_not_lock_the_steps_after_it(serve):
    # Nineteen of twenty clips cut is nineteen clips' worth of work the next
    # step can do. Locking it would leave the user with nothing rather than
    # with most of it.
    url = serve({"transcription": "completed", "highlights": "partial"})
    payload = json.loads(urllib.request.urlopen(url).read())

    assert payload["upload"] == "todo"
    assert payload["postiz"] == "todo"


def test_a_step_whose_dependency_never_ran_is_still_locked(serve):
    payload = json.loads(urllib.request.urlopen(serve({})).read())

    assert payload["upload"] == "locked"

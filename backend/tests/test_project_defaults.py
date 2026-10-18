"""What a new project starts from.

The application defaults are copied into a project once, at creation, and are
never read again: a project styled and reviewed must not re-style itself
because somebody changed the default a week later. These tests are about that
copy — which settings travel, and what a project falls back to when the
application has nothing to say.
"""

import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from backend.api import SimpleHandler
from backend.src.settings_manager import settings_manager


@pytest.fixture
def server(tmp_path, monkeypatch):
    """The API on a throwaway port, writing projects into `tmp_path`."""
    monkeypatch.chdir(tmp_path)
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), SimpleHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = httpd.server_address[:2]
        yield f"http://{host}:{port}"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


@pytest.fixture
def app_settings(monkeypatch):
    """The application's own settings, replaced wholesale for one test.

    The manager is a module singleton holding what it read at import time, so
    the dictionary is what a test has to stand in front of — chdir alone would
    leave the values from the real settings file in place.
    """
    values = {}
    monkeypatch.setattr(settings_manager, "settings", values)
    return values


def create_project(base_url, body=None):
    """Creates a project through the API and returns what was written for it."""
    request = urllib.request.Request(
        f"{base_url}/project/init",
        data=json.dumps(body or {}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        project_id = json.load(response)["project_id"]
    return json.loads((Path("projects") / project_id / "metadata.json").read_text())


def test_a_new_project_starts_from_the_promoted_overlay_look(server, app_settings):
    app_settings["overlay_defaults"] = {
        "enabled": True,
        "font_family": "Impact",
        "font_size_pct": 9.5,
        "position_pct": 12,
    }

    overlay = create_project(server)["settings"]["overlay"]

    assert overlay["enabled"] is True
    assert overlay["font_family"] == "Impact"
    assert overlay["font_size_pct"] == 9.5
    assert overlay["position_pct"] == 12


def test_a_promoted_overlay_carries_no_words(server, app_settings):
    """A line stored here would be one line over every clip of every project."""
    app_settings["overlay_defaults"] = {"enabled": True, "text": "SUBSCRIBE"}

    assert create_project(server)["settings"]["overlay"]["text"] == ""


def test_a_new_project_draws_no_titles_when_nothing_was_promoted(server, app_settings):
    assert create_project(server)["settings"]["overlay"]["enabled"] is False


def test_a_new_project_starts_from_the_promoted_frame(server, app_settings):
    """The upload screen no longer asks, so the defaults are the whole answer."""
    app_settings["video_defaults"] = {"resolution": "1080p", "aspect_ratio": "9:16"}

    settings = create_project(server)["settings"]

    assert settings["resolution"] == "1080p"
    assert settings["aspect_ratio"] == "9:16"


def test_a_new_project_keeps_the_original_frame_when_nothing_was_promoted(server, app_settings):
    settings = create_project(server)["settings"]

    assert settings["resolution"] == "keep original"
    assert settings["aspect_ratio"] == "keep original"


def test_a_frame_the_upload_screen_sends_is_ignored(server, app_settings):
    """Creation takes the file and nothing else; the frame is a project setting."""
    app_settings["video_defaults"] = {"resolution": "1080p", "aspect_ratio": "9:16"}

    settings = create_project(server, {"resolution": "720p", "aspectRatio": "1:1"})["settings"]

    assert settings["resolution"] == "1080p"
    assert settings["aspect_ratio"] == "9:16"


def test_a_new_project_starts_from_the_promoted_captions(server, app_settings):
    app_settings["caption_defaults"] = {
        "enabled": True,
        "preset": "bold_bottom",
        "overrides": {"font_size_pct": 7},
    }

    captions = create_project(server)["settings"]["captions"]

    assert captions["enabled"] is True
    assert captions["preset"] == "bold_bottom"
    assert captions["overrides"] == {"font_size_pct": 7}

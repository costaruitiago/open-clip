import json
import shutil
import subprocess
import threading
import urllib.error
import urllib.request
from datetime import datetime
from http.server import ThreadingHTTPServer

import pytest

from backend.api import SimpleHandler
from backend.src.dataclasses.data import EndScreenSettings, ProjectSettings
from backend.src.infrastructure.video_engine import (
    append_end_screen,
    has_audio,
    probe_duration,
    probe_video,
)

requires_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg not installed"
)


def _ffmpeg(*args):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True, capture_output=True)


@pytest.fixture
def clip(tmp_path):
    """A 2 second 606x1080 clip with an audio track, like a cut 9:16 short."""
    path = tmp_path / "clip_000.mp4"
    _ffmpeg(
        "-f", "lavfi", "-i", "testsrc2=size=606x1080:rate=30:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", str(path),
    )
    return str(path)


@pytest.fixture
def silent_clip(tmp_path):
    path = tmp_path / "silent.mp4"
    _ffmpeg(
        "-f", "lavfi", "-i", "testsrc2=size=606x1080:rate=30:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path),
    )
    return str(path)


@pytest.fixture
def image(tmp_path):
    """A landscape card, so fitting it into a portrait clip has to letterbox."""
    path = tmp_path / "card.png"
    _ffmpeg("-f", "lavfi", "-i", "color=c=red:s=800x400", "-frames:v", "1", str(path))
    return str(path)


@pytest.fixture
def music(tmp_path):
    """Shorter than the end screen, so it has to be padded out."""
    path = tmp_path / "music.mp3"
    _ffmpeg("-f", "lavfi", "-i", "sine=frequency=220:duration=1", str(path))
    return str(path)


def test_settings_default_off():
    assert ProjectSettings.from_dict({}).end_screen == EndScreenSettings()


def test_settings_clamp_duration_and_drop_junk():
    parsed = EndScreenSettings.from_dict({"enabled": "yes", "image": "", "music": 3, "duration": 99})
    assert parsed == EndScreenSettings(enabled=False, image=None, music=None, duration=20.0)
    assert EndScreenSettings.from_dict({"duration": True}).duration == 5.0


def test_settings_round_trip():
    stored = EndScreenSettings(enabled=True, image="image.png", music="music.mp3", duration=3.5)
    assert EndScreenSettings.from_dict(stored.to_dict()) == stored


@requires_ffmpeg
def test_appends_the_picture_for_its_duration(clip, image):
    append_end_screen(clip, image, 3.0)

    assert probe_duration(clip) == pytest.approx(5.0, abs=0.15)
    assert probe_video(clip)[:2] == (606, 1080)
    assert has_audio(clip)


@requires_ffmpeg
def test_music_shorter_than_the_end_screen_is_padded(clip, image, music):
    append_end_screen(clip, image, 3.0, music)

    assert probe_duration(clip) == pytest.approx(5.0, abs=0.15)


@requires_ffmpeg
def test_a_clip_without_audio_still_gets_an_end_screen(silent_clip, image, music):
    append_end_screen(silent_clip, image, 2.0, music)

    assert probe_duration(silent_clip) == pytest.approx(4.0, abs=0.15)
    assert has_audio(silent_clip)


@requires_ffmpeg
def test_an_unreadable_picture_is_refused_before_rendering(clip, tmp_path):
    before = (tmp_path / "clip_000.mp4").read_bytes()
    broken = tmp_path / "broken.png"
    broken.write_text("not an image")

    with pytest.raises(ValueError):
        append_end_screen(clip, str(broken), 2.0)

    assert (tmp_path / "clip_000.mp4").read_bytes() == before
    assert not (tmp_path / "clip_000.endscreen.mp4").exists()


PROJECT_ID = "end-screen-project"


@pytest.fixture
def api(tmp_path, monkeypatch):
    """A throwaway server over one empty project."""
    project_dir = tmp_path / "projects" / PROJECT_ID
    project_dir.mkdir(parents=True)
    (project_dir / "metadata.json").write_text(json.dumps({
        "project_id": PROJECT_ID,
        "name": "Test Project",
        "created_at": datetime.now().isoformat(),
        "files": {},
        "highlights": [],
        "video_metadata": {"components": [], "top_recommendations": []},
        "settings": {"aspect_ratio": "9:16", "resolution": "1080p"},
        "status": None,
        "step_statuses": {},
    }))
    monkeypatch.chdir(tmp_path)

    server = ThreadingHTTPServer(('127.0.0.1', 0), SimpleHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address[:2]
        yield f"http://{host}:{port}", project_dir
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def call(url, method, body=b"", headers=None):
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read())


def stored_end_screen(project_dir):
    return json.loads((project_dir / "metadata.json").read_text())["settings"]["end_screen"]


def test_upload_stores_the_file_and_points_the_setting_at_it(api):
    base, project_dir = api
    answer = call(f"{base}/project/{PROJECT_ID}/end_screen/image?name=Card.PNG", "POST", b"png bytes")

    assert answer["end_screen"]["image"] == "image.png"
    assert (project_dir / "end_screen" / "image.png").read_bytes() == b"png bytes"
    assert stored_end_screen(project_dir)["image"] == "image.png"


def test_a_replacement_in_another_format_removes_the_old_file(api):
    base, project_dir = api
    call(f"{base}/project/{PROJECT_ID}/end_screen/music?name=a.mp3", "POST", b"mp3")
    call(f"{base}/project/{PROJECT_ID}/end_screen/music?name=b.wav", "POST", b"wav")

    assert sorted(p.name for p in (project_dir / "end_screen").iterdir()) == ["music.wav"]
    assert stored_end_screen(project_dir)["music"] == "music.wav"


def test_a_file_of_the_wrong_kind_is_refused_and_keeps_the_old_one(api):
    base, project_dir = api
    call(f"{base}/project/{PROJECT_ID}/end_screen/image?name=a.png", "POST", b"png")

    with pytest.raises(urllib.error.HTTPError) as excinfo:
        call(f"{base}/project/{PROJECT_ID}/end_screen/image?name=a.mp3", "POST", b"mp3")

    assert excinfo.value.code == 400
    assert (project_dir / "end_screen" / "image.png").exists()
    assert stored_end_screen(project_dir)["image"] == "image.png"


def test_delete_removes_the_file_and_not_the_project(api):
    base, project_dir = api
    call(f"{base}/project/{PROJECT_ID}/end_screen/image?name=a.png", "POST", b"png")

    answer = call(f"{base}/project/{PROJECT_ID}/end_screen/image", "DELETE")

    assert answer["end_screen"]["image"] is None
    assert not (project_dir / "end_screen" / "image.png").exists()
    assert (project_dir / "metadata.json").exists()


def test_settings_patch_cannot_name_a_file(api):
    base, project_dir = api
    call(
        f"{base}/project/{PROJECT_ID}/settings", "PUT",
        json.dumps({"end_screen": {"enabled": True, "duration": 3, "image": "../../secret.png"}}).encode(),
    )

    assert stored_end_screen(project_dir) == {"enabled": True, "image": None, "music": None, "duration": 3.0}

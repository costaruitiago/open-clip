"""Range parsing for the static file route.

A <video> seeks by issuing `Range` requests. If the server answers 200 with the
whole file instead of 206, the browser marks the stream non-seekable and the
scrub bar refuses to move.
"""

import json
import threading
import urllib.error
import urllib.request
from datetime import datetime
from http.server import ThreadingHTTPServer

import pytest

from backend.api import SimpleHandler, UnsatisfiableRange, parse_byte_range

SIZE = 1000
PROJECT_ID = "test-project"
CLIP_BYTES = bytes(range(256)) * 4  # 1024 bytes, every offset distinguishable


@pytest.mark.parametrize("header", [None, ""])
def test_no_range_header_serves_whole_file(header):
    assert parse_byte_range(header, SIZE) is None


def test_closed_range():
    assert parse_byte_range("bytes=100-199", SIZE) == (100, 199)


def test_open_ended_range_runs_to_the_last_byte():
    assert parse_byte_range("bytes=100-", SIZE) == (100, SIZE - 1)


def test_end_past_the_file_is_clamped():
    assert parse_byte_range("bytes=900-5000", SIZE) == (900, SIZE - 1)


def test_suffix_range_takes_the_final_bytes():
    assert parse_byte_range("bytes=-200", SIZE) == (800, SIZE - 1)


def test_suffix_longer_than_the_file_starts_at_zero():
    assert parse_byte_range("bytes=-5000", SIZE) == (0, SIZE - 1)


def test_start_past_the_end_is_unsatisfiable():
    with pytest.raises(UnsatisfiableRange):
        parse_byte_range(f"bytes={SIZE}-", SIZE)


def test_suffix_range_on_an_empty_file_is_unsatisfiable():
    with pytest.raises(UnsatisfiableRange):
        parse_byte_range("bytes=-100", 0)


@pytest.mark.parametrize(
    "header",
    [
        "bytes=0-99,200-299",  # multiple ranges: not supported, send it all
        "items=0-99",  # unit this server does not speak
        "bytes=abc-def",
        "bytes=100",
        "bytes=200-100",  # end before start
        "bytes=-0",
    ],
)
def test_ranges_this_server_does_not_honour_fall_back_to_the_whole_file(header):
    assert parse_byte_range(header, SIZE) is None


@pytest.fixture
def clip_server(tmp_path, monkeypatch):
    """Serves one project containing a source video, on a throwaway port."""
    project_dir = tmp_path / "projects" / PROJECT_ID
    project_dir.mkdir(parents=True)
    (project_dir / "original.mp4").write_bytes(CLIP_BYTES)
    (project_dir / "metadata.json").write_text(json.dumps({
        "project_id": PROJECT_ID,
        "name": "Test Project",
        "created_at": datetime.now().isoformat(),
        "files": {},
        "highlights": [],
        "video_metadata": {"components": [], "top_recommendations": []},
        "settings": {"aspect_ratio": "16:9", "resolution": "1080p"},
        "status": None,
        "step_statuses": {},
    }))
    monkeypatch.chdir(tmp_path)

    server = ThreadingHTTPServer(('127.0.0.1', 0), SimpleHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address[:2]
        yield f"http://{host}:{port}/projects/static/{PROJECT_ID}/original.mp4"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def get(url, headers=None):
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}))


def test_serves_a_partial_response_for_a_range_request(clip_server):
    response = get(clip_server, {"Range": "bytes=100-199"})
    body = response.read()

    assert response.status == 206
    assert response.headers["Content-Range"] == f"bytes 100-199/{len(CLIP_BYTES)}"
    assert response.headers["Content-Length"] == "100"
    assert body == CLIP_BYTES[100:200]


def test_advertises_range_support_on_a_plain_request(clip_server):
    response = get(clip_server)
    body = response.read()

    assert response.status == 200
    assert response.headers["Accept-Ranges"] == "bytes"
    assert response.headers["Content-Length"] == str(len(CLIP_BYTES))
    assert body == CLIP_BYTES


def test_rejects_a_range_that_starts_past_the_end(clip_server):
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        get(clip_server, {"Range": f"bytes={len(CLIP_BYTES)}-"})

    assert excinfo.value.code == 416
    assert excinfo.value.headers["Content-Range"] == f"bytes */{len(CLIP_BYTES)}"

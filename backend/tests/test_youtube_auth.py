"""Cover for the stored YouTube token: what it was granted, and what it lacks.

Plus the consent attempt itself, which has to survive the ordinary way it ends:
a user who closes the tab without finishing.
"""

import json
import socket
import time
from urllib.error import HTTPError
from urllib.request import urlopen

import pytest
from google.oauth2.credentials import Credentials

from backend.src.infrastructure.youtube_auth import (
    SCOPES,
    YoutubeAuthError,
    YoutubeAuthSession,
    normalize_client_config,
    stored_scopes,
    token_status,
)

CLIENT_CONFIG = {
    "installed": {
        "client_id": "client-1",
        "client_secret": "secret-1",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
    }
}


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("localhost", 0))
        return probe.getsockname()[1]

UPLOAD = "https://www.googleapis.com/auth/youtube.upload"
READONLY = "https://www.googleapis.com/auth/youtube.readonly"
FORCE_SSL = "https://www.googleapis.com/auth/youtube.force-ssl"


def write_token(directory, scopes, refresh_token="refresh-1"):
    path = directory / "youtube_credentials.json"
    path.write_text(json.dumps({
        "token": "access-1",
        "refresh_token": refresh_token,
        "token_uri": "https://oauth2.googleapis.com/token",
        "client_id": "client-1",
        "client_secret": "secret-1",
        "scopes": scopes,
    }), encoding="utf-8")
    return path


def test_the_scopes_read_back_are_the_ones_the_token_was_granted(tmp_path):
    # Not the ones the app would ask for today: a token authorised before a
    # scope was added holds fewer, and claiming otherwise only moves the
    # failure to the first call that needs it.
    path = write_token(tmp_path, [UPLOAD])

    assert stored_scopes(path) == [UPLOAD]


def test_a_token_that_names_no_scopes_falls_back_to_the_ones_asked_for(tmp_path):
    path = tmp_path / "youtube_credentials.json"
    path.write_text(json.dumps({"token": "access-1", "refresh_token": "refresh-1"}), encoding="utf-8")

    assert stored_scopes(path) == list(SCOPES)


def test_a_token_without_the_read_scope_is_connected_but_short_of_one(tmp_path):
    # Uploads work on this token. What it cannot do is be asked whether a video
    # has finished processing.
    path = write_token(tmp_path, [UPLOAD, FORCE_SSL])

    status = token_status(path)

    assert status["connected"] is True
    assert status["missing_scopes"] == [READONLY]


def test_a_token_from_before_replacing_is_short_of_the_delete_scope(tmp_path):
    # Still uploads; what it cannot do is take the old video down when a clip
    # is regenerated, so Settings has to ask for the channel to be connected again.
    path = write_token(tmp_path, [UPLOAD, READONLY])

    status = token_status(path)

    assert status["connected"] is True
    assert status["missing_scopes"] == [FORCE_SSL]


def test_a_fully_authorised_token_is_missing_nothing(tmp_path):
    path = write_token(tmp_path, [UPLOAD, READONLY, FORCE_SSL])

    status = token_status(path)

    assert status["connected"] is True
    assert status["missing_scopes"] == []


def test_no_token_at_all_is_not_connected(tmp_path):
    status = token_status(tmp_path / "nothing.json")

    assert status["connected"] is False
    assert "connected" in status["reason"]


@pytest.mark.parametrize("secrets", [
    {"installed": {"client_id": "a", "client_secret": "b"}},
    {"web": {"client_id": "a", "client_secret": "b"}},
    {"client_id": "a", "client_secret": "b"},
    '{"installed": {"client_id": "a", "client_secret": "b"}}',
])
def test_the_shapes_people_paste_are_all_accepted(secrets):
    config = normalize_client_config(secrets)

    assert "installed" in config or "web" in config


def test_something_that_is_not_client_secrets_is_refused():
    with pytest.raises(YoutubeAuthError):
        normalize_client_config({"nothing": "useful"})


def redirect(session, query: str):
    """Plays Google's part: the browser arriving back at the callback."""
    try:
        with urlopen(f"http://localhost:{session.port}/{query}", timeout=2) as answer:
            return answer.status
    except HTTPError as e:
        return e.code


def settle(session, timeout: float = 5):
    deadline = time.monotonic() + timeout
    while session.is_pending() and time.monotonic() < deadline:
        time.sleep(0.02)
    return not session.is_pending()


def started_session(tmp_path, **overrides):
    session = YoutubeAuthSession(
        CLIENT_CONFIG, port=free_port(), token_path=tmp_path / "token.json", **overrides
    )
    session.start()
    return session


def test_the_redirect_google_sends_back_becomes_a_stored_token(tmp_path, monkeypatch):
    session = started_session(tmp_path)
    fetched = {}
    # What the exchange would have produced. `credentials` is read-only on the
    # flow, so it is stood in for rather than assigned.
    creds = Credentials(
        token="access-1", refresh_token="refresh-1",
        token_uri="https://oauth2.googleapis.com/token",
        client_id="client-1", client_secret="secret-1", scopes=list(SCOPES),
    )
    monkeypatch.setattr(
        session._flow, "fetch_token", lambda code=None, **kwargs: fetched.update(code=code)
    )
    monkeypatch.setattr(type(session._flow), "credentials", property(lambda self: creds))

    assert redirect(session, f"?code=the-code&state={session._state}") == 200
    assert settle(session)
    assert fetched["code"] == "the-code"
    assert session.status()["completed"] is True
    assert json.loads((tmp_path / "token.json").read_text())["refresh_token"] == "refresh-1"


def test_a_browser_asking_for_something_else_does_not_end_the_wait(tmp_path):
    # The single `handle_request` this replaced was spent by the first thing to
    # arrive, and a tab asking for its favicon is first often enough.
    session = started_session(tmp_path)

    assert redirect(session, "favicon.ico") == 404

    time.sleep(0.3)
    assert session.is_pending()
    session.cancel()


def test_a_refused_sign_in_is_reported_rather_than_stored(tmp_path):
    session = started_session(tmp_path)

    assert redirect(session, "?error=access_denied") == 200
    assert settle(session)
    assert session.status()["completed"] is False
    assert "access_denied" in session.status()["error"]
    assert not (tmp_path / "token.json").exists()


def test_a_reply_from_some_other_request_is_not_trusted(tmp_path):
    session = started_session(tmp_path)

    assert redirect(session, "?code=the-code&state=not-the-state-we-sent") == 200
    assert settle(session)
    assert session.status()["completed"] is False
    assert session.status()["error"]


def test_a_consent_nobody_finishes_can_be_cancelled(tmp_path):
    # Closing the tab is how this ends most of the time, and the attempt behind
    # it should stop rather than sit on a socket until its deadline.
    port = free_port()
    session = YoutubeAuthSession(
        CLIENT_CONFIG, port=port, token_path=tmp_path / "token.json"
    )
    session.start()
    assert session.is_pending()

    session.cancel()

    assert not session.is_pending()
    assert session.status()["cancelled"] is True
    # Nothing to report: the user did this on purpose.
    assert session.status()["error"] is None
    assert session.status()["completed"] is False


def test_a_second_consent_starts_while_the_first_is_still_waiting(tmp_path):
    # The whole point: pressing the button again opens another window. The
    # first attempt is not in the way and is not something to be told about.
    port = free_port()
    first = YoutubeAuthSession(CLIENT_CONFIG, port=port, token_path=tmp_path / "token.json")
    first.start()

    second = YoutubeAuthSession(CLIENT_CONFIG, port=port, token_path=tmp_path / "token.json")
    url = second.start()

    assert first.is_pending() and second.is_pending()
    # It took a port of its own rather than failing on the busy one, and the
    # URL Google is sent names the port that will actually answer.
    assert second.port != first.port
    assert f"localhost%3A{second.port}" in url or f"localhost:{second.port}" in url

    first.cancel()
    second.cancel()


def test_the_usual_port_is_taken_when_it_is_free(tmp_path):
    # Docker publishes one port, and an attempt on any other is unreachable
    # from the browser, so the preferred one is always tried first.
    port = free_port()
    session = YoutubeAuthSession(CLIENT_CONFIG, port=port, token_path=tmp_path / "token.json")
    session.start()

    assert session.port == port
    session.cancel()


def test_a_consent_left_alone_gives_up_by_itself(tmp_path):
    # Without a deadline an abandoned attempt holds the port until the backend
    # is restarted, and every retry is refused for a tab nobody has open.
    port = free_port()
    session = YoutubeAuthSession(
        CLIENT_CONFIG, port=port, token_path=tmp_path / "token.json", timeout_seconds=0.2
    )
    session.start()

    deadline = time.monotonic() + 5
    while session.is_pending() and time.monotonic() < deadline:
        time.sleep(0.05)

    assert not session.is_pending()
    assert session.status()["completed"] is False
    assert session.status()["error"]


def test_cancelling_a_consent_that_already_ended_does_nothing(tmp_path):
    port = free_port()
    session = YoutubeAuthSession(
        CLIENT_CONFIG, port=port, token_path=tmp_path / "token.json"
    )
    session.start()
    session.cancel()

    session.cancel()

    assert not session.is_pending()


def test_a_port_something_else_holds_does_not_stop_a_consent(tmp_path):
    # Another copy of the backend, or anything at all on that port. The sign-in
    # is what the user asked for; the port is an implementation detail.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
        held.bind(("localhost", 0))
        held.listen(1)
        port = held.getsockname()[1]

        session = YoutubeAuthSession(
            CLIENT_CONFIG, port=port, token_path=tmp_path / "token.json"
        )
        session.start()

        assert session.is_pending()
        assert session.port != port
        session.cancel()

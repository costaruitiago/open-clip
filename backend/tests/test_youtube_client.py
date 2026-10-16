"""Cover for opening the YouTube handle when the stored token no longer works.

A token file on disk is not an authorisation: Google can revoke the refresh
token behind it, and an OAuth client still in Testing expires one after seven
days. The file reads back the same either way, so the only place that learns
about it is the refresh, and what it raises there is what the user is shown.
"""

import json

import pytest
from google.auth.exceptions import RefreshError
from google.oauth2.credentials import Credentials

from backend.src.infrastructure import youtube_client as client_module
from backend.src.infrastructure.youtube_auth import save_credentials, token_status
from backend.src.infrastructure.youtube_client import (
    MissingCredentialsError,
    YoutubeClient,
)

UPLOAD = "https://www.googleapis.com/auth/youtube.upload"


def write_token(directory):
    path = directory / "youtube_credentials.json"
    path.write_text(
        json.dumps(
            {
                "token": "old",
                "refresh_token": "refresh-1",
                "client_id": "client-1",
                "client_secret": "secret-1",
                "token_uri": "https://oauth2.googleapis.com/token",
                "scopes": [UPLOAD],
            }
        )
    )
    return path


def client_whose_delete(raises=None):
    """A client whose `videos().delete().execute()` raises `raises`, or succeeds."""
    class Request:
        def execute(self):
            if raises:
                raise raises

    class Videos:
        def delete(self, id):
            return Request()

    class Service:
        def videos(self):
            return Videos()

    client = YoutubeClient.__new__(YoutubeClient)
    client.service = Service()
    return client


def http_error(status):
    import httplib2
    from googleapiclient.errors import HttpError

    return HttpError(httplib2.Response({"status": status}), b"{}")


def test_deleting_a_video_reports_it_went():
    assert client_whose_delete().delete_video("vid-old") is True


def test_deleting_a_video_that_is_already_gone_is_not_a_failure():
    # Somebody took it down in YouTube Studio first: the outcome asked for.
    assert client_whose_delete(http_error(404)).delete_video("vid-old") is False


def test_any_other_refusal_to_delete_still_raises():
    from googleapiclient.errors import HttpError

    with pytest.raises(HttpError):
        client_whose_delete(http_error(403)).delete_video("vid-old")


class StubCredentials:
    """An expired token that still holds a refresh token, like the real one."""

    valid = False
    expired = True
    refresh_token = "refresh-1"
    scopes = [UPLOAD]

    def __init__(self, error=None):
        self.error = error

    def refresh(self, request):
        if self.error:
            raise self.error
        self.valid = True


def stub_load(monkeypatch, creds):
    monkeypatch.setattr(
        client_module.Credentials,
        "from_authorized_user_file",
        classmethod(lambda cls, path, scopes=None: creds),
    )


def test_a_revoked_token_is_reported_as_something_the_user_can_fix(tmp_path, monkeypatch):
    path = write_token(tmp_path)
    stub_load(
        monkeypatch,
        StubCredentials(
            RefreshError(
                "invalid_grant: Token has been expired or revoked.",
                {"error": "invalid_grant"},
            )
        ),
    )

    with pytest.raises(MissingCredentialsError) as raised:
        YoutubeClient(credentials_path=str(path))

    message = str(raised.value)
    assert "connect the channel again" in message
    # The reason Google gave travels with it, without the tuple it arrived in.
    assert "invalid_grant: Token has been expired or revoked." in message
    assert "{" not in message
    # And the weekly-expiry trap, which is the actual cause when this keeps
    # coming back.
    assert "Testing" in message


def test_a_refused_token_stops_the_page_calling_the_channel_connected(tmp_path, monkeypatch):
    path = write_token(tmp_path)
    stub_load(monkeypatch, StubCredentials(RefreshError("invalid_grant: Token has been revoked.")))

    with pytest.raises(MissingCredentialsError):
        YoutubeClient(credentials_path=str(path))

    status = token_status(path)
    assert status["connected"] is False
    assert "invalid_grant" in status["reason"]

    # And a fresh consent puts it back: the refusal was about the old token.
    save_credentials(Credentials(token="new", refresh_token="refresh-2", scopes=[UPLOAD]), path)
    assert token_status(path)["connected"] is True


def test_a_token_that_refreshes_opens_the_service(tmp_path, monkeypatch):
    path = write_token(tmp_path)
    stub_load(monkeypatch, StubCredentials())
    monkeypatch.setattr(
        client_module.googleapiclient.discovery,
        "build",
        lambda *args, **kwargs: "service",
    )

    client = YoutubeClient(credentials_path=str(path))

    assert client.service == "service"
    assert client.scopes == [UPLOAD]

"""Turn the client secrets a user pastes into Settings into a stored YouTube token.

Every installation needs its own OAuth consent: Google issues the refresh token
to *this* user for *this* OAuth client, so there is nothing that can be shipped
with the project. The user supplies the client secrets for their own Google
Cloud project, consents once in a browser, and the refresh token that comes back
is what `YoutubeClient` uses from then on.

The loopback redirect is used rather than the copy-a-code flow, because Google
shut the out-of-band flow down in 2022. That means the machine running this
backend must be reachable at the redirect port from the browser doing the
consenting, which is the case for a local run and for Docker once the port is
published.

A consent is therefore a small web server, and starting one must never depend on
what an earlier one is doing: pressing the button is what a user does when the
last attempt went nowhere, and being told to deal with that attempt first is
being told to care about the app's bookkeeping. Google accepts any loopback port
for a desktop client, so an attempt that cannot have the usual port simply takes
another and opens its own window. Several can be open at once; the first to come
back wins, the rest expire.

The usual port is still tried first, because it is the one a Docker run
publishes: inside a container an attempt on some other port is not reachable
from the browser at all.
"""

import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

from google.oauth2.credentials import Credentials

logger = logging.getLogger(__name__)

# Upload publishes the video and attaches its thumbnail. Readonly is what lets
# the uploader ask whether YouTube has finished processing a video: a thumbnail
# set while it is still processing is accepted and then overwritten by the one
# YouTube generates, so the set has to wait for an answer only this scope can
# get. A token authorised before this scope was added still uploads; it just
# cannot be told when to attach the picture, and falls back to guessing.
#
# force-ssl is what lets an upload replace a clip's video: the new cut goes up
# and the old video is deleted, which neither of the other two allows.
SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube.force-ssl",
]
DEFAULT_TOKEN_PATH = Path("backend/youtube_credentials/youtube_credentials.json")
DEFAULT_CALLBACK_PORT = 8090
CALLBACK_HOST = os.environ.get("OAUTH_CALLBACK_HOST", "localhost")


class YoutubeAuthError(RuntimeError):
    """Raised when consent cannot be started or completed."""


def normalize_client_config(secrets: Any) -> Dict[str, Any]:
    """Accepts what the Settings box holds and returns a client config dict.

    Google hands out the file with a top-level `installed` or `web` key, but
    people paste all three shapes: the file itself, its inner object, or the
    JSON as a string.
    """
    if isinstance(secrets, str):
        try:
            secrets = json.loads(secrets)
        except json.JSONDecodeError as e:
            raise YoutubeAuthError(f"Client secrets are not valid JSON: {e}")

    if not isinstance(secrets, dict):
        raise YoutubeAuthError("No client secrets configured. Add them in Settings first.")

    if "installed" in secrets or "web" in secrets:
        return secrets
    if "client_id" in secrets and "client_secret" in secrets:
        # The inner object on its own: wrap it back up the way the flow wants.
        return {"installed": secrets}
    raise YoutubeAuthError(
        "Client secrets are missing client_id/client_secret. Download the OAuth "
        "client JSON for a Desktop app from Google Cloud Console and paste it in Settings."
    )


def rejection_path(token_path: Path = DEFAULT_TOKEN_PATH) -> Path:
    """Where a refusal from Google is remembered, beside the token it refused."""
    return token_path.with_name(token_path.name + ".rejected")


def mark_token_rejected(reason: str, token_path: Path = DEFAULT_TOKEN_PATH) -> None:
    """Remembers that Google refused this token, so the page stops calling it connected.

    Whether a refresh token still works is a question only Google can answer,
    and asking costs a network round trip that a status poll every few seconds
    must not make. So the answer is kept from the one moment it is learned —
    the refresh that failed — and the next consent clears it.
    """
    try:
        path = rejection_path(token_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(reason, encoding="utf-8")
    except Exception:
        # Never worth failing an upload over: the upload has already failed,
        # and this only decides how the failure reads on the page.
        logger.warning("Could not record that the YouTube token was refused", exc_info=True)


def token_status(token_path: Path = DEFAULT_TOKEN_PATH) -> Dict[str, Any]:
    """Whether an authorized token exists, and whether it can still be used.

    An expired token with a refresh token is still connected: that is the normal
    resting state, and `YoutubeClient` refreshes it on the next upload.

    Unless Google has already refused to refresh it. That token is a file that
    still reads back perfectly and buys nothing, and reporting it as connected
    is what left a user looking at "Connected" while every upload failed.
    """
    if not token_path.exists():
        return {"connected": False, "reason": "No YouTube account has been connected yet."}
    rejected = rejection_path(token_path)
    if rejected.exists():
        try:
            reason = rejected.read_text(encoding="utf-8").strip()
        except Exception:
            reason = ""
        return {
            "connected": False,
            "expired": True,
            "reason": reason or (
                "The stored authorisation is no longer accepted by Google. "
                "Connect the channel again."
            ),
        }
    try:
        creds = Credentials.from_authorized_user_file(str(token_path), stored_scopes(token_path))
    except Exception as e:
        return {"connected": False, "reason": f"Stored credentials could not be read: {e}"}

    granted = set(creds.scopes or [])
    return {
        "connected": bool(creds.valid or creds.refresh_token),
        "expired": bool(creds.expired),
        "has_refresh_token": bool(creds.refresh_token),
        "account": getattr(creds, "account", None) or None,
        # Not a reason to reconnect on its own — uploads work without it — but
        # it is why a thumbnail may not stick, and the user is the only one who
        # can grant it.
        "missing_scopes": sorted(set(SCOPES) - granted),
    }


def stored_scopes(token_path: Path = DEFAULT_TOKEN_PATH) -> list:
    """The scopes the stored token was actually granted.

    Read from the file rather than assumed to be `SCOPES`: a token authorised
    before a scope was added to this list holds fewer, and telling the
    credentials object it has one Google never issued only moves the failure to
    the first call that needs it.
    """
    try:
        granted = json.loads(token_path.read_text(encoding="utf-8")).get("scopes")
    except Exception:
        granted = None
    return list(granted) if granted else list(SCOPES)


def save_credentials(creds: Credentials, token_path: Path = DEFAULT_TOKEN_PATH) -> Path:
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(creds.to_json(), encoding="utf-8")
    # A refusal is about the token being replaced here, not about this one.
    rejection_path(token_path).unlink(missing_ok=True)
    logger.info(f"Stored YouTube credentials at {token_path}")
    return token_path


CONSENT_PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>{title}</title></head>
<body style="font-family: system-ui, sans-serif; padding: 3rem; text-align: center">
<h1>{title}</h1><p>{message}</p></body></html>"""


class _CallbackHandler(BaseHTTPRequestHandler):
    """Answers the one redirect Google sends back, and remembers what it said."""

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        # Anything without one of these is not the redirect — a browser asking
        # for /favicon.ico, mostly — and must not end the wait.
        if "code" not in query and "error" not in query:
            self.send_error(404)
            return

        self.server.consent_query = {k: v[0] for k, v in query.items()}
        failed = "error" in query
        body = CONSENT_PAGE.format(
            title="Sign-in failed" if failed else "Channel connected",
            message=(
                f"Google returned: {self.server.consent_query['error']}."
                if failed else "You can close this tab and go back to the app."
            ),
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        logger.debug(f"Consent callback: {format % args}")


class _CallbackServer(HTTPServer):
    # The point of the whole class. `run_local_server` in google-auth-oauthlib
    # binds with this off, so the connection one attempt answered keeps the
    # port in TIME_WAIT for about a minute afterwards — and a user retrying a
    # consent they just abandoned is inside that minute every time.
    allow_reuse_address = True

    consent_query: Optional[Dict[str, str]] = None


class YoutubeAuthSession:
    """One consent attempt, held open while the user is in the browser.

    The wait runs on its own thread and the API hands the consent URL to the
    frontend immediately, rather than holding a request open for however long
    the user takes.

    The server is ours rather than `InstalledAppFlow.run_local_server`'s, which
    is a single blocking `handle_request` with no way to stop it: closing the
    tab is the ordinary way a consent ends, and it left the old one waiting for
    a redirect nobody was going to send. Here the wait is a loop with a
    deadline, `cancel` ends it at once, and the port comes back either way.
    """

    # Long enough to find the right Google account and read the consent screen,
    # short enough that an abandoned attempt frees itself.
    DEFAULT_TIMEOUT_SECONDS = 300

    def __init__(self, client_config: Dict[str, Any], port: int = DEFAULT_CALLBACK_PORT,
                 token_path: Path = DEFAULT_TOKEN_PATH,
                 timeout_seconds: Optional[float] = None):
        from google_auth_oauthlib.flow import InstalledAppFlow

        # What it asks for, and what it got. They differ when something else
        # already holds the usual one — an attempt still open in a tab, most
        # often — and the difference is nobody's business but this session's.
        self.preferred_port = port
        self.port = port
        self.token_path = token_path
        self.timeout_seconds = (
            self.DEFAULT_TIMEOUT_SECONDS if timeout_seconds is None else timeout_seconds
        )
        self.error: Optional[str] = None
        self.completed = False
        self.cancelled = False
        self._state: Optional[str] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._flow = InstalledAppFlow.from_client_config(client_config, scopes=SCOPES)

    def _bind(self) -> "_CallbackServer":
        """Opens the server this consent will be answered on.

        Falls back to any free port rather than failing: the usual port being
        busy means an earlier attempt is still open, and that is not a reason
        to refuse this one. Google accepts any loopback port for a desktop
        client, and the redirect URI is built from whatever this returns.
        """
        try:
            return _CallbackServer((CALLBACK_HOST, self.preferred_port), _CallbackHandler)
        except OSError as e:
            logger.info(f"Port {self.preferred_port} is busy ({e}); taking another for this sign-in")
            return _CallbackServer((CALLBACK_HOST, 0), _CallbackHandler)

    def authorization_url(self) -> str:
        # `offline` plus `consent` is what makes Google return a refresh token:
        # without it a re-authorising user gets an access token that dies in an
        # hour and cannot be renewed.
        # No `include_granted_scopes`: it makes Google return every scope this
        # account ever granted the client, and oauthlib then refuses the token
        # exchange with "Scope has changed", so reconnecting never saves a token.
        url, self._state = self._flow.authorization_url(
            access_type="offline", prompt="consent"
        )
        return url

    def start(self) -> str:
        # Bound before the URL is built, not after: the port is only known once
        # it has been taken, and it has to appear in the redirect URI Google is
        # sent — and again, unchanged, when the code is exchanged.
        server = self._bind()
        self.port = server.server_address[1]
        self._flow.redirect_uri = f"http://localhost:{self.port}/"
        url = self.authorization_url()
        # How long a request may sit before the loop gets to look at `_stop`
        # again: the cost of cancelling, and of nothing else.
        server.timeout = 0.2

        def wait_for_consent():
            try:
                query = self._serve_until_redirect(server)
                if query is None:
                    return
                self._finish(query)
            except Exception as e:
                self.error = str(e)
                logger.error(f"YouTube consent failed: {e}")
            finally:
                server.server_close()

        self._thread = threading.Thread(target=wait_for_consent, daemon=True)
        self._thread.start()
        return url

    def _serve_until_redirect(self, server: _CallbackServer) -> Optional[Dict[str, str]]:
        """Waits for Google's redirect, or for whatever ends the wait first."""
        deadline = time.monotonic() + self.timeout_seconds
        while server.consent_query is None:
            if self._stop.is_set():
                logger.info("YouTube consent cancelled")
                return None
            if time.monotonic() >= deadline:
                self.error = (
                    "The sign-in was not completed in time. Start it again when you "
                    "are ready to finish it in the browser."
                )
                logger.info("YouTube consent timed out")
                return None
            # Returns on its own after `server.timeout` when nothing arrives,
            # which is what keeps the two checks above running.
            server.handle_request()
        return server.consent_query

    def _finish(self, query: Dict[str, str]) -> None:
        """Turns Google's redirect into a stored token, or into an error."""
        if "error" in query:
            self.error = f"Google refused the sign-in: {query['error']}"
            logger.warning(self.error)
            return
        if self._state and query.get("state") != self._state:
            # The redirect did not come from the consent this session started.
            self.error = "The sign-in reply did not match the request that started it."
            logger.warning(self.error)
            return

        self._flow.fetch_token(code=query["code"])
        save_credentials(self._flow.credentials, self.token_path)
        self.completed = True

    def cancel(self, timeout: float = 5) -> None:
        """Ends a consent still waiting, and gives the port back."""
        if not self.is_pending():
            return
        self.cancelled = True
        self._stop.set()
        if self._thread:
            self._thread.join(timeout)

    def is_pending(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def status(self) -> Dict[str, Any]:
        return {
            "pending": self.is_pending(),
            "completed": self.completed,
            "cancelled": self.cancelled,
            "error": self.error,
        }

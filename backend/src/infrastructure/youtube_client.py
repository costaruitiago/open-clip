import logging
import os
from pathlib import Path
import googleapiclient.discovery
import googleapiclient.errors
import googleapiclient.http
from google.oauth2.credentials import Credentials
from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from typing import Dict, Any, Optional

from backend.src.infrastructure.youtube_auth import mark_token_rejected, stored_scopes

logger = logging.getLogger(__name__)


# Any of these lets `videos.list` be called for the channel's own uploads.
READ_SCOPES = {
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/youtubepartner",
}


# Any of these lets `videos.delete` remove one of the channel's own uploads.
# Neither upload nor readonly does, so a token from before replacing existed
# has to be authorised again before it can replace anything.
DELETE_SCOPES = {
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/youtubepartner",
}


def _refusal(error: RefreshError) -> str:
    """What Google said, without the tuple it arrives wrapped in.

    `str(RefreshError)` is `('invalid_grant: Token has been expired or revoked.',
    {'error': ...})` — the same sentence twice, inside punctuation that belongs
    to Python. Only the first part is worth showing to somebody deciding what
    to click.
    """
    detail = error.args[0] if error.args else ""
    return str(detail).strip() or "no reason given"


class MissingCredentialsError(Exception):
    """No usable YouTube credentials on disk.

    Its own type because it is the one upload failure the user can fix without
    touching the app: connect the channel and try again. Everything else is a
    server or network fault.
    """


class YoutubeClient:
    """
    Manages the YouTube API service handle and the implementation of upload logic.
    """
    def __init__(self, credentials_path: str = "backend/youtube_credentials/youtube_credentials.json"):
        creds = None
        if os.path.exists(credentials_path):
            # The scopes the token was granted, not the ones the app would ask
            # for today: a token from before the readonly scope existed must
            # still upload rather than be refused for what it lacks.
            creds = Credentials.from_authorized_user_file(
                credentials_path, stored_scopes(Path(credentials_path))
            )

        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                try:
                    creds.refresh(Request())
                except RefreshError as e:
                    # Google refused the refresh token itself: it was revoked,
                    # or it expired because the OAuth client is still in
                    # Testing, where refresh tokens die after seven days. The
                    # file on disk looks fine and says the channel is
                    # connected, so without this the failure arrives as an
                    # opaque invalid_grant from deep inside the auth library.
                    # It is the same fix as having no token at all: authorise
                    # the channel again.
                    message = (
                        "YouTube has rejected the stored authorisation for this channel: "
                        f"{_refusal(e)}. Open Settings and connect the channel again, then "
                        "run this step again. If this keeps happening every week, the OAuth "
                        "client in Google Cloud Console is still in Testing, where refresh "
                        "tokens expire after seven days."
                    )
                    # Remembered on disk, so Settings stops showing this channel
                    # as connected while nothing it does can work.
                    mark_token_rejected(message, Path(credentials_path))
                    raise MissingCredentialsError(message) from e
            else:
                raise MissingCredentialsError(
                    "No usable YouTube credentials. Authorise a channel so "
                    f"{credentials_path} holds a token that can still be refreshed, then upload again."
                )
        
        self.scopes = list(creds.scopes or [])
        self.service = googleapiclient.discovery.build("youtube", "v3", credentials=creds)

    def can_read_processing(self) -> bool:
        """Whether this token may ask YouTube about the channel's own videos."""
        return bool(READ_SCOPES & set(self.scopes))

    def can_delete(self) -> bool:
        """Whether this token may take one of the channel's videos down."""
        return bool(DELETE_SCOPES & set(self.scopes))

    def delete_video(self, video_id: str) -> bool:
        """Removes a video from the channel, for good.

        Returns False when YouTube has no such video — somebody already deleted
        it, which is the outcome asked for rather than a failure. Raises on any
        other refusal.
        """
        try:
            self.service.videos().delete(id=video_id).execute()
        except googleapiclient.errors.HttpError as e:
            if getattr(e.resp, "status", None) == 404:
                logger.info(f"{video_id} is already gone from YouTube; nothing to delete")
                return False
            raise
        return True

    def video_exists(self, video_id: str) -> Optional[bool]:
        """Whether this channel can still see the video behind an id.

        False for one that has been deleted on YouTube — the case this
        application cannot otherwise detect, because nothing tells it when a
        video it published stops existing.

        None when the token cannot answer: without the readonly scope the
        question is a permission error rather than a "no", and treating those
        the same would throw away a perfectly good record.
        """
        if not self.can_read_processing():
            return None
        try:
            response = self.service.videos().list(part="id", id=video_id).execute()
        except Exception:
            # A network failure or a quota refusal is not evidence that the
            # video is gone.
            logger.warning(f"Could not check whether {video_id} still exists", exc_info=True)
            return None
        return bool(response.get("items"))

    def upload_video(
        self,
        file_path: str,
        title: str,
        description: str,
        privacy_status: str = "private",
        publish_at: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Publishes one file, at the privacy the caller asked for.

        `publish_at` is an RFC 3339 timestamp and makes the upload a scheduled
        one: YouTube holds the video private until then and turns it public
        itself. It is only honoured alongside `privacyStatus: private` — a
        video that is already public has nothing left to publish — so the
        privacy is forced back to private rather than sent as a pair YouTube
        would take and silently ignore.
        """
        status: Dict[str, Any] = {"privacyStatus": privacy_status}
        if publish_at:
            status["privacyStatus"] = "private"
            status["publishAt"] = publish_at
        body = {
            "snippet": {"title": title, "description": description},
            "status": status,
        }
        request = self.service.videos().insert(
            part="snippet,status",
            body=body,
            media_body=googleapiclient.http.MediaFileUpload(file_path, chunksize=-1, resumable=True),
        )
        response = None
        while response is None:
            status, response = request.next_chunk()
        video_id = response["id"]
        return {
            "video_id": video_id,
            "url": f"https://youtube.com/watch?v={video_id}",
            # A Short's "Related video" — the chip that sends a viewer to the
            # full episode — cannot be set by this API. `videos.insert` has no
            # field for it, and YouTube exposes it only in Studio, so the URL of
            # the page that does have it travels back with the upload. The link
            # in the description is a separate thing and does not create it.
            "studio_url": f"https://studio.youtube.com/video/{video_id}/edit",
        }

import json
import logging
import time
import uuid
import os
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from dataclasses import asdict
from typing import List, Optional, Tuple
from urllib.parse import urlparse, parse_qs

from backend.src.dataclasses.data import (
    CLIP_PREVIEW_CHOICES,
    LAYOUT_CHOICES,
    CaptionSettings,
    DescriptionSettings,
    HighlightSettings,
    OverlayText,
    as_split_position,
    as_stack_darkness,
    PostizSettings,
    Project,
    ThumbnailSettings,
    UploadSettings,
)
from backend.src.infrastructure.font_metrics import resolve_face
from backend.src.registry import list_projects, delete_project
from backend.src.services.marker_exporter import MarkerExporter, DEFAULT_RECORD_START
from backend.src.services.chapter_exporter import ChapterExporter, NoChaptersError
from backend.src.services.ass_writer import render_ass
from backend.src.infrastructure.youtube_client import MissingCredentialsError
from backend.src.infrastructure.youtube_auth import (
    YoutubeAuthError,
    YoutubeAuthSession,
    normalize_client_config,
    token_status,
)
from backend.src.services.captions import CaptionService
from backend.src.services.thumbnailer import SourceVideoMissingError, Thumbnailer
from backend.src.services.uploader import (
    DEFAULT_PRIVACY,
    UploadInProgressError,
)
from backend.src.infrastructure.postiz_client import (
    MissingPostizCredentialsError,
    PostizClient,
    PostizError,
    normalize_api_url,
)
from backend.src.services.postiz_publisher import (
    NoPostizChannelsError,
    PostizImportInProgressError,
)
from backend.src.services.description_builder import (
    DEFAULT_TEMPLATE,
    FIELD_HELP,
    build_description,
    resolve_template,
)
from backend.src.orchestrator import (
    DONE_STATUSES,
    ClipRegenerationInProgressError,
    PipelineOrchestrator,
    ThumbnailInProgressError,
)
from backend.src.settings_manager import settings_manager

# Generate a unique session ID for this run
SESSION_ID = str(uuid.uuid4())[:8]

# Logging configuration with persistence
log_level_map = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
    "CRITICAL": logging.CRITICAL
}

class SessionFilter(logging.Filter):
    def filter(self, record):
        record.session_id = SESSION_ID
        return True

def setup_logging():
    level_name = settings_manager.get("log_level", "INFO").upper()
    level = log_level_map.get(level_name, logging.INFO)
    
    # Filename format: YYYYMMDD_HHMMSS.log
    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_filename = f"{timestamp_str}.log"
    log_file = Path("backend/logs") / log_filename
    log_file.parent.mkdir(parents=True, exist_ok=True)
    
    formatter = logging.Formatter('%(asctime)s - [%(session_id)s] - %(name)s - %(levelname)s - %(message)s')
    
    file_handler = logging.FileHandler(log_file)
    file_handler.setFormatter(formatter)
    file_handler.addFilter(SessionFilter())
    
    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)
    stream_handler.addFilter(SessionFilter())
    
    root_logger = logging.getLogger()
    root_logger.setLevel(level)
    root_logger.addHandler(file_handler)
    root_logger.addHandler(stream_handler)
    
    # Force level on all existing loggers
    for logger_name in logging.root.manager.loggerDict:
        logging.getLogger(logger_name).setLevel(level)
    
    # Verification
    root_logger.info(f"Logging initialized with level={logging.getLevelName(level)}")

setup_logging()
logger = logging.getLogger(__name__)

# Track active subprocesses (shared state)
active_processes = {}

# Initialize PipelineOrchestrator
pipeline_orchestrator = PipelineOrchestrator(active_processes=active_processes)

# Caption cues and styles are read on every preview request, so this is shared
# rather than built per request.
caption_service = CaptionService()

# The thumbnail settings and the automatic title are read on every clip page,
# so this is shared too. It draws through the caption service above, which is
# what keeps a thumbnail's words styled like the clip's.
thumbnail_service = Thumbnailer(caption_service)

# The consent last started, which is the one the page reports on, and every
# consent still waiting for a browser. More than one can be open at once: a
# user who presses the button again gets another window rather than a refusal,
# and each attempt outlives the request that started it — the browser part
# takes as long as the user does.
youtube_consent: Optional[YoutubeAuthSession] = None
youtube_consents: List[YoutubeAuthSession] = []


def prune_finished_consents() -> None:
    """Drops the attempts that have stopped waiting, however they ended."""
    youtube_consents[:] = [s for s in youtube_consents if s.is_pending()]


class UnsatisfiableRange(Exception):
    """A syntactically valid Range that falls outside the file."""


def parse_byte_range(header: Optional[str], size: int) -> Optional[Tuple[int, int]]:
    """Resolves a Range header to inclusive `(start, end)` byte offsets.

    Returns None when the whole file should be sent: no header, or one this
    server does not honour (multiple ranges, a unit other than bytes, garbage).
    RFC 9110 lets a server ignore any Range it does not understand, and a full
    200 keeps the video playing.

    Raises UnsatisfiableRange for a well-formed range that starts past the end
    of the file, which must be answered with 416 rather than silently served.
    """
    if not header:
        return None

    unit, _, spec = header.partition('=')
    if unit.strip().lower() != 'bytes' or ',' in spec:
        return None

    first, sep, last = spec.strip().partition('-')
    if not sep:
        return None

    try:
        if not first:
            # `bytes=-N`: the final N bytes.
            suffix = int(last)
            if suffix <= 0:
                return None
            if size == 0:
                raise UnsatisfiableRange(header)
            return max(0, size - suffix), size - 1

        start = int(first)
        end = int(last) if last else size - 1
    except ValueError:
        return None

    if start < 0:
        return None
    # Checked before `end < start`: an open-ended range starting past the end
    # resolves to end = size - 1, which would otherwise look merely inverted.
    if start >= size:
        raise UnsatisfiableRange(header)
    if end < start:
        return None

    return start, min(end, size - 1)


class SimpleHandler(BaseHTTPRequestHandler):
    def send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, Range')
        self.send_header('Access-Control-Expose-Headers', 'Content-Disposition')

    def send_json_response(self, data, code=200):
        self.send_response(code)
        self.send_cors_headers()
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        try:
            self.wfile.write(json.dumps(data).encode())
        except (BrokenPipeError, ConnectionResetError):
            logger.warning("Client disconnected before response could be sent")

    def send_cors_error(self, code, message):
        self.send_json_response({"error": message}, code)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors_headers()
        self.end_headers()

    # GET Handlers
    def handle_get_health(self): self.send_json_response({"status": "ok"})
    def handle_get_processes(self): self.send_json_response(list(pipeline_orchestrator.active_processes.keys()))
    def handle_get_config(self): self.send_json_response(pipeline_orchestrator.pipeline_config)
    def handle_get_settings(self):
        logger.info("handle_get_settings called")
        all_settings = settings_manager.get_all()
        logger.info(f"handle_get_settings retrieved: {all_settings.keys()}")
        self.send_json_response({
            "settings": all_settings,
            "pipeline_config": pipeline_orchestrator.pipeline_config
        })

    def handle_get_youtube_status(self):
        """Whether a channel is connected, and what it was allowed to do.

        `missing_scopes` is what the page shows: a token authorised before a
        scope was added still uploads, so this is not a broken connection — it
        is the reason a thumbnail may not survive processing, and reconnecting
        is the only thing that can grant it.
        """
        status = token_status()
        status["has_client_secrets"] = bool(settings_manager.get("youtube_client_secrets"))
        # What an upload makes when a project has no opinion, so the panel on a
        # project can name the default it is following rather than say "the
        # default" and leave the user to go and look it up.
        status["privacy"] = settings_manager.get("youtube_privacy") or DEFAULT_PRIVACY
        if youtube_consent is not None:
            status["consent"] = youtube_consent.status()
        self.send_json_response(status)

    def handle_get_postiz_status(self):
        """Whether Postiz is configured, and what it would import into.

        One request rather than two, because the page asks the same question
        both answer: is this ready to use. `channels` is only present when the
        key works — a listing is the cheapest proof of that — and its absence
        with a `error` is what the settings page shows.
        """
        api_url = settings_manager.get("postiz_api_url")
        status = {
            "configured": bool(settings_manager.get("postiz_api_key")),
            "api_url": normalize_api_url(api_url),
            "selected_channels": settings_manager.get("postiz_channels") or [],
            "post_type": settings_manager.get("postiz_post_type") or "draft",
        }
        if not status["configured"]:
            self.send_json_response(status)
            return

        try:
            status["channels"] = PostizClient().list_integrations()
        except PostizError as e:
            # Not an HTTP error: the question "is Postiz reachable" was
            # answered, and the answer is no. The page draws that.
            status["error"] = str(e)
        except Exception as e:
            logger.exception("Could not read the Postiz channels")
            status["error"] = f"Could not read the Postiz channels: {e}"
        self.send_json_response(status)

    def handle_get_postiz_sync(self):
        """Asks Postiz what became of this project's posts and answers with it.

        A GET that writes, like `/publication` is for YouTube and for the same
        reason: the question and the correction are the same act. Nothing tells
        this application when a draft it filed goes out, so asking is the only
        way a published clip ever stops reading as "waiting in Postiz".
        """
        project_id = self.path.split('/')[2]
        try:
            project = Project(project_id)
        except Exception:
            self.send_cors_error(404, "Project not found")
            return

        publisher = pipeline_orchestrator.services.get("postiz")
        if publisher is None:
            self.send_cors_error(500, "No Postiz service is configured.")
            return

        try:
            self.send_json_response(publisher.sync(project))
        except MissingPostizCredentialsError as e:
            self.send_cors_error(401, str(e))
        except PostizError as e:
            # Postiz being unreachable is not an error of this project's: the
            # records stand, and the page says it could not ask.
            self.send_json_response({"checked": False, "reason": str(e), "clips": {}})
        except Exception as e:
            logger.exception(f"Postiz sync failed for project={project_id}")
            self.send_cors_error(500, f"Could not ask Postiz: {str(e)}")

    def handle_post_youtube_connect(self):
        """Starts a consent and hands back the URL for the user to open.

        The URL is returned rather than opened here: the browser doing the
        consenting is the user's, which for a backend in Docker is not on the
        same machine as this process.
        """
        global youtube_consent
        # An attempt already waiting is left alone. It is not in the way — a
        # new one takes its own port if it has to — and it is not this
        # request's business: pressing the button means open a window, and it
        # opens a window. Whichever attempt comes back first writes the token.
        prune_finished_consents()
        try:
            config = normalize_client_config(settings_manager.get("youtube_client_secrets"))
            session = YoutubeAuthSession(config)
            url = session.start()
        except YoutubeAuthError as e:
            self.send_cors_error(400, str(e))
            return
        except Exception as e:
            logger.exception("Could not start YouTube consent")
            self.send_cors_error(500, f"Could not start the YouTube connection: {str(e)}")
            return
        youtube_consent = session
        youtube_consents.append(session)
        self.send_json_response({"authorization_url": url})

    def handle_post_youtube_cancel(self):
        """Abandons every consent still waiting in a browser."""
        for session in list(youtube_consents):
            session.cancel()
        prune_finished_consents()
        self.send_json_response({"status": "success"})

    def handle_get_projects(self):
        all_projects = []
        for project_id in list_projects():
            try:
                project = Project(project_id)
                all_projects.append(project.to_dict())
            except Exception as e:
                logger.error(f"Failed to load project {project_id}: {e}")
        all_projects.sort(key=lambda x: x['created_at'], reverse=True)
        self.send_json_response(all_projects)

    def handle_get_project_file(self):
        # The path without its query: a re-cut clip keeps its filename, so the
        # browser is sent `?v=<rendered_at>` to stop it replaying the copy it
        # already has. Split off `self.path` raw, that version tag became part
        # of the filename and every regenerated clip 404'd.
        parts = urlparse(self.path).path.split('/')
        project_id = parts[3]
        rel_path = '/'.join(parts[4:])
        try:
            project = Project(project_id)
            if rel_path.startswith('clips/'):
                file_path = Path(project.get_clip_path(rel_path.split('/')[-1]))
            else:
                file_path = Path(project.base_directory) / project_id / rel_path

            if file_path.exists() and file_path.is_file():
                # Thumbnails are served from here too, and an <img> pointed at
                # an octet-stream is a download rather than a picture.
                mime = {
                    '.mp4': 'video/mp4',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.png': 'image/png',
                }.get(file_path.suffix.lower(), 'application/octet-stream')
                size = file_path.stat().st_size
                # Seeking in a <video> is a byte-range request. Without a 206 the
                # browser treats the stream as non-seekable and the scrub bar
                # snaps back to where it was.
                try:
                    span = parse_byte_range(self.headers.get('Range'), size)
                except UnsatisfiableRange:
                    self.send_response(416)
                    self.send_cors_headers()
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return

                if span is None:
                    start, end = 0, size - 1
                    self.send_response(200)
                else:
                    start, end = span
                    self.send_response(206)
                    self.send_header('Content-Range', f'bytes {start}-{end}/{size}')

                self.send_cors_headers()
                self.send_header('Content-type', mime)
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Content-Length', str(end - start + 1) if size else '0')
                self.end_headers()

                remaining = end - start + 1 if size else 0
                with open(file_path, 'rb') as f:
                    f.seek(start)
                    try:
                        while remaining > 0:
                            chunk = f.read(min(65536, remaining))
                            if not chunk:
                                break
                            remaining -= len(chunk)
                            self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        logger.warning("Client disconnected during file transfer")
            else:
                self.send_error(404)
        except Exception as e:
            self.send_error(500, str(e))

    def handle_get_project_detail(self):
        project_id = self.path.split('/')[-1]
        try:
            self.send_json_response(Project(project_id).to_dict())
        except Exception:
            self.send_cors_error(404, "Project not found")

    def handle_get_execution_status(self):
        project_id = self.path.split('/')[2]
        project = Project(project_id)
        
        # Merge file statuses with active processes
        statuses = project.step_statuses.copy()
        
        # Add progress metadata
        total_clips = len(project.highlights)
        generated_clips = len([h for h in project.highlights if h.is_clip_generated])
        statuses["progress"] = {"generated": generated_clips, "total": total_clips}
        # What each running step is doing, and since when. A step that reports
        # nothing still gets an entry with `since` in it, which is what lets the
        # page say how long it has been running rather than only that it is.
        statuses["activity"] = pipeline_orchestrator.activity(project_id)
        # Why the failed steps failed. A red badge on its own sends the user to
        # the backend log for something as ordinary as an API key nobody has
        # filled in; this is the sentence that saves that trip. Only failures
        # carry one, and a step clears its own the moment it runs again.
        step_errors = dict(project.step_errors)
        statuses["step_errors"] = step_errors
        # The clock `since` was taken from. Sent so the page measures elapsed
        # time against the same clock rather than against the browser's, which
        # can be minutes off and would report a step as running for -3 minutes.
        statuses["now"] = time.time()
        
        pipeline_config = pipeline_orchestrator.pipeline_config
        for k in pipeline_orchestrator.active_processes:
            if not k.startswith(f"{project_id}_"):
                continue
            # Matched against the declared steps rather than split on "_": the
            # per-clip jobs (`<id>_clip_3`, `<id>_upload_clip_3`) are not steps,
            # and reading their trailing segment as one put entries like
            # "3": "running" into this payload.
            step_name = k[len(project_id) + 1:]
            if step_name in pipeline_config['steps']:
                statuses[step_name] = "running"

        # A step that says it is running with nothing running it. "running" is
        # written to the file by the step and cleared by the step, so anything
        # that stops in between — the process being restarted, a crash, an
        # exception raised before the status could be moved — leaves that word
        # on disk forever. The page then shows a step that never finishes and
        # whose button offers to stop something that is not there.
        #
        # Corrected on the way out rather than written back: this is a fact
        # about this process, not about the project, and a second backend
        # reading the same project must not decide the first one's work has
        # stopped.
        for step_name in pipeline_config['steps']:
            if statuses.get(step_name) != "running":
                continue
            if f"{project_id}_{step_name}" in pipeline_orchestrator.active_processes:
                continue
            statuses[step_name] = "error"
            step_errors.setdefault(
                step_name,
                "This step stopped without finishing — the server was restarted, or it "
                "fell over. The backend log has the reason. Run it again.",
            )

        # Check dependencies for locked steps. A dependency that finished some
        # of its clips and not the rest counts as met: there is real output to
        # work from, and locking the step behind it would leave the user with
        # nothing to do about a run that mostly worked.
        for step_name, config in pipeline_config['steps'].items():
            if step_name not in statuses or statuses[step_name] == "todo":
                dependencies = config.get('depends_on', [])
                all_deps_met = all(statuses.get(dep) in DONE_STATUSES for dep in dependencies)
                statuses[step_name] = "locked" if not all_deps_met else "todo"

        self.send_json_response(statuses)

    def send_text_attachment(self, text: str, filename: str):
        body = text.encode('utf-8')
        self.send_response(200)
        self.send_cors_headers()
        self.send_header('Content-type', 'text/plain; charset=utf-8')
        self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def safe_project_name(self, project) -> str:
        return "".join(
            c if c.isalnum() or c in "-_" else "_" for c in (project.name or project.project_id)
        )

    def handle_get_markers_edl(self):
        parsed = urlparse(self.path)
        project_id = parsed.path.split('/')[2]
        params = parse_qs(parsed.query)
        record_start = params.get('start', [DEFAULT_RECORD_START])[0]

        try:
            project = Project(project_id)
            exporter = MarkerExporter(record_start=record_start)
            edl = exporter.export(project).read_text(encoding="utf-8")
        except Exception as e:
            logger.error(f"Failed to build EDL for {project_id}: {e}")
            self.send_cors_error(500, f"Failed to build EDL: {str(e)}")
            return

        self.send_text_attachment(edl, f"{self.safe_project_name(project)}_markers.edl")

    def handle_get_chapters(self, extension: str):
        """Serves the chapter list as YouTube text or as a Resolve marker EDL."""
        parsed = urlparse(self.path)
        project_id = parsed.path.split('/')[2]
        params = parse_qs(parsed.query)
        record_start = params.get('start', [DEFAULT_RECORD_START])[0]

        try:
            project = Project(project_id)
            exporter = ChapterExporter(record_start=record_start)
            body = exporter.edl(project) if extension == 'edl' else exporter.youtube(project)
        except NoChaptersError as e:
            logger.warning(f"No chapters to export for {project_id}: {e}")
            self.send_cors_error(404, str(e))
            return
        except Exception as e:
            logger.error(f"Failed to build chapters for {project_id}: {e}")
            self.send_cors_error(500, f"Failed to build chapters: {str(e)}")
            return

        self.send_text_attachment(body, f"{self.safe_project_name(project)}_chapters.{extension}")

    def handle_get_caption_styles(self):
        """The caption presets, which are also the style picker in the UI."""
        self.send_json_response(caption_service.presets())

    def handle_get_caption_font(self):
        """Serves the font file the burn will draw with, for the preview to use.

        The face is resolved from the requested family here rather than taken
        from the request, so this cannot be pointed at an arbitrary file: the
        only thing it will ever return is a font fontconfig matched.
        """
        params = parse_qs(urlparse(self.path).query)
        face = resolve_face(
            params.get('family', [''])[0],
            params.get('bold', ['0'])[0] == '1',
            params.get('italic', ['0'])[0] == '1',
        )
        if not face.path:
            self.send_cors_error(404, "No font file for that family")
            return

        try:
            body = face.path.read_bytes()
        except OSError as e:
            logger.error(f"Could not read font {face.path}: {e}")
            self.send_cors_error(500, "Font could not be read")
            return

        self.send_response(200)
        self.send_cors_headers()
        self.send_header('Content-type', 'font/otf' if face.path.suffix.lower() == '.otf' else 'font/ttf')
        self.send_header('Content-Length', str(len(body)))
        # The file behind a family only changes when fonts are installed, and
        # the page asks for it on every clip card.
        self.send_header('Cache-Control', 'public, max-age=86400')
        self.end_headers()
        self.wfile.write(body)

    def _highlight_from_path(self, position: int):
        """Resolves `/project/<id>/clip/<index>/...` to its project and highlight."""
        project_id = urlparse(self.path).path.split('/')[2]
        index = int(urlparse(self.path).path.split('/')[position])
        project = Project(project_id)
        # The clip grid renders one card per highlight, cut or not, so the index
        # in the URL is a position in `highlights`.
        return project, project.highlights[index], index

    def handle_get_clip_captions(self):
        """Cues and resolved style for one clip, for the in-browser preview."""
        try:
            project, highlight, _ = self._highlight_from_path(4)
        except (IndexError, ValueError):
            self.send_cors_error(404, "No clip at that index")
            return
        except FileNotFoundError:
            self.send_cors_error(404, "Project not found")
            return

        try:
            self.send_json_response(caption_service.preview(project, highlight))
        except Exception as e:
            logger.exception("Failed to build caption preview")
            self.send_cors_error(500, f"Failed to build captions: {str(e)}")

    def handle_get_clip_captions_ass(self):
        """The same captions as a downloadable .ass, for use in an editor."""
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        try:
            project, highlight, index = self._highlight_from_path(4)
        except (IndexError, ValueError):
            self.send_cors_error(404, "No clip at that index")
            return
        except FileNotFoundError:
            self.send_cors_error(404, "Project not found")
            return

        try:
            width = int(params.get('width', ['1080'])[0])
            height = int(params.get('height', ['1920'])[0])
        except ValueError:
            self.send_cors_error(400, "width and height must be numbers")
            return

        style = caption_service.style(project)
        cues = caption_service.cues(project, highlight, style)
        overlay = caption_service.overlay(project, highlight)
        if not cues and overlay is None:
            self.send_cors_error(404, "This clip has no transcribed words to caption")
            return

        self.send_text_attachment(
            # The overlay goes in too: this file is the burn, downloaded, and a
            # title missing from it would make the two disagree in an editor.
            render_ass(cues, style, width, height, overlay),
            f"{self.safe_project_name(project)}_clip_{index:03d}.ass",
        )

    def handle_get_clip_thumbnail(self):
        """One clip's thumbnail: its settings, its automatic title, its image.

        The title comes from here rather than being worked out in the browser,
        for the same reason the caption cues do: the page must show the text
        that will actually be drawn, including the model's hook standing in for
        a clip whose own title was never written.
        """
        try:
            project, highlight, index = self._highlight_from_path(4)
        except (IndexError, ValueError):
            self.send_cors_error(404, "No clip at that index")
            return
        except FileNotFoundError:
            self.send_cors_error(404, "Project not found")
            return

        try:
            payload = thumbnail_service.preview(project, highlight)
        except Exception as e:
            logger.exception("Failed to describe clip thumbnail")
            self.send_cors_error(500, f"Failed to read the thumbnail: {str(e)}")
            return

        path = thumbnail_service.path(project, highlight)
        # Reported as missing when the file is gone, so the page offers to make
        # one rather than pointing an <img> at a 404.
        payload["exists"] = bool(path and path.exists())
        self.send_json_response(payload)

    def handle_post_thumbnail(self):
        """Renders one clip's thumbnail now, with whatever its settings say."""
        parts = urlparse(self.path).path.split('/')
        try:
            project_id, clip_index = parts[2], int(parts[4])
        except (IndexError, ValueError):
            self.send_cors_error(404, "No clip at that index")
            return

        try:
            thumbnail = pipeline_orchestrator.generate_thumbnail(project_id, clip_index)
            self.send_json_response({"status": "success", "thumbnail": thumbnail})
        except FileNotFoundError:
            self.send_cors_error(404, "Project not found")
        except IndexError:
            self.send_cors_error(404, "No clip at that index")
        except SourceVideoMissingError as e:
            self.send_cors_error(409, str(e))
        except ThumbnailInProgressError as e:
            self.send_cors_error(409, str(e))
        except Exception as e:
            logger.exception(f"Thumbnail failed for project={project_id} clip={clip_index}")
            self.send_cors_error(500, f"Could not make the thumbnail: {str(e)}")

    def handle_put_clip_thumbnail(self):
        """One clip's thumbnail settings, or null to go back to the defaults.

        Null is not "no thumbnail": the defaults are the first frame with the
        clip's title on it, which is what a clip nobody has opened publishes.
        """
        parts = urlparse(self.path).path.split('/')
        try:
            project_id, clip_index = parts[2], int(parts[4])
        except (IndexError, ValueError):
            self.send_cors_error(404, "No clip at that index")
            return

        content_length = int(self.headers.get('Content-Length', 0))
        data = json.loads(self.rfile.read(content_length)) if content_length else {}
        try:
            project = Project(project_id)
            highlights = project.highlights
            if clip_index < 0 or clip_index >= len(highlights):
                self.send_cors_error(404, f"No clip at index {clip_index}")
                return

            payload = data.get('thumbnail')
            if isinstance(payload, dict):
                stored = highlights[clip_index].thumbnail
                settings = ThumbnailSettings.from_dict(payload)
                # The rendered file is not the form's to change: a settings
                # save describes the *next* thumbnail, and dropping these would
                # orphan the image already on disk.
                if stored is not None:
                    settings.generated_filename = stored.generated_filename
                    settings.generated_at = stored.generated_at
                highlights[clip_index].thumbnail = settings
            else:
                highlights[clip_index].thumbnail = None

            project.set_property("highlights", highlights)
            self.send_json_response({
                "status": "success",
                # Sanitized on the way back, like the overlay: the form shows
                # the numbers that will be used, not the ones it asked for.
                "thumbnail": (
                    highlights[clip_index].thumbnail.to_dict()
                    if highlights[clip_index].thumbnail
                    else None
                ),
            })
        except FileNotFoundError:
            self.send_cors_error(404, "Project not found")
        except Exception as e:
            logger.exception("Failed to update clip thumbnail")
            self.send_cors_error(500, f"Failed to update the thumbnail: {str(e)}")

    def handle_get_clip_publication(self):
        """Whether this clip's published video is still on YouTube.

        Asked when a clip is opened. Nothing tells this application when a
        video it published is deleted, so without this the clip page offers a
        dead link and a thumbnail button pointed at nothing, indefinitely.

        A video that has gone takes its record with it — see
        `Uploader.verify_publication`. `checked` is false when the question
        could not be asked at all, which is not the same as a "no".
        """
        parts = urlparse(self.path).path.split('/')
        try:
            project_id, clip_index = parts[2], int(parts[4])
        except (IndexError, ValueError):
            self.send_cors_error(404, "No clip at that index")
            return

        try:
            project = Project(project_id)
            if clip_index < 0 or clip_index >= len(project.highlights):
                self.send_cors_error(404, f"No clip at index {clip_index}")
                return

            uploader = pipeline_orchestrator.services.get("upload")
            if uploader is None:
                raise RuntimeError("No upload service is configured.")
            exists = uploader.verify_publication(project, clip_index)
            highlight = Project(project_id).highlights[clip_index]
            self.send_json_response({
                "published": bool(highlight.youtube_video_id),
                "video_id": highlight.youtube_video_id,
                "url": highlight.youtube_url,
                "checked": exists is not None,
            })
        except FileNotFoundError:
            self.send_cors_error(404, f"Project {project_id} not found")
        except MissingCredentialsError:
            # No channel connected: the record is all this application has, and
            # it stands until something can check it.
            project = Project(project_id)
            highlight = project.highlights[clip_index]
            self.send_json_response({
                "published": bool(highlight.youtube_video_id),
                "video_id": highlight.youtube_video_id,
                "url": highlight.youtube_url,
                "checked": False,
            })
        except Exception as e:
            logger.exception("Failed to verify the publication")
            self.send_cors_error(500, f"Failed to verify the publication: {str(e)}")

    def handle_get_clip_description(self):
        """The YouTube description one clip would be uploaded with.

        Rendered on the server rather than in the browser so the preview on the
        clip page and the text the uploader sends come from the same builder.
        """
        try:
            project, highlight, _ = self._highlight_from_path(4)
        except (IndexError, ValueError):
            self.send_cors_error(404, "No clip at that index")
            return
        except FileNotFoundError:
            self.send_cors_error(404, "Project not found")
            return

        try:
            self.send_json_response({
                "description": build_description(project, highlight),
                "template": resolve_template(project),
            })
        except Exception as e:
            logger.exception("Failed to build clip description")
            self.send_cors_error(500, f"Failed to build description: {str(e)}")

    def handle_get_description_fields(self):
        """The placeholders a description template may use, and the shipped default."""
        self.send_json_response({"fields": FIELD_HELP, "default_template": DEFAULT_TEMPLATE})

    def handle_get_aspect_ratios(self):
        with open("backend/config/aspect_ratios.json", "r") as f:
            self.send_json_response(json.load(f))

    def handle_get_resolutions(self):
        with open("backend/config/resolutions.json", "r") as f:
            self.send_json_response(json.load(f))

    def do_GET(self):
        logger.info(f"GET {self.path}")
        if self.path == '/health': self.handle_get_health()
        elif self.path == '/resolutions': self.handle_get_resolutions()
        elif self.path == '/aspect_ratios': self.handle_get_aspect_ratios()
        elif self.path == '/caption_styles': self.handle_get_caption_styles()
        elif self.path == '/description_fields': self.handle_get_description_fields()
        elif self.path.startswith('/caption_font'): self.handle_get_caption_font()
        elif self.path == '/active_processes': self.handle_get_processes()
        elif self.path == '/pipeline/config': self.handle_get_config()
        elif self.path == '/settings': self.handle_get_settings()
        elif self.path == '/youtube/status': self.handle_get_youtube_status()
        elif self.path == '/postiz/status': self.handle_get_postiz_status()
        elif self.path == '/projects': self.handle_get_projects()
        elif self.path.startswith('/projects/static/'): self.handle_get_project_file()
        elif self.path.startswith('/project/') and self.path.endswith('/execution_status'):
            self.handle_get_execution_status()
        elif self.path.startswith('/project/') and urlparse(self.path).path.endswith('/markers.edl'):
            self.handle_get_markers_edl()
        elif self.path.startswith('/project/') and urlparse(self.path).path.endswith('/chapters.edl'):
            self.handle_get_chapters('edl')
        elif self.path.startswith('/project/') and urlparse(self.path).path.endswith('/chapters.txt'):
            self.handle_get_chapters('txt')
        elif self.path.startswith('/project/') and urlparse(self.path).path.endswith('/captions.ass'):
            self.handle_get_clip_captions_ass()
        elif self.path.startswith('/project/') and urlparse(self.path).path.endswith('/captions'):
            self.handle_get_clip_captions()
        elif self.path.startswith('/project/') and urlparse(self.path).path.endswith('/publication'):
            self.handle_get_clip_publication()
        elif self.path.startswith('/project/') and urlparse(self.path).path.endswith('/postiz/sync'):
            self.handle_get_postiz_sync()
        elif self.path.startswith('/project/') and urlparse(self.path).path.endswith('/description'):
            self.handle_get_clip_description()
        elif self.path.startswith('/project/') and urlparse(self.path).path.endswith('/thumbnail'):
            self.handle_get_clip_thumbnail()
        elif self.path.startswith('/project/'):
            self.handle_get_project_detail()
        else: self.send_error(404)

    # POST Handlers
    def handle_post_init(self):
        content_length = int(self.headers.get('Content-Length', 0))
        data = json.loads(self.rfile.read(content_length))
        project = Project()
        # Not asked for at creation. Both are visible in the previews and
        # changeable in Project settings at any point, so making the upload
        # screen ask for them only forced a decision before there was anything
        # to look at. Like every other default here, the value is copied once:
        # a project already reviewed must not re-frame itself because the
        # application default moved.
        video_defaults = settings_manager.get('video_defaults') or {}
        project.settings.resolution = video_defaults.get('resolution') or 'keep original'
        project.settings.aspect_ratio = video_defaults.get('aspect_ratio') or 'keep original'
        # Captions start from the global default, then become the project's own:
        # changing the default later must not re-style clips already reviewed.
        project.settings.captions = CaptionSettings.from_dict(
            data.get('captions') or settings_manager.get('caption_defaults') or {}
        )
        # The title look starts from the global default for the same reason, and
        # is held wordless for the same reason the project setting is: a line
        # stored here would be one line over every clip of every project.
        project.settings.overlay = OverlayText.from_dict({
            **(settings_manager.get('overlay_defaults') or {}),
            "text": "",
        })
        # Anything else — a key from a later version, a typo typed into the
        # settings file — leaves the project on the shipped default rather than
        # reaching the page as a state it cannot draw.
        preview = settings_manager.get('clip_preview_default')
        if preview in CLIP_PREVIEW_CHOICES:
            project.settings.clip_preview = preview
        project.save()
        self.send_json_response({"project_id": project.project_id})

    def handle_post_upload(self):
        project_id = self.path.split('/')[-1]
        project = Project(project_id)
        content_length = int(self.headers.get('Content-Length', 0))
        new_filename = f"original{Path(project.name).suffix or '.mp4'}"
        project_dir = Path(project.base_directory) / project_id
        project_dir.mkdir(parents=True, exist_ok=True)
        file_path = project_dir / new_filename
        
        with open(file_path, 'wb') as f:
            remaining = content_length
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65536))
                if not chunk: break
                f.write(chunk)
                remaining -= len(chunk)

        self.send_json_response({"status": "uploaded", "path": str(file_path)})

    def handle_post_step(self):
        content_length = int(self.headers.get('Content-Length', 0))
        data = json.loads(self.rfile.read(content_length))
        project_id, step, action = data['project_id'], data['step'], data['action']
        
        if step == 'all' and action == 'START':
            pipeline_orchestrator.run_pipeline(project_id)
        elif action == 'START':
            # Set when the user chose to regenerate on Upload: every clip is
            # re-cut and its old YouTube video replaced.
            pipeline_orchestrator.run_step(project_id, step, replace=bool(data.get('regenerate')))
        
        self.send_json_response({"status": "started"})

    def handle_post_upload_clip(self):
        """Cuts one clip afresh and publishes it to YouTube.

        Answers as soon as the job is registered, like the re-cut does and for
        the same reason: publishing now begins with an encode, which outlives a
        browser request. The key returned is what the page watches on
        /active_processes; the outcome is on the highlight when it leaves.

        The refusals that can be known before any of that starts are answered
        here as the sentence the user needs, because the button that reached
        this point shows the response text verbatim.
        """
        parts = urlparse(self.path).path.split('/')
        try:
            project_id, clip_id = parts[2], int(parts[4])
        except (IndexError, ValueError):
            self.send_cors_error(404, "No clip at that index")
            return

        try:
            job = pipeline_orchestrator.upload_clip(project_id, clip_id)
            self.send_json_response({"status": "started", "job": job})
        except FileNotFoundError:
            self.send_cors_error(404, "Project not found")
        except IndexError:
            self.send_cors_error(404, "No clip at that index")
        except (UploadInProgressError, ClipRegenerationInProgressError) as e:
            self.send_cors_error(409, str(e))
        except MissingCredentialsError as e:
            self.send_cors_error(401, str(e))
        except Exception as e:
            logger.exception(f"Upload failed for project={project_id} clip={clip_id}")
            self.send_cors_error(500, f"Upload failed: {str(e)}")

    def handle_post_postiz_clip(self):
        """Cuts one clip afresh and files it in Postiz.

        Answers as soon as the job is registered, like the YouTube upload does
        and for the same reason: the import begins with an encode, which
        outlives a browser request. The key returned is what the page watches on
        /active_processes; the outcome is on the highlight when it leaves.

        Unlike the upload this is not irreversible — what it makes is a draft on
        a calendar the user owns — so there is no confirmation in front of it.
        """
        parts = urlparse(self.path).path.split('/')
        try:
            project_id, clip_id = parts[2], int(parts[4])
        except (IndexError, ValueError):
            self.send_cors_error(404, "No clip at that index")
            return

        try:
            job = pipeline_orchestrator.import_clip_to_postiz(project_id, clip_id)
            self.send_json_response({"status": "started", "job": job})
        except FileNotFoundError:
            self.send_cors_error(404, "Project not found")
        except IndexError:
            self.send_cors_error(404, "No clip at that index")
        except (PostizImportInProgressError, UploadInProgressError,
                ClipRegenerationInProgressError) as e:
            self.send_cors_error(409, str(e))
        except MissingPostizCredentialsError as e:
            self.send_cors_error(401, str(e))
        except NoPostizChannelsError as e:
            self.send_cors_error(400, str(e))
        except PostizError as e:
            self.send_cors_error(502, str(e))
        except Exception as e:
            logger.exception(f"Postiz import failed for project={project_id} clip={clip_id}")
            self.send_cors_error(500, f"Postiz import failed: {str(e)}")

    def handle_post_regenerate_clip(self):
        """Re-cuts one clip with whatever its settings now say.

        Answers as soon as the job is registered rather than when the encode is
        done: an encode outlives a browser request. The key returned is what the
        page watches on /active_processes to know when the new file is there.
        """
        parts = urlparse(self.path).path.split('/')
        try:
            project_id, clip_index = parts[2], int(parts[4])
        except (IndexError, ValueError):
            self.send_cors_error(404, "No clip at that index")
            return

        try:
            job = pipeline_orchestrator.regenerate_clip(project_id, clip_index)
            self.send_json_response({"status": "started", "job": job})
        except FileNotFoundError:
            self.send_cors_error(404, "Project not found")
        except IndexError:
            self.send_cors_error(404, "No clip at that index")
        except ClipRegenerationInProgressError as e:
            self.send_cors_error(409, str(e))
        except Exception as e:
            logger.exception(f"Could not start re-cut for project={project_id} clip={clip_index}")
            self.send_cors_error(500, f"Could not start the render: {str(e)}")

    def handle_put_clip_overlay(self):
        """One clip's own overlay title, or null to put it back on the project's.

        Like the per-clip caption settings, the body is the whole object: the
        editor holds the whole form and saves it, and a patch would say nothing
        about the difference between "no title" and "a title I have not
        finished typing". Null is the lock rather than a delete — a clip that
        wants no title at all unlocks and switches it off, which is the only
        way to say that against a project that has one.
        """
        parts = urlparse(self.path).path.split('/')
        try:
            project_id, clip_index = parts[2], int(parts[4])
        except (IndexError, ValueError):
            self.send_cors_error(404, "No clip at that index")
            return

        content_length = int(self.headers.get('Content-Length', 0))
        data = json.loads(self.rfile.read(content_length)) if content_length else {}
        try:
            project = Project(project_id)
            highlights = project.highlights
            if clip_index < 0 or clip_index >= len(highlights):
                self.send_cors_error(404, f"No clip at index {clip_index}")
                return

            payload = data.get('overlay')
            highlights[clip_index].overlay = (
                OverlayText.from_dict(payload) if isinstance(payload, dict) else None
            )
            project.set_property("highlights", highlights)
            self.send_json_response({
                "status": "success",
                # Sent back sanitized, so the form shows the numbers that will
                # actually be burned rather than the ones it asked for.
                "overlay": (
                    highlights[clip_index].overlay.to_dict()
                    if highlights[clip_index].overlay
                    else None
                ),
                "locked": highlights[clip_index].overlay is None,
            })
        except FileNotFoundError:
            self.send_cors_error(404, "Project not found")
        except Exception as e:
            logger.exception("Failed to update clip overlay")
            self.send_cors_error(500, f"Failed to update overlay text: {str(e)}")

    def handle_put_clip_trim(self):
        """One clip's window: where in the source it starts and where it ends.

        The whole window is sent rather than a nudge, because the editor holds
        both numbers and the user watches them while adjusting. Saving moves the
        highlight only — the cut file, if there is one, still holds the old
        window until the clip is rendered again, which is what the stamp coming
        back is for.
        """
        parts = urlparse(self.path).path.split('/')
        try:
            project_id, clip_index = parts[2], int(parts[4])
        except (IndexError, ValueError):
            self.send_cors_error(404, "No clip at that index")
            return

        content_length = int(self.headers.get('Content-Length', 0))
        data = json.loads(self.rfile.read(content_length)) if content_length else {}
        try:
            project = Project(project_id)
            trimmed = project.trim_highlight(clip_index, data.get('start'), data.get('end'))
            self.send_json_response({
                "status": "success",
                # Sent back as stored, so the editor shows the window that will
                # actually be cut rather than the one it asked for.
                "start": trimmed.get("start"),
                "end": trimmed.get("end"),
                "trimmed_at": trimmed.get("trimmed_at"),
            })
        except FileNotFoundError:
            self.send_cors_error(404, "Project not found")
        except IndexError:
            self.send_cors_error(404, f"No clip at index {clip_index}")
        except ValueError as e:
            # The one error the user can fix from where they are standing, so it
            # is their sentence rather than a 500 and a log line.
            self.send_cors_error(400, str(e))
        except Exception as e:
            logger.exception("Failed to trim clip")
            self.send_cors_error(500, f"Failed to save the trim: {str(e)}")

    def handle_put_project_settings(self):
        parts = self.path.split('/')
        project_id = parts[2]
        content_length = int(self.headers.get('Content-Length', 0))
        data = json.loads(self.rfile.read(content_length))
        try:
            project = Project(project_id)
            if 'resolution' in data:
                project.settings.resolution = data['resolution']
            if 'aspect_ratio' in data:
                project.settings.aspect_ratio = data['aspect_ratio']
            if 'clip_preview' in data:
                # Validated on the way in rather than trusted: this reaches the
                # page as the state every clip player is drawn from.
                project.settings.clip_preview = (
                    data['clip_preview']
                    if data['clip_preview'] in CLIP_PREVIEW_CHOICES
                    else project.settings.clip_preview
                )
            if 'layout' in data and data['layout'] in LAYOUT_CHOICES:
                project.settings.layout = data['layout']
            if 'stack_darkness' in data:
                project.settings.stack_darkness = as_stack_darkness(
                    data['stack_darkness'], project.settings.stack_darkness
                )
            if 'split_position' in data:
                project.settings.split_position = as_split_position(
                    data['split_position'], project.settings.split_position
                )
            for key in ('split_swap', 'split_divider'):
                if isinstance(data.get(key), bool):
                    setattr(project.settings, key, data[key])
            if 'description' in data:
                # Merged, not replaced: the project page saves one field at a
                # time as the user leaves it.
                project.settings.description = DescriptionSettings.from_dict({
                    **project.settings.description.to_dict(),
                    **(data['description'] or {}),
                })
            if 'highlights' in data:
                # Merged like the description, and an explicit null survives it:
                # null is how "follow the application settings" is stored, so a
                # number cleared back to it has to reach the settings object.
                project.settings.highlights = HighlightSettings.from_dict({
                    **project.settings.highlights.to_dict(),
                    **(data['highlights'] or {}),
                })
            if 'postiz' in data:
                # Merged, like the description: the panel saves one field at a
                # time. `channels` survives being set back to null — an explicit
                # null is still a key in the patch, and it is what "follow the
                # application settings" is stored as.
                project.settings.postiz = PostizSettings.from_dict({
                    **project.settings.postiz.to_dict(),
                    **(data['postiz'] or {}),
                })
            if 'upload' in data:
                # Merged like the Postiz block, and for the same reason: the
                # panel saves one field at a time, and an explicit null is how
                # "follow the application settings" is stored — so a key set
                # back to null has to survive the merge rather than be dropped.
                project.settings.upload = UploadSettings.from_dict({
                    **project.settings.upload.to_dict(),
                    **(data['upload'] or {}),
                })
            if 'captions' in data:
                # Merged rather than replaced: the styler sends one changed
                # field at a time as the user drags a slider.
                merged = {**project.settings.captions.to_dict(), **(data['captions'] or {})}
                if isinstance(data['captions'], dict) and 'overrides' in data['captions']:
                    merged['overrides'] = {
                        **project.settings.captions.overrides,
                        **(data['captions']['overrides'] or {}),
                    }
                project.settings.captions = CaptionSettings.from_dict(merged)
            if 'overlay' in data:
                # Merged for the same reason the captions are: the styler saves
                # one field at a time. `box_color` survives being set back to
                # null because an explicit null is still a key in the patch.
                #
                # `text` is dropped rather than merged: this setting is how a
                # title is drawn, not what it says, and a line stored here would
                # be one line over every clip in the project at once.
                patch = {k: v for k, v in (data['overlay'] or {}).items() if k != 'text'}
                project.settings.overlay = OverlayText.from_dict({
                    **project.settings.overlay.to_dict(),
                    **patch,
                    "text": "",
                })
            # The user can change these mid-run, so only the settings field is written.
            project.set_property("settings", project.settings)
            self.send_json_response({"status": "success", "settings": project.settings.to_dict()})
        except Exception as e:
            self.send_cors_error(500, f"Failed to update settings: {str(e)}")

    def handle_put_clip_captions(self):
        """One clip's caption settings, or null to put it back on the project's.

        The body is the whole settings object rather than a patch: a clip is
        either locked (null) or speaking for itself, and a partial update has
        no meaning for the transition between those two states.
        """
        parts = urlparse(self.path).path.split('/')
        project_id, clip_index = parts[2], int(parts[4])
        content_length = int(self.headers.get('Content-Length', 0))
        data = json.loads(self.rfile.read(content_length)) if content_length else {}
        try:
            project = Project(project_id)
            highlights = project.highlights
            if clip_index < 0 or clip_index >= len(highlights):
                self.send_cors_error(404, f"No clip at index {clip_index}")
                return

            payload = data.get('captions')
            highlights[clip_index].captions = (
                CaptionSettings.from_dict(payload) if isinstance(payload, dict) else None
            )
            project.set_property("highlights", highlights)
            self.send_json_response({
                "status": "success",
                "locked": highlights[clip_index].captions is None,
            })
        except Exception as e:
            logger.exception("Failed to update clip captions")
            self.send_cors_error(500, f"Failed to update clip captions: {str(e)}")

    def do_PUT(self):
        logger.info(f"PUT {self.path}")
        path = urlparse(self.path).path
        if path.startswith('/project/') and path.endswith('/captions'):
            self.handle_put_clip_captions()
        elif path.startswith('/project/') and path.endswith('/overlay'):
            self.handle_put_clip_overlay()
        elif path.startswith('/project/') and path.endswith('/thumbnail'):
            self.handle_put_clip_thumbnail()
        elif path.startswith('/project/') and path.endswith('/trim'):
            self.handle_put_clip_trim()
        elif path.startswith('/project/') and path.endswith('/settings'):
            self.handle_put_project_settings()
        else:
            self.send_error(404)

    def do_POST(self):
        logger.info(f"POST {self.path}")
        if self.path == '/project/init': self.handle_post_init()
        elif self.path == '/youtube/connect': self.handle_post_youtube_connect()
        elif self.path == '/youtube/connect/cancel': self.handle_post_youtube_cancel()
        elif self.path.startswith('/project/upload/'): self.handle_post_upload()
        elif self.path == '/project/step': self.handle_post_step()
        elif self.path.endswith('/upload'): self.handle_post_upload_clip()
        elif self.path.endswith('/postiz'): self.handle_post_postiz_clip()
        elif self.path.endswith('/regenerate'): self.handle_post_regenerate_clip()
        elif urlparse(self.path).path.endswith('/thumbnail'): self.handle_post_thumbnail()
        elif self.path == '/settings':
             content_length = int(self.headers.get('Content-Length', 0))
             data = json.loads(self.rfile.read(content_length))
             settings = data.get("settings", {})
             settings_manager.update_batch(settings)
             self.send_json_response({"status": "success"})
        elif self.path == '/settings/log_level':
             content_length = int(self.headers.get('Content-Length', 0))
             data = json.loads(self.rfile.read(content_length))
             new_level = data.get("log_level").upper()
             if new_level in log_level_map:
                 settings_manager.set("log_level", new_level)
                 # Update current logger and all child loggers
                 new_level_const = log_level_map[new_level]
                 logging.getLogger().setLevel(new_level_const)
                 for logger_name in logging.root.manager.loggerDict:
                     logging.getLogger(logger_name).setLevel(new_level_const)
                 self.send_json_response({"status": "success"})
             else:
                 self.send_cors_error(400, "Invalid log level")
        else: self.send_error(404)

    # DELETE Handlers
    def do_DELETE(self):
        logger.info(f"DELETE {self.path}")
        if self.path.startswith('/project/') and '/clip/' in self.path:
            parts = self.path.split('/')
            project_id = parts[2]
            try:
                clip_index = int(parts[4])
            except (IndexError, ValueError):
                self.send_cors_error(400, "Clip index must be a number")
                return
            try:
                project = Project(project_id)
                # The grid lists every highlight, rendered or not, so the index
                # it sends back is a position in `highlights`.
                project.delete_highlight(clip_index)
                self.send_json_response({"status": "deleted"})
            except FileNotFoundError:
                self.send_cors_error(404, f"Project {project_id} not found")
            except IndexError:
                self.send_cors_error(404, f"No clip at index {clip_index}")
            except Exception as e:
                logger.exception("Failed to delete clip")
                self.send_cors_error(500, f"Failed to delete clip: {str(e)}")
        elif self.path.startswith('/project/'):
            project_id = self.path.split('/')[-1]
            if delete_project(project_id):
                self.send_json_response({"status": "deleted"})
            else:
                self.send_error(404, "Project not found")
        else:
            self.send_error(404)


def run():  # pragma: no cover
    httpd = ThreadingHTTPServer(('', 8000), SimpleHandler)
    logger.info(f"Server started on port 8000, session={SESSION_ID}")
    httpd.serve_forever()

if __name__ == '__main__':
    run()

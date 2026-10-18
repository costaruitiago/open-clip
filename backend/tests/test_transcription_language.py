"""Which language transcription tells Whisper the video is in."""

from backend.src.services import transcriber
from backend.src.services.transcriber import transcription_language


def setting(monkeypatch, value):
    monkeypatch.setattr(transcriber.settings_manager, "get", lambda key, default=None: value)


def test_english_when_nothing_is_set(monkeypatch):
    setting(monkeypatch, None)

    assert transcription_language() == "en"


def test_the_chosen_language_is_used(monkeypatch):
    setting(monkeypatch, "pt")

    assert transcription_language() == "pt"


def test_auto_lets_whisper_detect_it(monkeypatch):
    setting(monkeypatch, "auto")

    assert transcription_language() is None

import whisper
from typing import Any

# Small and fast on a CPU. The garbled, mixed-language stretches it used to
# produce came from Whisper guessing the language, which the transcriber now
# states (see `transcription_language`).
DEFAULT_MODEL = "base"


class WhisperClient:
    """
    Manages the Whisper model instance and execution.
    """
    def __init__(self, model_name: str = DEFAULT_MODEL):
        self.model = whisper.load_model(model_name)

    def transcribe(self, file_path: str, **kwargs: Any) -> dict:
        return self.model.transcribe(file_path, **kwargs)

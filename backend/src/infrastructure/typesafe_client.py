"""Client for TypeSafe AI's System One endpoint, where Jev answers typed questions.

Jev does not generate text. It takes a `state` (the text being judged) and a set
of named questions — yes/no (`noul`), `choice` or `score` — and returns a
probability for each. See https://docs.typesafe.ai/api.
"""

import json
import logging
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

DEFAULT_URL = "https://api.typesafe.ai"
DEFAULT_MODEL = "jev-latest"
# Rate limited, overloaded, or a server error: worth one more try. Anything else
# (a bad key, a malformed question) fails the same way every time.
RETRYABLE = {429, 500, 502, 503, 504, 529}


class TypeSafeError(Exception):
    """A System One request that did not produce answers."""


class TypeSafeClient:
    def __init__(self, api_key: str, base_url: Optional[str] = None, model: str = DEFAULT_MODEL,
                 timeout: float = 300.0, retries: int = 2):
        if not api_key:
            raise TypeSafeError("Jev (TypeSafe) API key not found in secrets.")
        self.api_key = api_key
        self.base_url = (base_url or DEFAULT_URL).rstrip("/")
        self.model = model
        self.timeout = timeout
        self.retries = retries

    def system_one(self, state: Any, questions: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
        """Asks every question against one state; returns the response body."""
        body = json.dumps({"model": self.model, "state": state, "questions": questions}).encode()
        delay = 0.5
        for attempt in range(self.retries + 1):
            try:
                return self._post(body)
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:500]
                if e.code not in RETRYABLE or attempt == self.retries:
                    raise TypeSafeError(f"Jev returned {e.code}: {detail}") from e
                wait = float(e.headers.get("retry-after") or delay)
                logger.warning(f"Jev returned {e.code}; retrying in {wait:.1f}s")
            except urllib.error.URLError as e:
                if attempt == self.retries:
                    raise TypeSafeError(f"Could not reach Jev at {self.base_url}: {e.reason}") from e
                wait = delay
                logger.warning(f"Could not reach Jev ({e.reason}); retrying in {wait:.1f}s")
            time.sleep(wait)
            delay = min(delay * 2, 5.0)
        raise TypeSafeError("Jev request failed")  # unreachable: the loop returns or raises

    def _post(self, body: bytes) -> Dict[str, Any]:
        request = urllib.request.Request(
            f"{self.base_url}/v1/systemone",
            data=body,
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            data = json.load(response)
        logger.info(f"Jev answered {len(data.get('answers', {}))} questions, usage={data.get('usage')}")
        return data

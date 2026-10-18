"""Finds highlights with Jev, TypeSafe AI's decision model, in two steps.

1. Moments. The transcript is cut into clip-length windows that start and end
   on sentence boundaries. Jev answers yes/no questions about each one — does
   it hook in the first seconds, does it grab attention, does it stand alone —
   and the windows are taken best first, never two that overlap. The score
   weights those 50/40/10 (`WEIGHTS`), and is also kept relative to the
   video: its best moment 100, its weakest 0.
2. Cut. For each picked moment Jev chooses, among the words near its end, the
   one that runs straight into the clip's first words, so the short loops on
   replay. A loop is what a great short ideally has, not a requirement: when no
   word near the end loops well enough the clip ends where the moment ends, and
   the score is the same either way.

Both steps mirror backend/config/prompts/HIGHLIGHTS.md. Jev only judges; the
titles and descriptions are written afterwards by Gemini. Every window's
scores are saved to `jev_scores.json` beside the project's metadata.

Shaped by a spike on a 75-minute project (2026-10): scoring single sentences
gave fragments with no usable range, while clip-length windows with the text in
the question and the surrounding transcript as state ranked Gemini's own picks
at the top. jev-1.13 leans towards the first option of a Choice, so loop
options are asked in both orders and averaged.
"""

import json
import logging
import re
from typing import Any, Dict, List, Optional

from backend.src.dataclasses.data import Project
from backend.src.infrastructure.progress import raise_if_stopped, report
from backend.src.infrastructure.typesafe_client import TypeSafeClient
from backend.src.services.highlight_options import HighlightOptions

logger = logging.getLogger(__name__)

SCORES_FILE = "jev_scores.json"

# Sentences: split on end punctuation, on a long silence, or at a word cap so a
# transcript without punctuation still splits.
PAUSE_SPLIT = 1.5
MAX_SENTENCE_WORDS = 40

# Window lengths, as fractions of the way from the project's minimum duration to
# its maximum. With the shipped 18–110 s this is about 27, 46 and 69 s.
LENGTH_FRACTIONS = (0.1, 0.3, 0.55)
WINDOW_STRIDE = 2  # sentences between window starts

# Transcript sent as shared context per request, and the most question text
# one request carries (about 37k tokens, under Jev's 64k per-request limit).
SECTION_SENTENCES = 200
MAX_REQUEST_CHARS = 150_000

# What the hook question sees: about the first two to three seconds of speech,
# which is the stretch that decides whether a viewer swipes away.
OPENING_WORDS = 10
LOOP_OPENING_WORDS = 8  # what each loop option shows after its last word
LOOP_SEARCH_BEFORE, LOOP_SEARCH_AFTER = 20.0, 5.0  # seconds around the moment's end
LOOP_MAX_OPTIONS = 254  # a Choice takes 255; one is "none"
# How sure Jev must be before a clip is cut on its loop word instead of where
# the moment naturally ends.
LOOP_MIN_PROBABILITY = 0.4
NO_LOOP = "none"

# What makes a good short, one yes/no question each. They follow
# backend/config/prompts/HIGHLIGHTS.md (hook, complete arc, and the traits it
# prefers) and what short-form research agrees on: the first seconds decide
# whether a viewer stays, a hook has to pay off, a clip is watched by people
# who never saw the rest of the video, and surprise and strong opinion are
# what get a clip watched and shared.
HOOK = (
    "These are the first words of a short video:\n\"{opening}\"\n\n"
    "Would these first words make a viewer scrolling a feed stop and keep watching?"
)
STANDALONE = (
    "Short video clip:\n\"{text}\"\n\n"
    "Could a viewer who has seen nothing else of the video follow this clip, without needing "
    "anything that was said before it?"
)
ATTENTION = (
    "Short video clip:\n\"{text}\"\n\n"
    "Is this clip surprising, a strong opinion, funny, tense or emotional, rather than routine talk?"
)
LOOP = (
    "A short video replays in a loop: straight after its last word it starts again from its first "
    "words. Each option shows a possible last word followed by the video's first words, as a viewer "
    "hears the replay. Which option reads as one continuous, natural phrase, so the replay sounds "
    "like a single sentence rather than a restart?"
)


def build_sentences(entries: List[Any]) -> List[Dict[str, Any]]:
    """Groups word-map entries into sentences, keeping each word's index."""
    sentences: List[Dict[str, Any]] = []
    current: List[int] = []

    def close():
        if current:
            sentences.append({
                "first": current[0],
                "last": current[-1],
                "start": entries[current[0]].start,
                "end": entries[current[-1]].end,
                "text": " ".join(entries[i].word for i in current),
            })
            current.clear()

    for index, entry in enumerate(entries):
        if current and entry.start - entries[current[-1]].end > PAUSE_SPLIT:
            close()
        current.append(index)
        if re.search(r"[.?!]$", entry.word) or len(current) >= MAX_SENTENCE_WORDS:
            close()
    close()
    return sentences


def build_windows(sentences: List[Dict[str, Any]], min_duration: float,
                  max_duration: float) -> List[Dict[str, Any]]:
    """Every candidate clip: runs of whole sentences of a few target lengths."""
    targets = [min_duration + (max_duration - min_duration) * f for f in LENGTH_FRACTIONS]
    seen, windows = set(), []
    for target in targets:
        for i in range(0, len(sentences), WINDOW_STRIDE):
            j = i
            while j < len(sentences) - 1 and sentences[j]["end"] - sentences[i]["start"] < target:
                j += 1
            length = sentences[j]["end"] - sentences[i]["start"]
            if not min_duration <= length <= max_duration or (i, j) in seen:
                continue
            seen.add((i, j))
            windows.append({
                "id": f"w{i}_{j}",
                "first_sentence": i,
                "last_sentence": j,
                "start": sentences[i]["start"],
                "end": sentences[j]["end"],
                "text": " ".join(s["text"] for s in sentences[i:j + 1]),
            })
    return windows


# How much each answer counts toward a clip's score. Weighted toward what
# decides whether a short is watched at all: the first seconds, then whether it
# grabs attention.
WEIGHTS = {"hook": 0.5, "attention": 0.4, "standalone": 0.1}

# A raw answer at or above this earns the clip a tag on its card.
TAG_THRESHOLD = 0.8
TAGS = {"hook": "great_hook", "attention": "attention_grabber", "standalone": "stands_alone"}


def combined_score(parts: Dict[str, float]) -> float:
    """The clip's score: its answers weighted by `WEIGHTS`.

    The loop is not one of them. Whether a clip loops decides where it is cut,
    as something a great short ideally has, not how good the moment is.
    """
    return sum(WEIGHTS[name] * value for name, value in parts.items())


def tags_for(parts: Dict[str, float]) -> List[str]:
    """The qualities this clip is outstanding at, by raw answer."""
    return [TAGS[name] for name, value in parts.items() if value >= TAG_THRESHOLD]


def relative_scores(moments: List[Dict[str, Any]]) -> None:
    """Sets each moment's score relative to this video: its best is 1, its weakest 0.

    Jev answers judgement questions cautiously, so even a video's best moment
    rarely scores above 0.6 raw. Stretched across the video, the number says
    where a clip stands among this video's moments, which is the comparison
    the user is making.
    """
    if not moments:
        return
    low = min(m["score"] for m in moments)
    high = max(m["score"] for m in moments)
    for moment in moments:
        moment["relative"] = (moment["score"] - low) / (high - low) if high > low else 1.0


def _overlaps(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    return min(a["end"], b["end"]) > max(a["start"], b["start"])


def select_moments(windows: List[Dict[str, Any]], min_clips: int, max_clips: int,
                   min_score: float = 0.0) -> List[Dict[str, Any]]:
    """Best first, never two that overlap, `min_clips` to `max_clips` of them.

    `min_score` stops the list early, but never below `min_clips`: the project
    asked for at least that many.
    """
    picked: List[Dict[str, Any]] = []
    for window in sorted(windows, key=lambda w: -w["score"]):
        if len(picked) >= max_clips:
            break
        if window["score"] < min_score and len(picked) >= min_clips:
            break
        if not any(_overlaps(window, p) for p in picked):
            picked.append(window)
    return sorted(picked, key=lambda w: w["start"])


def _questions_for(window: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    opening = " ".join(window["text"].split()[:OPENING_WORDS])
    text = window["text"]
    return {
        "hook": {"type": "noul", "instructions": HOOK.format(opening=opening)},
        "standalone": {"type": "noul", "instructions": STANDALONE.format(text=text)},
        "attention": {"type": "noul", "instructions": ATTENTION.format(text=text)},
    }


class JevHighlighter:
    def __init__(self, client: TypeSafeClient):
        self.client = client
        self.entries: List[Any] = []

    def find_moments(self, project: Project, options: HighlightOptions) -> List[Dict[str, Any]]:
        """Every non-overlapping moment, scored, in time order, cut at its natural end.

        All of them, not just the best: which ones count as the project's clips
        is the cutoff's decision (see `highlight_options.selected_indices`), and
        the cutoff can move after the run.
        """
        self.entries = project.word_map.entries
        sentences = build_sentences(self.entries)
        windows = build_windows(sentences, options.min_duration, options.max_duration)
        if not windows:
            raise ValueError("The transcript has no stretch long enough for a clip.")

        self._score_windows(sentences, windows)
        moments = select_moments(windows, 0, len(windows))
        relative_scores(moments)
        for moment in moments:
            moment.update(
                first_word=sentences[moment["first_sentence"]]["first"],
                last_word=sentences[moment["last_sentence"]]["last"],
                cut_end=moment["end"],
                loop={"loop": None, "loop_used": False},
            )
        self._save_scores(project, windows, moments)
        return moments

    def payload(self, moment: Dict[str, Any], run_id: str) -> Dict[str, Any]:
        """One moment as a highlight payload: text, start, end and Jev's scores."""
        words = self.entries[moment["first_word"]:moment["last_word"] + 1]
        return {
            "highlight_text": " ".join(e.word for e in words),
            "start": moment["start"],
            "end": moment["cut_end"],
            # `run` ties the highlight to the run that made it, so the titles
            # and cuts of a run that has been replaced never land on the new one.
            "jev_scores": {
                **moment["parts"],
                "score": moment["score"],
                "relative": moment["relative"],
                "tags": tags_for(moment["parts"]),
                **moment["loop"],
                "run": run_id,
            },
        }

    def _score_windows(self, sentences, windows) -> None:
        """Asks every window's questions, one request per transcript section."""
        # Built first and sent after, so progress can say "request 3 of 13".
        requests = []
        for s0 in range(0, len(sentences), SECTION_SENTENCES):
            state = {"transcript_section": "\n".join(s["text"] for s in sentences[s0:s0 + SECTION_SENTENCES])}
            batch, size = {}, len(state["transcript_section"])
            for window in (w for w in windows if s0 <= w["first_sentence"] < s0 + SECTION_SENTENCES):
                for name, question in _questions_for(window).items():
                    if batch and size + len(question["instructions"]) > MAX_REQUEST_CHARS:
                        requests.append((state, batch))
                        batch, size = {}, len(state["transcript_section"])
                    batch[f"{window['id']}__{name}"] = question
                    size += len(question["instructions"])
            if batch:
                requests.append((state, batch))

        answers: Dict[str, float] = {}
        for number, (state, batch) in enumerate(requests, 1):
            report(f"Jev is scoring {len(windows)} candidate clips — request {number} of {len(requests)}")
            answers.update(self._ask(state, batch))

        for window in windows:
            names = WEIGHTS.keys()
            window["parts"] = {name: answers[f"{window['id']}__{name}"] for name in names}
            window["score"] = combined_score(window["parts"])

    def _ask(self, state, questions) -> Dict[str, float]:
        # Checked before every request, so a stopped run stops paying for Jev.
        raise_if_stopped()
        data = self.client.system_one(state, questions)
        return {key: answer["noul"] for key, answer in data["answers"].items()}

    def choose_cut(self, moment, options: HighlightOptions) -> None:
        """Picks the loop word for one moment, or keeps its natural end."""
        entries = self.entries
        first_word = moment["first_word"]
        opening = " ".join(e.word for e in entries[first_word:first_word + LOOP_OPENING_WORDS])
        candidates: Dict[str, int] = {}
        for index in range(first_word + 1, len(entries)):
            entry = entries[index]
            if entry.end < moment["end"] - LOOP_SEARCH_BEFORE:
                continue
            if entry.end > moment["end"] + LOOP_SEARCH_AFTER or len(candidates) >= LOOP_MAX_OPTIONS:
                break
            if options.min_duration <= entry.end - moment["start"] <= options.max_duration:
                candidates[f"w{index}"] = index
        if not candidates:
            return

        keys = list(candidates)
        shown = {k: f'"{entries[candidates[k]].word} {opening}"' for k in keys}
        none_text = "None of these reads as one continuous phrase."
        state = {"video_clip": moment["text"]}
        raise_if_stopped()
        data = self.client.system_one(state, {
            "forward": {"type": "choice", "instructions": LOOP,
                        "criteria": {**shown, NO_LOOP: none_text}},
            "reversed": {"type": "choice", "instructions": LOOP,
                         "criteria": {**{k: shown[k] for k in reversed(keys)}, NO_LOOP: none_text}},
        })
        forward = data["answers"]["forward"]["probabilities"]
        backward = data["answers"]["reversed"]["probabilities"]
        probability = {k: (forward.get(k, 0.0) + backward.get(k, 0.0)) / 2 for k in [*keys, NO_LOOP]}
        best = max(keys, key=lambda k: probability[k])

        moment["loop"] = {"loop": probability[best], "loop_used": False}
        if probability[best] >= LOOP_MIN_PROBABILITY and probability[best] > probability[NO_LOOP]:
            index = candidates[best]
            moment.update(last_word=index, cut_end=entries[index].end)
            moment["loop"]["loop_used"] = True

    def _save_scores(self, project: Project, windows, moments) -> None:
        path = project.metadata_path().parent / SCORES_FILE
        payload = {
            "windows": [
                {k: w[k] for k in ("start", "end", "score", "parts")} for w in windows
            ],
            # The non-overlapping moments that became highlights; their loop
            # cuts are recorded on the highlights as they are chosen.
            "moments": [
                {"start": m["start"], "end": m["end"], "score": m["score"], "relative": m["relative"]}
                for m in moments
            ],
        }
        path.write_text(json.dumps(payload, indent=1), encoding="utf-8")

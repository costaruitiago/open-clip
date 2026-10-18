"""What a running step is doing, in one sentence at a time.

A step reports "running" from the moment it is triggered until it ends, which
for the LLM steps can be several minutes of one HTTP request. Nothing about
that is visible: an overloaded model being retried for the fourth time and a
request that will never return look identical from the outside, and both look
like the application has hung.

This is the channel that carries the difference. Code deep inside a step calls
`report`; the orchestrator, which is the only thing that knows which step is
running, collects what comes out and hands it to `/execution_status`.

Deliberately a thread-local rather than a parameter threaded through every
call: the reporters are leaves — a retry inside an SDK wrapper — and the
collector is the thread that started the step. Passing a sink from one to the
other would mean a progress argument on every function between them, most of
which have nothing to do with progress. A report from a thread the step
spawned itself is dropped rather than misfiled, because nothing here can know
which step that thread belongs to.

Nothing is ever raised at the caller: a step must not fail because its
narration did.
"""

import logging
import threading
from contextlib import contextmanager
from typing import Callable, Iterator, Optional

logger = logging.getLogger(__name__)

_local = threading.local()

Sink = Callable[[str], None]


@contextmanager
def reporting_to(sink: Sink) -> Iterator[None]:
    """Sends everything `report`ed on this thread to `sink` for the duration.

    Restores whatever was in place before, so a nested run — a step that calls
    another — hands the channel back rather than leaving it pointing at a
    collector that has already finished.
    """
    previous: Optional[Sink] = getattr(_local, "sink", None)
    _local.sink = sink
    try:
        yield
    finally:
        _local.sink = previous


class StepStopped(Exception):
    """Raised inside a step that noticed it was stopped, to end it early."""


@contextmanager
def stoppable(event: threading.Event) -> Iterator[None]:
    """Lets code on this thread ask, through `stop_requested`, whether `event` is set.

    A Python thread cannot be killed, so stopping a step means telling it: the
    orchestrator sets the event, and the step checks before anything it would
    regret doing after the user pressed stop — paying for another request, or
    writing a result over the run that replaced it.
    """
    previous: Optional[threading.Event] = getattr(_local, "stop_event", None)
    _local.stop_event = event
    try:
        yield
    finally:
        _local.stop_event = previous


def stop_requested() -> bool:
    """Whether the step running on this thread has been stopped."""
    event: Optional[threading.Event] = getattr(_local, "stop_event", None)
    return bool(event and event.is_set())


def raise_if_stopped() -> None:
    if stop_requested():
        raise StepStopped()


def report(message: str) -> None:
    """Says what is happening now, replacing whatever was last said.

    One line, written for the person watching the pipeline: which model, what
    went wrong, what happens next. Not a log line — those go to the log.
    """
    sink: Optional[Sink] = getattr(_local, "sink", None)
    if sink is None:
        # Nothing is collecting: a CLI run, a test, or a thread the step
        # started for itself. The message is not worth a warning.
        return
    try:
        sink(message)
    except Exception:
        logger.debug("Could not record step progress", exc_info=True)

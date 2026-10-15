"""Keep one Whisper model resident between transcriptions and unload it when idle.

One slot holds one model, rather than a dict of every model ever asked for,
because the Go backend runs transcriptions in one sequential loop. A second
resident model would never be reused and each one costs gigabytes of VRAM.
"""

from contextlib import contextmanager
from typing import Iterator
import gc
import os
import threading
import time

from .fasterwhisper import FasterWhisperBackend

DEFAULT_IDLE_TIMEOUT = 300.0

_lock = threading.Lock()
_key: tuple[str, str] | None = None
_backend: FasterWhisperBackend | None = None
_leases: int = 0
_idle_since: float | None = None
_reaper: threading.Thread | None = None


def _idle_timeout() -> float:
    raw = os.environ.get("MODEL_IDLE_TIMEOUT")
    if raw is None:
        return DEFAULT_IDLE_TIMEOUT
    try:
        return float(raw)
    except ValueError:
        print(f"MODEL_IDLE_TIMEOUT={raw!r} is not a number, using {DEFAULT_IDLE_TIMEOUT:g}s", flush=True)
        return DEFAULT_IDLE_TIMEOUT


def _release(backend: FasterWhisperBackend) -> None:
    backend.model = None
    gc.collect()
    if backend.device == "cuda":
        # Also returns what the diarization pipeline left in torch's caching
        # allocator, which runs on the same device and is dropped per call.
        try:
            import torch
            torch.cuda.empty_cache()
        except Exception:
            pass


def _load(model_size: str, device: str) -> FasterWhisperBackend:
    print(f"Loading model {model_size} on {device}...", flush=True)
    backend = FasterWhisperBackend(model_size=model_size, device=device)
    backend.get_model()
    backend.load()
    return backend


def _reap_forever(timeout: float) -> None:
    global _key, _backend, _idle_since
    interval = max(1, min(30, timeout))
    while True:
        time.sleep(interval)
        with _lock:
            if _backend is None or _leases > 0 or _idle_since is None:
                continue
            if time.monotonic() - _idle_since < timeout:
                continue
            backend, key = _backend, _key
            _key = None
            _backend = None
            _idle_since = None
            print(f"Unloading model {key[0]} on {key[1]} after {timeout:g}s idle", flush=True)
            # Released under the lock, so two models are never resident at once.
            _release(backend)


def _ensure_reaper() -> None:
    global _reaper
    if _reaper is not None:
        return
    # Read at call time, not at import time, because main.py calls load_dotenv()
    # after its imports have already run.
    timeout = _idle_timeout()
    if timeout <= 0:
        return
    _reaper = threading.Thread(target=_reap_forever, args=(timeout,), daemon=True)
    _reaper.start()


@contextmanager
def lease(model_size: str, device: str) -> Iterator[FasterWhisperBackend]:
    """Yield a loaded backend, reusing the resident model when it is the right one."""
    global _key, _backend, _leases, _idle_since

    with _lock:
        _ensure_reaper()
        if _key == (model_size, device) and _backend is not None:
            backend = _backend
            cached = True
            _leases += 1
            _idle_since = None
        elif _leases == 0:
            if _backend is not None:
                evicted, stale = _key, _backend
                _key = None
                _backend = None
                _idle_since = None
                print(f"Unloading model {evicted[0]} on {evicted[1]} to load {model_size}", flush=True)
                _release(stale)
            backend = _load(model_size, device)
            cached = True
            _key = (model_size, device)
            _backend = backend
            _leases = 1
            _idle_since = None
        else:
            # Another model is mid-transcription and must not be evicted, so this
            # one stays out of the slot and is freed as soon as the caller is done.
            backend = _load(model_size, device)
            cached = False

    try:
        yield backend
    finally:
        with _lock:
            if cached:
                _leases -= 1
                if _leases == 0:
                    _idle_since = time.monotonic()
            else:
                _release(backend)

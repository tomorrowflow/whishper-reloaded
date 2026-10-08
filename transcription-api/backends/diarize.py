import numpy as np
from typing import Optional

# Pre-import torch/torchvision at module load so they are fully initialized
# before pyannote.audio lazily imports them, which would otherwise trigger a
# circular-import error ("partially initialized module 'torchvision'...").
try:
    import torch
    import torchvision  # noqa: F401
except ImportError:
    pass


def assign_speakers(
    audio: np.ndarray,
    segments: list,
    hf_token: str,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
    device: str = "cpu",
) -> list:
    """Run pyannote diarization and assign a speaker label to every segment."""
    try:
        import torch
        from pyannote.audio import Pipeline
    except ImportError:
        print("pyannote.audio not installed — skipping diarization")
        return segments

    if not hf_token:
        print("HF_TOKEN not set — skipping diarization")
        return segments

    try:
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token,
        )
        target_device = torch.device("cuda" if device == "cuda" else "cpu")
        pipeline.to(target_device)

        # pyannote expects a float32 mono waveform tensor: shape (1, T)
        waveform = torch.from_numpy(audio).unsqueeze(0).float()
        kwargs: dict = {}
        if min_speakers is not None:
            kwargs["min_speakers"] = min_speakers
        if max_speakers is not None:
            kwargs["max_speakers"] = max_speakers

        diarization = pipeline(
            {"waveform": waveform, "sample_rate": 16000},
            **kwargs,
        )

        # Resolve to an Annotation regardless of pyannote version.
        # pyannote 3.x returns Annotation directly; some builds wrap it.
        if hasattr(diarization, "itertracks"):
            annotation = diarization
        elif hasattr(diarization, "diarization"):
            annotation = diarization.diarization
        elif hasattr(diarization, "annotation"):
            annotation = diarization.annotation
        else:
            annotation = diarization[0]
        turns = [
            (turn.start, turn.end, speaker)
            for turn, _, speaker in annotation.itertracks(yield_label=True)
        ]

        for seg in segments:
            speaker = _dominant_speaker(float(seg["start"]), float(seg["end"]), turns)
            if speaker is not None:
                seg["speaker"] = speaker
        _renumber_speakers(segments)

    except Exception as exc:
        print(f"Diarization failed: {exc}")

    return segments


def _dominant_speaker(seg_start: float, seg_end: float, turns: list) -> Optional[str]:
    overlap: dict[str, float] = {}
    for t_start, t_end, speaker in turns:
        ov = max(0.0, min(seg_end, t_end) - max(seg_start, t_start))
        if ov > 0:
            overlap[speaker] = overlap.get(speaker, 0.0) + ov
    if overlap:
        return max(overlap, key=overlap.get)
    # Whisper and pyannote cut speech differently, so a segment can fall into a gap
    # between turns. Whoever speaks closest to it is the best guess.
    if not turns:
        return None
    nearest = min(
        turns,
        key=lambda t: max(t[0] - seg_end, seg_start - t[1], 0.0),
    )
    return nearest[2]


def _renumber_speakers(segments: list) -> None:
    """Relabel speakers SPEAKER_00, SPEAKER_01, ... in order of first appearance.

    pyannote numbers its clusters arbitrarily and some clusters end up with no
    segment at all, which leaves gaps ("Speaker 1, 2, 3, 5"). Numbering by first
    appearance makes "Speaker 1" whoever speaks first.
    """
    mapping: dict[str, str] = {}
    for seg in segments:
        label = seg.get("speaker")
        if label is None:
            continue
        if label not in mapping:
            mapping[label] = f"SPEAKER_{len(mapping):02d}"
        seg["speaker"] = mapping[label]

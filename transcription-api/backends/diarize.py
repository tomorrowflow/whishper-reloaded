import uuid
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

        labelled = []
        for seg in segments:
            labelled.extend(_split_by_speaker(seg, turns))
        _renumber_speakers(labelled)
        segments = labelled

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


# A run of words shorter than this between two runs of the same speaker is treated
# as boundary jitter and absorbed rather than split off (seconds).
MIN_INTERJECTION = 0.3


# How many words a speaker change may be moved to land on a sentence end.
SENTENCE_SNAP_REACH = 2


def _snap_to_sentences(words: list, labels: list) -> None:
    """Move speaker changes onto nearby sentence ends, in place.

    People take turns at sentence ends, while diarization boundaries and word
    timings are only accurate to a fraction of a second. A change that falls a word
    or two away from a sentence end ("...Anreise. Am | Sonntag hat er...") is moved
    onto it; one with no sentence end within reach is left alone.
    """
    ends = [w["word"].strip().endswith((".", "?", "!", "…")) for w in words]
    i = 1
    while i < len(labels):
        if labels[i] != labels[i - 1] and not ends[i - 1]:
            # Candidate positions j where a new speaker could start: right after a
            # sentence end, nearest first, later before earlier on a tie.
            target = None
            for d in range(1, SENTENCE_SNAP_REACH + 1):
                for j in (i + d, i - d):
                    if 1 <= j <= len(words) and ends[j - 1]:
                        target = j
                        break
                if target is not None:
                    break
            if target is not None and target > i:
                labels[i:target] = [labels[i - 1]] * (target - i)
            elif target is not None:
                labels[target:i] = [labels[i]] * (i - target)
        i += 1


def _split_by_speaker(seg: dict, turns: list) -> list:
    """Label a segment by speaker, splitting it where the speaker changes.

    Whisper cuts segments by sentence, not by speaker, so one segment can hold two
    voices ("Okay. - Also hier steht abgesagt..."). Every word gets the speaker who
    overlaps it most, and consecutive words of one speaker form a segment.
    """
    seg_speaker = _dominant_speaker(float(seg["start"]), float(seg["end"]), turns)
    words = seg.get("words") or []
    if not words:
        if seg_speaker is not None:
            seg["speaker"] = seg_speaker
        return [seg]

    labels = [
        _dominant_speaker(float(w["start"]), float(w["end"]), turns) or seg_speaker
        for w in words
    ]
    _snap_to_sentences(words, labels)

    runs: list = []  # [label, [words]]
    for word, label in zip(words, labels):
        if runs and runs[-1][0] == label:
            runs[-1][1].append(word)
        else:
            runs.append([label, [word]])

    # A short run sandwiched inside one speaker's sentence is almost always the
    # turn boundaries and word timings disagreeing by a fraction of a second.
    i = 1
    while i < len(runs) - 1:
        label, run_words = runs[i]
        duration = float(run_words[-1]["end"]) - float(run_words[0]["start"])
        if runs[i - 1][0] == runs[i + 1][0] and duration < MIN_INTERJECTION:
            runs[i - 1][1].extend(run_words + runs[i + 1][1])
            del runs[i : i + 2]
        else:
            i += 1

    if len(runs) == 1:
        if runs[0][0] is not None:
            seg["speaker"] = runs[0][0]
        return [seg]

    parts = []
    for k, (label, run_words) in enumerate(runs):
        part = dict(seg)
        part["id"] = seg.get("id") if k == 0 else uuid.uuid4().hex
        part["words"] = run_words
        part["start"] = seg["start"] if k == 0 else run_words[0]["start"]
        part["end"] = seg["end"] if k == len(runs) - 1 else run_words[-1]["end"]
        part["text"] = "".join(w["word"] for w in run_words)
        part["score"] = round(sum(w.get("score", 0) for w in run_words) / len(run_words), 2)
        if label is not None:
            part["speaker"] = label
        else:
            part.pop("speaker", None)
        parts.append(part)
    return parts


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

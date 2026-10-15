from backends.fasterwhisper import FasterWhisperBackend
from backends.model_lease import lease
from backends.backend import Transcription
from faster_whisper import decode_audio
from models import DeviceType
from typing import Optional
import numpy as np
import io
import os
import json
import queue
import threading

def convert_audio(file) -> np.ndarray:
        return decode_audio(file, split_stereo=False, sampling_rate=16000)

async def transcribe_from_filename(
    filename: str,
    model_size: int,
    language: Optional[str] = None,
    device: DeviceType = DeviceType.cpu,
    beam_size: int = 5,
    initial_prompt: str = None,
    hotwords: list[str] = None,
    vad_filter: bool = False,
    vad_threshold: Optional[float] = None,
    vad_min_speech_duration_ms: Optional[int] = None,
    vad_min_silence_duration_ms: Optional[int] = None,
    diarize: bool = False,
    hf_token: str = None,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
) -> Transcription:
    filepath = os.path.join(os.environ["UPLOAD_DIR"], filename)
    if not os.path.exists(filepath):
        raise RuntimeError(f"file not found in {filepath}")
    audio = convert_audio(filepath)
    return await transcribe_audio(audio, model_size, language, device, beam_size, initial_prompt, hotwords, vad_filter, vad_threshold, vad_min_speech_duration_ms, vad_min_silence_duration_ms, diarize, hf_token, min_speakers, max_speakers)

async def transcribe_file(
    file: io.BytesIO,
    model_size: int,
    language: Optional[str] = None,
    device: DeviceType = DeviceType.cpu,
    beam_size: int = 5,
    initial_prompt: str = None,
    hotwords: list[str] = None,
    vad_filter: bool = False,
    vad_threshold: Optional[float] = None,
    vad_min_speech_duration_ms: Optional[int] = None,
    vad_min_silence_duration_ms: Optional[int] = None,
    diarize: bool = False,
    hf_token: str = None,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
) -> Transcription:
    contents = await file.read()  # async read
    if len(contents) < 150 * 1024 * 1024:  # file is smaller than 150MB
        audio = convert_audio(io.BytesIO(contents))
    else:
        # Save the uploaded file temporarily on disk
        with open(file.filename, 'wb') as f:
            f.write(contents)
        # Check if file exists
        if not os.path.exists(file.filename):
            raise RuntimeError(f"file not found in {file.filename}")
        # Corrected to use the function in this file
        audio = convert_audio(file.filename)
        os.remove(file.filename)
    return await transcribe_audio(audio, model_size, language, device, beam_size, initial_prompt, hotwords, vad_filter, vad_threshold, vad_min_speech_duration_ms, vad_min_silence_duration_ms, diarize, hf_token, min_speakers, max_speakers)

async def transcribe_audio(
    audio: np.ndarray,
    model_size: int,
    language: Optional[str] = None,
    device: DeviceType = DeviceType.cpu,
    beam_size: int = 5,
    initial_prompt: str = None,
    hotwords: list[str] = None,
    vad_filter: bool = False,
    vad_threshold: Optional[float] = None,
    vad_min_speech_duration_ms: Optional[int] = None,
    vad_min_silence_duration_ms: Optional[int] = None,
    diarize: bool = False,
    hf_token: str = None,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
) -> Transcription:
    if language == "auto":
        language = None
    with lease(model_size, device) as model:
        return model.transcribe(
            audio,
            silent=True,
            language=language,
            beam_size=beam_size,
            initial_prompt=initial_prompt,
            hotwords=hotwords,
            vad_filter=vad_filter,
            vad_threshold=vad_threshold,
            vad_min_speech_duration_ms=vad_min_speech_duration_ms,
            vad_min_silence_duration_ms=vad_min_silence_duration_ms,
            diarize=diarize,
            hf_token=hf_token,
            min_speakers=min_speakers,
            max_speakers=max_speakers,
        )


def transcribe_from_filename_stream(
    filename: str,
    model_size: int,
    language: Optional[str] = None,
    device: DeviceType = DeviceType.cpu,
    beam_size: int = 5,
    initial_prompt: str = None,
    hotwords: list[str] = None,
    vad_filter: bool = False,
    vad_threshold: Optional[float] = None,
    vad_min_speech_duration_ms: Optional[int] = None,
    vad_min_silence_duration_ms: Optional[int] = None,
    diarize: bool = False,
    hf_token: str = None,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
):
    filepath = os.path.join(os.environ["UPLOAD_DIR"], filename)
    if not os.path.exists(filepath):
        raise RuntimeError(f"file not found in {filepath}")
    audio = convert_audio(filepath)
    return transcribe_audio_stream(
        audio, model_size, language, device, beam_size, initial_prompt, hotwords,
        vad_filter, vad_threshold, vad_min_speech_duration_ms, vad_min_silence_duration_ms,
        diarize, hf_token, min_speakers, max_speakers,
    )


def transcribe_file_stream(
    contents: bytes,
    filename: str,
    model_size: int,
    language: Optional[str] = None,
    device: DeviceType = DeviceType.cpu,
    beam_size: int = 5,
    initial_prompt: str = None,
    hotwords: list[str] = None,
    vad_filter: bool = False,
    vad_threshold: Optional[float] = None,
    vad_min_speech_duration_ms: Optional[int] = None,
    vad_min_silence_duration_ms: Optional[int] = None,
    diarize: bool = False,
    hf_token: str = None,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
):
    if len(contents) < 150 * 1024 * 1024:  # file is smaller than 150MB
        audio = convert_audio(io.BytesIO(contents))
    else:
        with open(filename, 'wb') as f:
            f.write(contents)
        if not os.path.exists(filename):
            raise RuntimeError(f"file not found in {filename}")
        audio = convert_audio(filename)
        os.remove(filename)
    return transcribe_audio_stream(
        audio, model_size, language, device, beam_size, initial_prompt, hotwords,
        vad_filter, vad_threshold, vad_min_speech_duration_ms, vad_min_silence_duration_ms,
        diarize, hf_token, min_speakers, max_speakers,
    )


def transcribe_audio_stream(
    audio: np.ndarray,
    model_size: int,
    language: Optional[str] = None,
    device: DeviceType = DeviceType.cpu,
    beam_size: int = 5,
    initial_prompt: str = None,
    hotwords: list[str] = None,
    vad_filter: bool = False,
    vad_threshold: Optional[float] = None,
    vad_min_speech_duration_ms: Optional[int] = None,
    vad_min_silence_duration_ms: Optional[int] = None,
    diarize: bool = False,
    hf_token: str = None,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
):
    """
    Run the transcription in a background thread and yield NDJSON lines.

    Model download line: {"type": "model_download", "model": "large-v2"}
    Each progress line:  {"type": "progress", "progress": 0.42}
    Final result line:   {"type": "result", "result": {<Transcription>}}
    On error:            {"type": "error", "error": "<message>"}
    """
    if language == "auto":
        language = None

    # If the model weights are not cached yet, let the consumer know that we
    # are about to download them (this can take a while for large models).
    if not FasterWhisperBackend(model_size=model_size, device=device).is_model_cached():
        yield json.dumps({"type": "model_download", "model": model_size}) + "\n"

    with lease(model_size, device) as model:
        # Thread-safe queue used to forward progress events from the worker
        # thread (where the blocking transcribe loop runs) to this generator.
        events: "queue.Queue" = queue.Queue()
        SENTINEL = object()

        def on_progress(progress: float, _segment):
            events.put({"type": "progress", "progress": round(progress, 4)})

        def worker():
            try:
                result = model.transcribe(
                    audio,
                    silent=True,
                    language=language,
                    beam_size=beam_size,
                    initial_prompt=initial_prompt,
                    hotwords=hotwords,
                    vad_filter=vad_filter,
                    vad_threshold=vad_threshold,
                    vad_min_speech_duration_ms=vad_min_speech_duration_ms,
                    vad_min_silence_duration_ms=vad_min_silence_duration_ms,
                    progress_callback=on_progress,
                    diarize=False,  # handled below so we can emit a progress event first
                )
                if diarize and hf_token:
                    events.put({"type": "diarizing"})
                    from backends.diarize import assign_speakers
                    result["segments"] = assign_speakers(
                        audio,
                        result["segments"],
                        hf_token=hf_token,
                        min_speakers=min_speakers,
                        max_speakers=max_speakers,
                        device=model.device,
                    )
                events.put({"type": "result", "result": result})
            except Exception as e:  # noqa: BLE001
                events.put({"type": "error", "error": str(e)})
            finally:
                events.put(SENTINEL)

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()

        while True:
            event = events.get()
            if event is SENTINEL:
                break
            yield json.dumps(event) + "\n"

        thread.join()

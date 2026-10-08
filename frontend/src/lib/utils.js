import {transcriptions, pendingDelete} from './stores';
import { dev } from '$app/environment';
import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';

export let CLIENT_API_HOST = `${env.PUBLIC_API_HOST}`;

// Fetches the full transcription (including the heavy WhisperResult payload) on demand.
// The list endpoint only returns a lightweight object, so actions that need segments,
// text or translations must load the complete record first.
export const getFullTranscription = async function (id) {
    const res = await fetch(`${CLIENT_API_HOST}/api/transcriptions/${id}`);
    if (!res.ok) {
        throw new Error(`Failed to load transcription ${id}: ${res.status}`);
    }
    return res.json();
};

const apiHost = env.PUBLIC_API_HOST || "default_api_host_here"; 
export let CLIENT_WS_HOST = `${apiHost.replace("http://", "").replace("https://", "")}`;// URL Validator
export const validateURL = function (url) {
    try {
        new URL(url);
        return true;
    } catch (e) {
        return false;
    }
}

export const deleteTranscription = async function (id) {
    const res = await fetch(`${CLIENT_API_HOST}/api/transcriptions/${id}`, {
        method: "DELETE"
    });

    if (!res.ok) {
        throw new Error(`Error: ${res.status} ${res.statusText}`);
    }
    transcriptions.update((_transcriptions) => _transcriptions.filter(t => t.id !== id));
}

// Asks for confirmation before deleting; the dialog on the home page does the rest.
export const requestDelete = function (tr) {
    pendingDelete.set(tr);
}

// Saves the complete speaker name mapping of a transcription and returns the
// updated transcription. Labels left out (or mapped to '') get their default name.
export const saveSpeakerNames = async function (id, names) {
    const response = await fetch(`${CLIENT_API_HOST}/api/transcriptions/${id}/speakers`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(names)
    });

    if (!response.ok) {
        throw new Error(`Error: ${response.status} ${await response.text()}`);
    }

    return response.json();
}

export const renameTranscription = async function (id, newFileName) {
    const formData = new FormData();
    formData.append('newFileName', newFileName);

    const response = await fetch(`${CLIENT_API_HOST}/api/rename/${id}`, {
        method: 'POST',
        body: formData
    });

    if (!response.ok) {
        throw new Error(`Error: ${response.statusText}`);
    }

    const updatedTranscription = await response.json();
    transcriptions.update((_transcriptions) => {
        const index = _transcriptions.findIndex(t => t.id === id);
        if (index !== -1) {
            _transcriptions[index] = updatedTranscription;
        }
        return _transcriptions;
    });

    return updatedTranscription;
}

export const uploadJSON = async function (id, jsonData) {
    const response = await fetch(`${CLIENT_API_HOST}/api/upload`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            transcriptionId: id,
            result: jsonData
        })
    });

    if (response.status === 304) {
        // Handle "no changes" case specifically
        const result = { noChanges: true };
        result.status = response.status;
        return result;
    }

    if (!response.ok) {
        const errorData = await response.json();
        const error = new Error(errorData.error || 'Upload failed');
        error.status = response.status;
        throw error;
    }

    const updatedTranscription = await response.json();
    transcriptions.update((_transcriptions) => {
        const index = _transcriptions.findIndex(t => t.id === id);
        if (index !== -1) {
            _transcriptions[index] = updatedTranscription;
        }
        return _transcriptions;
    });

    return updatedTranscription;
}

// Number of taglines available under the `taglines` i18n key. Keep in sync with the locale files.
export const TAGLINE_COUNT = 17;

// Returns a random tagline index that the UI resolves against the active locale's `taglines` list.
export const getRandomTaglineIndex = function () {
    return Math.floor(Math.random() * TAGLINE_COUNT);
}

// Formats a number of seconds as the "HH:MM:SS.mmm" stamp used by SRT and VTT cues.
const formatCueTime = function (seconds) {
    let whole = Math.floor(seconds);
    let millis = Math.floor((seconds - whole) * 1000);
    return new Date(whole * 1000 + millis).toISOString().substr(11, 12);
}

// Formats a number of seconds as "HH:MM:SS", the stamp used in speaker transcripts.
export const formatClockTime = function (seconds) {
    return formatCueTime(seconds).substr(0, 8);
}

// Turns a raw diarization label ("SPEAKER_00") into the 1-based, human readable
// name that transcript readers expect ("Speaker 1"). Anything that doesn't follow
// pyannote's convention is passed through untouched, so a hand-picked name such as
// "Alice" survives. Returns null when the segment carries no speaker at all.
// `names` is the transcription's speakerNames mapping ({"SPEAKER_00": "Alice"});
// a name the user picked there wins over the default.
export const speakerName = function (label, names = null) {
    if (!label) return null;
    let trimmed = String(label).trim();
    if (trimmed === '') return null;
    let custom = names?.[trimmed]?.trim();
    if (custom) return custom;
    if (/^Speaker \d+$/.test(trimmed)) return trimmed; // already resolved
    let match = /^SPEAKER[_\s-]?(\d+)$/i.exec(trimmed);
    return match ? `Speaker ${parseInt(match[1], 10) + 1}` : trimmed;
}

// True when at least one segment carries a speaker label, i.e. the transcription
// was diarized and the speaker-aware exports have something to work with.
export const hasSpeakers = function (segments) {
    return Array.isArray(segments) && segments.some((segment) => !!speakerName(segment.speaker));
}

// The border/badge colours used to tell speakers apart, indexed by the number in
// their label so a speaker keeps the same colour everywhere they appear.
const SPEAKER_PALETTES = [
    { box: 'border-l-4 border-l-blue-500/60',    badge: 'bg-blue-500/15 text-blue-400 border-blue-500/30',          text: 'text-blue-400' },
    { box: 'border-l-4 border-l-emerald-500/60', badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', text: 'text-emerald-400' },
    { box: 'border-l-4 border-l-violet-500/60',  badge: 'bg-violet-500/15 text-violet-400 border-violet-500/30',    text: 'text-violet-400' },
    { box: 'border-l-4 border-l-amber-500/60',   badge: 'bg-amber-500/15 text-amber-400 border-amber-500/30',       text: 'text-amber-400' },
    { box: 'border-l-4 border-l-rose-500/60',    badge: 'bg-rose-500/15 text-rose-400 border-rose-500/30',          text: 'text-rose-400' },
    { box: 'border-l-4 border-l-cyan-500/60',    badge: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',          text: 'text-cyan-400' },
    { box: 'border-l-4 border-l-orange-500/60',  badge: 'bg-orange-500/15 text-orange-400 border-orange-500/30',    text: 'text-orange-400' },
    { box: 'border-l-4 border-l-pink-500/60',    badge: 'bg-pink-500/15 text-pink-400 border-pink-500/30',          text: 'text-pink-400' }
];

// When the user gives several labels the same name (diarization split one person
// in two), they become one speaker: every label resolves to the lowest label that
// carries that name, so the merged speaker keeps a single colour.
export const speakerColorKey = function (label, names = null) {
    let custom = names?.[label]?.trim();
    if (!custom) return label;
    return Object.keys(names)
        .filter((other) => names[other]?.trim() === custom)
        .sort()[0];
}

// Resolves a raw diarization label to its colour set, or null when unlabeled.
export const speakerPalette = function (label, names = null) {
    if (!label) return null;
    label = speakerColorKey(label, names);
    const idx = parseInt(String(label).replace(/\D/g, '') || '0', 10) % SPEAKER_PALETTES.length;
    return SPEAKER_PALETTES[idx];
}

// Groups consecutive segments spoken by the same person into a single turn.
// A conversation transcript reads by turn, not by subtitle cue: one speaker label
// followed by everything they said before somebody else took over. Unlabeled
// segments are never merged — without a speaker there is nothing to say they
// belong together, and merging them would collapse an undiarized transcript into
// a single block. Labels that share a custom name count as the same speaker.
export const buildSpeakerTurns = function (segments, names = null) {
    let turns = [];

    (segments ?? []).forEach((segment) => {
        let text = (segment.text ?? '').trim();
        if (text === '') return;

        let label = segment.speaker ? speakerColorKey(segment.speaker, names) : null;
        let speaker = speakerName(segment.speaker, names);
        let last = turns[turns.length - 1];

        if (last && speaker !== null && last.speaker === speaker) {
            last.text += ` ${text}`;
            last.end = segment.end;
        } else {
            turns.push({ label, speaker, text, start: segment.start, end: segment.end });
        }
    });

    return turns;
}

// Renders segments as a speaker-attributed plain text transcript:
//
//   [00:00:02] Speaker 1: Hello, how are you?
//
//   [00:00:06] Speaker 2: I'm fine, thanks.
//
// This "Speaker N: text" layout is the de-facto interchange format for diarized
// transcripts (Otter, Rev, Sonix, AssemblyAI all export it) and it stays readable
// when pasted into a document or fed to a language model.
export const buildSpeakerTranscript = function (segments, { timestamps = true, unknownLabel = 'Unknown speaker', names = null } = {}) {
    return buildSpeakerTurns(segments, names)
        .map((turn) => {
            let stamp = timestamps ? `[${formatClockTime(turn.start)}] ` : '';
            return `${stamp}${turn.speaker ?? unknownLabel}: ${turn.text}`;
        })
        .join('\n\n');
}

// Downloads a speaker-attributed plain text transcript. See buildSpeakerTranscript.
export const downloadSpeakerTranscript = function (segments, title, options = {}) {
    let content = buildSpeakerTranscript(segments, options);
    let blob = new Blob([`${content}\n`], {type: 'text/plain'});
    let url = URL.createObjectURL(blob);
    let link = document.createElement('a');
    link.href = url;
    link.download = `${title}-speakers.txt`;
    link.click();
}

// Expects a segments array with start, end and text properties.
// With includeSpeakers, each cue is prefixed with "Speaker N: "; SRT has no
// standard speaker syntax, so this mirrors what diarizing transcribers emit.
export const downloadSRT = function (jsonData, title, includeSpeakers = false, names = null) {
    let srtContent = '';

    jsonData.forEach((segment, index) => {
        let start = formatCueTime(segment.start);
        let end = formatCueTime(segment.end);
        let speaker = includeSpeakers ? speakerName(segment.speaker, names) : null;
        let text = speaker ? `${speaker}: ${segment.text.trim()}` : segment.text;

        srtContent += `${index + 1}\n${start} --> ${end}\n${text}\n\n`;
    });
  
    let srtBlob = new Blob([srtContent], {type: 'text/plain'});
    let url = URL.createObjectURL(srtBlob);
    let link = document.createElement('a');
    link.href = url;
    link.download = `${title}.srt`;
    link.click();
}

// Downloads received text as a TXT file
export const downloadTXT = function (text, title) {
    let srtBlob = new Blob([text], {type: 'text/plain'});
    let url = URL.createObjectURL(srtBlob);
    let link = document.createElement('a');
    link.href = url;
    link.download = `${title}.txt`;
    link.click();
}

// Downloads received JSON data as a JSON file
export const downloadJSON = function (jsonData, title, includeWords = false) {
    // Remove "words" arrays from the data if includeWords is false
    const cleanData = includeWords
        ? jsonData
        : Array.isArray(jsonData)
            ? jsonData.map(item => {
                const { words, ...rest } = item;
                return rest;
            })
            : jsonData.segments
                ? {
                    ...jsonData,
                    segments: jsonData.segments.map(segment => {
                        const { words, ...rest } = segment;
                        return rest;
                    })
                }
                : jsonData;

    let srtBlob = new Blob([JSON.stringify(cleanData)], {type: 'text/plain'});
    let url = URL.createObjectURL(srtBlob);
    let link = document.createElement('a');
    link.href = url;
    link.download = `${title}.json`;
    link.click();
}

// Expects a segments array with start, end and text properties.
// With includeSpeakers, cue text is wrapped in a WebVTT voice span
// (`<v Speaker 1>...</v>`), which is how the W3C spec attributes a cue to a
// speaker, so players and downstream tools can read the speaker back out.
export const downloadVTT = function (jsonData, title, includeSpeakers = false, names = null) {
    let vttContent = 'WEBVTT\n\n'; // VTT files start with "WEBVTT" line
  
    jsonData.forEach((segment, index) => {
      let start = formatCueTime(segment.start);
      let end = formatCueTime(segment.end);
      let speaker = includeSpeakers ? speakerName(segment.speaker, names) : null;
      // A voice span annotation may not contain the characters that delimit it.
      let text = speaker
        ? `<v ${speaker.replace(/[<>&]/g, ' ').trim()}>${segment.text.trim()}</v>`
        : segment.text;

      vttContent += `${index + 1}\n${start} --> ${end}\n${text}\n\n`;
    });
  
    let vttBlob = new Blob([vttContent], {type: 'text/plain'});
    let url = URL.createObjectURL(vttBlob);
    let link = document.createElement('a');
    link.href = url;
    link.download = `${title}.vtt`;
    link.click();
}
  

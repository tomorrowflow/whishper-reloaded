// Svelte action that owns a media element's `src` and keeps playback alive on an
// unstable connection:
//  - network errors and long stalls reload the source at the same position,
//    with backoff, and resume playing if it was playing;
//  - the whole file is downloaded in the background in resumable Range chunks
//    and swapped in as a blob URL, after which playback no longer touches the
//    network.
// Emits `reloading` (detail: boolean) around every source swap, during which the
// element's currentTime is meaningless, `fatalerror` once it gives up, and
// `mediastatus` (detail: MediaStatus) whenever what the user should see changes.

/**
 * @typedef {object} MediaStatus
 * @property {'loading' | 'ok' | 'buffering' | 'reconnecting' | 'failed'} connection
 * @property {number} retryAt epoch ms of the next reconnect attempt, 0 if attempting now
 * @property {'saving' | 'waiting' | 'saved' | 'unavailable'} save background download;
 *   `waiting` while it retries a failed chunk, `unavailable` when the file is too
 *   large or the server cannot send ranges
 * @property {number} saved bytes downloaded so far
 * @property {number} total file size in bytes, 0 until known
 */

/** Whether the user is kept waiting for audio, as opposed to it playing or paused. */
export const isWaitingForAudio = (status) =>
	!!status && ['loading', 'buffering', 'reconnecting'].includes(status.connection);

const CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 300 * 1024 * 1024;
// Generous on purpose: on a lossy, high-latency link TCP goes quiet for many
// seconds and then recovers on its own, while every restart costs several
// round trips and throws away a connection that was about to deliver.
const STALL_MS = 15000;
const IDLE_MS = 30000;
// A reload whose request hangs fires neither `loadedmetadata` nor `error`.
const ATTEMPT_MS = 20000;
const MAX_BACKOFF_MS = 15000;
// Before the first successful load an error may be a real format problem, so
// give up after a few tries. Once the file has loaded, it is known to play.
const MAX_COLD_RETRIES = 5;
const PROGRESS_EVERY_MS = 250;

const log = (...args) => console.info('[media]', ...args);

// A fresh URL per reload keeps the browser from reusing a stuck connection or
// cached failure for the same address; the server ignores the query.
const freshUrl = (url, attempt) => `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}`;

const sleep = (ms, signal) =>
	new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal.addEventListener('abort', () => {
			clearTimeout(t);
			reject(signal.reason);
		});
	});

async function downloadWithResume(url, signal, onProgress) {
	const parts = [];
	let received = 0;
	let total = Infinity;
	let type = '';
	let failures = 0;
	while (received < total) {
		// A connection can go silent without ever closing; abort a chunk once no
		// bytes have arrived for a while and resume from what was kept.
		const chunk = new AbortController();
		const abortChunk = () => chunk.abort();
		signal.addEventListener('abort', abortChunk);
		let idle = setTimeout(abortChunk, IDLE_MS);
		try {
			const res = await fetch(url, {
				signal: chunk.signal,
				headers: { Range: `bytes=${received}-${received + CHUNK_BYTES - 1}` }
			});
			onProgress('saving', received, total);
			if (res.status !== 206) return null; // no Range support: leave it to streaming
			const size = Number(res.headers.get('Content-Range')?.split('/')[1]);
			if (!size || size > MAX_CACHE_BYTES) return null;
			total = size;
			type ||= res.headers.get('Content-Type') ?? '';
			const reader = res.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				parts.push(value);
				received += value.byteLength;
				failures = 0; // backoff is for a dead line, not one that drops now and then
				onProgress('saving', received, total);
				clearTimeout(idle);
				idle = setTimeout(abortChunk, IDLE_MS);
			}
		} catch (err) {
			if (signal.aborted) throw err;
			failures += 1;
			log(`download stopped at ${received} bytes, retrying`, err?.name ?? err);
			onProgress('waiting', received, total === Infinity ? 0 : total);
			await sleep(Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS), signal);
		} finally {
			clearTimeout(idle);
			signal.removeEventListener('abort', abortChunk);
		}
	}
	return new Blob(parts, type ? { type } : undefined);
}

export function resilientMedia(node, src) {
	let current = '';
	let objectUrl = '';
	let controller;
	let everLoaded = false;
	let retries = 0;
	let coldErrors = 0;
	let attempt = 0;
	let retryTimer;
	let attemptTimer;
	let stallTimer = null;
	let stallAt = 0;
	let wantsPlay = false;
	// Position and rate to restore, kept across reload attempts that fail before
	// loading: after a swap the element itself reports 0 and default speed.
	let pending = null;

	// play() on a failed source rejects without a `play` event, so the click
	// would be forgotten. Record the intent and let the reload resume playback.
	const nativePlay = node.play.bind(node);
	const nativePause = node.pause.bind(node);
	node.play = () => {
		wantsPlay = true;
		return pending || node.error ? Promise.resolve() : nativePlay();
	};
	node.pause = () => {
		wantsPlay = false;
		clearStall();
		nativePause();
	};

	const emit = (name, detail) => node.dispatchEvent(new CustomEvent(name, { detail }));

	/** @type {MediaStatus} */
	let status;
	let lastProgress = 0;
	function setStatus(patch) {
		status = { ...status, ...patch };
		emit('mediastatus', status);
	}
	function onSaveProgress(save, saved, total) {
		const now = Date.now();
		if (save === status.save && saved < total && now - lastProgress < PROGRESS_EVERY_MS) return;
		lastProgress = now;
		setStatus({ save, saved, total: total === Infinity ? 0 : total });
	}

	function swapSource(url) {
		if (!pending) {
			pending = { at: node.currentTime, rate: node.playbackRate };
			emit('reloading', true);
		}
		clearStall();
		clearTimeout(attemptTimer);
		if (url.startsWith('blob:')) {
			node.src = url;
		} else {
			attempt += 1;
			log(`reconnect attempt ${attempt}`);
			setStatus({ connection: 'reconnecting', retryAt: 0 });
			node.src = freshUrl(url, attempt);
			armAttempt();
		}
		node.load();
	}

	function armAttempt() {
		clearTimeout(attemptTimer);
		attemptTimer = setTimeout(() => {
			log(`load attempt got no answer in ${ATTEMPT_MS / 1000} s`);
			scheduleRetry();
		}, ATTEMPT_MS);
	}

	function clearStall() {
		clearTimeout(stallTimer);
		stallTimer = null;
	}

	function fail() {
		controller?.abort();
		clearTimeout(retryTimer);
		clearTimeout(attemptTimer);
		clearStall();
		log('giving up', node.error?.code, node.error?.message);
		setStatus({ connection: 'failed', retryAt: 0 });
		emit('fatalerror', node.error);
	}

	function scheduleRetry() {
		clearTimeout(retryTimer);
		clearTimeout(attemptTimer);
		retries += 1;
		const delay = navigator.onLine ? Math.min(1000 * 2 ** (retries - 1), MAX_BACKOFF_MS) : MAX_BACKOFF_MS;
		log(`retrying in ${delay / 1000} s`);
		setStatus({ connection: 'reconnecting', retryAt: Date.now() + delay });
		retryTimer = setTimeout(() => swapSource(objectUrl || current), delay);
	}

	function onError() {
		log('media error', node.error?.code, node.error?.message);
		// A decode error is the file itself; a blob cannot have network trouble.
		// Before anything has loaded, an error may also be a format the browser
		// cannot play, so stop after a few; timeouts never count towards that.
		if (node.error?.code === 3 || node.src.startsWith('blob:')) {
			fail();
			return;
		}
		if (!everLoaded && ++coldErrors >= MAX_COLD_RETRIES) {
			fail();
			return;
		}
		scheduleRetry();
	}

	function onLoaded() {
		everLoaded = true;
		retries = 0;
		clearTimeout(attemptTimer);
		if (pending) log('reconnected');
		setStatus({ connection: 'ok', retryAt: 0 });
		if (!pending) return;
		const { at, rate } = pending;
		pending = null;
		if (at) node.currentTime = at;
		node.playbackRate = rate;
		emit('reloading', false);
		if (wantsPlay) nativePlay().catch(() => {});
	}

	// `stalled` repeats every few seconds while no data arrives, so the timer is
	// armed once and only real progress of the playhead disarms it.
	function onWaiting() {
		// `stalled` also fires when a paused element stops buffering on purpose.
		if (!wantsPlay || pending || stallTimer || node.src.startsWith('blob:')) return;
		stallAt = node.currentTime;
		setStatus({ connection: 'buffering' });
		stallTimer = setTimeout(() => {
			log(`no progress for ${STALL_MS / 1000} s at ${stallAt.toFixed(1)} s`);
			swapSource(current);
		}, STALL_MS);
	}

	function onProgressing() {
		if (stallTimer && node.currentTime < stallAt + 0.5) return;
		clearStall();
		if (status.connection === 'buffering') setStatus({ connection: 'ok' });
	}
	const onPlay = () => (wantsPlay = true);
	// Native controls pause without going through node.pause. A swap also pauses
	// the element as a side effect, which is not the user pausing.
	const onPause = () => {
		if (pending || node.error) return;
		wantsPlay = false;
		clearStall();
		if (status.connection === 'buffering') setStatus({ connection: 'ok' });
	};
	const onOnline = () => {
		if (node.error || node.networkState === node.NETWORK_NO_SOURCE) {
			log('browser is back online');
			retries = 0;
			clearTimeout(retryTimer);
			swapSource(objectUrl || current);
		}
	};

	function load(url) {
		if (url === current) return;
		controller?.abort();
		clearTimeout(retryTimer);
		clearTimeout(attemptTimer);
		clearStall();
		if (objectUrl) URL.revokeObjectURL(objectUrl);
		objectUrl = '';
		current = url;
		everLoaded = false;
		retries = 0;
		coldErrors = 0;
		if (pending) emit('reloading', false);
		pending = null;
		setStatus({ connection: 'loading', retryAt: 0, save: 'saving', saved: 0, total: 0 });
		if (!url) {
			node.removeAttribute('src');
			return;
		}
		node.src = url;
		armAttempt();

		controller = new AbortController();
		const signal = controller.signal;
		downloadWithResume(url, signal, onSaveProgress)
			.then((blob) => {
				if (signal.aborted) return;
				if (!blob) {
					setStatus({ save: 'unavailable' });
					return;
				}
				log(`saved ${blob.size} bytes, playing from memory`);
				setStatus({ save: 'saved', saved: blob.size, total: blob.size });
				objectUrl = URL.createObjectURL(blob);
				swapSource(objectUrl);
			})
			.catch(() => {});
	}

	// The background download fetches the whole file; letting the element buffer
	// it all as well would send every byte twice over a thin connection.
	node.preload = 'metadata';
	node.addEventListener('error', onError);
	node.addEventListener('loadedmetadata', onLoaded);
	node.addEventListener('waiting', onWaiting);
	node.addEventListener('stalled', onWaiting);
	node.addEventListener('timeupdate', onProgressing);
	node.addEventListener('playing', onProgressing);
	node.addEventListener('play', onPlay);
	node.addEventListener('pause', onPause);
	window.addEventListener('online', onOnline);
	load(src);

	return {
		update: load,
		destroy() {
			controller?.abort();
			clearTimeout(retryTimer);
			clearTimeout(attemptTimer);
			clearStall();
			window.removeEventListener('online', onOnline);
			delete node.play;
			delete node.pause;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		}
	};
}

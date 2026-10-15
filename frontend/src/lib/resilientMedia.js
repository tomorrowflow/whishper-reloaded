// Svelte action that owns a media element's `src` and keeps playback alive on an
// unstable connection:
//  - network errors and long stalls reload the source at the same position,
//    with backoff, and resume playing if it was playing;
//  - the whole file is downloaded in the background in resumable Range chunks
//    and swapped in as a blob URL, after which playback no longer touches the
//    network.
// Emits `reloading` (detail: boolean) around every source swap, during which the
// element's currentTime is meaningless, and `fatalerror` once it gives up.

const CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 300 * 1024 * 1024;
const STALL_MS = 8000;
const IDLE_MS = 10000;
const MAX_BACKOFF_MS = 15000;
// Before the first successful load an error may be a real format problem, so
// give up after a few tries. Once the file has loaded, it is known to play.
const MAX_COLD_RETRIES = 5;

const sleep = (ms, signal) =>
	new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal.addEventListener('abort', () => {
			clearTimeout(t);
			reject(signal.reason);
		});
	});

async function downloadWithResume(url, signal) {
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
				clearTimeout(idle);
				idle = setTimeout(abortChunk, IDLE_MS);
			}
			failures = 0;
		} catch (err) {
			if (signal.aborted) throw err;
			failures += 1;
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
	let retryTimer;
	let stallTimer;
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
		clearTimeout(stallTimer);
		nativePause();
	};

	const emit = (name, detail) => node.dispatchEvent(new CustomEvent(name, { detail }));

	function swapSource(url) {
		if (!pending) {
			pending = { at: node.currentTime, rate: node.playbackRate };
			emit('reloading', true);
		}
		node.src = url;
		node.load();
	}

	function fail() {
		controller?.abort();
		clearTimeout(retryTimer);
		clearTimeout(stallTimer);
		emit('fatalerror', node.error);
	}

	function scheduleRetry() {
		clearTimeout(retryTimer);
		if (!everLoaded && retries >= MAX_COLD_RETRIES) {
			fail();
			return;
		}
		retries += 1;
		const delay = navigator.onLine ? Math.min(1000 * 2 ** (retries - 1), MAX_BACKOFF_MS) : MAX_BACKOFF_MS;
		retryTimer = setTimeout(() => swapSource(objectUrl || current), delay);
	}

	function onError() {
		// A decode error is the file itself; a blob cannot have network trouble.
		if (node.error?.code === 3 || node.src.startsWith('blob:')) {
			fail();
			return;
		}
		scheduleRetry();
	}

	function onLoaded() {
		everLoaded = true;
		retries = 0;
		if (!pending) return;
		const { at, rate } = pending;
		pending = null;
		if (at) node.currentTime = at;
		node.playbackRate = rate;
		emit('reloading', false);
		if (wantsPlay) nativePlay().catch(() => {});
	}

	function onWaiting() {
		clearTimeout(stallTimer);
		// `stalled` also fires when a paused element stops buffering on purpose.
		if (!wantsPlay || node.src.startsWith('blob:')) return;
		stallTimer = setTimeout(() => swapSource(current), STALL_MS);
	}

	const onProgressing = () => clearTimeout(stallTimer);
	const onPlay = () => (wantsPlay = true);
	// Native controls pause without going through node.pause. A swap also pauses
	// the element as a side effect, which is not the user pausing.
	const onPause = () => {
		if (pending || node.error) return;
		wantsPlay = false;
		clearTimeout(stallTimer);
	};
	const onOnline = () => {
		if (node.error || node.networkState === node.NETWORK_NO_SOURCE) {
			retries = 0;
			clearTimeout(retryTimer);
			swapSource(objectUrl || current);
		}
	};

	function load(url) {
		if (url === current) return;
		controller?.abort();
		clearTimeout(retryTimer);
		clearTimeout(stallTimer);
		if (objectUrl) URL.revokeObjectURL(objectUrl);
		objectUrl = '';
		current = url;
		everLoaded = false;
		retries = 0;
		if (pending) emit('reloading', false);
		pending = null;
		if (!url) {
			node.removeAttribute('src');
			return;
		}
		node.src = url;

		controller = new AbortController();
		const signal = controller.signal;
		downloadWithResume(url, signal)
			.then((blob) => {
				if (!blob || signal.aborted) return;
				objectUrl = URL.createObjectURL(blob);
				swapSource(objectUrl);
			})
			.catch(() => {});
	}

	node.preload = 'auto';
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
			clearTimeout(stallTimer);
			window.removeEventListener('online', onOnline);
			delete node.play;
			delete node.pause;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		}
	};
}

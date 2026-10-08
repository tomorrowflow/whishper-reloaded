<script>
	import { onDestroy, onMount, tick } from 'svelte';
	import { browser } from '$app/environment';
	import { _ } from 'svelte-i18n';
	import { currentTranscription, currentVideoPlayerTime } from '$lib/stores';
	import { buildSpeakerTurns, CLIENT_API_HOST } from '$lib/utils';
	import ReaderTurn from './ReaderTurn.svelte';
	import GoToSegment from './GoToSegment.svelte';
	import ModalDownloadOptions from './ModalDownloadOptions.svelte';
	import ModalSpeakerNames from './ModalSpeakerNames.svelte';
	import IconButton from './ui/IconButton.svelte';
	import SearchField from './ui/SearchField.svelte';
	import Select from './ui/Select.svelte';
	import Spinner from './ui/Spinner.svelte';
	import ThemeToggle from './ui/ThemeToggle.svelte';
	import {
		AlertTriangle,
		ArrowLeft,
		ChevronDown,
		ChevronUp,
		LocateFixed,
		Pause,
		Pencil,
		Play,
		Save,
		Users
	} from 'lucide-svelte';

	const TURNS_PER_PAGE = 30;
	const SEEK_TOLERANCE = 0.1; // seconds; matches the editor's player

	let language = 'original';
	let turnsToShow = TURNS_PER_PAGE;
	let query = '';
	let matchCursor = 0;
	let downloadOpen = false;
	let speakersOpen = false;
	let speakerFocus = null;
	let loadMoreButton;
	let observer;

	// The conversation is read as turns, not as subtitle cues — the same grouping the
	// speaker transcript download produces, so the page and the file always agree.
	$: segments =
		language === 'original'
			? $currentTranscription?.result?.segments ?? []
			: $currentTranscription?.translations?.find((t) => t.targetLanguage === language)?.result
					?.segments ?? [];
	$: turns = buildSpeakerTurns(segments, $currentTranscription?.speakerNames);
	$: speakerCount = new Set(turns.map((turn) => turn.speaker).filter(Boolean)).size;
	$: displayName = $currentTranscription?.fileName?.split('_WHSHPR_')[1] ?? '';

	// --- Search -------------------------------------------------------------
	// Two characters is enough here: unlike the file-name search on the home page this
	// runs over already-loaded text, so there is nothing to debounce.
	$: needle = query.trim().length >= 2 ? query.trim().toLowerCase() : '';
	$: matches = needle
		? turns.reduce((hits, turn, i) => {
				if (turn.text.toLowerCase().includes(needle)) hits.push(i);
				return hits;
		  }, [])
		: [];
	$: focusedTurn = matches.length ? matches[Math.min(matchCursor, matches.length - 1)] : -1;

	let lastNeedle = '';
	$: if (needle !== lastNeedle) {
		lastNeedle = needle;
		matchCursor = 0;
	}

	// Matches are found across every turn, including ones the window has not rendered
	// yet, so the focused one has to be pulled in or there would be nothing to scroll to.
	$: if (focusedTurn >= turnsToShow) turnsToShow = focusedTurn + 10;

	// Find-in-page behaviour: move to the hit as the query is typed rather than waiting
	// for the next/previous buttons, debounced so the page does not chase every keystroke.
	let revealTimer;
	$: scheduleReveal(matches);

	function scheduleReveal(hits) {
		if (!browser) return;
		clearTimeout(revealTimer);
		if (!hits.length) return;
		revealTimer = setTimeout(() => scrollToTurn(hits[Math.min(matchCursor, hits.length - 1)]), 250);
	}

	function stepMatch(delta) {
		if (!matches.length) return;
		clearTimeout(revealTimer); // a deliberate step wins over a pending reveal
		matchCursor = (matchCursor + delta + matches.length) % matches.length;
		scrollToTurn(matches[matchCursor]);
	}

	function onSearchKeydown(e) {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		stepMatch(e.shiftKey ? -1 : 1);
	}

	// --- Navigation ---------------------------------------------------------
	// Turns past the rendered window have no row to scroll to yet, so grow the window
	// first and wait for Svelte to flush before looking the row up.
	async function scrollToTurn(index) {
		if (index < 0 || index >= turns.length) return;
		if (index >= turnsToShow) turnsToShow = index + 10;
		await tick();
		const rows = document.querySelectorAll('[data-reader-turn]');
		rows[index]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	function turnIndexAt(time) {
		const idx = turns.findIndex((turn, i) => {
			const next = turns[i + 1];
			return time >= turn.start && (!next || time < next.start);
		});
		if (idx !== -1) return idx;
		if (!turns.length) return -1;
		return time < turns[0].start ? 0 : turns.length - 1;
	}

	function goToPlayingTurn() {
		scrollToTurn(turnIndexAt($currentVideoPlayerTime));
	}

	// --- Player -------------------------------------------------------------
	let media;
	let canPlay = false;
	let paused = true;
	let everPlayed = false;
	let duration = 0;
	let mediaError = '';

	// Which turn the playhead currently sits in. Only meaningful once something has
	// played: before that the time is 0 and every transcript would light up its first turn.
	$: playingTurn = everPlayed ? turnIndexAt($currentVideoPlayerTime) : -1;

	$: mediaSrc = $currentTranscription
		? `${CLIENT_API_HOST}/api/video/${encodeURIComponent($currentTranscription.fileName)}`
		: '';

	const MEDIA_ERROR_LABELS = {
		1: 'Loading aborted',
		2: 'Network error',
		3: 'Decode error',
		4: 'Source not supported'
	};

	function handleMediaError() {
		const err = media?.error;
		mediaError = err
			? `${MEDIA_ERROR_LABELS[err.code] ?? 'Unknown error'}${err.message ? `: ${err.message}` : ''}`
			: 'Failed to load media';
		canPlay = false;
		console.error('Media element error:', err);
	}

	// play() returns a promise that rejects when the source never loaded; without a
	// catch that surfaces as an unhandled rejection on every click.
	function togglePlay() {
		if (!media) return;
		if (!media.paused) {
			media.pause();
			return;
		}
		const played = media.play();
		if (played && typeof played.catch === 'function') {
			played.catch((err) => {
				mediaError = err?.message ?? String(err);
				console.error('Audio playback failed:', err);
			});
		}
	}

	$: if (canPlay && media && Math.abs(media.currentTime - $currentVideoPlayerTime) > SEEK_TOLERANCE) {
		media.currentTime = $currentVideoPlayerTime;
	}

	function seekTo(time) {
		$currentVideoPlayerTime = time;
	}

	// Plays a voice sample from the speakers dialog, so a speaker can be recognised
	// by ear before naming them.
	function listenAt(time) {
		seekTo(time);
		if (media) media.currentTime = time;
		if (media?.paused) togglePlay();
	}

	function openSpeakers(label = null) {
		speakerFocus = label;
		speakersOpen = true;
	}

	function fmt(t) {
		if (!t && t !== 0) return '0:00';
		return Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
	}

	// --- Lazy rendering -----------------------------------------------------
	onMount(() => {
		observer = new IntersectionObserver((entries) => {
			entries.forEach((entry) => {
				if (entry.isIntersecting && turnsToShow < turns.length) {
					turnsToShow += TURNS_PER_PAGE;
				}
			});
		});
		if (loadMoreButton) observer.observe(loadMoreButton);
	});

	onDestroy(() => {
		observer?.disconnect();
		clearTimeout(revealTimer);
	});
</script>

<ModalDownloadOptions bind:open={downloadOpen} tr={$currentTranscription} preferredFormat="dialog" />
<ModalSpeakerNames
	bind:open={speakersOpen}
	tr={$currentTranscription}
	focusLabel={speakerFocus}
	onListen={listenAt}
	onSaved={(updated) => currentTranscription.set(updated)}
/>

{#if $currentTranscription.status != 2}
	<div class="flex items-center justify-center gap-3 py-20 text-muted-foreground">
		<Spinner size={24} />
		<p>{$_('reader.waiting')}</p>
	</div>
{:else}
	<!-- Header -->
	<div class="sticky top-0 z-10 border-b border-border bg-card/70 px-4 py-3 backdrop-blur-sm">
		<div class="mx-auto flex max-w-3xl flex-col gap-2.5">
			<div class="flex items-center justify-between gap-4">
				<div class="flex min-w-0 items-center gap-3">
					<a
						href="/"
						title={$_('reader.back')}
						aria-label={$_('reader.back')}
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground transition-all hover:scale-105 hover:bg-secondary hover:text-foreground active:scale-95"
					>
						<ArrowLeft size={16} />
					</a>
					<div class="min-w-0">
						<h1 class="truncate text-[1rem] font-semibold text-foreground" title={displayName}>
							{displayName}
						</h1>
						<p class="flex items-center gap-2 text-[0.7rem] text-muted-foreground">
							<span>{$_('reader.paragraphs', { values: { count: turns.length } })}</span>
							{#if speakerCount > 0}
								<span class="text-border">·</span>
								<button
									type="button"
									class="flex items-center gap-1 rounded underline-offset-2 transition-colors hover:text-foreground hover:underline"
									title={$_('reader.renameSpeakers')}
									on:click={() => openSpeakers()}
								>
									<Users size={11} />
									{$_('reader.speakers', { values: { count: speakerCount } })}
									<Pencil size={10} />
								</button>
							{/if}
						</p>
					</div>
				</div>

				<div class="flex shrink-0 items-center gap-1.5">
					<ThemeToggle />
					<a
						href={`/editor/${$currentTranscription.id}`}
						title={$_('reader.openEditor')}
						aria-label={$_('reader.openEditor')}
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground transition-all hover:scale-105 hover:bg-secondary hover:text-foreground active:scale-95"
					>
						<Pencil size={16} />
					</a>
					<IconButton
						variant="primary"
						title={$_('reader.download')}
						on:click={() => (downloadOpen = true)}
					>
						<Save size={16} />
					</IconButton>
				</div>
			</div>

			<div class="flex flex-wrap items-center gap-2">
				<SearchField
					class="min-w-[12rem] flex-1"
					bind:value={query}
					placeholder={$_('reader.search.placeholder')}
					on:keydown={onSearchKeydown}
					on:clear={() => (query = '')}
				/>

				{#if needle}
					<div
						class="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1.5"
					>
						<span class="px-1 text-[0.72rem] font-mono text-muted-foreground tabular-nums">
							{#if matches.length}
								{$_('reader.search.matches', {
									values: { current: matchCursor + 1, total: matches.length }
								})}
							{:else}
								{$_('reader.search.noMatches')}
							{/if}
						</span>
						<IconButton
							size="sm"
							title={$_('reader.search.prev')}
							disabled={!matches.length}
							on:click={() => stepMatch(-1)}
						>
							<ChevronUp size={14} />
						</IconButton>
						<IconButton
							size="sm"
							title={$_('reader.search.next')}
							disabled={!matches.length}
							on:click={() => stepMatch(1)}
						>
							<ChevronDown size={14} />
						</IconButton>
					</div>
				{/if}

				<GoToSegment
					{language}
					items={turns}
					rowSelector="[data-reader-turn]"
					segmentsToShow={turnsToShow}
					setSegmentsToShow={(v) => (turnsToShow = v)}
					alwaysSeek={true}
					labels={{
						placeholder: $_('reader.goTo.placeholder', { values: { max: turns.length } }),
						go: $_('reader.goTo.goToParagraph'),
						seek: $_('reader.goTo.goAndSeek')
					}}
				/>

				{#if $currentTranscription.translations.length > 0}
					<Select bind:value={language} class="w-auto min-w-[7rem] uppercase !py-2">
						<option value="original">✅ {$currentTranscription.result.language}</option>
						{#each $currentTranscription.translations as translation}
							<option value={translation.targetLanguage}>🤖 {translation.targetLanguage}</option>
						{/each}
					</Select>
				{/if}
			</div>
		</div>
	</div>

	<!-- Conversation -->
	<div class="mx-auto max-w-3xl px-4 pb-28 pt-5 sm:pl-12">
		{#if turns.length === 0}
			<p class="py-16 text-center text-[0.85rem] text-muted-foreground">{$_('reader.empty')}</p>
		{:else}
			<div class="space-y-1">
				{#each turns.slice(0, turnsToShow) as turn, index (turn.start + '-' + index)}
					<ReaderTurn
						{turn}
						index={index + 1}
						query={needle}
						focused={index === focusedTurn}
						playing={index === playingTurn}
						onSeek={seekTo}
						onRename={openSpeakers}
					/>
				{/each}
			</div>
		{/if}

		<button bind:this={loadMoreButton} class="w-full py-6 text-center text-[0.78rem] text-muted-foreground">
			{#if turnsToShow >= turns.length}
				{$_('reader.end')}
			{:else}
				{$_('reader.loadingMore')}
			{/if}
		</button>
	</div>

	<!-- Player -->
	<div class="fixed bottom-0 left-0 right-0 border-t border-border bg-card/80 p-3 backdrop-blur-md">
		<div class="mx-auto flex max-w-3xl items-center gap-3">
			<!-- No `type` hint: the file may be any of the supported audio formats, and a
			     wrong hint makes the browser skip the source. -->
			<audio
				bind:this={media}
				src={mediaSrc}
				preload="metadata"
				on:timeupdate={(e) => ($currentVideoPlayerTime = e.target.currentTime)}
				on:canplay={() => (canPlay = true)}
				on:loadedmetadata={(e) => {
					canPlay = true;
					duration = e.target.duration;
				}}
				on:play={() => {
					paused = false;
					everPlayed = true;
				}}
				on:pause={() => (paused = true)}
				on:error={handleMediaError}
				class="hidden"
			/>

			<button
				class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full shadow-lg transition-all {mediaError
					? 'border border-red-500/40 bg-red-500/20 text-red-400'
					: 'bg-primary text-primary-foreground shadow-primary/20 hover:bg-primary/90'}"
				title={mediaError || (paused ? $_('reader.play') : $_('reader.pause'))}
				aria-label={paused ? $_('reader.play') : $_('reader.pause')}
				disabled={!!mediaError}
				on:click={togglePlay}
			>
				{#if mediaError}
					<AlertTriangle size={16} />
				{:else if !canPlay}
					<Spinner size={16} />
				{:else if !paused}
					<Pause size={16} />
				{:else}
					<Play size={16} />
				{/if}
			</button>

			<div class="min-w-0 flex-1">
				{#if mediaError}
					<p class="truncate text-[0.75rem] font-mono text-red-400" title={mediaError}>
						{$_('reader.mediaError', { values: { error: mediaError } })}
					</p>
				{:else}
					<input
						type="range"
						class="w-full accent-[var(--primary)]"
						min="0"
						max="100"
						aria-label={$_('reader.seek')}
						value={duration ? ($currentVideoPlayerTime / duration) * 100 : 0}
						on:input={(e) => duration && ($currentVideoPlayerTime = (e.target.value / 100) * duration)}
					/>
					<div class="mt-0.5 flex justify-between text-[0.7rem] font-mono text-muted-foreground tabular-nums">
						<span>{fmt($currentVideoPlayerTime)}</span>
						<span>{fmt(duration)}</span>
					</div>
				{/if}
			</div>

			<IconButton variant="primary" title={$_('reader.locate')} on:click={goToPlayingTurn}>
				<LocateFixed size={16} />
			</IconButton>

			<Select class="w-auto !py-2" on:change={(e) => media && (media.playbackRate = e.target.value)}>
				<option value={0.5}>0.5x</option>
				<option value={0.75}>0.75x</option>
				<option value={1} selected>1x</option>
				<option value={1.25}>1.25x</option>
				<option value={1.5}>1.5x</option>
				<option value={2}>2x</option>
			</Select>
		</div>
	</div>
{/if}

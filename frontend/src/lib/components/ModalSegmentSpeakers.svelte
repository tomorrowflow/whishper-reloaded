<script>
	import { tick } from 'svelte';
	import toast from 'svelte-french-toast';
	import { _ } from 'svelte-i18n';
	import {
		saveSegmentSpeakers,
		speakerLabels,
		nextSpeakerLabel,
		speakerName,
		speakerPalette,
		formatClockTime
	} from '$lib/utils';
	import { currentVideoPlayerTime } from '$lib/stores';
	import Modal from './ui/Modal.svelte';
	import Button from './ui/Button.svelte';
	import MediaStatus from './MediaStatus.svelte';
	import Spinner from './ui/Spinner.svelte';
	import { isWaitingForAudio } from '$lib/resilientMedia';
	import { ArrowLeftRight, Pause, Play, X } from 'lucide-svelte';

	export let open = false;
	export let tr; // full transcription
	export let segments = []; // the segments being read (original or a translation)
	export let indices = []; // positions of the paragraph's segments in `segments`
	export let onListen = null; // (time) => void
	export let onTogglePlay = null; // () => void, pauses or resumes the recording
	export let paused = true; // whether the recording is currently paused
	export let mediaStatus = null; // see resilientMedia
	export let onSaved = null; // (transcription) => void

	// Diarization judged these sentences as one paragraph; each can be given its own
	// speaker here. Speakers are always the labels of the original transcription,
	// which translations share segment by segment.
	let drafts = {};
	let saving = false;
	// Set once a sentence was played from here; until then the playhead belongs to
	// the page behind the dialog and highlighting a row would be noise.
	let listened = false;
	let rowElements = {};

	$: names = tr?.speakerNames;
	$: original = tr?.result?.segments ?? [];
	$: labels = speakerLabels(original);
	$: newLabel = nextSpeakerLabel(original);
	$: rows = indices.map((index) => ({ index, segment: segments[index] })).filter((row) => row.segment);

	let wasOpen = false;
	$: if (open !== wasOpen) {
		wasOpen = open;
		if (open) {
			drafts = Object.fromEntries(rows.map((row) => [row.index, row.segment.speaker ?? '']));
		} else {
			// Don't leave the meeting playing once the dialog is gone.
			if (listened && !paused) onTogglePlay?.();
			listened = false;
		}
	}

	// The row under the playhead: from its start until the next row starts, so the
	// highlight doesn't flicker off in the pauses between sentences.
	$: playingRow = listened ? rowAt($currentVideoPlayerTime) : null;
	function rowAt(time) {
		for (let i = rows.length - 1; i >= 0; i--) {
			const { segment } = rows[i];
			if (time >= segment.start) {
				return i === rows.length - 1 && time > (segment.end ?? Infinity) ? null : rows[i].index;
			}
		}
		return null;
	}

	$: if (playingRow !== null && !paused) followRow(playingRow);
	async function followRow(index) {
		await tick();
		rowElements[index]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}

	function toggleRow(row) {
		if (playingRow === row.index && onTogglePlay) {
			onTogglePlay();
			return;
		}
		listened = true;
		onListen(row.segment.start);
	}

	$: changes = rows
		.filter((row) => drafts[row.index] && drafts[row.index] !== (row.segment.speaker ?? ''))
		.map((row) => ({ index: row.index, start: row.segment.start, speaker: drafts[row.index] }));

	async function save() {
		if (saving || !changes.length) return;
		saving = true;
		try {
			const updated = await saveSegmentSpeakers(tr.id, changes);
			onSaved?.(updated);
			toast.success($_('modals.segmentSpeakers.toasts.success'));
			open = false;
		} catch (error) {
			console.error('Error correcting speakers:', error);
			toast.error(
				String(error).includes('409')
					? $_('modals.segmentSpeakers.toasts.conflict')
					: $_('modals.segmentSpeakers.toasts.error')
			);
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:open size="lg" let:close>
	<div class="p-6">
		<div class="mb-2 flex items-center justify-between">
			<div class="flex items-center gap-2.5">
				<div class="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/25 bg-primary/15">
					<ArrowLeftRight size={14} class="text-primary" />
				</div>
				<h2 class="text-[0.95rem] font-semibold text-foreground">{$_('modals.segmentSpeakers.title')}</h2>
			</div>
			<button
				on:click={close}
				aria-label={$_('common.close')}
				class="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
			>
				<X size={14} />
			</button>
		</div>
		<p class="mb-3 text-[0.78rem] text-muted-foreground">{$_('modals.segmentSpeakers.hint')}</p>
		{#if onListen}<MediaStatus status={mediaStatus} class="mb-4" />{/if}

		<form class="space-y-2" on:submit|preventDefault={save}>
			{#each rows as row (row.index)}
				{@const palette = speakerPalette(drafts[row.index], names)}
				{@const changed = !!drafts[row.index] && drafts[row.index] !== (row.segment.speaker ?? '')}
				{@const isPlaying = playingRow === row.index}
				<div
					bind:this={rowElements[row.index]}
					class="flex flex-col gap-2 rounded-xl border p-3 transition-colors sm:flex-row sm:items-start {palette?.box ??
						''} {isPlaying
						? 'border-amber-400/40 bg-amber-500/10 ring-1 ring-amber-400/40'
						: `border-border ${palette?.tint ?? 'bg-muted/30'}`}"
				>
					<div class="flex min-w-0 flex-1 items-start gap-2">
						{#if onListen}
							{@const showPause = isPlaying && !paused}
							<button
								type="button"
								title={showPause ? $_('modals.speakers.pause') : $_('modals.segmentSpeakers.listen')}
								aria-label={showPause ? $_('modals.speakers.pause') : $_('modals.segmentSpeakers.listen')}
								aria-pressed={showPause}
								on:click={() => toggleRow(row)}
								class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors {showPause
									? 'bg-primary text-primary-foreground hover:bg-primary/90'
									: 'bg-primary/15 text-primary hover:bg-primary/25'}"
							>
								{#if isPlaying && !paused && isWaitingForAudio(mediaStatus)}
									<Spinner size={11} />
								{:else if showPause}
									<Pause size={11} />
								{:else}
									<Play size={11} />
								{/if}
							</button>
						{/if}
						<p class="min-w-0 text-[0.85rem] text-foreground">
							<span class="mr-1 font-mono text-[0.7rem] text-muted-foreground">{formatClockTime(row.segment.start)}</span>
							{row.segment.text.trim()}
						</p>
					</div>
					<div class="flex shrink-0 flex-col items-end gap-1">
						<select
							bind:value={drafts[row.index]}
							aria-label={$_('modals.segmentSpeakers.speakerFor', { values: { time: formatClockTime(row.segment.start) } })}
							class="rounded-lg border px-2.5 py-1.5 text-[0.8rem] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/35 {palette?.select ??
								'border-border bg-muted text-foreground'}"
						>
							{#each labels as label (label)}
								<option value={label}>{speakerName(label, names)}</option>
							{/each}
							<option value={newLabel}>{$_('modals.segmentSpeakers.newSpeaker', { values: { name: speakerName(newLabel) } })}</option>
						</select>
						{#if changed && row.segment.speaker}
							<span class="text-[0.68rem] line-through opacity-70 {speakerPalette(row.segment.speaker, names)?.text ?? 'text-muted-foreground'}">
								{speakerName(row.segment.speaker, names)}
							</span>
						{/if}
					</div>
				</div>
			{/each}

			<div class="flex items-center justify-end gap-2 pt-3">
				<Button variant="secondary" size="sm" on:click={close}>{$_('common.cancel')}</Button>
				<Button type="submit" size="sm" disabled={!changes.length || saving}>{$_('modals.segmentSpeakers.save')}</Button>
			</div>
		</form>
	</div>
</Modal>

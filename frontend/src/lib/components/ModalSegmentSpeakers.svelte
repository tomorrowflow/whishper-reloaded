<script>
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
	import Modal from './ui/Modal.svelte';
	import Button from './ui/Button.svelte';
	import { ArrowLeftRight, Play, X } from 'lucide-svelte';

	export let open = false;
	export let tr; // full transcription
	export let segments = []; // the segments being read (original or a translation)
	export let indices = []; // positions of the paragraph's segments in `segments`
	export let onListen = null; // (time) => void
	export let onSaved = null; // (transcription) => void

	// Diarization judged these sentences as one paragraph; each can be given its own
	// speaker here. Speakers are always the labels of the original transcription,
	// which translations share segment by segment.
	let drafts = {};
	let saving = false;

	$: names = tr?.speakerNames;
	$: original = tr?.result?.segments ?? [];
	$: labels = speakerLabels(original);
	$: newLabel = nextSpeakerLabel(original);
	$: rows = indices.map((index) => ({ index, segment: segments[index] })).filter((row) => row.segment);

	let wasOpen = false;
	$: if (open !== wasOpen) {
		wasOpen = open;
		if (open) drafts = Object.fromEntries(rows.map((row) => [row.index, row.segment.speaker ?? '']));
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
		<p class="mb-5 text-[0.78rem] text-muted-foreground">{$_('modals.segmentSpeakers.hint')}</p>

		<form class="space-y-2" on:submit|preventDefault={save}>
			{#each rows as row (row.index)}
				{@const palette = speakerPalette(drafts[row.index], names)}
				<div class="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 p-3 sm:flex-row sm:items-start {palette?.box ?? ''}">
					<div class="flex min-w-0 flex-1 items-start gap-2">
						{#if onListen}
							<button
								type="button"
								title={$_('modals.segmentSpeakers.listen')}
								aria-label={$_('modals.segmentSpeakers.listen')}
								on:click={() => onListen(row.segment.start)}
								class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary transition-colors hover:bg-primary/25"
							>
								<Play size={11} />
							</button>
						{/if}
						<p class="min-w-0 text-[0.85rem] text-foreground">
							<span class="mr-1 font-mono text-[0.7rem] text-muted-foreground">{formatClockTime(row.segment.start)}</span>
							{row.segment.text.trim()}
						</p>
					</div>
					<select
						bind:value={drafts[row.index]}
						aria-label={$_('modals.segmentSpeakers.speakerFor', { values: { time: formatClockTime(row.segment.start) } })}
						class="shrink-0 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-[0.8rem] font-medium focus:outline-none focus:ring-2 focus:ring-primary/35 {palette?.text ?? 'text-foreground'}"
					>
						{#each labels as label (label)}
							<option value={label}>{speakerName(label, names)}</option>
						{/each}
						<option value={newLabel}>{$_('modals.segmentSpeakers.newSpeaker', { values: { name: speakerName(newLabel) } })}</option>
					</select>
				</div>
			{/each}

			<div class="flex items-center justify-end gap-2 pt-3">
				<Button variant="secondary" size="sm" on:click={close}>{$_('common.cancel')}</Button>
				<Button type="submit" size="sm" disabled={!changes.length || saving}>{$_('modals.segmentSpeakers.save')}</Button>
			</div>
		</form>
	</div>
</Modal>

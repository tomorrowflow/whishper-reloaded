<script>
	import { tick } from 'svelte';
	import toast from 'svelte-french-toast';
	import { _ } from 'svelte-i18n';
	import { saveSpeakerNames, mergeSpeakers, speakerName, speakerPalette, formatClockTime } from '$lib/utils';
	import Modal from './ui/Modal.svelte';
	import Button from './ui/Button.svelte';
	import { Combine, Pause, Play, Users, X } from 'lucide-svelte';

	export let open = false;
	export let tr; // full transcription, with result.segments and speakerNames
	export let focusLabel = null; // raw label whose input gets the focus on open
	export let onListen = null; // (time) => void, plays the recording from `time`
	export let onTogglePlay = null; // () => void, pauses or resumes the recording
	export let paused = true; // whether the recording is currently paused
	export let onSaved = null; // (transcription) => void

	// Names are always edited on the raw diarization labels, never on the merged
	// speakers: that keeps a merge reversible, by giving a label its own name again.
	let drafts = {};
	let saving = false;
	let listening = null; // label whose voice sample was started last

	// Joining is permanent (segments are relabelled), so picking a target only asks;
	// the join happens once the row's confirmation is accepted.
	let join = null; // { from, into } awaiting confirmation
	let joining = false;

	function askJoin(from, into) {
		join = into ? { from, into } : null;
	}

	async function confirmJoin() {
		if (!join || joining) return;
		joining = true;
		const { from, into } = join;
		try {
			const updated = await mergeSpeakers(tr.id, [from], into);
			// Keep unsaved names typed for the other speakers; the joined one is gone.
			const { [from]: _gone, ...rest } = drafts;
			drafts = rest;
			if (listening === from) listening = null;
			onSaved?.(updated);
			toast.success($_('modals.speakers.join.toasts.success', { values: { from: displayName(from), into: displayName(into) } }));
		} catch (error) {
			console.error('Error joining speakers:', error);
			toast.error($_('modals.speakers.join.toasts.error'));
		} finally {
			joining = false;
			join = null;
		}
	}

	// What the user currently calls a speaker: a typed name, else the default.
	const displayName = (label) => speakerName(label, draftNames);

	// The sample button mirrors the player: the sample being heard shows pause, and
	// the same button resumes it. Any other sample starts from its own sentence.
	function toggleSample(speaker) {
		if (listening === speaker.label && onTogglePlay) {
			onTogglePlay();
			return;
		}
		listening = speaker.label;
		onListen(speaker.sample.start);
	}

	$: speakers = collectSpeakers(tr?.result?.segments ?? []);

	// One entry per diarization label, in order of first appearance, with how much
	// that voice speaks and its longest sentence as a sample to recognise it by.
	function collectSpeakers(segments) {
		const byLabel = new Map();
		for (const segment of segments) {
			if (!segment.speaker) continue;
			let entry = byLabel.get(segment.speaker);
			if (!entry) {
				entry = { label: segment.speaker, seconds: 0, segments: 0, sample: null };
				byLabel.set(segment.speaker, entry);
			}
			entry.seconds += Math.max(0, segment.end - segment.start);
			entry.segments += 1;
			const text = (segment.text ?? '').trim();
			if (!entry.sample || text.length > entry.sample.text.length) {
				entry.sample = { text, start: segment.start };
			}
		}
		return [...byLabel.values()];
	}

	let wasOpen = false;
	$: if (open !== wasOpen) {
		wasOpen = open;
		if (open) {
			reset();
		} else {
			// A sample is only for recognising a voice; don't leave the meeting playing
			// once the dialog is gone.
			if (listening && !paused) onTogglePlay?.();
			listening = null;
		}
	}

	async function reset() {
		drafts = Object.fromEntries(speakers.map((s) => [s.label, tr?.speakerNames?.[s.label] ?? '']));
		await tick();
		const target = focusLabel ?? speakers[0]?.label;
		document.getElementById(inputId(target))?.focus();
	}

	const inputId = (label) => `speaker-name-${label}`;

	function formatDuration(seconds) {
		const minutes = Math.floor(seconds / 60);
		return minutes > 0 ? `${minutes}m ${Math.round(seconds % 60)}s` : `${Math.round(seconds)}s`;
	}

	// Live preview of what a label will be called and coloured once saved, so a
	// merge is visible before committing to it.
	$: draftNames = Object.fromEntries(
		Object.entries(drafts).filter(([, name]) => name.trim() !== '')
	);
	$: mergedCount = new Set(speakers.map((s) => speakerName(s.label, draftNames))).size;
	$: changed = speakers.some((s) => (drafts[s.label] ?? '').trim() !== (tr?.speakerNames?.[s.label] ?? ''));
	async function save() {
		if (saving || !changed) return;
		saving = true;
		try {
			const updated = await saveSpeakerNames(tr.id, draftNames);
			onSaved?.(updated);
			toast.success($_('modals.speakers.toasts.success'));
			open = false;
		} catch (error) {
			console.error('Error saving speaker names:', error);
			toast.error($_('modals.speakers.toasts.error'));
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
					<Users size={14} class="text-primary" />
				</div>
				<h2 class="text-[0.95rem] font-semibold text-foreground">{$_('modals.speakers.title')}</h2>
			</div>
			<button
				on:click={close}
				aria-label={$_('common.close')}
				class="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
			>
				<X size={14} />
			</button>
		</div>
		<p class="mb-5 text-[0.78rem] text-muted-foreground">{$_('modals.speakers.hint')}</p>

		<form class="space-y-2.5" on:submit|preventDefault={save}>
			{#each speakers as speaker (speaker.label)}
				{@const palette = speakerPalette(speaker.label, draftNames)}
				<div class="rounded-xl border border-border bg-muted/30 py-3 pl-3 pr-3 {palette?.box ?? ''}">
					<div class="flex flex-wrap items-center gap-2.5">
						<label
							for={inputId(speaker.label)}
							class="w-24 shrink-0 text-[0.8rem] font-semibold {palette?.text ?? 'text-foreground'}"
						>
							{speakerName(speaker.label)}
						</label>
						<input
							id={inputId(speaker.label)}
							type="text"
							maxlength="80"
							bind:value={drafts[speaker.label]}
							placeholder={speakerName(speaker.label)}
							class="min-w-[10rem] flex-1 rounded-lg border border-border bg-muted px-3 py-2 text-[0.85rem] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/35"
						/>
						<span class="shrink-0 text-[0.7rem] font-mono text-muted-foreground tabular-nums">
							{$_('modals.speakers.stats', {
								values: { duration: formatDuration(speaker.seconds), count: speaker.segments }
							})}
						</span>
						{#if speakers.length > 1}
							<label class="relative shrink-0" title={$_('modals.speakers.join.label')}>
								<span class="sr-only">{$_('modals.speakers.join.label')}</span>
								<Combine size={12} class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
								<select
									value={join?.from === speaker.label ? join.into : ''}
									disabled={joining}
									on:change={(e) => askJoin(speaker.label, e.currentTarget.value)}
									class="appearance-none rounded-lg border border-border bg-muted py-1.5 pl-6 pr-2 text-[0.72rem] text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/35"
								>
									<option value="">{$_('modals.speakers.join.placeholder')}</option>
									{#each speakers.filter((other) => other.label !== speaker.label) as other (other.label)}
										<option value={other.label}>{displayName(other.label)}</option>
									{/each}
								</select>
							</label>
						{/if}
					</div>
					{#if join?.from === speaker.label}
						<div
							class="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2"
							role="alert"
						>
							<p class="text-[0.78rem] text-foreground">
								{$_('modals.speakers.join.confirm', {
									values: { from: displayName(join.from), into: displayName(join.into), count: speaker.segments }
								})}
							</p>
							<div class="flex shrink-0 items-center gap-2">
								<Button variant="secondary" size="sm" on:click={() => (join = null)} disabled={joining}>
									{$_('common.cancel')}
								</Button>
								<Button size="sm" on:click={confirmJoin} disabled={joining}>
									<Combine size={13} />
									{$_('modals.speakers.join.action')}
								</Button>
							</div>
						</div>
					{/if}
					{#if speaker.sample?.text}
						<div class="mt-2 flex items-start gap-2 pl-[6.6rem] max-sm:pl-0">
							{#if onListen}
								{@const playing = listening === speaker.label && !paused}
								<button
									type="button"
									title={playing ? $_('modals.speakers.pause') : $_('modals.speakers.listen')}
									aria-label={playing ? $_('modals.speakers.pause') : $_('modals.speakers.listen')}
									aria-pressed={playing}
									on:click={() => toggleSample(speaker)}
									class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors {playing
										? 'bg-primary text-primary-foreground hover:bg-primary/90'
										: 'bg-primary/15 text-primary hover:bg-primary/25'}"
								>
									{#if playing}<Pause size={11} />{:else}<Play size={11} />{/if}
								</button>
							{/if}
							<p class="line-clamp-2 text-[0.78rem] italic text-muted-foreground">
								<span class="not-italic font-mono text-[0.7rem]">{formatClockTime(speaker.sample.start)}</span>
								„{speaker.sample.text}“
							</p>
						</div>
					{/if}
				</div>
			{/each}

			<div class="flex items-center justify-between gap-2 pt-3">
				<span class="text-[0.75rem] text-muted-foreground">
					{#if mergedCount < speakers.length}
						{$_('modals.speakers.merged', { values: { from: speakers.length, to: mergedCount } })}
					{/if}
				</span>
				<div class="flex items-center gap-2">
					<Button variant="secondary" size="sm" on:click={close}>{$_('common.cancel')}</Button>
					<Button type="submit" size="sm" disabled={!changed || saving}>{$_('modals.speakers.save')}</Button>
				</div>
			</div>
		</form>
	</div>
</Modal>

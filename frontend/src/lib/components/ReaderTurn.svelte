<script>
	import { speakerPalette, formatClockTime } from '$lib/utils';
	import { _ } from 'svelte-i18n';
	import { Pencil } from 'lucide-svelte';

	// One turn of the conversation: everything a speaker said before the next
	// person took over. Read-only by design — no timing inputs, no per-segment
	// statistics, nothing to edit.
	export let turn;
	export let index; // 1-based position, matching what the paragraph picker expects
	export let query = ''; // lowercase search needle, '' when not searching
	export let focused = false; // the search match currently being stepped through
	export let playing = false; // the turn the media is currently inside
	export let onSeek = null;
	export let onRename = null; // (label) => void, opens the speaker names dialog

	$: palette = speakerPalette(turn.label);

	// The whole paragraph jumps the player to it, except when the click ends a text
	// selection (copying a quote) or lands on one of the paragraph's own buttons.
	function onParagraphClick(e) {
		if (!onSeek || e.target.closest('button')) return;
		if (window.getSelection()?.toString()) return;
		onSeek(turn.start);
	}
	$: parts = splitOnQuery(turn.text, query);

	// Splits the text around every occurrence of the needle so matches can be marked
	// up without handing raw transcript text to the DOM as HTML.
	function splitOnQuery(text, needle) {
		if (!needle) return [{ text, hit: false }];

		const parts = [];
		const haystack = text.toLowerCase();
		let from = 0;

		while (from <= text.length) {
			const at = haystack.indexOf(needle, from);
			if (at === -1) {
				if (from < text.length) parts.push({ text: text.slice(from), hit: false });
				break;
			}
			if (at > from) parts.push({ text: text.slice(from, at), hit: false });
			parts.push({ text: text.slice(at, at + needle.length), hit: true });
			from = at + needle.length;
		}

		return parts;
	}
</script>

<!-- Mouse convenience only: the header button below is the keyboard-accessible way
     to jump here, so the container needs no role or key handler of its own. -->
<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div
	data-reader-turn
	data-start={turn.start}
	on:click={onParagraphClick}
	class="group relative cursor-pointer rounded-r-xl pl-4 pr-4 py-2.5 transition-colors {palette
		? palette.box
		: 'border-l-4 border-l-border'} {focused
		? 'bg-primary/10 ring-1 ring-primary/30'
		: playing
		? 'bg-amber-500/10 ring-1 ring-amber-400/40'
		: 'hover:bg-muted/40'}"
>
	<!-- Paragraph number, revealed on hover so the picker is usable without
	     putting a column of numbers into the reading flow. -->
	<span
		class="absolute -left-9 top-3 hidden w-7 text-right text-[0.65rem] font-mono text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 sm:block tabular-nums"
		aria-hidden="true"
	>
		{index}
	</span>

	<div class="mb-1 flex items-baseline gap-1.5">
		<button
			type="button"
			class="group/head flex items-baseline gap-2.5 text-left"
			title={$_('reader.seekHere')}
			on:click={() => onSeek && onSeek(turn.start)}
		>
			{#if turn.speaker}
				<span class="text-[0.8rem] font-semibold {palette ? palette.text : 'text-foreground'}">
					{turn.speaker}
				</span>
			{/if}
			<span
				class="text-[0.7rem] font-mono text-muted-foreground transition-colors group-hover/head:text-foreground tabular-nums"
			>
				{formatClockTime(turn.start)}
			</span>
		</button>
		{#if turn.speaker && onRename}
			<button
				type="button"
				class="self-center rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
				title={$_('reader.renameSpeaker', { values: { name: turn.speaker } })}
				aria-label={$_('reader.renameSpeaker', { values: { name: turn.speaker } })}
				on:click={() => onRename(turn.label)}
			>
				<Pencil size={11} />
			</button>
		{/if}
	</div>

	<p class="text-[0.95rem] leading-7 text-foreground/90">
		{#each parts as part}
			{#if part.hit}
				<mark class="rounded bg-amber-400/30 px-0.5 text-foreground">{part.text}</mark>
			{:else}
				{part.text}
			{/if}
		{/each}
	</p>
</div>

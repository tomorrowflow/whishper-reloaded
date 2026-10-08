<script>
	import {
		downloadSRT,
		downloadTXT,
		downloadJSON,
		downloadVTT,
		downloadSpeakerTranscript,
		buildSpeakerTranscript,
		hasSpeakers,
		CLIENT_API_HOST
	} from '$lib/utils';
	import toast from 'svelte-french-toast';
	import { _ } from 'svelte-i18n';
	import Modal from './ui/Modal.svelte';
	import Checkbox from './ui/Checkbox.svelte';
	import Spinner from './ui/Spinner.svelte';
	import { X, Download, Copy, Film, Check } from 'lucide-svelte';

	export let open = false;
	export let tr;
	// A caller can suggest the format to start on — the reading view opens on the
	// speaker transcript, since that is what it shows on screen. Only a suggestion:
	// it is applied when the modal opens and the user can switch afterwards.
	export let preferredFormat = null;

	const BASE_FORMATS = ['srt', 'vtt', 'json', 'txt'];

	let subtitleFormat = 'srt';
	let language = 'original';
	let includeWords = false;
	let includeSpeakers = true;
	let dialogTimestamps = true;
	let copied = false;

	// Resolves the segments and text of the currently picked language. The original
	// transcription and every translation share the same shape, and a translation
	// inherits the speaker labels of the segments it was built from.
	function resolveSelection(transcription, lang) {
		if (!transcription) return { segments: [], text: '', title: 'subtitles' };

		const title = transcription.fileName.split('_WHSHPR_')[1];
		const empty = { segments: [], text: '', title };

		if (lang == 'original') {
			return { ...empty, segments: transcription.result.segments ?? [], text: transcription.result.text ?? '' };
		}

		for (const translation of transcription.translations) {
			if (translation.targetLanguage == lang) {
				return { ...empty, segments: translation.result.segments ?? [], text: translation.result.text ?? '' };
			}
		}

		return empty;
	}

	$: selection = resolveSelection(tr, language);
	$: speakersAvailable = hasSpeakers(selection.segments);
	// The speaker transcript only exists for diarized runs, so it is offered
	// alongside the plain formats instead of replacing one of them.
	$: formats = speakersAvailable ? [...BASE_FORMATS, 'dialog'] : BASE_FORMATS;
	$: if (!speakersAvailable && subtitleFormat == 'dialog') subtitleFormat = 'srt';
	$: speakerLabelsApply = speakersAvailable && (subtitleFormat == 'srt' || subtitleFormat == 'vtt');

	let wasOpen = false;
	$: if (open !== wasOpen) {
		wasOpen = open;
		if (open && preferredFormat && formats.includes(preferredFormat)) subtitleFormat = preferredFormat;
	}

	function speakerOptions() {
		return {
			timestamps: dialogTimestamps,
			names: tr?.speakerNames,
			unknownLabel: $_('modals.download.unknownSpeaker')
		};
	}

	function downloadSubtitle() {
		const { segments, text, title } = selection;

		if (subtitleFormat == 'dialog') {
			if (segments.length == 0) {
				toast.error($_('modals.download.toasts.noData'));
				return;
			}
			downloadSpeakerTranscript(segments, title, speakerOptions());
			return;
		}

		if (segments.length == 0 || text == '') {
			toast.error($_('modals.download.toasts.noData'));
			return;
		}

		if (subtitleFormat == 'srt') {
			downloadSRT(segments, title, includeSpeakers, tr.speakerNames);
		} else if (subtitleFormat == 'vtt') {
			downloadVTT(segments, title, includeSpeakers, tr.speakerNames);
		} else if (subtitleFormat == 'json') {
			downloadJSON(tr.result, title, includeWords);
		} else if (subtitleFormat == 'txt') {
			downloadTXT(text, title);
		}
	}

	function downloadMedia() {
		let link = document.createElement('a');
		link.href = `${CLIENT_API_HOST}/api/video/${tr.fileName}`;
		link.target = '_blank';
		link.download = tr.fileName.split('_WHSHPR_')[1] + '.mp4';
		link.click();
	}

	async function copyText() {
		// Copying follows the picked format, so the speaker transcript can be pasted
		// straight into a document instead of having to go through a file.
		let text =
			subtitleFormat == 'dialog'
				? buildSpeakerTranscript(selection.segments, speakerOptions())
				: selection.text;

		if (text == '') {
			toast.error($_('modals.download.toasts.noData'));
			return;
		}

		try {
			await navigator.clipboard.writeText(text);
			toast.success($_('modals.download.toasts.copied'));
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch (err) {
			console.error('Error in copying text: ', err);
		}
	}
</script>

<Modal bind:open size="md" let:close>
	<div class="p-6">
		<div class="flex items-start justify-between mb-6">
			<div>
				<h2 class="text-foreground text-[0.95rem] font-semibold">{$_('modals.download.title')}</h2>
				{#if tr}
					<p class="text-muted-foreground text-[0.72rem] font-mono mt-0.5 truncate max-w-[16rem]">
						{tr.fileName.split('_WHSHPR_')[1]}
					</p>
				{/if}
			</div>
			<button
				on:click={close}
				class="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-all shrink-0"
			>
				<X size={14} />
			</button>
		</div>

		{#if tr}
			<div class="space-y-4 mb-7">
				<!-- Format -->
				<div>
					<p class="text-muted-foreground mb-2 text-[0.72rem] uppercase tracking-wider">{$_('modals.download.fileFormat')}</p>
					<div class="flex items-center gap-1.5 flex-wrap">
						{#each formats as f}
							<button
								on:click={() => (subtitleFormat = f)}
								class="px-3 py-1.5 rounded-lg border transition-all text-[0.78rem] font-medium uppercase {subtitleFormat ===
								f
									? 'bg-primary border-primary/50 text-primary-foreground shadow-lg shadow-primary/20'
									: 'border-border bg-muted text-muted-foreground hover:text-foreground hover:border-border/80'}"
							>
								{f}
							</button>
						{/each}
					</div>
				</div>

				<!-- Language -->
				<div>
					<p class="text-muted-foreground mb-2 text-[0.72rem] uppercase tracking-wider">{$_('modals.download.textLanguage')}</p>
					<div class="flex items-center gap-1.5 flex-wrap">
						<button
							on:click={() => (language = 'original')}
							class="px-3 py-1.5 rounded-lg border transition-all text-[0.78rem] font-medium uppercase {language ===
							'original'
								? 'bg-primary border-primary/50 text-primary-foreground shadow-lg shadow-primary/20'
								: 'border-border bg-muted text-muted-foreground hover:text-foreground hover:border-border/80'}"
						>
							{tr.result.language}
						</button>
						{#each tr.translations as translation}
							<button
								on:click={() => (language = translation.targetLanguage)}
								class="px-3 py-1.5 rounded-lg border transition-all text-[0.78rem] font-medium uppercase {language ===
								translation.targetLanguage
									? 'bg-primary border-primary/50 text-primary-foreground shadow-lg shadow-primary/20'
									: 'border-border bg-muted text-muted-foreground hover:text-foreground hover:border-border/80'}"
							>
								{translation.targetLanguage}
							</button>
						{/each}
					</div>
				</div>

				{#if subtitleFormat === 'json'}
					<label class="flex items-center gap-2 cursor-pointer">
						<Checkbox bind:checked={includeWords} />
						<span class="text-muted-foreground text-[0.78rem]">{$_('modals.download.includeWords')}</span>
					</label>
				{/if}

				{#if subtitleFormat === 'dialog'}
					<p class="text-muted-foreground text-[0.72rem] leading-relaxed">
						{$_('modals.download.dialogHint')}
					</p>
					<label class="flex items-center gap-2 cursor-pointer">
						<Checkbox bind:checked={dialogTimestamps} />
						<span class="text-muted-foreground text-[0.78rem]">{$_('modals.download.includeTimestamps')}</span>
					</label>
				{/if}

				{#if speakerLabelsApply}
					<label class="flex items-center gap-2 cursor-pointer">
						<Checkbox bind:checked={includeSpeakers} />
						<span class="text-muted-foreground text-[0.78rem]">{$_('modals.download.includeSpeakers')}</span>
					</label>
				{/if}
			</div>

			<!-- Actions -->
			<div class="grid grid-cols-3 gap-2">
				<button
					on:click={downloadSubtitle}
					title={$_('modals.download.tooltipFile', { values: { format: subtitleFormat, language } })}
					class="flex flex-col items-center gap-2 py-3.5 rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:border-emerald-500/40 transition-all hover:scale-[1.02] active:scale-[0.98]"
				>
					<Download size={17} />
					<span class="text-[0.7rem] font-semibold tracking-wider">{$_('modals.download.file')}</span>
				</button>
				<button
					on:click={copyText}
					title={$_('modals.download.tooltipCopy', { values: { language } })}
					class="flex flex-col items-center gap-2 py-3.5 rounded-xl border transition-all hover:scale-[1.02] active:scale-[0.98] {copied
						? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
						: 'border-blue-500/20 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 hover:border-blue-500/40'}"
				>
					{#if copied}<Check size={17} />{:else}<Copy size={17} />{/if}
					<span class="text-[0.7rem] font-semibold tracking-wider">{$_('modals.download.copy')}</span>
				</button>
				<button
					on:click={downloadMedia}
					title={$_('modals.download.tooltipMedia')}
					class="flex flex-col items-center gap-2 py-3.5 rounded-xl border border-violet-500/20 bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 hover:border-violet-500/40 transition-all hover:scale-[1.02] active:scale-[0.98]"
				>
					<Film size={17} />
					<span class="text-[0.7rem] font-semibold tracking-wider">{$_('modals.download.media')}</span>
				</button>
			</div>
		{:else}
			<div class="flex items-center justify-center py-12 text-muted-foreground">
				<Spinner size={28} />
			</div>
		{/if}
	</div>
</Modal>

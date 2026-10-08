<script>
	import { editorSettings, currentTranscription, currentVideoPlayerTime } from '$lib/stores';
	import { _ } from 'svelte-i18n';
	import IconButton from './ui/IconButton.svelte';
	import { ArrowRight, LocateFixed } from 'lucide-svelte';
	export let language;
	export let segmentsToShow;
	export let setSegmentsToShow;
	// When set, navigate this list instead of deriving segments from the transcription.
	// The reading view passes its merged speaker turns so the picker steps through
	// paragraphs of the conversation rather than subtitle cues.
	export let items = null;
	export let rowSelector = '[data-segment-row]';
	// Wording is caller-supplied because "segment" is the wrong noun in the reader.
	export let labels = null;
	// The reader has no editor settings to honour, but always wants the seek.
	export let alwaysSeek = false;

	let segmentIndex = '';

	$: texts =
		labels ?? {
			placeholder: $_('editor.goTo.placeholder', { values: { max: getCurrentSegments().length } }),
			go: $_('editor.goTo.goToSegment'),
			seek: $_('editor.goTo.goAndSeek')
		};

	function navigateToSegment() {
		const index = parseInt(segmentIndex);
		if (index > 0 && index <= getCurrentSegments().length) {
			if (index > segmentsToShow) {
				setSegmentsToShow(index + 10);
				setTimeout(() => {
					scrollToSegmentRow(index);
				}, 200);
			} else {
				scrollToSegmentRow(index);
			}
		}
	}

	function scrollToSegmentRow(index) {
		let allRows = document.querySelectorAll(rowSelector);
		const targetSegmentRow = allRows[index - 1]; // Convert to 0-based index

		if (targetSegmentRow) {
			targetSegmentRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
			targetSegmentRow.classList.add('ring-2', 'ring-primary');
			setTimeout(() => {
				targetSegmentRow.classList.remove('ring-2', 'ring-primary');
			}, 2000);
		} else {
			setTimeout(() => {
				const retryRows = document.querySelectorAll(rowSelector);
				const retryTargetRow = retryRows[index - 1];
				if (retryTargetRow) {
					retryTargetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
					retryTargetRow.classList.add('ring-2', 'ring-primary');
					setTimeout(() => {
						retryTargetRow.classList.remove('ring-2', 'ring-primary');
					}, 2000);
				}
			}, 300);
		}
	}

	function getCurrentSegments() {
		if (items) return items;
		if (language === 'original') {
			return $currentTranscription.result.segments;
		} else {
			return (
				$currentTranscription.translations.filter(
					(translation) => translation.targetLanguage === language
				)[0]?.result.segments || []
			);
		}
	}
</script>

<div class="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-border bg-muted/50">
	<input
		type="number"
		min="0"
		max={getCurrentSegments().length}
		placeholder={texts.placeholder}
		bind:value={segmentIndex}
		on:keydown={(e) => e.key === 'Enter' && navigateToSegment()}
		class="w-24 px-2 py-1.5 rounded-md bg-muted border border-border text-foreground text-[0.78rem] focus:outline-none focus:ring-2 focus:ring-primary/40"
	/>
	<IconButton
		variant="primary"
		title={texts.go}
		on:click={navigateToSegment}
		disabled={!segmentIndex || parseInt(segmentIndex) < 0 || parseInt(segmentIndex) > getCurrentSegments().length}
	>
		<ArrowRight size={15} />
	</IconButton>
	<IconButton
		variant="primary"
		title={texts.seek}
		on:click={() => {
			navigateToSegment();
			// The input is 1-based, like the row the arrow button scrolls to.
			if ((alwaysSeek || $editorSettings.seekOnClick) && segmentIndex) {
				$currentVideoPlayerTime = getCurrentSegments()[parseInt(segmentIndex) - 1]?.start;
			}
		}}
		disabled={!segmentIndex || parseInt(segmentIndex) < 1 || parseInt(segmentIndex) > getCurrentSegments().length}
	>
		<LocateFixed size={15} />
	</IconButton>
</div>

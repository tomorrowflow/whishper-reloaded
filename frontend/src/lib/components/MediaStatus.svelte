<script>
	import { onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { CircleCheck, Download, Radio, WifiOff } from 'lucide-svelte';
	import Spinner from './ui/Spinner.svelte';
	import { isWaitingForAudio } from '$lib/resilientMedia';

	/** @type {import('$lib/resilientMedia').MediaStatus | null} */
	export let status = null;
	// For overlays: show nothing once playback is fine and the download is settled.
	export let hideWhenSettled = false;
	let className = '';
	export { className as class };

	// Ticks once a second while a retry is scheduled, for the countdown.
	let now = Date.now();
	let clock;
	$: if (status?.retryAt && !clock) {
		now = Date.now();
		clock = setInterval(() => (now = Date.now()), 1000);
	} else if (!status?.retryAt && clock) {
		clock = clearInterval(clock);
	}
	onDestroy(() => clearInterval(clock));

	const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

	$: percent = status?.total ? Math.floor((status.saved / status.total) * 100) : 0;
	$: seconds = status?.retryAt ? Math.max(0, Math.ceil((status.retryAt - now) / 1000)) : 0;
	$: trouble = isWaitingForAudio(status);
	$: showBar = status && (status.save === 'saving' || status.save === 'waiting') && status.total > 0;
</script>

{#if status && status.connection !== 'failed' && !(hideWhenSettled && !trouble && (status.save === 'saved' || status.save === 'unavailable'))}
	<div class="min-w-0 {className}">
		<p
			class="flex min-w-0 items-center gap-1.5 text-[0.7rem] {status.connection === 'reconnecting' ||
			(!trouble && status.save === 'waiting')
				? 'text-amber-500'
				: !trouble && status.save === 'saved'
					? 'text-emerald-500'
					: 'text-muted-foreground'}"
		>
			{#if status.connection === 'reconnecting'}
				<WifiOff size={12} class="shrink-0" />
				<span class="truncate">
					{seconds ? $_('media.retryIn', { values: { seconds } }) : $_('media.reconnecting')}
				</span>
			{:else if status.connection === 'loading' || status.connection === 'buffering'}
				<Spinner size={12} class="shrink-0" />
				<span class="truncate">
					{status.connection === 'loading' ? $_('media.connecting') : $_('media.buffering')}
				</span>
			{:else if status.save === 'saving'}
				<Download size={12} class="shrink-0" />
				<span class="truncate">
					{$_('media.saving', { values: { percent } })}{#if status.total}
						<span class="font-mono tabular-nums">
							{' · '}{$_('media.savingSize', { values: { saved: mb(status.saved), total: mb(status.total) } })}</span
						>{/if}
				</span>
			{:else if status.save === 'waiting'}
				<WifiOff size={12} class="shrink-0" />
				<span class="truncate">{$_('media.saveWaiting', { values: { percent } })}</span>
			{:else if status.save === 'saved'}
				<CircleCheck size={12} class="shrink-0" />
				<span class="truncate">{$_('media.saved')}</span>
			{:else}
				<Radio size={12} class="shrink-0" />
				<span class="truncate">{$_('media.streaming')}</span>
			{/if}
		</p>
		{#if showBar}
			<div class="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-border">
				<div
					class="h-full rounded-full transition-[width] duration-300 {status.save === 'waiting'
						? 'bg-amber-500'
						: 'bg-primary'}"
					style="width: {percent}%"
				/>
			</div>
		{/if}
	</div>
{/if}

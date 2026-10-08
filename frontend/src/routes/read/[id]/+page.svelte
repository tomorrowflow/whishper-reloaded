<script>
	import { Toaster } from 'svelte-french-toast';
	import Reader from '$lib/components/Reader.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { currentTranscription } from '$lib/stores';
</script>

<Toaster
	toastOptions={{
		style: 'background: var(--card); color: var(--foreground); border: 1px solid var(--border);'
	}}
/>

{#if $currentTranscription}
	<div class="min-h-screen bg-background">
		<Reader />
	</div>
{:else}
	<div class="flex h-screen w-screen items-center justify-center bg-background text-muted-foreground">
		<Spinner size={40} />
	</div>
{/if}

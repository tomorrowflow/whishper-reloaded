<script>
	import { tick } from 'svelte';
	import toast from 'svelte-french-toast';
	import { _ } from 'svelte-i18n';
	import { pendingDelete } from '$lib/stores';
	import { deleteTranscription } from '$lib/utils.js';
	import Modal from './ui/Modal.svelte';
	import Button from './ui/Button.svelte';
	import { Trash2, X } from 'lucide-svelte';

	// Opened by requestDelete(tr) from any transcription row; closing clears the request.
	let open = false;
	let deleting = false;
	let confirmButton;

	$: tr = $pendingDelete;
	$: if (tr) show();

	async function show() {
		open = true;
		await tick();
		confirmButton?.focus();
	}

	$: displayName = tr ? tr.fileName.split('_WHSHPR_')[1] ?? tr.fileName : '';

	async function confirm() {
		if (!tr || deleting) return;
		deleting = true;
		try {
			await deleteTranscription(tr.id);
			toast.success($_('modals.delete.toasts.success'));
		} catch (error) {
			console.error('Error deleting transcription:', error);
			toast.error($_('modals.delete.toasts.error'));
		} finally {
			deleting = false;
			open = false;
			pendingDelete.set(null);
		}
	}
</script>

<Modal bind:open size="sm" let:close on:close={() => pendingDelete.set(null)}>
	<div class="p-6">
		<div class="mb-4 flex items-center justify-between">
			<div class="flex items-center gap-2.5">
				<div class="flex h-8 w-8 items-center justify-center rounded-lg border border-red-500/25 bg-red-500/15">
					<Trash2 size={14} class="text-red-400" />
				</div>
				<h2 class="text-[0.95rem] font-semibold text-foreground">{$_('modals.delete.title')}</h2>
			</div>
			<button
				on:click={close}
				aria-label={$_('common.close')}
				class="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
			>
				<X size={14} />
			</button>
		</div>

		<p class="mb-1 break-words text-[0.85rem] font-medium text-foreground">{displayName}</p>
		<p class="mb-6 text-[0.8rem] text-muted-foreground">{$_('modals.delete.message')}</p>

		<div class="flex items-center justify-end gap-2">
			<Button variant="secondary" size="sm" on:click={close} disabled={deleting}>{$_('common.cancel')}</Button>
			<button
				bind:this={confirmButton}
				type="button"
				on:click={confirm}
				disabled={deleting}
				class="inline-flex items-center justify-center gap-2 rounded-xl bg-red-500 px-3 py-2 text-[0.8rem] font-semibold text-white transition-all hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
			>
				<Trash2 size={13} />
				{$_('common.delete')}
			</button>
		</div>
	</div>
</Modal>

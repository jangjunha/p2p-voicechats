<script lang="ts">
  import { store } from '../lib/store.svelte';
  import { isAnimatedWebp, isWebp } from '../lib/webp';
  import Sticker from './Sticker.svelte';

  let {
    serverId,
    spaceId,
    isOwner,
    onpick,
    onclose,
  }: {
    serverId: string;
    spaceId: string;
    isOwner: boolean;
    onpick: (id: string) => void;
    onclose: () => void;
  } = $props();

  const stickers = $derived(store.stickersOf(serverId, spaceId));
  let busy = $state(false);
  let err = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  // Keep well under the server's ~2 MB ciphertext cap (base64 adds ~33%).
  const MAX_BYTES = 1024 * 1024;

  $effect(() => {
    void store.loadStickers(serverId, spaceId).catch((e) => {
      err = e instanceof Error ? e.message : String(e);
    });
  });

  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-picking the same file later
    if (!file) return;
    err = null;
    if (file.size > MAX_BYTES) {
      err = 'Sticker must be under 1 MB';
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isWebp(bytes)) {
      err = 'Only webp images are supported';
      return;
    }
    if (!isAnimatedWebp(bytes)) {
      // Static webp still works; just nudge toward the intended format.
      console.info('sticker is a static webp; animated webp is recommended');
    }
    const name = file.name.replace(/\.[^.]+$/, '').slice(0, 64) || 'sticker';
    busy = true;
    try {
      await store.addSticker(serverId, spaceId, name, bytes);
    } catch (e2) {
      err = e2 instanceof Error ? e2.message : String(e2);
    } finally {
      busy = false;
    }
  }

  async function remove(e: MouseEvent, id: string) {
    e.stopPropagation();
    err = null;
    try {
      await store.deleteSticker(serverId, spaceId, id);
    } catch (e2) {
      err = e2 instanceof Error ? e2.message : String(e2);
    }
  }
</script>

<div class="picker">
  <header>
    <span class="label">Stickers</span>
    {#if isOwner}
      <button type="button" class="add" disabled={busy} onclick={() => fileInput?.click()}>
        {busy ? 'Uploading…' : '+ Add'}
      </button>
      <input bind:this={fileInput} type="file" accept="image/webp" hidden onchange={onFile} />
    {/if}
    <button type="button" class="close" onclick={onclose} title="Close">✕</button>
  </header>

  {#if err}<p class="err">{err}</p>{/if}

  {#if stickers.length === 0}
    <p class="empty">
      {isOwner ? 'No stickers yet — add an animated webp.' : 'No stickers in this space yet.'}
    </p>
  {:else}
    <div class="grid">
      {#each stickers as s (s.id)}
        <div class="cell">
          <button type="button" class="use" title={s.name} onclick={() => onpick(s.id)}>
            <Sticker {serverId} {spaceId} stickerId={s.id} size={72} />
          </button>
          {#if isOwner}
            <button type="button" class="del" title="Delete sticker" onclick={(e) => remove(e, s.id)}
              >✕</button
            >
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .picker {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    right: 0;
    max-height: 280px;
    overflow-y: auto;
    background: var(--bg-1);
    border: 1px solid var(--bg-3);
    border-radius: var(--radius);
    padding: 8px 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 20;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-1);
    flex: 1;
  }
  .add {
    font-size: 12px;
    padding: 3px 8px;
  }
  .close {
    background: transparent;
    color: var(--fg-1);
    padding: 0 4px;
  }
  .err {
    margin: 4px 0;
    color: var(--danger);
    font-size: 12px;
  }
  .empty {
    margin: 6px 2px;
    color: var(--fg-1);
    font-size: 12.5px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, 72px);
    gap: 8px;
  }
  .cell {
    position: relative;
    width: 72px;
    height: 72px;
  }
  .use {
    padding: 2px;
    background: var(--bg-2);
    border-radius: 8px;
    display: grid;
    place-items: center;
  }
  .use:hover {
    background: var(--bg-3);
  }
  .del {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 18px;
    height: 18px;
    padding: 0;
    font-size: 10px;
    line-height: 1;
    border-radius: 50%;
    background: var(--danger);
    color: #0d1117;
    opacity: 0;
  }
  .cell:hover .del {
    opacity: 1;
  }
</style>

<script lang="ts">
  import { store } from '../lib/store.svelte';

  let {
    serverId,
    spaceId,
    stickerId,
    size = 128,
  }: { serverId: string; spaceId: string; stickerId: string; size?: number } = $props();

  let url = $state<string | null>(null);
  let failed = $state(false);

  $effect(() => {
    let active = true;
    url = null;
    failed = false;
    void store.stickerUrl(serverId, spaceId, stickerId).then((u) => {
      if (!active) return;
      if (u) url = u;
      else failed = true;
    });
    return () => {
      active = false;
    };
  });
</script>

{#if url}
  <img class="sticker" src={url} alt="sticker" style="width:{size}px;height:{size}px" />
{:else}
  <div class="sticker placeholder" class:failed style="width:{size}px;height:{size}px">
    {failed ? '🚫' : ''}
  </div>
{/if}

<style>
  .sticker {
    object-fit: contain;
    border-radius: 8px;
  }
  .placeholder {
    display: grid;
    place-items: center;
    background: var(--bg-3);
    color: var(--fg-1);
  }
</style>

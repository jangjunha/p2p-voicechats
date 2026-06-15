<script lang="ts">
  import CallPanel from './CallPanel.svelte';
  import type { Space } from '../lib/api';
  import { store } from '../lib/store.svelte';

  let { serverId, channelId, space }: { serverId: string; channelId: string; space: Space } = $props();

  let draft = $state('');
  let scroller = $state<HTMLElement | null>(null);

  const channel = $derived(space.channels.find((c) => c.id === channelId));
  const msgs = $derived(store.messagesOf(serverId, channelId));
  const inThisCall = $derived(store.call?.serverId === serverId && store.call?.channelId === channelId);
  const locked = $derived(store.lockedOf(serverId, space.id));

  // Keep scrolled to the bottom as messages arrive.
  $effect(() => {
    msgs.length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  async function send(e: SubmitEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    draft = '';
    try {
      await store.sendMessage(serverId, channelId, text);
    } catch (err) {
      store.error = err instanceof Error ? err.message : String(err);
    }
  }

  function time(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

<div class="view">
  <header>
    <span class="title"># {channel?.name}</span>
    {#if !inThisCall}
      <button class="primary" onclick={() => store.joinCall(serverId, channelId)} disabled={store.call !== null}>
        Join call
      </button>
    {/if}
  </header>

  {#if inThisCall}
    <CallPanel />
  {/if}

  <div class="messages" bind:this={scroller}>
    {#if locked}
      <div class="locked">
        Waiting for another member to share this space's encryption key…
      </div>
    {/if}
    {#each msgs as m (m.id)}
      <div class="msg" class:bad={!m.ok}>
        <span class="meta"><b>{m.senderName}</b> {time(m.createdAt)}</span>
        <span class="body">{m.body}</span>
      </div>
    {/each}
  </div>

  <form class="composer" onsubmit={send}>
    <input
      bind:value={draft}
      placeholder={locked ? 'Locked — no space key yet' : `Message #${channel?.name}`}
      disabled={locked}
      maxlength="4000"
    />
  </form>
</div>

<style>
  .view { display: flex; flex-direction: column; height: 100%; }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--bg-3);
  }
  .title { font-weight: 600; }

  .messages { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
  .msg { display: flex; flex-direction: column; }
  .msg .meta { color: var(--fg-1); font-size: 12px; }
  .msg .meta b { color: var(--fg-0); }
  .msg .body { white-space: pre-wrap; word-break: break-word; }
  .msg.bad .body { color: var(--fg-1); font-style: italic; }
  .locked {
    background: var(--bg-3);
    border-radius: var(--radius);
    padding: 8px 12px;
    color: var(--fg-1);
    font-size: 13px;
  }

  .composer { padding: 12px 16px; }
  .composer input { width: 100%; }
</style>

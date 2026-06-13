<script lang="ts">
  import ChannelView from './ChannelView.svelte';
  import Modal from './Modal.svelte';
  import { copyText } from '../lib/clipboard';
  import { store } from '../lib/store.svelte';

  // Native prompt()/alert()/confirm() are no-ops in some WebViews (e.g. macOS
  // WKWebView), so every interaction goes through an in-app modal instead.
  type ModalState =
    | null
    | { kind: 'newSpace' }
    | { kind: 'join' }
    | { kind: 'invite'; token: string }
    | { kind: 'backup'; data: string }
    | { kind: 'kick'; userId: string; name: string };

  let modal = $state<ModalState>(null);
  let textInput = $state('');
  let copied = $state(false);
  let busy = $state(false);

  let newChannelName = $state('');
  let addingChannel = $state(false);

  const space = $derived(store.activeSpace);
  const isOwner = $derived(space !== null && space.owner_id === store.userId);

  function open(state: ModalState) {
    textInput = '';
    copied = false;
    modal = state;
  }
  function close() {
    modal = null;
  }

  async function submitNewSpace(e: SubmitEvent) {
    e.preventDefault();
    const name = textInput.trim();
    if (!name) return;
    busy = true;
    try {
      await store.createSpace(name);
      close();
    } catch (err) {
      store.error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function submitJoin(e: SubmitEvent) {
    e.preventDefault();
    const token = textInput.trim();
    if (!token) return;
    busy = true;
    try {
      await store.acceptInvite(token);
      close();
    } catch (err) {
      store.error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function invite() {
    if (!space || !store.api) return;
    busy = true;
    try {
      const { token } = await store.api.createInvite(space.id);
      open({ kind: 'invite', token });
      copied = await copyText(token);
    } catch (err) {
      store.error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  function backupIdentity() {
    open({ kind: 'backup', data: store.exportIdentity() });
  }

  async function copyCurrent(text: string) {
    copied = await copyText(text);
  }

  async function confirmKick() {
    if (modal?.kind !== 'kick' || !space) return;
    busy = true;
    try {
      await store.removeMember(space.id, modal.userId);
      close();
    } catch (err) {
      store.error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function addChannel(e: SubmitEvent) {
    e.preventDefault();
    if (!space || !newChannelName.trim()) return;
    await store.api?.createChannel(space.id, newChannelName.trim());
    newChannelName = '';
    addingChannel = false;
    await store.refreshSpaces();
  }
</script>

<div class="layout">
  <nav class="rail">
    {#each store.spaces as s (s.id)}
      <button
        class="space-btn"
        class:active={s.id === store.activeSpaceId}
        title={s.name}
        onclick={() => store.selectChannel(s.id, s.channels[0]?.id ?? null)}
      >
        {s.name.slice(0, 2).toUpperCase()}
      </button>
    {/each}
    <button class="space-btn dim" title="Create space" onclick={() => open({ kind: 'newSpace' })}>+</button>
    <button class="space-btn dim" title="Join with invite" onclick={() => open({ kind: 'join' })}>⤓</button>
    <div class="spacer"></div>
    <button class="space-btn dim" title="Back up identity" onclick={backupIdentity}>🔑</button>
  </nav>

  <aside class="sidebar">
    {#if space}
      <header>{space.name}</header>
      <div class="channels">
        {#each space.channels as c (c.id)}
          <button
            class="channel"
            class:active={c.id === store.activeChannelId}
            onclick={() => store.selectChannel(space.id, c.id)}
          >
            # {c.name}
          </button>
        {/each}
        {#if isOwner}
          {#if addingChannel}
            <form onsubmit={addChannel}>
              <input bind:value={newChannelName} placeholder="channel name" maxlength="64" />
            </form>
          {:else}
            <button class="channel dim" onclick={() => (addingChannel = true)}>+ channel</button>
          {/if}
        {/if}
      </div>

      <div class="members">
        <h3>Members</h3>
        {#each store.members[space.id] ?? [] as m (m.user_id)}
          <div class="member">
            <span class:me={m.user_id === store.userId}>{m.name}</span>
            {#if m.role === 'owner'}<span class="badge">owner</span>{/if}
            {#if isOwner && m.user_id !== store.userId}
              <button
                class="kick"
                title="Remove member"
                onclick={() => open({ kind: 'kick', userId: m.user_id, name: m.name })}
              >✕</button>
            {/if}
          </div>
        {/each}
        {#if isOwner}
          <button class="invite" onclick={invite}>Create invite</button>
        {/if}
      </div>
    {:else}
      <header>voicechats</header>
      <p class="hint">Create a space or join one with an invite token.</p>
    {/if}
  </aside>

  <main>
    {#if store.activeChannelId && space}
      <ChannelView channelId={store.activeChannelId} {space} />
    {:else}
      <div class="empty">No channel selected</div>
    {/if}
  </main>
</div>

{#if modal?.kind === 'newSpace'}
  <Modal title="Create space" onclose={close}>
    <form onsubmit={submitNewSpace}>
      <!-- svelte-ignore a11y_autofocus -->
      <input bind:value={textInput} placeholder="Space name" maxlength="64" autofocus />
      <div class="actions">
        <button type="button" onclick={close}>Cancel</button>
        <button class="primary" disabled={busy || !textInput.trim()}>Create</button>
      </div>
    </form>
  </Modal>
{:else if modal?.kind === 'join'}
  <Modal title="Join with invite" onclose={close}>
    <form onsubmit={submitJoin}>
      <!-- svelte-ignore a11y_autofocus -->
      <input bind:value={textInput} placeholder="Paste invite token" autofocus />
      <div class="actions">
        <button type="button" onclick={close}>Cancel</button>
        <button class="primary" disabled={busy || !textInput.trim()}>Join</button>
      </div>
    </form>
  </Modal>
{:else if modal?.kind === 'invite'}
  {@const token = modal.token}
  <Modal title="Invite token" onclose={close}>
    <p class="note">Share this token with a friend. Valid for 7 days.</p>
    <input class="reveal" readonly value={token} onfocus={(e) => e.currentTarget.select()} />
    <div class="actions">
      <button class="primary" onclick={() => copyCurrent(token)}>
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  </Modal>
{:else if modal?.kind === 'backup'}
  {@const data = modal.data}
  <Modal title="Identity backup" onclose={close}>
    <p class="note">
      This is the only way to move your account to another device. Store it
      somewhere safe and private — anyone with it can read your messages.
    </p>
    <textarea class="reveal" readonly rows="4" onfocus={(e) => e.currentTarget.select()}>{data}</textarea>
    <div class="actions">
      <button class="primary" onclick={() => copyCurrent(data)}>
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  </Modal>
{:else if modal?.kind === 'kick'}
  {@const name = modal.name}
  <Modal title="Remove member" onclose={close}>
    <p class="note">Remove <b>{name}</b> from this space? The space key will be rotated so they can't read new messages.</p>
    <div class="actions">
      <button type="button" onclick={close}>Cancel</button>
      <button class="danger" disabled={busy} onclick={confirmKick}>Remove</button>
    </div>
  </Modal>
{/if}

<style>
  .layout {
    display: grid;
    grid-template-columns: 56px 200px 1fr;
    height: 100%;
  }
  .rail {
    background: var(--bg-0);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
  }
  .space-btn {
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: var(--bg-2);
    font-weight: 600;
  }
  .space-btn.active { outline: 2px solid var(--accent); }
  .space-btn.dim { color: var(--fg-1); }
  .spacer { flex: 1; }

  .sidebar {
    background: var(--bg-1);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .sidebar header {
    padding: 12px;
    font-weight: 600;
    border-bottom: 1px solid var(--bg-3);
  }
  .channels { padding: 8px; display: flex; flex-direction: column; gap: 2px; }
  .channel {
    background: transparent;
    text-align: left;
    color: var(--fg-1);
    padding: 5px 8px;
  }
  .channel.active { background: var(--bg-3); color: var(--fg-0); }
  .channel.dim { font-size: 12.5px; }
  .channels input { width: 100%; }

  .members { padding: 8px 12px; margin-top: auto; border-top: 1px solid var(--bg-3); }
  .members h3 { font-size: 11px; text-transform: uppercase; color: var(--fg-1); margin: 4px 0; }
  .member { display: flex; align-items: center; gap: 6px; padding: 3px 0; color: var(--fg-1); }
  .member .me { color: var(--fg-0); font-weight: 600; }
  .badge {
    font-size: 10px;
    background: var(--bg-3);
    border-radius: 4px;
    padding: 1px 5px;
    color: var(--fg-1);
  }
  .kick { margin-left: auto; background: transparent; color: var(--fg-1); padding: 0 4px; }
  .invite { margin-top: 8px; width: 100%; font-size: 12.5px; }

  main { background: var(--bg-2); min-width: 0; }
  .empty, .hint { color: var(--fg-1); padding: 16px; }
  .empty { display: grid; place-items: center; height: 100%; }

  /* modal contents */
  form { display: flex; flex-direction: column; gap: 12px; }
  form input { width: 100%; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .note { margin: 0; color: var(--fg-1); font-size: 13px; line-height: 1.45; }
  .reveal {
    width: 100%;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    word-break: break-all;
    resize: vertical;
  }
</style>

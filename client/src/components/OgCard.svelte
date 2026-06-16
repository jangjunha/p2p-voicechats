<script lang="ts">
  import { fetchOg, type OgData } from '../lib/og';
  import { openExternal } from '../lib/platform';

  let { url }: { url: string } = $props();

  let data = $state<OgData | null>(null);

  $effect(() => {
    let active = true;
    data = null;
    void fetchOg(url).then((d) => {
      if (active) data = d;
    });
    return () => {
      active = false;
    };
  });
</script>

{#if data}
  <button class="og" onclick={() => data && void openExternal(data.url)} title={data.url}>
    {#if data.image}
      <img src={data.image} alt="" loading="lazy" />
    {/if}
    <div class="meta">
      {#if data.siteName}<span class="site">{data.siteName}</span>{/if}
      {#if data.title}<span class="title">{data.title}</span>{/if}
      {#if data.description}<span class="desc">{data.description}</span>{/if}
    </div>
  </button>
{/if}

<style>
  .og {
    display: flex;
    gap: 10px;
    align-items: stretch;
    text-align: left;
    max-width: 420px;
    margin-top: 6px;
    padding: 8px;
    background: var(--bg-1);
    border: 1px solid var(--bg-3);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius);
    cursor: pointer;
  }
  .og img {
    width: 72px;
    height: 72px;
    object-fit: cover;
    border-radius: 6px;
    flex: none;
    background: var(--bg-3);
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    justify-content: center;
  }
  .site {
    font-size: 11px;
    color: var(--fg-1);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .title {
    font-weight: 600;
    font-size: 13px;
    color: var(--fg-0);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .desc {
    font-size: 12px;
    color: var(--fg-1);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
</style>

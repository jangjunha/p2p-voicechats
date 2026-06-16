<script lang="ts">
  import { extractUrls, linkSegments } from '../lib/linkify';
  import { openExternal } from '../lib/platform';
  import OgCard from './OgCard.svelte';

  let { text }: { text: string } = $props();

  const segments = $derived(linkSegments(text));
  const urls = $derived(extractUrls(text));

  function open(e: MouseEvent, href: string) {
    e.preventDefault();
    void openExternal(href);
  }
</script>

<span class="text"
  >{#each segments as seg, i (i)}{#if seg.type === 'link'}<a
        href={seg.href}
        onclick={(e) => open(e, seg.href)}>{seg.value}</a
      >{:else}{seg.value}{/if}{/each}</span
>
{#each urls as u (u)}
  <OgCard url={u} />
{/each}

<style>
  .text {
    white-space: pre-wrap;
    word-break: break-word;
  }
  a {
    color: var(--accent);
    text-decoration: none;
    cursor: pointer;
  }
  a:hover {
    text-decoration: underline;
  }
</style>

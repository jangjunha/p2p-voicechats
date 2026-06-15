<script lang="ts">
  import ServerForm from './ServerForm.svelte';
</script>

<div class="wrap">
  <div class="card">
    <h1>malguem</h1>
    <p class="sub">Your identity key is generated on this device. The server never sees your messages or media.</p>
    <ServerForm />
  </div>
</div>

<style>
  .wrap { height: 100%; display: grid; place-items: center; }
  .card {
    background: var(--bg-1);
    padding: 28px;
    border-radius: 12px;
    width: 340px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h1 { margin: 0; font-size: 22px; }
  .sub { margin: 0; color: var(--fg-1); font-size: 12.5px; }
</style>

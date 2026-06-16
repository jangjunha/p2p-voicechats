/** Desktop (Tauri) vs. browser-dev shims. */

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Open a URL in the user's real browser. In the Tauri desktop app this hands
 * off to the OS via the opener plugin; in browser dev it falls back to a new
 * tab. Either way the link never navigates our own webview away from the app.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return;
    } catch (e) {
      console.warn('opener plugin failed, falling back to window.open', e);
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

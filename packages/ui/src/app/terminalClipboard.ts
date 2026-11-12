/**
 * The pane's clipboard routes, as functions.
 *
 * Lifted whole out of TerminalView — not as a tidy-up but as a design gate
 * payment, the way useQuickActions left HostWorkspaceView: the view sits
 * under the 1000-line cap, and these two never touched the terminal anyway —
 * `navigator.clipboard` in, `paste(text)` out. What stayed behind is the
 * DECISION about when each route fires (mouse-up copy, right-click paste,
 * the chords, the capture button); this module is only the routes
 * themselves, with their failure posture intact: silent, never throwing,
 * because a clipboard refusal has no useful renderer-side answer.
 */

/** Copy `text` to the system clipboard. Silent on failure — never throws. */
export async function copyToClipboard(text: string): Promise<void> {
  if (!text) return; // a bare click clears the selection; don't blank the clipboard
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard permission denied / API unavailable. Nothing useful to do
    // from the renderer; the selection is still there for a manual Ctrl-C.
  }
}

/**
 * Read the system clipboard and hand it to [paste] — the pane's
 * `term.paste`, injected so this module owns no terminal.
 *
 * One caller left: the terminal's right-click. Both paste CHORDS go to the
 * prompt composer now, so this is the whole of the shell's paste.
 */
export async function pasteFromClipboard(paste: (text: string) => void): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) paste(text);
  } catch {
    // Same posture as the copy: degrade quietly. Ctrl-V still works via
    // xterm's own handling of the browser `paste` event.
  }
}

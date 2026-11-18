/**
 * What the diagnostic strip says to a person on a phone (pocketshell#3161).
 *
 * The desktop strip shows the raw record — `[terminal-stall] terminal output
 * parsing stalled (…)` — next to a desktop log the user can open. A phone has
 * no log to open, and the raw kind and message mean nothing to someone who
 * just wanted their terminal: the compact layout shows a plain sentence and
 * offers the raw record through "Copy details", so it can still be pasted
 * into a bug report word for word.
 */
import type { DiagEntry, DiagKind } from './diag';

const PLAIN_SUMMARY: Record<DiagKind, string> = {
  render: 'Something went wrong in PocketShell.',
  error: 'Something went wrong in PocketShell.',
  unhandledrejection: 'Something went wrong in PocketShell.',
  'terminal-stall': 'The terminal stopped showing new output.',
  'terminal-selection': 'Copying the terminal selection failed.',
  editor: 'The file editor ran into a problem.',
};

/** One plain sentence for a diagnostic kind; never the raw kind or message. */
export function plainDiagSummary(kind: DiagKind): string {
  return PLAIN_SUMMARY[kind] ?? PLAIN_SUMMARY.error;
}

/** The raw record, as "Copy details" puts it on the clipboard. */
export function diagDetailsText(entry: Pick<DiagEntry, 'kind' | 'message' | 'stack'>): string {
  const head = `[${entry.kind}] ${entry.message}`;
  return entry.stack && entry.stack !== entry.message ? `${head}\n${entry.stack}` : head;
}

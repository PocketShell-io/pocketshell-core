/**
 * Local diagnostic reports: one model for every source a support screen lists
 * — runtime errors the shared app caught, native crashes a platform recorded,
 * and 0.5.x Android crash reports/diagnostic history carried over by the
 * installed-data import — plus the redaction every shared or exported copy
 * passes through.
 *
 * Pure: no DOM, storage or platform import. Platforms own where reports live
 * (the `api.diagnostics` seam) and call these functions on the way in and out.
 *
 * Redaction follows 0.5.x `CrashReportFormatter.redactForSharing`: context
 * lines naming a host, user, session, directory or action are blanked, the
 * exception summary keeps its class but drops the message, and home paths,
 * credentials and private-key blocks are replaced everywhere else.
 */

export type DiagnosticReportSource = 'runtime-error' | 'native-crash' | 'imported-crash' | 'imported-history';

export interface DiagnosticReport {
  /** Stable, platform-assigned identity; also the delete key. */
  id: string;
  source: DiagnosticReportSource;
  /** Epoch ms when the failure happened, or null when the source did not say. */
  at: number | null;
  /** One line: the error class or report kind. Never contains host data. */
  title: string;
  /** Full report text, already redacted for display and sharing. */
  body: string;
}

export const MAX_DIAGNOSTIC_REPORT_BYTES = 64 * 1024;
export const MAX_DIAGNOSTIC_REPORTS = 50;

const CONTEXT_PREFIXES = ['Host:', 'Hostname:', 'User:', 'Session:', 'Directory:', 'Action:'];

/** Scrub paths, credentials, keys, addresses and `user@host` from free text. */
export function redactDiagnosticText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?(-----END [^-]+ PRIVATE KEY-----|$)/gi, '<private-key-redacted>')
    .replace(/(authorization|bearer|password|passphrase|token|secret|private key)(\s*[=:]\s*|\s+)[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(\/home\/|\/users\/|\/var\/home\/|\/root\/)[^\s:)'"]+/gi, '<path>')
    .replace(/~\/[^\s:)'"]+/g, '<path>')
    .replace(/\b[\w.+-]+@[\w-]+(\.[\w-]+)*\b/g, '<user@host>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<address>')
    .replace(/\bssh:\/\/[^\s]+/gi, 'ssh://<host>');
}

/** Line-aware redaction of a 0.5.x-format crash report. */
export function redactCrashReport(report: string): string {
  let inException = false;
  const out: string[] = [];
  for (const line of report.split(/\r?\n/)) {
    if (line === 'Exception') {
      inException = true;
      out.push(line);
    } else if (inException) {
      out.push(redactDiagnosticText(line));
    } else if (CONTEXT_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      out.push(`${line.slice(0, line.indexOf(':'))}: [redacted]`);
    } else if (line.startsWith('Exception summary:')) {
      const value = line.slice('Exception summary:'.length).trim();
      out.push(`Exception summary: ${value.split(':', 1)[0]}`);
    } else if (line.startsWith('Top frame:')) {
      out.push('Top frame: [redacted]');
    } else {
      out.push(redactDiagnosticText(line));
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

function bounded(text: string): string {
  if (text.length <= MAX_DIAGNOSTIC_REPORT_BYTES) return text;
  return `${text.slice(0, MAX_DIAGNOSTIC_REPORT_BYTES)}\n[report truncated]\n`;
}

/** The error class name only — `TypeError`, `IllegalStateException` — never its message. */
export function errorClassName(error: unknown): string {
  if (error instanceof Error) return /^[A-Za-z_$][\w$.]*$/.test(error.name) ? error.name : 'Error';
  if (typeof error === 'string') return 'Error';
  return 'Unknown error';
}

/**
 * A report for an uncaught runtime error. The message and stack are redacted;
 * the title carries only where it was caught and the error class.
 */
export function runtimeErrorReport(input: {
  id: string;
  at: number;
  kind: 'render' | 'error' | 'unhandledrejection' | string;
  error: unknown;
  appVersion?: string;
}): DiagnosticReport {
  const className = errorClassName(input.error);
  const message = input.error instanceof Error ? input.error.message : typeof input.error === 'string' ? input.error : '';
  const stack = input.error instanceof Error && input.error.stack ? input.error.stack : '';
  const kindLabel = input.kind === 'unhandledrejection' ? 'Unhandled promise rejection' : input.kind === 'render' ? 'Render error' : 'Uncaught error';
  const body = [
    'PocketShell runtime error',
    `Generated: ${new Date(input.at).toISOString()}`,
    `App version: ${input.appVersion ?? 'unknown'}`,
    `Caught by: ${input.kind}`,
    `Exception summary: ${className}`,
    '',
    'Exception',
    redactDiagnosticText(message),
    redactDiagnosticText(stack),
  ].join('\n');
  return { id: input.id, source: 'runtime-error', at: input.at, title: `${kindLabel}: ${className}`, body: bounded(`${body.trimEnd()}\n`) };
}

/** 0.5.x crash-report ids are `yyyyMMdd-HHmmss-SSS` file names, in device local time. */
export function parseLegacyCrashReportTimestamp(fileName: string): number | null {
  const match = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})/.exec(fileName);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match.map(Number) as number[];
  const at = new Date(y!, mo! - 1, d!, h!, mi!, s!, ms!).getTime();
  return Number.isFinite(at) ? at : null;
}

/** An imported 0.5.x crash report, redacted, titled by its exception class. */
export function legacyCrashReport(id: string, relativePath: string, text: string): DiagnosticReport {
  const generated = /^Generated:\s*(\S+)/m.exec(text)?.[1];
  const generatedAt = generated ? Date.parse(generated) : Number.NaN;
  const summary = /^Exception summary:\s*([^:\r\n]+)/m.exec(text)?.[1]?.trim();
  const className = summary && /^[A-Za-z_$][\w$.]*$/.test(summary) ? summary : 'crash';
  return {
    id,
    source: 'imported-crash',
    at: Number.isFinite(generatedAt) ? generatedAt : parseLegacyCrashReportTimestamp(relativePath),
    title: `0.5.x crash report: ${className}`,
    body: bounded(redactCrashReport(text)),
  };
}

/**
 * The imported 0.5.x diagnostic history (`pocketshell-diagnostics.jsonl`) as
 * one report: each JSON line is re-serialized after redaction; malformed lines
 * are counted, not shown.
 */
export function legacyDiagnosticHistoryReport(id: string, jsonl: string): DiagnosticReport {
  const lines: string[] = [];
  let malformed = 0;
  let latest: number | null = null;
  for (const raw of jsonl.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      const wall = (parsed as Record<string, unknown>)['wallClock'] ?? (parsed as Record<string, unknown>)['lastWallClock'];
      const at = typeof wall === 'string' ? Date.parse(wall) : typeof wall === 'number' ? wall : Number.NaN;
      if (Number.isFinite(at)) latest = Math.max(latest ?? at, at);
      lines.push(redactDiagnosticText(JSON.stringify(parsed)));
    } catch {
      malformed += 1;
    }
  }
  const header = `PocketShell 0.5.x diagnostic history\nEvents: ${lines.length}${malformed ? ` (${malformed} unreadable line${malformed === 1 ? '' : 's'} omitted)` : ''}\n\n`;
  return { id, source: 'imported-history', at: latest, title: '0.5.x diagnostic history', body: bounded(header + lines.join('\n') + (lines.length ? '\n' : '')) };
}

/** Newest first (undated last), bounded, with duplicate ids dropped. */
export function sortDiagnosticReports(reports: readonly DiagnosticReport[]): DiagnosticReport[] {
  const seen = new Set<string>();
  const unique = reports.filter((report) => (seen.has(report.id) ? false : (seen.add(report.id), true)));
  return unique
    .sort((left, right) => (right.at ?? Number.NEGATIVE_INFINITY) - (left.at ?? Number.NEGATIVE_INFINITY))
    .slice(0, MAX_DIAGNOSTIC_REPORTS);
}

/** The shareable text for one report or a bundle; bodies are re-redacted as a last guard. */
export function formatDiagnosticReportsForSharing(reports: readonly DiagnosticReport[], exportedAt: number): string {
  const sections = reports.map((report) => [
    `=== ${report.title}`,
    `Recorded: ${report.at === null ? 'unknown' : new Date(report.at).toISOString()}`,
    `Source: ${report.source}`,
    '',
    redactDiagnosticText(report.body).trimEnd(),
  ].join('\n'));
  return [
    `PocketShell diagnostics export (${new Date(exportedAt).toISOString()})`,
    'Review before sharing. Host names, paths and credentials are redacted; terminal excerpts may remain.',
    '',
    ...sections,
    '',
  ].join('\n');
}

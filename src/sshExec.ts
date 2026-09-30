import type {
  SshCapability,
  SshConnectionRef,
  SshExecResult,
} from './sshCapability.js';

/**
 * The one checked exec over a client's {@link SshCapability}. Every exec a
 * controller runs carries a request id and the connection generation it was
 * issued on; a response that echoes a different request, connection, or
 * generation is a late answer from a replaced transport and must never be
 * read as this request's output. Usage, port scan and port forwarding all
 * share this check instead of each keeping a copy.
 */

/** The identity every native SSH response echoes back. */
export interface SshRequestEcho {
  requestId: string;
  connectionId: string;
  generationId: string;
}

/** True when `response` answers `requestId` on exactly `connection`'s generation. */
export function isSshResponseFor(
  response: SshRequestEcho,
  requestId: string,
  connection: SshConnectionRef,
): boolean {
  return response.requestId === requestId &&
    response.connectionId === connection.connectionId &&
    response.generationId === connection.generationId;
}

/** A native response that belongs to a different request, connection, or generation. */
export class SshResponseMismatchError extends Error {
  constructor(message = 'The SSH response belongs to a different request or connection.') {
    super(message);
    this.name = 'SshResponseMismatchError';
  }
}

export interface ExecCheckedOptions {
  requestId: string;
  command: string;
  timeoutMs: number;
}

/**
 * Run `command` on `connection` and verify the response echo. Errors thrown by
 * the capability propagate unchanged; a mismatched echo rejects with
 * {@link SshResponseMismatchError}. Exit status and timeout are left to the
 * caller, because some probes (the port scan) read partial output on purpose.
 */
export async function execChecked(
  capability: Pick<SshCapability, 'exec'>,
  connection: SshConnectionRef,
  options: ExecCheckedOptions,
): Promise<SshExecResult> {
  const result = await capability.exec({
    ...connection,
    requestId: options.requestId,
    command: options.command,
    timeoutMs: options.timeoutMs,
  });
  if (!isSshResponseFor(result, options.requestId, connection)) {
    throw new SshResponseMismatchError();
  }
  return result;
}

/** First non-empty stderr line, bounded, for a user-visible failure message. */
export function execStderrSummary(result: Pick<SshExecResult, 'stderr'>, maxLength = 200): string | undefined {
  return result.stderr.trim().split(/\r?\n/).find(Boolean)?.slice(0, maxLength);
}

/** Request ids unique within this runtime, prefixed by the controller that issued them. */
export function createRequestIdFactory(prefix: string): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
  };
}

/** A thrown value as display text. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

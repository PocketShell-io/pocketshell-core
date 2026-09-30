import { parseUsageNdjson, type UsageRow } from './usageParsers.js';
import type { SshCapability, SshConnectionRef, SshExecResult } from './sshCapability.js';
import {
  createRequestIdFactory,
  describeError,
  execChecked,
  execStderrSummary,
  SshResponseMismatchError,
} from './sshExec.js';

/**
 * Provider usage comes only from the connected host: the client runs the
 * host CLI's `usage --json` over its SSH capability and parses the NDJSON.
 * PocketShell itself keeps no provider credentials.
 */

export const USAGE_JSON_COMMAND = 'pocketshell usage --json';
export const USAGE_COMMAND_TIMEOUT_MS = 20_000;

export class UsageSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UsageSourceError';
  }
}

export interface UsageSourceOptions {
  createRequestId?: () => string;
  timeoutMs?: number;
}

const defaultRequestId = createRequestIdFactory('usage');

/** Read usage rows from the host, rejecting with {@link UsageSourceError} on any failure. */
export async function readHostUsage(
  capability: Pick<SshCapability, 'exec'>,
  connection: SshConnectionRef,
  options: UsageSourceOptions = {},
): Promise<UsageRow[]> {
  const requestId = (options.createRequestId ?? defaultRequestId)();
  let result: SshExecResult;
  try {
    result = await execChecked(capability, connection, {
      requestId,
      command: USAGE_JSON_COMMAND,
      timeoutMs: options.timeoutMs ?? USAGE_COMMAND_TIMEOUT_MS,
    });
  } catch (cause) {
    if (cause instanceof SshResponseMismatchError) {
      throw new UsageSourceError('The usage response belongs to a different SSH request or connection.');
    }
    throw new UsageSourceError(
      `Could not read provider usage from the host: ${describeError(cause)}`,
      { cause },
    );
  }
  if (result.timedOut) throw new UsageSourceError('The host usage command timed out.');
  if (result.exitCode !== 0) {
    const detail = execStderrSummary(result);
    throw new UsageSourceError(
      `The host usage command failed${result.exitCode === null ? '' : ` (exit ${result.exitCode})`}` +
      `${detail ? `: ${detail}` : '.'}`,
    );
  }
  return parseUsageNdjson(result.stdout);
}

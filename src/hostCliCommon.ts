/** Shared transport, errors, and parsing primitives for HostCliCore modules. */

export interface HostCliExecOutcome {
  /** Null means that the transport did not receive an exit status. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** The sole I/O boundary required by the host CLI contract. */
export interface HostCliTransport {
  exec(command: string, timeoutMs: number): Promise<HostCliExecOutcome>;
}

export type HostCliErrorKind = 'failed' | 'too_old' | 'malformed';

/** A typed host-contract failure. The caller can branch on `kind`. */
export abstract class HostCliError extends Error {
  abstract readonly kind: HostCliErrorKind;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The host CLI is too old to answer with a schema this client understands. */
export class HostCliTooOld extends HostCliError {
  readonly kind = 'too_old' as const;

  constructor(
    readonly foundSchema: number,
    readonly requiredSchema: number,
  ) {
    super(
      `The pocketshell CLI on the host is too old (reports schema ${foundSchema}, ` +
        `this app needs schema ${requiredSchema} or newer). Update it on the host ` +
        'and try again.',
    );
  }
}

/** The host returned malformed JSON or a document that violates its schema. */
export class HostCliMalformed extends HostCliError {
  readonly kind = 'malformed' as const;

  constructor(
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`Could not read the host's response: ${detail}`, options);
  }
}

/** The command failed, timed out, or could not be run by the transport. */
export class HostCliFailed extends HostCliError {
  readonly kind = 'failed' as const;

  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly timedOut: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new HostCliMalformed('response was not valid JSON', { cause });
  }
}

export function parseObject(raw: string): JsonRecord {
  const root = parseJson(raw);
  if (!isRecord(root)) {
    throw new HostCliMalformed('expected a JSON object at the top level');
  }
  return root;
}

export function requiredSchema(root: JsonRecord, field = 'schema'): number {
  const schema = root[field];
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < -2147483648 || schema > 2147483647) {
    throw new HostCliMalformed(
      schema === undefined ? `missing the \`${field}\` field` : `\`${field}\` was not an integer`,
    );
  }
  return schema;
}

export function optionalString(value: unknown, field: string, row: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${row}.${field} must be a string or null`);
  }
  return value;
}

export function optionalInteger(value: unknown, field: string, row: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${row}.${field} must be an integer or null`);
  }
  return value;
}

export function objectArray(value: unknown, field: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((row, index) => {
    if (!isRecord(row)) throw new Error(`${field}[${index}] must be an object`);
    return row;
  });
}

export function parseShape<T>(schema: number, label: string, read: () => T): T {
  try {
    return read();
  } catch (cause) {
    if (cause instanceof HostCliError) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new HostCliMalformed(`${label} schema ${schema} payload did not match the expected shape (${detail})`, {
      cause,
    });
  }
}

export function nonZeroExit(command: string, outcome: HostCliExecOutcome): HostCliFailed {
  const detail = outcome.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  const shortDetail = detail.length <= 200 ? detail : `${detail.slice(0, 200)}…`;
  return new HostCliFailed(
    command,
    outcome.exitCode,
    outcome.stderr,
    false,
    `\`${command}\` failed on the host (exit ${outcome.exitCode})${shortDetail ? `: ${shortDetail}` : '.'}`,
  );
}

export abstract class HostCliModule {
  protected constructor(
    protected readonly transport: HostCliTransport,
    readonly binary: string,
  ) {}

  protected async capture(command: string, timeoutMs: number): Promise<HostCliExecOutcome> {
    let outcome: HostCliExecOutcome;
    try {
      outcome = await this.transport.exec(command, timeoutMs);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new HostCliFailed(
        command,
        null,
        '',
        false,
        `Could not run \`${command}\` on the host: ${reason || 'unknown error'}`,
        { cause },
      );
    }
    if (outcome.timedOut) {
      throw new HostCliFailed(
        command,
        null,
        outcome.stderr,
        true,
        `\`${command}\` did not finish within ${timeoutMs}ms on the host.`,
      );
    }
    return outcome;
  }

  protected async captureJson(command: string, timeoutMs: number): Promise<string> {
    const outcome = await this.capture(command, timeoutMs);
    if (outcome.exitCode !== 0) throw nonZeroExit(command, outcome);
    if (!outcome.stdout.trim()) throw new HostCliMalformed(`\`${command}\` printed nothing on stdout`);
    return outcome.stdout;
  }
}

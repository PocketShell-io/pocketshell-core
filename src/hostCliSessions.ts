/** The versioned `pocketshell sessions` host CLI contract. */

import { shellQuote } from './shellQuote';
import {
  HostCliFailed,
  HostCliMalformed,
  HostCliModule,
  HostCliTooOld,
  isRecord,
  nonZeroExit,
  objectArray,
  optionalInteger,
  optionalString,
  parseJson,
  parseObject,
  parseShape,
  requiredSchema,
  type HostCliExecOutcome,
  type HostCliTransport,
  type JsonRecord,
} from './hostCliCommon';

const SESSION_SCHEMA = 3;
const LIST_TIMEOUT_MS = 20_000;
const CREATE_TIMEOUT_MS = 60_000;
const KILL_TIMEOUT_MS = 20_000;
const ACK_TIMEOUT_MS = 20_000;

export type AgentState = 'idle' | 'waiting' | 'working';
export type AgentStateSource = 'reported' | 'heuristic';

export interface SessionRow {
  name: string;
  id: string | null;
  workspace: string | null;
  tag: string | null;
  engine: string | null;
  profile: string | null;
  agent: string | null;
  agentState: AgentState | null;
  agentStateSource: AgentStateSource | null;
  attached: boolean;
  createdEpoch: number | null;
  activityEpoch: number | null;
}

export interface SessionListError {
  message: string;
}

export interface SessionsListing {
  sessions: SessionRow[];
  errors: SessionListError[];
}

export interface CreatedSession {
  name: string;
  id: string | null;
  created: boolean;
}

export type WarningKind = 'oom' | 'crash';

export interface WarningRow {
  session: string | null;
  workspace: string | null;
  tag: string | null;
  engine: string | null;
  kind: WarningKind | null;
  detail: string | null;
  createdAtMs: number | null;
  /** A stable selector the host accepts for acking this warning. */
  ackSelector: string | null;
}

/** Parse the schema-3 output from `pocketshell sessions list --json`. */
export function parseHostSessionsList(raw: string): SessionsListing {
  const root = parseObject(raw);
  const schema = requiredSchema(root);
  if (schema < SESSION_SCHEMA) throw new HostCliTooOld(schema, SESSION_SCHEMA);
  return parseShape(schema, 'sessions', () => {
    const sessions = root.sessions === undefined ? [] : objectArray(root.sessions, 'sessions').map((row, index): SessionRow => {
      const label = `sessions[${index}]`;
      if (typeof row.name !== 'string') throw new Error(`${label}.name must be a string`);
      if (typeof row.attached !== 'boolean') throw new Error(`${label}.attached must be a boolean`);
      const agent = optionalString(row.agent, 'agent', label)?.trim() || null;
      const agentState = optionalString(row.agent_state, 'agent_state', label);
      const agentStateSource = optionalString(row.agent_state_source, 'agent_state_source', label);
      const knownState: AgentState | null =
        agentState === 'idle' || agentState === 'waiting' || agentState === 'working' ? agentState : null;
      const knownStateSource: AgentStateSource | null =
        agentStateSource === 'reported' || agentStateSource === 'heuristic' ? agentStateSource : null;
      return {
        name: row.name,
        id: optionalString(row.id, 'id', label),
        workspace: optionalString(row.workspace, 'workspace', label),
        tag: optionalString(row.tag, 'tag', label),
        engine: optionalString(row.engine, 'engine', label),
        profile: optionalString(row.profile, 'profile', label),
        agent,
        agentState: knownState,
        agentStateSource: knownStateSource,
        attached: row.attached,
        createdEpoch: optionalInteger(row.created_epoch, 'created_epoch', label),
        activityEpoch: optionalInteger(row.activity_epoch, 'activity_epoch', label),
      };
    });
    const errors = root.errors === undefined ? [] : objectArray(root.errors, 'errors').map((row, index) => {
      if (typeof row.message !== 'string') throw new Error(`errors[${index}].message must be a string`);
      return { message: row.message };
    });
    return { sessions, errors };
  });
}

/** Parse the array emitted by `pocketshell sessions warnings --json`. */
export function parseHostWarnings(raw: string): WarningRow[] {
  const root = parseJson(raw);
  if (!Array.isArray(root)) throw new HostCliMalformed('expected a JSON array at the top level');
  return root.map((value, index) => {
    if (!isRecord(value)) throw new HostCliMalformed('expected every warning to be a JSON object');
    return parseShape(1, 'warning', () => {
      const label = `warnings[${index}]`;
      const session = optionalString(value.session, 'session', label);
      const workspace = optionalString(value.workspace, 'workspace', label);
      const tag = optionalString(value.tag, 'tag', label);
      const engine = optionalString(value.engine, 'engine', label);
      const kindValue = optionalString(value.kind, 'kind', label);
      const detail = optionalString(value.detail, 'detail', label);
      const createdAtMs = optionalInteger(value.created_at_ms, 'created_at_ms', label);
      const kind: WarningKind | null = kindValue === 'oom' || kindValue === 'crash' ? kindValue : null;
      const ackSelector = tag?.trim()
        ? workspace?.trim() ? `${workspace}:${tag}` : session?.trim() || null
        : session?.trim() || null;
      return { session, workspace, tag, engine, kind, detail, createdAtMs, ackSelector };
    });
  });
}

export class HostCliSessions extends HostCliModule {
  constructor(transport: HostCliTransport, binary = 'pocketshell') {
    super(transport, binary);
  }

  /** `pocketshell sessions list --json` (schema 3). */
  async listSessions(): Promise<SessionsListing> {
    const command = `${this.binary} sessions list --json`;
    return parseHostSessionsList(await this.captureJson(command, LIST_TIMEOUT_MS));
  }

  /** `pocketshell sessions create --json [options] -- NAME`. */
  async createSession(
    name: string,
    options: { cwd?: string | null; engine?: string | null; profile?: string | null } = {},
  ): Promise<CreatedSession> {
    let command = `${this.binary} sessions create --json`;
    if (options.cwd != null) command += ` --cwd ${shellQuote(options.cwd)}`;
    if (options.engine != null) command += ` --engine ${shellQuote(options.engine)}`;
    if (options.profile != null) command += ` --profile ${shellQuote(options.profile)}`;
    command += ` -- ${shellQuote(name)}`;
    return this.parseCreate(command, await this.capture(command, CREATE_TIMEOUT_MS));
  }

  /** `pocketshell sessions kill -- NAME`. */
  async killSession(name: string): Promise<void> {
    const command = `${this.binary} sessions kill -- ${shellQuote(name)}`;
    const outcome = await this.capture(command, KILL_TIMEOUT_MS);
    if (outcome.exitCode !== 0) throw nonZeroExit(command, outcome);
  }

  /** `pocketshell sessions warnings --json`; older hosts fail visibly. */
  async listWarnings(): Promise<WarningRow[]> {
    const command = `${this.binary} sessions warnings --json`;
    return parseHostWarnings(await this.captureJson(command, LIST_TIMEOUT_MS));
  }

  /** `pocketshell sessions ack --json [-- SELECTOR]`. */
  async ackWarnings(selector?: string | null): Promise<void> {
    const command = `${this.binary} sessions ack --json${selector == null ? '' : ` -- ${shellQuote(selector)}`}`;
    const outcome = await this.capture(command, ACK_TIMEOUT_MS);
    if (outcome.exitCode !== 0) throw nonZeroExit(command, outcome);
  }

  /** A PTY command that replaces the wrapping shell with the attached CLI. */
  buildAttachCommand(name: string): string {
    return `exec ${this.binary} sessions attach -- ${shellQuote(name)}`;
  }

  private parseCreate(command: string, outcome: HostCliExecOutcome): CreatedSession {
    if (!outcome.stdout.trim()) {
      if (outcome.exitCode !== 0) throw nonZeroExit(command, outcome);
      throw new HostCliMalformed(`\`${command}\` printed nothing on stdout`);
    }

    let root: JsonRecord;
    try {
      root = parseObject(outcome.stdout);
    } catch (error) {
      if (outcome.exitCode !== 0) throw nonZeroExit(command, outcome);
      throw error;
    }
    const schema = requiredSchema(root);
    if (schema < SESSION_SCHEMA) throw new HostCliTooOld(schema, SESSION_SCHEMA);
    if (root.error !== undefined && root.error !== null) {
      if (typeof root.error !== 'string') throw new HostCliMalformed('the create response `error` field was not a string');
      throw new HostCliFailed(command, outcome.exitCode, outcome.stderr, false, root.error);
    }
    if (outcome.exitCode !== 0) throw nonZeroExit(command, outcome);
    return parseShape(schema, 'create', () => {
      if (typeof root.name !== 'string') throw new Error('name must be a string');
      if (typeof root.created !== 'boolean') throw new Error('created must be a boolean');
      return { name: root.name, id: optionalString(root.id, 'id', 'create'), created: root.created };
    });
  }
}

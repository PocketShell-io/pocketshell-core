/**
 * Composer delivery: send routing and the bracketed-paste framing.
 *
 * WHY THE FRAMING LIVES HERE AND IS NOT OPTIONAL
 * ----------------------------------------------
 * The Android client talks to tmux through a `tmux -CC` control-mode client,
 * so `sendInputBytesToPane` (TmuxSessionViewModel.kt:9758-9800, :9860-9870)
 * gets to wrap multi-line input in bracketed-paste markers before the submit
 * key. This app writes into a PLAIN PTY running `tmux attach`, so nothing does
 * that for us — the renderer must do it itself.
 *
 * It matters because `appendAttachmentPaths` ALWAYS introduces newlines when
 * attachments are staged. Without the framing an agent
 * REPL treats every line of the `Attached files:` block as a separate prompt —
 * a bug that actually shipped on the phone (found in daily use 2026-05-27).
 *
 * Programs that do not enable bracketed paste render the markers literally.
 * The Kotlin accepts that degradation explicitly (:9793-9795); so do we.
 *
 * ## WHY THE PASTE TRAVELS AS THREE WRITES, NOT ONE
 *
 * The fixture's `/bin/sh` — and every minimal appliance shell, including the
 * one aplexer's shell engine runs — edits lines with busybox's line editor,
 * whose escape parser consumes a FIXED 16-byte window from any read chunk
 * that starts with ESC. A bracketed-paste frame delivered as one write
 * therefore loses `ESC[200~` plus the first ten characters of the prompt,
 * and the surviving fragment EXECUTES: the composer E2E watched
 * `echo bp_line_one` arrive as `ne_one`. The bytes are lost in the shell's
 * parser, not in any transport — the same bytes through a `cat` pane arrive
 * complete, and `tmux attach` hides the bug by re-emitting the marker as a
 * key of its own (probed 2026-09-22).
 *
 * The split makes the window land on bytes that exist to be eaten: the start
 * marker travels alone (a chunk of nothing but marker eats itself, which is
 * harmless), the body travels on its own, the end marker last. The gaps
 * between writes exist because the shell can only mis-parse what arrives in
 * one read: below ~50 ms of separation the chunks coalesce on the way down
 * and the head loss returns (measured: 40 ms broken, 60 ms safe, one 80 ms
 * run still failed), so `PASTE_GAP_MS` stays comfortably above the window.
 */

/** `ESC [ 2 0 0 ~` — "a paste starts here". */
export const BP_START = '\x1b[200~';
/** `ESC [ 2 0 1 ~` — "the paste ends here". */
export const BP_END = '\x1b[201~';

/**
 * The submit key, sent SEPARATELY and AFTER the paste block — never inside it
 * (Android `sendAgentPayloadToPaneResult`, :8777-8780).
 */
export const SUBMIT_KEY = '\r';

/**
 * Tunables, grouped so tests can shorten them without fake timers.
 *
 * `submitDelayMs`: issue #526. The Android default is 150ms
 * (SettingsModels.kt:271) with a 250ms floor for Codex
 * (TmuxSessionViewModel.kt:12135). We take the safe end of that range for every
 * send rather than only the Codex one: 250ms is imperceptible to a human and
 * Enter must never race the TUI's ingestion of the paste.
 *
 * `sendTimeoutMs`: SEND_TIMEOUT_MS (PromptComposerViewModel.kt:2535).
 * The Android `ATTACHMENT_UPLOAD_TIMEOUT_MS` (:2521) has no counterpart
 * here: uploads are unbounded — a big pick streams for as long as it
 * streams, and the SSH keepalive turns a dead connection into the
 * rejection the timeout existed to produce.
 */
export const composerTiming = {
  submitDelayMs: 250,
  sendTimeoutMs: 12_000,
};

/** True when the payload must be bracketed — i.e. it contains a line break. */
export function needsBracketedPaste(payload: string): boolean {
  return payload.includes('\n') || payload.includes('\r');
}

/**
 * The exact body written to the PTY before the submit key: bracketed when the
 * payload is multi-line, verbatim otherwise.
 */
export function frameForPaste(payload: string): string {
  return needsBracketedPaste(payload) ? BP_START + payload + BP_END : payload;
}

/**
 * Gap between the three paste writes. The shell's escape parser can only eat
 * into a read that starts with ESC, so the split has to survive the journey
 * down the channel without coalescing — measured 2026-09-22: 40 ms of
 * separation still loses the paste's head, 60 ms survives, one 80 ms run
 * still failed. 120 ms buys margin against a coalescing window that stretches
 * under load; both gaps together are still far below what a human notices in
 * a send that already waits `submitDelayMs` before Enter.
 */
export const PASTE_GAP_MS = 120;

/**
 * The payload writes shared by the desktop adapter and the portable delivery
 * controller. The body is kept verbatim: CRLF, lone CR, Unicode and trailing
 * newlines are all user input and are not normalized here.
 */
export function composerPayloadSegments(payload: string): string[] {
  return needsBracketedPaste(payload) ? [BP_START, payload, BP_END] : [payload];
}

/** Encode JavaScript text as UTF-8 without depending on DOM or Node globals. */
export function encodeComposerText(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const first = text.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = text.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
        index += 1;
      } else {
        // Match TextEncoder's USVString conversion for an unpaired surrogate.
        codePoint = 0xfffd;
      }
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

export type ComposerDeliveryIntent = 'insert' | 'submit';
export type ComposerDraftEffect = 'clear' | 'retain';

export interface ComposerDeliveryRequest {
  /** Unique per explicit user action; reused ids are never sent twice. */
  operationId: string;
  /** The exact composed text, including any staged attachment references. */
  payload: string;
  /** Insert leaves the prompt at the shell; submit appends a separate CR. */
  intent: ComposerDeliveryIntent;
}

export interface ComposerWriteContext {
  operationId: string;
  /** One-based index of the write within this operation. */
  writeIndex: number;
}

/** Platform effects for one PTY-bound composer controller. */
export interface ComposerDeliveryEffects {
  /** A resolving write acknowledges the bytes; a rejection is ambiguous. */
  write: (bytes: Uint8Array, context: ComposerWriteContext) => Promise<void>;
  /** Required so embedded engines do not need a host event-loop shim. */
  sleep: (ms: number) => Promise<void>;
}

export type ComposerDeliveryResult =
  | {
    status: 'delivered';
    operationId: string;
    intent: ComposerDeliveryIntent;
    draftEffect: 'clear';
    bytesAttempted: number;
    writeCount: number;
  }
  | {
    status: 'not-sent';
    operationId: string;
    intent: ComposerDeliveryIntent;
    draftEffect: 'retain';
    reason:
      | 'invalid-operation-id'
      | 'empty-payload'
      | 'disconnected'
      | 'transport-changed'
      | 'operation-id-reused';
    bytesAttempted: 0;
    writeCount: 0;
  }
  | {
    status: 'uncertain';
    operationId: string;
    intent: ComposerDeliveryIntent;
    draftEffect: 'retain';
    reason: 'transport-lost' | 'effect-failed';
    stage: 'write' | 'pacing';
    bytesAttempted: number;
    writeCount: number;
    error: string;
  };

/**
 * Serial composer delivery policy for one session's PTY.
 *
 * Create one controller per PTY. Every explicit insert/submit is serialized in
 * call order. A connection-state change invalidates the generation captured by
 * queued work, so an operation waiting for the queue cannot slip onto a newly
 * connected PTY. A write rejection is ambiguous even when it is the first
 * write: the bridge may have accepted some bytes before it failed. In that
 * case the result says `draftEffect: 'retain'`; reconnecting never retries it.
 *
 * The platform owns the draft store and applies only the returned draftEffect:
 * clear after a fully acknowledged operation, otherwise keep the same draft.
 * The controller never keeps a pending payload to replay on reconnect.
 */
export class ComposerDeliveryController {
  private transportState: 'connected' | 'lost' | 'closed' = 'closed';
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly operationIds = new Set<string>();
  private readonly submitDelayMs: number;
  private readonly pasteGapMs: number;

  constructor(
    private readonly effects: ComposerDeliveryEffects,
    options: { submitDelayMs?: number; pasteGapMs?: number } = {},
  ) {
    this.submitDelayMs = options.submitDelayMs ?? composerTiming.submitDelayMs;
    this.pasteGapMs = options.pasteGapMs ?? PASTE_GAP_MS;
  }

  /** Physical state only; TypeScript owns how a loss affects pending sends. */
  setTransportState(state: 'connected' | 'lost' | 'closed'): void {
    if (this.transportState === state) return;
    this.transportState = state;
    this.generation += 1;
  }

  /** Enqueue one user action. Reused ids are refused and never write again. */
  deliver(request: ComposerDeliveryRequest): Promise<ComposerDeliveryResult> {
    const notSent = (
      reason: Extract<ComposerDeliveryResult, { status: 'not-sent' }>['reason'],
    ): Promise<ComposerDeliveryResult> => Promise.resolve({
      status: 'not-sent',
      operationId: request.operationId,
      intent: request.intent,
      draftEffect: 'retain',
      reason,
      bytesAttempted: 0,
      writeCount: 0,
    });
    if (request.operationId === '') {
      return notSent('invalid-operation-id');
    }
    if (this.operationIds.has(request.operationId)) return notSent('operation-id-reused');
    this.operationIds.add(request.operationId);

    const generation = this.generation;
    const result = this.queue.then(() => this.deliverOne(request, generation));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async deliverOne(
    request: ComposerDeliveryRequest,
    generation: number,
  ): Promise<ComposerDeliveryResult> {
    const notSent = (
      reason: Extract<ComposerDeliveryResult, { status: 'not-sent' }>['reason'],
    ): ComposerDeliveryResult => ({
      status: 'not-sent',
      operationId: request.operationId,
      intent: request.intent,
      draftEffect: 'retain',
      reason,
      bytesAttempted: 0,
      writeCount: 0,
    });
    const isCurrent = (): boolean =>
      this.transportState === 'connected' && this.generation === generation;

    if (request.payload.length === 0) return notSent('empty-payload');
    if (this.transportState !== 'connected') return notSent('disconnected');
    if (this.generation !== generation) return notSent('transport-changed');

    let bytesAttempted = 0;
    let writeCount = 0;
    let stage: 'write' | 'pacing' = 'write';
    const failIfStale = (): void => {
      if (!isCurrent()) throw new Error('Composer transport generation changed.');
    };
    const write = async (text: string): Promise<void> => {
      failIfStale();
      const bytes = encodeComposerText(text);
      writeCount += 1;
      bytesAttempted += bytes.length;
      stage = 'write';
      await this.effects.write(bytes, { operationId: request.operationId, writeIndex: writeCount });
      failIfStale();
    };
    const pause = async (ms: number): Promise<void> => {
      if (ms <= 0) return;
      failIfStale();
      stage = 'pacing';
      await this.effects.sleep(ms);
      failIfStale();
    };

    try {
      const parts = composerPayloadSegments(request.payload);
      for (let index = 0; index < parts.length; index += 1) {
        await write(parts[index]!);
        if (index < parts.length - 1) await pause(this.pasteGapMs);
      }
      if (request.intent === 'submit') {
        await pause(this.submitDelayMs);
        await write(SUBMIT_KEY);
      }
      return {
        status: 'delivered',
        operationId: request.operationId,
        intent: request.intent,
        draftEffect: 'clear',
        bytesAttempted,
        writeCount,
      };
    } catch (error) {
      if (writeCount === 0) {
        return notSent(
          this.transportState === 'connected' ? 'transport-changed' : 'disconnected',
        );
      }
      const transportLost = !isCurrent();
      return {
        status: 'uncertain',
        operationId: request.operationId,
        intent: request.intent,
        draftEffect: 'retain',
        reason: transportLost ? 'transport-lost' : 'effect-failed',
        stage,
        bytesAttempted,
        writeCount,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export interface DeliverOptions {
  /** Writes bytes to the PTY. Resolves false when the write did not land. */
  write: (data: string) => Promise<boolean>;
  /** Overrides `composerTiming.submitDelayMs`. */
  submitDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Write one composed prompt to a PTY: framed body, pause, submit key.
 *
 * The bracketed frame crosses the wire as three writes — START, body, END —
 * with `PASTE_GAP_MS` between them, because a single-write paste loses its
 * head to the shell's escape parser (module header). Returns false without
 * pressing Enter when a write fails. A failed write can still be partial; new
 * clients should use `ComposerDeliveryController` to distinguish uncertainty
 * and retain the draft explicitly.
 */
export async function deliverPayload(payload: string, opts: DeliverOptions): Promise<boolean> {
  const delay = opts.submitDelayMs ?? composerTiming.submitDelayMs;
  const sleep = opts.sleep ?? defaultSleep;
  const parts = composerPayloadSegments(payload);
  for (const [i, part] of parts.entries()) {
    if (!(await opts.write(part))) return false;
    if (i < parts.length - 1 && PASTE_GAP_MS > 0) await sleep(PASTE_GAP_MS);
  }
  if (delay > 0) await sleep(delay);
  return opts.write(SUBMIT_KEY);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Agent engines the composer can route to. Mirrors Android's `AgentKind`. */
export type ComposerAgentKind = 'claude' | 'codex' | 'opencode' | 'grok';

/**
 * Narrow a host-recorded `SessionAgentKind` (types.ts:103) to the engines the
 * composer can actually route to and offer commands for.
 *
 * `shell` and `unknown` are the phone's "not an agent" — a shell pane must never
 * get a slash dropdown. `probing` / `exited` are transient detector states with
 * no engine to talk to yet, so they map to null too: the catalog must never
 * offer a command we cannot name an engine for.
 */
export function composerAgentKind(
  kind: 'claude' | 'codex' | 'opencode' | 'grok' | 'shell' | 'probing' | 'exited' | 'unknown' | null | undefined,
): ComposerAgentKind | null {
  switch (kind) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'grok':
      return kind;
    default:
      return null;
  }
}

/**
 * Android: `TmuxComposerSendRoute` (TmuxSessionScreen.kt:3159).
 *
 * The phone's third arm, `'agent-conversation'`, is GONE rather than merely
 * unreachable. It existed for the Conversation tab, which has been deleted
 *, and it never did anything the `'raw'` arm did not:
 * both wrote to the pane's PTY, because there was no live transcript to echo
 * an optimistic turn into. What it DID do, unhelpfully, was short-circuit
 * ahead of the codex arm below — so a codex pane viewed from the Conversation
 * tab got the SHORT submit delay and could drop its Enter. Removing the arm
 * fixes that as a side effect.
 */
export type ComposerSendRoute = 'agent-payload' | 'raw';

export interface SendRouteInput {
  /** The engine currently running in the pane, when detection knows. */
  liveAgent: ComposerAgentKind | null;
  /** The engine we believe the pane runs, from history rather than detection. */
  presumedAgent: ComposerAgentKind | null;
  /** Always true inside the composer — there is exactly one Send verb. */
  withEnter: boolean;
}

/**
 * Android: the `when` block at `TmuxSessionScreen.kt:3163-3179`, ported shape
 * for shape.
 *
 * `liveAgent` is fed from the host-recorded `@ps_agent_kind` tmux option via
 * `composerAgentKind`, so the Codex arm is live. `presumedAgent` has no desktop
 * source yet — nothing infers an engine from history.
 */
export function sendRoute(input: SendRouteInput): ComposerSendRoute {
  if (input.withEnter && input.liveAgent === 'codex') return 'agent-payload';
  if (input.liveAgent !== null) return 'raw';
  if (input.presumedAgent !== null) return 'agent-payload';
  return 'raw';
}

/** Resolve a promise to `null` if it has not settled within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

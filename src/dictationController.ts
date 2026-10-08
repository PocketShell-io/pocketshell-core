/**
 * Portable dictation lifecycle policy.
 *
 * This controller owns recognition-turn state only. Adapters own microphone
 * permission, recognizer configuration and delivery of the completed
 * transcript to a composer or terminal.
 *
 * Nothing the user dictated may disappear unless they explicitly cancel it
 * (issue #3060). A partial is a preview while its turn is live, but whenever
 * a turn ends without a final that covers it (stop with no result, a final
 * shorter than the last partial, an error, an early endpoint, backgrounding,
 * a target change or a closed surface) the latest partial is promoted into
 * `transcript`. Only `cancel()` - an explicit user action - drops text.
 *
 * While listening, `noSpeech` reports that recognition is producing no text
 * (issue #3062): nothing was recognized for `noTextWarningMs`, or the
 * recognizer keeps ending turns with no match while the controller silently
 * restarts them. It only informs; it never changes the transcript.
 */

export type DictationPhase =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'stopping'
  | 'completed'
  | 'cancelled'
  | 'error';

/** Only an explicit user action may drop dictated text. */
export type DictationCancelReason = 'user';

/**
 * Lifecycle events that end a run early but keep everything dictated so far:
 * the app went to the background (screen off), the target changed, or the
 * dictation surface closed/unmounted.
 */
export type DictationInterruptReason = 'background' | 'target-change' | 'closed';

/** Endpointing outcomes that should resume an active dictation. */
export type DictationRecoverableEnd = 'no-match' | 'speech-timeout' | 'recognizer-busy';

/**
 * Coarse microphone evidence since the last recognized text: `unknown` when
 * the adapter reports no audio levels, `silent` when it reported only
 * silence, `sound` once it reported any sound.
 */
export type DictationAudioEvidence = 'unknown' | 'silent' | 'sound';

/** Why listening is flagged as producing no recognized text. */
export type DictationNoSpeechReason = 'no-text-timeout' | 'empty-turns';

export interface DictationNoSpeech {
  reason: DictationNoSpeechReason;
  audio: DictationAudioEvidence;
  /** Consecutive recognizer turns that ended with no match since the last text. */
  emptyTurns: number;
}

/** Default "no recognized text yet" window (#3062). */
export const DEFAULT_NO_TEXT_WARNING_MS = 8_000;
/** Consecutive empty (no-match / speech-timeout) turns that raise the signal early. */
export const DEFAULT_NO_TEXT_RESTART_LIMIT = 2;

export interface DictationError {
  code: string;
  message: string;
}

export interface DictationSnapshot {
  /** Monotonically increases every time the public state changes. */
  revision: number;
  phase: DictationPhase;
  /** Target associated with this run, retained after cancellation for safe handoff. */
  targetId: string | null;
  /** Identity of the one recognizer turn currently allowed to report events. */
  requestId: string | null;
  /**
   * Latest partial of the live turn. It is folded into `segments` when the
   * turn ends without a final that covers it; `cancel()` alone discards it.
   */
  partial: string;
  /** Final recognized turns, each accepted at most once for its request id. */
  segments: readonly string[];
  /** Trimmed final segments joined with one space. */
  transcript: string;
  error: DictationError | null;
  cancelReason: DictationCancelReason | null;
  /** Set when a lifecycle event ended the run as `completed`, keeping the text. */
  interruptReason: DictationInterruptReason | null;
  /**
   * Non-null while listening has produced no recognized text for a while
   * (#3062). Cleared by any non-blank partial or final, and whenever the run
   * stops listening. Informational only.
   */
  noSpeech: DictationNoSpeech | null;
}

export interface DictationControllerOptions {
  /** Start one recognizer turn. The adapter must associate callbacks with `requestId`. */
  startRecognition(requestId: string): void | Promise<void>;
  /** Ask the active turn to resolve and return its final result. */
  stopRecognition(requestId: string): void | Promise<void>;
  /** Immediately abandon the active turn. Late callbacks will be ignored. */
  cancelRecognition(requestId: string): void | Promise<void>;
  /** Defer the next turn until the current recognizer callback has unwound. */
  schedule(callback: () => void): unknown;
  /** Cancel a deferred restart returned by `schedule`. */
  cancelScheduled(handle: unknown): void;
  /** Optional deterministic ID source. IDs must be unique for this controller's lifetime. */
  createRequestId?: () => string;
  /** Milliseconds of listening without recognized text before `noSpeech` is raised. */
  noTextWarningMs?: number;
  /** Consecutive empty recognizer turns that raise `noSpeech` before the window elapses. */
  noTextRestartLimit?: number;
  /** Delayed callback for the no-text window; defaults to `setTimeout`. */
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  /** Cancels a handle returned by `setTimer`; defaults to `clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
}

interface PendingRestart {
  token: number;
  handle: unknown;
  hasHandle: boolean;
}

function defaultRequestId(): string {
  return `dictation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Speech recognition failed.';
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function wordCount(text: string): number {
  return text ? text.split(/\s+/u).length : 0;
}

/**
 * Pick the text for one finished turn. Some recognizers return a final that
 * drops the tail the last partial already showed ("so let's" after "so let's
 * solve it"); keep the partial when it has more words. Otherwise the final
 * wins, so its punctuation and revisions are kept.
 */
function coveringSegment(finalText: string, partial: string): string {
  return wordCount(partial) > wordCount(finalText) ? partial : finalText;
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return typeof value === 'object' && value !== null && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Dictation policy shared by clients with different speech-recognition APIs.
 *
 * Call `setTarget` and `setForeground` from app lifecycle events, `start` on
 * the mic tap, and `stop` on the explicit stop tap. Native or browser adapter
 * callbacks must carry the request id supplied to `startRecognition`.
 */
export class DictationController {
  private readonly options: DictationControllerOptions;
  private readonly listeners = new Set<(snapshot: DictationSnapshot) => void>();
  private readonly usedRequestIds = new Set<string>();
  private readonly idPrefix = defaultRequestId();
  private configuredTargetId: string | null = null;
  private foreground = true;
  private sequence = 0;
  private revision = 0;
  private currentRequestId: string | null = null;
  private requestStartResolved = false;
  private stopIssued = false;
  private desiredListening = false;
  private pendingRestart: PendingRestart | null = null;
  private restartToken = 0;
  private readonly noTextWarningMs: number;
  private readonly noTextRestartLimit: number;
  private noTextTimer: { handle: unknown; token: number } | null = null;
  private noTextToken = 0;
  private noTextElapsed = false;
  private emptyTurns = 0;
  private turnHadText = false;
  private audioEvidence: DictationAudioEvidence = 'unknown';
  private snapshot: DictationSnapshot = {
    revision: 0,
    phase: 'idle',
    targetId: null,
    requestId: null,
    partial: '',
    segments: [],
    transcript: '',
    error: null,
    cancelReason: null,
    interruptReason: null,
    noSpeech: null,
  };

  constructor(options: DictationControllerOptions) {
    this.options = options;
    this.noTextWarningMs = positiveOr(options.noTextWarningMs, DEFAULT_NO_TEXT_WARNING_MS);
    this.noTextRestartLimit = Math.floor(positiveOr(options.noTextRestartLimit, DEFAULT_NO_TEXT_RESTART_LIMIT));
  }

  getSnapshot(): DictationSnapshot {
    return this.copySnapshot();
  }

  subscribe(listener: (snapshot: DictationSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  /**
   * Set the composer/session target. Changing it during a run ends that run
   * immediately but keeps its text; the completed snapshot remains tagged with
   * the old target so the adapter can file it under the original draft.
   */
  setTarget(targetId: string | null): void {
    if (targetId === this.configuredTargetId) return;
    this.configuredTargetId = targetId;
    if (this.isActive()) this.interrupt('target-change');
  }

  /**
   * Backgrounding (screen off) releases the microphone and invalidates
   * outstanding events, but keeps finals and the latest partial.
   */
  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    if (!foreground && this.isActive()) this.interrupt('background');
  }

  /** Start a fresh dictation for the currently selected target. */
  start(): string | null {
    if (this.isActive() || !this.foreground || this.configuredTargetId === null) return null;
    this.cancelPendingRestart();
    this.desiredListening = true;
    this.snapshot = {
      revision: this.revision,
      phase: 'idle',
      targetId: this.configuredTargetId,
      requestId: null,
      partial: '',
      segments: [],
      transcript: '',
      error: null,
      cancelReason: null,
      interruptReason: null,
      noSpeech: null,
    };
    this.resetNoSpeechTracking();
    const requestId = this.beginTurn();
    this.publish();
    return requestId;
  }

  /**
   * Stop listening and wait for the active recognizer turn's final result.
   * No next turn is armed after this call.
   */
  stop(): void {
    if (!this.isActive()) return;
    this.desiredListening = false;
    this.cancelPendingRestart();
    this.endNoSpeechTracking();
    if (this.currentRequestId === null) {
      this.snapshot = { ...this.snapshot, phase: 'completed', requestId: null, partial: '' };
      this.publish();
      return;
    }
    this.snapshot = { ...this.snapshot, phase: 'stopping' };
    this.publish();
    if (this.requestStartResolved) this.issueStop(this.currentRequestId);
  }

  /**
   * End the run now without waiting for the recognizer, keeping finals and
   * the latest partial as a `completed` transcript. The active turn is
   * abandoned, so its late callbacks cannot change the kept text.
   */
  interrupt(reason: DictationInterruptReason): void {
    if (!this.isActive()) return;
    const requestId = this.currentRequestId;
    this.desiredListening = false;
    this.cancelPendingRestart();
    this.endNoSpeechTracking();
    this.currentRequestId = null;
    this.requestStartResolved = false;
    this.stopIssued = false;
    this.promotePartial();
    this.snapshot = {
      ...this.snapshot,
      phase: 'completed',
      requestId: null,
      interruptReason: reason,
    };
    this.publish();
    if (requestId !== null) this.callCancel(requestId);
  }

  /** Explicit user cancel: the only path that discards dictated text. */
  cancel(reason: DictationCancelReason = 'user'): void {
    if (!this.isActive()) return;
    const requestId = this.currentRequestId;
    this.desiredListening = false;
    this.cancelPendingRestart();
    this.endNoSpeechTracking();
    this.currentRequestId = null;
    this.requestStartResolved = false;
    this.stopIssued = false;
    this.snapshot = {
      ...this.snapshot,
      phase: 'cancelled',
      requestId: null,
      partial: '',
      cancelReason: reason,
    };
    this.publish();
    if (requestId !== null) this.callCancel(requestId);
  }

  /** Record the latest partial for the current request (see `partial`). */
  onPartial(requestId: string, text: string): boolean {
    if (!this.accepts(requestId)) return false;
    this.snapshot = { ...this.snapshot, partial: text };
    if (text.trim()) this.textRecognized();
    this.publish();
    return true;
  }

  /**
   * Coarse audio evidence for the current turn: `true` when the adapter's
   * microphone level shows sound, `false` for silence. Used only to word the
   * `noSpeech` signal; never carries audio content.
   */
  onAudioLevel(requestId: string, soundPresent: boolean): boolean {
    if (!this.accepts(requestId)) return false;
    const next: DictationAudioEvidence = soundPresent ? 'sound' : this.audioEvidence === 'unknown' ? 'silent' : this.audioEvidence;
    if (next === this.audioEvidence) return true;
    this.audioEvidence = next;
    if (this.snapshot.noSpeech) {
      this.snapshot = { ...this.snapshot, noSpeech: { ...this.snapshot.noSpeech, audio: next } };
      this.publish();
    }
    return true;
  }

  /** Commit one final recognizer turn, then continue or finish according to policy. */
  onRecognizedSegment(requestId: string, text: string): boolean {
    if (!this.accepts(requestId)) return false;
    const segment = coveringSegment(text.trim(), this.snapshot.partial.trim());
    if (!segment) return this.onRecoverableEnd(requestId, 'no-match');
    this.settleRequest(requestId);
    this.textRecognized();
    const segments = [...this.snapshot.segments, segment];
    this.snapshot = {
      ...this.snapshot,
      partial: '',
      segments,
      transcript: segments.join(' '),
      requestId: null,
    };
    if (this.desiredListening) {
      this.snapshot = { ...this.snapshot, phase: 'listening' };
      this.publish();
      this.scheduleNextTurn();
    } else {
      this.endNoSpeechTracking();
      this.snapshot = { ...this.snapshot, phase: 'completed' };
      this.publish();
    }
    return true;
  }

  /** A known transient endpointing outcome; it resumes only while listening. */
  onRecoverableEnd(requestId: string, reason: DictationRecoverableEnd): boolean {
    if (!this.accepts(requestId)) return false;
    const emptyTurn = !this.turnHadText && reason !== 'recognizer-busy';
    this.settleRequest(requestId);
    this.promotePartial();
    this.snapshot = { ...this.snapshot, requestId: null };
    if (this.desiredListening) {
      if (emptyTurn) this.countEmptyTurn();
      this.snapshot = { ...this.snapshot, phase: 'listening' };
      this.publish();
      this.scheduleNextTurn();
    } else {
      this.endNoSpeechTracking();
      this.snapshot = { ...this.snapshot, phase: 'completed' };
      this.publish();
    }
    return true;
  }

  /** Any non-recoverable recognizer failure ends this run and keeps finals and the partial. */
  onError(requestId: string, error: DictationError): boolean {
    if (!this.accepts(requestId)) return false;
    this.settleRequest(requestId);
    this.promotePartial();
    this.endNoSpeechTracking();
    this.snapshot = {
      ...this.snapshot,
      phase: 'error',
      requestId: null,
      partial: '',
      error: { ...error },
    };
    this.desiredListening = false;
    this.publish();
    return true;
  }

  private beginTurn(): string {
    const requestId = this.nextRequestId();
    this.currentRequestId = requestId;
    this.requestStartResolved = false;
    this.stopIssued = false;
    this.turnHadText = false;
    this.snapshot = {
      ...this.snapshot,
      phase: 'starting',
      requestId,
      partial: '',
      error: null,
      cancelReason: null,
      interruptReason: null,
    };

    let result: void | Promise<void>;
    try {
      result = this.options.startRecognition(requestId);
    } catch (error) {
      this.failStart(requestId, error);
      return requestId;
    }
    if (isPromiseLike(result)) {
      Promise.resolve(result).then(
        () => this.startResolved(requestId),
        (error: unknown) => this.failStart(requestId, error),
      );
    } else {
      this.startResolved(requestId);
    }
    return requestId;
  }

  private startResolved(requestId: string): void {
    if (this.currentRequestId !== requestId) return;
    this.requestStartResolved = true;
    if (this.snapshot.phase === 'stopping') {
      this.issueStop(requestId);
      return;
    }
    if (this.snapshot.phase === 'starting') {
      this.snapshot = { ...this.snapshot, phase: 'listening' };
      // The no-text window starts once the microphone is live, not while
      // a permission prompt may still be open.
      if (this.noTextTimer === null && !this.noTextElapsed) this.armNoTextTimer();
      this.publish();
    }
  }

  private failStart(requestId: string, error: unknown): void {
    if (this.currentRequestId !== requestId) return;
    this.settleRequest(requestId);
    this.desiredListening = false;
    this.endNoSpeechTracking();
    this.snapshot = {
      ...this.snapshot,
      phase: 'error',
      requestId: null,
      partial: '',
      error: { code: 'start-failed', message: errorMessage(error) },
    };
    this.publish();
  }

  private issueStop(requestId: string): void {
    if (this.currentRequestId !== requestId || this.stopIssued) return;
    this.stopIssued = true;
    let result: void | Promise<void>;
    try {
      result = this.options.stopRecognition(requestId);
    } catch (error) {
      this.failStop(requestId, error);
      return;
    }
    if (isPromiseLike(result)) {
      Promise.resolve(result).catch((error: unknown) => this.failStop(requestId, error));
    }
  }

  private failStop(requestId: string, error: unknown): void {
    if (this.currentRequestId !== requestId) return;
    this.callCancel(requestId);
    this.settleRequest(requestId);
    this.promotePartial();
    this.endNoSpeechTracking();
    this.snapshot = {
      ...this.snapshot,
      phase: 'error',
      requestId: null,
      partial: '',
      error: { code: 'stop-failed', message: errorMessage(error) },
    };
    this.desiredListening = false;
    this.publish();
  }

  private scheduleNextTurn(): void {
    if (!this.desiredListening || this.pendingRestart !== null) return;
    const pending: PendingRestart = { token: ++this.restartToken, handle: undefined, hasHandle: false };
    this.pendingRestart = pending;
    try {
      const handle = this.options.schedule(() => {
        if (this.pendingRestart?.token !== pending.token) return;
        this.pendingRestart = null;
        if (!this.desiredListening || this.snapshot.phase !== 'listening' || this.currentRequestId !== null) return;
        this.beginTurn();
        this.publish();
      });
      if (this.pendingRestart === pending) {
        pending.handle = handle;
        pending.hasHandle = true;
      }
    } catch (error) {
      if (this.pendingRestart !== pending) return;
      this.pendingRestart = null;
      this.desiredListening = false;
      this.endNoSpeechTracking();
      this.snapshot = {
        ...this.snapshot,
        phase: 'error',
        error: { code: 'restart-scheduling-failed', message: errorMessage(error) },
      };
      this.publish();
    }
  }

  private cancelPendingRestart(): void {
    const pending = this.pendingRestart;
    this.pendingRestart = null;
    this.restartToken += 1;
    if (pending?.hasHandle) {
      try {
        this.options.cancelScheduled(pending.handle);
      } catch {
        // The token also invalidates a callback if the scheduler cannot cancel it.
      }
    }
  }

  /** Any non-blank recognized text: clear the warning and restart the window. */
  private textRecognized(): void {
    this.turnHadText = true;
    this.emptyTurns = 0;
    this.audioEvidence = 'unknown';
    this.noTextElapsed = false;
    if (this.snapshot.noSpeech) this.snapshot = { ...this.snapshot, noSpeech: null };
    if (this.desiredListening) this.armNoTextTimer();
  }

  private countEmptyTurn(): void {
    this.emptyTurns += 1;
    if (this.snapshot.noSpeech) {
      this.snapshot = { ...this.snapshot, noSpeech: { ...this.snapshot.noSpeech, emptyTurns: this.emptyTurns } };
    } else if (this.emptyTurns >= this.noTextRestartLimit) {
      this.raiseNoSpeech('empty-turns');
    }
  }

  private raiseNoSpeech(reason: DictationNoSpeechReason): void {
    this.snapshot = {
      ...this.snapshot,
      noSpeech: { reason, audio: this.audioEvidence, emptyTurns: this.emptyTurns },
    };
  }

  private armNoTextTimer(): void {
    this.clearNoTextTimer();
    const token = ++this.noTextToken;
    const fire = () => {
      if (this.noTextTimer?.token !== token) return;
      this.noTextTimer = null;
      this.noTextElapsed = true;
      if (!this.desiredListening || this.snapshot.noSpeech) return;
      if (this.snapshot.phase !== 'listening' && this.snapshot.phase !== 'starting') return;
      this.raiseNoSpeech('no-text-timeout');
      this.publish();
    };
    const setTimer = this.options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    this.noTextTimer = { handle: undefined, token };
    const handle = setTimer(fire, this.noTextWarningMs);
    if (this.noTextTimer?.token === token) this.noTextTimer.handle = handle;
  }

  private clearNoTextTimer(): void {
    const timer = this.noTextTimer;
    this.noTextTimer = null;
    this.noTextToken += 1;
    if (!timer) return;
    try {
      const clearTimer = this.options.clearTimer
        ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
      clearTimer(timer.handle);
    } catch {
      // The token already makes a late timer callback inert.
    }
  }

  private resetNoSpeechTracking(): void {
    this.clearNoTextTimer();
    this.noTextElapsed = false;
    this.emptyTurns = 0;
    this.turnHadText = false;
    this.audioEvidence = 'unknown';
  }

  /** Listening is over: drop the warning and its timer. */
  private endNoSpeechTracking(): void {
    this.resetNoSpeechTracking();
    if (this.snapshot.noSpeech) this.snapshot = { ...this.snapshot, noSpeech: null };
  }

  /** Fold the latest partial into the transcript as its own segment. */
  private promotePartial(): void {
    const partial = this.snapshot.partial.trim();
    if (!partial) {
      if (this.snapshot.partial) this.snapshot = { ...this.snapshot, partial: '' };
      return;
    }
    const segments = [...this.snapshot.segments, partial];
    this.snapshot = { ...this.snapshot, partial: '', segments, transcript: segments.join(' ') };
  }

  private settleRequest(requestId: string): void {
    if (this.currentRequestId !== requestId) return;
    this.currentRequestId = null;
    this.requestStartResolved = false;
    this.stopIssued = false;
  }

  private accepts(requestId: string): boolean {
    return this.currentRequestId === requestId
      && (this.snapshot.phase === 'starting' || this.snapshot.phase === 'listening' || this.snapshot.phase === 'stopping');
  }

  private isActive(): boolean {
    return this.snapshot.phase === 'starting'
      || this.snapshot.phase === 'listening'
      || this.snapshot.phase === 'stopping';
  }

  private nextRequestId(): string {
    const requestId = this.options.createRequestId?.() ?? `${this.idPrefix}-${++this.sequence}`;
    if (!requestId || this.usedRequestIds.has(requestId)) {
      throw new Error('Dictation request ids must be non-empty and unique.');
    }
    this.usedRequestIds.add(requestId);
    return requestId;
  }

  private callCancel(requestId: string): void {
    try {
      const result = this.options.cancelRecognition(requestId);
      if (isPromiseLike(result)) Promise.resolve(result).catch(() => undefined);
    } catch {
      // Cancellation is best-effort at the adapter boundary; state invalidation
      // has already made every callback for this request stale.
    }
  }

  private copySnapshot(): DictationSnapshot {
    return {
      ...this.snapshot,
      segments: [...this.snapshot.segments],
      error: this.snapshot.error ? { ...this.snapshot.error } : null,
      noSpeech: this.snapshot.noSpeech ? { ...this.snapshot.noSpeech } : null,
    };
  }

  private publish(): void {
    this.revision += 1;
    this.snapshot = { ...this.snapshot, revision: this.revision };
    for (const listener of this.listeners) listener(this.getSnapshot());
  }
}

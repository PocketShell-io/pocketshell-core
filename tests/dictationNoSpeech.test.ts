import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NO_TEXT_WARNING_MS,
  DictationController,
  type DictationControllerOptions,
} from '../src/dictationController';

/**
 * Issue #3062: the maintainer dictated for two minutes and nothing was
 * recognized, with no warning. The shared controller must expose a
 * "listening without recognized text" signal: raised after N seconds with no
 * partial or final, cleared by any recognized text, and raised early when the
 * recognizer keeps ending turns with no match while dictation restarts them.
 */

class FakeTimers {
  private now = 0;
  private nextHandle = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number): number => {
    const handle = ++this.nextHandle;
    this.timers.set(handle, { at: this.now + delayMs, callback });
    return handle;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Advance the clock, firing due timers in order (timers may arm new ones). */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }

  pending(): number {
    return this.timers.size;
  }
}

function setup(overrides: Partial<DictationControllerOptions> = {}) {
  const timers = new FakeTimers();
  const restarts: Array<() => void> = [];
  let nextId = 0;
  const controller = new DictationController({
    startRecognition: () => undefined,
    stopRecognition: () => undefined,
    cancelRecognition: () => undefined,
    schedule: (callback) => { restarts.push(callback); return restarts.length; },
    cancelScheduled: () => undefined,
    createRequestId: () => `turn-${++nextId}`,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    noTextWarningMs: 8_000,
    ...overrides,
  });
  controller.setTarget('composer:session-a');
  /** Run the deferred next-turn restart the controller queued. */
  const restart = () => {
    const callback = restarts.shift();
    if (!callback) throw new Error('No restart is queued.');
    callback();
  };
  return { controller, timers, restart };
}

function startListening(set: ReturnType<typeof setup>): string {
  const id = set.controller.start();
  if (id === null) throw new Error('Expected dictation to start.');
  expect(set.controller.getSnapshot().phase).toBe('listening');
  return id;
}

function currentId(set: ReturnType<typeof setup>): string {
  const id = set.controller.getSnapshot().requestId;
  if (id === null) throw new Error('Expected an active recognizer turn.');
  return id;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DictationController no-recognized-text signal (#3062)', () => {
  it('raises the signal after N seconds of listening with audio but no partial or final', () => {
    const state = setup();
    const id = startListening(state);
    expect(state.controller.getSnapshot().noSpeech).toBeNull();

    state.controller.onAudioLevel(id, true);
    state.timers.advance(7_999);
    expect(state.controller.getSnapshot().noSpeech).toBeNull();

    state.timers.advance(1);
    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'listening',
      noSpeech: { reason: 'no-text-timeout', audio: 'sound', emptyTurns: 0 },
    });
  });

  it('a partial clears the signal and restarts the N-second window', () => {
    const state = setup();
    const id = startListening(state);
    state.timers.advance(8_000);
    expect(state.controller.getSnapshot().noSpeech?.reason).toBe('no-text-timeout');

    expect(state.controller.onPartial(id, 'hello there')).toBe(true);
    expect(state.controller.getSnapshot().noSpeech).toBeNull();

    // The window restarts from the partial, not from the start of dictation.
    state.timers.advance(7_999);
    expect(state.controller.getSnapshot().noSpeech).toBeNull();
    state.timers.advance(1);
    expect(state.controller.getSnapshot().noSpeech?.reason).toBe('no-text-timeout');
  });

  it('a final segment clears the signal and the audio evidence', () => {
    const state = setup();
    const id = startListening(state);
    state.controller.onAudioLevel(id, true);
    state.timers.advance(8_000);
    expect(state.controller.getSnapshot().noSpeech?.audio).toBe('sound');

    state.controller.onRecognizedSegment(id, 'fix the build');
    expect(state.controller.getSnapshot()).toMatchObject({ noSpeech: null, transcript: 'fix the build' });
    state.restart();
    state.timers.advance(8_000);
    // No audio reported since the last recognized text.
    expect(state.controller.getSnapshot().noSpeech).toMatchObject({ reason: 'no-text-timeout', audio: 'unknown' });
  });

  it('a whitespace-only partial is not recognized text and does not clear the signal', () => {
    const state = setup();
    const id = startListening(state);
    state.timers.advance(8_000);
    state.controller.onPartial(id, '   ');
    expect(state.controller.getSnapshot().noSpeech?.reason).toBe('no-text-timeout');
  });

  it('distinguishes silence from sound without words using the adapter audio flag', () => {
    const state = setup();
    const id = startListening(state);
    state.controller.onAudioLevel(id, false);
    state.timers.advance(8_000);
    expect(state.controller.getSnapshot().noSpeech?.audio).toBe('silent');

    // Sound arriving while the warning is up updates the wording live.
    state.controller.onAudioLevel(id, true);
    expect(state.controller.getSnapshot().noSpeech?.audio).toBe('sound');
    // A later quiet moment does not erase that sound was heard since the last text.
    state.controller.onAudioLevel(id, false);
    expect(state.controller.getSnapshot().noSpeech?.audio).toBe('sound');
  });

  it('raises the signal on a silent restart loop of no-match / speech-timeout turns before N seconds', () => {
    const state = setup();
    startListening(state);

    state.controller.onRecoverableEnd(currentId(state), 'no-match');
    expect(state.controller.getSnapshot().noSpeech).toBeNull();
    state.restart();
    state.controller.onRecoverableEnd(currentId(state), 'speech-timeout');
    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'listening',
      noSpeech: { reason: 'empty-turns', emptyTurns: 2 },
    });
    // The controller keeps restarting; the count keeps growing while the warning stays.
    state.restart();
    state.controller.onRecognizedSegment(currentId(state), '');
    expect(state.controller.getSnapshot().noSpeech).toMatchObject({ reason: 'empty-turns', emptyTurns: 3 });

    // Recognized text breaks the loop.
    state.restart();
    state.controller.onPartial(currentId(state), 'finally');
    expect(state.controller.getSnapshot().noSpeech).toBeNull();
  });

  it('does not count a turn that produced a partial, nor a busy recognizer, as an empty turn', () => {
    const state = setup();
    startListening(state);
    const first = currentId(state);
    state.controller.onPartial(first, 'some words');
    state.controller.onRecoverableEnd(first, 'no-match');
    state.restart();
    state.controller.onRecoverableEnd(currentId(state), 'recognizer-busy');
    state.restart();
    state.controller.onRecoverableEnd(currentId(state), 'no-match');
    expect(state.controller.getSnapshot()).toMatchObject({ noSpeech: null, transcript: 'some words' });
  });

  it('keeps the timeout window running across silent restarts within one dictation', () => {
    const state = setup({ noTextRestartLimit: 99 });
    startListening(state);
    state.timers.advance(5_000);
    state.controller.onRecoverableEnd(currentId(state), 'speech-timeout');
    state.restart();
    state.timers.advance(3_000);
    expect(state.controller.getSnapshot().noSpeech).toMatchObject({ reason: 'no-text-timeout', emptyTurns: 1 });
  });

  it('clears the signal and its timer once dictation stops, is cancelled, interrupted or fails', () => {
    for (const end of ['stop', 'cancel', 'interrupt', 'error'] as const) {
      const state = setup();
      const id = startListening(state);
      state.timers.advance(8_000);
      expect(state.controller.getSnapshot().noSpeech).not.toBeNull();
      if (end === 'stop') state.controller.stop();
      if (end === 'cancel') state.controller.cancel();
      if (end === 'interrupt') state.controller.interrupt('background');
      if (end === 'error') state.controller.onError(id, { code: 'audio-error', message: 'mic failed' });
      expect(state.controller.getSnapshot().noSpeech, end).toBeNull();
      expect(state.timers.pending(), end).toBe(0);
    }
  });

  it('never alters the transcript, partial or segments when the signal is raised', () => {
    const state = setup();
    const id = startListening(state);
    state.controller.onRecognizedSegment(id, 'keep me');
    state.restart();
    const before = state.controller.getSnapshot();
    state.timers.advance(8_000);
    const after = state.controller.getSnapshot();
    expect(after.noSpeech).not.toBeNull();
    expect({ transcript: after.transcript, segments: after.segments, partial: after.partial })
      .toEqual({ transcript: before.transcript, segments: before.segments, partial: before.partial });
  });

  it('ignores audio levels from a stale request', () => {
    const state = setup();
    const first = startListening(state);
    state.controller.onRecognizedSegment(first, 'one');
    state.restart();
    expect(state.controller.onAudioLevel(first, true)).toBe(false);
    state.timers.advance(8_000);
    expect(state.controller.getSnapshot().noSpeech?.audio).toBe('unknown');
  });

  it('defaults to an 8 second window on the platform timer', () => {
    vi.useFakeTimers();
    expect(DEFAULT_NO_TEXT_WARNING_MS).toBe(8_000);
    const controller = new DictationController({
      startRecognition: () => undefined,
      stopRecognition: () => undefined,
      cancelRecognition: () => undefined,
      schedule: () => 0,
      cancelScheduled: () => undefined,
    });
    controller.setTarget('terminal:a');
    controller.start();
    vi.advanceTimersByTime(7_999);
    expect(controller.getSnapshot().noSpeech).toBeNull();
    vi.advanceTimersByTime(1);
    expect(controller.getSnapshot().noSpeech?.reason).toBe('no-text-timeout');
    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DictationController,
  type DictationControllerOptions,
} from '../src/dictationController';

/**
 * Issue #3060: nothing the user dictated may disappear unless they explicitly
 * cancel it. Backgrounding, a target change, recognizer errors, early
 * endpoints and a final shorter than the last partial all keep the words.
 */
function setup(overrides: Partial<DictationControllerOptions> = {}) {
  const scheduled: Array<() => void> = [];
  const starts: string[] = [];
  const stops: string[] = [];
  const cancels: string[] = [];
  let nextId = 0;
  const controller = new DictationController({
    startRecognition: (requestId) => { starts.push(requestId); },
    stopRecognition: (requestId) => { stops.push(requestId); },
    cancelRecognition: (requestId) => { cancels.push(requestId); },
    schedule: (callback) => { scheduled.push(callback); return scheduled.length; },
    cancelScheduled: () => undefined,
    createRequestId: () => `turn-${++nextId}`,
    ...overrides,
  });
  controller.setTarget('composer:session-a');
  const runRestart = () => {
    const callback = scheduled.shift();
    if (!callback) throw new Error('No restart is scheduled.');
    callback();
    return controller.getSnapshot().requestId!;
  };
  return { controller, starts, stops, cancels, runRestart };
}

function begin(state: ReturnType<typeof setup>): string {
  const id = state.controller.start();
  if (id === null) throw new Error('Expected dictation to start.');
  return id;
}

describe('dictation keeps dictated text (#3060)', () => {
  it('backgrounding mid-dictation commits finals and the latest partial instead of cancelling', () => {
    const state = setup();
    const first = begin(state);
    state.controller.onRecognizedSegment(first, 'first sentence');
    const second = state.runRestart();
    state.controller.onPartial(second, 'and the unfinished words');

    state.controller.setForeground(false);

    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'completed',
      requestId: null,
      partial: '',
      segments: ['first sentence', 'and the unfinished words'],
      transcript: 'first sentence and the unfinished words',
      cancelReason: null,
      interruptReason: 'background',
      targetId: 'composer:session-a',
    });
    // The microphone is released immediately; a late callback cannot change the kept text.
    expect(state.cancels).toEqual([second]);
    expect(state.controller.onRecognizedSegment(second, 'late')).toBe(false);
    expect(state.controller.getSnapshot().transcript).toBe('first sentence and the unfinished words');
  });

  it('a target change keeps the text tagged with the original target', () => {
    const state = setup();
    const requestId = begin(state);
    state.controller.onPartial(requestId, 'words for session a');

    state.controller.setTarget('composer:session-b');

    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'completed',
      targetId: 'composer:session-a',
      transcript: 'words for session a',
      interruptReason: 'target-change',
    });
    expect(state.cancels).toEqual([requestId]);
  });

  it('interrupt() is the graceful close path and keeps the partial', () => {
    const state = setup();
    const requestId = begin(state);
    state.controller.onPartial(requestId, 'closing the sheet');

    state.controller.interrupt('closed');

    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'completed', transcript: 'closing the sheet', interruptReason: 'closed',
    });
    expect(state.cancels).toEqual([requestId]);
  });

  it('only an explicit user cancel drops the dictated text', () => {
    const state = setup();
    const requestId = begin(state);
    state.controller.onPartial(requestId, 'throw this away');

    state.controller.cancel();

    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'cancelled', partial: '', transcript: '', cancelReason: 'user', interruptReason: null,
    });
  });

  it('a final result shorter than the last partial keeps the partial ("so let\'s solve it")', () => {
    const state = setup();
    const requestId = begin(state);
    state.controller.onPartial(requestId, "so let's solve it");
    state.controller.stop();

    state.controller.onRecognizedSegment(requestId, "so let's");

    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'completed', transcript: "so let's solve it", segments: ["so let's solve it"],
    });
  });

  it('a stop with no final result promotes the last partial', () => {
    const state = setup();
    const requestId = begin(state);
    state.controller.onPartial(requestId, "so let's solve it");
    state.controller.stop();

    state.controller.onRecoverableEnd(requestId, 'no-match');

    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'completed', partial: '', transcript: "so let's solve it",
    });
  });

  it('a stop timeout or recognizer error promotes the last partial', () => {
    const state = setup();
    const requestId = begin(state);
    state.controller.onRecognizedSegment(requestId, 'kept final');
    const second = state.runRestart();
    state.controller.onPartial(second, "so let's solve it");
    state.controller.stop();

    state.controller.onError(second, { code: 'recognizer-stop-timeout', message: 'Stop timed out.' });

    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'error', partial: '', transcript: "kept final so let's solve it",
      error: { code: 'recognizer-stop-timeout' },
    });
  });

  it('a failing stop effect promotes the last partial', async () => {
    const state = setup({ stopRecognition: () => Promise.reject(new Error('stop failed')) });
    const requestId = begin(state);
    state.controller.onPartial(requestId, 'still here');
    state.controller.stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(state.controller.getSnapshot()).toMatchObject({ phase: 'error', transcript: 'still here' });
  });

  it.each(['no-match', 'speech-timeout', 'recognizer-busy'] as const)(
    'an early %s endpoint while listening promotes the partial and keeps listening',
    (reason) => {
      const state = setup();
      const requestId = begin(state);
      state.controller.onPartial(requestId, 'words before the pause');

      state.controller.onRecoverableEnd(requestId, reason);

      expect(state.controller.getSnapshot()).toMatchObject({
        phase: 'listening', partial: '', transcript: 'words before the pause',
      });
      const next = state.runRestart();
      expect(next).not.toBe(requestId);
      state.controller.onRecognizedSegment(next, 'after the pause');
      expect(state.controller.getSnapshot().transcript).toBe('words before the pause after the pause');
    },
  );

  it('a final at least as long as the partial wins (the recognizer may revise words)', () => {
    const state = setup();
    const requestId = begin(state);
    state.controller.onPartial(requestId, 'two cats');
    state.controller.stop();
    state.controller.onRecognizedSegment(requestId, 'Two cats.');

    expect(state.controller.getSnapshot().transcript).toBe('Two cats.');
  });
});

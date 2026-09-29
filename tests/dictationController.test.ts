import { describe, expect, it } from 'vitest';
import {
  DictationController,
  type DictationControllerOptions,
} from '../src/dictationController';

class FakeScheduler {
  private nextHandle = 0;
  readonly callbacks = new Map<number, () => void>();
  readonly cancelled: number[] = [];

  schedule = (callback: () => void): number => {
    const handle = ++this.nextHandle;
    this.callbacks.set(handle, callback);
    return handle;
  };

  cancel = (handle: unknown): void => {
    if (typeof handle !== 'number') throw new Error('Unexpected timer handle.');
    this.cancelled.push(handle);
  };

  run(handle: number): void {
    this.callbacks.get(handle)?.();
  }

  latestHandle(): number {
    const handles = [...this.callbacks.keys()];
    const handle = handles.at(-1);
    if (handle === undefined) throw new Error('No restart is scheduled.');
    return handle;
  }
}

function setup(overrides: Partial<DictationControllerOptions> = {}) {
  const scheduler = new FakeScheduler();
  const starts: string[] = [];
  const stops: string[] = [];
  const cancels: string[] = [];
  let nextId = 0;
  const controller = new DictationController({
    startRecognition: (requestId) => { starts.push(requestId); },
    stopRecognition: (requestId) => { stops.push(requestId); },
    cancelRecognition: (requestId) => { cancels.push(requestId); },
    schedule: scheduler.schedule,
    cancelScheduled: scheduler.cancel,
    createRequestId: () => `turn-${++nextId}`,
    ...overrides,
  });
  controller.setTarget('composer:session-a');
  return { controller, scheduler, starts, stops, cancels };
}

function start(set: ReturnType<typeof setup>): string {
  const id = set.controller.start();
  if (id === null) throw new Error('Expected dictation to start.');
  return id;
}

describe('DictationController', () => {
  it('keeps partials preview-only and accumulates each recognized segment once', () => {
    const state = setup();
    const first = start(state);

    expect(state.controller.getSnapshot()).toMatchObject({ phase: 'listening', requestId: first, partial: '', transcript: '' });
    expect(state.controller.onPartial(first, 'good morning')).toBe(true);
    expect(state.controller.getSnapshot()).toMatchObject({ partial: 'good morning', segments: [], transcript: '' });

    expect(state.controller.onRecognizedSegment(first, '  good morning  ')).toBe(true);
    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'listening', requestId: null, partial: '', segments: ['good morning'], transcript: 'good morning',
    });
    expect(state.scheduler.callbacks.size).toBe(1);

    expect(state.controller.onRecognizedSegment(first, 'good morning')).toBe(false);
    expect(state.controller.onPartial(first, 'late partial')).toBe(false);
    state.scheduler.run(state.scheduler.latestHandle());
    const second = state.controller.getSnapshot().requestId;
    expect(second).not.toBe(first);
    expect(state.starts).toEqual([first, second]);

    expect(state.controller.onRecognizedSegment(second!, 'everyone')).toBe(true);
    state.controller.stop();
    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'completed', segments: ['good morning', 'everyone'], transcript: 'good morning everyone',
    });
    expect(state.starts).toHaveLength(2);
  });

  it('isolates each subscriber snapshot from mutation by another listener', () => {
    const state = setup();
    const secondListenerTranscripts: string[] = [];
    state.controller.subscribe((snapshot) => {
      if (snapshot.transcript === 'one') {
        (snapshot as { transcript: string }).transcript = 'corrupted';
        (snapshot.segments as string[]).push('corrupted');
      }
    });
    state.controller.subscribe((snapshot) => {
      if (snapshot.transcript === 'one' || snapshot.transcript === 'corrupted') {
        secondListenerTranscripts.push(snapshot.transcript);
        expect(snapshot.segments).toEqual(['one']);
      }
    });

    const requestId = start(state);
    state.controller.onRecognizedSegment(requestId, 'one');

    expect(secondListenerTranscripts).toEqual(['one']);
    expect(state.controller.getSnapshot()).toMatchObject({ transcript: 'one', segments: ['one'] });
  });

  it.each(['no-match', 'speech-timeout', 'recognizer-busy'] as const)(
    'resumes after recoverable %s while listening and preserves recognized text',
    (reason) => {
      const state = setup();
      const first = start(state);
      state.controller.onRecognizedSegment(first, 'first phrase');
      state.scheduler.run(state.scheduler.latestHandle());
      const second = state.controller.getSnapshot().requestId!;
      state.controller.onPartial(second, 'unconfirmed preview');

      expect(state.controller.onRecoverableEnd(second, reason)).toBe(true);
      expect(state.controller.getSnapshot()).toMatchObject({
        phase: 'listening', requestId: null, partial: '', transcript: 'first phrase',
      });
      state.scheduler.run(state.scheduler.latestHandle());
      const third = state.controller.getSnapshot().requestId!;

      state.controller.stop();
      expect(state.stops).toEqual([third]);
      state.controller.onRecognizedSegment(third, 'second phrase');
      expect(state.controller.getSnapshot()).toMatchObject({
        phase: 'completed', segments: ['first phrase', 'second phrase'], transcript: 'first phrase second phrase',
      });
      expect(state.starts).toHaveLength(3);
    },
  );

  it.each(['no-match', 'speech-timeout', 'recognizer-busy'] as const)(
    'completes after Stop when the recognizer ends with recoverable %s',
    (reason) => {
      const state = setup();
      const requestId = start(state);
      state.controller.onPartial(requestId, 'unconfirmed preview');

      state.controller.stop();
      expect(state.stops).toEqual([requestId]);

      expect(state.controller.onRecoverableEnd(requestId, reason)).toBe(true);
      expect(state.controller.getSnapshot()).toMatchObject({
        phase: 'completed', requestId: null, partial: '', transcript: '',
      });
      expect(state.scheduler.callbacks.size).toBe(0);
      expect(state.starts).toEqual([requestId]);
    },
  );

  it('waits for the active turn after Stop and does not rearm after its result', () => {
    const state = setup();
    const requestId = start(state);
    state.controller.onPartial(requestId, 'preview until final');

    state.controller.stop();
    expect(state.controller.getSnapshot()).toMatchObject({ phase: 'stopping', requestId, partial: 'preview until final' });
    expect(state.stops).toEqual([requestId]);
    expect(state.starts).toHaveLength(1);

    state.controller.onPartial(requestId, 'more preview');
    expect(state.controller.getSnapshot().transcript).toBe('');
    state.controller.onRecognizedSegment(requestId, 'final words');
    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'completed', requestId: null, partial: '', segments: ['final words'], transcript: 'final words',
    });
    expect(state.controller.onRecognizedSegment(requestId, 'duplicate')).toBe(false);
    expect(state.starts).toHaveLength(1);
  });

  it('cancels a queued restart when Stop races the endpointing callback', () => {
    const state = setup();
    const first = start(state);
    state.controller.onRecognizedSegment(first, 'kept');
    const restartHandle = state.scheduler.latestHandle();

    state.controller.stop();
    expect(state.scheduler.cancelled).toContain(restartHandle);
    expect(state.controller.getSnapshot()).toMatchObject({ phase: 'completed', transcript: 'kept' });
    state.scheduler.run(restartHandle);
    expect(state.starts).toEqual([first]);
  });

  it('waits for asynchronous start before issuing Stop', async () => {
    let resolveStart!: () => void;
    const startPromise = new Promise<void>((resolve) => { resolveStart = resolve; });
    const state = setup({ startRecognition: (requestId) => { state.starts.push(requestId); return startPromise; } });
    const requestId = start(state);

    state.controller.stop();
    expect(state.controller.getSnapshot().phase).toBe('stopping');
    expect(state.stops).toEqual([]);
    resolveStart();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.stops).toEqual([requestId]);

    state.controller.onRecognizedSegment(requestId, 'after stop');
    expect(state.controller.getSnapshot()).toMatchObject({ phase: 'completed', transcript: 'after stop' });
  });

  it('cancels immediately on background and ignores callbacks from the abandoned request', () => {
    const state = setup();
    const requestId = start(state);
    state.controller.onPartial(requestId, 'preview');

    state.controller.setForeground(false);
    expect(state.cancels).toEqual([requestId]);
    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'cancelled', requestId: null, partial: '', cancelReason: 'background',
    });
    expect(state.controller.onRecognizedSegment(requestId, 'must not land')).toBe(false);
    expect(state.controller.start()).toBeNull();
    expect(state.controller.getSnapshot().transcript).toBe('');

    state.controller.setForeground(true);
    expect(start(state)).not.toBe(requestId);
  });

  it('cancels on target change, retains the old target identity, and starts clean for the new target', () => {
    const state = setup();
    const requestId = start(state);
    state.controller.onPartial(requestId, 'preview');

    state.controller.setTarget('composer:session-b');
    expect(state.cancels).toEqual([requestId]);
    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'cancelled', targetId: 'composer:session-a', partial: '', cancelReason: 'target-change',
    });
    expect(state.controller.onRecognizedSegment(requestId, 'stale')).toBe(false);

    const next = start(state);
    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'listening', targetId: 'composer:session-b', requestId: next, transcript: '', segments: [],
    });
  });

  it('ignores stale and duplicate outcomes after a newer request has started', () => {
    const state = setup();
    const first = start(state);
    state.controller.onRecognizedSegment(first, 'one');
    state.scheduler.run(state.scheduler.latestHandle());
    const second = state.controller.getSnapshot().requestId!;

    expect(state.controller.onRecoverableEnd(first, 'speech-timeout')).toBe(false);
    expect(state.controller.onError(first, { code: 'late', message: 'late error' })).toBe(false);
    expect(state.controller.onRecognizedSegment(second, 'two')).toBe(true);
    expect(state.controller.onError(second, { code: 'duplicate', message: 'duplicate error' })).toBe(false);
    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'listening', transcript: 'one two', segments: ['one', 'two'], error: null,
    });
  });

  it('ends on fatal errors without rearming and preserves earlier final segments', () => {
    const state = setup();
    const first = start(state);
    state.controller.onRecognizedSegment(first, 'saved phrase');
    state.scheduler.run(state.scheduler.latestHandle());
    const second = state.controller.getSnapshot().requestId!;

    expect(state.controller.onError(second, { code: 'permission-denied', message: 'Permission denied.' })).toBe(true);
    expect(state.controller.getSnapshot()).toMatchObject({
      phase: 'error', requestId: null, transcript: 'saved phrase',
      error: { code: 'permission-denied', message: 'Permission denied.' },
    });
    expect(state.starts).toHaveLength(2);
    expect(state.controller.onRecognizedSegment(second, 'late')).toBe(false);
  });

  it('reports start and stop effect failures as terminal errors', async () => {
    const startFailed = setup({ startRecognition: () => { throw new Error('service unavailable'); } });
    start(startFailed);
    expect(startFailed.controller.getSnapshot()).toMatchObject({
      phase: 'error', error: { code: 'start-failed', message: 'service unavailable' },
    });

    const stopFailed = setup({ stopRecognition: () => Promise.reject(new Error('stop failed')) });
    const requestId = start(stopFailed);
    stopFailed.controller.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(stopFailed.controller.getSnapshot()).toMatchObject({
      phase: 'error', error: { code: 'stop-failed', message: 'stop failed' },
    });
    expect(stopFailed.cancels).toEqual([requestId]);
    expect(stopFailed.controller.onRecognizedSegment(requestId, 'too late')).toBe(false);
  });

  it('rejects starts without a target and starts while already active', () => {
    const scheduler = new FakeScheduler();
    const controller = new DictationController({
      startRecognition: () => undefined,
      stopRecognition: () => undefined,
      cancelRecognition: () => undefined,
      schedule: scheduler.schedule,
      cancelScheduled: scheduler.cancel,
    });
    expect(controller.start()).toBeNull();
    controller.setTarget('terminal:session-a');
    expect(controller.start()).not.toBeNull();
    expect(controller.start()).toBeNull();
  });
});

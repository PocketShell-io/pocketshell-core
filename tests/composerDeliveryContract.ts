import vectors from './fixtures/composer-delivery-vectors.json';

/** Shared, runtime-neutral composer policy contract for Vitest and browser/embed engines. */
export async function runComposerDeliveryContract(Core: any): Promise<string> {
  let assertions = 0;
  const check = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message);
    assertions += 1;
  };
  const equal = (actual: unknown, expected: unknown, message: string): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${message}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    }
    assertions += 1;
  };
  const hex = (bytes: Uint8Array): string =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };

  for (const vector of vectors.vectors) {
    const writes: string[] = [];
    const contexts: Array<{ operationId: string; writeIndex: number }> = [];
    const sleeps: number[] = [];
    const controller = new Core.ComposerDeliveryController({
      write: async (bytes: Uint8Array, context: { operationId: string; writeIndex: number }) => {
        writes.push(hex(bytes));
        contexts.push(context);
      },
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    controller.setTransportState('connected');
    const result = await controller.deliver({
      operationId: `vector-${vector.name}`,
      payload: vector.payload,
      intent: vector.intent,
    });
    equal(result.status, 'delivered', `${vector.name} status`);
    equal(result.draftEffect, vector.expectedDraftEffect, `${vector.name} draft effect`);
    equal(writes, vector.expectedHex, `${vector.name} exact bytes`);
    equal(sleeps, vector.expectedSleepMs, `${vector.name} ordered pacing`);
    equal(contexts.map((context) => context.writeIndex), writes.map((_value, index) => index + 1), `${vector.name} write sequence`);
    equal(result.writeCount, vector.expectedHex.length, `${vector.name} acknowledged write count`);
  }

  const idleEffects = { write: async () => { throw new Error('unexpected write'); }, sleep: async () => {} };
  const idleController = new Core.ComposerDeliveryController(idleEffects);
  const invalidId = await idleController.deliver({ operationId: '', payload: 'keep me', intent: 'submit' });
  equal([invalidId.status, invalidId.reason, invalidId.draftEffect], ['not-sent', 'invalid-operation-id', 'retain'], 'empty id refuses without losing draft');
  const emptyPayload = await idleController.deliver({ operationId: 'empty', payload: '', intent: 'submit' });
  equal([emptyPayload.status, emptyPayload.reason, emptyPayload.draftEffect], ['not-sent', 'empty-payload', 'retain'], 'empty payload is a retained no-op');
  const disconnected = await idleController.deliver({ operationId: 'offline', payload: 'keep me', intent: 'submit' });
  equal([disconnected.status, disconnected.reason, disconnected.draftEffect], ['not-sent', 'disconnected', 'retain'], 'disconnected send does not write or clear draft');

  let failedWriteCalls = 0;
  const failedController = new Core.ComposerDeliveryController({
    write: async () => { failedWriteCalls += 1; throw new Error('bridge reset after write began'); },
    sleep: async () => {},
  });
  failedController.setTransportState('connected');
  const failed = await failedController.deliver({ operationId: 'ambiguous-first-write', payload: 'original prompt', intent: 'submit' });
  equal([failed.status, failed.reason, failed.draftEffect], ['uncertain', 'effect-failed', 'retain'], 'rejected first write is ambiguous and retains draft');
  failedController.setTransportState('lost');
  failedController.setTransportState('connected');
  equal(failedWriteCalls, 1, 'reconnect does not replay an uncertain write');

  const firstWrite = deferred<void>();
  const interruptedWrites: string[] = [];
  const interrupted = new Core.ComposerDeliveryController({
    write: async (bytes: Uint8Array) => {
      interruptedWrites.push(hex(bytes));
      if (interruptedWrites.length === 1) await firstWrite.promise;
    },
    sleep: async () => {},
  });
  interrupted.setTransportState('connected');
  const inFlight = interrupted.deliver({ operationId: 'loss-mid-paste', payload: 'line one\nline two', intent: 'submit' });
  const queued = interrupted.deliver({ operationId: 'queued-before-loss', payload: 'later prompt', intent: 'insert' });
  await Promise.resolve();
  equal(interruptedWrites, ['1b5b3230307e'], 'first frame starts before queued operation');
  interrupted.setTransportState('lost');
  interrupted.setTransportState('connected');
  firstWrite.resolve();
  const [interruptedResult, queuedResult] = await Promise.all([inFlight, queued]);
  equal([interruptedResult.status, interruptedResult.reason, interruptedResult.draftEffect], ['uncertain', 'transport-lost', 'retain'], 'loss during write retains ambiguous draft');
  equal([queuedResult.status, queuedResult.reason, queuedResult.draftEffect], ['not-sent', 'transport-changed', 'retain'], 'queued old-generation input is not sent after reconnect');
  equal(interruptedWrites, ['1b5b3230307e'], 'partial framed input stops at generation loss');

  const firstOrderedWrite = deferred<void>();
  const orderedWrites: Array<{ operationId: string; hex: string }> = [];
  const ordered = new Core.ComposerDeliveryController({
    write: async (bytes: Uint8Array, context: { operationId: string }) => {
      orderedWrites.push({ operationId: context.operationId, hex: hex(bytes) });
      if (orderedWrites.length === 1) await firstOrderedWrite.promise;
    },
    sleep: async () => {},
  });
  ordered.setTransportState('connected');
  const insert = ordered.deliver({ operationId: 'ordered-insert', payload: 'first', intent: 'insert' });
  const submit = ordered.deliver({ operationId: 'ordered-submit', payload: 'second', intent: 'submit' });
  await Promise.resolve();
  equal(orderedWrites.map((entry) => entry.operationId), ['ordered-insert'], 'later intent waits behind in-flight intent');
  firstOrderedWrite.resolve();
  const [insertResult, submitResult] = await Promise.all([insert, submit]);
  equal([insertResult.status, submitResult.status], ['delivered', 'delivered'], 'ordered insert and submit complete');
  equal(orderedWrites, [
    { operationId: 'ordered-insert', hex: '6669727374' },
    { operationId: 'ordered-submit', hex: '7365636f6e64' },
    { operationId: 'ordered-submit', hex: '0d' },
  ], 'insert bytes precede submit body and separate CR');

  let idempotentWrites = 0;
  const idempotent = new Core.ComposerDeliveryController({
    write: async () => { idempotentWrites += 1; },
    sleep: async () => {},
  });
  idempotent.setTransportState('connected');
  const sameRequest = { operationId: 'one-click', payload: 'send once', intent: 'insert' };
  const original = await idempotent.deliver(sameRequest);
  const duplicate = await idempotent.deliver(sameRequest);
  equal(original.status, 'delivered', 'first operation id is delivered');
  equal([duplicate.status, duplicate.reason, duplicate.draftEffect], ['not-sent', 'operation-id-reused', 'retain'], 'repeated operation id is refused and retains draft');
  equal(idempotentWrites, 1, 'repeated operation id writes exactly once');
  const reused = await idempotent.deliver({ ...sameRequest, payload: 'different bytes' });
  equal([reused.status, reused.reason, reused.draftEffect], ['not-sent', 'operation-id-reused', 'retain'], 'reused id with different bytes is refused');

  let submitFailureWrites = 0;
  const submitFailure = new Core.ComposerDeliveryController({
    write: async () => {
      submitFailureWrites += 1;
      if (submitFailureWrites === 2) throw new Error('submit acknowledgement lost');
    },
    sleep: async () => {},
  });
  submitFailure.setTransportState('connected');
  const uncertainSubmit = await submitFailure.deliver({ operationId: 'submit-cr-unknown', payload: 'run task', intent: 'submit' });
  equal([uncertainSubmit.status, uncertainSubmit.stage, uncertainSubmit.draftEffect], ['uncertain', 'write', 'retain'], 'uncertain submit key retains draft');
  equal(submitFailureWrites, 2, 'submit failure does not add later writes');

  check(typeof Core.encodeComposerText === 'function', 'UTF-8 encoder is exported');
  return `assertions=${assertions}`;
}

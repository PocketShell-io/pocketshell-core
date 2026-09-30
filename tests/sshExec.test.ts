import { describe, expect, it, vi } from 'vitest';
import type { SshCapability, SshExecOptions, SshExecResult } from '../src/sshCapability.js';
import {
  createRequestIdFactory,
  describeError,
  execChecked,
  execStderrSummary,
  isSshResponseFor,
  SshResponseMismatchError,
} from '../src/sshExec.js';

const connection = { connectionId: 'conn-1', generationId: 'gen-1' };

function capabilityAnswering(
  overrides: Partial<SshExecResult> = {},
): { capability: Pick<SshCapability, 'exec'>; exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn(async (options: SshExecOptions): Promise<SshExecResult> => ({
    requestId: options.requestId,
    connectionId: options.connectionId,
    generationId: options.generationId,
    exitCode: 0,
    stdout: 'out',
    stderr: '',
    timedOut: false,
    ...overrides,
  }));
  return { capability: { exec } as unknown as Pick<SshCapability, 'exec'>, exec };
}

describe('execChecked — the one request/connection/generation echo check', () => {
  it('runs the command on the given generation and returns the echoed result', async () => {
    const { capability, exec } = capabilityAnswering();
    const result = await execChecked(capability, connection, { requestId: 'r-1', command: 'true', timeoutMs: 5 });
    expect(exec).toHaveBeenCalledWith({ ...connection, requestId: 'r-1', command: 'true', timeoutMs: 5 });
    expect(result.stdout).toBe('out');
  });

  it('leaves exit status and timeout to the caller', async () => {
    const { capability } = capabilityAnswering({ exitCode: 3, timedOut: true, stderr: 'boom' });
    const result = await execChecked(capability, connection, { requestId: 'r-2', command: 'false', timeoutMs: 5 });
    expect(result).toMatchObject({ exitCode: 3, timedOut: true });
  });

  for (const mismatch of [
    { requestId: 'other-request' },
    { connectionId: 'other-connection' },
    { generationId: 'stale-generation' },
  ]) {
    it(`rejects a response with a different ${Object.keys(mismatch)[0]}`, async () => {
      const { capability } = capabilityAnswering(mismatch);
      await expect(execChecked(capability, connection, { requestId: 'r-3', command: 'x', timeoutMs: 5 }))
        .rejects.toBeInstanceOf(SshResponseMismatchError);
    });
  }

  it('propagates capability errors unchanged', async () => {
    const failure = new Error('SSH connection closed');
    const capability = { exec: vi.fn(async () => { throw failure; }) } as unknown as Pick<SshCapability, 'exec'>;
    await expect(execChecked(capability, connection, { requestId: 'r-4', command: 'x', timeoutMs: 5 }))
      .rejects.toBe(failure);
  });

  it('matches only the exact request echo', () => {
    const echo = { requestId: 'r', ...connection };
    expect(isSshResponseFor(echo, 'r', connection)).toBe(true);
    expect(isSshResponseFor(echo, 'r', { ...connection, generationId: 'gen-2' })).toBe(false);
    expect(isSshResponseFor(echo, 'q', connection)).toBe(false);
  });
});

describe('exec helpers', () => {
  it('summarizes the first non-empty stderr line, bounded', () => {
    expect(execStderrSummary({ stderr: '\n\n  first line\nsecond\n' })).toBe('first line');
    expect(execStderrSummary({ stderr: '   ' })).toBeUndefined();
    expect(execStderrSummary({ stderr: 'x'.repeat(500) })).toHaveLength(200);
  });

  it('issues unique prefixed request ids', () => {
    const next = createRequestIdFactory('probe');
    const ids = new Set(Array.from({ length: 50 }, () => next()));
    expect(ids.size).toBe(50);
    expect([...ids].every((id) => id.startsWith('probe-'))).toBe(true);
  });

  it('describes thrown values', () => {
    expect(describeError(new Error('bad'))).toBe('bad');
    expect(describeError('plain')).toBe('plain');
  });
});

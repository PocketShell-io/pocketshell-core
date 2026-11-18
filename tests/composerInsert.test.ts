import { describe, expect, it } from 'vitest';
import { BP_END, BP_START, deliverPayload, SUBMIT_KEY } from '../src/composerSend';

// PocketShell #3128: the phone composer's Insert writes the prompt at the
// pane's prompt without submitting it; Send is the same writes plus Enter.
describe('deliverPayload submit option', () => {
  const sleep = async (): Promise<void> => undefined;

  it('submit:false writes the body and never the submit key', async () => {
    const writes: string[] = [];
    const ok = await deliverPayload('git status', {
      write: async (d) => (writes.push(d), true),
      submit: false,
      submitDelayMs: 250,
      sleep,
    });
    expect(ok).toBe(true);
    expect(writes).toEqual(['git status']);
  });

  it('submit:false keeps the bracketed frame for a multi-line body', async () => {
    const writes: string[] = [];
    await deliverPayload('a\nb', { write: async (d) => (writes.push(d), true), submit: false, sleep });
    expect(writes).toEqual([BP_START, 'a\nb', BP_END]);
  });

  it('the default is Send: body then the submit key', async () => {
    const writes: string[] = [];
    await deliverPayload('git status', { write: async (d) => (writes.push(d), true), sleep });
    expect(writes).toEqual(['git status', SUBMIT_KEY]);
  });

  it('submit:false reports a failed body write', async () => {
    const ok = await deliverPayload('x', { write: async () => false, submit: false, sleep });
    expect(ok).toBe(false);
  });
});

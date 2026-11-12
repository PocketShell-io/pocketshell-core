import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extensionsFor,
  provideExtensions,
  type TerminalInputAdapter,
} from '../src/app/extensions';
import { createTerminalInputOwnership } from '../src/app/terminalInputOwnership';

const adapter = (id: string, order?: number): TerminalInputAdapter => ({ id, order, attach: () => undefined });

afterEach(() => provideExtensions({}));

describe('terminal.inputAdapter slot', () => {
  it('is empty until a platform contributes, so desktop and web keep xterm input untouched', () => {
    expect(extensionsFor('terminal.inputAdapter')).toEqual([]);
  });

  it('returns contributions in order, ordered entries first', () => {
    provideExtensions({ 'terminal.inputAdapter': [adapter('b'), adapter('a', 1), adapter('c')] });
    expect(extensionsFor('terminal.inputAdapter').map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('replaces earlier contributions wholesale', () => {
    provideExtensions({ 'terminal.inputAdapter': [adapter('a')] });
    provideExtensions({});
    expect(extensionsFor('terminal.inputAdapter')).toEqual([]);
  });

  it('rejects duplicate ids, missing ids and unknown slots', () => {
    expect(() => provideExtensions({ 'terminal.inputAdapter': [adapter('a'), adapter('a')] })).toThrow(/duplicate/);
    expect(() => provideExtensions({ 'terminal.inputAdapter': [adapter('')] })).toThrow(/no id/);
    expect(() => provideExtensions({ 'terminal.typo': [] } as never)).toThrow(/unknown extension slot/);
  });

  it('routes adapter bytes through xterm user input after cancelling prefix intent, with a live identity and owned cleanup', () => {
    const detach = vi.fn();
    const attach = vi.fn<import('../src/app/extensions').TerminalInputAdapter['attach']>(() => detach);
    provideExtensions({ 'terminal.inputAdapter': [{ id: 'ime', attach }] });
    let key = 'first';
    const cancel = vi.fn();
    const input = vi.fn(() => { expect(cancel).toHaveBeenCalledOnce(); });
    const textarea = {} as HTMLTextAreaElement;
    const element = {} as HTMLElement;
    const ownership = createTerminalInputOwnership({ getPrefixOwner: () => null,
      getContainer: () => null, getSessionKey: () => key, routeKey: () => true,
      cancelDetachCandidate: cancel, expectIntentionalDetach: vi.fn() });
    ownership.attachInputAdapters({ textarea, input }, element);
    expect(attach).toHaveBeenCalledOnce();
    const target = attach.mock.calls[0]![0];
    expect(target.textarea).toBe(textarea);
    expect(target.element).toBe(element);
    expect(target.sessionKey).toBe('first');
    key = 'second';
    expect(target.sessionKey).toBe('second');
    target.sendInput('Unicode ☃\r');
    expect(input).toHaveBeenCalledTimes(1);
    expect(input).toHaveBeenCalledWith('Unicode ☃\r', true);
    expect(detach).not.toHaveBeenCalled();
    ownership.disposeInputAdapters();
    ownership.disposeInputAdapters();
    expect(detach).toHaveBeenCalledOnce();
  });

  it('does not attach contributed adapters before xterm creates its textarea', () => {
    const attach = vi.fn();
    provideExtensions({ 'terminal.inputAdapter': [{ id: 'ime', attach }] });
    const ownership = createTerminalInputOwnership({ getPrefixOwner: () => null,
      getContainer: () => null, getSessionKey: () => 'key', routeKey: () => true,
      cancelDetachCandidate: vi.fn(), expectIntentionalDetach: vi.fn() });
    ownership.attachInputAdapters({ textarea: undefined, input: vi.fn() }, {} as HTMLElement);
    expect(attach).not.toHaveBeenCalled();
  });
});

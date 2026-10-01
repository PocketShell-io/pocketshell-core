import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  extensionsFor,
  provideExtensions,
  type TerminalInputAdapter,
} from '../src/app/extensions';

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

  it('is attached by TerminalView on its xterm textarea, sending through term.input, and detached on unmount', () => {
    const view = readFileSync(resolve(__dirname, '../src/app/components/TerminalView.vue'), 'utf8');
    expect(view).toMatch(/extensionsFor\('terminal\.inputAdapter'\)/);
    expect(view).toMatch(/sendInput: \(data\) => t\.input\(data, true\)/);
    expect(view).toMatch(/get sessionKey\(\) \{\s*return registryKey\.value;/);
    expect(view).toMatch(/attachInputAdapters\(term, containerEl\.value!\)/);
    expect(view).toMatch(/for \(const detach of inputAdapterDetaches\) detach\(\);/);
  });
});

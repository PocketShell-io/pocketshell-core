// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INSET_VARIABLES, writeAppInsets } from '@ui/app/insets';

const TOKENS = readFileSync(resolve(__dirname, '../src/tokens.css'), 'utf8');

describe('inset contract', () => {
  it('names the five variables', () => {
    expect(INSET_VARIABLES).toEqual({
      top: '--ps-inset-top',
      bottom: '--ps-inset-bottom',
      left: '--ps-inset-left',
      right: '--ps-inset-right',
      keyboard: '--ps-inset-keyboard',
    });
  });

  it('defaults every inset to 0px in the shared tokens, which is what desktop and web run with', () => {
    for (const name of Object.values(INSET_VARIABLES)) {
      expect(TOKENS).toMatch(new RegExp(`${name}:\\s*0px;`));
    }
  });

  it('writes pixel counts, CSS expressions, and removes an override on null', () => {
    const el = document.createElement('div');
    writeAppInsets({ top: 24, bottom: 'env(safe-area-inset-bottom, 0px)', keyboard: 0 }, el);
    expect(el.style.getPropertyValue('--ps-inset-top')).toBe('24px');
    expect(el.style.getPropertyValue('--ps-inset-bottom')).toBe('env(safe-area-inset-bottom, 0px)');
    expect(el.style.getPropertyValue('--ps-inset-keyboard')).toBe('0px');

    writeAppInsets({ keyboard: 300 }, el);
    expect(el.style.getPropertyValue('--ps-inset-keyboard')).toBe('300px');
    expect(el.style.getPropertyValue('--ps-inset-top')).toBe('24px'); // untouched

    writeAppInsets({ left: 'env(safe-area-inset-left, 0px)', right: 48 }, el);
    expect(el.style.getPropertyValue('--ps-inset-left')).toBe('env(safe-area-inset-left, 0px)');
    expect(el.style.getPropertyValue('--ps-inset-right')).toBe('48px');

    writeAppInsets({ top: null }, el);
    expect(el.style.getPropertyValue('--ps-inset-top')).toBe('');
  });

  it('writes onto <html> by default', () => {
    writeAppInsets({ top: 12 });
    expect(document.documentElement.style.getPropertyValue('--ps-inset-top')).toBe('12px');
    writeAppInsets({ top: null });
  });

  it('refuses a negative or non-finite pixel count and an unknown edge', () => {
    const el = document.createElement('div');
    expect(() => writeAppInsets({ top: -1 }, el)).toThrow(/non-negative/);
    expect(() => writeAppInsets({ bottom: Number.NaN }, el)).toThrow(/finite/);
    expect(() => writeAppInsets({ start: 4 } as never, el)).toThrow(/unknown inset edge: start/);
  });
});

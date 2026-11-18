// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DiagBanner from '../src/app/components/DiagBanner.vue';
import { diagErrors, recordDiagDetail, recordDiagError } from '../src/app/diag';
import { diagDetailsText, plainDiagSummary } from '../src/app/diagPresentation';
import { COMPACT_QUERY } from '../src/app/layoutClass';

/**
 * pocketshell#3161: on a Pixel 7a the strip showed `[error] i is not defined`
 * and `[terminal-stall] terminal output parsing stalled (…)` in red, under the
 * status bar. The compact layout says what happened in plain words, offers
 * "Copy details" (the raw record, for a bug report) and clears the status bar;
 * the desktop layout keeps the raw `[kind] message` rows (D44).
 * The 411x914 placement is measured in a real WebView by the packaged journey.
 */
const SOURCE = readFileSync(resolve(__dirname, '../src/app/components/DiagBanner.vue'), 'utf8');

function useWidth(compact: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: compact && query === COMPACT_QUERY,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

function seedIncident(): void {
  recordDiagError('error', new ReferenceError('i is not defined'));
  recordDiagDetail('terminal-stall', 'terminal output parsing stalled (1520 chars queued, session bots)', {});
}

beforeEach(() => {
  diagErrors.value = [];
});

afterEach(() => {
  diagErrors.value = [];
  vi.restoreAllMocks();
});

describe('DiagBanner on a phone (compact layout)', () => {
  it('says what happened in plain words, never the raw kind or developer message', async () => {
    useWidth(true);
    seedIncident();
    const wrapper = mount(DiagBanner);
    await flushPromises();
    const rows = wrapper.findAll('.diag-strip .row');
    expect(rows.map((row) => row.attributes('data-diag-kind'))).toEqual(['error', 'terminal-stall']);
    expect(rows.map((row) => row.find('.message').text())).toEqual([
      'Something went wrong in PocketShell.',
      'The terminal stopped showing new output.',
    ]);
    const text = wrapper.text();
    expect(text).not.toContain('[error]');
    expect(text).not.toContain('[terminal-stall]');
    expect(text).not.toContain('is not defined');
    expect(text).not.toContain('parsing stalled');
    wrapper.unmount();
  });

  it('offers Copy details, which puts the raw record and stack on the clipboard', async () => {
    useWidth(true);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    seedIncident();
    const wrapper = mount(DiagBanner);
    await flushPromises();
    const copy = wrapper.findAll('.row')[0]!.get('button.copy');
    expect(copy.text()).toBe('Copy details');
    await copy.trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(copied.startsWith('[error] i is not defined\nReferenceError: i is not defined')).toBe(true);
    expect(copy.text()).toBe('Copied');
    wrapper.unmount();
  });

  it('dismisses one row at a time', async () => {
    useWidth(true);
    seedIncident();
    const wrapper = mount(DiagBanner);
    await flushPromises();
    await wrapper.findAll('.row')[0]!.get('button.dismiss').trigger('click');
    expect(wrapper.findAll('.row').map((row) => row.attributes('data-diag-kind'))).toEqual(['terminal-stall']);
    wrapper.unmount();
  });
});

describe('DiagBanner on desktop (expanded layout) is unchanged', () => {
  it('keeps the raw `[kind] message` rows with the stack as the title and no extra actions', async () => {
    useWidth(false);
    seedIncident();
    const wrapper = mount(DiagBanner);
    await flushPromises();
    const rows = wrapper.findAll('.diag-strip p.row');
    expect(rows.map((row) => `${row.get('.kind').text()} ${row.get('.message').text()}`)).toEqual([
      '[error] i is not defined',
      '[terminal-stall] terminal output parsing stalled (1520 chars queued, session bots)',
    ]);
    expect(rows[0]!.attributes('title')).toContain('ReferenceError: i is not defined');
    expect(wrapper.find('button.copy').exists()).toBe(false);
    expect(wrapper.find('.diag-strip.compact').exists()).toBe(false);
    expect(wrapper.find('[data-diag-kind]').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('DiagBanner placement', () => {
  it('sits below the platform top inset, which desktop and web leave at 0px', () => {
    expect(SOURCE).toMatch(/\.diag-strip \{[^}]*top: calc\(var\(--ps-inset-top\) \+ var\(--sp-2\)\);/);
  });
});

describe('diag presentation', () => {
  it('has a plain sentence for every kind and copies the raw record', () => {
    for (const kind of ['render', 'error', 'unhandledrejection', 'terminal-stall', 'terminal-selection', 'editor'] as const) {
      expect(plainDiagSummary(kind)).toMatch(/^[A-Z][^[\]]+\.$/);
    }
    expect(diagDetailsText({ kind: 'terminal-stall', message: 'stalled', stack: null })).toBe('[terminal-stall] stalled');
  });
});

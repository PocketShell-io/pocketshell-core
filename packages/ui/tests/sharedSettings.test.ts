import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { composerTiming } from '@pocketshell/core';
import { coerceSettings, settingsDefaults, useSettingsStore } from '../src/app/stores/settings';
import { registerSettingsSection, settingsSections } from '../src/app/settingsSections';
import { provideApi } from '../src/app/ipc';
import { diagErrors, dismissDiagError, installDiagCapture } from '../src/app/diag';
import type { PocketShellApi } from '../src/app/api';

describe('shared settings: lifecycle, advanced and usage preferences', () => {
  it('defaults every carried-over 0.5.x preference', () => {
    expect(settingsDefaults()).toMatchObject({
      backgroundGraceMs: 90_000,
      reconnectOnReturn: true,
      usageWarnPercent: null,
      submitEnterDelayMs: composerTiming.submitDelayMs,
    });
  });

  it('keeps valid stored values, snaps sliders and degrades bad values per key', () => {
    expect(coerceSettings({ backgroundGraceMs: 600_000, reconnectOnReturn: false, usageWarnPercent: 67, submitEnterDelayMs: 174, theme: 'dark' }))
      .toMatchObject({ backgroundGraceMs: 600_000, reconnectOnReturn: false, usageWarnPercent: 65, submitEnterDelayMs: 150 });
    expect(coerceSettings({ backgroundGraceMs: 45_000, reconnectOnReturn: 'no', usageWarnPercent: 'x', submitEnterDelayMs: null }))
      .toMatchObject({ backgroundGraceMs: 90_000, reconnectOnReturn: true, usageWarnPercent: null, submitEnterDelayMs: 250 });
    expect(coerceSettings({ usageWarnPercent: null }).usageWarnPercent).toBeNull();
  });

  it('resets only the Advanced values together', () => {
    setActivePinia(createPinia());
    const store = useSettingsStore();
    expect(store.advancedIsDefault).toBe(true);
    store.set('usageWarnPercent', 60);
    store.set('submitEnterDelayMs', 500);
    store.set('backgroundGraceMs', 600_000);
    expect(store.advancedIsDefault).toBe(false);
    store.resetAdvancedDefaults();
    expect(store.usageWarnPercent).toBeNull();
    expect(store.submitEnterDelayMs).toBe(composerTiming.submitDelayMs);
    expect(store.backgroundGraceMs).toBe(600_000);
    expect(store.advancedIsDefault).toBe(true);
  });
});

describe('platform settings sections', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
  const component = defineComponent({ render: () => null });

  it('renders registered sections by order, replaces by id and unregisters', () => {
    cleanups.push(registerSettingsSection({ id: 'voice', title: 'Voice', order: 20, component }));
    cleanups.push(registerSettingsSection({ id: 'crash-reporter', title: 'Crash reporting', order: 10, component }));
    cleanups.push(registerSettingsSection({ id: 'update-install', title: 'Updates on this device', order: 20, component }));
    expect(settingsSections().map((section) => section.id)).toEqual(['crash-reporter', 'voice', 'update-install']);

    const unregister = registerSettingsSection({ id: 'voice', title: 'Dictation', order: 5, component });
    expect(settingsSections().map((section) => `${section.id}:${section.title}`)).toEqual([
      'voice:Dictation', 'crash-reporter:Crash reporting', 'update-install:Updates on this device',
    ]);
    unregister();
    expect(settingsSections().map((section) => section.id)).toEqual(['crash-reporter', 'update-install']);
    expect(() => registerSettingsSection({ id: 'Bad Id', title: 'x', component })).toThrow(/kebab-case/);
  });
});

describe('shared unhandled-error capture', () => {
  it('routes Vue, unhandled-rejection and window errors to the platform diag log with the error class', () => {
    const log = vi.fn();
    provideApi({ diag: { log } } as unknown as PocketShellApi);
    const app = createApp({});
    const target = new EventTarget() as unknown as Window;
    const uninstall = installDiagCapture(app, target);

    app.config.errorHandler?.(new TypeError('render broke'), null, 'render');
    const rejection = Object.assign(new Event('unhandledrejection'), { reason: new RangeError('async broke') });
    target.dispatchEvent(rejection);
    target.dispatchEvent(Object.assign(new Event('error'), { error: new SyntaxError('window broke') }));
    target.dispatchEvent(Object.assign(new Event('error'), { error: null }));

    expect(log.mock.calls.map(([entry]) => [entry.kind, entry.errorName, entry.message])).toEqual([
      ['render', 'TypeError', 'render broke'],
      ['unhandledrejection', 'RangeError', 'async broke'],
      ['error', 'SyntaxError', 'window broke'],
    ]);
    expect(diagErrors.value.map((entry) => entry.kind)).toEqual(['render', 'unhandledrejection', 'error']);
    uninstall();
    target.dispatchEvent(Object.assign(new Event('error'), { error: new Error('after uninstall') }));
    expect(log).toHaveBeenCalledTimes(3);
    for (const entry of [...diagErrors.value]) dismissDiagError(entry.id);
  });
});

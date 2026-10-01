// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticReport } from '@pocketshell/core';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import DiagnosticsPanel from '../src/app/components/DiagnosticsPanel.vue';

function report(id: string, at: number, body = 'trace'): DiagnosticReport {
  return { id, source: 'runtime-error', at, title: `Uncaught error: ${id}`, body };
}

function transport(initial: DiagnosticReport[]) {
  let reports = [...initial];
  const diagnostics = {
    list: vi.fn(async () => [...reports]),
    remove: vi.fn(async (id: string) => {
      const before = reports.length;
      reports = reports.filter((entry) => entry.id !== id);
      return reports.length < before;
    }),
    clear: vi.fn(async () => {
      const removed = reports.length;
      reports = [];
      return removed;
    }),
    share: vi.fn(async (_payload: { fileName: string; text: string }) => 'shared' as const),
  };
  provideApi({ diagnostics } as unknown as PocketShellApi);
  return diagnostics;
}

beforeEach(() => setActivePinia(createPinia()));

describe('DiagnosticsPanel', () => {
  it('shows the empty state when there are no reports', async () => {
    transport([]);
    const wrapper = mount(DiagnosticsPanel);
    await flushPromises();
    expect(wrapper.find('[data-testid=diagnostics-empty]').exists()).toBe(true);
    expect(wrapper.find('[data-testid=diagnostics-clear]').exists()).toBe(false);
  });

  it('lists reports, opens one and shares it re-redacted', async () => {
    const diagnostics = transport([report('a', 2, 'connect to prodbox.corp.example.com failed'), report('b', 1)]);
    const wrapper = mount(DiagnosticsPanel);
    await flushPromises();
    expect(wrapper.findAll('[data-report-id]').map((row) => row.attributes('data-report-id'))).toEqual(['a', 'b']);
    await wrapper.find('[data-testid=diagnostics-report-a]').trigger('click');
    expect(wrapper.find('[data-testid=diagnostics-report-body]').text()).toContain('connect to');
    await wrapper.find('[data-testid=diagnostics-share-report]').trigger('click');
    await flushPromises();
    const payload = diagnostics.share.mock.calls[0]![0];
    expect(payload.fileName).toMatch(/^pocketshell-report-.*\.txt$/);
    expect(payload.text).toContain('=== Uncaught error: a');
    expect(payload.text).not.toContain('prodbox.corp.example.com');
    expect(wrapper.find('[data-testid=diagnostics-status]').text()).toContain('share sheet');
  });

  it('deletes one report only after a second tap, then shows it gone', async () => {
    const diagnostics = transport([report('a', 2), report('b', 1)]);
    const wrapper = mount(DiagnosticsPanel);
    await flushPromises();
    await wrapper.find('[data-testid=diagnostics-report-a]').trigger('click');
    const del = wrapper.find('[data-testid=diagnostics-delete-report]');
    await del.trigger('click');
    expect(diagnostics.remove).not.toHaveBeenCalled();
    expect(del.text()).toContain('Tap again');
    await del.trigger('click');
    await flushPromises();
    expect(diagnostics.remove).toHaveBeenCalledWith('a');
    expect(wrapper.findAll('[data-report-id]').map((row) => row.attributes('data-report-id'))).toEqual(['b']);
    expect(wrapper.find('[data-testid=diagnostics-status]').text()).toContain('deleted');
  });

  it('clears all reports after a second tap and reloads the empty list', async () => {
    const diagnostics = transport([report('a', 2), report('b', 1)]);
    const wrapper = mount(DiagnosticsPanel);
    await flushPromises();
    await wrapper.find('[data-testid=diagnostics-clear]').trigger('click');
    expect(diagnostics.clear).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid=diagnostics-clear]').text()).toContain('Tap again to remove 2');
    await wrapper.find('[data-testid=diagnostics-clear]').trigger('click');
    await flushPromises();
    expect(diagnostics.clear).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid=diagnostics-empty]').exists()).toBe(true);
    expect(wrapper.find('[data-testid=diagnostics-status]').text()).toContain('Removed 2 local reports');
  });

  it('shows a load failure with a retry', async () => {
    const diagnostics = transport([report('a', 1)]);
    diagnostics.list.mockRejectedValueOnce(new Error('storage unavailable'));
    const wrapper = mount(DiagnosticsPanel);
    await flushPromises();
    expect(wrapper.text()).toContain('Could not load reports: storage unavailable');
    await wrapper.find('.notice button').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-report-id]')).toHaveLength(1);
  });
});

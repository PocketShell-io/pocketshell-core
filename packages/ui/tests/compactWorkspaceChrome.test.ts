// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@pocketshell/core';
import type { WorkspaceTab } from '@pocketshell/core/shared/workspaceTabs';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import { useConnectionStore } from '../src/app/stores/connection';
import { useSessionsStore } from '../src/app/stores/sessions';
import HostWorkspaceView from '../src/app/views/HostWorkspaceView.vue';
import WorkspaceTabBar from '../src/app/components/WorkspaceTabBar.vue';
import { dismissTopLayer, openDismissLayerCount } from '../src/app/extensions';
import { registerTabActions, tabActionRowsFor, unregisterTabActions } from '../src/app/workspaceTabActions';

/**
 * #3121 (Mobile S2): the compact workspace chrome, asserted on the REAL
 * HostWorkspaceView / SessionTree / WorkspaceTabBar in jsdom. Layout geometry
 * (44px strip, 48px rows) is measured in real Chromium by
 * compactChromeBrowser.test.ts; this file holds the structural and behavioural
 * contract, and for every compact rule the same mount at an expanded width
 * asserts the desktop output is unchanged.
 */

function installWidth(width: number): void {
  const matchMedia = (query: string) => {
    const max = Number(/max-width:\s*(\d+)px/.exec(query)?.[1]);
    return {
      // `pointer: coarse` is true for the phone widths and false for the desktop
      // one, so a compact mount gets the bottom sheet and 1200 gets the menu.
      matches: /pointer:\s*coarse/.test(query) ? width <= 640 : Number.isFinite(max) ? width <= max : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  };
  vi.stubGlobal('matchMedia', matchMedia);
  Object.defineProperty(window, 'matchMedia', { value: matchMedia, configurable: true, writable: true });
}

function provideTransport(): void {
  const overrides: Record<string, unknown> = {
    'forwards.list': async () => [],
    'forwards.isAutoEnabled': async () => false,
    'helper.sessionsListing': async () => ({ sessions: SESSIONS, errors: [] }),
    'helper.sessionsList': async () => SESSIONS,
    'helper.warnings': async () => [],
    'projects.home': async () => ({ ok: true, home: '/home/u', error: null }),
  };
  const group = (name: string) =>
    new Proxy({}, {
      get: (_t, method: string) =>
        overrides[`${name}.${method}`] ??
        (method.startsWith('on') ? () => () => undefined : async () => undefined),
    });
  // `hosts` / `workspaces` are absent like on a platform that reads them from
  // elsewhere (the browser harness does the same), so Settings mounts cleanly.
  provideApi(
    new Proxy({}, {
      get: (_t, name: string) => (name === 'hosts' || name === 'workspaces' ? undefined : group(name)),
    }) as unknown as PocketShellApi,
  );
}

const SESSIONS: SessionSummary[] = [
  { name: 'main', created: 1, activity: 2, attached: true, path: '/home/u/git/alpha' },
  { name: 'shell', created: 1, activity: 2, attached: false, path: '/home/u/git/alpha' },
  { name: 'other', created: 1, activity: 2, attached: false, path: '/home/u/git/beta' },
];

/** Counts mounts of the pane's content: a remount would reset a terminal. */
const paneMounts = { mounted: 0, unmounted: 0 };
const FolderStub = defineComponent({
  setup() {
    onMounted(() => {
      paneMounts.mounted += 1;
    });
    onBeforeUnmount(() => {
      paneMounts.unmounted += 1;
    });
    return () => h('div', { class: 'pane-stub' }, 'terminal');
  },
});

async function mountWorkspace(width: number, path: string) {
  installWidth(width);
  provideTransport();
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = useConnectionStore(pinia) as unknown as {
    connectionId: string | null;
    activeHost: { name: string } | null;
  };
  connection.connectionId = 'h1';
  connection.activeHost = { name: 'hetzner' };
  useSessionsStore(pinia).$patch({ sessions: SESSIONS } as never);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'hosts', component: { render: () => h('div') } },
      {
        path: '/host/:name',
        component: HostWorkspaceView,
        children: [
          { path: '', name: 'host-sessions', component: { render: () => h('div') } },
          { path: 'folder/:folder', name: 'folder', component: FolderStub },
        ],
      },
    ],
  });
  await router.push(path);
  await router.isReady();
  const wrapper = mount({ render: () => h(RouterView) }, {
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  });
  await flushPromises();
  return { wrapper, router };
}

let current: VueWrapper | null = null;
beforeEach(() => {
  paneMounts.mounted = 0;
  paneMounts.unmounted = 0;
});
afterEach(() => {
  current?.unmount();
  current = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('compact (phone) workspace chrome', () => {
  it('draws no icon rail and an app bar with back, folder switcher and overflow', async () => {
    const { wrapper } = await mountWorkspace(390, '/host/hetzner/folder/~%2Fgit%2Falpha');
    current = wrapper;
    expect(wrapper.find('.collapsed-rail').exists()).toBe(false);
    const bar = wrapper.find('[data-testid="compact-app-bar"]');
    expect(bar.exists()).toBe(true);
    expect(bar.find('button[aria-label="Back to sessions"]').exists()).toBe(true);
    expect(bar.find('[data-testid="compact-app-bar-title"]').text()).toContain('alpha');
    expect(bar.find('button[aria-label="More"]').exists()).toBe(true);
  });

  it('the overflow sheet carries labelled Ports, Usage, Monitor, Quick actions and Settings', async () => {
    const { wrapper } = await mountWorkspace(390, '/host/hetzner/folder/~%2Fgit%2Falpha');
    current = wrapper;
    await wrapper.find('button[aria-label="More"]').trigger('click');
    const sheet = document.body.querySelector('[data-testid="host-overflow-sheet"]');
    expect(sheet).not.toBeNull();
    const rows = [...sheet!.querySelectorAll('.menu-item')].map((r) => r.textContent?.trim());
    expect(rows).toEqual([
      'Port forwarding',
      'Provider usage',
      'Host monitor',
      'Quick actions',
      'Settings',
    ]);
  });

  it('tapping the app-bar title opens the folder switcher as a sheet and picking a row navigates', async () => {
    const { wrapper, router } = await mountWorkspace(390, '/host/hetzner/folder/~%2Fgit%2Falpha');
    current = wrapper;
    await wrapper.find('[data-testid="compact-app-bar-title"]').trigger('click');
    const rows = [...document.body.querySelectorAll('.popup-menu.sheet .switch-item')];
    expect(rows.map((r) => r.querySelector('.switch-label')?.textContent)).toEqual(['alpha', 'beta']);
    (rows[1] as HTMLElement).click();
    await flushPromises();
    expect(router.currentRoute.value.params['folder']).toBe('~/git/beta');
    expect(document.body.querySelector('.popup-menu.sheet')).toBeNull();
  });

  it('the session panel header is back, refresh, new session and overflow only', async () => {
    const { wrapper } = await mountWorkspace(390, '/host/hetzner');
    current = wrapper;
    const header = wrapper.find('[data-testid="session-tree-compact-header"]');
    expect(header.exists()).toBe(true);
    expect(header.findAll('button').map((b) => b.attributes('aria-label'))).toEqual([
      'Back to hosts',
      'Refresh',
      'New session in any folder',
      'More',
    ]);
    expect(wrapper.find('.tree-header:not(.compact)').exists()).toBe(false);
  });

  it('the panel header overflow opens the same labelled sheet and routes Settings', async () => {
    const { wrapper } = await mountWorkspace(390, '/host/hetzner');
    current = wrapper;
    await wrapper.find('[data-testid="session-tree-compact-header"] button[aria-label="More"]').trigger('click');
    (document.body.querySelector('[data-testid="host-overflow-settings"]') as HTMLElement).click();
    await flushPromises();
    expect(document.body.querySelector('.popup-menu.sheet')).toBeNull();
    expect(document.body.querySelector('[role="dialog"][aria-label="Settings"]')).not.toBeNull();
  });

  it('a host tool picked from the session list shows the tool even when it is already the open folder', async () => {
    const { wrapper, router } = await mountWorkspace(390, '/host/hetzner/folder/~%2Fgit%2Falpha');
    current = wrapper;
    const hidden = () => (wrapper.find('aside.session-panel').attributes('style') ?? '').includes('display: none');
    for (const round of [1, 2]) {
      await wrapper.find('button[aria-label="Back to sessions"]').trigger('click');
      await nextTick();
      expect(hidden(), `round ${round}: the session list is up`).toBe(false);
      await wrapper.find('[data-testid="session-tree-compact-header"] button[aria-label="More"]').trigger('click');
      (document.body.querySelector('[data-testid="host-overflow-usage"]') as HTMLElement).click();
      await flushPromises();
      expect(router.currentRoute.value.params['folder'], `round ${round}`).toBe('::maintenance::');
      // Round 2 re-picks the folder that is already open: the route does not
      // change, so nothing else would take the list off the screen.
      expect(hidden(), `round ${round}: the tool is in front, not the list`).toBe(true);
    }
  });

  it('keeps both halves mounted: panel <-> pane swaps without remounting the pane', async () => {
    const { wrapper } = await mountWorkspace(390, '/host/hetzner/folder/~%2Fgit%2Falpha');
    current = wrapper;
    expect(paneMounts).toEqual({ mounted: 1, unmounted: 0 });
    const panel = wrapper.find('aside.session-panel');
    const pane = wrapper.find('main.session-pane');
    expect(panel.exists() && pane.exists()).toBe(true);
    expect(panel.attributes('style')).toContain('display: none');
    await wrapper.find('button[aria-label="Back to sessions"]').trigger('click');
    await nextTick();
    expect(wrapper.find('aside.session-panel').attributes('style') ?? '').not.toContain('display: none');
    expect(wrapper.find('main.session-pane').attributes('style')).toContain('display: none');
    expect(paneMounts).toEqual({ mounted: 1, unmounted: 0 });
  });
});

describe('compact overflow: the front tab\'s actions', () => {
  it('lists Rename and `Stop this session` under the host rows, and Stop only arms the confirm', async () => {
    const stopped: string[] = [];
    const renamed: string[] = [];
    const source = () =>
      tabActionRowsFor(TABS[0], {
        rename: (tab) => renamed.push(tab.label),
        stop: (session) => stopped.push(session),
        closeFiles: () => undefined,
        closeTool: () => undefined,
      });
    registerTabActions(source);
    try {
      const { wrapper } = await mountWorkspace(390, '/host/hetzner/folder/~%2Fgit%2Falpha');
      current = wrapper;
      await wrapper.find('button[aria-label="More"]').trigger('click');
      const tabRows = [...document.body.querySelectorAll('[data-testid^="host-overflow-tab-"]')];
      expect(tabRows.map((r) => r.textContent?.trim())).toEqual(['Rename session…', 'Stop this session']);
      expect(tabRows[1]!.classList.contains('danger')).toBe(true);
      (tabRows[1] as HTMLElement).click();
      await flushPromises();
      // The tap hands the session to the tab bar's stop path (which opens the
      // named confirm dialog); nothing else happened and the sheet is gone.
      expect(stopped).toEqual(['main']);
      expect(renamed).toEqual([]);
      expect(document.body.querySelector('.popup-menu.sheet')).toBeNull();
    } finally {
      unregisterTabActions(source);
    }
  });

  it('is a dismiss layer: Android Back closes the sheet before it navigates', async () => {
    const { wrapper } = await mountWorkspace(390, '/host/hetzner/folder/~%2Fgit%2Falpha');
    current = wrapper;
    expect(openDismissLayerCount()).toBe(0);
    await wrapper.find('button[aria-label="More"]').trigger('click');
    expect(document.body.querySelector('.popup-menu.sheet')).not.toBeNull();
    expect(openDismissLayerCount()).toBe(1);
    expect(dismissTopLayer()).toBe(true);
    await flushPromises();
    expect(document.body.querySelector('.popup-menu.sheet')).toBeNull();
    expect(openDismissLayerCount()).toBe(0);
  });

  it('a scrim tap closes the sheet', async () => {
    const { wrapper } = await mountWorkspace(390, '/host/hetzner/folder/~%2Fgit%2Falpha');
    current = wrapper;
    await wrapper.find('button[aria-label="More"]').trigger('click');
    document.body.querySelector('.popup-scrim')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushPromises();
    expect(document.body.querySelector('.popup-menu.sheet')).toBeNull();
  });
});

describe('expanded layout is unchanged', () => {
  it('has no app bar and no compact header, and keeps the nine-control strip', async () => {
    const { wrapper } = await mountWorkspace(1200, '/host/hetzner/folder/~%2Fgit%2Falpha');
    current = wrapper;
    expect(wrapper.find('[data-testid="compact-app-bar"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="session-tree-compact-header"]').exists()).toBe(false);
    const header = wrapper.find('.tree-header');
    expect(header.classes()).toEqual(['tree-header']);
    expect(header.findAll('button').map((b) => b.attributes('title'))).toEqual([
      'Hide session panel',
      'Back to hosts',
      'New session in any folder',
      'Quick actions',
      'Port forwarding',
      'Provider usage',
      'Host monitor',
      'Refresh',
      'Settings',
    ]);
  });

  it('collapsing the panel still draws the rail with its switcher menu', async () => {
    const { wrapper } = await mountWorkspace(1200, '/host/hetzner/folder/~%2Fgit%2Falpha');
    current = wrapper;
    await wrapper.find('button[title="Hide session panel"]').trigger('click');
    const rail = wrapper.find('aside.collapsed-rail');
    expect(rail.exists()).toBe(true);
    expect(rail.findAll('button').map((b) => b.attributes('title'))).toEqual([
      'Show session panel',
      'Back to hosts',
      'Sessions — 3',
      'Port forwarding',
      'Provider usage',
      'Host monitor',
      'Settings',
    ]);
    await rail.find('button[title="Sessions — 3"]').trigger('click');
    expect(document.body.querySelector('.popup-menu .switch-item')).not.toBeNull();
    expect(document.body.querySelector('.popup-menu.sheet')).toBeNull();
  });
});

const TABS: WorkspaceTab[] = [
  { kind: 'session', id: 's:main', session: 'main', label: 'main' } as WorkspaceTab,
  { kind: 'session', id: 's:shell', session: 'shell', label: 'shell' } as WorkspaceTab,
  { kind: 'files', id: 'files-1', label: 'Files' } as WorkspaceTab,
];

function mountTabBar(width: number) {
  installWidth(width);
  return mount(WorkspaceTabBar, {
    props: {
      tabs: TABS,
      activeTabId: 's:main',
      renaming: null,
      renameText: '',
      renameError: null,
      addAnchor: null,
      sessionTabTitle: (s: string) => s,
      tabMark: () => null,
      identityFor: (s: string) => s,
      addressFor: () => null,
      vsCode: false,
      addable: true,
      captureable: false,
      captureTitle: '',
    } as never,
    attachTo: document.body,
  });
}

describe('workspace tab bar', () => {
  it('compact: no `×` on any tab, strip flagged compact, tabs not draggable', () => {
    current = mountTabBar(390) as unknown as VueWrapper;
    expect(current.findAll('.tab-close')).toHaveLength(0);
    expect(current.find('.folder-bar').classes()).toContain('compact');
    expect(current.findAll('.tabs .tab').every((t) => t.attributes('draggable') === 'false')).toBe(true);
    expect(current.findAll('.tabs .tab')).toHaveLength(3);
  });

  it('expanded: the `×` on every tab and the bar markup are exactly as before', () => {
    current = mountTabBar(1200) as unknown as VueWrapper;
    expect(current.findAll('.tab-close').map((c) => c.attributes('title'))).toEqual([
      'Stop this session',
      'Stop this session',
      'Close this Files tab',
    ]);
    expect(current.find('.folder-bar').classes()).toEqual(['folder-bar']);
    expect(current.findAll('.tabs .tab').every((t) => t.attributes('draggable') === 'true')).toBe(true);
  });
});

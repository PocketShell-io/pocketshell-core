// Harness for compactChromeBrowser.test.ts (#3121): the REAL HostWorkspaceView
// (real SessionTree, app bar, sheets, tokens) in real Chromium. The folder
// route renders the REAL WorkspaceTabBar over a flexible body standing in for
// the terminal; everything else is the shipped shell.
//   ?route=pane  -> /host/hetzner/folder/~/git/alpha   (a folder open)
//   ?route=panel -> /host/hetzner                       (the session list)
import '@ui/styles.css';
import { createPinia } from 'pinia';
import { createApp, defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import type { SessionSummary } from '@pocketshell/core';
import type { WorkspaceTab } from '@pocketshell/core/shared/workspaceTabs';
import { provideApi } from '@ui/app/ipc';
import type { PocketShellApi } from '@ui/app/api';
import { useConnectionStore } from '@ui/app/stores/connection';
import { useSessionsStore } from '@ui/app/stores/sessions';
import HostWorkspaceView from '@ui/app/views/HostWorkspaceView.vue';
import WorkspaceTabBar from '@ui/app/components/WorkspaceTabBar.vue';

const SESSIONS: SessionSummary[] = [
  { name: 'home-alexey-main', created: 1, activity: 2, attached: true, path: '/home/u/git/alpha' },
  { name: 'alexey-home-shell', created: 1, activity: 2, attached: false, path: '/home/u/git/alpha' },
  { name: 'other', created: 1, activity: 2, attached: false, path: '/home/u/git/beta' },
];
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
      overrides[`${name}.${method}`] ?? (method.startsWith('on') ? () => () => undefined : async () => undefined),
  });
provideApi(
  new Proxy({}, {
    get: (_t, name: string) => (name === 'hosts' || name === 'workspaces' ? undefined : group(name)),
  }) as unknown as PocketShellApi,
);

const TABS: WorkspaceTab[] = [
  { kind: 'session', id: 's:main', session: 'home-alexey-main', label: 'home-alexey' } as WorkspaceTab,
  { kind: 'session', id: 's:shell', session: 'alexey-home-shell', label: 'alexey:home-shell' } as WorkspaceTab,
  { kind: 'files', id: 'files-1', label: 'Files' } as WorkspaceTab,
];
const Folder = defineComponent({
  setup: () => () =>
    h('div', { style: 'display:flex;flex-direction:column;flex:1;min-height:0', class: 'folder-stub' }, [
      h(WorkspaceTabBar, {
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
        captureable: true,
        captureTitle: 'Copy screen',
      } as never),
      h('div', { class: 'terminal-stub', style: 'flex:1;min-height:0' }),
    ]),
});

const pinia = createPinia();
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
        { path: 'folder/:folder', name: 'folder', component: Folder },
      ],
    },
  ],
});
const pane = new URLSearchParams(location.search).get('route') !== 'panel';
void router.push(pane ? '/host/hetzner/folder/~%2Fgit%2Falpha' : '/host/hetzner').then(() => {
  createApp({ render: () => h(RouterView) }).use(pinia).use(router).mount('#app');
});

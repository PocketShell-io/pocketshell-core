// Harness for filesPortsLayoutBrowser.test.ts: the REAL FilesView or
// PortPanelView in real Chromium, fed by an in-memory API. `?view=files|ports`.
import '@ui/styles.css';
import { createPinia } from 'pinia';
import { createApp, h } from 'vue';
import { provideApi } from '@ui/app/ipc';
import { useConnectionStore } from '@ui/app/stores/connection';
import FilesView from '@ui/app/views/FilesView.vue';
import PortPanelView from '@ui/app/views/PortPanelView.vue';
import type { PocketShellApi } from '@ui/app/api';

const view = new URLSearchParams(location.search).get('view');
const group = (name: string) => new Proxy({}, {
  get: (_t, key: string) => (key.startsWith('on') ? () => () => undefined : async () => undefined),
});

const entries = Array.from({ length: 60 }, (_v, i) => ({
  name: i < 6 ? `folder-${i}` : `notes-${String(i).padStart(2, '0')}.bin`,
  longname: '',
  type: i < 6 ? 'dir' : 'file',
  size: 2048 + i,
  modifyTime: 0,
  accessTime: 0,
  rights: { user: 'rw-', group: 'r--', other: 'r--' },
  owner: 0,
  group: 0,
}));

const sftp = {
  list: async () => entries,
  stat: async () => ({ type: 'file', size: 2048, modifyTime: 0, accessTime: 0 }),
  realPath: async (_c: string, p: string) => (p === '.' || p === '~' ? '/home/dev/project' : p),
  // Bytes that are not text: the binary panel, no CodeMirror chunk needed.
  readBinary: async () => new Uint8Array([0, 1, 2, 3, 255, 254, 0, 0]),
};

const forwardStates = [
  { key: 'L:3000', kind: 'local', listenHost: '127.0.0.1', listenPort: 3000, destHost: '127.0.0.1', destPort: 3000, origin: 'auto', active: true, bytesIn: 1234567, bytesOut: 98765, rateIn: 2048, rateOut: 0, name: 'web dev server', process: 'node', cwd: '/home/dev/project/frontend', remapped: false },
  { key: 'L:8080', kind: 'local', listenHost: '127.0.0.1', listenPort: 18080, destHost: '127.0.0.1', destPort: 8080, origin: 'manual', active: false, bytesIn: 0, bytesOut: 0, rateIn: 0, rateOut: 0, name: null, process: 'python3', cwd: '/home/dev/api', remapped: true },
  { key: 'R:9000', kind: 'remote', listenHost: '0.0.0.0', listenPort: 9000, destHost: '127.0.0.1', destPort: 9001, origin: 'manual', active: false, bytesIn: 10, bytesOut: 20, rateIn: 0, rateOut: 0, name: null, process: null, cwd: null, remapped: false },
];
const discovered = [
  { port: 3000, process: 'node', pid: 1, cwd: '/home/dev/project/frontend', forwarded: true, localPort: 3000, intent: null, name: 'web dev server', eligible: true, lastError: null },
  { port: 8080, process: 'python3', pid: 2, cwd: '/home/dev/api', forwarded: true, localPort: 18080, intent: null, name: null, eligible: true, lastError: null },
  { port: 5432, process: 'postgres', pid: 3, cwd: '/var/lib/postgresql', forwarded: false, localPort: null, intent: null, name: null, eligible: false, lastError: null },
];
const forwards = {
  list: async () => forwardStates,
  discovered: async () => discovered,
  status: async () => ({ scanning: false, lastScanAt: Date.now(), lastScanOk: true, lastError: null }),
  isAutoEnabled: async () => true,
  startAuto: async () => undefined,
  onStates: () => () => undefined,
};

const base = new Proxy({}, { get: (_t, name: string) => (name === 'sftp' ? sftp : name === 'forwards' ? forwards : group(name)) }) as unknown as PocketShellApi;
provideApi(base);

const pinia = createPinia();
const app = createApp({
  render: () =>
    h('div', { style: 'height: 100dvh; display: flex; flex-direction: column;' }, [
      view === 'ports' ? h(PortPanelView) : h(FilesView, { startPath: '/home/dev/project', sessionKey: 'harness' }),
    ]),
});
app.use(pinia);
useConnectionStore(pinia).connectionId = 'conn-1' as never;
app.mount('#app');

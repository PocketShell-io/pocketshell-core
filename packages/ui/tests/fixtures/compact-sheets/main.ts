// Harness for compactSheetsBrowser.test.ts: the REAL OverlayPanel, CommandPalette,
// PopupMenu, SettingsView and NewSessionDialog in real Chromium. ?case= picks one.
import '@ui/styles.css';
import { createPinia } from 'pinia';
import { createApp, h } from 'vue';
import { provideApi } from '@ui/app/ipc';
import { provideFontProfile, bundledOnlyFontProfile } from '@ui/app/fontProfile';
import { useProjectsStore } from '@ui/app/stores/projects';
import OverlayPanel from '@ui/app/components/OverlayPanel.vue';
import type { PocketShellApi } from '@ui/app/api';

const params = new URLSearchParams(location.search);
const which = params.get('case');
const group = (name: string) => new Proxy({}, {
  get: (_t, key: string) => (name === 'ssh' && key === 'listConfigHosts' ? async () => [] : key.startsWith('on') ? () => () => undefined : async () => undefined),
});
provideApi(new Proxy({}, {
  get: (_t, name: string) =>
    name === 'app' ? { onResumed: () => () => undefined, desktopChrome: true }
    : name === 'hosts' || name === 'workspaces' ? undefined : group(name),
}) as unknown as PocketShellApi);
provideFontProfile(bundledOnlyFontProfile('monospace'));

const pinia = createPinia();
const noop = (): void => undefined;
const commands = ['Open Files', 'Open Ports', 'Open Usage', 'New session', 'Settings', 'Switch host', 'Reconnect', 'Close tab', 'Rename session', 'Copy path'].map((label, i) => ({
  id: `c${i}`, label, group: i < 5 ? 'Go' : 'Session', hint: i % 3 === 0 ? 'Ctrl+K' : undefined, run: noop,
}));

// Heavy components load only for the case that needs them: the cold Vite transform
// of SettingsView/NewSessionDialog (CodeMirror, stores) took ~25s and made the
// plain overlay/palette/menu cases time out on a loaded CI runner.
const view = async () => {
  switch (which) {
    case 'palette':
      return h((await import('@ui/app/components/CommandPalette.vue')).default, { commands, onClose: noop });
    case 'menu':
      return h((await import('@ui/app/components/PopupMenu.vue')).default, { anchor: { left: 200, top: 300, width: 24, height: 24 }, onClose: noop }, {
        default: () => h('ul', ['Rename', 'Duplicate', 'Close session', 'Show in files'].map((t) => h('li', h('button', { class: 'menu-item' }, t)))),
      });
    case 'newsession': {
      const projects = useProjectsStore(pinia);
      projects.$patch({
        home: '/home/dev', cwd: '/home/dev/git',
        dirs: ['aplexer', 'pocketshell', 'pocketshell-core', 'pocketshell-cli', 'notes', 'dotfiles', 'scratch', 'website'].map((name) => ({ name })) as never,
      });
      return h((await import('@ui/app/components/NewSessionDialog.vue')).default, { onClose: noop });
    }
    case 'overlay-in-host':
      // A transformed host (the phone's session panel): fixed children resolve against it.
      return h('div', { style: 'transform: translateY(54px); height: 400px; overflow: hidden' }, [
        h(OverlayPanel, { title: 'Ports', size: 'lg' }, { default: () => h('div', { style: 'padding:16px' }, 'Panel body') }),
      ]);
    case 'settings': {
      const SettingsView = (await import('@ui/app/views/SettingsView.vue')).default;
      return h(OverlayPanel, { title: 'Settings', size: 'md' }, { default: () => h(SettingsView) });
    }
    default:
      return h(OverlayPanel, { title: 'Ports', size: 'lg' }, { default: () => h('div', { style: 'padding:16px' }, 'Panel body') });
  }
};
const root = await view();
const app = createApp({ render: () => root });
app.use(pinia);
app.mount('#app');

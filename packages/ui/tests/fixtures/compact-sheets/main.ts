// Harness for compactSheetsBrowser.test.ts: the REAL OverlayPanel, CommandPalette,
// PopupMenu, SettingsView and NewSessionDialog in real Chromium. ?case= picks one.
import '@ui/styles.css';
import { createPinia } from 'pinia';
import { createApp, h } from 'vue';
import { provideApi } from '@ui/app/ipc';
import { provideFontProfile, bundledOnlyFontProfile } from '@ui/app/fontProfile';
import { useProjectsStore } from '@ui/app/stores/projects';
import OverlayPanel from '@ui/app/components/OverlayPanel.vue';
import CommandPalette from '@ui/app/components/CommandPalette.vue';
import PopupMenu from '@ui/app/components/PopupMenu.vue';
import NewSessionDialog from '@ui/app/components/NewSessionDialog.vue';
import SettingsView from '@ui/app/views/SettingsView.vue';
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

const view = () => {
  switch (which) {
    case 'palette':
      return h(CommandPalette, { commands, onClose: noop });
    case 'menu':
      return h(PopupMenu, { anchor: { left: 200, top: 300, width: 24, height: 24 }, onClose: noop }, {
        default: () => h('ul', ['Rename', 'Duplicate', 'Close session', 'Show in files'].map((t) => h('li', h('button', { class: 'menu-item' }, t)))),
      });
    case 'newsession': {
      const projects = useProjectsStore(pinia);
      projects.$patch({
        home: '/home/dev', cwd: '/home/dev/git',
        dirs: ['aplexer', 'pocketshell', 'pocketshell-core', 'pocketshell-cli', 'notes', 'dotfiles', 'scratch', 'website'].map((name) => ({ name })) as never,
      });
      return h(NewSessionDialog, { onClose: noop });
    }
    case 'overlay-in-host':
      // A transformed host (the phone's session panel): fixed children resolve against it.
      return h('div', { style: 'transform: translateY(54px); height: 400px; overflow: hidden' }, [
        h(OverlayPanel, { title: 'Ports', size: 'lg' }, { default: () => h('div', { style: 'padding:16px' }, 'Panel body') }),
      ]);
    case 'settings':
      return h(OverlayPanel, { title: 'Settings', size: 'md' }, { default: () => h(SettingsView) });
    default:
      return h(OverlayPanel, { title: 'Ports', size: 'lg' }, { default: () => h('div', { style: 'padding:16px' }, 'Panel body') });
  }
};
const app = createApp({ render: view });
app.use(pinia);
app.mount('#app');

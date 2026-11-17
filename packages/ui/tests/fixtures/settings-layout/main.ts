// Harness for settingsLayoutBrowser.test.ts: the REAL Settings view inside the
// real OverlayPanel, in real Chromium, as an Android-style host (?host=android:
// app.desktopChrome === false, bundled-only fonts, stored theme `system`) or a
// desktop-style one (?host=desktop).
import '@ui/styles.css';
import { createPinia } from 'pinia';
import { createApp, h } from 'vue';
import { provideApi } from '@ui/app/ipc';
import { provideFontProfile, bundledOnlyFontProfile } from '@ui/app/fontProfile';
import { useSettingsStore } from '@ui/app/stores/settings';
import OverlayPanel from '@ui/app/components/OverlayPanel.vue';
import SettingsView from '@ui/app/views/SettingsView.vue';
import type { PocketShellApi } from '@ui/app/api';

const android = new URLSearchParams(location.search).get('host') === 'android';
const group = (name: string) => new Proxy({}, {
  get: (_t, key: string) => (name === 'ssh' && key === 'listConfigHosts' ? async () => [] : key.startsWith('on') ? () => () => undefined : async () => undefined),
});
const base = new Proxy({}, {
  get: (_t, name: string) => (name === 'hosts' || name === 'workspaces' ? undefined : group(name)),
}) as unknown as PocketShellApi;
provideApi(new Proxy({}, {
  get: (_t, name: string) => (android && name === 'app' ? { onResumed: () => () => undefined, desktopChrome: false } : (base as never)[name]),
}) as unknown as PocketShellApi);
if (android) provideFontProfile(bundledOnlyFontProfile('monospace'));

const pinia = createPinia();
const app = createApp({ render: () => h(OverlayPanel, { title: 'Settings', size: 'md' }, { default: () => h(SettingsView) }) });
app.use(pinia);
if (android) useSettingsStore(pinia).set('theme', 'system');
app.mount('#app');

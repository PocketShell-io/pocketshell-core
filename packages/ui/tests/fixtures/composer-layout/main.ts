// Harness for composerLayoutBrowser.test.ts (#3191): the REAL PromptComposer,
// docked in a phone-sized pane, with a platform `composer.accessory` row as
// tall as an upload chip. The test fills the card (banner, uploading line,
// tiles) through the real store and measures the rows in real Chromium.
import '@ui/styles.css';
import { createPinia } from 'pinia';
import { createApp, defineComponent, h } from 'vue';
import { provideApi } from '@ui/app/ipc';
import { provideExtensions } from '@ui/app/extensions';
import { provideFontProfile, bundledOnlyFontProfile } from '@ui/app/fontProfile';
import { useComposerStore } from '@ui/app/stores/composer';
import PromptComposer from '@ui/app/components/PromptComposer.vue';
import type { PocketShellApi } from '@ui/app/api';

const group = () => new Proxy({}, {
  get: (_t, key: string) => (key.startsWith('on') ? () => () => undefined : async () => undefined),
});
provideApi(new Proxy({}, {
  get: (_t, name: string) => (name === 'app' ? { onResumed: () => () => undefined } : group()),
}) as unknown as PocketShellApi);
provideFontProfile(bundledOnlyFontProfile('monospace'));

// One platform chip (an upload refusal is two text lines plus a 48px button).
const Chip = defineComponent({
  setup: () => () => h('div', { class: 'test-chip', style: 'width:100%;min-height:64px;box-sizing:border-box;border:1px solid red' }, 'VID_1.jpg — This photo is 101.0 MB; the limit is 100.0 MB.'),
});
provideExtensions({ 'composer.accessory': [{ id: 'test-chip', component: Chip }] });

const pinia = createPinia();
const app = createApp({
  setup: () => () => h('div', { style: 'position:relative;width:100vw;height:100vh;overflow:hidden' }, [
    h(PromptComposer, { connectionId: 'conn-1', sessionName: 'sess', connected: true }),
  ]),
});
app.use(pinia).mount('#app');
const composer = useComposerStore(pinia);
composer.setMode('docked');
(window as unknown as { __composer: unknown }).__composer = composer;

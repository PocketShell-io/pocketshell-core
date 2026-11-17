// Browser entry for scripts/verify-hit-targets.mjs: mounts the REAL AppRoot
// (its real <style>, the real tokens/primitives css) around the REAL router
// outlet and the REAL HostWorkspaceView at /host/box, over a stub transport.
// Built by Vite exactly like the app is, so the measured chain is the shipped
// one (no extracted-CSS copy). The stub answers every api call with an
// undefined/empty result: layout, not behaviour, is under test.
import { createApp, h } from 'vue';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import AppRoot from '@ui/app/AppRoot.vue';
import { createAppRoutes } from '@ui/app/routes';
import { provideApi } from '@ui/app/ipc';
import '@ui/tokens.css';
import '@ui/primitives.css';

function stub(path: string): unknown {
  const fn = () => Promise.resolve(undefined);
  return new Proxy(fn, {
    get: (_t, prop) => (prop === 'then' ? undefined : stub(`${path}.${String(prop)}`)),
    apply: () => Promise.resolve(undefined),
  });
}

provideApi(stub('api') as never);

const router = createRouter({ history: createMemoryHistory(), routes: createAppRoutes() });
const errors: string[] = [];
const app = createApp({ render: () => h(AppRoot) });
app.config.errorHandler = (e) => errors.push(String(e));
app.use(createPinia()).use(router);
(window as unknown as { __rootChainErrors: string[] }).__rootChainErrors = errors;
void router.push('/host/box').then(() => app.mount('#app'));

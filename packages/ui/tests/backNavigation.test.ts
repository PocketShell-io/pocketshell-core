// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createAppRoutes } from '@ui/app/routes';
import { registerDismissLayer } from '@ui/app/extensions';
import { handleBack } from '@ui/app/backNavigation';
import { MAINTENANCE_ROOT } from '@ui/app/maintenance';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

async function routerAt(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: createAppRoutes() });
  await router.push(path);
  return router;
}
const here = (r: Awaited<ReturnType<typeof routerAt>>) => String(r.currentRoute.value.name);

describe('handleBack', () => {
  it('is not consumed at the host list root', async () => {
    const router = await routerAt('/');
    expect(handleBack(router)).toBe(false);
    expect(here(router)).toBe('hosts');
  });

  it('closes the topmost layer first and leaves the route alone', async () => {
    const router = await routerAt('/host/box/folder/~%2Fgit%2Fx');
    const closed: string[] = [];
    cleanup.push(registerDismissLayer(() => closed.push('outer')));
    cleanup.push(registerDismissLayer(() => closed.push('inner')));
    expect(handleBack(router)).toBe(true);
    expect(closed).toEqual(['inner']);
    expect(here(router)).toBe('folder');
  });

  it('goes from a maintenance tool (Ports) to the host workspace, then to the host list', async () => {
    const router = await routerAt(`/host/box/folder/${encodeURIComponent(MAINTENANCE_ROOT)}`);
    expect(here(router)).toBe('folder');
    expect(handleBack(router)).toBe(true);
    await router.isReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(here(router)).toBe('host-sessions');
    expect(router.currentRoute.value.params['name']).toBe('box');
    expect(handleBack(router)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(here(router)).toBe('hosts');
    expect(handleBack(router)).toBe(false);
  });

  it('goes from a folder workspace to the host list', async () => {
    const router = await routerAt('/host/box/folder/~%2Fgit%2Fx');
    expect(handleBack(router)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(here(router)).toBe('hosts');
  });
});

describe('CommandPalette as a dismiss layer', () => {
  it('closes through the platform Back', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: CommandPalette } = await import('@ui/app/components/CommandPalette.vue');
    const { dismissTopLayer } = await import('@ui/app/extensions');
    const w = mount(CommandPalette, { props: { commands: [] }, attachTo: document.body });
    expect(dismissTopLayer()).toBe(true);
    expect(w.emitted('close')).toHaveLength(1);
    w.unmount();
    expect(dismissTopLayer()).toBe(false);
  });
});

// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia';
import { computed, defineComponent, h, nextTick, onMounted, onBeforeUnmount, type PropType } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter, RouterView, useRoute, useRouter } from 'vue-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import { useSessionsStore } from '../src/app/stores/sessions';
import { useFilesStore } from '../src/app/stores/files';
import { useProjectsStore } from '../src/app/stores/projects';
import { useComposerStore } from '../src/app/stores/composer';
import { useFolderTree } from '../src/app/folderTree';
import { useWorkspaceMemory } from '../src/app/useWorkspaceMemory';
import { useWorkspaceTabs } from '../src/app/useWorkspaceTabs';
import { usePaneIdentity } from '../src/app/paneIdentity';
import { useComposerDraft } from '../src/app/useComposerDraft';
import { sessionIdentityKey } from '../src/app/sessionIdentity';

/**
 * #3146: an aplexer session's `workspace` FOLLOWS the shell's cwd (verified on
 * a Windows desktop host and on Linux: `cd` flips the snapshot's `workspace`
 * while `id`, `tag` and the launch `cwd` stay). Pane identity used to include
 * that workspace, so every `cd` re-keyed the open pane, moved its tab out of
 * the open folder, unmounted the TerminalView and re-attached. Identity is now
 * the immutable aplexer id.
 *
 * Runs in core's own vitest (`npm run test:unit` in this repo's CI); it is not
 * part of the app repo's js-unit-test-manifest.
 */
const ID1 = '538ec222-0384-4393-b9cf-c0e83c365d66';
const ID2 = '11111111-2222-3333-4444-555555555555';
function row(id: string, workspace: string, name = 'home-User') {
  return {
    name, created: id === ID1 ? 1 : 2, activity: 2, attached: false, path: workspace,
    backend: 'aplexer' as const, workspace, tag: name, aplexerId: id,
  };
}

describe('sessionIdentityKey', () => {
  it('is the immutable id when known, whatever the workspace', () => {
    const a = sessionIdentityKey('t', { backend: 'aplexer', workspace: '/a', aplexerId: ID1 });
    const b = sessionIdentityKey('t', { backend: 'aplexer', workspace: '/b', aplexerId: ID1 });
    expect(a).toBe(b);
  });
  it('same tag + same workspace but different ids are distinct', () => {
    expect(sessionIdentityKey('t', { backend: 'aplexer', workspace: '/a', aplexerId: ID1 }))
      .not.toBe(sessionIdentityKey('t', { backend: 'aplexer', workspace: '/a', aplexerId: ID2 }));
  });
  it('falls back to workspace+tag without an id, and the bare name for tmux', () => {
    expect(sessionIdentityKey('t', { backend: 'aplexer', workspace: '/a' })).toBe('aplexer:/a:t');
    expect(sessionIdentityKey('t', { backend: 'tmux', workspace: '/a', aplexerId: ID1 })).toBe('t');
  });
});

const events: string[] = [];
let attached: Array<{ identity: string }> = [];
const Pane = defineComponent({
  props: {
    sessionKey: { type: String, required: true },
    backend: { type: String as PropType<'tmux' | 'aplexer'> },
    workspace: { type: String },
    aplexerId: { type: String },
  },
  setup(props) {
    const { registryKey } = usePaneIdentity(props);
    onMounted(() => { events.push(`mount ${registryKey.value}`); attached.push({ identity: registryKey.value }); });
    onBeforeUnmount(() => events.push(`unmount ${registryKey.value}`));
    return () => h('div', { class: 'pane', 'data-key': registryKey.value });
  },
});

let tabsApi: ReturnType<typeof useWorkspaceTabs>;
let composerKey: () => string;
const Workspace = defineComponent({
  setup() {
    const route = useRoute();
    const router = useRouter();
    const sessions = useSessionsStore();
    const folderKey = computed(() => String(route.params['folder'] ?? ''));
    const hostAlias = computed(() => String(route.params['name'] ?? ''));
    const { folders, allFolders } = useFolderTree();
    const folder = computed(() => folders.value.find((d) => d.key === folderKey.value) ?? null);
    const folderPath = computed(() => folder.value?.path ?? folderKey.value);
    const memory = useWorkspaceMemory({
      folderKey, hostAlias,
      routedTab: () => route.query['tab'] as string | undefined,
      getActiveTab: () => tabsApi.activeTab.value,
      focusActiveTab: () => {},
    });
    tabsApi = useWorkspaceTabs({
      folder, folderKey, folderPath, hostAlias, allFolders,
      followToFolder: (target, session) => { void router.replace({ name: 'folder', params: { name: hostAlias.value, folder: target }, query: { tab: session } }); },
      sessions, files: useFilesStore(), memory, focusActiveTab: async () => {},
    });
    memory.loadFolderState();
    const composer = useComposerStore();
    composerKey = () => {
      const m = tabsApi.activeSessionMeta.value;
      const props = { connectionId: 'c1', sessionName: tabsApi.activeSession.value ?? '', backend: m?.backend, workspace: m?.workspace, aplexerId: m?.aplexerId };
      return useComposerDraft({ composer, props } as never).key.value;
    };
    return () => h('div', tabsApi.terminalPanes.value.map((pane) => {
      const m = tabsApi.sessionMeta.value.get(pane.session);
      return h(Pane, { key: pane.id, sessionKey: pane.session, backend: m?.backend, workspace: m?.workspace ?? undefined, aplexerId: m?.aplexerId ?? undefined });
    }));
  },
});

async function setup(initial: ReturnType<typeof row>[], folder = '/work/a') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/host/:name/folder/:folder(.*)', name: 'folder', component: Workspace }],
  });
  await router.push({ name: 'folder', params: { name: 'h', folder } });
  const sessions = useSessionsStore();
  useProjectsStore().home = '/home/u';
  sessions.sessions = initial;
  const wrapper = mount({ render: () => h(RouterView) }, { global: { plugins: [router] } });
  await flushPromises();
  return { router, sessions, wrapper };
}

beforeEach(() => {
  setActivePinia(createPinia());
  const group = (g: string) => new Proxy({}, { get: (_t, m: string) => (m.startsWith('on') ? () => () => undefined : async () => (g === 'helper' && m === 'sessionsListing' ? { sessions: [], errors: [] } : undefined)) });
  provideApi(new Proxy({}, { get: (_t, g: string) => group(g) }) as unknown as PocketShellApi);
  events.length = 0; attached = [];
  localStorage.clear();
});

describe('cd under an open aplexer terminal (real tab/pane/draft consumers)', () => {
  it('keeps the pane mounted, the registry key and draft key unchanged, and follows the session to its new folder', async () => {
    const { router, sessions, wrapper } = await setup([row(ID1, '/work/a')]);
    expect(events).toEqual([`mount aplexer:${ID1}`]);
    const key0 = composerKey();
    const el0 = wrapper.find('.pane').element;
    // the shell cd's: same id, new workspace/path -> the tree files it under /work/b
    sessions.sessions = [row(ID1, '/work/b')];
    await flushPromises(); await nextTick(); await flushPromises();
    expect(events).toEqual([`mount aplexer:${ID1}`]); // no unmount, no second mount
    expect(wrapper.find('.pane').element).toBe(el0); // same DOM node
    expect(attached).toHaveLength(1); // no second attach
    expect(composerKey()).toBe(key0);
    expect(router.currentRoute.value.params['folder']).toBe('/work/b'); // route followed the session
    expect(router.currentRoute.value.query['tab']).toBe('home-User');
  });

  it('a NEW session with the same tag in the original folder gets a distinct pane and draft', async () => {
    const { sessions, wrapper } = await setup([row(ID1, '/work/a')]);
    sessions.sessions = [row(ID1, '/work/b')];
    await flushPromises(); await nextTick(); await flushPromises();
    const keyOld = composerKey();
    // create a fresh session with the same derived tag back in /work/a, then open that folder
    sessions.sessions = [row(ID1, '/work/b'), row(ID2, '/work/a')];
    await flushPromises();
    const { router } = { router: wrapper.vm.$router };
    await router.push({ name: 'folder', params: { name: 'h', folder: '/work/a' }, query: { tab: 'home-User' } });
    await flushPromises(); await nextTick();
    expect(composerKey()).not.toBe(keyOld);
    expect(wrapper.findAll('.pane').map((p) => p.attributes('data-key'))).toEqual([`aplexer:${ID2}`]);
  });

  it('a partial listing that omits the id, then returns it moved: the draft survives under the id key and the session re-opens in its new folder', async () => {
    const { sessions, wrapper } = await setup([row(ID1, '/work/a')]);
    const composer = useComposerStore();
    const key = composerKey();
    composer.states[key]!.draft = 'keep me';
    // reconnect / partial listing: the session is briefly absent from the host listing
    sessions.sessions = [row(ID2, '/work/x', 'other')];
    await flushPromises();
    expect(wrapper.findAll('.pane')).toHaveLength(0); // honest teardown: the host did not list it
    sessions.sessions = [row(ID1, '/work/b'), row(ID2, '/work/x', 'other')];
    await flushPromises();
    await wrapper.vm.$router.push({ name: 'folder', params: { name: 'h', folder: '/work/b' }, query: { tab: 'home-User' } });
    await flushPromises(); await nextTick();
    expect(wrapper.findAll('.pane').map((p) => p.attributes('data-key'))).toEqual([`aplexer:${ID1}`]);
    expect(composerKey()).toBe(key); // same id key even though the workspace changed meanwhile
    expect(composer.states[key]?.draft).toBe('keep me');
  });

  it('restores a legacy workspace-keyed composer draft onto the id key (one-time migration)', async () => {
    const composer = useComposerStore();
    const legacy = composer.targetKey('c1', 'home-User', sessionIdentityKey('home-User', { backend: 'aplexer', workspace: '/work/a' }));
    composer.ensure(legacy);
    composer.states[legacy]!.draft = 'half-typed';
    await setup([row(ID1, '/work/a')]);
    const k = composerKey();
    expect(k).toBe(`c1/aplexer:${ID1}`);
    expect(composer.states[k]?.draft).toBe('half-typed');
    expect(composer.states[legacy]).toBeUndefined();
  });

  it('restored tab after cd + restart: the id-keyed pane mounts in the session\'s CURRENT folder', async () => {
    // Persisted tab memory lives under the folder the user last had open; after a restart the
    // listing already reports the moved workspace. The tab is found in the folder that now holds it.
    localStorage.setItem('ps.lastFolder.h', '/work/b');
    const { wrapper } = await setup([row(ID1, '/work/b')], '/work/b');
    expect(wrapper.findAll('.pane').map((p) => p.attributes('data-key'))).toEqual([`aplexer:${ID1}`]);
  });
});

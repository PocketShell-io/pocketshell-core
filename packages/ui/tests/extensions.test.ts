// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import {
  dismissTopLayer,
  EXTENSION_SLOTS,
  extensionsFor,
  openDismissLayerCount,
  provideExtensions,
  registerDismissLayer,
  useDismissLayer,
  type AppExtensions,
} from '@ui/app/extensions';
import ExtensionSlot from '@ui/app/components/ExtensionSlot.vue';

/** A contributed component that shows which context it was handed. */
function chip(label: string) {
  return defineComponent({
    props: { context: { type: Object, required: false } },
    setup(props) {
      return () =>
        h('span', { class: 'chip', 'data-label': label }, `${label}:${(props.context as { tag?: string })?.tag ?? ''}`);
    },
  });
}

afterEach(() => {
  provideExtensions({});
  // Every test closes what it opened; a leak would bleed into the next one.
  expect(openDismissLayerCount()).toBe(0);
});

describe('extension registry', () => {
  it('names exactly the planned slots', () => {
    expect([...EXTENSION_SLOTS].sort()).toEqual(
      ['composer.accessory', 'composer.inputSources', 'settings.sections', 'terminal.dock', 'terminal.inputAdapter'].sort(),
    );
  });

  it('is empty for every slot until a platform provides something', () => {
    for (const slot of EXTENSION_SLOTS) expect(extensionsFor(slot)).toEqual([]);
  });

  it('returns contributions ordered by `order`, unordered ones after in their given order', () => {
    provideExtensions({
      'terminal.dock': [
        { id: 'c', component: chip('c') },
        { id: 'b', component: chip('b'), order: 2 },
        { id: 'd', component: chip('d') },
        { id: 'a', component: chip('a'), order: 1 },
      ],
    });
    expect(extensionsFor('terminal.dock').map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('replaces the whole set on a second call, like provideApi', () => {
    provideExtensions({ 'composer.accessory': [{ id: 'x', component: chip('x') }] });
    provideExtensions({ 'settings.sections': [{ id: 's', title: 'S', component: chip('s') }] });
    expect(extensionsFor('composer.accessory')).toEqual([]);
    expect(extensionsFor('settings.sections').map((e) => e.id)).toEqual(['s']);
  });

  it('refuses a duplicate id within a slot', () => {
    expect(() =>
      provideExtensions({
        'terminal.dock': [
          { id: 'keys', component: chip('1') },
          { id: 'keys', component: chip('2') },
        ],
      }),
    ).toThrow(/duplicate extension id "keys" in terminal\.dock/);
  });

  it('refuses an unknown slot name so a typo cannot silently drop a feature', () => {
    expect(() => provideExtensions({ 'terminal.dok': [] } as unknown as AppExtensions)).toThrow(
      /unknown extension slot: terminal\.dok/,
    );
  });

  it('refuses a contribution without an id', () => {
    expect(() => provideExtensions({ 'terminal.dock': [{ id: '', component: chip('x') }] })).toThrow(/has no id/);
  });
});

describe('<ExtensionSlot>', () => {
  it('renders NO element at all when the slot is empty', () => {
    const host = mount(
      defineComponent({
        setup: () => () => h('div', { class: 'host' }, [h(ExtensionSlot, { name: 'terminal.dock', context: {} })]),
      }),
    );
    const el = host.get('.host').element;
    expect(el.children).toHaveLength(0);
    expect(el.textContent).toBe('');
    expect(host.find('.ps-extension-slot').exists()).toBe(false);
  });

  it('renders each contribution in order with the slot context', () => {
    provideExtensions({
      'composer.accessory': [
        { id: 'two', component: chip('two'), order: 2 },
        { id: 'one', component: chip('one'), order: 1 },
      ],
    });
    const wrapper = mount(ExtensionSlot, { props: { name: 'composer.accessory', context: { tag: 'ctx' } } });
    const root = wrapper.get('[data-extension-slot="composer.accessory"]');
    expect(root.classes()).toContain('ps-extension-slot');
    expect(root.findAll('.chip').map((c) => c.text())).toEqual(['one:ctx', 'two:ctx']);
  });

  it('only renders its own slot', () => {
    provideExtensions({ 'composer.inputSources': [{ id: 'mic', component: chip('mic') }] });
    const wrapper = mount(ExtensionSlot, { props: { name: 'terminal.dock', context: {} } });
    expect(wrapper.find('.chip').exists()).toBe(false);
  });

  it('re-renders when the platform provides contributions after mount', async () => {
    const wrapper = mount(ExtensionSlot, { props: { name: 'terminal.dock', context: {} } });
    expect(wrapper.find('.ps-extension-slot').exists()).toBe(false);
    provideExtensions({ 'terminal.dock': [{ id: 'keys', component: chip('keys') }] });
    await nextTick();
    expect(wrapper.find('[data-label="keys"]').exists()).toBe(true);
    provideExtensions({});
    await nextTick();
    expect(wrapper.find('.ps-extension-slot').exists()).toBe(false);
  });
});

describe('app.dismissLayers', () => {
  it('reports false when no layer is open, so the gesture can fall through', () => {
    expect(openDismissLayerCount()).toBe(0);
    expect(dismissTopLayer()).toBe(false);
  });

  it('closes the most recently opened layer first', () => {
    const closed: string[] = [];
    const offOuter = registerDismissLayer(() => closed.push('outer'));
    const unregisterInner = registerDismissLayer(() => {
      closed.push('inner');
      unregisterInner();
    });
    expect(dismissTopLayer()).toBe(true);
    expect(closed).toEqual(['inner']);
    expect(openDismissLayerCount()).toBe(1);
    offOuter();
  });

  it('unregister is idempotent and removes only its own layer', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = registerDismissLayer(a);
    const offB = registerDismissLayer(b);
    offA();
    offA();
    expect(openDismissLayerCount()).toBe(1);
    dismissTopLayer();
    expect(b).toHaveBeenCalledOnce();
    expect(a).not.toHaveBeenCalled();
    offB();
  });

  it('useDismissLayer registers while mounted and unregisters on unmount', () => {
    const close = vi.fn();
    const Layer = defineComponent({
      setup() {
        useDismissLayer(close);
        return () => h('div');
      },
    });
    const wrapper = mount(Layer);
    expect(openDismissLayerCount()).toBe(1);
    expect(dismissTopLayer()).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    wrapper.unmount();
    expect(openDismissLayerCount()).toBe(0);
  });
});

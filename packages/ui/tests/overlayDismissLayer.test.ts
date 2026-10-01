// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import OverlayPanel from '@ui/app/components/OverlayPanel.vue';
import { dismissTopLayer, openDismissLayerCount } from '@ui/app/extensions';

describe('OverlayPanel as an app.dismissLayers layer', () => {
  it('registers while open, closes through the platform dismiss, and unregisters on close', () => {
    const wrapper = mount(OverlayPanel, { props: { title: 'Ports' }, attachTo: document.body });
    expect(openDismissLayerCount()).toBe(1);
    expect(dismissTopLayer()).toBe(true);
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
    expect(openDismissLayerCount()).toBe(0);
    expect(dismissTopLayer()).toBe(false);
  });

  it('closes the topmost of two stacked panels only', () => {
    const outer = mount(OverlayPanel, { props: { title: 'Usage' }, attachTo: document.body });
    const inner = mount(OverlayPanel, { props: { title: 'Confirm' }, attachTo: document.body });
    dismissTopLayer();
    expect(inner.emitted('close')).toHaveLength(1);
    expect(outer.emitted('close')).toBeUndefined();
    inner.unmount();
    outer.unmount();
  });
});

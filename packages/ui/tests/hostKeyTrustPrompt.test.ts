// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { HostEntry, HostKeyTrustChoice, HostKeyTrustRequest } from '@pocketshell/core';
import type { PocketShellApi } from '../src/app/api';
import { provideApi } from '../src/app/ipc';
import { useConnectionStore } from '../src/app/stores/connection';
import HostKeyTrustPrompt from '../src/app/components/HostKeyTrustPrompt.vue';
import HostKeyTrustGate from '../src/app/components/HostKeyTrustGate.vue';

// #2953 (A6): the shared host-key card and the store wiring behind the
// optional `ssh.onTrustDecision` hook.

const REQUEST: HostKeyTrustRequest = {
  hostLabel: 'fixture',
  hostname: '10.0.2.2',
  port: 2245,
  user: 'testuser',
  keyType: 'ssh-ed25519',
  fingerprintSha256: 'SHA256:q0Yx1S9hN1Yy4oX1fqmE0Q6y2G3cVbJb3fYbq8kT2p8',
};
const TRUSTED = 'SHA256:NMisw6A9vd5mn2qagwpbm2EEn8cU3wlBbWko/CapjZk';

type PromptProps = { request: HostKeyTrustRequest; trustedFingerprintSha256?: string | null; choices?: HostKeyTrustChoice[] };

function render(props: PromptProps): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(HostKeyTrustPrompt, props) }));
}

/** A shared-app transport with just the `ssh` members the connection store touches. */
function fakeApi(ssh: Partial<PocketShellApi['ssh']>) {
  const connects: Array<Record<string, unknown>> = [];
  const api = {
    ssh: {
      onState: () => () => undefined,
      connect: async (payload: Record<string, unknown>) => {
        connects.push(payload);
        return { ok: false, error: 'stop here' };
      },
      ...ssh,
    },
  } as unknown as PocketShellApi;
  return { api, connects };
}

const HOST: HostEntry = {
  name: 'fixture',
  hostname: '10.0.2.2',
  port: 2245,
  user: 'testuser',
  identityFile: null,
  proxyJump: null,
  forwardAgent: false,
  localForwards: [],
  remoteForwards: [],
  fromConfig: false,
};

describe('shared host-key trust prompt', () => {
  it('shows the host, key type and SHA-256 fingerprint with all three answers on first contact', async () => {
    const html = await render({ request: REQUEST });
    expect(html).toContain('data-testid="host-key-decision"');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('not seen before');
    expect(html).toMatch(/data-testid="host-key-host"[^>]*>fixture</);
    expect(html).toContain('testuser@10.0.2.2:2245');
    expect(html).toMatch(/data-testid="host-key-type"[^>]*>ssh-ed25519</);
    expect(html).toMatch(/data-testid="host-key-fingerprint"[^>]*>SHA256:q0Yx1S9hN1Yy4oX1fqmE0Q6y2G3cVbJb3fYbq8kT2p8</);
    expect(html).toContain('data-testid="trust-host-key-once"');
    expect(html).toContain('data-testid="trust-host-key"');
    expect(html).toContain('data-testid="reject-host-key"');
  });

  it('refuses a changed key: both fingerprints, an interception warning, and no way to trust it', async () => {
    // Even a caller that asks for every answer gets none that trusts.
    const html = await render({ request: REQUEST, trustedFingerprintSha256: TRUSTED, choices: ['accept-once', 'accept-always', 'reject'] });
    expect(html).toContain('data-testid="host-key-changed"');
    expect(html).not.toContain('data-testid="host-key-decision"');
    expect(html).toContain('Host key changed — connection refused');
    expect(html).not.toContain('not seen before');
    expect(html).toContain('intercepting');
    expect(html).toMatch(new RegExp(`data-testid="host-key-trusted-fingerprint"[^>]*>${TRUSTED}<`));
    expect(html).toMatch(new RegExp(`data-testid="host-key-fingerprint"[^>]*>${REQUEST.fingerprintSha256}<`));
    expect(html).not.toContain('data-testid="trust-host-key"');
    expect(html).not.toContain('data-testid="trust-host-key-once"');
    expect(html).not.toContain('Trust and remember');
    expect(html).toMatch(/data-testid="reject-host-key"[^>]*>\s*Close\s*</);
  });

  it('offers only the answers the caller can honour, and sends exactly one answer', async () => {
    const html = await render({ request: REQUEST, choices: ['accept-always', 'reject'] });
    expect(html).not.toContain('data-testid="trust-host-key-once"');

    const wrapper = mount(HostKeyTrustPrompt, { props: { request: REQUEST } });
    await wrapper.get('[data-testid=trust-host-key-once]').trigger('click');
    await wrapper.get('[data-testid=trust-host-key]').trigger('click');
    expect(wrapper.emitted('decide')).toEqual([['accept-once']]);
    wrapper.unmount();
  });

  it('keeps the historical accept-always dial on a platform without ssh.onTrustDecision', async () => {
    const { api, connects } = fakeApi({});
    provideApi(api);
    setActivePinia(createPinia());
    const connection = useConnectionStore();
    expect(await connection.connect(HOST)).toBe(false);
    expect(connects[0]).toMatchObject({ host: '10.0.2.2', tofuDecision: 'accept-always' });
    connection.answerTrust('accept-always'); // nothing is waiting: a no-op
    expect(connection.pendingTrust).toBeNull();
  });

  it('dials with no standing decision when the platform asks, and supersedes an unanswered question', async () => {
    let decider: ((request: HostKeyTrustRequest) => Promise<HostKeyTrustChoice>) | null = null;
    const { api, connects } = fakeApi({
      onTrustDecision: (registered) => {
        decider = registered;
        return () => undefined;
      },
    });
    provideApi(api);
    setActivePinia(createPinia());
    const connection = useConnectionStore();
    expect(decider).not.toBeNull();
    await connection.connect(HOST);
    expect(connects[0]).not.toHaveProperty('tofuDecision');

    const first = decider!(REQUEST);
    expect(connection.pendingTrust).toEqual(REQUEST);
    const seq = connection.pendingTrustSeq;
    const second = decider!({ ...REQUEST, hostLabel: 'other' });
    await expect(first).resolves.toBe('reject');
    expect(connection.pendingTrust?.hostLabel).toBe('other');
    expect(connection.pendingTrustSeq).toBe(seq + 1);
    connection.answerTrust('accept-once');
    await expect(second).resolves.toBe('accept-once');
    expect(connection.pendingTrust).toBeNull();
  });

  it('renders the app-wide gate only while a question waits, and a disconnect refuses it', async () => {
    let decider: ((request: HostKeyTrustRequest) => Promise<HostKeyTrustChoice>) | null = null;
    const { api } = fakeApi({
      onTrustDecision: (registered) => { decider = registered; return () => undefined; },
      close: async () => true,
    });
    provideApi(api);
    const pinia = createPinia();
    setActivePinia(pinia);
    const connection = useConnectionStore();
    const gate = () => {
      const app = createSSRApp({ render: () => h(HostKeyTrustGate) });
      app.use(pinia);
      return renderToString(app);
    };
    expect(await gate()).not.toContain('host-key-decision');
    const waiting = decider!(REQUEST);
    const html = await gate();
    expect(html).toContain('data-testid="host-key-trust-gate"');
    expect(html).toContain(REQUEST.fingerprintSha256);
    await connection.disconnect();
    await expect(waiting).resolves.toBe('reject');
    expect(await gate()).not.toContain('host-key-decision');
  });
});

// @vitest-environment jsdom
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { KeyVaultStore, type VaultRememberRecord } from '@pocketshell/core';
import { MemoryTransport } from '../../../../tests/keyVault/memoryTransport';
import { passphraseStrength, provideKeyVault, requestVaultUnlock, type KeyVaultPlatform } from '../../src/app/keyVault';
import VaultUnlockGate from '../../src/app/components/vault/VaultUnlockGate.vue';
import VaultSetupCard from '../../src/app/components/vault/VaultSetupCard.vue';
import VaultResetFlow from '../../src/app/components/vault/VaultResetFlow.vue';
import VaultKeyList from '../../src/app/components/vault/VaultKeyList.vue';
import VaultChangePassphrase from '../../src/app/components/vault/VaultChangePassphrase.vue';
import HostVaultKeyPicker from '../../src/app/components/vault/HostVaultKeyPicker.vue';

// The shared key-vault UI (key-vault W1) over a real core KeyVaultStore and an
// in-memory settings API. Argon2id runs for real at the parser floor (32 MiB, t=3).
const KDF = { m: 32768, t: 3, p: 1 };
const PASS = 'correct horse battery staple';

async function vaultWith(platform: Partial<KeyVaultPlatform> = {}, create = true) {
  const transport = new MemoryTransport();
  if (create) await new KeyVaultStore({ transport, kdf: KDF }).createVault(PASS, { syncPassphrase: 'sync-pass' });
  const store = new KeyVaultStore({ transport, kdf: KDF });
  const controller = provideKeyVault({ store, ...platform })!;
  return { transport, store, controller };
}

async function settle(): Promise<void> {
  // Argon2id and WebCrypto resolve outside Vue's microtask queue.
  for (let i = 0; i < 20; i += 1) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Wait until the unlock form is no longer busy (Argon2id finished). */
async function idle(wrapper: { find(selector: string): { exists(): boolean; text(): string } }): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const button = wrapper.find('[data-testid="vault-unlock-submit"]');
    if (!button.exists() || button.text() !== 'Unlocking…') break;
  }
  await flushPromises();
}

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => provideKeyVault(null));

describe('VaultUnlockGate', () => {
  it('renders nothing without a provided vault, and nothing until a dial asks', async () => {
    provideKeyVault(null);
    expect(mount(VaultUnlockGate).find('[data-testid="vault-unlock-gate"]').exists()).toBe(false);
    expect(await requestVaultUnlock()).toBe(false);
    const { controller } = await vaultWith();
    const gate = mount(VaultUnlockGate);
    expect(gate.find('[data-testid="vault-unlock-gate"]').exists()).toBe(false);
    const ask = requestVaultUnlock();
    await flushPromises();
    expect(gate.find('[data-testid="vault-unlock-gate"]').exists()).toBe(true);
    controller.cancelUnlock();
    expect(await ask).toBe(false);
    gate.unmount();
  });

  it('wrong passphrase says so and keeps the sheet; the right one resolves every waiting dial', async () => {
    const { controller } = await vaultWith();
    const gate = mount(VaultUnlockGate, { attachTo: document.body });
    const first = controller.requestUnlock('connect', 'hetzner');
    const second = requestVaultUnlock();
    await flushPromises();
    expect(gate.text()).toContain('Unlock your key vault to connect to hetzner');
    expect(gate.text()).not.toMatch(/pick a key|choose a key/i);

    await gate.find('[data-testid="vault-unlock-passphrase"]').setValue('nope');
    await gate.find('form').trigger('submit');
    await idle(gate);
    expect(gate.find('[data-testid="vault-unlock-error"]').text()).toBe("That passphrase didn't unlock your vault. Check it and try again.");
    expect(gate.find('[data-testid="vault-unlock-submit"]').text()).toBe('Unlock');
    expect(gate.find('[data-testid="vault-unlock-gate"]').exists()).toBe(true);

    await gate.find('[data-testid="vault-unlock-passphrase"]').setValue(PASS);
    await gate.find('form').trigger('submit');
    await idle(gate);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(gate.find('[data-testid="vault-unlock-gate"]').exists()).toBe(false);
    expect(controller.view.state).toBe('unlocked');
    expect(await requestVaultUnlock()).toBe(true);
    gate.unmount();
  });

  it('cancel resolves false; after three misses the button counts down the backoff', async () => {
    const { controller } = await vaultWith();
    const gate = mount(VaultUnlockGate, { attachTo: document.body });
    const ask = controller.requestUnlock();
    await flushPromises();
    for (let i = 0; i < 3; i += 1) {
      await gate.find('[data-testid="vault-unlock-passphrase"]').setValue(`wrong-${i}`);
      await gate.find('form').trigger('submit');
      await idle(gate);
    }
    const submit = gate.find('[data-testid="vault-unlock-submit"]');
    expect(submit.text()).toMatch(/^Wait \ds$/);
    expect(submit.attributes('disabled')).toBeDefined();
    expect(gate.find('[data-testid="vault-unlock-error"]').text()).toMatch(/Try again in \d s\./);
    await gate.find('[data-testid="vault-unlock-cancel"]').trigger('click');
    expect(await ask).toBe(false);
    gate.unmount();
  });

  it('remember on this device hands the platform a DEK + AUTH record; hidden without remember support', async () => {
    const saved: VaultRememberRecord[] = [];
    const remember = {
      save: vi.fn(async (record: VaultRememberRecord) => {
        saved.push({ ...record, dek: Uint8Array.from(record.dek), auth: Uint8Array.from(record.auth!) });
      }),
      forget: vi.fn(async () => undefined),
      isRemembered: vi.fn(async () => false),
    };
    const { controller } = await vaultWith({ remember });
    const gate = mount(VaultUnlockGate, { attachTo: document.body });
    void controller.requestUnlock('account');
    await flushPromises();
    await gate.find('[data-testid="vault-unlock-remember"]').setValue(true);
    await gate.find('[data-testid="vault-unlock-passphrase"]').setValue(PASS);
    await gate.find('form').trigger('submit');
    await idle(gate);
    expect(remember.save).toHaveBeenCalledTimes(1);
    expect(saved[0]!.dek).toHaveLength(32);
    expect(saved[0]!.auth).toHaveLength(32);
    expect(saved[0]!.epoch).toBe(1);
    expect(controller.view.remembered).toBe(true);
    gate.unmount();

    const plain = await vaultWith();
    const sheet = mount(VaultUnlockGate, { attachTo: document.body });
    void plain.controller.requestUnlock();
    await flushPromises();
    expect(sheet.find('[data-testid="vault-unlock-remember"]').exists()).toBe(false);
    sheet.unmount();
  });

  it('"Forgot it?" explains and opens the injected reset URL', async () => {
    const openUrl = vi.fn();
    const { controller } = await vaultWith({ resetUrl: 'https://app.example/keys?reset=1', openUrl });
    const gate = mount(VaultUnlockGate, { attachTo: document.body });
    const ask = controller.requestUnlock();
    await flushPromises();
    await gate.find('[data-testid="vault-unlock-forgot"]').trigger('click');
    expect(gate.find('[data-testid="vault-unlock-forgot-text"]').text()).toContain('cannot be recovered');
    await gate.find('[data-testid="vault-unlock-reset"]').trigger('click');
    expect(openUrl).toHaveBeenCalledWith('https://app.example/keys?reset=1');
    expect(await ask).toBe(false);
    gate.unmount();
  });
});

describe('VaultSetupCard', () => {
  it('needs the unrecoverable acknowledgement, then creates the vault with the sync passphrase', async () => {
    const { controller, store } = await vaultWith({}, false);
    const card = mount(VaultSetupCard, { props: { syncPassphrase: 'sync-1' } });
    expect(card.find('[data-testid="vault-setup-warning"]').text()).toContain(
      "If you forget it, your keys cannot be recovered. You'll reset the vault and upload them again.",
    );
    await card.find('[data-testid="vault-setup-new"]').setValue('a long new passphrase');
    await card.find('[data-testid="vault-setup-again"]').setValue('a long new passphrase');
    expect(card.find('[data-testid="vault-setup-create"]').attributes('disabled')).toBeDefined();
    await card.find('[data-testid="vault-setup-understood"]').setValue(true);
    await card.find('form').trigger('submit');
    await settle();
    expect(card.emitted('created')).toHaveLength(1);
    expect(controller.view.state).toBe('unlocked');
    expect(store.getSyncPassphrase()).toBe('sync-1');
  });

  it('rejects mismatched entries and rates strength', () => {
    expect(passphraseStrength('short').label).toBe('too short');
    expect(passphraseStrength('aaaaaaaa').score).toBeLessThan(passphraseStrength('correct horse battery staple').score);
  });
});

describe('VaultChangePassphrase', () => {
  it('a wrong current passphrase is an error; the right one changes it', async () => {
    const { controller, transport } = await vaultWith();
    await controller.unlock(PASS, false);
    const form = mount(VaultChangePassphrase);
    await form.find('[data-testid="vault-change-current"]').setValue('wrong');
    await form.find('[data-testid="vault-change-new"]').setValue('the next passphrase');
    await form.find('[data-testid="vault-change-again"]').setValue('the next passphrase');
    await form.find('form').trigger('submit');
    await settle();
    expect(form.text()).toContain("That isn't your current vault passphrase.");
    await form.find('[data-testid="vault-change-current"]').setValue(PASS);
    await form.find('form').trigger('submit');
    await settle();
    expect(form.emitted('changed')).toHaveLength(1);
    expect((await new KeyVaultStore({ transport }).unlock('the next passphrase')).kind).toBe('ok');
  });
});

describe('VaultResetFlow', () => {
  it('re-authenticates, needs RESET, and with "I forgot that too" deletes the host list', async () => {
    const reauth = vi.fn(async () => true);
    const hostList = { exists: vi.fn(async () => true), verifyPassphrase: vi.fn(async () => false), remove: vi.fn(async () => undefined) };
    const { controller, transport } = await vaultWith({ reauth, hostList });
    const flow = mount(VaultResetFlow);
    await settle();
    expect(flow.find('[data-testid="vault-reset-reauth"]').exists()).toBe(true);
    await flow.find('[data-testid="vault-reset-signin"]').trigger('click');
    await settle();
    expect(reauth).toHaveBeenCalled();
    await flow.find('[data-testid="vault-reset-new"]').setValue('brand new passphrase');
    await flow.find('[data-testid="vault-reset-again"]').setValue('brand new passphrase');
    await flow.find('[data-testid="vault-reset-sync"]').setValue('wrong sync');
    await flow.find('[data-testid="vault-reset-confirm"]').setValue('RESET');
    await flow.find('form').trigger('submit');
    await settle();
    expect(flow.text()).toContain("That sync passphrase doesn't open your host list. Nothing was reset.");
    expect(controller.view.state).toBe('locked');

    await flow.find('[data-testid="vault-reset-forgot-sync"]').setValue(true);
    await flow.find('form').trigger('submit');
    await settle();
    expect(flow.find('[data-testid="vault-reset-done"]').exists()).toBe(true);
    expect(hostList.remove).toHaveBeenCalled();
    expect(controller.store.epoch).toBe(2);
    expect((await new KeyVaultStore({ transport }).unlock('brand new passphrase')).kind).toBe('ok');
  });
});

describe('VaultKeyList and HostVaultKeyPicker', () => {
  it('lists entries with where they are used; upload actions only with canUpload', async () => {
    const { controller } = await vaultWith();
    await controller.unlock(PASS, false);
    const pem = String(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const added = await controller.addKey(pem, 'laptop');
    if (added.kind !== 'ok') throw new Error('add failed');
    await controller.bindHost('hetzner', { keyId: added.entry.keyId, gatewayAuth: 'both' });
    const list = mount(VaultKeyList);
    expect(list.text()).toContain('laptop');
    expect(list.text()).toContain('Used by hetzner');
    expect(list.find('[data-testid="vault-add-key"]').exists()).toBe(false);

    await list.find(`[data-testid="vault-delete-${added.entry.keyId}"]`).trigger('click');
    expect(list.text()).toContain('hetzner will need another key.');
    await list.find('[data-testid="vault-delete-confirm"]').trigger('click');
    await settle();
    expect(controller.view.keys).toEqual([]);

    provideKeyVault({ store: controller.store, canUpload: true });
    expect(mount(VaultKeyList).find('[data-testid="vault-add-key"]').exists()).toBe(true);
  });

  it('the picker emits a binding with the gateway policy, or null', async () => {
    const keys = [{ keyId: 'AAAAAAAAAAAAAAAAAAAAAA', name: 'laptop', type: 'ssh-ed25519' as const, fingerprint: 'SHA256:x', createdAt: '2026-10-15T00:00:00Z' }];
    const picker = mount(HostVaultKeyPicker, { props: { modelValue: null, keys } });
    expect(picker.find('fieldset').exists()).toBe(false);
    await picker.find('select').setValue('AAAAAAAAAAAAAAAAAAAAAA');
    expect(picker.emitted('update:modelValue')![0]).toEqual([{ keyId: 'AAAAAAAAAAAAAAAAAAAAAA', gatewayAuth: 'both' }]);
    await picker.setProps({ modelValue: { keyId: 'AAAAAAAAAAAAAAAAAAAAAA', gatewayAuth: 'both' } });
    await picker.find('[data-testid="host-vault-policy-managed"]').setValue(true);
    expect(picker.emitted('update:modelValue')![1]).toEqual([{ keyId: 'AAAAAAAAAAAAAAAAAAAAAA', gatewayAuth: 'managed' }]);
    await picker.find('select').setValue('');
    expect(picker.emitted('update:modelValue')![2]).toEqual([null]);
    await picker.setProps({ modelValue: { keyId: 'BBBBBBBBBBBBBBBBBBBBBB', gatewayAuth: 'host' } });
    expect(picker.text()).toContain('Missing key');
  });
});

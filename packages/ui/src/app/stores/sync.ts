import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import { useConnectionStore } from './connection';
import { useSettingsStore } from './settings';
import {
  applyAccountToSelection,
  parseSyncPayload,
  runSyncRound,
  type SyncRoundResult,
} from '@pocketshell/core';
import { SYNC_SLOT } from '@pocketshell/core';
import type { SyncStatus } from '@pocketshell/core';
import type { HostEntry } from '@pocketshell/core';

/**
 * The Account & sync section's model.
 *
 * Login state lives in MAIN (safeStorage-protected token file); this store
 * holds only what the UI renders — the status answer, one in-flight flag,
 * and the last outcome. The ONE thing this store owns persistently is
 * nothing: the sync passphrase lives in a plain ref, in memory, for the
 * session. It is deliberately NOT in the settings store / localStorage, for
 * the same reason it is not sent to the server — writing it to disk would
 * undo the zero-knowledge property the whole design is built on. A user who
 * syncs again after a relaunch types it again, which the section says out
 * loud.
 *
 * WHICH hosts sync is the settings store's `syncSelectedHosts`, persisted
 * per machine — persisting the selection is the opposite trade from the
 * passphrase: a forgotten selection is the dangerous direction, since a
 * relaunch that reset every tick to off would let an innocent "Sync now"
 * push an empty list and wipe the account. Beside it, `syncUntickedHosts`
 * persists the user's explicit unticks.
 *
 * The tick rule is core's and the same on every client (pocketshell#3072):
 * every account host stays selected unless the user explicitly unticked it.
 * Every way this store learns the account — Check account, the platform's
 * session cache, each pull of a sync round — applies it, so the Account view
 * never shows "remove on sync" for a host the user did not untick, and an
 * untouched Sync now never removes a host from the account.
 *
 * `syncNow` is the whole feature in one action: core's `runSyncRound` pulls
 * the account, absorbs its aliases into the selection (a sync never silently
 * drops another machine's hosts), assembles the ticked set (local entry when
 * the config has the alias, the account's when it does not) and pushes; a
 * 409 from a concurrent writer is re-based and retried, and each retry
 * re-absorbs, so it cannot compound. This store only supplies the api
 * effects, mirrors each pull into the account copy and the persisted
 * selection, and afterwards adds anything the config file is missing.
 */

export interface SyncMessage {
  kind: 'ok' | 'error';
  text: string;
}

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncStatus | null>(null);
  /** The last account contents read with the current passphrase, or unknown. */
  const accountHosts = ref<HostEntry[] | null>(null);
  const passphrase = ref('');
  const busy = ref(false);
  const message = ref<SyncMessage | null>(null);

  async function refreshStatus(): Promise<void> {
    status.value = await api.sync.status();
    if (!status.value.loggedIn) {
      accountHosts.value = null;
      return;
    }
    // Signed in: seed the account copy from main's session cache when this
    // window has not decrypted one itself. That is what lets the host picker
    // (which never sees the passphrase) show the account's hosts once any
    // window — usually the Account window's Check account or Sync now — has
    // decrypted them this session. A copy pulled HERE is fresher than the
    // cache, so it is never overwritten.
    if (accountHosts.value === null) {
      const cached = await api.sync.accountHosts().catch(() => null);
      if (cached !== null) absorbAccount(cached);
    }
  }

  /** Read the account so the Account window can distinguish synced hosts. */
  async function loadAccount(): Promise<void> {
    if (busy.value) return;
    if (!status.value?.loggedIn) {
      message.value = { kind: 'error', text: 'Sign in first.' };
      return;
    }
    if (passphrase.value === '') {
      message.value = { kind: 'error', text: 'Enter your sync passphrase.' };
      return;
    }
    busy.value = true;
    message.value = null;
    try {
      const pulled = await api.sync.pull(SYNC_SLOT, passphrase.value);
      if (pulled.kind === 'absent') {
        accountHosts.value = [];
        message.value = { kind: 'ok', text: 'Your account has no synced hosts yet.' };
        return;
      }
      const remote = parseSyncPayload(pulled.plaintext);
      absorbAccount(remote);
      message.value = {
        kind: 'ok',
        text: `Your account has ${remote.length} synced host${remote.length === 1 ? '' : 's'}.`,
      };
    } catch (err) {
      message.value = { kind: 'error', text: (err as Error).message };
    } finally {
      busy.value = false;
    }
  }

  /**
   * Tick or untick one alias — the user's explicit decision. Unticked hosts
   * never leave this machine, and an untick is the one thing that removes a
   * host from the account on the next sync, so it is persisted
   * (`syncUntickedHosts`) and survives a restart; ticking again cancels it.
   */
  function setSelected(alias: string, selected: boolean): void {
    const settings = useSettingsStore();
    const has = settings.syncSelectedHosts.includes(alias);
    const unticked = settings.syncUntickedHosts.includes(alias);
    if (selected && unticked) {
      settings.syncUntickedHosts = settings.syncUntickedHosts.filter((name) => name !== alias);
    } else if (!selected && !unticked) {
      settings.syncUntickedHosts = [...settings.syncUntickedHosts, alias];
    }
    // A redundant tick must not MOVE the alias: the list's order is the
    // user's, and a re-click on an already-ticked box is not a reorder.
    if (selected === has) return;
    const rest = settings.syncSelectedHosts.filter((name) => name !== alias);
    settings.syncSelectedHosts = selected ? [...rest, alias] : rest;
  }

  /**
   * Show an account copy and apply core's tick rule to it
   * ({@link applyAccountToSelection}): every account alias the user has not
   * explicitly unticked joins the selection, and unticks the account no
   * longer needs are spent.
   */
  function absorbAccount(remote: HostEntry[]): void {
    accountHosts.value = remote;
    persistSelection(applyAccountToSelection(remote, selectionState()));
  }

  function selectionState(): { checked: string[]; unticked: string[] } {
    const settings = useSettingsStore();
    return { checked: settings.syncSelectedHosts, unticked: settings.syncUntickedHosts };
  }

  /** Write a selection back, touching only what changed. */
  function persistSelection(next: { checked: readonly string[]; unticked: readonly string[] }): void {
    const settings = useSettingsStore();
    const current = settings.syncSelectedHosts;
    // Keep the user's order; append the newly ticked aliases.
    const added = next.checked.filter((alias) => !current.includes(alias));
    if (added.length > 0) settings.syncSelectedHosts = [...current, ...added];
    const unticked = [...next.unticked];
    if (unticked.length !== settings.syncUntickedHosts.length
      || unticked.some((alias, index) => settings.syncUntickedHosts[index] !== alias)) {
      settings.syncUntickedHosts = unticked;
    }
  }

  async function login(): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    message.value = null;
    try {
      const email = await api.sync.login();
      await refreshStatus();
      message.value = { kind: 'ok', text: `Signed in as ${email ?? 'your Google account'}.` };
    } catch (err) {
      message.value = { kind: 'error', text: (err as Error).message };
    } finally {
      busy.value = false;
    }
  }

  async function logout(): Promise<void> {
    busy.value = true;
    try {
      await api.sync.logout();
      passphrase.value = '';
      accountHosts.value = null;
      // The next account starts with every host kept: an untick belonged to
      // this account, and forgetting one can only keep a host, never drop it.
      useSettingsStore().syncUntickedHosts = [];
      message.value = null;
      await refreshStatus();
    } finally {
      busy.value = false;
    }
  }

  async function syncNow(): Promise<void> {
    if (busy.value) return;
    if (!status.value?.loggedIn) {
      message.value = { kind: 'error', text: 'Sign in first.' };
      return;
    }
    if (passphrase.value === '') {
      message.value = { kind: 'error', text: 'Enter your sync passphrase.' };
      return;
    }
    const connection = useConnectionStore();
    const settings = useSettingsStore();
    busy.value = true;
    message.value = null;
    try {
      // One shared round (pull → absorb → assemble → push, 409 re-base and
      // retry). A wrong passphrase rejects the pull with SyncCryptoError's
      // message — that IS the user feedback. Every pull, including a re-pull
      // after a 409, refreshes the account copy and persists the auto-ticked
      // aliases.
      let pulls = 0;
      const result = await runSyncRound(connection.hosts, selectionState(), {
        async pull() {
          pulls += 1;
          const pulled = await api.sync.pull(SYNC_SLOT, passphrase.value);
          // A re-pull after a 409 that finds no account at all means the
          // account was cleared mid-sync: stop rather than re-create it.
          if (pulls > 1 && pulled.kind !== 'ok') throw new Error('the account changed while syncing — try again');
          return pulled;
        },
        // The account API's conflict base for a fresh (absent) account is 0.
        push: ({ baseVersion, plaintext }) =>
          api.sync.push(SYNC_SLOT, plaintext, passphrase.value, baseVersion ?? 0),
        onPulled({ hosts, selectedAliases, untickedAliases }) {
          accountHosts.value = hosts as HostEntry[];
          persistSelection({ checked: selectedAliases, unticked: untickedAliases });
        },
      });
      if (result.kind !== 'synced') {
        message.value = { kind: 'error', text: syncFailureText(result, settings.syncSelectedHosts.length) };
        return;
      }
      // The synced set IS the payload: the ticked hosts, local entry first.
      const set = result.hosts as HostEntry[];
      accountHosts.value = set;

      // Restore path: the synced set is offered to main, which appends
      // whatever ~/.ssh/config is actually missing (it re-checks against the
      // FILE, not this list — a host hand-added since loadHosts is never
      // duplicated).
      const applied = await api.sync.applyHosts(set);
      await connection.loadHosts();

      const total = set.length;
      const parts: string[] = [`${total} host${total === 1 ? '' : 's'} in your account`];
      if (applied.added.length > 0) parts.push(`added ${applied.added.length} to ~/.ssh/config`);
      message.value = { kind: 'ok', text: `Synced: ${parts.join(', ')}.` };
    } catch (err) {
      message.value = { kind: 'error', text: (err as Error).message };
    } finally {
      busy.value = false;
    }
  }

  return {
    status,
    accountHosts,
    passphrase,
    busy,
    message,
    refreshStatus,
    loadAccount,
    setSelected,
    login,
    logout,
    syncNow,
  };
});

/** The one sentence for each way a sync round stops short of `synced`. */
function syncFailureText(
  result: Exclude<SyncRoundResult, { kind: 'synced' }>,
  selectedCount: number,
): string {
  switch (result.kind) {
    case 'empty-selection':
      return selectedCount === 0
        ? 'Tick at least one host to sync.'
        : 'None of the ticked hosts exists here or in the account.';
    case 'error':
      return result.message;
    case 'conflict-limit':
      return 'the account kept changing — try again in a moment';
    case 'invalid-payload':
      return 'The account holds sync data this version cannot read, so nothing was uploaded.';
  }
}

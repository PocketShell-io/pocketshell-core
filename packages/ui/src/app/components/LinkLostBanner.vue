<script setup lang="ts">
// LinkLostBanner: the workspace's lost-link strip, extracted whole from
// HostWorkspaceView — not as a tidy-up but as a design-gate payment (the
// same door useQuickActions left through): the view sits under CLEAN_CODE's
// 1000-line cap, and this strip is a self-contained surface with its own
// state, its own arc, and no callers inside the view's logic.
//
// The banner's own memory of the re-dial it started. The connection store
// already knows everything about the DROP — its `ssh.onState` subscription
// flips `state` to 'lost' and stocks `error` — but until this banner
// existed no view rendered any of it, so the terminal froze, the file
// browser listed nothing, and the session panel's poll surfaced a raw IPC
// rejection ("Unknown connection: …") as the only clue. The store's own
// comment promised "the state flag is enough for the UI to say the link is
// gone and offer reconnect"; this is that UI.
//
// A local ref on top of the store's state, because the store's `state`
// alone cannot keep the banner up for the whole recovery arc: pressing
// Reconnect moves it to 'connecting' (no longer 'lost'), and a FAILED
// re-dial lands on 'idle' — the same value a fresh app has. A banner gated
// purely on `state === 'lost'` would therefore vanish the moment the
// button was pressed and stay gone after a failure, which is precisely
// when the user needs the error and a pressable button most. So the banner
// shows while the state is 'lost' OR while a re-dial this banner started
// is unresolved or failed, and only a re-dial that actually lands clears
// it.
import { computed, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { useConnectionStore } from '../stores/connection';
import { MAX_ATTEMPTS } from '@pocketshell/core/shared/reconnectBackoff';
import { linkDownText, transportRetryText } from '../linkLostText';

const connection = useConnectionStore();

/** The lost-link banner's own memory of the re-dial it started. */
const redial = ref<'none' | 'inflight' | 'failed'>('none');

/**
 * The banner is up for the whole arc: drop, attempt, failure.
 *
 * `connection.recovering` covers the AUTOMATIC half the store now drives:
 * a scheduled retry sits at state 'connecting' while it is
 * on the wire with `redial` still 'none', and without this the strip would
 * blink off during every dial it did not start.
 */
const linkLost = computed(
  () => connection.state === 'lost' || redial.value !== 'none' || connection.recovering,
);

/** True while a re-dial is on the wire (a recovery-owning transport's ladder included). */
const reconnecting = computed(() => connection.state === 'connecting' || connection.transportRetry !== null);

/** True while the store's automatic retry is scheduled — the button is "Retry now". */
const autoRetrying = computed(() => connection.autoRetry !== null);

/**
 * What the strip says while a retry is scheduled. Names the host, where in
 * the curve the FSM is, and when the next dial goes out — the countdown the
 * backoff's `retryAtEpochMs` was designed for.
 */
const autoRetryText = computed(() => {
  const host = connection.activeHost?.name ?? 'the host';
  return (
    `Lost the connection to ${host}. Retrying automatically — attempt ` +
    `${connection.autoRetry?.attempt ?? 0} of ${MAX_ATTEMPTS} starts in ` +
    `${connection.retryIn}s.`
  );
});

/**
 * Re-dial the host through the store. The store's `reconnect()` wakes the
 * surfaces that went stale with the dead id — sessions refresh, forwards
 * re-init — so recovery is identical whether the user pressed this or the
 * FSM dialled on its own schedule; this handler only manages the banner.
 *
 * On failure the store has already written `connection.error` (connect() sets
 * it before resolving false), so all that is left here is to keep the banner
 * standing and re-arm the button.
 */
async function onReconnect(): Promise<void> {
  redial.value = 'inflight';
  const ok = await connection.reconnect();
  if (ok) {
    // Drop the banner — the link is back. (The store's surface recovery is
    // awaited inside reconnect(); by the time this resolves it is done or
    // failed soft, and neither is worth an error-toned strip.)
    redial.value = 'none';
  } else {
    redial.value = 'failed';
  }
}

/** The button during a countdown: skip the wait and dial now. */
function onRetryNow(): void {
  void connection.retryNow();
}

/**
 * What the strip says: a recovery-owning transport's ladder, the store's
 * countdown, a failed re-dial's own error (never a stale "connection lost"
 * over a fresher failure), else the standing sentence naming the frozen
 * surfaces ("did my session die?" — no, the LINK did).
 */
const linkLostText = computed(() => {
  if (connection.transportRetry) return transportRetryText(connection.activeHost?.name, connection.transportRetry);
  if (autoRetrying.value) return autoRetryText.value;
  if (redial.value === 'failed') return connection.error ?? 'Reconnect failed';
  const reason = connection.transportOwnsRecovery && connection.error !== 'Connection lost' ? connection.error : null;
  return linkDownText(connection.activeHost?.name, reason);
});
</script>

<template>
  <!-- Error-toned and a strip rather than a modal on purpose: the scrollback
       in the frozen panes is still worth reading — the store keeps
       `connectionId` alive through 'lost' precisely so those panes stay
       mounted — and a dialog would sit on top of the very thing the user
       wants to look at while deciding whether to reconnect. It carries the
       ONE recovery action right where the symptom is — before this, the
       only route back was guessing to navigate to hosts and reconnect by
       hand. -->
  <p v-if="linkLost" class="link-lost">
    <AppIcon name="alert-triangle" :size="14" />
    <span class="link-lost-text">{{ linkLostText }}</span>
    <button
      class="reconnect-btn"
      :disabled="reconnecting"
      @click="autoRetrying ? onRetryNow() : onReconnect()"
    >
      {{ reconnecting ? 'Reconnecting…' : autoRetrying ? 'Retry now' : 'Reconnect' }}
    </button>
  </p>
</template>

<style scoped>
.link-lost {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  color: var(--error);
  background: var(--error-soft);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
}
/* The text takes the slack so the button keeps its place at the right edge —
   the strip's message changes length (lost sentence vs. a failure reason) and
   the one control must not wander with it. */
.link-lost-text {
  flex: 1;
  min-width: 0;
}
/* Solid error, like the stop-confirm's danger button: this is the strip's one
   action and the whole reason it exists, so it must not read as a tinted
   afterthought beside its own message. */
.reconnect-btn {
  flex: 0 0 auto;
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  padding: 0 var(--sp-4);
  border-radius: var(--r-md);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-200);
  font-weight: var(--fw-semibold);
  background: var(--error);
  border: 1px solid var(--error);
  color: var(--on-accent);
  transition: opacity var(--dur-fast) var(--ease);
}
.reconnect-btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
</style>

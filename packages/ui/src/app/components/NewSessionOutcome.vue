<script setup lang="ts">
// NewSessionOutcome: the answers that are NOT simply "yes".
//
// A create that works never renders this panel — the commit emitted `started`
// and the dialog is already unmounting, on the ground that success is not
// news, it is the thing that was asked for. What renders here is the rest:
// a failure, or the raw-`tmux` create whose warning is the reason it holds.
// Two of the answers cannot be read off the session row afterwards:
// `via: 'tmux-fallback'` means the session was created WITHOUT a memory cap,
// and `code: 'folder-missing'` guards a real helper trap where a `-c` at a
// missing directory exits 0 and silently lands the pane in `$HOME`. Both are
// worth a sentence, so the dialog stays put, says it, and the user presses
// Open (or goes round again) having read it.
//
// Extracted from NewSessionDialog.vue under CLEAN_CODE rule 12, when the
// editable session name pushed that file over the component gate. The picker
// it sits beside did not get smaller because this panel was unimportant, but
// because it was separable: it reads one result and offers two buttons, and
// shares nothing with the browsing around it.
import AppIcon from '@ui/components/AppIcon.vue';
import { KIND_LABELS } from '@pocketshell/core';
import type { LaunchChoice, StartSessionResult } from '@pocketshell/core';
import { displayPath, useProjectsStore } from '../stores/projects';

defineProps<{
  /** The host's answer, kept on screen until the user acts on it. */
  outcome: StartSessionResult;
  /**
   * The agent parked for the session named in the banner, if any. Held only
   * so the banner can say what will happen next; the launch itself is in
   * `pendingAgentLaunch`.
   */
  parkedKind: LaunchChoice['kind'] | null;
}>();

const emit = defineEmits<{
  /** Open the session named in the banner. */
  open: [];
  /** Clear the banner and go round again. */
  again: [];
}>();

const projects = useProjectsStore();
</script>
<template>
  <!-- Only the answers that are not simply "yes" get this far. `reused` is
       not among them and never was from the dialog that mounts this: that
       dialog asks for `unique`, which walks `-2`, `-3`… rather than handing
       back an open session (see the note beside `derivedName` in
       useNewSessionCommit.ts), so the host's `reused` flag is always false on
       this path and the banner does not offer to explain a state it cannot
       produce. -->
  <section class="result">
    <div :class="['result-banner', outcome.ok ? 'ok' : 'bad']">
      <AppIcon :name="outcome.ok ? 'check' : 'alert-triangle'" />
      <div class="result-text">
        <p class="result-title">
          <template v-if="outcome.ok">
            Started <code>{{ outcome.sessionName }}</code>
          </template>
          <template v-else-if="outcome.code === 'folder-missing'">
            That folder is not on the host
          </template>
          <template v-else>Could not start the session</template>
        </p>
        <p v-if="outcome.ok" class="result-sub muted">
          in <code>{{ displayPath(outcome.folder ?? '', projects.home) }}</code>
        </p>
        <p v-else-if="outcome.code === 'folder-missing'" class="result-sub muted">
          {{ outcome.error }}. Nothing was created — a session started in a missing
          directory would silently land in <code>$HOME</code> instead.
        </p>
        <p v-else class="result-sub muted">{{ outcome.error }}</p>
      </div>
    </div>

    <!-- The agent is armed, not started. Saying so here is what keeps the
         banner honest about a launch that happens after a navigation the
         user has not made yet — "I picked Claude and got a shell" is not a
         bug anyone can report usefully. It reads as true as it ever did,
         because the only successful create that still shows this panel is
         the one the user must press Open on: everywhere else the
         navigation happens on its own and there is no instruction to
         give. -->
    <p v-if="outcome.ok && parkedKind" class="launch-note">
      <AppIcon name="terminal" :size="12" />
      {{ KIND_LABELS[parkedKind] }} starts when this session's terminal opens — press
      <strong>Open session</strong>.
    </p>

    <!-- Said plainly rather than hidden: the raw-tmux path cannot apply the
         helper's systemd memory cap, so this session has no limit on it. -->
    <p v-if="outcome.ok && outcome.via === 'tmux-fallback'" class="fallback-note">
      <AppIcon name="alert-triangle" :size="12" />
      Created with raw <code>tmux</code> — the <code>pocketshell</code> helper was
      not usable here, so this session has <strong>no memory cap</strong>.
    </p>

    <div class="result-actions">
      <button class="btn-secondary" @click="emit('again')">Start another</button>
      <button v-if="outcome.ok" class="btn-primary" autofocus @click="emit('open')">
        Open session
      </button>
    </div>
  </section>
</template>

<style scoped>
.result {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.result-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  border: 1px solid var(--border);
}
.result-banner.ok {
  background: var(--success-soft);
  border-color: transparent;
  color: var(--success);
}
.result-banner.bad {
  background: var(--error-soft);
  border-color: transparent;
  color: var(--error);
}
.result-text {
  min-width: 0;
}
.result-title {
  margin: 0;
  font-size: var(--fs-400);
  line-height: var(--lh-400);
  font-weight: var(--fw-semibold);
  color: var(--fg);
}
.result-sub {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-200);
}
/* Accent-toned, not warning-toned: nothing has gone wrong, this is the next
   step of what the user asked for. */
.launch-note {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-200);
}
.launch-note .app-icon {
  margin-top: 3px;
}
.fallback-note {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--warning-soft);
  color: var(--warning);
  font-size: var(--fs-200);
}
.fallback-note .app-icon {
  margin-top: 3px;
}
.result-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
}
/* The same buttons the dialog's commit bar wears; scoped styles do not reach
   across components, so the section carries its own copy. */
.btn-primary,
.btn-secondary {
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4);
  border-radius: var(--r-md);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.btn-primary {
  background: var(--accent);
  color: var(--on-accent);
  border: 1px solid var(--accent);
}
.btn-primary:hover:not(:disabled) {
  background: var(--accent-dim);
  color: var(--fg);
}
.btn-primary:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.btn-secondary {
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  color: var(--fg-secondary);
  font-weight: var(--fw-medium);
}
.btn-secondary:hover {
  color: var(--fg);
}
code {
  font-family: var(--font-mono);
}
</style>

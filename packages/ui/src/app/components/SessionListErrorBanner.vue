<script setup lang="ts">
// SessionListErrorBanner: the host answered the session listing but reported
// `errors[]` — part of its session state could not be read (an aplexer probe
// failed, a snapshot was unreadable). The list beneath may be incomplete, and
// an EMPTY list next to errors is not "no sessions". Without this strip the
// panel looked like a quiet host; the Android app it replaces showed the same
// "Some sessions may be missing" warning.
//
// In flow above the tree, like CrashWarningBanner, and with no dismiss: it is
// a fact about the listing, and the next refresh that comes back clean is
// what takes it down.
import { computed } from 'vue';
import { sessionListErrorNotice } from '@pocketshell/core';
import { useSessionsStore } from '../stores/sessions';

const sessions = useSessionsStore();
const notice = computed(() => sessionListErrorNotice(sessions.listErrors));
</script>

<template>
  <p
    v-if="notice"
    class="list-errors"
    role="status"
    data-testid="session-list-errors"
    :title="notice"
  >
    {{ notice }}
  </p>
</template>

<style scoped>
.list-errors {
  margin: 0 var(--sp-2) var(--sp-2);
  border: 1px solid var(--warning);
  background: var(--warning-soft);
  border-radius: var(--r-md);
  padding: var(--sp-1) var(--sp-2);
  font-size: var(--fs-100);
  line-height: var(--lh-200);
  color: var(--fg);
  /* The Android banner's three-line cap: a long host message must not push
     the tree off a phone screen. The title carries the full text. */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
</style>

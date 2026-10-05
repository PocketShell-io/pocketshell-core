<script setup lang="ts">
// BarErrorStrip: the one-line refusal strip under the tab bar — a failed
// create and a failed rename rent the same sentence (the `barError` state
// lives in the workspace view's script and decides WHEN this shows).
//
// A failed create is a sentence, not a dialog: the tab bar is still usable
// and the message is about the one action that did not happen. The dismiss
// is the app's ghost `.icon-btn sm` register (App.vue) and nothing louder:
// the strip is already error-tinted, and a button that outshouted the
// sentence would make the remedy read like a second problem.
//
// `@mousedown.prevent` is load-bearing, not tidiness: while a rename field is
// open, an unprevented mousedown here would blur the field, the blur would
// re-run the failing commit, and the message would be re-set moments after
// the click cleared it — a dismiss button that un-dismisses itself.
import AppIcon from '@ui/components/AppIcon.vue';

defineProps<{
  /** The refusal sentence. Null renders nothing — the strip's whole presence decision. */
  message: string | null;
}>();

const emit = defineEmits<{
  /** The dismiss. The parent clears the state; the strip owns only the gesture. */
  dismiss: [];
}>();
</script>

<template>
  <p v-if="message" class="bar-error">
    <span class="bar-error-text">{{ message }}</span>
    <button
      class="icon-btn sm bar-error-dismiss"
      title="Dismiss"
      aria-label="Dismiss this message"
      @mousedown.prevent
      @click="emit('dismiss')"
    >
      <AppIcon name="close" :size="12" />
    </button>
  </p>
</template>

<style scoped>
/* Flex, so the dismiss button sits at the end of the strip; the TEXT is the
   flexible child, so the three-line launch-timeout remedy wraps under itself
   rather than under the button. */
.bar-error {
  margin: 0;
  padding: var(--sp-1) var(--sp-3);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--error);
  background: var(--error-soft);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
}
.bar-error-text {
  flex: 1;
  min-width: 0;
}
/* The shared `.icon-btn` is square by construction; pinned rigid here so a
   long message cannot squeeze it below its tap target. */
.bar-error-dismiss {
  flex: 0 0 auto;
}
</style>

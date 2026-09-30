<script setup lang="ts">
// Settings → Advanced: the composer's Enter-key delay and the usage warning
// threshold (0.5.x Advanced), with one reset for both. The threshold starts
// unset, which keeps the shipped meter colours (core usageMeterTone).
import {
  SUBMIT_ENTER_DELAY_MAX_MS,
  SUBMIT_ENTER_DELAY_MIN_MS,
  SUBMIT_ENTER_DELAY_STEP_MS,
  USAGE_DEFAULT_WARN_PERCENT,
  USAGE_WARN_MAX_PERCENT,
  USAGE_WARN_MIN_PERCENT,
  USAGE_WARN_STEP_PERCENT,
  parseSubmitEnterDelayMs,
  parseUsageWarnPercent,
} from '@pocketshell/core';
import { computed } from 'vue';
import { useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();
const warnValue = computed(() => settings.usageWarnPercent ?? USAGE_DEFAULT_WARN_PERCENT);

function onEnterDelayInput(event: Event): void {
  const parsed = parseSubmitEnterDelayMs((event.target as HTMLInputElement).value);
  if (parsed !== undefined) settings.set('submitEnterDelayMs', parsed);
}

function onWarnPercentInput(event: Event): void {
  const parsed = parseUsageWarnPercent((event.target as HTMLInputElement).value);
  if (parsed !== undefined) settings.set('usageWarnPercent', parsed);
}
</script>

<template>
  <section class="group" data-testid="settings-group-advanced">
    <h3 class="group-title">Advanced</h3>
    <div class="row">
      <div class="row-text">
        <label class="row-label" for="enter-delay">Enter-key delay</label>
        <p class="row-hint">
          Pause after sending a prompt's text before sending Enter. Change it only if an
          agent leaves pasted input unsubmitted.
        </p>
      </div>
      <span class="range-control">
        <input
          id="enter-delay"
          type="range"
          data-testid="setting-enter-delay"
          :min="SUBMIT_ENTER_DELAY_MIN_MS"
          :max="SUBMIT_ENTER_DELAY_MAX_MS"
          :step="SUBMIT_ENTER_DELAY_STEP_MS"
          :value="settings.submitEnterDelayMs"
          @input="onEnterDelayInput"
        />
        <output for="enter-delay" data-testid="setting-enter-delay-value">{{ settings.submitEnterDelayMs }} ms</output>
      </span>
    </div>
    <div class="row">
      <div class="row-text">
        <label class="row-label" for="usage-warn">Usage: warn at</label>
        <p class="row-hint">
          A provider quota turns amber once this much of it is used. Critical (95%) and
          exceeded (100%) stay fixed. Until you set it, meters keep their standard colours.
        </p>
      </div>
      <span class="range-control">
        <input
          id="usage-warn"
          type="range"
          data-testid="setting-usage-warn"
          :min="USAGE_WARN_MIN_PERCENT"
          :max="USAGE_WARN_MAX_PERCENT"
          :step="USAGE_WARN_STEP_PERCENT"
          :value="warnValue"
          @input="onWarnPercentInput"
        />
        <output for="usage-warn" data-testid="setting-usage-warn-value">
          {{ settings.usageWarnPercent === null ? 'Standard' : `${settings.usageWarnPercent}%` }}
        </output>
      </span>
    </div>
    <div class="row">
      <div class="row-text">
        <span class="row-label">Reset advanced defaults</span>
        <p class="row-hint">Restores the Enter-key delay and the standard usage colours.</p>
      </div>
      <button
        class="btn-ghost"
        data-testid="settings-reset-advanced"
        :disabled="settings.advancedIsDefault"
        @click="settings.resetAdvancedDefaults()"
      >
        Reset
      </button>
    </div>
  </section>
</template>

<style scoped src="./settingsGroup.css"></style>

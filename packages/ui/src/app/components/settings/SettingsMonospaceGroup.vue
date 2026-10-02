<script setup lang="ts">
// Settings → Monospace text: the one shared face plus the two per-surface
// sizes, each with its own live sample. Extracted from SettingsView with the
// rest of the group components; the reasoning that shaped the two samples
// travels with the template below.
import { computed } from 'vue';
import { useSettingsStore } from '../../stores/settings';
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  MONOSPACE_FAMILIES,
  parseFontSize,
  resolveMonoStack,
  sanitiseFontFamily,
} from '@ui/fonts';

const settings = useSettingsStore();

/**
 * The stack the chosen family actually resolves to, used to render the two
 * samples below.
 *
 * The samples are not decoration. There is no way to ask the renderer whether
 * a family is installed, so a sample IS the answer: type a name, and if it
 * does not change, the font is not on this machine and the stack fell through
 * to Consolas. That is a better report than any check this app could make.
 *
 * There are two of them, one per size control, because a single shared sample
 * is what made the size controls confusable in the first place — see the
 * comment above the Monospace text section in the template.
 */
const monoSample = computed(() => resolveMonoStack(settings.monospaceFontFamily));

/**
 * Committed on `change` (blur, Enter, or picking a datalist suggestion) rather
 * than on `input`. A family name is only meaningful once it is finished — the
 * partial "Fira Cod" would resolve to the fallback and flicker the whole app's
 * mono chrome on the way to "Fira Code".
 */
function onFamilyChange(event: Event): void {
  const el = event.target as HTMLInputElement;
  const clean = sanitiseFontFamily(el.value) ?? null;
  settings.set('monospaceFontFamily', clean);
  // Write the cleaned value back so the field shows what was actually stored;
  // otherwise a name that lost characters to the sanitiser would look accepted
  // verbatim until the panel was reopened.
  el.value = clean ?? '';
}

/** Both size fields. The clamp lives in `fonts.ts` so it cannot drift. */
function onSizeChange(key: 'terminalFontSize' | 'editorFontSize', event: Event): void {
  const el = event.target as HTMLInputElement;
  // `min`/`max` on a number input are advisory — they gate the stepper, not a
  // typed value — so the clamp is applied here regardless of what the DOM says.
  const size = parseFontSize(el.value) ?? settings[key];
  settings.set(key, size);
  el.value = String(size);
}
</script>

<template>
  <!--
    TWO SIZE CONTROLS, AND WHY EACH ONE CARRIES ITS OWN PREVIEW.

    These shipped as "Terminal size" and "File editor size" under one
    heading, with a single shared sample between them, and a user reported
    twice that "font size has no effect" — because they were moving the
    editor's control while watching the terminal. The wiring was correct
    both times. That is a labelling defect, not a user error: two adjacent
    numeric fields whose only distinguishing mark was a word in a hint
    nobody reads.

    Both settings are kept. They are genuinely two decisions — the terminal's
    size changes the cell, so it changes the rows and columns pushed to the
    PTY and tmux reflows on the far end, which the editor's size cannot do —
    and merging them would jump every existing user's editor from 13px to
    16px on upgrade, breaking the rule the whole typography feature was built
    on. What changes instead is that each control now names its surface in
    the LABEL rather than in prose, and each is followed by a captioned live
    sample rendered in that surface's own face, size and ground. A preview
    that visibly moves when you touch the control is self-explanatory in a
    way no label is; if this is still confused after that, the answer is to
    merge them and accept the editor jump.
  -->
  <section class="group" data-testid="settings-group-monospace">
    <h3 class="group-title">Monospace text</h3>

    <div class="row">
      <div class="row-text">
        <label class="row-label" for="mono-family">Font</label>
        <p class="row-hint">
          Used by the terminal, the file editor and every path, port and session name
          in the app — they are one surface, so they share one face. Pick a suggestion
          or type any family installed on this machine; leave it empty for the default.
          A font you do not have falls back to Consolas, never to a proportional face.
        </p>
      </div>
      <input
        id="mono-family"
        class="control"
        type="text"
        list="mono-families"
        placeholder="Consolas (default)"
        :value="settings.monospaceFontFamily ?? ''"
        @change="onFamilyChange"
      />
      <datalist id="mono-families">
        <option v-for="family in MONOSPACE_FAMILIES" :key="family" :value="family" />
      </datalist>
    </div>

    <div class="row previewed">
      <div class="row-main">
        <div class="row-text">
          <label class="row-label" for="terminal-size">Terminal text size</label>
          <p class="row-hint">
            Pixels, for the terminal only — this is the one the shell and tmux are in.
            Changing it changes the cell size, so the terminal reports a new row and
            column count to the remote and tmux redraws to fit. Above about 22px an
            80-column pane no longer fits a default window with the session panel open.
          </p>
        </div>
        <input
          id="terminal-size"
          class="control size"
          type="number"
          :min="FONT_SIZE_MIN"
          :max="FONT_SIZE_MAX"
          step="1"
          :value="settings.terminalFontSize"
          @change="onSizeChange('terminalFontSize', $event)"
        />
      </div>
      <!-- On the terminal's own ground, in the resolved stack, at exactly
           the size above: the sample answers both "is this font installed"
           and "which of the two controls am I holding". -->
      <figure class="preview">
        <figcaption class="preview-tag">Terminal at {{ settings.terminalFontSize }}px</figcaption>
        <p class="sample terminal" :style="{ fontFamily: monoSample }">
          ABCdef 0123 il1 O0 {}[]() -&gt;= !== &amp;&amp; ~/.ssh/config
        </p>
      </figure>
    </div>

    <div class="row previewed">
      <div class="row-main">
        <div class="row-text">
          <label class="row-label" for="editor-size">File editor text size</label>
          <p class="row-hint">
            Pixels, for the text of a file open in the Files tab — nothing else. It has
            its own setting because the two surfaces ship at different sizes, and
            because only the terminal's size is visible to the program on the other end.
          </p>
        </div>
        <input
          id="editor-size"
          class="control size"
          type="number"
          :min="FONT_SIZE_MIN"
          :max="FONT_SIZE_MAX"
          step="1"
          :value="settings.editorFontSize"
          @change="onSizeChange('editorFontSize', $event)"
        />
      </div>
      <figure class="preview">
        <figcaption class="preview-tag">File editor at {{ settings.editorFontSize }}px</figcaption>
        <p class="sample editor" :style="{ fontFamily: monoSample }">
          ABCdef 0123 il1 O0 {}[]() -&gt;= !== &amp;&amp; ~/.ssh/config
        </p>
      </figure>
    </div>
  </section>
</template>

<style scoped src="./settingsGroup.css"></style>

<style scoped>
/* A row whose preview belongs to IT and not to the section. The label/control
   pair keeps the normal shape in `.row-main`; the sample goes full width
   underneath, inside the same row, so the hairline still separates settings
   rather than separating a control from its own preview. */
.row.previewed {
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-2);
}
.row-main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
}
.preview {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
/* Names the surface the sample IS. Same metric as the group title, one step
   quieter — it labels a picture, it is not a heading. */
.preview-tag {
  font-size: var(--fs-100);
  line-height: var(--lh-100);
  font-weight: var(--fw-medium);
  color: var(--fg-secondary);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.control.size {
  width: 5rem;
  font-variant-numeric: tabular-nums;
}
/* Each sample sits on its surface's own ground at its surface's own size, so
   it answers the question the user is actually asking — "what will THIS look
   like" — rather than "what does this font look like on a settings panel".
   The two differ only in the size token they read, which is the whole point:
   move one control and exactly one sample changes. */
.sample {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--term-bg);
  line-height: 1.3;
  white-space: nowrap;
  overflow-x: auto;
}
.sample.terminal {
  color: var(--term-fg);
  font-size: var(--term-font-size);
}
/* The editor sits on the terminal's ground too (see FilesView: an open file
   and the shell it came from are one surface), in the editor's own body
   colour and at the editor's own size. */
.sample.editor {
  color: var(--code-variable);
  font-size: var(--code-font-size);
}
</style>

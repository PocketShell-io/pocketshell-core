import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The session panel's scroll contract, held at the source because jsdom
// cannot lay out and the behaviour tiers below this one need a host.
//
// `.tree` (SessionTree.vue) is the flex column that bounds the rows'
// `.folder-list` (SessionTreeRowsView.vue), whose `flex: 1;
// overflow-y: auto` only makes it a scroll area as a child of one. In plain
// block flow the list's height is its content's, the overflow never engages,
// and the host panel's `overflow: hidden` clips the rows instead of
// scrolling them — the failure a host with more sessions than a windowful
// ships as. The `display: flex` pair was lost in the move to
// @pocketshell/ui and the loss shipped silently; these are the
// definition-of-done greps for it, executed rather than remembered.

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(HERE, '..', 'src', 'app', 'components');

/** A rule's declarations, its comments blanked so prose cannot satisfy it. */
function declarations(file: string, selector: string): string {
  const source = readFileSync(resolve(UI_SRC, file), 'utf8');
  const match = source.match(new RegExp(`^${selector} \\{([^}]*)\\}`, 'm'));
  expect(match, `\`${selector}\` in ${file}`).toBeTruthy();
  return match![1].replace(/\/\*[\s\S]*?\*\//g, '');
}

function expectDeclares(rule: string, what: string): void {
  expect(rule, `declaration \`${what}\``).toMatch(new RegExp(`(^|[^\\w-])${what}`, 'm'));
}

describe('session tree scroll contract', () => {
  it('lays the panel out as the flex column that bounds the scroll area', () => {
    const tree = declarations('SessionTree.vue', '\\.tree');
    expectDeclares(tree, 'display:\\s*flex');
    expectDeclares(tree, 'flex-direction:\\s*column');
  });

  it('keeps the folder list the flexible scroll area inside it', () => {
    const list = declarations('SessionTreeRowsView.vue', '\\.folder-list');
    expectDeclares(list, 'flex:\\s*1');
    expectDeclares(list, 'overflow-y:\\s*auto');
  });
});

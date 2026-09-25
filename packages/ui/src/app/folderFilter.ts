/**
 * The session panel's quick search — the filter box in the tool strip, and
 * the one way to cut a long tree down to the folder you have half a name for.
 *
 * ## What it is, and is not
 *
 * A VISIBILITY FILTER over the tree the other projections already ordered —
 * it removes rows and never rearranges them, so it composes with everything
 * upstream of it (the host's order; the picked sort, `folderSort.ts`; the
 * manual arrangement, `folderOrder.ts`) without an opinion about any of them.
 * It runs LAST in the derivation (folderTree.ts), on the list the panel would
 * have drawn.
 *
 * It is also deliberately NOT a state the tree can stay in by accident: the
 * query lives in memory only (a module ref, not a setting — a filter is where
 * you are looking, not what you decided), and the panel shows a
 * "no folders match" state rather than its "no sessions" one while the query
 * empties the tree, so a filter that matches nothing never reads as a host
 * with nothing running.
 *
 * ## What matches
 *
 * Case-insensitive substring against the three strings a row can be found by:
 * the folder's label, the folder's full home-relative path, and the NAMES of
 * the sessions inside it — the names matter because the panel no longer shows
 * them as rows (they live in the row tooltip and the workspace tab bar), so
 * "the session I was just in" is often only reachable through them. A query
 * that names a ROOT keeps the root whole, every folder in it: matching the
 * header is a statement about the root, not one folder under it.
 */
import type { SessionRootFolder } from './sessionTree';

/**
 * The tree with every folder the [query] does not match removed.
 *
 * Roots that lose all their folders disappear with them — including empty
 * REGISTERED roots, which the unfiltered panel deliberately shows: a filter
 * is a question about what is running, and a root with nothing running is not
 * an answer to it.
 *
 * A blank query (after trimming — a stray space is not a search) returns a
 * shallow copy: the filter's "off" must be indistinguishable from the filter
 * not existing, down to the input list's objects passing through untouched.
 *
 * A NEW structure is returned and the input is never mutated, for the same
 * reactive reason every projection in this pipeline states: the input is a
 * Vue computed's value.
 */
export function filterFolderRoots(
  roots: readonly SessionRootFolder[],
  query: string,
): SessionRootFolder[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...roots];
  const hit = (value: string): boolean => value.toLowerCase().includes(needle);
  return roots
    .map((root) => {
      if (hit(root.key) || hit(root.label)) return root;
      const directories = root.directories.filter(
        (dir) =>
          hit(dir.label) ||
          hit(dir.path) ||
          dir.rows.some((row) => hit(row.session.name)),
      );
      return { ...root, directories };
    })
    .filter((root) => root.directories.length > 0);
}

// Harness for sessionTreeRowsBrowser.test.ts and the design screenshots: the
// REAL SessionTreeRowsView over a realistic tree — many single-session
// projects, a few multi-session ones, directories deleted under a live
// session — in compact (?layout=compact, showSessions) or desktop
// (?layout=desktop) form.
import '@ui/styles.css';
import { createApp, h } from 'vue';
import { groupSessionsIntoRoots, type SessionSummary } from '@pocketshell/core';
import SessionTreeRowsView from '@ui/app/components/SessionTreeRowsView.vue';

const NOW_S = 1_800_000_000;
const HOME = '/home/alexey';
const s = (name: string, dir: string, ageS: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  name,
  created: NOW_S - ageS - 100,
  activity: NOW_S - ageS,
  attached: false,
  path: `${HOME}/git/${dir}`,
  agentKind: 'shell',
  ...extra,
});
const sessions: SessionSummary[] = [
  s('orchestrator-main', 'orchestrator', 5, { attached: true, agentKind: 'claude' }),
  s('main', 'dtc-website', 12 * 3600, { agentKind: 'claude' }),
  s('invertory', 'dataops', 18 * 3600, { agentKind: 'codex' }),
  s('pocketshell-impl', 'pocketshell', 60, { attached: true, agentKind: 'claude' }),
  s('pocketshell-review', 'pocketshell', 300, { agentKind: 'codex' }),
  s('pocketshell-shell', 'pocketshell', 900),
  s('main', 'aplexer', 3 * 3600),
  s('main', 'quse', 5 * 3600),
  s('docs', 'course-management-platform', 6 * 3600, { agentKind: 'claude' }),
  s('web', 'coolify-config', 7 * 3600),
  s('main', 'ai-shipping-labs', 20 * 3600, { agentKind: 'claude' }),
  s('build', 'ai-shipping-labs', 21 * 3600),
  s('main', 'notes', 22 * 3600),
  s('shell-s1-mwd6e1xg', 'ps-s1-s1-mwd6e1xg (deleted)', 5 * 86400),
  s('shell-s0-mwd5sye7', 'ps-s0-s0-mwd5sye7 (deleted)', 5 * 86400),
  s('an-extremely-long-session-name-that-also-overflows-the-row', 'a-very-long-project-name-that-keeps-going-and-going', 4 * 3600),
  s('main', 'telegram-bot', 2 * 86400),
  s('main', 'mcp-servers', 3 * 86400),
  s('main', 'home-lab', 4 * 86400),
  s('main', 'blog', 4 * 86400),
  s('main', 'dotfiles', 5 * 86400),
];
const roots = groupSessionsIntoRoots(sessions, HOME, ['~/git']);
const params = new URLSearchParams(location.search);
const selects: unknown[][] = [];
(window as unknown as { __selects: unknown[][] }).__selects = selects;
const compact = params.get('layout') !== 'desktop';

createApp({
  render: () =>
    h('div', { class: 'tree', style: 'container-type:inline-size;display:flex;flex-direction:column;height:100vh;background:var(--bg)' }, [
      h(SessionTreeRowsView, {
        roots,
        home: HOME,
        now: NOW_S * 1000,
        defaultStartIn: null,
        showSessions: compact,
        tabOrders: {},
        activeFolder: params.get('active') ? '~/git/orchestrator' : null,
        activeSession: params.get('active') ? 'orchestrator-main' : null,
        onSelect: (dir: { key: string }, session?: string) => selects.push([dir.key, session ?? null]),
      }),
    ]),
}).mount('#app');

/**
 * Proves the embed artifact is the real contract layer: the SAME assertions
 * run against the SAME bundle file in TWO engines — this Node's vm, and a
 * real QuickJS (the engine class Android embeds, via quickjs-emscripten).
 * A pass here means the Android integration surface is exercised code, not a
 * claim.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { getQuickJS } from 'quickjs-emscripten';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = readFileSync(root + 'embed/pocketshell-core.js', 'utf8');
const shims = readFileSync(root + 'embed/host-shims.js', 'utf8');

// Sync contract assertions only: the async paths (AplexerCore round-trips)
// are pinned by the apps' vitest suites against the same sources.
function contractAssertions(C) {
  var n = 0;
  var eq = function (got, want, what) {
    if (got !== want) {
      throw new Error(what + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
    }
    n += 1;
  };
  eq(C.shellQuote('a b'), "'a b'", 'shellQuote quotes');
  eq(C.formatBytes(512), '512 B', 'formatBytes bytes');
  eq(C.formatBytes(1536), '1.5 KB', 'formatBytes KB');
  eq(C.KIND_LABELS.claude, 'Claude Code', 'KIND_LABELS');
  eq(C.aplexerSnapshotCommand(), 'a snapshot --json', 'aplexerSnapshotCommand default');
  eq(C.aplexerSnapshotCommand('created'), 'a snapshot --json --sort created', 'aplexerSnapshotCommand sort');
  eq(C.decodeOsc52SetClipboard('c;aGVsbG8gd29ybGQ='), 'hello world', 'osc52 decode (atob)');
  var directive = C.parseDirectiveLine('Host dev-box', 1);
  if (!directive) throw new Error('sshConfigCore parseDirectiveLine returned nothing');
  n += 1;
  if (typeof C.AplexerCore !== 'function') throw new Error('AplexerCore class missing');
  n += 1;
  if (typeof C.HostCliCore !== 'function') throw new Error('HostCliCore class missing');
  n += 1;
  var host = new C.HostCliCore({ exec: function () { throw new Error('unexpected transport call'); } });
  eq(host.buildAttachCommand("it's a build"), "exec pocketshell sessions attach -- 'it'\\''s a build'", 'host CLI attach');
  var sessions = C.parseHostSessionsList('{"schema":3,"sessions":[{"name":"main","attached":false,"agent_state":"waiting"}],"errors":[]}');
  eq(sessions.sessions[0].agentState, 'waiting', 'host CLI sessions parser');
  var workspaces = C.parseHostWorkspaces('{"schema":1,"workspaces":[{"path":"/workspace"}]}');
  eq(workspaces.workspaces[0].displayPath, '/workspace', 'host CLI workspaces parser');
  var engines = C.parseHostEnginesList('{"engines":[{"id":"claude","label":"Claude","available_for_create":true}]}');
  eq(engines[0].availableForCreate, true, 'host CLI engines parser');
  var profiles = C.parseHostProfilesList('{"profiles":[{"name":"Claude","engine":"claude","default":true}]}');
  eq(profiles[0].isDefault, true, 'host CLI profiles parser');
  return 'assertions=' + n;
}

function run(runner) {
  try {
    return 'OK ' + runner();
  } catch (e) {
    return 'FAIL ' + (e && e.message ? e.message : String(e));
  }
}

// The wrapper evaluates in-engine; only the verdict string crosses back.
var source = '(' + run.toString() + ')(function () { return (' + contractAssertions.toString() + ')(globalThis.PocketShellCore); })';

function evalChunk(engine, chunk, label) {
  const result = engine.evalCode(chunk);
  const value = engine.dump(result);
  result.dispose();
  return value;
}

// Engine 1: Node vm, bare context — nothing but the shims and the bundle.
var nodeResult;
try {
  nodeResult = vm.runInNewContext(shims + ';\n' + bundle + ';\n' + source, {}, { timeout: 10_000 });
} catch (e) {
  nodeResult = 'FAIL node vm threw: ' + e.message;
}
console.log('node vm   :', nodeResult);

// Engine 2: QuickJS.
var quickResult;
const QJS = await getQuickJS();
const vmc = QJS.newContext();
try {
  const resultHandle = vmc.unwrapResult(vmc.evalCode(shims, 'host-shims.js'));
  resultHandle.dispose();
  vmc.unwrapResult(vmc.evalCode(bundle, 'pocketshell-core.js')).dispose();
  const verdict = vmc.unwrapResult(vmc.evalCode(source, 'assertions.js'));
  quickResult = vmc.dump(verdict);
  verdict.dispose();
} catch (e) {
  quickResult = 'FAIL quickjs threw: ' + e.message;
} finally {
  vmc.dispose();
}
console.log('quickjs   :', quickResult);

if (nodeResult.startsWith('OK ') && typeof quickResult === 'string' && quickResult.startsWith('OK ')) {
  console.log('embed verification passed in both engines');
} else {
  console.error('embed verification FAILED');
  process.exit(1);
}

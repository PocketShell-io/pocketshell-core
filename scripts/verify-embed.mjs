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
import { build } from 'esbuild';
import { getQuickJS } from 'quickjs-emscripten';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = readFileSync(root + 'embed/pocketshell-core.js', 'utf8');
const shims = readFileSync(root + 'embed/host-shims.js', 'utf8');
const policyContract = await build({
  entryPoints: ['tests/connectionControllerContract.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'PocketShellConnectionPolicyContract',
  target: 'es2020',
  write: false,
});
const policyBundle = policyContract.outputFiles[0].text;

// Synchronous contract assertions work without host I/O in either engine.
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

// Exercise the Android bridge seam in-engine too. This Promise-based transport
// returns deterministic SSH exec outcomes, just as the Kotlin bridge does.
async function asyncContractAssertions(C) {
  var n = 0;
  var eq = function (got, want, what) {
    if (got !== want) {
      throw new Error(what + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
    }
    n += 1;
  };
  var calls = [];
  var host = new C.HostCliCore({
    exec: function (command, timeoutMs) {
      calls.push({ command: command, timeoutMs: timeoutMs });
      if (command === 'pocketshell sessions list --json') {
        return Promise.resolve({
          exitCode: 0,
          stdout: '{"schema":3,"sessions":[{"name":"fixture:main","attached":false,"agent_state":"working"}],"errors":[]}',
          stderr: '',
        });
      }
      return Promise.resolve({ exitCode: 2, stdout: '', stderr: "No such command 'profiles'.\n" });
    },
  });

  var sessions = await host.listSessions();
  eq(sessions.sessions[0].name, 'fixture:main', 'async host CLI parsed session');
  eq(sessions.sessions[0].agentState, 'working', 'async host CLI parsed agent state');
  eq(calls[0].command, 'pocketshell sessions list --json', 'async host CLI success command');
  eq(calls[0].timeoutMs, 20_000, 'async host CLI success timeout');

  var failure;
  try {
    await host.listProfiles();
  } catch (error) {
    failure = error;
  }
  eq(failure instanceof C.HostCliFailed, true, 'async host CLI failure type');
  eq(failure.kind, 'failed', 'async host CLI failure kind');
  eq(failure.exitCode, 2, 'async host CLI failure exit');
  eq(failure.stderr, "No such command 'profiles'.\n", 'async host CLI failure stderr');
  eq(calls[1].command, 'pocketshell profiles list --json', 'async host CLI failure command');
  eq(calls[1].timeoutMs, 20_000, 'async host CLI failure timeout');
  return 'assertions=' + n;
}

function run(runner) {
  try {
    return 'OK ' + runner();
  } catch (e) {
    return 'FAIL ' + (e && e.message ? e.message : String(e));
  }
}

function runAsync(runner) {
  return Promise.resolve().then(runner).then(
    function (value) { return 'OK ' + value; },
    function (e) { return 'FAIL ' + (e && e.message ? e.message : String(e)); },
  );
}

// The wrapper evaluates in-engine; only the verdict string crosses back.
var source = '(' + run.toString() + ')(function () { return (' + contractAssertions.toString() + ')(globalThis.PocketShellCore); })';
var asyncSource = '(' + runAsync.toString() + ')(function () { return (' + asyncContractAssertions.toString() + ')(globalThis.PocketShellCore); })';
var policyAsyncSource = '(' + runAsync.toString() + ')(function () { return globalThis.PocketShellConnectionPolicyContract.runConnectionControllerContract(globalThis.PocketShellCore); })';

function evalChunk(engine, chunk, label) {
  const result = engine.evalCode(chunk);
  const value = engine.dump(result);
  result.dispose();
  return value;
}

// Engine 1: Node vm, bare context — nothing but the shims and the bundle.
var nodeResult;
var nodeAsyncResult;
var nodePolicyResult;
var nodeContext = {};
try {
  nodeResult = vm.runInNewContext(shims + ';\n' + bundle + ';\n' + source, nodeContext, { timeout: 10_000 });
  nodeAsyncResult = await vm.runInNewContext(asyncSource, nodeContext, { timeout: 10_000 });
  vm.runInNewContext(policyBundle, nodeContext, { timeout: 10_000 });
  nodePolicyResult = await vm.runInNewContext(policyAsyncSource, nodeContext, { timeout: 10_000 });
} catch (e) {
  nodeResult = 'FAIL node vm threw: ' + e.message;
  nodeAsyncResult = 'FAIL node vm async threw: ' + e.message;
  nodePolicyResult = 'FAIL node vm policy threw: ' + e.message;
}
console.log('node vm sync :', nodeResult);
console.log('node vm async:', nodeAsyncResult);
console.log('node vm policy:', nodePolicyResult);

// Engine 2: QuickJS.
var quickResult;
var quickAsyncResult;
var quickPolicyResult;
const QJS = await getQuickJS();
const vmc = QJS.newContext();
try {
  const resultHandle = vmc.unwrapResult(vmc.evalCode(shims, 'host-shims.js'));
  resultHandle.dispose();
  vmc.unwrapResult(vmc.evalCode(bundle, 'pocketshell-core.js')).dispose();
  const verdict = vmc.unwrapResult(vmc.evalCode(source, 'assertions.js'));
  quickResult = vmc.dump(verdict);
  verdict.dispose();

  // Promise jobs in QuickJS do not run automatically. The embedder must drain
  // them after evaluating async work, before reading the returned Promise.
  const asyncPromise = vmc.unwrapResult(vmc.evalCode(asyncSource, 'async-assertions.js'));
  const hostPromise = vmc.resolvePromise(asyncPromise);
  let drainedJobs = 0;
  while (vmc.runtime.hasPendingJob()) {
    drainedJobs += vmc.unwrapResult(vmc.runtime.executePendingJobs());
    if (drainedJobs > 10_000) throw new Error('QuickJS async contract did not quiesce');
  }
  if (drainedJobs === 0) throw new Error('QuickJS async contract queued no Promise jobs');
  const asyncVerdict = vmc.unwrapResult(await hostPromise);
  quickAsyncResult = vmc.dump(asyncVerdict);
  asyncVerdict.dispose();
  asyncPromise.dispose();

  vmc.unwrapResult(vmc.evalCode(policyBundle, 'connection-controller-contract.js')).dispose();
  const policyPromise = vmc.unwrapResult(vmc.evalCode(policyAsyncSource, 'connection-controller-contract-run.js'));
  const hostPolicyPromise = vmc.resolvePromise(policyPromise);
  drainedJobs = 0;
  while (vmc.runtime.hasPendingJob()) {
    drainedJobs += vmc.unwrapResult(vmc.runtime.executePendingJobs());
    if (drainedJobs > 10_000) throw new Error('QuickJS connection policy contract did not quiesce');
  }
  if (drainedJobs === 0) throw new Error('QuickJS connection policy contract queued no Promise jobs');
  const policyVerdict = vmc.unwrapResult(await hostPolicyPromise);
  quickPolicyResult = vmc.dump(policyVerdict);
  policyVerdict.dispose();
  policyPromise.dispose();
} catch (e) {
  quickResult = 'FAIL quickjs threw: ' + e.message;
  quickAsyncResult = 'FAIL quickjs async threw: ' + e.message;
  quickPolicyResult = 'FAIL quickjs policy threw: ' + e.message;
} finally {
  vmc.dispose();
}
console.log('quickjs sync :', quickResult);
console.log('quickjs async:', quickAsyncResult);
console.log('quickjs policy:', quickPolicyResult);

if (
  nodeResult.startsWith('OK ') &&
  nodeAsyncResult.startsWith('OK ') &&
  nodePolicyResult.startsWith('OK ') &&
  typeof quickResult === 'string' && quickResult.startsWith('OK ') &&
  typeof quickAsyncResult === 'string' && quickAsyncResult.startsWith('OK ') &&
  typeof quickPolicyResult === 'string' && quickPolicyResult.startsWith('OK ')
) {
  console.log('embed verification passed in both engines');
} else {
  console.error('embed verification FAILED');
  process.exit(1);
}

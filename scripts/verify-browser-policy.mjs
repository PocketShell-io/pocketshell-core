/**
 * Run the shared connection and composer policy contracts against a real browser build.
 * CI provisions Chrome; local runs may set CHROMIUM_BIN to a Chromium binary.
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { build } from 'esbuild';

function findBrowser() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    process.env.CHROME_BIN,
    'chromium',
    'chromium-browser',
    'google-chrome',
    'google-chrome-stable',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }
  throw new Error('Could not find Chromium or Chrome; set CHROMIUM_BIN to its executable.');
}

const core = await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'PocketShellCore',
  platform: 'browser',
  target: 'es2020',
  write: false,
});
const contract = await build({
  entryPoints: ['tests/connectionControllerContract.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'PocketShellConnectionPolicyContract',
  platform: 'browser',
  target: 'es2020',
  write: false,
});
const composerContract = await build({
  entryPoints: ['tests/composerDeliveryContract.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'PocketShellComposerDeliveryContract',
  platform: 'browser',
  target: 'es2020',
  write: false,
});

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Connection policy contract</title></head>
<body><output id="result" data-result="pending">pending</output>
<script>${core.outputFiles[0].text}</script>
<script>${contract.outputFiles[0].text}</script>
<script>${composerContract.outputFiles[0].text}</script>
<script>
Promise.resolve()
  .then(function () {
    return Promise.all([
      PocketShellConnectionPolicyContract.runConnectionControllerContract(PocketShellCore),
      PocketShellComposerDeliveryContract.runComposerDeliveryContract(PocketShellCore)
    ]);
  })
  .then(function (results) {
    var total = results.reduce(function (sum, result) {
      var match = result.match(/^assertions=(\\d+)$/);
      if (!match) throw new Error('Unexpected policy contract result: ' + result);
      return sum + Number(match[1]);
    }, 0);
    document.getElementById('result').setAttribute('data-result', 'OK assertions=' + total);
  }, function (error) {
    document.getElementById('result').setAttribute('data-result', 'FAIL ' + (error && error.message || String(error)));
  });
</script></body></html>`;
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
});
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the browser contract server.');
  const browser = findBrowser();
  const child = spawn(browser, [
    '--headless',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--virtual-time-budget=20000',
    '--dump-dom',
    `http://127.0.0.1:${address.port}/contract`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  if (exit.code !== 0) throw new Error(`Browser exited with ${exit.code ?? exit.signal}: ${stderr.slice(-3000)}`);
  const match = stdout.match(/<output id="result" data-result="([^"]+)"/);
  const result = match?.[1]?.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  if (!result || !result.startsWith('OK assertions=')) {
    throw new Error(`Browser policy contract failed: ${result ?? 'result marker missing'}\n${stdout.slice(0, 2500)}\n${stderr.slice(-1000)}`);
  }
  console.log(`browser policy: ${result}`);
} finally {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

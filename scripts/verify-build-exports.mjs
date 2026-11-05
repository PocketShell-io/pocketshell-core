// Load both actual distribution entry points. In particular, Windows cmd's
// shell echo preserves single quotes and previously produced invalid CJS
// package metadata even though TypeScript and ESM checks were green.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '../dist/esm/index.js';
import { ipc } from '../dist/esm/shared/channels.js';

const require = createRequire(import.meta.url);
const cjs = require('../dist/cjs/index.js');
assert.deepEqual(Object.keys(esm).sort(),Object.keys(cjs).sort(),'ESM and CommonJS must expose the same public names');
for (const name of Object.keys(esm)) assert.equal(typeof cjs[name],typeof esm[name],`export kind: ${name}`);
for (const api of [esm,cjs]) {
  for (const name of ['parseGatewayDeviceList','normalizeGatewayServerUrl']) assert.equal(typeof api[name],'function',name);
  for (const method of ['createVault','unlock','bindHost','decryptKeyForHost','listKeys']) assert.equal(typeof api.KeyVaultStore.prototype[method],'function',method);
}
assert.deepEqual(ipc.gateway, {
  devices:'gateway:devices',pairings:'gateway:pairings',clientKeys:'gateway:clientKeys',
  createClientKey:'gateway:createClientKey',addDevice:'gateway:addDevice',
});
assert.deepEqual(require('../dist/cjs/shared/channels.js').ipc.gateway,ipc.gateway,'gateway channels match in both module formats');
console.log('ESM/CJS public export parity, vault APIs and gateway channels passed');

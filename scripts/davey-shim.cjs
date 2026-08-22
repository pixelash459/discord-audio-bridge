// Inlined into the release bundle; loads the real @snazzah/davey from node_modules on disk.
//
// davey (Discord's DAVE MLS implementation) resolves its WASM/native binding with
// createRequire(__filename) and fs.readFileSync at runtime, so it cannot be bundled: it must ship
// as real files next to the executable. A Node single-executable's require() only loads built-in
// modules, hence this shim, which anchors a fresh require where the shipped node_modules lives.
// __dirname is undefined inside esbuild's module wrappers under SEA, hence the typeof guard.
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');

const base = typeof __dirname === 'string' ? __dirname : dirname(process.execPath);
module.exports = createRequire(join(base, 'bridge.cjs'))('@snazzah/davey');

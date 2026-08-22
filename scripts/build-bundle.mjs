// Bundles the bot into one CommonJS file that a Node single executable can embed.
//
// Two dependencies refuse bundling and are handled specially:
//  - @snazzah/davey resolves its WASM/native binding at runtime relative to its own files, so
//    every import of it is redirected to scripts/davey-shim.cjs, which loads the real package
//    from the node_modules tree shipped next to the executable.
//  - ffmpeg-static is an optional dependency of prism-media that is deliberately not installed
//    (the bot shells out to the system ffmpeg); prism wraps its require in try/catch.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const outfile = fileURLToPath(new URL('../dist/bridge.cjs', import.meta.url));
const shim = fileURLToPath(new URL('./davey-shim.cjs', import.meta.url));

// In a CommonJS bundle esbuild replaces import.meta with {}, so dependencies that anchor a
// require() at import.meta.url (@discordjs/voice does, for davey) would call
// createRequire(undefined). createRequire also accepts a plain absolute path; pointed at the
// executable, the require resolves from the node_modules tree shipped next to it — exactly the
// packaged layout. (No require() in the injected text: esbuild would rename it into the module's
// own not-yet-initialized binding.)
const IMPORT_META_URL = '(typeof __filename === "string" ? __filename : process.execPath)';

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile,
  sourcemap: false,
  keepNames: true, // class/function names appear in logs; minification is not worth losing them
  external: ['ffmpeg-static'],
  plugins: [
    {
      name: 'davey-runtime-load',
      setup(builder) {
        builder.onResolve({ filter: /^@snazzah\/davey$/ }, () => ({ path: shim }));
      },
    },
    {
      name: 'import-meta-url-anchor',
      setup(builder) {
        builder.onLoad({ filter: /\.[cm]?js$/ }, async (args) => {
          if (!args.path.includes('node_modules')) return null;
          const contents = await readFile(args.path, 'utf8');
          if (!contents.includes('import.meta.url')) return null;
          return { contents: contents.replaceAll('import.meta.url', IMPORT_META_URL), loader: 'js' };
        });
      },
    },
  ],
  logLevel: 'info',
});

console.log(`bundled ${entry.replace(root, '')} -> ${outfile.replace(root, '')}`);

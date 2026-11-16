// Builds the app into dist/. `--serve` also watches and serves on http://localhost:5173
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const require = createRequire(import.meta.url);
const serve = process.argv.includes('--serve');

const pdfjs = dirname(require.resolve('pdfjs-dist/package.json'));
const katex = dirname(require.resolve('katex/package.json'));

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// Static files
await cp(join(root, 'public'), dist, { recursive: true });
await cp(join(root, 'src/index.html'), join(dist, 'index.html'));

// pdf.js worker + data it loads at runtime
await mkdir(join(dist, 'pdfjs'), { recursive: true });
await cp(join(pdfjs, 'legacy/build/pdf.worker.min.mjs'), join(dist, 'pdfjs/pdf.worker.min.mjs'));
for (const d of ['standard_fonts', 'cmaps', 'wasm', 'iccs']) {
  await cp(join(pdfjs, d), join(dist, 'pdfjs', d), { recursive: true }).catch(() => {});
}

// KaTeX stylesheet + woff2 fonts
await mkdir(join(dist, 'katex/fonts'), { recursive: true });
await cp(join(katex, 'dist/katex.min.css'), join(dist, 'katex/katex.min.css'));
for (const f of await readdir(join(katex, 'dist/fonts'))) {
  if (f.endsWith('.woff2')) await cp(join(katex, 'dist/fonts', f), join(dist, 'katex/fonts', f));
}

const options = {
  entryPoints: [join(root, 'src/main.ts'), join(root, 'src/styles.css')],
  bundle: true,
  format: 'esm',
  splitting: true,
  outdir: dist,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  target: ['es2022'],
  minify: !serve,
  sourcemap: serve,
  logLevel: 'info',
};

// Stamp the service worker so each build gets a fresh cache
await writeFile(join(dist, 'version.js'), `self.BUILD = ${JSON.stringify(Date.now().toString(36))};\n`);

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { hosts, port } = await ctx.serve({ servedir: dist, port: 5173, host: '0.0.0.0' });
  console.log(`\n  Opplinotes dev server: http://localhost:${port}  (hosts: ${hosts.join(', ')})\n`);
} else {
  await esbuild.build(options);
}

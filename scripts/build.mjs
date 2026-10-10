import { build } from 'esbuild'

await Promise.all([
  build({
    entryPoints: ['src/backend.ts'],
    outfile: 'dist/backend.js',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    sourcemap: false,
  }),
  build({
    entryPoints: ['src/frontend.ts'],
    outfile: 'dist/frontend.js',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: false,
  }),
])

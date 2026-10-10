import { build } from 'esbuild'

const result = await build({
  entryPoints: ['src/core.test.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node22',
})

const source = result.outputFiles[0].text
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

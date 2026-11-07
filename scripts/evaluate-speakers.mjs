import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

const path = process.argv[2]
if (!path || process.argv.length !== 3) {
  console.error('Usage: npm run evaluate:speakers -- path/to/labeled-decisions.json')
  process.exitCode = 1
} else {
  try {
    const result = await build({ entryPoints: ['src/speaker-review-evaluation.ts'], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22' })
    const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
    const input = JSON.parse(await readFile(path, 'utf8'))
    console.log(JSON.stringify(module.evaluateSpeakerReviews(input), null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

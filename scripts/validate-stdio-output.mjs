import { readFile } from 'node:fs/promises'

const [stdoutPath, stderrPath] = process.argv.slice(2)
if (!stdoutPath || !stderrPath) throw new Error('stdout and stderr paths are required')
const [stdout, stderr] = await Promise.all([
  readFile(stdoutPath, 'utf8'),
  readFile(stderrPath, 'utf8'),
])
const lines = stdout
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
if (lines.length === 0) {
  throw new Error(`stdio server returned no response (stderr=${JSON.stringify(stderr)})`)
}
for (const line of lines) {
  const message = JSON.parse(line)
  if (message.jsonrpc !== '2.0') throw new Error(`non-JSON-RPC stdout line: ${line}`)
}
process.stderr.write(`stdio purity: ${lines.length} JSON-RPC response(s), no stray stdout\n`)

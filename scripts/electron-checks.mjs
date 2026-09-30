import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const mode = process.argv[2]
if (!['syntax', 'test'].includes(mode)) throw new Error('Use electron-checks.mjs syntax|test')
function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesUnder(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : [])
}
const files = filesUnder(join(root, 'electron')).filter(path => path.endsWith(mode === 'syntax' ? '.cjs' : '.node-tests.mjs')).sort()
if (!files.length) throw new Error(`No Electron ${mode} files found`)
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.signal) throw new Error(`Electron ${mode} process exited on ${result.signal}`)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
// Explicit paths keep both npm's Windows shell and POSIX shells independent of glob expansion.
if (mode === 'test') run(['--test', ...files])
else { for (const file of files) run(['--check', file]); process.stdout.write(`Checked ${files.length} Electron CJS files.\n`) }

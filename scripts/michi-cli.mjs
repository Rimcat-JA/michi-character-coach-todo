#!/usr/bin/env node
import { createRequire } from 'node:module'
const { createMCPFileClient } = createRequire(import.meta.url)('../electron/mcp-file-client.cjs')
const [mode, ...args] = process.argv.slice(2)
try {
  if (!['validate', 'submit'].includes(mode) || args.length !== 2 && args.length !== 4 || args[0] !== '--bridge' || args.length === 4 && args[2] !== '--task') throw new Error('Use michi-cli.mjs validate|submit --bridge <directory> [--task <id>]')
  const client = await createMCPFileClient(args[1]), proposals = await client.taskEdits({ taskId: args[3] })
  // Validate every copy before publishing any request. No signing key or database path is read.
  if (mode === 'validate') process.stdout.write(JSON.stringify({ state: 'validated', changes: proposals.map(value => ({ taskId: value.targetId, fields: Object.keys(value.payload), commandId: value.commandId })), notApplied: true }) + '\n')
  else {
    const results = []
    for (const proposal of proposals) results.push(await client.proposeUpdate(proposal))
    process.stdout.write(JSON.stringify({ state: 'submitted-for-app-review', results, notApplied: true }) + '\n')
  }
} catch (error) { process.stderr.write(`${error.code ?? error.message}\n`); process.exitCode = 1 }

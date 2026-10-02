import electron from 'electron'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, basename } from 'node:path'
const profile = process.argv[2]
if (!profile || basename(resolve(profile)) !== 'pdf-fixtures' || !resolve(profile).includes('qa-reminders-profile')) throw new Error('Pass a dedicated qa-reminders-profile/pdf-fixtures directory')
const child = spawn(electron, [fileURLToPath(new URL('./calendar-pdf-fixtures.cjs', import.meta.url)), '--user-data-dir=' + resolve(profile)], { windowsHide: true, stdio: 'inherit' })
const timer = setTimeout(() => { process.stderr.write('Fixture generation timed out; verify the process identity before stopping it.\n'); process.exitCode = 1 }, 30000)
child.on('error', error => { clearTimeout(timer); throw error })
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1 })

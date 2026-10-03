import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { createFileBridgeController } from './file-bridge-commands'
import { fileBridgeReceiptKey, fileBridgeScopeKey } from './file-bridge-types'
import { bridgeHarness, click, resetApp } from './command-test-harness'

it('two real coordinators apply the same request UUID independently; revoking A preserves B pending and manual25', async () => {
  await resetApp()
  const task = (title: string) => ({ ...newTaskInput(), title, scheduledDate: '2026-10-03', dueDate: '2026-10-10', score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 25 } })
  const a = await createTask(task('A のみ')), b = await createTask(task('B のみ')), harness = await bridgeHarness({taskIds:[a],fields:['notes','scheduled_date']})
  try {
    const sa = harness.status(), aid = sa.registration!.client.id, other = createFileBridgeController(harness.gateway)
    await other.configure({intendedHost:'claude_code',taskIds:[b],fields:['notes','scheduled_date'],lifetimeHours:1},click())
    const sb = await other.exportSnapshot(click()), bid = sb.registration!.client.id, id = crypto.randomUUID()
    await harness.writeCommand({command_id:id,type:'task.update',target_id:a,expected_revision:1,payload:{notes:'A の案'}})
    await writeFile(join(sb.root!,'inbox',`${id}.ready.json`),JSON.stringify({schema_version:'1',command_id:id,snapshot_id:sb.snapshot!.snapshot_id,expires_at:new Date(Date.now()+60000).toISOString(),type:'task.update',target_id:b,expected_revision:1,payload:{notes:'B の案'}}))
    await harness.gateway.selectClient!({clientId:aid})
    const scanA = await harness.controller.scanInbox(), entryA = scanA.entries.find(entry=>entry.state==='awaiting_approval')!
    if(entryA.state!=='awaiting_approval')throw Error('missing A')
    const pa = await harness.controller.prepare(entryA.reference)
    await harness.gateway.selectClient!({clientId:bid})
    const scanB = await other.scanInbox(), entryB = scanB.entries.find(entry=>entry.state==='awaiting_approval')!
    if(entryB.state!=='awaiting_approval')throw Error('missing B')
    const pb = await other.prepare(entryB.reference)
    const ra = await harness.controller.applyFromUI(pa,click())
    expect(ra.result?.client_id).toBe(aid)
    await harness.controller.disconnect(click())
    const rb = await other.applyFromUI(pb,click())
    expect(rb.result?.client_id).toBe(bid)
    expect(await db.commands.get(fileBridgeReceiptKey(id,aid))).toBeDefined();expect(await db.commands.get(fileBridgeReceiptKey(id,bid))).toBeDefined()
    const s = (await db.settings.get('main'))!
    expect(JSON.parse((await db.commands.get(fileBridgeScopeKey(s.profileId,s.datasetId,aid)))!.resultId).registration).toBeNull()
    expect(JSON.parse((await db.commands.get(fileBridgeScopeKey(s.profileId,s.datasetId,bid)))!.resultId).registration.client.id).toBe(bid)
    for(const [taskId,notes] of [[a,'A の案'],[b,'B の案']])expect(await db.tasks.get(taskId)).toMatchObject({notes,dueDate:'2026-10-10',score:{manualPoints:25},revision:2})
    expect(await db.ledger.count()).toBe(0);expect(await db.completions.count()).toBe(0)
  } finally { await harness.close() }
})

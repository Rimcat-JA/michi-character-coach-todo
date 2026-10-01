import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { completeTask } from './commands'
import { captureSnapshot, inspectBackup, restoreBackup } from './backup'
import { validateSnapshot, type Snapshot } from './backup-validation'
import { adoptHandoffFields, adoptHandoffTask, compareHandoff, inspectHandoff, keepLocalForHandoff, lastHandoffAt, replaceAfterExport, replaceWithHandoff } from './handoff'
import { computeHeads, computeRowIds } from './handoff-heads'
import { counts, exportFile, humanClick, manualTask, PASSWORD, resetDevices, setManualPoints, useDevice } from './device-test-fixtures'

beforeEach(() => resetDevices())
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** A (PC role) creates 25pt, B (second profile, emulation) takes it over, then both edit: B 30pt, A 40pt. */
async function divergedScenario() {
  await useDevice('A')
  const id = await manualTask('資料作成', 25)
  const first = await exportFile()
  await useDevice('B')
  await replaceWithHandoff(first.snapshot, { confirmDifferentDataset: true })
  await setManualPoints(id, 30)
  const second = await exportFile()
  await useDevice('A')
  await setManualPoints(id, 40)
  return { id, first, second }
}
const manual = async (id: string) => (await db.tasks.get(id))!.score.manualPoints

describe('I05 手動の引継ぎ確認（端末間の競合検知）', () => {
  it('base 25 / A 40 / B 30 は両方変更として手動ポイントを示し、黙った置き換えを拒否する', async () => {
    const { id, first, second } = await divergedScenario()
    expect(second.snapshot.handoff).toMatchObject({ kind: 'backup', base_bundle_id: first.snapshot.handoff!.bundle_id })
    const preview = await inspectHandoff(second.snapshot)
    expect(preview.sameDataset).toBe(true); expect(preview.comparison.baseKnown).toBe(true); expect(preview.comparison.blocking).toBe(true)
    const task = preview.comparison.tasks.find(row => row.taskId === id)!
    expect(task.state).toBe('both_changed'); expect(task.manualConflict).toBe(true)
    expect(task.diffs.find(diff => diff.field === 'manualPoints')).toMatchObject({ base: 25, local: 40, incoming: 30, changedBy: 'both' })
    await expect(replaceWithHandoff(second.snapshot)).rejects.toThrow('この端末だけの変更')
    expect(await manual(id)).toBe(40)
  })

  it('この端末を正本として維持すると40のまま、個別取込で30になり40の評価履歴は残る。台帳と完了は変えない', async () => {
    const { id, second } = await divergedScenario()
    const done = await manualTask('完了済みの別タスク', 10); await completeTask(done, 1)
    const before = await counts(), assessments = (await db.assessments.where('taskId').equals(id).toArray()).map(row => row.score.manualPoints)
    await keepLocalForHandoff(second.snapshot)
    expect(await manual(id)).toBe(40)
    const revision = (await db.tasks.get(id))!.revision
    await expect(adoptHandoffFields(second.snapshot, id, ['score'], revision, new Event('click'))).rejects.toThrow('本人確認')
    await adoptHandoffFields(second.snapshot, id, ['score'], revision, humanClick())
    expect(await manual(id)).toBe(30)
    const history = (await db.assessments.where('taskId').equals(id).toArray()).map(row => row.score.manualPoints)
    expect([...history].sort()).toEqual([...assessments, 30].sort()); expect(history).toContain(40); expect(history).toContain(25)
    const after = await counts()
    expect(after.ledger).toBe(before.ledger); expect(after.completions).toBe(before.completions); expect(after.assessments).toBe(before.assessments + 1)
    expect((await db.audits.where('taskId').equals(id).toArray()).map(row => row.operation)).toContain(`adopted_from_handoff:${second.snapshot.handoff!.bundle_id}`)
    // Re-importing the same file is idempotent: no new revision, one handoff record.
    const records = await db.handoffHeads.count(), next = (await db.tasks.get(id))!.revision
    await adoptHandoffFields(second.snapshot, id, ['score'], next, humanClick())
    await keepLocalForHandoff(second.snapshot)
    expect((await db.tasks.get(id))!.revision).toBe(next); expect(await db.handoffHeads.count()).toBe(records)
    expect((await inspectHandoff(second.snapshot)).comparison.tasks.find(row => row.taskId === id)!.state).toBe('identical')
  })

  it('書き出し後にこの端末だけで編集した場合はlocal_only、相手だけの変更はincoming_onlyとして置き換えられる', async () => {
    await useDevice('A')
    const id = await manualTask('週次報告', 25)
    const first = await exportFile()
    await useDevice('B')
    await replaceWithHandoff(first.snapshot, { confirmDifferentDataset: true })
    const unchanged = await exportFile()
    await useDevice('A')
    await setManualPoints(id, 40)
    const preview = await inspectHandoff(unchanged.snapshot)
    expect(preview.comparison.tasks.find(row => row.taskId === id)!.state).toBe('local_only'); expect(preview.comparison.blocking).toBe(true)
    // Reverse direction: A's new file on B is only an incoming change, so B may replace directly.
    const fromA = await exportFile()
    await useDevice('B')
    const reverse = await inspectHandoff(fromA.snapshot)
    expect(reverse.comparison.tasks.find(row => row.taskId === id)!.state).toBe('incoming_only'); expect(reverse.comparison.blocking).toBe(false)
    await replaceWithHandoff(fromA.snapshot)
    expect(await manual(id)).toBe(40)
  })

  it('引継ぎ情報のない旧形式のファイルは差分をすべて要確認にする', async () => {
    await useDevice('A')
    const id = await manualTask('旧形式', 25)
    const legacy = await captureSnapshot()
    expect(legacy.handoff).toBeUndefined()
    await setManualPoints(id, 40)
    const preview = await inspectHandoff(legacy)
    expect(preview.manifest).toBeNull(); expect(preview.comparison.baseKnown).toBe(false)
    expect(preview.comparison.tasks.find(row => row.taskId === id)!.state).toBe('needs_review'); expect(preview.comparison.blocking).toBe(true)
    await expect(replaceWithHandoff(legacy)).rejects.toThrow('この端末だけの変更')
    await expect(adoptHandoffFields(legacy, id, ['score'], (await db.tasks.get(id))!.revision, humanClick())).rejects.toThrow('引継ぎ情報のない')
  })

  it('改ざんした引継ぎ情報は使われない: 余分なheadsは拒否、不明なbaseは要確認、本文と違うデータセットは拒否', async () => {
    const { id, second } = await divergedScenario()
    const forged = structuredClone(second.snapshot) as Snapshot & { handoff: Record<string, unknown> }
    forged.handoff.heads = { [id]: { criticalHash: '0'.repeat(64) } }
    expect(() => validateSnapshot(forged)).toThrow('引継ぎ情報の項目')
    const otherDataset = structuredClone(second.snapshot); otherDataset.handoff = { ...otherDataset.handoff!, dataset_id: 'forged-dataset' }
    expect(() => validateSnapshot(otherDataset)).toThrow('データセット')
    const unknownBase = structuredClone(second.snapshot); unknownBase.handoff = { ...unknownBase.handoff!, base_bundle_id: 'forged-base' }
    const preview = await inspectHandoff(unknownBase)
    expect(preview.comparison.baseKnown).toBe(false); expect(preview.comparison.tasks.find(row => row.taskId === id)!.state).toBe('needs_review')
    // Even a base id that this device knows cannot hide B's 30: heads come from the incoming rows.
    const pointedAtMine = structuredClone(second.snapshot); pointedAtMine.handoff = { ...pointedAtMine.handoff!, base_bundle_id: (await db.handoffHeads.where('direction').equals('export').first())!.bundleId }
    expect((await inspectHandoff(pointedAtMine)).comparison.tasks.find(row => row.taskId === id)!.diffs.find(diff => diff.field === 'manualPoints')).toMatchObject({ local: 40, incoming: 30 })
  })

  it('「書き出してから置き換え」は書き出しが成功した後でだけ置き換える', async () => {
    const { id, second } = await divergedScenario()
    const failing = vi.fn(async () => { throw new Error('書き出し失敗（合成）') })
    await expect(replaceAfterExport(second.snapshot, PASSWORD, failing)).rejects.toThrow('書き出し失敗')
    expect(failing).toHaveBeenCalledOnce(); expect(await manual(id)).toBe(40)
    const order: string[] = []
    const exporter = vi.fn(async () => { order.push(`export:${await manual(id)}`) })
    await replaceAfterExport(second.snapshot, PASSWORD, exporter)
    order.push(`after:${await manual(id)}`)
    expect(order).toEqual(['export:40', 'after:30'])
    expect((await db.handoffHeads.get(`import:${second.snapshot.handoff!.bundle_id}`))!.decision).toBe('replaced_after_export')
  })

  it('別データセットのファイルは明示確認なしでは置き換えない', async () => {
    await useDevice('A'); await manualTask('Aのタスク', 25)
    const fromA = await exportFile()
    await useDevice('B'); const own = await manualTask('Bだけのタスク', 10)
    const preview = await inspectHandoff(fromA.snapshot)
    expect(preview.sameDataset).toBe(false); expect(preview.comparison.blocking).toBe(false)
    await expect(replaceWithHandoff(fromA.snapshot)).rejects.toThrow('別データセット')
    expect(await db.tasks.get(own)).toBeDefined()
    await replaceWithHandoff(fromA.snapshot, { confirmDifferentDataset: true })
    expect(await db.tasks.get(own)).toBeUndefined()
    expect(await lastHandoffAt()).not.toBeNull()
  })

  it('取込ファイルだけにある未完了タスクは個別に取り込め、完了記録つきは要手動対応として拒否する', async () => {
    await useDevice('A'); await manualTask('共通', 5)
    const first = await exportFile()
    await useDevice('B'); await replaceWithHandoff(first.snapshot, { confirmDifferentDataset: true })
    const created = await manualTask('Bで追加', 15), finished = await manualTask('Bで完了', 20); await completeTask(finished, 1)
    const fromB = await exportFile()
    await useDevice('A')
    const ledger = await db.ledger.count(), preview = await inspectHandoff(fromB.snapshot)
    expect(preview.comparison.tasks.find(row => row.taskId === created)!.state).toBe('created_incoming')
    await adoptHandoffTask(fromB.snapshot, created, humanClick())
    expect(await db.tasks.get(created)).toMatchObject({ title: 'Bで追加', status: 'open', revision: 1 })
    await expect(adoptHandoffTask(fromB.snapshot, finished, humanClick())).rejects.toThrow('要手動対応')
    expect(await db.ledger.count()).toBe(ledger)
  })

  it('比較は純粋関数で、ledgerなどこの端末だけの行があれば置き換えを止める', async () => {
    await useDevice('A')
    const id = await manualTask('台帳', 10)
    await completeTask(id, 1)
    const local = await captureSnapshot(), incoming = structuredClone(local)
    incoming.ledger = []; incoming.completions = []; incoming.tasks = incoming.tasks.map(task => ({ ...task, status: 'open' as const }))
    const side = async (row: Snapshot) => ({ heads: await computeHeads(row), rowIds: computeRowIds(row) })
    const result = compareHandoff(await side(local), await side(incoming), await side(local))
    expect(result.localOnlyRows).toMatchObject({ ledger: 1, completions: 1 }); expect(result.blocking).toBe(true)
    expect(result.tasks[0]).toMatchObject({ state: 'incoming_only', completionConflict: true })
  })
})

describe('I05 端末固有の表はバックアップに入らず、復元でも消えない', () => {
  it('localDeviceとhandoffHeadsは書き出さず、復元後も残る。旧形式（引継ぎ情報なし）も復元できる', async () => {
    await useDevice('A')
    await manualTask('端末固有', 25)
    const file = await exportFile(), device = (await db.localDevice.get('main'))!
    expect(Object.keys(file.snapshot)).not.toContain('localDevice'); expect(Object.keys(file.snapshot)).not.toContain('handoffHeads'); expect(Object.keys(file.snapshot)).not.toContain('datasetState')
    expect(file.snapshot.handoff!.source_device_id).toBe(device.deviceId)
    const plain = JSON.stringify(file.snapshot.tasks) + JSON.stringify(file.snapshot.settings)
    expect(plain).not.toContain(device.deviceId)
    const legacy = structuredClone(file.snapshot); delete legacy.handoff
    await restoreBackup(legacy)
    expect(await db.localDevice.get('main')).toEqual(device); expect(await db.handoffHeads.count()).toBe(1)
    await restoreBackup(await inspectBackup(new File([file.text], 'x.coachbundle'), PASSWORD))
    expect(await db.localDevice.get('main')).toEqual(device)
  })
})

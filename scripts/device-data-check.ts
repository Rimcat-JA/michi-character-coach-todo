import { db, ensureSettings } from '../src/db'
import { createTask, newTaskInput } from '../src/commands'
import { emptyScore } from '../src/domain'
import { captureSnapshot, restoreBackup } from '../src/backup'
import { recordHandoff, stampHandoff } from '../src/handoff-heads'
import { handoffReplacementGuard, inspectHandoff, replaceWithHandoff } from '../src/handoff'
import type { Snapshot } from '../src/backup-validation'
import { generateShareIdentity, sealShareEnvelope } from '../src/share-crypto'
import type { ShareCard } from '../src/share-types'
import { importShareBundle, listSharedInbound } from '../src/share-inbox'
import { purgeExpiredSharedInbound } from '../src/share-lifetime'

function check(value: unknown, label: string): asserts value { if (!value) throw Error(label) }
async function bundle() {
  const snapshot = await captureSnapshot()
  snapshot.handoff = await stampHandoff(snapshot, 'backup')
  await recordHandoff(snapshot, 'export', 'exported')
  return snapshot
}
Object.assign(window, { deviceDataCheck: {
  ready: async () => { await ensureSettings(); return true },
  seed: async () => {
    const taskId = await createTask({ ...newTaskInput(), title: 'Chromium引継ぎ', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
    await db.taskNotes.add({ id: 'note-1', taskId, ownerId: (await db.settings.get('main'))!.profileId, kind: 'self', body: 'base', createdAt: new Date().toISOString() })
    return bundle()
  },
  acceptAndEdit: async (snapshot: Snapshot) => {
    await replaceWithHandoff(snapshot, { confirmDifferentDataset: true })
    await db.taskNotes.update('note-1', { body: 'incoming' })
    return bundle()
  },
  protect: async (snapshot: Snapshot) => {
    check(!(await inspectHandoff(snapshot)).comparison.blocking, 'INCOMING_ONLY_BLOCKED')
    const guard = await handoffReplacementGuard(snapshot)
    await db.taskNotes.update('note-1', { body: 'local' })
    const preview = await inspectHandoff(snapshot)
    check(preview.comparison.rowConflicts?.some(row => row.table === 'taskNotes' && row.state === 'both_changed'), 'ROW_CONFLICT_MISSING')
    let blocked = false
    try { await restoreBackup(snapshot, { beforeReplace: guard }) } catch (error) { blocked = String(error).includes('この端末だけの変更') }
    check(blocked, 'RESTORE_GUARD_MISSING')
    check((await db.taskNotes.get('note-1'))?.body === 'local', 'LOCAL_NOTE_LOST')
    check(await db.ledger.count() === 0, 'LEDGER_MUTATED')
    return { concurrentRestoreBlocked: true, localNotePreserved: true, ledger: 0 }
  },
  identity: async () => {
    // Synthetic fixture setup, NOT the native consent path or a real second person.
    const identity = await generateShareIdentity('Synthetic profile')
    await db.shareIdentity.put(identity)
    const stored = (await db.shareIdentity.get('main'))!
    check(!stored.signKeys.privateKey.extractable && !stored.dhKeys.privateKey.extractable, 'EXTRACTABLE_PRIVATE_KEY')
    return stored.card
  },
  grantFile: async (recipient: ShareCard) => {
    const sender = (await db.shareIdentity.get('main'))!
    return sealShareEnvelope({ kind: 'grant', shareId: 'synthetic-share-1', epoch: 1, sequence: 1, sender, recipient,
      payload: { role: 'viewer', shared_fields: ['title'], projection: { share_task_id: 'synthetic-share-1', title: '選択した項目のみ' }, share_note: '共有メモ', expires_at: new Date(Date.now() + 86400000).toISOString() } })
  },
  receiveAndExpire: async (raw: string, owner: ShareCard) => {
    await db.shareContacts.put({ id: owner.fingerprint, displayName: owner.display_name, card: owner, relation: 'owner', verifiedAt: new Date().toISOString(), createdAt: new Date().toISOString() })
    const before = { tasks: await db.tasks.count(), ledger: await db.ledger.count() }
    const imported = await importShareBundle(raw)
    check(imported.status === 'stored', 'SHARE_IMPORT_FAILED')
    check((await listSharedInbound()).length === 1, 'SHARE_NOT_VISIBLE')
    const row = (await db.sharedInbound.get('synthetic-share-1'))!
    await purgeExpiredSharedInbound(Date.parse(row.expiresAt!)) // Explicit synthetic deadline, not an OS clock change.
    const tombstone = (await db.sharedInbound.get(row.id))!
    check(!tombstone.projection && !tombstone.shareNote && !tombstone.sharedFields.length, 'EXPIRED_CONTENT_RETAINED')
    let rejected = false
    try { await importShareBundle(raw) } catch { rejected = true }
    check(rejected, 'EXPIRED_REPLAY_ACCEPTED')
    check(await db.tasks.count() === before.tasks && await db.ledger.count() === before.ledger, 'SHARE_CHANGED_PERSONAL_DATA')
    return { nonExtractableKeysPersisted: true, encryptedShareImported: true, expiryClearedContent: true, replayRejected: true, personalDataUnchanged: true }
  },
} })

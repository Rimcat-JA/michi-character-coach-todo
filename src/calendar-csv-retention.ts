import { db } from './db'
import { canonicalJSON } from './canonical'
import { changePolicyFor } from './change-set'
import { clearCalendarRulesAuthority } from './calendar-rules-save'
import { redactExpiredCSVRecords } from './calendar-csv-redaction'
import { validateCalendarRulesState } from './calendar-rules-validation'
import { clearCalendarCSVImportAuthority } from './calendar-csv-import-save'

let running: Promise<void> | null = null
/** Called on startup, expiry ticks and before capture. No event or completion is canceled. */
export async function purgeExpiredCSVOriginals(at = new Date().toISOString()): Promise<void> {
  if (running) return running
  running = db.transaction('rw', [db.calendarRules, db.calendarEvents, db.audits, db.commands, db.settings], async () => {
    const settings = await db.settings.get('main'); if (!settings) return
    const original = { calendarRules: await db.calendarRules.toArray(), calendarEvents: await db.calendarEvents.toArray(), audits: await db.audits.toArray(), commands: await db.commands.toArray() }
    const result = redactExpiredCSVRecords(original, at), clean = { calendarRules: result.calendarRules, calendarEvents: result.calendarEvents, audits: result.audits, commands: result.commands }
    if (canonicalJSON(original) === canonicalJSON(clean)) return
    const policy = changePolicyFor(settings)
    if (!Number.isSafeInteger(policy.epoch + 1) || !Number.isSafeInteger(policy.sourcePermissionRevision + 1)) throw new Error('CSV資料の権限版が上限に達しています')
    clean.calendarRules.forEach(state => validateCalendarRulesState(state, settings.profileId, settings.datasetId))
    await db.calendarRules.bulkPut(clean.calendarRules); await db.calendarEvents.bulkPut(clean.calendarEvents); await db.audits.bulkPut(clean.audits); await db.commands.bulkPut(clean.commands)
    await db.settings.put({ ...settings, changePolicy: { ...policy, epoch: policy.epoch + 1, sourcePermissionRevision: policy.sourcePermissionRevision + 1 } })
    clearCalendarRulesAuthority()
    clearCalendarCSVImportAuthority()
  })
  try { await running } finally { running = null }
}

import { db } from './db'
import { allowWhileFrozen } from './dataset-guard'
import { canonicalJSON } from './canonical'
import { changePolicyFor } from './change-set'
import { clearCalendarRulesAuthority } from './calendar-rules-save'
import { redactExpiredICSRecords } from './calendar-import-redaction'
import { validateCalendarRulesState } from './calendar-rules-validation'
import { purgeScheduleRefreshInbox } from './schedule-refresh'

let running: Promise<void> | null = null
/** Call on startup, expiry tick and before capture. No event is cancelled. */
export async function purgeExpiredCalendarOriginals(at = new Date().toISOString()): Promise<void> {
  if (running) return running
  running = db.transaction('rw', [db.calendarRules, db.calendarEvents, db.audits, db.commands, db.settings], async () => {
    allowWhileFrozen()
    const settings = await db.settings.get('main'); if (!settings) return
    const records = { calendarRules: await db.calendarRules.toArray(), calendarEvents: await db.calendarEvents.toArray(), audits: await db.audits.toArray(), commands: await db.commands.toArray() }, result = redactExpiredICSRecords(records, at)
    if (canonicalJSON(records) === canonicalJSON({ calendarRules: result.calendarRules, calendarEvents: result.calendarEvents, audits: result.audits, commands: result.commands })) return
    const policy = changePolicyFor(settings)
    if (!Number.isSafeInteger(policy.epoch + 1) || !Number.isSafeInteger(policy.sourcePermissionRevision + 1)) throw new Error('資料の権限版が上限に達しています')
    result.calendarRules.forEach(state => validateCalendarRulesState(state, settings.profileId, settings.datasetId))
    await db.calendarRules.bulkPut(result.calendarRules); await db.calendarEvents.bulkPut(result.calendarEvents); await db.audits.bulkPut(result.audits); await db.commands.bulkPut(result.commands)
    await db.settings.put({ ...settings, changePolicy: { ...policy, epoch: policy.epoch + 1, sourcePermissionRevision: policy.sourcePermissionRevision + 1 } })
    clearCalendarRulesAuthority()
  })
  try { await running; await purgeScheduleRefreshInbox(at) } finally { running = null }
}

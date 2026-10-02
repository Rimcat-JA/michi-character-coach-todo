import { db, ensureSettings } from './db'
import { uid } from './domain'
import { eventOrigin } from './calendar-event-origin'
export async function updateCalendarEventLocally(id: string, expectedRevision: number, input: { title: string; startAt: string; endAt: string }, event: Event) {
  if (!(event instanceof Event) || !event.isTrusted || !['click', 'submit'].includes(Object.getOwnPropertyDescriptor(Event.prototype, 'type')!.get!.call(event))) throw new Error('予定の本人確認ボタンから保存してください')
  if (Object.keys(input).length !== 3 || !input.title?.trim() || input.title.length > 300 || [input.startAt, input.endAt].some(at => !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) || input.endAt <= input.startAt) throw new Error('予定の名前・UTC日時・順序を確認してください')
  const settings = await ensureSettings()
  await db.transaction('rw', db.calendarEvents, db.calendarRules, db.settings, db.audits, async () => {
    const current = await db.calendarEvents.get(id), latest = await db.settings.get('main')
    if (!current || current.ownerId !== settings.profileId || latest?.profileId !== settings.profileId || latest.datasetId !== settings.datasetId || (current.revision ?? 1) !== expectedRevision) throw new Error('予定の本人・保存先・版が変わりました')
    if (!Number.isSafeInteger(expectedRevision + 1)) throw new Error('予定の版が上限に達しました')
    const origin = eventOrigin(current, await db.calendarRules.get('main')), at = new Date().toISOString()
    await db.calendarEvents.put({ ...current, ...input, title: input.title.trim(), revision: expectedRevision + 1, updatedAt: at, locallyEdited: origin.kind === 'imported' })
    await db.audits.add({ id: uid(), taskId: null, operation: 'calendar.event.local_edit', at, detail: JSON.stringify({ eventId: id, fromRevision: expectedRevision, toRevision: expectedRevision + 1, origin, externalWrite: false }) })
  })
}

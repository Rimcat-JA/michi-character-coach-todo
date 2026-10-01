import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { updateTask } from './commands'
import { captureSnapshot } from './backup'
import { adoptDetectedTask, enableSyntheticAI, secretQuote } from './source-quote-fixtures'
import { maskSourceReferences, projectTask, resolveSharedSourceLink, SHARE_MASKED_SOURCE, validateProjection, validateShareNote } from './share-projection'
import { checkShareNote, previewSharePayload } from './share-grants'
import { humanClick, inputOf, resetDevices, switchDevice } from './device-test-fixtures'
import { ensureShareIdentity } from './share-identity'

beforeEach(async () => { resetDevices(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z')); await switchDevice('owner-A') })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('I06 共有用の投影（17.4: 共有用本文と個人のsource refを分離）', () => {
  it('検出から採用したタスクを投影しても、メモ・引用・source id・資料の件数は含まれない', async () => {
    await enableSyntheticAI()
    const { taskId, sourceId } = await adoptDetectedTask()
    // Legacy rows may still carry the citation in notes; it must not travel either.
    const task = (await db.tasks.get(taskId))!
    await updateTask(taskId, task.revision, { ...inputOf(task), notes: `${task.notes}\n[${sourceId} 1 span-1] ${secretQuote}` })
    expect(await db.taskSourceEvidence.where('taskId').equals(taskId).count()).toBeGreaterThan(0)
    const payload = await previewSharePayload({ taskId, role: 'viewer', sharedFields: ['title', 'status', 'scheduled_date', 'due_date', 'effective_points'], shareNote: '' }, 'share-x')
    const text = JSON.stringify(payload)
    expect(Object.keys(payload.projection).sort()).toEqual(['due_date', 'effective_points', 'scheduled_date', 'share_task_id', 'status', 'title'])
    expect(text).not.toContain(secretQuote.slice(0, 12)); expect(text).not.toContain(sourceId); expect(text).not.toContain('notes'); expect(text).not.toContain('source')
    expect(text).not.toContain('仕事Slack')
  })

  it('個人資料の原文を20文字以上含む共有メモと資料参照は拒否し、本人の短い一言は通す', async () => {
    await enableSyntheticAI()
    const { sourceId } = await adoptDetectedTask()
    await expect(checkShareNote(`参考: ${secretQuote}`)).rejects.toThrow('20文字以上')
    await expect(checkShareNote(`詳細は [${sourceId} 1 span] を見て`)).rejects.toThrow('参照')
    await expect(checkShareNote('michi://source/anything を参照')).rejects.toThrow('参照')
    expect(await checkShareNote('  金曜までに確認お願いします  ')).toBe('金曜までに確認お願いします')
    expect(() => validateShareNote('あ'.repeat(2001), [], [])).toThrow('2000')
  })

  it('タイトル内の出典リンクは隠し、受け手の出典解決は存在してもしなくても同じ文言になる', async () => {
    expect(maskSourceReferences('見積 michi://source/abc123 を送る')).toBe(`見積 ［${SHARE_MASKED_SOURCE}］ を送る`)
    expect(resolveSharedSourceLink('michi://source/real-source-id')).toBe(resolveSharedSourceLink('michi://source/random-404'))
    expect(resolveSharedSourceLink('[real-source-id 1 span]')).toBe(SHARE_MASKED_SOURCE)
    const task = { id: 't', title: '件名 michi://source/zz', status: 'open', scheduledDate: '2026-10-05', dueDate: null, effectivePoints: 25 } as Parameters<typeof projectTask>[0]
    const projection = projectTask(task, undefined, 'share-1', ['title', 'effective_points'])
    expect(projection).toEqual({ share_task_id: 'share-1', title: `件名 ［${SHARE_MASKED_SOURCE}］`, effective_points: 25 })
    expect(() => validateProjection({ ...projection, notes: 'x' }, 'share-1', ['title', 'effective_points'])).toThrow('項目')
    expect(() => validateProjection(projection, 'share-1', ['title'])).toThrow('項目')
  })

  it('共有の鍵・相手・付与の表はスナップショットに入らない', async () => {
    await ensureShareIdentity('所有者A', humanClick())
    const snapshot = await captureSnapshot(), keys = Object.keys(snapshot)
    for (const table of ['shareIdentity', 'shareContacts', 'resourceGrants', 'sharedInbound', 'shareProposals', 'localDevice', 'handoffHeads']) expect(keys).not.toContain(table)
    expect(JSON.stringify(snapshot)).not.toContain((await db.shareIdentity.get('main'))!.card.fingerprint)
  })
})

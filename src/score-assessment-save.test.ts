import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { newTaskInput } from './commands'
import { emptyScore } from './domain'
import { assessmentProvenance, saveTaskWithScoreProvenance } from './score-assessment-save'
import type { ScoreAcceptanceProvenance } from './score-assist'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
const provenance: ScoreAcceptanceProvenance = { ruleVersion: 'v1', model: 'provider/model', sourceText: '作業30分', estimated: true, fields: [{ field: 'minutes', value: 30, origin: 'ai_estimate', evidence: '作業30分' }] }

it('本人の25ptを保持し、評価ID付きの属性出典を保存する', async () => {
  const input = { ...newTaskInput(), title: '作業30分', score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 25, minutes: 30 } }
  const id = await saveTaskWithScoreProvenance(null, input, provenance)
  const task = (await db.tasks.get(id))!
  expect(task.effectivePoints).toBe(25)
  expect(assessmentProvenance(await db.audits.toArray(), task.assessmentId)).toMatchObject({ estimated: true, sourceText: '作業30分' })
  expect(await db.ledger.count()).toBe(0)
})

it('採用後の本人編集をAI推定と誤表示せず、版競合で出典も追加しない', async () => {
  const input = { ...newTaskInput(), title: '作業30分', score: { ...emptyScore(), minutes: 45 } }
  const id = await saveTaskWithScoreProvenance(null, input, provenance)
  const task = (await db.tasks.get(id))!
  expect(assessmentProvenance(await db.audits.toArray(), task.assessmentId)).toMatchObject({ estimated: false, fields: [{ value: 45, origin: 'human', evidence: null }] })
  const before = await db.audits.count()
  await expect(saveTaskWithScoreProvenance({ ...task, revision: 0 }, input, provenance)).rejects.toThrow('別の画面')
  expect(await db.audits.count()).toBe(before)
})

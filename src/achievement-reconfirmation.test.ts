import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { achievementCompletionDigest, buildAchievementManifest, completionScoreMode, type AchievementExport, type AchievementFacts } from './achievements'
import { achievementTestFacts, achievementTestGateway, achievementTestSelection, achievementTestTime } from './achievements-test-fixtures'
import { calculateScore, emptyScore } from './domain'
import { contentDigest } from './canonical'

const require = createRequire(import.meta.url)
const { validateGitHubPublicationFacts, buildGitHubPublicFiles } = require('../electron/github-publication-facts.cjs')
const { githubValueDigest } = require('../electron/github-publish.cjs')
const referenceId = 'zz-explicit-reconfirmed-assessment'
const restoreId = 'explicit-reconfirmation-restore'

async function reconfirmedFacts(createdAt = achievementTestTime, points = 3) {
  const facts = await achievementTestFacts(14, 'formula'), score = { ...emptyScore(), mode: 'manual' as const, manualPoints: points }
  facts.assessments.push({ id: referenceId, taskId: facts.task.id, origin: 'human', ruleVersion: 'v1', score, result: calculateScore(score), createdAt })
  Object.assign(facts.completion, { currentAt: achievementTestTime, netPoints: points, lastConfirmedPoints: points, reconfirmedAssessmentId: referenceId })
  facts.ledger.push(
    { id: 'original-reverse', taskId: facts.task.id, completionId: facts.completion.id, kind: 'reverse', delta: -14, at: achievementTestTime, reason: '原実績を取消' },
    { id: restoreId, taskId: facts.task.id, completionId: facts.completion.id, kind: 'restore', delta: points, at: achievementTestTime, reason: '本人が実績を再確認', assessmentId: referenceId },
  )
  facts.policy.threshold = 0
  return facts
}

async function nativeFixture(facts: AchievementFacts) {
  const manifest = await buildAchievementManifest({ facts, selection: achievementTestSelection, gateway: achievementTestGateway,
    exportId: 'aaaaaaaa-1234-4234-8234-aaaaaaaaaaaa', publicId: 'bbbbbbbb-1234-4234-8234-bbbbbbbbbbbb', policyEpoch: 0, sourcePermissionRevision: 0,
    previous: null, published: [], preparedAt: achievementTestTime, expiresAt: '2026-10-01T04:00:00.000Z' })
  const row = { id: manifest.exportId, publicId: manifest.publicId, manifest, taskId: facts.task.id, completionId: facts.completion.id,
    repositoryId: 42, ownerId: facts.settings.profileId, datasetId: facts.settings.datasetId, state: 'approved', approvedBy: facts.settings.profileId,
    approvedAt: achievementTestTime, selection: structuredClone(achievementTestSelection), previousCommitSha: null, commitSha: null,
    summary: { title: achievementTestSelection.title, body: achievementTestSelection.body, points: facts.completion.netPoints!, scoreMode: completionScoreMode(facts.completion, facts.assessments, facts.ledger), completionAt: facts.completion.originalAt, canceled: false },
    evidenceRefs: facts.evidence.map(item => ({ id: item.id, revision: item.revision, publicRevision: item.publicRevision, originalSha256: item.origin.sha256, publicSha256: item.publicSha256 })) } as AchievementExport
  const evidence = facts.evidence[0]
  return { row, configuration: { id: manifest.configurationId, revision: manifest.authorizationRevision, ownerId: facts.settings.profileId,
    datasetId: facts.settings.datasetId, repository: achievementTestGateway.repository }, facts: { ...facts, row,
    attachments: [{ id: evidence.origin.id, taskId: facts.task.id, ownerId: facts.settings.profileId, sha256: evidence.origin.sha256,
      actualSha256: evidence.origin.sha256, size: evidence.origin.size, actualSize: evidence.origin.size, mediaType: evidence.origin.mediaType }], notes: [], published: [] } }
}

describe('再確認実績の公開記録に対する独立検証', () => {
  it('参照がない旧実績のdigestを従来の3項目と同じに保つ', async () => {
    const facts = await achievementTestFacts(14, 'formula'), expected = { completion: facts.completion,
      ledger: facts.ledger.slice().sort((a, b) => a.id.localeCompare(b.id)), originalAssessment: facts.assessments[0] }
    expect(await achievementCompletionDigest(facts)).toBe(await contentDigest(expected))
    expect(await achievementCompletionDigest(facts)).toBe(githubValueDigest(expected))
    facts.policy.threshold = 0
    const native = await nativeFixture(facts)
    expect(() => validateGitHubPublicationFacts(native.facts, native.configuration)).not.toThrow()
  })

  it.each([achievementTestTime, '2026-09-30T03:00:00.000Z'])('本人評価の日時 %s が原完了以前でも原評価を置き換えずTS/nativeが一致する', async createdAt => {
    const facts = await reconfirmedFacts(createdAt), expected = { completion: facts.completion,
      ledger: facts.ledger.slice().sort((a, b) => a.id.localeCompare(b.id)), originalAssessment: facts.assessments[0], reconfirmationAssessments: [facts.assessments[1]] }
    expect(await achievementCompletionDigest(facts)).toBe(await contentDigest(expected))
    expect(await achievementCompletionDigest(facts)).toBe(githubValueDigest(expected))
    expect(completionScoreMode(facts.completion, facts.assessments, facts.ledger)).toBe('manual')
    const native = await nativeFixture(facts)
    expect(() => validateGitHubPublicationFacts(native.facts, native.configuration)).not.toThrow()
    expect(buildGitHubPublicFiles({ row: native.row, completion: facts.completion, assessment: facts.assessments[0], evidence: facts.evidence, published: [], ledger: facts.ledger })).toEqual(native.row.manifest.files)
    const record = JSON.parse(native.row.manifest.files[0].content)
    expect(record).toMatchObject({ points: 3, scoreMode: 'manual', completionAt: facts.completion.originalAt })
    expect(facts.completion.originalPoints).toBe(14)
    expect(facts.task.effectivePoints).toBe(14)
  })

  it('再確認0ptも確定したmanual実績としてTS/native双方で保持する', async () => {
    const facts = await reconfirmedFacts(achievementTestTime, 0), native = await nativeFixture(facts)
    expect(() => validateGitHubPublicationFacts(native.facts, native.configuration)).not.toThrow()
    expect(JSON.parse(native.row.manifest.files[0].content)).toMatchObject({ points: 0, scoreMode: 'manual' })
  })

  it('本人評価3ptの参照を保ち後続の明示訂正2ptを公開する', async () => {
    const facts = await reconfirmedFacts()
    facts.completion.netPoints = 2
    facts.completion.lastConfirmedPoints = 2
    facts.ledger.push({ id: 'later-adjust', taskId: facts.task.id, completionId: facts.completion.id, kind: 'adjust', delta: -1, at: achievementTestTime, reason: '本人の後日訂正' })
    const native = await nativeFixture(facts)
    expect(() => validateGitHubPublicationFacts(native.facts, native.configuration)).not.toThrow()
    expect(JSON.parse(native.row.manifest.files[0].content)).toMatchObject({ points: 2, scoreMode: 'manual' })
    expect(facts.assessments[1].score.manualPoints).toBe(3)
    expect(facts.ledger.find(item => item.id === restoreId)!.delta).toBe(3)
  })

  it('過去の各再確認評価をID順で束縛し配列順序に依存しない', async () => {
    const facts = await reconfirmedFacts(), earlierScore = { ...emptyScore(), mode: 'manual' as const, manualPoints: 5 }
    facts.assessments.push({ id: 'aa-earlier-reconfirmation', taskId: facts.task.id, score: earlierScore, result: calculateScore(earlierScore), origin: 'human', ruleVersion: 'v1', createdAt: achievementTestTime })
    facts.ledger.push({ id: 'earlier-restore', taskId: facts.task.id, completionId: facts.completion.id, kind: 'restore', delta: 5, at: achievementTestTime, reason: '先の本人確認', assessmentId: 'aa-earlier-reconfirmation' },
      { id: 'earlier-reverse', taskId: facts.task.id, completionId: facts.completion.id, kind: 'reverse', delta: -5, at: achievementTestTime, reason: '先の確認を取消' })
    const digest = await achievementCompletionDigest(facts), native = await nativeFixture(facts)
    expect(() => validateGitHubPublicationFacts(native.facts, native.configuration)).not.toThrow()
    facts.assessments.reverse(); facts.ledger.reverse()
    expect(await achievementCompletionDigest(facts)).toBe(digest)
    expect(() => validateGitHubPublicationFacts(native.facts, native.configuration)).not.toThrow()
  })

  it.each(['date', 'score-detail'] as const)('参照評価の %s だけの改変も既存native承認を失効する', async change => {
    const facts = await reconfirmedFacts(), native = await nativeFixture(facts), before = await achievementCompletionDigest(facts)
    if (change === 'date') facts.assessments[1].createdAt = '2026-09-29T03:00:00.000Z'
    else facts.assessments[1].score.minutes = 10
    expect(await achievementCompletionDigest(facts)).not.toBe(before)
    expect(() => validateGitHubPublicationFacts(native.facts, native.configuration)).toThrow('COMPLETION_CHANGED')
  })

  it.each(['missing', 'duplicate', 'other-task', 'routine', 'allocated', 'amount', 'result', 'instruction', 'entry-kind', 'empty-id', 'marker-unreferenced', 'cache-missing', 'cache-null', 'cache-negative', 'invalid-score'] as const)('%s の本人評価参照をTS/native双方が拒否する', async invalid => {
    const facts = await reconfirmedFacts(), native = await nativeFixture(facts), assessment = facts.assessments[1], entry = facts.ledger.find(item => item.id === restoreId)!
    if (invalid === 'missing') facts.assessments.splice(1, 1)
    if (invalid === 'duplicate') facts.assessments.push(structuredClone(assessment))
    if (invalid === 'other-task') assessment.taskId = 'another-task'
    if (invalid === 'routine') assessment.origin = 'routine'
    if (invalid === 'allocated') assessment.score.mode = 'allocated'
    if (invalid === 'amount') { assessment.score.manualPoints = 4; assessment.result = calculateScore(assessment.score) }
    if (invalid === 'result') assessment.result.effective = 4
    if (invalid === 'instruction') Object.assign(assessment, { instruction: {} })
    if (invalid === 'entry-kind') entry.kind = 'adjust'
    if (invalid === 'empty-id') entry.assessmentId = ''
    if (invalid === 'marker-unreferenced') facts.completion.reconfirmedAssessmentId = facts.assessments[0].id
    if (invalid === 'cache-missing') delete facts.completion.lastConfirmedPoints
    if (invalid === 'cache-null') facts.completion.lastConfirmedPoints = null
    if (invalid === 'cache-negative') facts.completion.lastConfirmedPoints = -1
    if (invalid === 'invalid-score') assessment.score.minutes = -1
    await expect(achievementCompletionDigest(facts)).rejects.toThrow()
    expect(() => validateGitHubPublicationFacts(native.facts, native.configuration)).toThrow('RECONFIRMATION_ASSESSMENT_INVALID')
  })
})

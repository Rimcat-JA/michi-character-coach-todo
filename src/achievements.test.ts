/// <reference types="node" />
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { achievementCompletionDigest, achievementDraftFor, achievementTextHash, buildAchievementManifest, completionScoreMode, evaluateAchievement, localAchievementPoints, publicAchievementText, type AchievementExport, type AchievementFacts } from './achievements'
import { achievementTestFacts, achievementTestGateway, achievementTestSelection, achievementTestTime } from './achievements-test-fixtures'
import { restoreAchievementExports, validateAchievementExport, verifyAchievementDigests } from './achievements-validation'
import type { GitHubPublishManifest } from './github-publish-types'

const require = createRequire(import.meta.url)
const { validateGitHubPublicationFacts } = require('../electron/github-publication-facts.cjs') as { validateGitHubPublicationFacts: (facts: unknown, configuration: unknown) => { completionId: string } }
const publicId = 'abcdabcd-1234-4234-8234-abcdabcdabcd'
async function preview(facts?: AchievementFacts, published: AchievementExport[] = []) {
  return buildAchievementManifest({ facts: facts ?? await achievementTestFacts(), selection: achievementTestSelection, gateway: achievementTestGateway, exportId: 'eeeeeeee-1234-4234-8234-eeeeeeeeeeee', publicId, policyEpoch: 0, sourcePermissionRevision: 0, previous: null, published, preparedAt: achievementTestTime, expiresAt: '2026-10-01T03:15:00.000Z' })
}
function rowFor(manifest: GitHubPublishManifest, points = 40): AchievementExport {
  return { id: manifest.exportId, ownerId: manifest.ownerId, datasetId: manifest.datasetId, repositoryId: 42, completionId: 'private-completion-id', taskId: 'private-task-id', publicId, revision: 1, state: 'committing', manifest, summary: { title: achievementTestSelection.title, body: achievementTestSelection.body, points, scoreMode: 'manual', completionAt: achievementTestTime, canceled: false }, selection: achievementTestSelection, publishedSummary: null, evidenceRefs: [{id:'evidence-id',revision:1,publicRevision:1,originalSha256:'f'.repeat(64),publicSha256:'e'.repeat(64)}], approvedAt: achievementTestTime, approvedBy: manifest.ownerId, attemptId: 'attempt-id', attemptStartedAt: achievementTestTime, attemptCount: 1, commitSha: null, branch: null, recordPath: `records/2026/10/${publicId}.json`, publishedAt: null, url: null, pullRequestUrl: null, contribution: 'not_published', failureCode: null, previousCommitSha: null, history: [], createdAt: achievementTestTime, updatedAt: achievementTestTime }
}
describe('本人証拠付き実績の評価と公開文章', () => {
  it('訂正と取消しの全ファイルがnative側で同じbytesに再構築され、公開元の情報を承認hashへ含める', async () => {
    const original=await preview(await achievementTestFacts(100)),previous={...rowFor(original,100),state:'published' as const,commitSha:'b'.repeat(40)}
    for(const canceled of [false,true]){
      const facts=await achievementTestFacts(100);facts.completion.netPoints=canceled?0:80;facts.ledger.push({...facts.ledger[0],id:'adjustment',kind:canceled?'reverse':'adjust',delta:canceled?-100:-20})
      if(canceled){facts.completion.currentAt=null;facts.task.status='open'}
      const selection={...achievementTestSelection,correctionReason:canceled?'完了取消':'本人の訂正'}
      const manifest=await buildAchievementManifest({facts,selection,gateway:achievementTestGateway,exportId:original.exportId,publicId,policyEpoch:0,sourcePermissionRevision:0,previous,published:[previous],preparedAt:achievementTestTime,expiresAt:'2026-10-01T03:15:00.000Z'})
      const row={...rowFor(manifest,canceled?0:80),selection,previousCommitSha:previous.commitSha,summary:{...rowFor(manifest).summary,points:canceled?0:80,canceled},evidenceRefs:facts.evidence.map(item=>({id:item.id,revision:item.revision,publicRevision:item.publicRevision,originalSha256:item.origin.sha256,publicSha256:item.publicSha256}))}
      const nativeFacts={...facts,row,published:[previous],attachments:[{id:'private-attachment-id',taskId:facts.task.id,ownerId:facts.settings.profileId,sha256:facts.evidence[0].origin.sha256,actualSha256:facts.evidence[0].origin.sha256,size:facts.evidence[0].origin.size,actualSize:facts.evidence[0].origin.size,mediaType:'text/plain'}],notes:[]}
      expect(validateGitHubPublicationFacts(nativeFacts,{id:achievementTestGateway.configurationId,revision:1,ownerId:facts.settings.profileId,datasetId:facts.settings.datasetId,repository:achievementTestGateway.repository}).completionId).toBe(facts.completion.id)
      expect(manifest.publicationSequence).toBe(1);expect(manifest.previousCommitSha).toBe(previous.commitSha);expect(manifest.previousFileBlobShas).toHaveLength(2)
      const record=JSON.parse(manifest.files[0].content);expect(record.correction.canceled).toBe(canceled);expect(record.points).toBe(canceled?0:80)
    }
  })
  it('40pt既定で原本証拠がなければ待機し、未知は0pt扱いしない', async () => {
    const facts = await achievementTestFacts()
    facts.evidence = []
    expect(evaluateAchievement(facts).state).toBe('awaiting_evidence')
    expect(evaluateAchievement(await achievementTestFacts(null)).state).toBe('awaiting_score')
    expect(evaluateAchievement(await achievementTestFacts(39)).state).toBe('not_eligible')
  })
  it('自己申告だけでは添付原本要件を満たさない', async () => {
    const facts = await achievementTestFacts(), item = facts.evidence[0]
    item.kind = 'user_statement'; item.verification = 'self_reported'; item.origin = { ...item.origin, kind: 'user_statement', id: null, originalText: '本人の申告' }
    expect(evaluateAchievement(facts).state).toBe('awaiting_evidence')
    facts.policy.requireAttachment = false
    expect(evaluateAchievement(facts).eligible).toBe(true)
    item.publicReviewed = false
    expect(evaluateAchievement(facts).eligible).toBe(false)
  })
  it('台帳と完了点数の不一致・別タスク台帳を拒否する', async () => {
    const facts = await achievementTestFacts()
    facts.ledger[0].delta = 400
    expect(evaluateAchievement(facts).eligible).toBe(false)
    facts.ledger[0].delta = 40; facts.ledger[0].taskId = 'another-task'
    expect(evaluateAchievement(facts).eligible).toBe(false)
  })
  it('100pt手動・式のどちらも5files一recordで、内部名/原本hash/原本bytesを公開しない', async () => {
    for (const mode of ['manual', 'formula'] as const) {
      const facts = await achievementTestFacts(100, mode), manifest = await preview(facts), serialized = manifest.files.map(item => item.content).join('\n')
      expect(manifest.files).toHaveLength(5)
      expect(manifest.files.filter(file => file.path.endsWith('.json') && file.path.startsWith('records/'))).toHaveLength(1)
      expect(JSON.parse(manifest.files[0].content)).toMatchObject({ points: 100, scoreMode: mode })
      for (const privateValue of [facts.task.title, facts.task.id, facts.completion.id, facts.evidence[0].origin.sha256, '秘密の添付内容']) expect(serialized).not.toContain(privateValue)
      expect(serialized).toContain('100ptを100commitに分割しません')
    }
  })
  it('点数未設定完了後の本人確定と訂正を manual と記録する', async () => {
    const facts = await achievementTestFacts(null)
    facts.completion.netPoints = 40; facts.completion.scoreState = 'confirmed'
    facts.ledger = [{ id: 'adjust-id', taskId: facts.task.id, completionId: facts.completion.id, kind: 'adjust', delta: 40, at: achievementTestTime, reason: '本人確定' }]
    expect(completionScoreMode(facts.completion, facts.assessments, facts.ledger)).toBe('manual')
    expect(JSON.parse((await preview(facts)).files[0].content).scoreMode).toBe('manual')
  })
  it('設定以前の完了は別途明示選択し、公開先の可視性/版変更を拒否する', async () => {
    const facts = await achievementTestFacts(); facts.policy.effectiveAt = '2026-10-02T00:00:00.000Z'
    await expect(preview(facts)).rejects.toThrow('明示選択')
    facts.policy.effectiveAt = achievementTestTime
    const args = { facts, selection: achievementTestSelection, gateway: { ...achievementTestGateway, repository: { ...achievementTestGateway.repository!, visibility: 'private' as const } }, exportId: 'eeeeeeee-1234-4234-8234-eeeeeeeeeeee', publicId, policyEpoch: 0, sourcePermissionRevision: 0, previous: null, published: [], preparedAt: achievementTestTime, expiresAt: '2026-10-01T03:15:00.000Z' }
    await expect(buildAchievementManifest(args)).rejects.toThrow('可視性')
  })
  it('署名付きURL/キー/端末内パスを公開文として拒否する', () => {
    for (const value of ['sk-or-v1-' + 'x'.repeat(32), 'https://example.org/report?token=secret', 'C:\\private\\report.txt', 'C:/private/report.txt', 'Bearer secret', '-----BEGIN PRIVATE KEY-----']) expect(() => publicAchievementText(value)).toThrow()
  })
  it('公開指標は未公開完了を含めず、訂正待ちは実際の前回公開点数を維持する', async () => {
    const first = rowFor(await preview(), 90)
    first.id = 'previous-export'; first.commitSha = 'b'.repeat(40); first.state = 'correction_pending'; first.summary.points = 5; first.publishedSummary = { ...first.summary, points: 90 }
    const record = await preview(await achievementTestFacts(40), [first]), metrics = JSON.parse(record.files.find(file => file.path === 'metrics/daily-points.json')!.content)
    expect(metrics.values).toEqual([{ date: '2026-10-01', points: 130 }])
    expect(localAchievementPoints([(await achievementTestFacts(100)).completion, (await achievementTestFacts(null)).completion])).toEqual([{ date: '2026-10-01', points: 100, pending: 1, completed: 2 }])
  })
  it('原本/公開文章/版の変更でdigestが変わり、復元の承認は解除する', async () => {
    const facts = await achievementTestFacts(), digest = await achievementCompletionDigest(facts)
    facts.completion.netPoints = 41
    expect(await achievementCompletionDigest(facts)).not.toBe(digest)
    const row = rowFor(await preview())
    const restored = restoreAchievementExports([row])[0]
    expect(restored.state).toBe('unknown'); expect(restored.approvedAt).toBeNull(); expect(restored.attemptId).toBe('attempt-id')
    row.state = 'approved'; row.attemptId = null; row.attemptStartedAt = null; row.attemptCount = 0
    expect(restoreAchievementExports([row])[0].state).toBe('awaiting_review')
  })
  it('backup公開内容の1文字改変、原本text改変、extra字段を拒否する', async () => {
    const facts = await achievementTestFacts(), row = rowFor(await preview())
    await verifyAchievementDigests(facts.evidence, [row])
    row.manifest.files[0].content += 'x'
    await expect(verifyAchievementDigests(facts.evidence, [row])).rejects.toThrow('SHA-256')
    const invalid = { ...row, arbitraryApproval: true }
    expect(() => validateAchievementExport(invalid)).toThrow()
    const evidence = facts.evidence[0]; evidence.origin.kind = 'task_note'; evidence.verification = 'self_reported'; evidence.origin.originalText = 'modified'
    await expect(verifyAchievementDigests([evidence], [])).rejects.toThrow('原本文章')
  })
  it('ローカル公開下書きは自己申告原本として保存し、添付証拠と区別する', async () => {
    const facts = await achievementTestFacts(), row = facts.evidence[0]
    row.kind = 'user_statement'; row.origin.originalText = JSON.stringify({ format: 'michi-achievement-local-draft', title: '下書き', body: '本文' })
    expect(achievementDraftFor([row], facts.completion.id)).toEqual({ title: '下書き', body: '本文' })
    expect(achievementDraftFor([row], 'other')).toBeNull()
  })
  it('TS previewとmainの独立公開formatterが手動/式/未知後確定の5filesで一致する', async () => {
    for (const mode of ['manual', 'formula', 'confirmed-unknown'] as const) {
      const facts = await achievementTestFacts(mode === 'confirmed-unknown' ? null : 100, mode === 'formula' ? 'formula' : 'manual')
      if (mode === 'confirmed-unknown') { facts.completion.netPoints = 100; facts.completion.scoreState = 'confirmed'; facts.ledger = [{ id: 'adjust-id', taskId: facts.task.id, completionId: facts.completion.id, kind: 'adjust', delta: 100, at: achievementTestTime, reason: '本人確定' }] }
      const manifest = await preview(facts), row = rowFor(manifest, 100)
      row.summary.scoreMode = mode === 'formula' ? 'formula' : 'manual'
      row.evidenceRefs = facts.evidence.map(item => ({ id: item.id, revision: item.revision, publicRevision: item.publicRevision, originalSha256: item.origin.sha256, publicSha256: item.publicSha256 }))
      const nativeFacts = { ...facts, row, published: [], attachments: [{ id: 'private-attachment-id', taskId: facts.task.id, ownerId: facts.settings.profileId, sha256: facts.evidence[0].origin.sha256, actualSha256: facts.evidence[0].origin.sha256, size: facts.evidence[0].origin.size, actualSize: facts.evidence[0].origin.size, mediaType: 'text/plain' }], notes: [] }, configuration = { id: 'cccccccc-1234-4234-8234-cccccccccccc', revision: 1, ownerId: facts.settings.profileId, datasetId: facts.settings.datasetId, repository: achievementTestGateway.repository }
      expect(validateGitHubPublicationFacts(nativeFacts, configuration).completionId).toBe(facts.completion.id)
      const mutated = structuredClone(nativeFacts); mutated.row.manifest.files[0].content = 'caller substituted content'; mutated.row.manifest.files[0].sha256 = await achievementTextHash(mutated.row.manifest.files[0].content)
      expect(() => validateGitHubPublicationFacts(mutated, configuration)).toThrow()
      const changedConfiguration = structuredClone(configuration); changedConfiguration.repository!.visibility = 'private'
      expect(() => validateGitHubPublicationFacts(nativeFacts, changedConfiguration)).toThrow('REPOSITORY_CHANGED')
      const historical = rowFor(manifest, 9); historical.id = 'another-export'; historical.state = 'correction_pending'; historical.commitSha = 'c'.repeat(40); historical.publishedSummary = { ...historical.summary, points: 90 }
      const combined = await preview(facts, [historical]), combinedFacts = { ...nativeFacts, row: { ...row, manifest: combined }, published: [historical] }
      expect(validateGitHubPublicationFacts(combinedFacts, configuration).completionId).toBe(facts.completion.id)
    }
  })
})

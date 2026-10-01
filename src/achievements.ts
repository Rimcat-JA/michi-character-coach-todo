import { canonicalJSON, contentDigest } from './canonical'
import { calculateScore, validateDate, type Assessment, type Completion, type Container, type LedgerEntry, type ScoreMode, type Settings, type Task } from './domain'
import type { GitHubGatewayStatus, GitHubPublishManifest, GitHubRepositoryTarget } from './github-publish-types'

export type AchievementEvidenceKind = 'artifact_file' | 'code_link' | 'submission_receipt' | 'photo' | 'external_reference' | 'user_statement'
export type AchievementEvidence = {
  id: string; ownerId: string; datasetId: string; taskId: string; completionId: string; revision: number
  kind: AchievementEvidenceKind; status: 'uploaded' | 'scanning' | 'ready' | 'rejected' | 'removed'
  verification: 'self_reported' | 'attachment_present' | 'provider_confirmed' | 'human_reviewed'
  origin: { kind: 'task_attachment' | 'task_note' | 'user_statement' | 'external_reference'; id: string | null; sha256: string; size: number; mediaType: string; originalText: string | null }
  publicText: string; publicSha256: string; publicRevision: number; publicReviewed: boolean
  createdAt: string; updatedAt: string
}
export type AchievementPolicy = {
  id: string; ownerId: string; datasetId: string; repositoryId: number; repository: GitHubRepositoryTarget
  configurationId: string; authorizationRevision: number; revision: number; enabled: boolean
  threshold: number; allowedCategoryIds: string[]; allowedEvidenceKinds: AchievementEvidenceKind[]; requireAttachment: boolean
  publishMode: 'review_every_time'; effectiveAt: string; createdAt: string; updatedAt: string
}
export type AchievementState = 'not_eligible' | 'awaiting_score' | 'awaiting_evidence' | 'awaiting_review' | 'approved' | 'queued' | 'preparing' | 'committing' | 'published' | 'pr_pending' | 'unknown' | 'failed' | 'correction_pending' | 'corrected' | 'canceled' | 'integration_not_configured' | 'awaiting_connection'
export type AchievementExport = {
  id: string; ownerId: string; datasetId: string; repositoryId: number; completionId: string; taskId: string; publicId: string; revision: number
  state: AchievementState; manifest: GitHubPublishManifest; summary: { title: string; body: string; points: number; scoreMode: ScoreMode; completionAt: string; canceled: boolean }
  selection: AchievementPublicSelection
  publishedSummary: { title: string; body: string; points: number; scoreMode: ScoreMode; completionAt: string; canceled: boolean } | null
  evidenceRefs: { id: string; revision: number; publicRevision: number; originalSha256: string; publicSha256: string }[]
  approvedAt: string | null; approvedBy: string | null; attemptId: string | null; attemptStartedAt: string | null; attemptCount: number
  commitSha: string | null; branch: string | null; recordPath: string; publishedAt: string | null; url: string | null; pullRequestUrl: string | null
  contribution: 'not_published' | 'pending' | 'unverified'; failureCode: string | null; previousCommitSha: string | null
  history: { at: string; state: AchievementState; commitSha: string | null; approvalDigest: string }[]; createdAt: string; updatedAt: string
}
export type AchievementFacts = { settings: Settings; task: Task; completion: Completion; ledger: LedgerEntry[]; assessments: Assessment[]; containers: Container[]; policy: AchievementPolicy; evidence: AchievementEvidence[] }
export type AchievementPublicSelection = { title: string; body: string; evidenceIds: string[]; includePastCompletion: boolean; correctionReason: string }
export type AchievementEligibility = { state: 'not_eligible' | 'awaiting_score' | 'awaiting_evidence' | 'awaiting_review'; eligible: boolean; reason: string; points: number | null; scoreMode: ScoreMode }
export const defaultAchievementThreshold = 40
export const evidenceKinds: AchievementEvidenceKind[] = ['artifact_file', 'code_link', 'submission_receipt', 'photo', 'external_reference', 'user_statement']
export async function achievementTextHash(value: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('') }
export function achievementCategoryIds(task: Task, containers: Container[], ownerId: string) {
  const result: string[] = [], seen = new Set<string>(); let id = task.containerId
  while (id) { if (seen.has(id)) throw new Error('所属カテゴリが循環しています'); seen.add(id); const row = containers.find(item => item.id === id && item.ownerId === ownerId && !item.deletedAt); if (!row) break; if (row.kind === 'category') result.push(row.id); id = row.parentId }
  return result
}
function completionAssessmentFacts(completion: Completion, assessments: Assessment[], entries: LedgerEntry[]) {
  const ledger = entries.filter(item => item.completionId === completion.id).sort((a, b) => a.id.localeCompare(b.id))
  const references = new Set<string>()
  for (const entry of ledger) {
    if (entry.assessmentId === undefined) continue
    const candidates = assessments.filter(item => item.id === entry.assessmentId), assessment = candidates[0]
    if (typeof entry.assessmentId !== 'string' || !entry.assessmentId.trim() || entry.kind !== 'restore' || entry.taskId !== completion.taskId || !Number.isSafeInteger(entry.delta) || entry.delta < 0 || entry.delta > 100000 || candidates.length !== 1 || assessment.taskId !== completion.taskId || assessment.origin !== 'human' || assessment.ruleVersion !== 'v1' || Object.hasOwn(assessment, 'instruction') || assessment.score.mode !== 'manual' || assessment.score.manualPoints !== entry.delta || !Number.isFinite(Date.parse(assessment.createdAt))) throw new Error('再確認実績の本人評価参照が不正です')
    const result = calculateScore(assessment.score)
    if (result.effective !== assessment.result.effective || result.lower !== assessment.result.lower || result.upper !== assessment.result.upper) throw new Error('再確認実績の本人評価ポイントが一致しません')
    references.add(entry.assessmentId)
  }
  if (completion.reconfirmedAssessmentId !== undefined && (!references.has(completion.reconfirmedAssessmentId) || !Number.isSafeInteger(completion.lastConfirmedPoints) || completion.lastConfirmedPoints! < 0 || completion.lastConfirmedPoints! > 100000)) throw new Error('再確認実績と再完了台帳が一致しません')
  // A new manual assessment can precede originalAt when the clock rolls back.
  // Its restore reference establishes its role without inferring time order.
  const originalAssessment = assessments.filter(item => item.taskId === completion.taskId && !references.has(item.id) && item.createdAt <= completion.originalAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? null
  return { completion, ledger, originalAssessment, ...(references.size ? { reconfirmationAssessments: assessments.filter(item => references.has(item.id)).sort((a, b) => a.id.localeCompare(b.id)) } : {}) }
}
export function completionScoreMode(completion: Completion, assessments: Assessment[], ledger: LedgerEntry[] = []): ScoreMode {
  const facts = completionAssessmentFacts(completion, assessments, ledger)
  if (completion.scoreState === 'confirmed' && (facts.originalAssessment?.score.mode === 'unset' || facts.reconfirmationAssessments?.length || facts.ledger.some(item => item.kind === 'adjust'))) return 'manual'
  return facts.originalAssessment?.score.mode ?? 'unset'
}
export function evaluateAchievement(facts: AchievementFacts, selectedEvidenceIds: string[] = facts.evidence.map(item => item.id)): AchievementEligibility {
  const { task, completion, settings, policy } = facts
  let scoreMode: ScoreMode
  try { scoreMode = completionScoreMode(completion, facts.assessments, facts.ledger) } catch { return { state: 'not_eligible', eligible: false, reason: '再確認実績の本人評価と台帳を確認してください', points: completion.netPoints, scoreMode: 'unset' } }
  const result = (state: AchievementEligibility['state'], reason: string, eligible = false): AchievementEligibility => ({ state, eligible, reason, points: completion.netPoints, scoreMode })
  if (completion.taskId !== task.id || policy.ownerId !== settings.profileId || policy.datasetId !== settings.datasetId || task.deletedAt || task.status !== 'completed' || !completion.currentAt || !policy.enabled) return result('not_eligible', '有効な本人の完了実績・公開設定を確認してください')
  if (completion.scoreState !== 'confirmed' || completion.netPoints === null) return result('awaiting_score', '完了ポイントが未確定です。0ptとして判定しません')
  const ledger = facts.ledger.filter(item => item.completionId === completion.id)
  if (!Number.isSafeInteger(completion.netPoints) || completion.netPoints < 0 || ledger.some(item => item.taskId !== task.id || !Number.isSafeInteger(item.delta)) || ledger.reduce((sum, item) => sum + item.delta, 0) !== completion.netPoints) return result('not_eligible', '完了記録と正味ポイント台帳が一致しません')
  if (completion.netPoints < policy.threshold) return result('not_eligible', `GitHub公開の閾値${policy.threshold}pt未満です。アプリ内の実績は保持します`)
  if (policy.allowedCategoryIds.length && !achievementCategoryIds(task, facts.containers, settings.profileId).some(id => policy.allowedCategoryIds.includes(id))) return result('not_eligible', 'このカテゴリは公開対象に選ばれていません')
  const evidence = facts.evidence.filter(item => selectedEvidenceIds.includes(item.id) && item.ownerId === settings.profileId && item.datasetId === settings.datasetId && item.completionId === completion.id && item.taskId === task.id && item.status === 'ready' && policy.allowedEvidenceKinds.includes(item.kind))
  if (!evidence.length || policy.requireAttachment && !evidence.some(item => item.origin.kind === 'task_attachment' && item.verification === 'attachment_present')) return result('awaiting_evidence', '対象の原本証拠が必要です。自己申告だけでは添付要件を満たしません')
  if (evidence.some(item => !item.publicReviewed || !item.publicText.trim())) return result('awaiting_review', '原本と別の公開用説明を本人が確認してください')
  return result('awaiting_review', '公開する内容・証拠・リポジトリの確認を待っています', true)
}
export async function achievementCompletionDigest(facts: Pick<AchievementFacts, 'completion' | 'ledger' | 'assessments'>) { return contentDigest(completionAssessmentFacts(facts.completion, facts.assessments, facts.ledger)) }
export const achievementEvidenceOrder = (evidence: AchievementEvidence[]) => evidence.slice().sort((a, b) => a.id.localeCompare(b.id))
export function publicAchievementText(value: string, max = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || new TextDecoder().decode(new TextEncoder().encode(value)) !== value || [...value].some(char => char.charCodeAt(0) < 32 && !['\n', '\r', '\t'].includes(char))) throw new Error('公開用文章の文字・長さを確認してください')
  if (/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-(?:or-v1-)?[A-Za-z0-9_-]{12,})|\bBearer\s+\S+|X-Amz-(?:Credential|Signature|Security-Token)=|[?&](?:access_token|token|signature|sig)=|\b[A-Za-z]:[\\/]|\bfile:\/\//i.test(value)) throw new Error('キー・認証情報・期限付きURL・端末内パスを公開文に含めないでください')
  return value.trim().normalize('NFC')
}
const md = (value: string) => value.replaceAll('\\', '\\\\').replace(/[<>&`*_[\]#]/g, char => `\\${char}`)
function pointsHeatmap(values: { date: string; points: number }[]) { const rows = values.slice(-366); return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(160, rows.length * 12)}" height="54" role="img" aria-label="このリポジトリへ公開を許可した正味ポイント"><title>GitHub標準contribution graphとは別のポイント図</title>${rows.map((row, index) => `<rect x="${index * 12}" y="24" width="10" height="10" fill="${row.points === 0 ? '#eee' : row.points < 40 ? '#c4b5fd' : row.points < 100 ? '#a78bfa' : '#7c3aed'}"><title>${row.date}: ${row.points}pt</title></rect>`).join('')}</svg>\n` }
export async function buildAchievementManifest(input: { facts: AchievementFacts; selection: AchievementPublicSelection; gateway: GitHubGatewayStatus; exportId: string; publicId: string; policyEpoch: number; sourcePermissionRevision: number; previous: AchievementExport | null; published: AchievementExport[]; preparedAt: string; expiresAt: string }): Promise<GitHubPublishManifest> {
  const { facts, selection, gateway, previous } = input, { policy, completion } = facts
  const correction = Boolean(previous?.commitSha), eligibility = evaluateAchievement(facts, selection.evidenceIds)
  if (!policy.enabled || policy.ownerId !== facts.settings.profileId || policy.datasetId !== facts.settings.datasetId || completion.taskId !== facts.task.id) throw new Error('本人の公開設定・対象を確認してください')
  if (completion.currentAt && (completion.scoreState !== 'confirmed' || completion.netPoints === null)) throw new Error('完了ポイントの確定を待っています')
  if (!eligibility.eligible && !correction) throw new Error(eligibility.reason)
  if (correction && (!selection.correctionReason.trim() || !previous || !['correction_pending', 'published', 'corrected', 'pr_pending'].includes(previous.state))) throw new Error('既存の公開実績への訂正理由・状態を確認してください')
  if (!selection.includePastCompletion && completion.originalAt < policy.effectiveAt) throw new Error('設定以前の完了実績は本人が公開対象として明示選択してください')
  if (gateway.state !== 'ready' || !gateway.repository || !gateway.configurationId) throw new Error(gateway.state === 'awaiting_connection' ? 'awaiting_connection' : 'integration_not_configured')
  if (!gateway.repository.ownerVerified || !gateway.repository.canPush || gateway.repository.empty || gateway.repository.repositoryId !== policy.repositoryId || gateway.configurationId !== policy.configurationId || gateway.authorizationRevision !== policy.authorizationRevision || gateway.repository.visibility !== policy.repository.visibility || gateway.repository.defaultBranch !== policy.repository.defaultBranch || gateway.repository.owner !== policy.repository.owner || gateway.repository.name !== policy.repository.name) throw new Error('リポジトリ・所有者・可視性・権限が変わりました。設定を確認してください')
  const title = publicAchievementText(selection.title, 300), body = publicAchievementText(selection.body), evidence = achievementEvidenceOrder(facts.evidence.filter(item => selection.evidenceIds.includes(item.id)))
  if (selection.evidenceIds.length > 20 || selection.evidenceIds.length !== evidence.length || new Set(selection.evidenceIds).size !== selection.evidenceIds.length || evidence.some(item => item.status !== 'ready' || !item.publicReviewed || item.ownerId !== facts.settings.profileId || item.datasetId !== facts.settings.datasetId || item.completionId !== completion.id)) throw new Error('選択した公開用証拠の本人・版・状態を確認してください')
  const recordDate = previous?.manifest.recordDate ?? completion.localDate ?? completion.originalAt.slice(0, 10); validateDate(recordDate, '実績日')
  const prefix = `records/${recordDate.slice(0, 4)}/${recordDate.slice(5, 7)}/${input.publicId}`, evidenceRows = evidence.map(item => ({ kind: item.kind, status: item.status, verification: item.verification, publicSha256: item.publicSha256, publicText: publicAchievementText(item.publicText), originalAccess: '原本は本人のアプリ内に保持し、この公開には含めません' }))
  const points = completion.currentAt && completion.netPoints !== null ? completion.netPoints : 0, scoreMode = completionScoreMode(completion, facts.assessments, facts.ledger)
  const record = { format: 'michi-achievement', version: 1, id: input.publicId, title, summary: body, completionAt: completion.originalAt, recordDate, preparedAt: input.preparedAt, points, scoreMode, formulaVersion: 'v1', verification: '本人によるローカル記録。証拠のhashは真実性の証明ではありません', evidence: evidenceRows, correction: correction ? { reason: publicAchievementText(selection.correctionReason, 2000), previousCommitSha: previous!.commitSha, canceled: !completion.currentAt } : null }
  const included = input.published.filter(item => item.repositoryId === policy.repositoryId && item.ownerId === policy.ownerId && item.datasetId === policy.datasetId && item.id !== input.exportId && item.commitSha && item.publishedSummary), daily = new Map<string, number>()
  for (const item of included) daily.set(item.manifest.recordDate, (daily.get(item.manifest.recordDate) ?? 0) + item.publishedSummary!.points)
  daily.set(recordDate, (daily.get(recordDate) ?? 0) + points)
  const values = [...daily].map(([date, points]) => ({ date, points })).sort((a, b) => a.date.localeCompare(b.date))
  const files = [ { path: prefix+'.json', content: JSON.stringify(record, null, 2)+'\n', kind: 'record' as const }, { path: prefix+'.md', content: `# ${md(title)}\n\n${md(body)}\n\n- 実績日: ${recordDate}\n- 確定した正味ポイント: ${points}pt (${scoreMode})\n- 計算式の版: v1\n- 原本の証拠はこの公開に含めません。説明は本人が編集・確認した文章です。\n- hashは同一性確認に使用し、成果の真実性を保証しません。\n\n${evidenceRows.map(item => `## 証拠 (${item.kind} / ${item.verification})\n\n${md(item.publicText)}\n`).join('\n')}${record.correction ? `\n## 訂正\n\n${md(record.correction.reason)}\n\n前回commit: ${record.correction.previousCommitSha}\n${record.correction.canceled ? '完了を取消したため正味0ptです。過去のGitHub contributionが消えたとは断言しません。\n' : ''}` : ''}`, kind: 'record' as const }, { path: 'metrics/daily-points.json', content: JSON.stringify({ format: 'michi-published-points', version: 1, scope: 'このリポジトリへ公開を許可した実績のみ', values }, null, 2)+'\n', kind: 'metrics' as const }, { path: 'metrics/points-heatmap.svg', content: pointsHeatmap(values), kind: 'metrics' as const }, { path: 'README.md', content: '# 本人が選んだ証拠付き作業実績\n\n本人が公開文と証拠の説明を確認した完了実績を、一つの実績につき一つのrecordとして記録します。ポイントは作業負荷の見積もり・確定値で、成果の質や真実性の証明ではありません。元ファイル、内部タスク名、会話、認証情報は公開対象に含めません。\n\n## 公開を許可した実績の正味ポイント\n\n![ポイント図](metrics/points-heatmap.svg)\n\nGitHub標準contribution graphとは別の図です。GitHub APIの投稿成功だけで草への反映は確認できません。作者の帰属・branch・repository等のGitHub側の集計条件と反映待ちを区別します。100ptを100commitに分割しません。\n', kind: 'readme' as const } ]
  const manifestFiles = await Promise.all(files.map(async file => ({ ...file, sha256: await achievementTextHash(file.content) })))
  const unsigned = { version: 1 as const, exportId: input.exportId, publicId: input.publicId, ownerId: facts.settings.profileId, datasetId: facts.settings.datasetId, repository: structuredClone(gateway.repository), configurationId: gateway.configurationId, authorizationRevision: gateway.authorizationRevision, completionDigest: await achievementCompletionDigest(facts), evidenceDigest: await contentDigest(evidence), policyDigest: await contentDigest(policy), policyRevision: policy.revision, policyEpoch: input.policyEpoch, sourcePermissionRevision: input.sourcePermissionRevision, preparedAt: input.preparedAt, expiresAt: input.expiresAt, recordDate, files: manifestFiles }
  return { ...unsigned, approvalDigest: await contentDigest(unsigned) }
}
/** App-local points use all valid completions; public metrics deliberately use only selected exports. */
export function localAchievementPoints(completions: Completion[]) { const rows = new Map<string, { date: string; points: number; pending: number; completed: number }>(); for (const completion of completions.filter(item => item.currentAt)) { const date = completion.localDate ?? completion.originalAt.slice(0, 10), row = rows.get(date) ?? { date, points: 0, pending: 0, completed: 0 }; row.completed++; if (completion.netPoints === null) row.pending++; else row.points += completion.netPoints; rows.set(date, row) }; return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)) }
export function achievementChanged(row: AchievementExport, completionDigest: string, evidenceDigest: string, policyDigest: string) { return canonicalJSON([row.manifest.completionDigest, row.manifest.evidenceDigest, row.manifest.policyDigest]) !== canonicalJSON([completionDigest, evidenceDigest, policyDigest]) }
export function achievementDraftFor(evidence:AchievementEvidence[],completionId:string):{title:string;body:string}|null{for(const row of evidence.filter(item=>item.completionId===completionId&&item.kind==='user_statement'&&item.status!=='removed').sort((a,b)=>b.createdAt.localeCompare(a.createdAt))){try{const value=JSON.parse(row.origin.originalText??'');if(value.format==='michi-achievement-local-draft'&&typeof value.title==='string'&&typeof value.body==='string')return {title:value.title,body:value.body}}catch{/* Plain self statement. */}}return null}

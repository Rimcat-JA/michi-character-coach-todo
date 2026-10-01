import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { newTaskInput } from './commands'
import { emptyScore, type Completion, type Settings, type Task } from './domain'
import CompletionReconfirmationView, { ReconfirmationPreview, ReconfirmationTaskEntry } from './CompletionReconfirmationView'
import { reconfirmationPoints } from './completion-reconfirmation-view-input'

type Preview = Parameters<typeof ReconfirmationPreview>[0]['preview']
const preview = (): Preview => ({
  task: { id: 'parent', title: '現在の親', revision: 4, estimatePoints: 20, scoreMode: 'manual' },
  completion: { id: 'completion', originalAt: '2026-10-01T00:00:00.000Z', originalPoints: 40, originalTitle: '元の親', originalProject: '元の所属', currentTimezone: 'Asia/Tokyo', cachedPoints: 20, cachedPointsMissing: false },
  cancellation: { status: 'known', points: 40, at: '2026-10-01T00:01:00.000Z', reason: '取消台帳を確認済み' },
  allocation: { hasChildren: true, parentRemainder: 20, children: [
    { id: 'child', title: '子の作業', status: 'completed', deleted: false, estimatePoints: 20, activePoints: 17, hasActiveCompletion: true, relation: 'verified' },
  ], issues: [], combinedEstimatePoints: 40, combinedActivePoints: 17, proposedCombinedActivePoints: 20, proposedCombinedEstimatePoints: 23 },
  trips: [], displayTimezone: 'Asia/Tokyo', requiresImpactAcknowledgement: true,
})
const settings: Settings = { id: 'main', profileId: 'owner', datasetId: 'dataset', createdAt: '2026-10-01T00:00:00.000Z', coachName: 'コーチ', dailyMinutes: 480, dailyPoints: 100, notifications: false, aiEnabled: false, automation: 'A0', lastBackupAt: null }
const task: Task = { ...newTaskInput(), id: 'parent', generationKey: 'parent', routineId: null, title: '取消済みの親', score: { ...emptyScore(), mode: 'manual', manualPoints: 20 }, effectivePoints: 20, assessmentId: 'estimate', status: 'open', revision: 4, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:02:00.000Z', deletedAt: null }
const completion: Completion = { id: 'completion', taskId: 'parent', originalAt: '2026-10-01T00:00:00.000Z', currentAt: null, originalPoints: 40, netPoints: null, lastConfirmedPoints: 20, scoreState: 'confirmed', title: '元の親', project: '元の所属' }

describe('取消済み実績の本人再確認画面', () => {
  it.each(['', ' ', '-1', '1.5', '1e2', '100001', 'NaN', 'Infinity'])('明示した整数以外を0にしない: %s', value => {
    expect(() => reconfirmationPoints(value)).toThrow('整数')
  })
  it('本人が明示入力した0と上限を受け付ける', () => {
    expect(reconfirmationPoints('0')).toBe(0)
    expect(reconfirmationPoints('100000')).toBe(100000)
  })
  it('最初40・取消前40・保存20・将来20と本人3を分けて表示する', () => {
    const html = renderToStaticMarkup(<ReconfirmationPreview preview={preview()} points={3} reason="実績を本人確認" />)
    expect(html).toContain('<dt>最初の実績ポイント</dt><dd>40 pt')
    expect(html).toContain('<dt>取消直前の実加点</dt><dd>40 pt')
    expect(html).toContain('<dt>再完了用の保存値</dt><dd>20 pt')
    expect(html).toContain('<dt>現在のタスクの将来用見積</dt><dd>20 pt')
    expect(html).toContain('<dt>本人が再確定する実績</dt><dd><strong>3 pt')
    expect(html).toContain('最初の記録は残ります')
    expect(html).toContain('タスクの将来用ポイントは変更しません')
    expect(html).toContain('表示タイムゾーン：Asia/Tokyo')
    expect(html).toContain('元の日時：2026-10-01T00:00:00.000Z')
  })
  it('子の現在実績17と将来見積20、再確定後合計20を区別する', () => {
    const html = renderToStaticMarkup(<ReconfirmationPreview preview={preview()} points={3} reason="親の残作業を確認" />)
    expect(html).toContain('現在有効な実績：17 pt')
    expect(html).toContain('将来用の見積：20 pt')
    expect(html).toContain('<dt>今回の再確定後の親子実績合計</dt><dd>20 pt')
    expect(html).toContain('<dt>将来用の親子見積合計</dt><dd>40 pt')
  })
  it('保存値欠落・取消履歴不明・子ポイント未設定を0と表示しない', () => {
    const value = preview()
    value.completion.cachedPointsMissing = true; value.completion.originalPoints = null
    value.cancellation = { status: 'unknown', points: null, at: null, reason: '旧履歴が曖昧です' }
    value.allocation.children[0].activePoints = null; value.allocation.children[0].estimatePoints = null
    value.allocation.proposedCombinedActivePoints = null; value.allocation.issues = ['親子リンクの再確認が必要']
    const html = renderToStaticMarkup(<ReconfirmationPreview preview={value} points={0} reason="本人が0を指定" />)
    expect(html).toContain('保存値なし')
    expect(html).toContain('履歴から確認できません')
    expect(html).toContain('現在有効な実績：未設定')
    expect(html).toContain('将来用の見積：未設定')
    expect(html).toContain('親子リンクの再確認が必要')
    expect(html).toContain('合計を確認できません')
    expect(html).toContain('<strong>0 pt</strong>')
  })
  it('本文をHTMLとして実行せず、改行理由を表示する', () => {
    const value = preview(); value.task.title = '<script>test</script>'
    const html = renderToStaticMarkup(<ReconfirmationPreview preview={value} points={3} reason={'<img src=x>\n確認理由'} />)
    expect(html).toContain('&lt;script&gt;test&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x&gt;\n確認理由')
    expect(html).not.toContain('<script>')
  })
  it('束が固定済みか今回固定されるかを確認案へ表示する', () => {
    const value = preview(); value.trips = [{ id: 'new', title: '未固定の束', totalPoints: 60, frozenAt: null }, { id: 'old', title: '固定済みの束', totalPoints: 40, frozenAt: '2026-10-01T00:00:00.000Z' }]
    const html = renderToStaticMarkup(<ReconfirmationPreview preview={value} points={3} reason="配分固定も本人確認" />)
    expect(html).toContain('今回の実績再確定で、この束の配分を固定します')
    expect(html).toContain('現在の固定を保持します')
    expect(html).toContain('束の合計：60 pt')
    expect(html).toContain('束の合計：40 pt')
  })
  it('タスク入口の保存値を将来見積と区別し、欠落や未設定を0にしない', () => {
    expect(renderToStaticMarkup(<ReconfirmationTaskEntry completion={completion} onOpen={() => undefined} />)).toContain('再完了用の保存値：20 pt')
    expect(renderToStaticMarkup(<ReconfirmationTaskEntry completion={{ ...completion, lastConfirmedPoints: null }} onOpen={() => undefined} />)).toContain('再完了用の保存値：未設定')
    const missing = { ...completion }; delete missing.lastConfirmedPoints
    expect(renderToStaticMarkup(<ReconfirmationTaskEntry completion={missing} onOpen={() => undefined} />)).toContain('再完了用の保存値：保存値なし')
    expect(renderToStaticMarkup(<ReconfirmationTaskEntry completion={{ ...completion, currentAt: completion.originalAt }} onOpen={() => undefined} />)).toBe('')
  })
  it('AI停止中も入口があり、選択と本人入力を空欄から始める', () => {
    const html = renderToStaticMarkup(<CompletionReconfirmationView settings={settings} tasks={[task]} completions={[completion]} ledger={[]} />)
    expect(html).toContain('<option value="" selected="">選んでください</option>')
    expect(html).toMatch(/aria-label="再確定するポイント"[^>]*value=""/)
    expect(html).toMatch(/aria-label="再確定する理由"[^>]*><\/textarea>/)
    expect(html).not.toContain('この内容で実績を再確定')
  })
  it('指定対象から開いても、旧ポイントと理由を本人入力へコピーしない', () => {
    const html = renderToStaticMarkup(<CompletionReconfirmationView settings={settings} tasks={[task]} completions={[completion]} ledger={[]} initialCompletionId={completion.id} />)
    expect(html).toContain('<option value="completion" selected="">')
    expect(html).toMatch(/aria-label="再確定するポイント"[^>]*value=""/)
    expect(html).not.toContain('本人のポイント・理由と親子への影響を確認した')
  })
  it('有効な完了・ゴミ箱内・完了中のタスクを対象に含めない', () => {
    const html = renderToStaticMarkup(<CompletionReconfirmationView settings={settings} tasks={[{ ...task, deletedAt: '2026-10-01T00:03:00.000Z' }]} completions={[completion, { ...completion, id: 'active', currentAt: completion.originalAt }]} ledger={[]} />)
    expect(html).toContain('再確認できる取消済みの実績はありません')
    expect(html).not.toContain('<option value="completion"')
    expect(html).not.toContain('<option value="active"')
  })
})

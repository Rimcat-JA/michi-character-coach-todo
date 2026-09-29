import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput, completeTask, correctCompletion, undoCompletion } from './commands'
import { emptyScore } from './domain'
import { createContainer } from './containers'
import { addChecklistItem, convertChecklistItem } from './checklist'
import { createLabelDefinition, createLabelGroup } from './labels'
import { instantiateTemplate, saveTaskTemplate } from './templates'
import { addTaskAttachment, addTaskComment, addTaskNote, getTaskAttachment } from './materials'
import { addTaskDependency } from './dependencies'
import { assignTaskToBucket, createPlanningBucket } from './period-planning'
import { createCalendarEvent, createTimeBlock } from './calendar-planning'
import { rolloverTask } from './rollover'
import { createThemeRule } from './themes'
import { assignDaySection, setDaySectionMode } from './day-sections'
import { createSmartList } from './smart-lists'
import { setFocusProjects } from './focus-projects'
import { setSpotlight } from './focus-tools'
import { captureDayProgressBaseline, createTimeTarget } from './progress'
import { createHabit, recordHabitLog } from './habits'
import { createGoal, createGoalCheckIn } from './goals'
import { createTracker, recordTrackerEntry, saveDayNote } from './journal'
import { recordPomodoro, startPomodoro } from './pomodoro'
import { addWallTile } from './wall'
import { saveWorkflowPreset } from './workflows'
import { saveAppearance } from './appearance'
import { inspectBackup, restoreBackup } from './backup'
import { validateSnapshot, type Snapshot } from './backup-validation'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

async function snapshot(): Promise<Snapshot> {
  const attachments = await Promise.all((await db.taskAttachments.toArray()).map(async ({ blob, ...item }) => ({ ...item, contentBase64: btoa(Array.from(new Uint8Array(await blob.arrayBuffer()), value => String.fromCharCode(value)).join('')) })))
  return {
    format: 'coachbundle', version: 1, exportedAt: new Date().toISOString(),
    tasks: await db.tasks.toArray(), assessments: await db.assessments.toArray(),
    completions: await db.completions.toArray(), ledger: await db.ledger.toArray(),
    routines: await db.routines.toArray(), sessions: await db.sessions.toArray(),
    commands: await db.commands.toArray(), audits: await db.audits.toArray(),
    settings: await db.settings.toArray(), containers: await db.containers.toArray(), checklistItems: await db.checklistItems.toArray(), labelGroups: await db.labelGroups.toArray(), labelDefinitions: await db.labelDefinitions.toArray(), savedTemplates: await db.savedTemplates.toArray(), taskNotes: await db.taskNotes.toArray(), taskComments: await db.taskComments.toArray(), taskAttachments: attachments, taskDependencies: await db.taskDependencies.toArray(), planningBuckets: await db.planningBuckets.toArray(), timeBlocks: await db.timeBlocks.toArray(), calendarEvents: await db.calendarEvents.toArray(), rollovers: await db.rollovers.toArray(), themeRules: await db.themeRules.toArray(), smartLists: await db.smartLists.toArray(), focusSelections: await db.focusSelections.toArray(), habits: await db.habits.toArray(), habitLogs: await db.habitLogs.toArray(), goals: await db.goals.toArray(), goalCheckIns: await db.goalCheckIns.toArray(), trackerDefinitions: await db.trackerDefinitions.toArray(), trackerEntries: await db.trackerEntries.toArray(), dayNotes: await db.dayNotes.toArray(), pomodoroCycles: await db.pomodoroCycles.toArray()
  }
}

describe('バックアップの復元前検証', () => {
  it('見た目の設定を復元し、不正な配色を拒否する', async () => {
    await saveAppearance({ theme: 'high-contrast', accent: 'blue', fontScale: 110, iconStyle: 'bold' })
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const corrupt = structuredClone(saved)
    corrupt.settings[0].appearance!.accent = 'invalid' as 'blue'
    expect(() => validateSnapshot(corrupt)).toThrow('見た目')
    await db.settings.update('main', { appearance: undefined })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))?.appearance).toMatchObject({ theme: 'high-contrast', accent: 'blue', fontScale: 110, iconStyle: 'bold' })
  })
  it('版付きワークフローを復元し、共有対象外の設定を含むものを拒否する', async () => {
    await saveWorkflowPreset('自分の設定')
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const corrupt = structuredClone(saved)
    Object.assign(corrupt.settings[0].workflowPresets![0].config, { notifications: true })
    expect(() => validateSnapshot(corrupt)).toThrow('ワークフロー設定')
    await db.settings.update('main', { workflowPresets: [] })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))?.workflowPresets?.[0].name).toBe('自分の設定')
  })
  it('機能の表示設定を復元し、未知の機能を拒否する', async () => {
    await db.settings.update('main', { hiddenFeatures: ['wall', 'journal'] })
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const corrupt = structuredClone(saved)
    corrupt.settings[0].hiddenFeatures!.push('unknown')
    expect(() => validateSnapshot(corrupt)).toThrow('機能の表示')
    await db.settings.update('main', { hiddenFeatures: [] })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))?.hiddenFeatures).toEqual(['wall', 'journal'])
  })
  it('PCとスマホのナビゲーションを別々に復元し、不正な機能名を拒否する', async () => {
    await db.settings.update('main', { navDesktop: [], navMobile: ['today', 'wall'] })
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const corrupt = structuredClone(saved)
    corrupt.settings[0].navMobile!.push('unknown')
    expect(() => validateSnapshot(corrupt)).toThrow('ナビゲーション')
    await db.settings.update('main', { navDesktop: ['tasks'], navMobile: [] })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))).toMatchObject({ navDesktop: [], navMobile: ['today', 'wall'] })
  })
  it('Wallの配置を復元し、不正な座標を拒否する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '付箋' })
    await addWallTile(id, '準備')
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const corrupt = structuredClone(saved)
    corrupt.settings[0].wallTiles![0].x = 99
    expect(() => validateSnapshot(corrupt)).toThrow('Wall')
    await db.settings.update('main', { wallTiles: [] })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))?.wallTiles).toEqual([{ taskId: id, x: 0, y: 0, group: '準備' }])
  })
  it('有効な実績と取消履歴を復元できる', async () => {
    const input = { ...newTaskInput(), title: '復元するタスク', score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 20 } }
    const id = await createTask(input)
    await completeTask(id, 1)
    await correctCompletion(id, 25, '実績を訂正')
    await undoCompletion(id, 2)
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.tasks.get(id))?.title).toBe('復元するタスク')
    expect((await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0)).toBe(0)
  })

  it('台帳の不一致を拒否し現在のデータを保持する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '保護対象', score: { ...emptyScore(), mode: 'manual', manualPoints: 20 } })
    await completeTask(id, 1)
    const corrupt = await snapshot()
    corrupt.ledger[0].delta = 99
    await expect(restoreBackup(corrupt)).rejects.toThrow('台帳の合計')
    expect((await db.tasks.get(id))?.title).toBe('保護対象')
    expect((await db.ledger.toArray())[0].delta).toBe(20)
  })

  it('重複キー、欠落した評価、不正な日時を拒否する', async () => {
    await createTask({ ...newTaskInput(), title: '一件目' })
    await createTask({ ...newTaskInput(), title: '二件目' })
    const valid = await snapshot()
    const duplicate = structuredClone(valid)
    duplicate.tasks[1].generationKey = duplicate.tasks[0].generationKey
    expect(() => validateSnapshot(duplicate)).toThrow('重複')
    const missing = structuredClone(valid)
    missing.assessments = []
    expect(() => validateSnapshot(missing)).toThrow('評価参照')
    const badDate = structuredClone(valid)
    badDate.tasks[0].createdAt = 'yesterday'
    expect(() => validateSnapshot(badDate)).toThrow('履歴')
  })
  it('認証情報のような未対応設定を取り込まない', async () => {
    const data = await snapshot()
    const injected = { ...data, settings: [{ ...data.settings[0], apiKey: 'synthetic-test-only' }] }
    expect(() => validateSnapshot(injected)).toThrow('未対応の項目')
  })
  it('version付きJSONを検証して復元候補を返す', async () => {
    await createTask({ ...newTaskInput(), title: 'JSONの対象' })
    const data = await snapshot()
    const file = new File([JSON.stringify(data)], 'portable.json', { type: 'application/json' })
    const inspected = await inspectBackup(file, '')
    expect(inspected.tasks[0].title).toBe('JSONの対象')
    expect(inspected.format).toBe('coachbundle')
  })
  it('階層付きタスクを復元し参照を保つ', async () => {
    const parent = await createContainer({ kind: 'category', name: '生活', parentId: null })
    const child = await createContainer({ kind: 'project', name: '買い物', parentId: parent })
    const id = await createTask({ ...newTaskInput(), title: '食品を買う', containerId: child })
    const saved = await snapshot()
    await db.containers.clear(); await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.tasks.get(id))?.containerId).toBe(child)
    expect((await db.containers.get(child))?.parentId).toBe(parent)
  })
  it('配分済みチェック項目と子タスクを一緒に復元する', async () => {
    const parent = await createTask({ ...newTaskInput(), title: '親', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    const item = await addChecklistItem(parent, '子にする項目')
    const child = await convertChecklistItem(item, 1, 10)
    const saved = await snapshot()
    await db.checklistItems.clear(); await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.checklistItems.get(item))?.convertedTaskId).toBe(child)
    expect((await db.tasks.get(parent))?.effectivePoints).toBe(30)
    expect((await db.tasks.get(child))?.effectivePoints).toBe(10)
  })
  it('singleグループを保持して復元し、二値指定の破損を拒否する', async () => {
    const group = await createLabelGroup('場所', 'single')
    await createLabelDefinition('家', group); await createLabelDefinition('外', group)
    const id = await createTask({ ...newTaskInput(), title: '準備', labels: ['家'] })
    const saved = await snapshot()
    const corrupt = structuredClone(saved)
    corrupt.tasks[0].labels = ['家', '外']
    await expect(restoreBackup(corrupt)).rejects.toThrow('1つだけ')
    await db.labelGroups.clear(); await db.labelDefinitions.clear(); await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.labelGroups.get(group))?.selectionMode).toBe('single')
    expect((await db.tasks.get(id))?.labels).toEqual(['家'])
  })
  it('保存済みテンプレートを復元して新しい発生回を作る', async () => {
    const source = await createTask({ ...newTaskInput(), title: '準備' })
    await addChecklistItem(source, '持ち物')
    const template = await saveTaskTemplate(source, '準備')
    const saved = await snapshot()
    await db.savedTemplates.clear()
    await restoreBackup(saved)
    expect((await db.savedTemplates.get(template))?.version).toBe(1)
    const created = await instantiateTemplate(template)
    expect((await db.checklistItems.where('taskId').equals(created.taskIds[0]).first())?.done).toBe(false)
  })
  it('ノート・コメント・添付の内容とハッシュを検証して復元する', async () => {
    const task = await createTask({ ...newTaskInput(), title: '資料' })
    await addTaskNote(task, '**確認**', 'self'); await addTaskComment(task, '確認しました')
    const id = await addTaskAttachment(task, new File(['contents'], 'memo.txt', { type: 'text/plain' }))
    const saved = await snapshot()
    const corrupt = structuredClone(saved)
    corrupt.taskAttachments![0].contentBase64 = btoa('tampered')
    await expect(restoreBackup(corrupt)).rejects.toThrow('ハッシュ')
    expect(await db.taskAttachments.count()).toBe(1)
    await db.taskAttachments.clear(); await db.taskNotes.clear(); await db.taskComments.clear()
    await restoreBackup(saved)
    expect((await db.taskNotes.toArray())[0].body).toBe('**確認**')
    expect((await db.taskComments.toArray())[0].body).toBe('確認しました')
    expect((await getTaskAttachment(id, (await ensureSettings()).profileId)).name).toBe('memo.txt')
  })
  it('依存関係を復元し、循環するバックアップは拒否する', async () => {
    const a = await createTask({ ...newTaskInput(), title: 'A' }), b = await createTask({ ...newTaskInput(), title: 'B' })
    await addTaskDependency(b, a)
    const saved = await snapshot()
    const corrupt = structuredClone(saved)
    corrupt.taskDependencies!.push({ id: crypto.randomUUID(), taskId: a, dependsOnId: b, createdAt: new Date().toISOString() })
    await expect(restoreBackup(corrupt)).rejects.toThrow('循環')
    await db.taskDependencies.clear()
    await restoreBackup(saved)
    expect((await db.taskDependencies.toArray())[0]).toMatchObject({ taskId: b, dependsOnId: a })
  })
  it('期間計画への割当を復元する', async () => {
    const bucket = await createPlanningBucket('quarter', '2026-10-01')
    const id = await createTask({ ...newTaskInput(), title: '計画済み' })
    await assignTaskToBucket(id, 1, bucket)
    const saved = await snapshot()
    await db.tasks.clear(); await db.planningBuckets.clear()
    await restoreBackup(saved)
    expect((await db.tasks.get(id))?.planBucketId).toBe(bucket)
    expect((await db.planningBuckets.get(bucket))?.kind).toBe('quarter')
  })
  it('時間枠と会議を別資源として復元する', async () => {
    const block = await createTimeBlock({ kind: 'activity', category: '学習', projectId: null, date: '2026-10-01', startMinute: 540, endMinute: 600, timezone: 'Asia/Tokyo' })
    const event = await createCalendarEvent({ kind: 'meeting', title: '会議', startAt: '2026-10-01T01:00:00.000Z', endAt: '2026-10-01T02:00:00.000Z', timezone: 'Asia/Tokyo', linkedTaskId: null })
    const saved = await snapshot()
    await db.timeBlocks.clear(); await db.calendarEvents.clear()
    await restoreBackup(saved)
    expect((await db.timeBlocks.get(block))?.category).toBe('学習')
    expect((await db.calendarEvents.get(event))?.title).toBe('会議')
  })
  it('初回予定日と繰越履歴を復元する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '繰越', scheduledDate: '2026-10-01' })
    await rolloverTask(id, 1, '2026-10-02')
    const saved = await snapshot()
    await db.rollovers.clear(); await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.tasks.get(id))?.firstScheduledDate).toBe('2026-10-01')
    expect((await db.rollovers.where('taskId').equals(id).first())?.toDate).toBe('2026-10-02')
  })
  it('重点テーマと気力属性を復元する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '執筆', project: '執筆', energyNeed: 0, focusNeed: null, positiveFeeling: 3 })
    const rule = await createThemeRule({ category: '執筆', weekdays: [2], startDate: null, endDate: null, strength: 2 })
    const saved = await snapshot()
    await db.tasks.clear(); await db.themeRules.clear()
    await restoreBackup(saved)
    expect(await db.tasks.get(id)).toMatchObject({ energyNeed: 0, focusNeed: null, positiveFeeling: 3 })
    expect((await db.themeRules.get(rule))?.weekdays).toEqual([2])
  })
  it('今日の表示区分とタスクの割当を復元する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '午前の作業' })
    await assignDaySection(id, 1, 'dayHalf', 'morning')
    await setDaySectionMode('halfday')
    const saved = await snapshot()
    await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.tasks.get(id))?.dayHalf).toBe('morning')
    expect((await db.settings.get('main'))?.daySectionMode).toBe('halfday')
  })
  it('Smart Listの条件を復元し、不正な演算子を拒否する', async () => {
    const id = await createSmartList('短時間', { type: 'condition', field: 'minutes', operator: 'lte', value: 15 })
    const saved = await snapshot()
    await db.smartLists.clear()
    await restoreBackup(saved)
    expect((await db.smartLists.get(id))?.name).toBe('短時間')
    const corrupt = structuredClone(saved)
    corrupt.smartLists![0].ast = { type: 'condition', field: 'minutes', operator: 'eval' } as never
    expect(() => validateSnapshot(corrupt)).toThrow('演算子')
  })
  it('本人の重点案件と表示件数を復元する', async () => {
    await createTask({ ...newTaskInput(), title: '案件B', project: 'B' })
    await setFocusProjects('2026-10-01', ['B'], 'user')
    await db.settings.update('main', { taskListLimit: 5 })
    const saved = await snapshot()
    await db.focusSelections.clear()
    await restoreBackup(saved)
    expect((await db.focusSelections.toArray())[0]).toMatchObject({ projects: ['B'], source: 'user' })
    expect((await db.settings.get('main'))?.taskListLimit).toBe(5)
  })
  it('Spotlight参照を復元してもタスクは増えない', async () => {
    const id = await createTask({ ...newTaskInput(), title: '集中する作業' })
    await setSpotlight(id, 1, true)
    const saved = await snapshot()
    await db.tasks.clear()
    await restoreBackup(saved)
    expect(await db.tasks.count()).toBe(1)
    expect((await db.tasks.get(id))?.spotlightOrder).toBe(1)
  })
  it('時間目標と当日進捗の固定基準を復元する', async () => {
    const containerId = await createContainer({ kind: 'project', name: '学習', parentId: null })
    const taskId = await createTask({ ...newTaskInput(), title: '練習', scheduledDate: '2026-10-01' })
    await createTimeTarget(containerId, '2026-10-01', '2026-10-07', 180)
    await captureDayProgressBaseline('2026-10-01')
    const saved = await snapshot()
    await db.settings.put({ ...(await db.settings.get('main'))!, timeTargets: [], dayProgressBaseline: undefined })
    await restoreBackup(saved)
    const settings = await db.settings.get('main')
    expect(settings?.timeTargets?.[0].targetMinutes).toBe(180)
    expect(settings?.dayProgressBaseline?.entries[0].taskId).toBe(taskId)
  })
  it('習慣と訂正履歴を復元し、参照先のないログを拒否する', async () => {
    const habitId = await createHabit({ title: '読書', direction: 'increase', unit: '分', targetAmount: 20, cadence: 'daily', weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: 'Asia/Tokyo', routineId: null })
    await recordHabitLog(habitId, '2026-10-01', 10)
    await recordHabitLog(habitId, '2026-10-01', 20, '訂正')
    const saved = await snapshot()
    const invalid = structuredClone(saved)
    invalid.habitLogs![0].habitId = 'missing'
    expect(() => validateSnapshot(invalid)).toThrow('習慣ログ')
    await db.habitLogs.clear(); await db.habits.clear()
    await restoreBackup(saved)
    expect((await db.habitLogs.get(`${habitId}:2026-10-01`))?.history).toHaveLength(1)
  })
  it('目標とチェックインを復元する', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '目標の作業' })
    const goalId = await createGoal({ title: '習得', description: '', parentId: null, dueDate: null, containerId: null, taskIds: [taskId], habitIds: [], manualPercent: null, checkInCadence: 'weekly', checkInQuestion: '進捗は？' })
    await createGoalCheckIn(goalId, '2026-10-01', '進めた')
    const saved = await snapshot()
    await db.goalCheckIns.clear(); await db.goals.clear()
    await restoreBackup(saved)
    expect((await db.goals.get(goalId))?.taskIds).toEqual([taskId])
    expect((await db.goalCheckIns.where('goalId').equals(goalId).first())?.answer).toBe('進めた')
  })
  it('空欄の気力記録と日記を復元する', async () => {
    const trackerId = await createTracker('気力', '段階', 0, 5)
    await recordTrackerEntry(trackerId, null)
    const noteId = await saveDayNote('2026-10-01', 'Asia/Tokyo', '本人のメモ')
    const saved = await snapshot()
    await db.trackerEntries.clear(); await db.trackerDefinitions.clear(); await db.dayNotes.clear()
    await restoreBackup(saved)
    expect((await db.trackerEntries.where('trackerId').equals(trackerId).first())?.value).toBeNull()
    expect((await db.dayNotes.get(noteId))?.humanText).toBe('本人のメモ')
  })
  it('ポモドーロ回数をタスクや作業区間と別に復元する', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '集中' })
    const runtime = startPomodoro(taskId, 25, '2026-10-01T10:00:00.000Z')
    await recordPomodoro(runtime, '2026-10-01T10:25:00.000Z')
    const saved = await snapshot()
    await db.pomodoroCycles.clear()
    await restoreBackup(saved)
    expect((await db.pomodoroCycles.toArray())[0]).toMatchObject({ taskId, targetMinutes: 25, elapsedMinutes: 25 })
  })
})

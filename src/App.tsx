import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArchiveRestore, CalendarDays, Check, CheckCircle2, ChevronDown, Clock3, CloudOff, Database, Download, Focus, FolderTree, History, Inbox, LayoutDashboard, ListTodo, LockKeyhole, Menu, MessageCircle, Moon, MoreHorizontal, Plus, Repeat2, Search, Settings2, ShieldCheck, Sparkles, Tags, Trash2, Upload, X } from 'lucide-react'
import { db, ensureSettings } from './db'
import { bulkUpdateTasksAtomic, createRoutine, createTask, correctCompletion, expandRoutines, newTaskInput, restoreTask, setTaskFlag, trashTask, undoCompletion, updateTask, completeTask, type BulkTaskPatch, type TaskInput } from './commands'
import { addDays, calculateScore, emptyScore, scoreText, today, type ChecklistItem, type Completion, type Container, type Goal, type GoalCheckIn, type LabelDefinition, type LabelGroup, type Routine, type SavedTemplate, type ScoreInput, type Settings, type SmartList, type Task, type TimeBlock, type WorkSession } from './domain'
import { exportBackup, exportPortableJson, exportTasksCsv, exportTasksIcs, inspectBackup, restoreBackup } from './backup'
import { unionSessionMinutes } from './time-tracking'
import { dayCapacity, filterTasksByDates, nextAvailableDate, reviewDueTasks, sortTasks, suggestedTasks, urgency } from './planning'
import { containerPath, containerPointTotals, createContainer, moveContainer, renameContainer } from './containers'
import { addChecklistItem, checklistProgress, convertChecklistItem, toggleChecklistItem } from './checklist'
import { createLabelDefinition, createLabelGroup } from './labels'
import { instantiateTemplate, saveProjectTemplate, saveTaskTemplate } from './templates'
import { selectedGoalContext, selectedTaskContext, type AIStatus } from './ai'
import Braindump from './Braindump'
import TaskMaterials from './TaskMaterials'
import TaskDependencies from './TaskDependencies'
import PeriodPlanningView from './PeriodPlanningView'
import CalendarPlanningView from './CalendarPlanningView'
import { timeBlockCapacity } from './calendar-planning'
import AutoSchedulePanel from './AutoSchedulePanel'
import TaskRolloverHistory from './TaskRolloverHistory'
import { dueSnoozes, rolloverTask, snoozeTask } from './rollover'
import { ThemeRulesView } from './ThemeRulesView'
import { ContextSuggestions } from './ContextSuggestions'
import { assignDaySection, groupTodayTasks, setDaySectionMode, type DaySectionMode } from './day-sections'
import { SmartListControls } from './SmartListControls'
import { querySmartList } from './smart-lists'
import { FocusProjectsView } from './FocusProjectsView'
import { MatrixView } from './MatrixView'
import { truncateTasks } from './list-view'
import TaskStaleness from './TaskStaleness'
import TaskBreakdownWizard from './TaskBreakdownWizard'
import DurationEstimate from './DurationEstimate'
import DayProgressView from './DayProgressView'
import TimeTargetsView from './TimeTargetsView'
import { captureDayProgressBaseline } from './progress'
import HabitsView from './HabitsView'
import GoalsView from './GoalsView'
import JournalView from './JournalView'
import AnalyticsView from './AnalyticsView'
import PrintPreview from './PrintPreview'
import PomodoroPanel from './PomodoroPanel'
import SessionCorrectionView from './SessionCorrectionView'
import { FocusChoiceTools } from './FocusChoiceTools'
import SuperFocusView from './SuperFocusView'
import TopOfMindView from './TopOfMindView'
import WallView from './WallView'
import { findNavigation, visibleNavigation, type NavigationId } from './navigation'
import { featureEnabled, OPTIONAL_FEATURE_IDS, setFeatureVisible } from './features'
import WorkflowPresetsView from './WorkflowPresetsView'
import AppearanceSettingsView from './AppearanceSettingsView'
import { applyAppearance } from './appearance'
import { setSpotlight } from './focus-tools'
import { projectNextStepStatus } from './dependencies'
import './App.css'

type View = NavigationId | 'mini'
const INITIAL_NOW = new Date()
const nav: { view: NavigationId; label: string; icon: typeof Inbox }[] = [
  { view: 'today', label: '今日', icon: LayoutDashboard }, { view: 'tasks', label: 'すべてのタスク', icon: ListTodo }, { view: 'wall', label: '付箋のWall', icon: LayoutDashboard }, { view: 'projects', label: 'カテゴリとプロジェクト', icon: FolderTree }, { view: 'labels', label: 'ラベル', icon: Tags }, { view: 'saved', label: 'テンプレート', icon: ArchiveRestore }, { view: 'plan', label: '計画', icon: CalendarDays }, { view: 'periods', label: '週・月・四半期', icon: CalendarDays }, { view: 'calendar', label: '時間枠と予定', icon: CalendarDays },
  { view: 'coach', label: 'コーチ', icon: MessageCircle }, { view: 'focus', label: '集中', icon: Focus }, { view: 'history', label: '実績', icon: History }, { view: 'routines', label: 'ルーティン', icon: Repeat2 }, { view: 'habits', label: '習慣', icon: Repeat2 }, { view: 'goals', label: '目標', icon: Sparkles }, { view: 'journal', label: 'ノートと記録', icon: History }, { view: 'settings', label: '設定とデータ', icon: Settings2 }
]
function dateLabel(date: string | null) { if (!date) return '日付なし'; const d = new Date(`${date}T12:00:00`); return `${d.getMonth() + 1}/${d.getDate()}` }
function dateLong(date: string) { const d = new Date(`${date}T12:00:00`); return new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' }).format(d) }
function intOrNull(s: string) { return s.trim() === '' ? null : Number(s) }
function App() {
  const [view, setView] = useState<View>(() => (location.hash.slice(1) as View) || 'today')
  const [editor, setEditor] = useState<Task | 'new' | null>(null)
  const [toast, setToast] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [featureQuery, setFeatureQuery] = useState('')
  const [nowIso, setNowIso] = useState(() => new Date().toISOString())
  const tasks = useLiveQuery(() => db.tasks.toArray(), []) ?? []
  const completions = useLiveQuery(() => db.completions.toArray(), []) ?? []
  const ledger = useLiveQuery(() => db.ledger.toArray(), []) ?? []
  const sessions = useLiveQuery(() => db.sessions.toArray(), []) ?? []
  const routines = useLiveQuery(() => db.routines.toArray(), []) ?? []
  const containers = useLiveQuery(() => db.containers.toArray(), []) ?? []
  const labelGroups = useLiveQuery(() => db.labelGroups.toArray(), []) ?? []
  const labelDefinitions = useLiveQuery(() => db.labelDefinitions.toArray(), []) ?? []
  const savedTemplates = useLiveQuery(() => db.savedTemplates.toArray(), []) ?? []
  const dependencies = useLiveQuery(() => db.taskDependencies.toArray(), []) ?? []
  const planningBuckets = useLiveQuery(() => db.planningBuckets.toArray(), []) ?? []
  const timeBlocks = useLiveQuery(() => db.timeBlocks.toArray(), []) ?? []
  const calendarEvents = useLiveQuery(() => db.calendarEvents.toArray(), []) ?? []
  const themeRules = useLiveQuery(() => db.themeRules.toArray(), []) ?? []
  const smartLists = useLiveQuery(() => db.smartLists.toArray(), []) ?? []
  const focusSelections = useLiveQuery(() => db.focusSelections.toArray(), []) ?? []
  const goals = useLiveQuery(() => db.goals.toArray(), []) ?? []
  const goalCheckIns = useLiveQuery(() => db.goalCheckIns.toArray(), []) ?? []
  const settings = useLiveQuery(() => db.settings.get('main'), [])
  const active = tasks.filter(t => !t.deletedAt)
  const open = active.filter(t => t.status === 'open')
  const currentDate = today()
  const visibleOpen = open.filter(t => !t.snoozedUntil || t.snoozedUntil <= nowIso)
  const scheduled = visibleOpen.filter(t => t.scheduledDate === currentDate)
  const overdue = visibleOpen.filter(t => t.dueDate && t.dueDate < currentDate)
  const todayTasks = [...new Map([...overdue, ...scheduled].map(t => [t.id, t])).values()].sort((a, b) => (b.importance - a.importance) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'))
  const completedToday = completions.filter(c => c.currentAt && today(new Date(c.currentAt)) === currentDate)
  const todayPoints = completedToday.reduce((n, c) => n + (c.netPoints ?? 0), 0)
  const pendingPoints = completedToday.filter(c => c.netPoints === null).length
  const plannedMinutes = timeBlockCapacity(currentDate, open, timeBlocks).totalMinutes
  const plannedPoints = todayTasks.reduce((n, t) => n + (t.effectivePoints ?? 0), 0)
  const snoozeAlerts = dueSnoozes(active, nowIso)
  const desktopNavigation = visibleNavigation(settings?.navDesktop, 'desktop')
  const mobileNavigation = visibleNavigation(settings?.navMobile, 'mobile')

  useEffect(() => { if (location.hash === '#mini') return; ensureSettings().then(() => expandRoutines()).then(() => captureDayProgressBaseline(currentDate)).catch(e => setToast(e instanceof Error ? e.message : String(e))) }, [currentDate])
  useEffect(() => applyAppearance(settings?.appearance), [settings?.appearance])
  useEffect(() => { const timer = setInterval(() => setNowIso(new Date().toISOString()), 60000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    if (!settings?.notifications || !('Notification' in window) || Notification.permission !== 'granted') return
    for (const task of snoozeAlerts) {
      const key = `snooze-notified:${settings.datasetId}:${task.id}:${task.snoozedUntil}`
      if (localStorage.getItem(key)) continue
      try { new Notification('タスクを再表示', { body: task.title }); localStorage.setItem(key, '1') } catch { /* in-app reminder remains visible */ }
    }
  }, [settings, snoozeAlerts])
  useEffect(() => { location.hash = view }, [view])
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 4500); return () => clearTimeout(id) }, [toast])
  function showError(e: unknown) { setToast(`エラー: ${e instanceof Error ? e.message : String(e)}`) }
  async function run(fn: () => Promise<unknown>, success = 'この端末に保存しました') { try { await fn(); setToast(success); return true } catch (e) { showError(e); return false } }
  function go(next: View) { setView(next); setMenuOpen(false) }
  async function toggleTask(t: Task) { await run(() => t.status === 'open' ? completeTask(t.id, t.revision) : undoCompletion(t.id, t.revision), t.status === 'open' ? '完了を記録しました' : '完了を取り消しました'); await expandRoutines().catch(showError) }
  const focusSelection = focusSelections.find(selection => selection.date === currentDate && selection.ownerId === settings?.profileId)
  const suggested = suggestedTasks(tasks, currentDate, 3, dependencies, nowIso, themeRules.filter(rule => rule.ownerId === settings?.profileId), focusSelection?.projects ?? [])
  const reviews = reviewDueTasks(visibleOpen, currentDate)
  if (!settings) return <div className="loading">ローカルデータを準備しています…</div>
  if (view === 'mini') return <TopOfMindView tasks={active} />

  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Sparkles size={22} /></div><div><strong>michi</strong><small>Character Coach ToDo</small></div></div>
      <div className="space-label">WORKSPACE <ChevronDown size={14} /></div>
      <nav>{nav.filter(n => desktopNavigation.includes(n.view) && featureEnabled(settings.hiddenFeatures, n.view)).map(n => <button key={n.view} className={`nav-item ${view === n.view ? 'selected' : ''}`} onClick={() => go(n.view)}><n.icon size={19} strokeWidth={1.9} /><span>{n.label}</span>{n.view === 'tasks' && <em>{open.length}</em>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="offline-note"><CloudOff size={16} /><span>この端末で保存中</span></div><div className="mini-profile"><span className="profile-avatar">私</span><div><strong>マイワークスペース</strong><small>オフラインで利用できます</small></div></div></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><button className="icon-button mobile-menu" aria-label="メニュー" onClick={() => setMenuOpen(!menuOpen)}><Menu size={22} /></button><div className="breadcrumbs">マイワークスペース <span>/</span> <strong>{nav.find(n => n.view === view)?.label}</strong></div><div className="top-actions"><label className="feature-finder"><Search size={14} /><input aria-label="機能を探す" type="search" list="all-features" value={featureQuery} onChange={e => { const value = e.target.value; setFeatureQuery(value); const exact = nav.find(item => item.label === value || item.view === value); if (exact) { go(exact.view); setFeatureQuery('') } }} onKeyDown={e => { if (e.key === 'Enter') { const found = findNavigation(nav, featureQuery); if (found) { go(found); setFeatureQuery('') } } }} placeholder="機能を探す" /></label><datalist id="all-features">{nav.map(item => <option key={item.view} value={item.label} />)}</datalist><button className="icon-button" aria-label="設定を開く" onClick={() => go('settings')}><Settings2 size={17} /></button><span className="saved-pill"><ShieldCheck size={15} /> この端末・保存済み</span><button className="primary-button top-add" onClick={() => setEditor('new')}><Plus size={17} /> 新しいタスク</button></div></header>
      <div className="page-content">
        {!featureEnabled(settings.hiddenFeatures, view) ? <section className="card list-card"><h1>{nav.find(item => item.view === view)?.label}はOFFです</h1><p>表示だけを停止しています。保存済みデータ、通知、バックグラウンド処理の設定は変わりません。</p><button className="primary-button" onClick={() => run(() => setFeatureVisible(view as NavigationId, true), '機能をONにしました')}>この機能をONにする</button></section> : <>
        {view === 'today' && <>
          <div className="page-heading"><div><span className="eyebrow">YOUR DAY · {dateLong(currentDate)}</span><h1>今日を、ひとつずつ。</h1><p>いま必要なことから始めましょう。予定はいつでも調整できます。</p></div><button className="secondary-button" onClick={() => go('plan')}><CalendarDays size={17} /> 計画を見る</button></div>
          <div className="stats-grid"><Stat icon={<ListTodo size={19} />} label="今日の予定" value={`${scheduled.length} 件`} detail={overdue.length ? `期限超過 ${overdue.length} 件` : 'いま進めるタスク'} tone="lilac" /><Stat icon={<Clock3 size={19} />} label="予定時間" value={`${plannedMinutes} 分`} detail={`目安 ${settings.dailyMinutes} 分 / 日`} tone="peach" /><Stat icon={<Sparkles size={19} />} label="必要ポイント" value={`${plannedPoints} pt`} detail={`目安 ${settings.dailyPoints} pt / 日`} tone="mint" /><Stat icon={<CheckCircle2 size={19} />} label="今日の実績" value={`${todayPoints} pt`} detail={`${completedToday.length} 件完了${pendingPoints ? ` · 未設定${pendingPoints}件` : ''}`} tone="blue" /></div>
          <DayProgressView baseline={settings.dayProgressBaseline} date={currentDate} tasks={active} completions={completions} />
          <div className="two-column"><TodaySections tasks={todayTasks} blocks={timeBlocks} date={currentDate} mode={settings.daySectionMode ?? 'halfday'} onEdit={setEditor} onToggle={toggleTask} onNew={() => setEditor('new')} onAll={() => go('tasks')} run={run} />
          <section className="card coach-panel"><div className="card-heading"><div><span className="eyebrow">YOUR COMPANION</span><h2>{settings.coachName}から</h2></div><span className="template-tag">定型メッセージ</span></div><div className="coach-illustration"><div className="coach-orbit orbit-one"/><div className="coach-orbit orbit-two"/><div className="coach-face"><span className="coach-eye"/><span className="coach-eye"/><span className="coach-mouth"/></div><span className="star star-one">✦</span><span className="star star-two">✧</span></div><div className="speech">{todayTasks.length ? `まずは「${todayTasks[0].title}」から。ひとつ終われば、次を一緒に選びましょう。` : '今日は何から始めましょうか。新しいタスクも、ゆっくり整理できます。'}</div><button className="secondary-button full" onClick={() => go('coach')}><MessageCircle size={16} /> コーチを開く</button></section></div>
          {reviews.length > 0 && <section className="card suggestion-card"><div className="card-heading"><div><span className="eyebrow">REVIEW</span><h2>見直しが必要</h2></div><span className="subtle">見直しだけでは完了しません</span></div><div className="suggestion-list">{reviews.map(task => <button key={task.id} className="suggestion" onClick={() => setEditor(task)}><span className="suggestion-dot"/><span>{task.title}</span><small>見直し {dateLabel(task.reviewDate)}</small></button>)}</div></section>}
          {open.some(task => task.pinned && (!task.snoozedUntil || task.snoozedUntil <= nowIso)) && <section className="card suggestion-card"><div className="card-heading"><h2>ピン留め</h2></div>{open.filter(task => task.pinned && (!task.snoozedUntil || task.snoozedUntil <= nowIso)).map(task => <TaskRow key={task.id} task={task} onToggle={() => toggleTask(task)} onEdit={() => setEditor(task)} />)}</section>}
          {snoozeAlerts.length > 0 && <section className="card suggestion-card"><div className="card-heading"><h2>スヌーズ終了</h2></div><div className="suggestion-list">{snoozeAlerts.map(task => <button key={task.id} className="suggestion" onClick={() => setEditor(task)}>{task.title} · 再表示 {new Date(task.snoozedUntil!).toLocaleString('ja-JP')}</button>)}</div></section>}
          <FocusProjectsView tasks={open} selection={focusSelection} date={currentDate} run={run} />
          <section className="card suggestion-card"><div className="card-heading"><div><span className="eyebrow">NEXT UP</span><h2>次に考えること</h2></div><span className="subtle">登録済みタスクから表示</span></div><div className="suggestion-list">{suggested.length ? suggested.map(t => <button key={t.id} className="suggestion" onClick={() => setEditor(t)}><span className="suggestion-dot"/><span>{t.title}</span><small>{t.dueDate ? `期限 ${dateLabel(t.dueDate)}` : t.scheduledDate ? `予定 ${dateLabel(t.scheduledDate)}` : '日付なし'}</small></button>) : <p className="muted">未完了のタスクはありません。</p>}</div></section>
          <ContextSuggestions tasks={tasks} dependencies={dependencies} themes={themeRules.filter(rule => rule.ownerId === settings.profileId)} date={currentDate} now={nowIso} onEdit={setEditor} />
        </>}
        {view === 'tasks' && <TasksView tasks={tasks} lists={smartLists} settings={settings} onEdit={setEditor} onToggle={toggleTask} onNew={() => setEditor('new')} run={run} />}
        {view === 'wall' && <WallView tasks={tasks} settings={settings} onEdit={setEditor} run={run} />}
        {view === 'projects' && <ContainersView containers={containers} tasks={tasks} completions={completions} dependencies={dependencies} ownerId={settings.profileId} run={run} />}
        {view === 'labels' && <LabelsView groups={labelGroups} definitions={labelDefinitions} ownerId={settings.profileId} run={run} />}
        {view === 'saved' && <SavedItemsView templates={savedTemplates} containers={containers} tasks={active} ownerId={settings.profileId} run={run} />}
        {view === 'plan' && <><PlanView tasks={open} blocks={timeBlocks} settings={settings} onEdit={setEditor} /><ThemeRulesView tasks={active} rules={themeRules} ownerId={settings.profileId} run={run} /><AutoSchedulePanel tasks={tasks} dependencies={dependencies} blocks={timeBlocks} settings={settings} run={run} /></>}
        {view === 'periods' && <PeriodPlanningView buckets={planningBuckets} tasks={tasks} ownerId={settings.profileId} run={run} />}
        {view === 'calendar' && <CalendarPlanningView blocks={timeBlocks} events={calendarEvents} tasks={tasks} projects={containers} sessions={sessions} ownerId={settings.profileId} run={run} />}
        {view === 'coach' && <CoachView tasks={open} goals={goals.filter(goal => goal.ownerId === settings.profileId && !goal.deletedAt)} checkIns={goalCheckIns} settings={settings} onEdit={setEditor} onNew={() => setEditor('new')} />}
        {view === 'focus' && <><SuperFocusView tasks={open} sessions={sessions} onEdit={setEditor} onBack={() => go('today')} run={run} /><PomodoroPanel tasks={open} run={run} /><FocusChoiceTools tasks={tasks} dependencies={dependencies} themes={themeRules.filter(rule => rule.ownerId === settings.profileId)} focusProjects={focusSelection?.projects ?? []} lists={smartLists} ownerId={settings.profileId} date={currentDate} now={nowIso} onEdit={setEditor} run={run} /></>}
        {view === 'history' && <><HistoryView completions={completions} ledger={ledger} sessions={sessions} tasks={tasks} onEdit={id => { const t = tasks.find(x => x.id === id); if (t) setEditor(t) }} run={run} /><TimeTargetsView settings={settings} containers={containers} tasks={tasks} sessions={sessions} run={run} /><AnalyticsView completions={completions} sessions={sessions} /><SessionCorrectionView sessions={sessions} tasks={tasks} run={run} /></>}
        {view === 'routines' && <RoutinesView routines={routines} run={run} />}
        {view === 'habits' && <HabitsView run={run} />}
        {view === 'goals' && <GoalsView run={run} />}
        {view === 'journal' && <JournalView run={run} />}
        {view === 'settings' && <SettingsView settings={settings} run={run} />}
        </>}
      </div>
    </main>
    <nav className="bottom-nav">{nav.filter(n => mobileNavigation.includes(n.view) && featureEnabled(settings.hiddenFeatures, n.view)).map(n => <button key={n.view} className={view === n.view ? 'selected' : ''} onClick={() => go(n.view)}><n.icon size={20} /><span>{n.label === 'すべてのタスク' ? 'タスク' : n.label}</span></button>)}<button className="bottom-add" aria-label="タスク追加" onClick={() => setEditor('new')}><Plus size={22} /></button></nav>
    {editor && <TaskEditor key={editor === 'new' ? 'new' : `${editor.id}:${editor.revision}`} task={editor === 'new' ? null : editor} containers={containers.filter(item => item.ownerId === settings.profileId && !item.deletedAt)} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setToast('この端末に保存しました') }} onError={showError} run={run} />}
    {toast && <div role={toast.startsWith('エラー:') ? 'alert' : 'status'} className="toast"><span>{toast}</span><button aria-label="閉じる" onClick={() => setToast('')}><X size={16} /></button></div>}
  </div>
}

function Stat({ icon, label, value, detail, tone }: { icon: React.ReactNode; label: string; value: string; detail: string; tone: string }) { return <div className={`stat-card ${tone}`}><div className="stat-icon">{icon}</div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div> }
function Empty({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) { return <div className="empty"><div className="empty-icon"><Inbox size={27} /></div><strong>{title}</strong><p>{detail}</p>{action}</div> }
function TaskRow({ task, onToggle, onEdit }: { task: Task; onToggle: () => void; onEdit: () => void }) { return <div className={`task-row ${task.status === 'completed' ? 'done' : ''}`}><button className="check-button" onClick={onToggle} aria-label={`${task.title}を${task.status === 'completed' ? '未完了に戻す' : '完了する'}`}>{task.status === 'completed' && <Check size={15} />}</button><button className="task-main" onClick={onEdit}><strong>{task.title}</strong><span>{task.project && <em>{task.project}</em>}{task.scheduledDate && <>予定 {dateLabel(task.scheduledDate)}</>}{task.dueDate && <> · 期限 {dateLabel(task.dueDate)} · 緊急 {urgency(task, today())}</>}{nextAvailableDate(task) && nextAvailableDate(task)! > today() && <> · 延期中（{dateLabel(nextAvailableDate(task))}から）</>}{task.snoozedUntil && <> · スヌーズ設定（{new Date(task.snoozedUntil).toLocaleString('ja-JP')}まで）</>}</span></button><span className={`score-pill ${task.score.mode}`}>{scoreText(task)}</span><button className="row-more" aria-label="編集" onClick={onEdit}><MoreHorizontal size={18} /></button></div> }

function TodaySections({ tasks, blocks, date, mode, onEdit, onToggle, onNew, onAll, run }: { tasks: Task[]; blocks: TimeBlock[]; date: string; mode: DaySectionMode; onEdit: (task: Task) => void; onToggle: (task: Task) => void; onNew: () => void; onAll: () => void; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const grouped = groupTodayTasks(tasks, mode, date, blocks)
  const modes: { mode: DaySectionMode; label: string }[] = [{ mode: 'halfday', label: '午前・午後' }, { mode: 'category', label: 'カテゴリ' }, { mode: 'timeblock', label: '時間枠' }, { mode: 'custom', label: 'カスタム' }]
  return <section className="card task-card">
    <div className="card-heading"><div><span className="eyebrow">TODAY'S LIST</span><h2>今日のタスク</h2><small>{grouped.taskIds.length}件 · {grouped.points}pt{grouped.unknownPoints ? ` · 未設定${grouped.unknownPoints}件` : ''}</small></div><button className="text-button" onClick={onAll}>すべて見る →</button></div>
    <div className="segmented day-section-modes">{modes.map(item => <button key={item.mode} className={mode === item.mode ? 'active' : ''} onClick={() => run(() => setDaySectionMode(item.mode), '表示区分を保存しました')}>{item.label}</button>)}</div>
    {grouped.sections.length ? grouped.sections.map(section => <div className="day-section" key={section.key}><div className="day-section-heading"><strong>{section.label}</strong><small>{section.tasks.length}件 · {section.tasks.reduce((sum, task) => sum + (task.effectivePoints ?? 0), 0)}pt</small></div>{section.tasks.map(task => <div key={task.id} className="day-section-task"><TaskRow task={task} onToggle={() => onToggle(task)} onEdit={() => onEdit(task)} />{mode === 'halfday' && <select aria-label={`${task.title}の午前午後`} value={task.dayHalf ?? ''} onChange={event => run(() => assignDaySection(task.id, task.revision, 'dayHalf', event.target.value || null), '区分を保存しました')}><option value="">未指定</option><option value="morning">午前</option><option value="afternoon">午後</option></select>}{mode === 'custom' && <input key={`${task.id}:${task.revision}`} aria-label={`${task.title}のカスタム区分`} defaultValue={task.customSection ?? ''} maxLength={60} placeholder="区分名" onBlur={event => { const value = event.target.value.trim() || null; if (value !== (task.customSection ?? null)) void run(() => assignDaySection(task.id, task.revision, 'customSection', value), '区分を保存しました') }} />}</div>)}</div>) : <Empty title="今日の予定はまだありません" detail="タスクを作って予定日を今日にすると、ここに表示されます。" action={<button className="secondary-button" onClick={onNew}><Plus size={16} /> 追加する</button>} />}
  </section>
}

function TasksView({ tasks, lists, settings, onEdit, onToggle, onNew, run }: { tasks: Task[]; lists: SmartList[]; settings: Settings; onEdit: (t: Task) => void; onToggle: (t: Task) => void; onNew: () => void; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [filter, setFilter] = useState<'open' | 'completed' | 'trash' | 'backburner' | 'orbit'>('open')
  const [sortBy, setSortBy] = useState<'scheduled' | 'frog' | 'weight'>('scheduled')
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const [targetDateFilter, setTargetDateFilter] = useState('')
  const [dueDateFilter, setDueDateFilter] = useState('')
  const [showBulk, setShowBulk] = useState(false)
  const [selected, setSelected] = useState<Record<string, number>>({})
  const [printOpen, setPrintOpen] = useState(false)
  const [bulkNotice, setBulkNotice] = useState('')
  const [smartListId, setSmartListId] = useState('')
  const ownerId = settings.profileId
  function chooseFilter(next: typeof filter) { setFilter(next); setSelected({}); setBulkNotice('') }
  const projects = [...new Set(tasks.map(t => t.project).filter(Boolean))]
  const activeList = lists.find(list => list.id === smartListId && list.ownerId === ownerId)
  const smartIds = activeList ? new Set(querySmartList(activeList, tasks, ownerId).map(task => task.id)) : null
  const visible = sortTasks(filterTasksByDates(tasks, targetDateFilter || null, dueDateFilter || null)
    .filter(t => !smartIds || smartIds.has(t.id))
    .filter(t => filter === 'trash' ? !!t.deletedAt : !t.deletedAt && (filter === 'backburner' ? !!t.backburner && t.status === 'open' : filter === 'orbit' ? !!t.orbit && t.status === 'open' : t.status === filter && (filter !== 'open' || !t.backburner)))
    .filter(t => !project || t.project === project)
    .filter(t => !query || [t.title, t.notes, ...t.labels].join(' ').toLowerCase().includes(query.toLowerCase())), sortBy)
  const { shown, remaining } = truncateTasks(visible, settings.taskListLimit ?? null)

  return <>
    <div className="page-heading"><div><span className="eyebrow">YOUR TASKS</span><h1>すべてのタスク</h1><p>思いついたことを記録して、必要な作業を見渡せます。</p></div><button className="primary-button" onClick={onNew}><Plus size={17} /> タスクを追加</button></div>
    <SmartListControls lists={lists} ownerId={ownerId} selectedId={smartListId} onSelect={setSmartListId} run={run} />
    <MatrixView tasks={tasks} lists={lists} ownerId={ownerId} date={today()} onEdit={onEdit} />
    <div className="toolbar">
      <div className="segmented">
        <button className={filter === 'open' ? 'active' : ''} onClick={() => chooseFilter('open')}>未完了</button>
        <button className={filter === 'completed' ? 'active' : ''} onClick={() => chooseFilter('completed')}>完了</button>
        <button className={filter === 'trash' ? 'active' : ''} onClick={() => chooseFilter('trash')}>ゴミ箱</button>
        <button className={filter === 'backburner' ? 'active' : ''} onClick={() => chooseFilter('backburner')}>保留</button>
        <button className={filter === 'orbit' ? 'active' : ''} onClick={() => chooseFilter('orbit')}>Orbit</button>
      </div>
      <div className="toolbar-right">
        <label className="search"><Search size={17} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="タスクを検索" /></label>
        <select aria-label="プロジェクト" value={project} onChange={e => setProject(e.target.value)}><option value="">すべてのプロジェクト</option>{projects.map(x => <option key={x}>{x}</option>)}</select>
        <select aria-label="並び替え" value={sortBy} onChange={event => setSortBy(event.target.value as typeof sortBy)}><option value="scheduled">予定日順</option><option value="frog">Frog順</option><option value="weight">Weight順</option></select>
        <select aria-label="一覧の表示件数" value={settings.taskListLimit ?? ''} onChange={event => { const limit = event.target.value ? Number(event.target.value) : null; setSelected({}); void run(() => db.settings.update('main', { taskListLimit: limit }).then(() => undefined), '表示件数を保存しました') }}><option value="">全件表示</option>{[5, 10, 20, 50].map(limit => <option key={limit} value={limit}>{limit}件</option>)}</select>
        <label className="field">目標日<input aria-label="目標日で検索" type="date" value={targetDateFilter} onChange={event => setTargetDateFilter(event.target.value)} /></label>
        <label className="field">外部期限<input aria-label="外部期限で検索" type="date" value={dueDateFilter} onChange={event => setDueDateFilter(event.target.value)} /></label>
      </div>
    </div>
    <section className="card list-card">
      <div className="list-header"><span>表示 {shown.length} / 全体 {visible.length} 件{remaining > 0 ? ` · 残り${remaining}件` : ''}</span>{remaining > 0 && <button className="text-button" onClick={() => run(() => db.settings.update('main', { taskListLimit: null }).then(() => undefined), '全件表示にしました')}>全件表示</button>}<button className="text-button" onClick={() => setShowBulk(!showBulk)}>{showBulk ? '閉じる' : 'クイック追加・複数行入力'}</button></div>
      {showBulk && <Braindump />}
      {filter !== 'trash' && shown.length > 0 && <div className="bulk-select-bar"><button className="text-button" onClick={() => setSelected(Object.fromEntries(shown.slice(0, 100).map(task => [task.id, task.revision])))}>表示中の先頭100件を選択</button><span>{Object.keys(selected).length} 件を選択中</span>{Object.keys(selected).length > 0 && <><button className="text-button" onClick={() => setPrintOpen(true)}>選択した一覧を印刷</button><button className="text-button" onClick={() => setSelected({})}>選択を解除</button></>}</div>}
      {bulkNotice && <p role="status" className="bulk-notice">{bulkNotice}</p>}
      {Object.keys(selected).length > 0 && filter !== 'trash' && <BulkEdit items={Object.entries(selected).map(([id, revision]) => ({ id, revision }))} onDone={count => { setSelected({}); setBulkNotice(`${count}件を一括更新しました`) }} />}
      {shown.length ? shown.map(t => <div key={t.id} className="task-with-actions">
        {filter !== 'trash' && <input className="task-select" type="checkbox" aria-label={`${t.title}を一括編集に選択`} checked={selected[t.id] !== undefined} onChange={e => setSelected(current => { const next = { ...current }; if (e.target.checked) next[t.id] = t.revision; else delete next[t.id]; return next })} />}
        <TaskRow task={t} onToggle={() => onToggle(t)} onEdit={() => onEdit(t)} />
        {!t.deletedAt && t.status === 'open' && <div className="task-flags"><button className="text-button" onClick={() => run(() => setTaskFlag(t.id, t.revision, 'pinned', !t.pinned))}>{t.pinned ? 'ピン解除' : 'ピン留め'}</button><button className="text-button" onClick={() => run(() => setSpotlight(t.id, t.revision, t.spotlightOrder == null), t.spotlightOrder == null ? 'Spotlightへ追加しました' : 'Spotlightから外しました')}>{t.spotlightOrder == null ? 'Spotlightへ' : 'Spotlight解除'}</button><button className="text-button" onClick={() => run(() => setTaskFlag(t.id, t.revision, 'backburner', !t.backburner))}>{t.backburner ? '保留解除' : '保留'}</button><button className="text-button" onClick={() => run(() => setTaskFlag(t.id, t.revision, 'orbit', !t.orbit))}>{t.orbit ? 'Orbit解除' : 'Orbitへ'}</button>{t.scheduledDate && <button className="text-button" onClick={() => run(() => rolloverTask(t.id, t.revision, addDays(t.scheduledDate!, 1)), '1日繰り越しました')}>1日繰越</button>}<button className="text-button" onClick={() => run(() => snoozeTask(t.id, t.revision, t.snoozedUntil ? null : new Date(`${addDays(today(), 1)}T09:00:00`).toISOString()), t.snoozedUntil ? 'スヌーズを解除しました' : '明日までスヌーズしました')}>{t.snoozedUntil ? 'スヌーズ解除' : '明日までスヌーズ'}</button></div>}
        {filter === 'trash' ? <button className="ghost-action" onClick={() => run(() => restoreTask(t.id, t.revision))}><ArchiveRestore size={15} /> 復元</button> : <button className="ghost-action" onClick={() => run(() => trashTask(t.id, t.revision))}><Trash2 size={15} /> ゴミ箱</button>}
      </div>) : <Empty title="該当するタスクはありません" detail="検索条件を変えるか、新しく追加してください。" action={<button className="secondary-button" onClick={onNew}><Plus size={16} /> タスクを追加</button>} />}
    </section>
    {printOpen && <PrintPreview tasks={tasks.filter(task => selected[task.id] !== undefined)} onClose={() => setPrintOpen(false)} />}
  </>
}
function BulkEdit({ items, onDone }: { items: { id: string; revision: number }[]; onDone: (count: number) => void }) {
  const [field, setField] = useState<'project' | 'scheduledDate' | 'dueDate' | 'importance'>('project')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  async function save() {
    setBusy(true); setNotice('')
    try {
      const patch: BulkTaskPatch = field === 'importance' ? { importance: Number(value) } : field === 'project' ? { project: value } : field === 'scheduledDate' ? { scheduledDate: value || null } : { dueDate: value || null }
      await bulkUpdateTasksAtomic(items, patch)
      onDone(items.length)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <div className="bulk-edit-panel"><strong>{items.length}件をまとめて編集</strong><p>全件のrevisionを確認し、競合があれば一件も変更しません。</p><div className="bulk-edit-controls"><select aria-label="一括編集する項目" value={field} onChange={event => { setField(event.target.value as typeof field); setValue(''); setNotice('') }}><option value="project">プロジェクト</option><option value="scheduledDate">予定日</option><option value="dueDate">締め切り</option><option value="importance">重要度</option></select>{field === 'importance' ? <select aria-label="一括編集する値" value={value} onChange={event => setValue(event.target.value)}><option value="">選択してください</option><option value="0">低</option><option value="1">通常</option><option value="2">高</option><option value="3">最優先</option></select> : <input aria-label="一括編集する値" type={field === 'project' ? 'text' : 'date'} value={value} onChange={event => setValue(event.target.value)} placeholder={field === 'project' ? 'プロジェクト名（空欄でInbox）' : undefined} />}<button className="secondary-button" disabled={busy || items.length > 100 || (field === 'importance' && value === '')} onClick={save}>{busy ? '保存中…' : '全件を保存'}</button></div>{notice && <p role="status" className="bulk-edit-notice">{notice}</p>}</div>
}
function ContainersView({ containers, tasks, completions, dependencies, ownerId, run }: { containers: Container[]; tasks: Task[]; completions: Completion[]; dependencies: import('./domain').TaskDependency[]; ownerId: string; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [name, setName] = useState(''), [kind, setKind] = useState<Container['kind']>('project'), [parentId, setParentId] = useState('')
  const [editing, setEditing] = useState<string | null>(null), [editName, setEditName] = useState('')
  const own = containers.filter(item => item.ownerId === ownerId && !item.deletedAt)
  const sorted = [...own].sort((a, b) => containerPath(a.id, own).localeCompare(containerPath(b.id, own), 'ja'))
  const totals = containerPointTotals(own, tasks, completions)
  const nextSteps = projectNextStepStatus(own, tasks, dependencies)
  async function add() {
    if (await run(() => createContainer({ kind, name, parentId: parentId || null }), 'カテゴリ・プロジェクトを作成しました')) { setName(''); setParentId('') }
  }
  async function saveName(item: Container) {
    if (await run(() => renameContainer(item.id, item.revision, editName), '名前を変更しました')) setEditing(null)
  }
  return <>
    <div className="page-heading"><div><span className="eyebrow">STRUCTURE</span><h1>カテゴリとプロジェクト</h1><p>12段までの階層で整理します。親のポイントは子タスクの実績を集計した値です。</p></div></div>
    <section className="card list-card"><div className="card-heading"><h2>新しい項目</h2></div><div className="container-create"><select aria-label="種類" value={kind} onChange={event => { setKind(event.target.value as Container['kind']); setParentId('') }}><option value="category">カテゴリ</option><option value="project">プロジェクト</option></select><input aria-label="名前" value={name} maxLength={100} onChange={event => setName(event.target.value)} placeholder="名前" /><select aria-label="親" value={parentId} onChange={event => setParentId(event.target.value)}><option value="">最上位</option>{sorted.filter(item => kind === 'project' || item.kind === 'category').map(item => <option key={item.id} value={item.id}>{containerPath(item.id, own)}</option>)}</select><button className="primary-button" disabled={!name.trim()} onClick={add}>作成</button></div></section>
    <section className="card list-card"><div className="card-heading"><h2>階層一覧</h2><span className="subtle">{own.length}件</span></div>{sorted.length ? sorted.map(item => <div className="container-row" key={item.id}>
      <div className="container-main"><span className="status-tag">{item.kind === 'category' ? 'カテゴリ' : 'プロジェクト'}</span>{editing === item.id ? <><input aria-label={`${item.name}の新しい名前`} value={editName} maxLength={100} onChange={event => setEditName(event.target.value)} /><button className="text-button" onClick={() => saveName(item)}>保存</button><button className="text-button" onClick={() => setEditing(null)}>取消</button></> : <><strong>{containerPath(item.id, own)}</strong><button className="text-button" onClick={() => { setEditing(item.id); setEditName(item.name) }}>名前変更</button></>}</div>
      <span>{totals.get(item.id) ?? 0} pt · 直接のタスク {tasks.filter(task => task.containerId === item.id && !task.deletedAt).length}件</span>
      {item.kind === 'project' && ['empty', 'blocked'].includes(nextSteps.get(item.id) ?? '') && <span className="status-tag">{nextSteps.get(item.id) === 'empty' ? '次の作業を登録' : '前提タスクを確認'}</span>}
      <select aria-label={`${item.name}の移動先`} value={item.parentId ?? ''} onChange={event => run(() => moveContainer(item.id, item.revision, event.target.value || null), '移動しました')}><option value="">最上位</option>{sorted.filter(candidate => candidate.id !== item.id && (item.kind === 'project' || candidate.kind === 'category')).map(candidate => <option key={candidate.id} value={candidate.id}>{containerPath(candidate.id, own)}</option>)}</select>
    </div>) : <Empty title="階層はまだありません" detail="カテゴリやプロジェクトを作成すると、タスクの編集画面から選べます。" />}</section>
  </>
}
function SavedItemsView({ templates, containers, tasks, ownerId, run }: { templates: SavedTemplate[]; containers: Container[]; tasks: Task[]; ownerId: string; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [kind, setKind] = useState<SavedTemplate['kind']>('task'), [sourceId, setSourceId] = useState(''), [name, setName] = useState('')
  const sources = kind === 'task' ? tasks.map(task => ({ id: task.id, name: task.title })) : containers.filter(item => item.kind === 'project' && !item.deletedAt && item.ownerId === ownerId).map(item => ({ id: item.id, name: containerPath(item.id, containers) }))
  const own = templates.filter(template => template.ownerId === ownerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  async function save() {
    const selected = sources.find(source => source.id === sourceId)
    if (!selected) return
    if (await run(() => kind === 'task' ? saveTaskTemplate(sourceId, name || selected.name) : saveProjectTemplate(sourceId, name || selected.name), 'テンプレートを保存しました')) { setSourceId(''); setName('') }
  }
  return <>
    <div className="page-heading"><div><span className="eyebrow">SAVED ITEMS</span><h1>テンプレート</h1><p>保存した版から新しいタスクやプロジェクトを作れます。完了実績とチェック済み状態は複製しません。</p></div></div>
    <section className="card list-card"><div className="card-heading"><h2>今の内容をテンプレートに保存</h2></div><div className="container-create"><select aria-label="テンプレートの種類" value={kind} onChange={event => { setKind(event.target.value as SavedTemplate['kind']); setSourceId('') }}><option value="task">タスク</option><option value="project">プロジェクト</option></select><select aria-label="保存する元" value={sourceId} onChange={event => setSourceId(event.target.value)}><option value="">選択してください</option>{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select><input aria-label="テンプレート名" value={name} maxLength={100} onChange={event => setName(event.target.value)} placeholder="名前（空欄なら元の名前）" /><button className="primary-button" disabled={!sourceId} onClick={save}>版として保存</button></div></section>
    <section className="card list-card"><div className="card-heading"><h2>保存済み</h2><span className="subtle">{own.length}版</span></div>{own.length ? own.map(template => <div className="container-row" key={template.id}><div className="container-main"><span className="status-tag">{template.kind === 'task' ? 'タスク' : 'プロジェクト'}</span><strong>{template.name}</strong><span>v{template.version} · {template.tasks.length}タスク</span></div><button className="secondary-button" onClick={() => run(() => instantiateTemplate(template.id), 'テンプレートから作成しました')}>新規を追加</button></div>) : <p className="muted">保存したテンプレートはまだありません。</p>}</section>
  </>
}

function LabelsView({ groups, definitions, ownerId, run }: { groups: LabelGroup[]; definitions: LabelDefinition[]; ownerId: string; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [groupName, setGroupName] = useState(''), [mode, setMode] = useState<LabelGroup['selectionMode']>('single')
  const [labelName, setLabelName] = useState(''), [groupId, setGroupId] = useState('')
  const ownGroups = groups.filter(group => group.ownerId === ownerId), ownLabels = definitions.filter(label => label.ownerId === ownerId)
  return <>
    <div className="page-heading"><div><span className="eyebrow">LABELS</span><h1>ラベル</h1><p>singleグループからはタスクごとに1つだけ選べます。</p></div></div>
    <section className="card list-card"><div className="card-heading"><h2>グループを作成</h2></div><div className="container-create"><input aria-label="新しいグループ名" value={groupName} maxLength={100} onChange={event => setGroupName(event.target.value)} placeholder="例：場所" /><select aria-label="選択方式" value={mode} onChange={event => setMode(event.target.value as LabelGroup['selectionMode'])}><option value="single">single：1つ</option><option value="multi">multi：複数</option></select><button className="primary-button" disabled={!groupName.trim()} onClick={async () => { if (await run(() => createLabelGroup(groupName, mode), 'グループを作成しました')) setGroupName('') }}>作成</button></div></section>
    <section className="card list-card"><div className="card-heading"><h2>ラベルを作成</h2></div><div className="container-create"><input aria-label="新しいラベル名" value={labelName} maxLength={100} onChange={event => setLabelName(event.target.value)} placeholder="例：自宅" /><select aria-label="所属グループ" value={groupId} onChange={event => setGroupId(event.target.value)}><option value="">グループなし</option>{ownGroups.map(group => <option key={group.id} value={group.id}>{group.name} · {group.selectionMode}</option>)}</select><button className="primary-button" disabled={!labelName.trim()} onClick={async () => { if (await run(() => createLabelDefinition(labelName, groupId || null), 'ラベルを作成しました')) setLabelName('') }}>作成</button></div></section>
    <section className="card list-card"><div className="card-heading"><h2>登録済みラベル</h2></div>{ownLabels.length ? ownLabels.map(label => <div className="container-row" key={label.id}><strong>{label.name}</strong><span>{ownGroups.find(group => group.id === label.groupId)?.name ?? 'グループなし'}</span></div>) : <p className="muted">ラベルはまだありません。</p>}<p className="muted">タスク編集画面の「ラベル」に、ここで作成した名前を入力できます。</p></section>
  </>
}

function TaskChecklist({ task, onError, onClose }: { task: Task | null; onError: (error: unknown) => void; onClose: () => void }) {
  const [text, setText] = useState(''), [converting, setConverting] = useState<string | null>(null), [points, setPoints] = useState('')
  const items = useLiveQuery<ChecklistItem[]>(() => task ? db.checklistItems.where('taskId').equals(task.id).toArray() : [], [task?.id]) ?? []
  if (!task) return <p className="muted">チェックリストはタスクを保存した後に追加できます。</p>
  const progress = checklistProgress(items)
  async function add() { try { await addChecklistItem(task!.id, text); setText('') } catch (error) { onError(error) } }
  async function convert(id: string) { try { await convertChecklistItem(id, task!.revision, Number(points)); onClose() } catch (error) { onError(error) } }
  return <section className="checklist-panel"><h3>チェックリスト</h3><p>{progress.done}/{progress.total}件。チェックだけでは親タスクを完了しません。</p>{items.map(item => <div className="checklist-row" key={item.id}>{item.convertedTaskId ? <span className="status-tag">子タスク化済み</span> : <input type="checkbox" aria-label={`${item.text}を完了`} checked={item.done} onChange={event => toggleChecklistItem(item.id, event.target.checked).catch(onError)} />}<span>{item.text}</span>{!item.convertedTaskId && <button className="text-button" onClick={() => { setConverting(item.id); setPoints('') }}>子タスク化</button>}{converting === item.id && <div className="checklist-convert"><input aria-label="親から配分するポイント" type="number" min={0} max={100000} value={points} onChange={event => setPoints(event.target.value)} placeholder="親から配分するpt" /><button className="secondary-button" disabled={points === ''} onClick={() => convert(item.id)}>配分して作成</button><button className="text-button" onClick={() => setConverting(null)}>取消</button></div>}</div>)}<div className="checklist-add"><input aria-label="新しいチェック項目" value={text} maxLength={300} onChange={event => setText(event.target.value)} placeholder="確認すること" /><button className="secondary-button" disabled={!text.trim()} onClick={add}>項目を追加</button></div></section>
}
function TaskEditor({ task, containers, onClose, onSaved, onError, run }: { task: Task | null; containers: Container[]; onClose: () => void; onSaved: () => void; onError: (e: unknown) => void; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [form, setForm] = useState<TaskInput>(task ? { title: task.title, notes: task.notes, project: task.project, containerId: task.containerId ?? null, labels: task.labels, scheduledDate: task.scheduledDate, dueDate: task.dueDate, targetDate: task.targetDate, reviewDate: task.reviewDate, availableFrom: task.availableFrom, deferredUntil: task.deferredUntil ?? null, importance: task.importance, frog: task.frog ?? null, weight: task.weight ?? null, energyNeed: task.energyNeed ?? null, focusNeed: task.focusNeed ?? null, positiveFeeling: task.positiveFeeling ?? null, score: task.score } : newTaskInput())
  const [tab, setTab] = useState<'details' | 'points'>('details')
  const [saving, setSaving] = useState(false)
  let preview: ReturnType<typeof calculateScore> = { effective: null, lower: null, upper: null, label: '入力エラー' }
  try { preview = calculateScore(form.score) } catch { /* incomplete input is shown as an input error at save time */ }
  const set = <K extends keyof TaskInput>(key: K, value: TaskInput[K]) => setForm(f => ({ ...f, [key]: value }))
  const setScore = <K extends keyof ScoreInput>(key: K, value: ScoreInput[K]) => setForm(f => ({ ...f, score: { ...f.score, [key]: value } }))
  async function save() { setSaving(true); try { if (task) await updateTask(task.id, task.revision, form); else await createTask(form); onSaved() } catch (e) { onError(e) } finally { setSaving(false) } }
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><div className="editor" role="dialog" aria-modal="true" aria-label={task ? 'タスク編集' : '新しいタスク'}><div className="editor-header"><div><span className="eyebrow">{task ? 'EDIT TASK' : 'NEW TASK'}</span><h2>{task ? 'タスクを編集' : '新しいタスク'}</h2></div><button className="icon-button" aria-label="閉じる" onClick={onClose}><X size={20} /></button></div><div className="editor-tabs"><button className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>基本情報</button><button className={tab === 'points' ? 'active' : ''} onClick={() => setTab('points')}>必要ポイント</button></div><div className="editor-body">{tab === 'details' ? <><div className="form-grid"><label className="field full-field">タスク名 <span>*</span><input autoFocus maxLength={300} value={form.title} onChange={e => set('title', e.target.value)} placeholder="何をしますか？" /></label><label className="field full-field">メモ<textarea rows={4} maxLength={50000} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="補足や手順を記録" /></label><label className="field">予定日<input type="date" value={form.scheduledDate ?? ''} onInput={e => set('scheduledDate', (e.target as HTMLInputElement).value || null)} onChange={e => set('scheduledDate', e.target.value || null)} /></label><label className="field">締め切り<input type="date" value={form.dueDate ?? ''} onInput={e => set('dueDate', (e.target as HTMLInputElement).value || null)} onChange={e => set('dueDate', e.target.value || null)} /></label><label className="field">目標日<input type="date" value={form.targetDate ?? ''} onInput={e => set('targetDate', (e.target as HTMLInputElement).value || null)} onChange={e => set('targetDate', e.target.value || null)} /></label><label className="field">見直し日<input type="date" value={form.reviewDate ?? ''} onInput={e => set('reviewDate', (e.target as HTMLInputElement).value || null)} onChange={e => set('reviewDate', e.target.value || null)} /></label><label className="field">開始可能日<input type="date" value={form.availableFrom ?? ''} onInput={e => set('availableFrom', (e.target as HTMLInputElement).value || null)} onChange={e => set('availableFrom', e.target.value || null)} /></label><label className="field">延期終了日<input type="date" value={form.deferredUntil ?? ''} onChange={e => set('deferredUntil', e.target.value || null)} /></label><label className="field">重要度<select value={form.importance} onChange={e => set('importance', Number(e.target.value))}><option value={0}>低</option><option value={1}>通常</option><option value={2}>高</option><option value={3}>最優先</option></select></label><label className="field">Frog（本人の負担感）<select value={form.frog ?? ''} onChange={event => set('frog', event.target.value === '' ? null : Number(event.target.value))}><option value="">未設定</option>{[0,1,2,3,4].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label className="field">Weight（本人の重み）<select value={form.weight ?? ''} onChange={event => set('weight', event.target.value === '' ? null : Number(event.target.value))}><option value="">未設定</option>{[0,1,2,3,4].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label className="field">必要気力<select value={form.energyNeed ?? ''} onChange={event => set('energyNeed', event.target.value === '' ? null : Number(event.target.value))}><option value="">未設定</option>{[0,1,2,3,4].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label className="field">必要集中度<select value={form.focusNeed ?? ''} onChange={event => set('focusNeed', event.target.value === '' ? null : Number(event.target.value))}><option value="">未設定</option>{[0,1,2,3,4].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label className="field">ポジティブな気持ち<select value={form.positiveFeeling ?? ''} onChange={event => set('positiveFeeling', event.target.value === '' ? null : Number(event.target.value))}><option value="">未設定</option>{[0,1,2,3,4].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label className="field">カテゴリ・プロジェクト<select value={form.containerId ?? ''} onChange={e => set('containerId', e.target.value || null)}><option value="">階層なし</option>{containers.map(item => <option key={item.id} value={item.id}>{containerPath(item.id, containers)}</option>)}</select></label>{!form.containerId && <label className="field">旧形式のプロジェクト名<input value={form.project} onChange={e => set('project', e.target.value)} placeholder="Inbox" /></label>}<label className="field">ラベル（カンマ区切り）<input value={form.labels.join(', ')} onChange={e => set('labels', e.target.value.split(',').map(s => s.trim()).filter(Boolean).slice(0, 30))} placeholder="仕事, 連絡" /></label></div><TaskChecklist task={task} onError={onError} onClose={onClose} /><TaskDependencies task={task} onError={onError} /><TaskRolloverHistory task={task} /><TaskStaleness task={task} /><TaskBreakdownWizard task={task} onError={onError} onClose={onClose} /><TaskMaterials task={task} onError={onError} /></> : <div className="score-form"><p className="field-intro">必要ポイントは作業負荷の目安です。未設定のままでもタスクを保存・完了できます。</p><div className="mode-options">{(['unset', 'manual', 'formula'] as const).map(mode => <button key={mode} className={form.score.mode === mode ? 'active' : ''} onClick={() => setScore('mode', mode)}><span className="radio" />{mode === 'unset' ? '未設定' : mode === 'manual' ? '自分で決める' : '式で計算'}</button>)}</div>{form.score.mode === 'manual' && <><label className="field">必要ポイント<input type="number" min={0} max={100000} step={1} value={form.score.manualPoints ?? ''} onChange={e => setScore('manualPoints', intOrNull(e.target.value))} placeholder="0も指定できます" /></label><label className="field">作業分数<input type="number" min={0} max={10080} value={form.score.minutes ?? ''} onChange={e => setScore('minutes', intOrNull(e.target.value))} placeholder="配置案に使用" /></label><label className="field">移動分数<input type="number" min={0} max={10080} value={form.score.travelMinutes ?? ''} onChange={e => setScore('travelMinutes', intOrNull(e.target.value))} placeholder="移動なしなら0" /></label></>}{form.score.mode === 'formula' && <div className="form-grid"><label className="field">作業分数<input type="number" min={0} value={form.score.minutes ?? ''} onChange={e => setScore('minutes', intOrNull(e.target.value))} /></label><label className="field">移動分数<input type="number" min={0} value={form.score.travelMinutes ?? ''} onChange={e => setScore('travelMinutes', intOrNull(e.target.value))} /></label>{([['difficulty', '難しさ', 4], ['uncertainty', '不確実さ', 3], ['coordination', '対人調整', 3], ['physical', '身体負荷', 3]] as const).map(([key, label, max]) => <label className="field" key={key}>{label} <small>0〜{max}</small><select value={form.score[key] ?? ''} onChange={e => setScore(key, intOrNull(e.target.value))}><option value="">不明</option>{Array.from({ length: max + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}</select></label>)}<label className="field full-field">独立した外出が必要<select value={form.score.outing === null ? '' : form.score.outing ? 'yes' : 'no'} onChange={e => setScore('outing', e.target.value === '' ? null : e.target.value === 'yes')}><option value="">不明</option><option value="no">いいえ</option><option value="yes">はい</option></select></label></div>}<DurationEstimate score={form.score} /><div className="score-preview"><span>保存される値</span><strong>{form.score.mode === 'manual' ? form.score.manualPoints === null ? '入力してください' : `${form.score.manualPoints} pt · 手動` : form.score.mode === 'unset' ? '未設定' : preview.effective !== null ? `${preview.effective} pt · 自動` : preview.upper === null ? `${preview.lower} pt〜 · 上限不明` : `${preview.lower}–${preview.upper} pt · 推定範囲`}</strong>{form.score.mode === 'formula' && <small>不明な項目がある場合、確定ポイントは保存しません。</small>}</div></div>}</div><div className="editor-footer">{task && <button className="danger-text" onClick={async () => { if (await run(() => trashTask(task.id, task.revision))) onClose() }}><Trash2 size={16} /> ゴミ箱へ</button>}<button className="secondary-button" onClick={onClose}>キャンセル</button><button className="primary-button" disabled={saving || !form.title.trim()} onClick={save}>{saving ? '保存中…' : 'この端末に保存'}</button></div></div></div>
}

function PlanView({ tasks, blocks, settings, onEdit }: { tasks: Task[]; blocks: TimeBlock[]; settings: Settings; onEdit: (t: Task) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(today(), i))
  return <><div className="page-heading"><div><span className="eyebrow">LOOK AHEAD</span><h1>これからの計画</h1><p>予定日と締め切りを分けて管理します。容量は目安として表示します。</p></div></div><div className="week-grid">{days.map(day => { const items = tasks.filter(t => t.scheduledDate === day), capacity = dayCapacity(items, settings.dailyMinutes, settings.dailyPoints), load = timeBlockCapacity(day, tasks, blocks); return <section key={day} className={`day-card ${day === today() ? 'is-today' : ''}`}><div className="day-title"><strong>{dateLong(day)}</strong>{day === today() && <span>今日</span>}</div><div className="capacity"><span className={load.totalMinutes > settings.dailyMinutes ? 'over' : ''}>{load.totalMinutes}/{settings.dailyMinutes}分</span><span className={capacity.overPoints ? 'over' : ''}>{capacity.points}/{settings.dailyPoints}pt</span></div><div className="meter"><i style={{ width: `${Math.min(100, load.totalMinutes / Math.max(settings.dailyMinutes, 1) * 100)}%` }} /></div><small className="muted">時間未設定 {load.unknownMinutes}件 · ポイント未設定 {capacity.unknownPoints}件</small><div className="day-tasks">{items.length ? items.map(t => <button key={t.id} onClick={() => onEdit(t)}><span>{t.title}</span><small>{scoreText(t)}</small></button>) : <span className="muted">予定なし</span>}</div></section> })}</div><div className="card info-card"><CalendarDays size={20} /><p>締め切りは予定日を動かしても変わりません。時間とポイントの上限も別々に確認できます。</p></div></>
}

function fixedCoachAnswer(text: string, next: Task | undefined) {
  let answer = 'ここでは保存済みのタスクを一緒に確認できます。新しいAI推論は実行していません。'
  if (/今日|いま|次|何から/.test(text)) answer = next ? `登録済みのタスクなら「${next.title}」が次の候補です。必要なら開いて予定を調整しましょう。` : '未完了のタスクはありません。必要な作業があれば手動で追加できます。'
  if (/疲れ|しんど|無理/.test(text)) answer = '今日は負荷を下げても大丈夫です。予定を見直す場合は、対象のタスクを選んで変更しましょう。'
  return answer
}

function CoachView({ tasks, goals, checkIns, settings, onEdit, onNew }: { tasks: Task[]; goals: Goal[]; checkIns: GoalCheckIn[]; settings: Settings; onEdit: (t: Task) => void; onNew: () => void }) {
  const [message, setMessage] = useState('')
  const [chat, setChat] = useState<{ who: 'you' | 'coach'; text: string }[]>([])
  const [aiStatus, setAiStatus] = useState<AIStatus | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [modelInput, setModelInput] = useState(settings.aiModel || 'deepseek/deepseek-v4.1-flash')
  const [selectedId, setSelectedId] = useState('')
  const [selectedGoalId, setSelectedGoalId] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [sending, setSending] = useState(false)
  const bridge = window.michiAI
  const next = [...tasks].sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.importance - a.importance)[0]
  const selectedTask = tasks.find(t => t.id === selectedId)
  const selectedContext = [selectedTaskContext(selectedTask), selectedGoalContext(goals.find(goal => goal.id === selectedGoalId), checkIns)].filter(Boolean).join('\n\n').slice(0, 6000) || null
  const aiReady = Boolean(bridge && aiStatus?.configured && settings.aiEnabled && settings.aiModel)

  useEffect(() => {
    if (!window.michiAI) return
    window.michiAI.status().then(setAiStatus).catch(e => setConnectionError(e instanceof Error ? e.message : String(e)))
  }, [])

  async function saveConnection() {
    if (!bridge) return
    setConnectionError('')
    try {
      const model = modelInput.trim()
      if (!/^[\w~./:-]{3,120}$/.test(model)) throw new Error('モデルIDを入力してください')
      if (!aiStatus?.configured && !keyInput) throw new Error('APIキーを入力してください')
      if (keyInput) await bridge.saveKey(keyInput.trim())
      await db.settings.update('main', { aiEnabled: true, aiModel: model })
      setKeyInput('')
      setAiStatus(await bridge.status())
    } catch (e) {
      setConnectionError(e instanceof Error ? e.message : String(e))
    }
  }

  async function disconnect() {
    if (!bridge) return
    setConnectionError('')
    try {
      await bridge.deleteKey()
      await db.settings.update('main', { aiEnabled: false })
      setAiStatus(await bridge.status())
      setKeyInput('')
    } catch (e) {
      setConnectionError(e instanceof Error ? e.message : String(e))
    }
  }

  async function send() {
    const text = message.trim()
    if (!text || sending) return
    setChat(c => [...c, { who: 'you', text }])
    setMessage('')
    if (aiReady && bridge && navigator.onLine) {
      setSending(true)
      try {
        const answer = await bridge.chat({ model: settings.aiModel!, message: text, selectedTask: selectedContext })
        setChat(c => [...c, { who: 'coach', text: answer }])
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        const answer = error.includes('OpenRouterへ接続できませんでした') ? `接続できないため端末内の定型応答を表示します。${fixedCoachAnswer(text, next)}` : error
        setChat(c => [...c, { who: 'coach', text: answer }])
      } finally {
        setSending(false)
      }
      return
    }
    setChat(c => [...c, { who: 'coach', text: fixedCoachAnswer(text, next) }])
  }

  return <>
    <div className="page-heading">
      <div><span className="eyebrow">CHARACTER COACH</span><h1>{settings.coachName}と整理する</h1><p>{aiReady ? '送信した文章と選択したタスク・目標だけを、OpenRouter経由で選択したモデルの提供先へ送ります。' : '現在は端末内の定型応答です。外部AIへの送信は行いません。'}</p></div>
      <span className="status-tag"><Moon size={15} /> {aiReady ? 'OpenRouter 接続' : 'オフライン対応'}</span>
    </div>
    <div className="coach-layout">
      <section className="card conversation">
        <div className="conversation-top"><div className="small-avatar">✦</div><div><strong>{settings.coachName}</strong><small>{aiReady ? 'AI応答 · 選択したデータだけ送信' : '定型応答 · タスクの保存状態を参照'}</small></div></div>
        <div className="messages">
          <div className="message coach">こんにちは。今日は何を整理しましょうか？</div>
          {chat.map((m, i) => <div key={i} className={`message ${m.who}`}>{m.text}</div>)}
          {sending && <div className="message coach">OpenRouterからの応答を待っています…</div>}
        </div>
        {aiReady && <div className="coach-share">
          <label className="field">OpenRouterへ送る保存済みタスク
            <select value={selectedId} onChange={e => setSelectedId(e.target.value)}><option value="">送らない</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
          </label>
          <label className="field">OpenRouterへ送る目標とチェックイン<select value={selectedGoalId} onChange={e => setSelectedGoalId(e.target.value)}><option value="">送らない</option>{goals.map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label>
          {selectedContext && <details><summary>送信する保存情報を表示</summary><pre>{selectedContext}</pre></details>}
          <small>メッセージ送信時、入力文と選択したタスク・目標の現行チェックインだけを送ります。過去の会話・他のタスクは送りません。APIキーは認証ヘッダーにだけ使用します。</small>
        </div>}
        <div className="chat-input"><input value={message} maxLength={6000} onChange={e => setMessage(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder="今日、何から始めよう？" /><button className="primary-button" onClick={send} disabled={!message.trim() || sending}>送信</button></div>
      </section>
      <aside className="card coach-aside">
        <span className="eyebrow">FROM YOUR LIST</span><h2>いまの候補</h2>
        {next ? <><p>締め切りと重要度から、登録済みタスクを表示しています。</p><button className="candidate" onClick={() => onEdit(next)}><strong>{next.title}</strong><span>{scoreText(next)} {next.dueDate && `· 期限 ${dateLabel(next.dueDate)}`}</span></button></> : <Empty title="候補はありません" detail="必要なタスクを手動で追加できます。" action={<button className="secondary-button" onClick={onNew}>追加する</button>} />}
        <div className="aside-note"><LockKeyhole size={17} /> 会話からタスクを自動作成・変更しません。</div>
        <div className="coach-ai-setup">
          <h3>OpenRouter接続</h3>
          {bridge ? <>
            <p>APIキーはWindowsの暗号化保存を使用し、バックアップには含めません。</p>
            <label className="field">モデルID<input value={modelInput} onChange={e => setModelInput(e.target.value)} placeholder="例：提供元/モデル名" /></label>
            <label className="field">APIキー<input type="password" autoComplete="off" value={keyInput} onChange={e => setKeyInput(e.target.value)} placeholder={aiStatus?.configured ? '登録済み（変更時のみ入力）' : 'OpenRouterのキー'} /></label>
            <button className="secondary-button full" disabled={aiStatus?.secureStorage === false} onClick={saveConnection}>接続を保存</button>
            {aiStatus?.configured && <button className="text-button" onClick={disconnect}>キーを削除してOFFにする</button>}
            {aiStatus?.secureStorage === false && <p>この端末では安全なキー保存を利用できません。</p>}
            {connectionError && <p role="alert">{connectionError}</p>}
          </> : <p>AI接続はWindowsデスクトップ版で設定できます。ブラウザ版は定型応答です。</p>}
        </div>
      </aside>
    </div>
  </>
}
function HistoryView({ completions, ledger, sessions, tasks, onEdit, run }: { completions: { taskId: string; title: string; currentAt: string | null; netPoints: number | null; scoreState: string }[]; ledger: { delta: number }[]; sessions: WorkSession[]; tasks: Task[]; onEdit: (id: string) => void; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const valid = completions.filter(c => c.currentAt).sort((a, b) => b.currentAt!.localeCompare(a.currentAt!))
  const total = ledger.reduce((n, e) => n + e.delta, 0)
  const [correcting, setCorrecting] = useState<string | null>(null), [points, setPoints] = useState(''), [reason, setReason] = useState('')
  return <><div className="page-heading"><div><span className="eyebrow">YOUR RECORD</span><h1>積み重ねた実績</h1><p>完了記録とポイント台帳から集計しています。</p></div></div><div className="stats-grid three"><Stat icon={<CheckCircle2 size={19} />} label="完了したタスク" value={`${valid.length} 件`} detail={`未設定 ${valid.filter(c => c.netPoints === null).length} 件`} tone="lilac" /><Stat icon={<Sparkles size={19} />} label="確定ポイント" value={`${total} pt`} detail="取消・訂正を反映" tone="mint" /><Stat icon={<Clock3 size={19} />} label="記録した時間" value={`${unionSessionMinutes(sessions)} 分`} detail="重複区間を除いて集計" tone="peach" /></div><section className="card list-card"><div className="card-heading"><div><span className="eyebrow">COMPLETION HISTORY</span><h2>完了履歴</h2></div></div>{valid.length ? valid.map(c => <div className="history-row" key={c.taskId}><div className="history-icon"><Check size={16} /></div><button onClick={() => onEdit(c.taskId)}><strong>{c.title}</strong><small>{new Date(c.currentAt!).toLocaleString('ja-JP')}</small></button><span className="history-points">{c.netPoints === null ? '未設定' : `${c.netPoints} pt`}</span><button className="text-button" onClick={() => { setCorrecting(c.taskId); setPoints(String(c.netPoints ?? '')); setReason('') }}>訂正</button></div>) : <Empty title="実績はまだありません" detail="タスクを完了すると、ここに記録されます。" />}</section><section className="card list-card"><div className="card-heading"><div><span className="eyebrow">WORK SESSIONS</span><h2>作業時間の元区間</h2></div></div>{sessions.length ? [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(session => <div className="history-row" key={session.id}><div className="history-icon"><Clock3 size={16} /></div><div><strong>{tasks.find(task => task.id === session.taskId)?.title ?? '削除済みタスク'}</strong><small>{new Date(session.startedAt).toLocaleString('ja-JP')} 〜 {new Date(session.endedAt).toLocaleString('ja-JP')}</small></div><span className="history-points">{session.minutes} 分</span></div>) : <p className="muted">作業時間の記録はありません。</p>}</section>{correcting && <div className="modal-backdrop"><div className="small-modal card" role="dialog" aria-modal="true"><div className="card-heading"><h2>実績ポイントを訂正</h2><button className="icon-button" onClick={() => setCorrecting(null)}><X size={18} /></button></div><p>元の完了記録は残し、差分を台帳に追記します。</p><label className="field">訂正後のポイント<input type="number" min={0} max={100000} value={points} onChange={e => setPoints(e.target.value)} /></label><label className="field">理由<input value={reason} onChange={e => setReason(e.target.value)} /></label><button className="primary-button" onClick={async () => { if (await run(() => correctCompletion(correcting, Number(points), reason), '実績を訂正しました')) setCorrecting(null) }}>訂正する</button></div></div>}</>
}

function RoutinesView({ routines, run }: { routines: Routine[]; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [show, setShow] = useState(false), [title, setTitle] = useState(''), [cadence, setCadence] = useState<Routine['cadence']>('daily'), [interval, setIntervalValue] = useState(1), [weekday, setWeekday] = useState(INITIAL_NOW.getDay()), [day, setDay] = useState(INITIAL_NOW.getDate()), [start, setStart] = useState(today()), [project, setProject] = useState(''), [points, setPoints] = useState(''), [excludedDates, setExcludedDates] = useState('')
  async function save() { const score: ScoreInput = points === '' ? emptyScore() : { ...emptyScore(), mode: 'manual', manualPoints: Number(points) }; if (await run(async () => { await createRoutine({ title, cadence, interval, weekdays: [weekday], monthDay: day, startDate: start, endDate: null, afterTaskId: null, score, project, excludedDates: excludedDates.split(',').map(value => value.trim()).filter(Boolean), active: true }); await expandRoutines() }, 'ルーティンを保存し、発生回を作成しました')) { setShow(false); setTitle(''); setExcludedDates('') } }
  return <><div className="page-heading"><div><span className="eyebrow">REPEAT WITH INTENTION</span><h1>ルーティン</h1><p>毎日・毎週・毎月・完了後の繰り返しを、端末内で展開します。</p></div><button className="primary-button" onClick={() => setShow(true)}><Plus size={17} /> ルーティンを作成</button></div><section className="card list-card">{routines.length ? routines.map(r => <div className="routine-row" key={r.id}><div className="routine-icon"><Repeat2 size={19} /></div><div><strong>{r.title}</strong><small>{r.cadence === 'daily' ? `${r.interval}日ごと` : r.cadence === 'weekly' ? `${r.interval}週ごと` : r.cadence === 'monthly' ? `${r.interval}か月ごと` : `完了から${r.interval}日後`} · {r.score.mode === 'manual' ? `${r.score.manualPoints}pt` : 'ポイント未設定'}</small></div><span className="status-tag">有効</span></div>) : <Empty title="ルーティンはまだありません" detail="繰り返す必要のある作業を設定できます。" action={<button className="secondary-button" onClick={() => setShow(true)}>作成する</button>} />}</section>{show && <div className="modal-backdrop"><div className="small-modal card" role="dialog" aria-modal="true"><div className="card-heading"><h2>ルーティンを作成</h2><button className="icon-button" onClick={() => setShow(false)}><X size={18} /></button></div><label className="field">作業名<input value={title} onChange={e => setTitle(e.target.value)} placeholder="例：週次レビュー" /></label><div className="form-grid"><label className="field">周期<select value={cadence} onChange={e => setCadence(e.target.value as Routine['cadence'])}><option value="daily">毎日</option><option value="weekly">毎週</option><option value="monthly">毎月</option><option value="after_completion">完了から</option></select></label><label className="field">間隔<input type="number" min={1} max={365} value={interval} onChange={e => setIntervalValue(Number(e.target.value))} /></label>{cadence === 'weekly' && <label className="field">曜日<select value={weekday} onChange={e => setWeekday(Number(e.target.value))}>{['日', '月', '火', '水', '木', '金', '土'].map((x, i) => <option key={i} value={i}>{x}曜日</option>)}</select></label>}{cadence === 'monthly' && <label className="field">日（31は月末）<input type="number" min={1} max={31} value={day} onChange={e => setDay(Number(e.target.value))} /></label>}<label className="field">開始日<input type="date" value={start} onChange={e => setStart(e.target.value)} /></label><label className="field">必要ポイント<input type="number" min={0} value={points} onChange={e => setPoints(e.target.value)} placeholder="未設定" /></label><label className="field full-field">除外日（カンマ区切り）<input value={excludedDates} onChange={e => setExcludedDates(e.target.value)} placeholder="2026-10-03, 2026-10-10" /></label><label className="field full-field">プロジェクト<input value={project} onChange={e => setProject(e.target.value)} placeholder="Inbox" /></label></div><button className="primary-button full" disabled={!title.trim()} onClick={save}>保存して発生回を作る</button></div></div>}</>
}

function SettingsView({ settings, run }: { settings: Settings; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [password, setPassword] = useState(''), [file, setFile] = useState<File | null>(null), [restoreInfo, setRestoreInfo] = useState<Awaited<ReturnType<typeof inspectBackup>> | null>(null), [storage, setStorage] = useState('確認中')
  useEffect(() => { navigator.storage?.estimate().then(x => setStorage(`${Math.round((x.usage ?? 0) / 1024 / 1024)} MB / ${Math.round((x.quota ?? 0) / 1024 / 1024)} MB`)).catch(() => setStorage('取得できません')) }, [])
  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    run(async () => {
      if ((key === 'dailyMinutes' || key === 'dailyPoints') && (!Number.isInteger(value) || (value as number) < 0)) throw new Error('1日の目安は0以上の整数で入力してください')
      await db.transaction('rw', db.settings, async () => {
        const current = await db.settings.get('main')
        if (!current) throw new Error('設定がありません')
        await db.settings.put({ ...current, [key]: value })
      })
    }, '設定を保存しました')
  }
  function toggleNavigation(platform: 'desktop' | 'mobile', id: NavigationId, enabled: boolean) {
    run(() => db.transaction('rw', db.settings, async () => {
      const current = await db.settings.get('main')
      if (!current) throw new Error('設定がありません')
      const key = platform === 'desktop' ? 'navDesktop' : 'navMobile'
      const selected = visibleNavigation(current[key], platform)
      await db.settings.put({ ...current, [key]: enabled ? [...new Set([...selected, id])] : selected.filter(value => value !== id) })
    }), 'ナビゲーションを保存しました')
  }
  async function inspect() { if (!file) return; await run(async () => { const result = await inspectBackup(file, password); setRestoreInfo(result) }, 'バックアップを検証しました') }
  async function restore() { if (!restoreInfo) return; if (!confirm(`現在のデータを置き換えます。${restoreInfo.tasks.length}件のタスクを復元しますか？`)) return; await run(async () => { await restoreBackup(restoreInfo); setRestoreInfo(null); setFile(null) }, 'バックアップを復元しました') }
  return <><div className="page-heading"><div><span className="eyebrow">PREFERENCES & DATA</span><h1>設定とデータ</h1><p>この端末の保存と、自分に合う使い方を管理します。</p></div></div><div className="settings-grid"><AppearanceSettingsView settings={settings} run={run} /><WorkflowPresetsView settings={settings} run={run} /><section className="card setting-section navigation-settings"><div className="setting-heading"><Settings2 size={20} /><div><h2>機能の表示</h2><p>OFFにしても保存済みデータは残ります。通知とバックグラウンド動作は別の設定です。</p></div></div><div className="feature-toggle-grid">{OPTIONAL_FEATURE_IDS.map(id => <label key={id}><input type="checkbox" aria-label={`${nav.find(item => item.view === id)?.label}をON`} checked={featureEnabled(settings.hiddenFeatures, id)} onChange={event => run(() => setFeatureVisible(id, event.target.checked), '機能の表示を保存しました')} />{nav.find(item => item.view === id)?.label}</label>)}</div></section><section className="card setting-section navigation-settings"><div className="setting-heading"><Search size={20} /><div><h2>ナビゲーション</h2><p>PCとスマートフォンで表示する入口を別々に選びます。上部の機能検索と設定ボタンは常に使えます。</p></div></div><div className="navigation-table"><strong>機能</strong><strong>PC</strong><strong>スマホ</strong>{nav.map(item => <div className="navigation-row" key={item.view}><span>{item.label}</span><input type="checkbox" aria-label={`${item.label}をPCに表示`} checked={visibleNavigation(settings.navDesktop, 'desktop').includes(item.view)} onChange={event => toggleNavigation('desktop', item.view, event.target.checked)} /><input type="checkbox" aria-label={`${item.label}をスマホに表示`} checked={visibleNavigation(settings.navMobile, 'mobile').includes(item.view)} onChange={event => toggleNavigation('mobile', item.view, event.target.checked)} /></div>)}</div></section><section className="card setting-section"><div className="setting-heading"><Settings2 size={20} /><div><h2>日々の目安</h2><p>計画画面の容量表示に使います。</p></div></div><div className="form-grid"><label className="field">1日の時間（分）<input type="number" min={0} value={settings.dailyMinutes} onChange={e => update('dailyMinutes', Number(e.target.value))} /></label><label className="field">1日のポイント<input type="number" min={0} value={settings.dailyPoints} onChange={e => update('dailyPoints', Number(e.target.value))} /></label><label className="field full-field">コーチの名前<input value={settings.coachName} onChange={e => update('coachName', e.target.value)} /></label></div></section><section className="card setting-section"><div className="setting-heading"><ShieldCheck size={20} /><div><h2>AIと自動化</h2><p>初期状態では外部AIの呼び出しはありません。</p></div></div><div className="setting-line"><div><strong>AI処理</strong><small>OpenRouter接続はコーチ画面から設定できます</small></div><span className="status-tag">任意</span></div><div className="setting-line"><div><strong>自動化レベル</strong><small>AIによるタスク変更は実行しません</small></div><span className="status-tag">A1 確認中心</span></div><div className="setting-line"><div><strong>通知</strong><small>アプリを開いている間、スヌーズ終了時に通知します</small></div><button className="secondary-button" onClick={async () => { if (settings.notifications) { update('notifications', false); return } await run(async () => { if (!('Notification' in window)) throw new Error('この環境は通知に対応していません'); if (await Notification.requestPermission() !== 'granted') throw new Error('通知が許可されませんでした'); await db.settings.update('main', { notifications: true }) }, '通知を有効にしました') }}>{settings.notifications ? '通知を停止' : '通知を有効にする'}</button></div></section><section className="card setting-section"><div className="setting-heading"><Database size={20} /><div><h2>ローカルデータ</h2><p>タスクと台帳はこのブラウザのIndexedDBが正本です。</p></div></div><div className="data-row"><span>データセット</span><code>{settings.datasetId.slice(0, 8)}…</code></div><div className="data-row"><span>保存使用量</span><strong>{storage}</strong></div><div className="data-row"><span>最後の書き出し</span><strong>{settings.lastBackupAt ? new Date(settings.lastBackupAt).toLocaleString('ja-JP') : 'まだありません'}</strong></div><button className="secondary-button" onClick={() => navigator.storage?.persist?.().then(ok => alert(ok ? '保存保護が許可されました' : 'ブラウザによって許可されませんでした'))}>保存保護を要求</button></section><section className="card setting-section"><div className="setting-heading"><LockKeyhole size={20} /><div><h2>暗号化バックアップ</h2><p>パスワードで保護した .coachbundle を保存・復元します。</p></div></div><label className="field">バックアップ用パスワード<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="10文字以上" /></label><button className="secondary-button" disabled={password.length < 10} onClick={() => run(() => exportBackup(password), 'バックアップを書き出しました')}><Download size={16} /> 書き出す</button><div className="divider"/><p className="muted">別形式の書き出し。JSON・CSV・ICSは暗号化されません。</p><div className="export-buttons"><button className="secondary-button" onClick={() => run(exportPortableJson, 'JSONを書き出しました')}>JSON</button><button className="secondary-button" onClick={() => run(exportTasksCsv, 'CSVを書き出しました')}>CSV</button><button className="secondary-button" onClick={() => run(exportTasksIcs, 'ICSを書き出しました')}>ICS</button></div><div className="divider"/><label className="field">復元するファイル<input type="file" accept=".coachbundle,.json,application/json" onChange={e => { setFile(e.target.files?.[0] ?? null); setRestoreInfo(null) }} /></label><button className="secondary-button" disabled={!file} onClick={inspect}><Upload size={16} /> 内容を検証</button>{restoreInfo && <div className="restore-preview"><strong>検証済み：{restoreInfo.tasks.length}件のタスク、{restoreInfo.completions.length}件の完了記録</strong><p>現在のデータを置き換えます。必要なら先に書き出してください。</p><button className="primary-button" onClick={restore}>このバックアップを復元</button></div>}</section></div></>
}

export default App

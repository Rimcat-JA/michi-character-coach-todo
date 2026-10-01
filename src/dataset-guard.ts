import Dexie, { type DBCore, type DBCoreMutateRequest, type Middleware } from 'dexie'

/** Business tables a frozen (moving) or read-only (moved away) dataset must not change. */
export const GUARDED_TABLES = ['tasks', 'assessments', 'completions', 'ledger', 'routines', 'sessions', 'containers', 'checklistItems', 'labelGroups', 'labelDefinitions', 'savedTemplates', 'taskNotes', 'taskComments', 'taskAttachments', 'taskDependencies', 'planningBuckets', 'timeBlocks', 'calendarEvents', 'calendarRules', 'rollovers', 'themeRules', 'smartLists', 'focusSelections', 'habits', 'habitLogs', 'goals', 'goalCheckIns', 'trackerDefinitions', 'trackerEntries', 'dayNotes', 'pomodoroCycles', 'reviewRecords', 'tripBundles'] as const
/** New personal context cannot be added while frozen, but erasure and retention (put/delete) always run. */
export const CREATE_GUARDED_TABLES = ['contextSources', 'coachMemories', 'coachConversations', 'coachMessages'] as const
export type DatasetMode = 'active' | 'frozen' | 'read_only'
export class DatasetFrozenError extends Error {
  readonly code = 'DATASET_FROZEN'
  constructor(mode: Exclude<DatasetMode, 'active'>) { super(mode === 'frozen' ? 'この端末のデータは移行のため凍結中です。編集できません（移行を取り消すと再開できます）' : 'この端末のデータは別端末へ移行済みのため読み取り専用です。編集できません') }
}
const privileged = new WeakSet<object>()
/** Marks the current transaction as restore/retention bookkeeping that must run regardless of the dataset mode. */
export function allowWhileFrozen() {
  const trans = Dexie.currentTransaction as unknown as { idbtrans?: object } | null
  if (!trans?.idbtrans) throw new Error('凍結中にも必要な処理はトランザクション内で実行してください')
  privileged.add(trans.idbtrans)
}
const guarded = new Set<string>(GUARDED_TABLES), createGuarded = new Set<string>(CREATE_GUARDED_TABLES)
export const datasetGuardMiddleware: Middleware<DBCore> = {
  stack: 'dbcore', name: 'datasetModeGuard', level: 1,
  create: down => ({
    ...down,
    // Every write transaction on a guarded table also reads settings, so the mode is checked inside the same transaction.
    transaction: (stores, mode, options) => down.transaction(mode === 'readwrite' && !stores.includes('settings') && stores.some(name => guarded.has(name) || createGuarded.has(name)) && down.schema.tables.some(table => table.name === 'settings') ? [...stores, 'settings'] : stores, mode, options),
    table: name => {
      const table = down.table(name)
      if (!guarded.has(name) && !createGuarded.has(name)) return table
      return {
        ...table,
        mutate: async (req: DBCoreMutateRequest) => {
          if (!privileged.has(req.trans as object) && (guarded.has(name) || req.type === 'add')) {
            const settings = await down.table('settings').get({ trans: req.trans, key: 'main' }) as { datasetMode?: DatasetMode } | undefined
            if (settings?.datasetMode === 'frozen' || settings?.datasetMode === 'read_only') throw new DatasetFrozenError(settings.datasetMode)
          }
          return table.mutate(req)
        }
      }
    }
  })
}

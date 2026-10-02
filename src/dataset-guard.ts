import Dexie, { type DBCore, type DBCoreMutateRequest, type Middleware } from 'dexie'

/** Business tables a frozen (moving) or read-only (moved away) dataset must not change. */
export const GUARDED_TABLES = ['tasks', 'assessments', 'completions', 'ledger', 'routines', 'sessions', 'containers', 'checklistItems', 'labelGroups', 'labelDefinitions', 'savedTemplates', 'taskNotes', 'taskComments', 'taskAttachments', 'taskDependencies', 'planningBuckets', 'timeBlocks', 'calendarEvents', 'calendarRules', 'rollovers', 'themeRules', 'smartLists', 'focusSelections', 'habits', 'habitLogs', 'goals', 'goalCheckIns', 'trackerDefinitions', 'trackerEntries', 'dayNotes', 'pomodoroCycles', 'reviewRecords', 'tripBundles'] as const
export type DatasetMode = 'active' | 'frozen' | 'read_only'
/** Device-local mode row. A dedicated store (not settings) so retention jobs that lock settings are never blocked by long task writes. */
export type DatasetState = { id: 'main'; mode: DatasetMode; updatedAt: string; moveId: string | null }
const STATE = 'datasetState'
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
const guarded = new Set<string>(GUARDED_TABLES)
export const datasetGuardMiddleware: Middleware<DBCore> = {
  stack: 'dbcore', name: 'datasetModeGuard', level: 1,
  create: down => ({
    ...down,
    // Every write transaction on a guarded table also holds the mode row, so a freeze and a business write serialize: no write slips past a move snapshot.
    transaction: (stores, mode, options) => down.transaction(mode === 'readwrite' && !stores.includes(STATE) && stores.some(name => guarded.has(name)) && down.schema.tables.some(table => table.name === STATE) ? [...stores, STATE] : stores, mode, options),
    table: name => {
      const table = down.table(name)
      if (!guarded.has(name)) return table
      return {
        ...table,
        mutate: async (req: DBCoreMutateRequest) => {
          if (!privileged.has(req.trans as object) && (req.trans as unknown as IDBTransaction).mode !== 'versionchange' && down.schema.tables.some(table => table.name === STATE)) {
            const state = await down.table(STATE).get({ trans: req.trans, key: 'main' }) as DatasetState | undefined
            if (state?.mode === 'frozen' || state?.mode === 'read_only') throw new DatasetFrozenError(state.mode)
          }
          return table.mutate(req)
        }
      }
    }
  })
}

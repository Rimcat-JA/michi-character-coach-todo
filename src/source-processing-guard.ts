import { db } from './db'
import { DatasetFrozenError } from './dataset-guard'

/** Stop processing before sending or extracting, as well as before saving results. */
export async function assertSourceProcessingActive() {
  const state = await db.datasetState.get('main')
  if (state?.mode === 'frozen' || state?.mode === 'read_only') throw new DatasetFrozenError(state.mode)
}

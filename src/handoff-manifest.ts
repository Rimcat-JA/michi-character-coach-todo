/** I05 file handoff kinds (design 18.11): backup = same dataset, move = frozen hand-over of the primary device, fork = independent copy with a new dataset_id. */
export type HandoffKind = 'backup' | 'move' | 'fork'
type ManifestBase = { bundle_id: string; dataset_id: string; source_device_id: string; exported_at: string; base_bundle_id: string | null }
export type HandoffManifest =
  | ManifestBase & { kind: 'backup' }
  | ManifestBase & { kind: 'move'; move_id: string; move_secret: string }
  | ManifestBase & { kind: 'fork'; parent_dataset_id: string }

const filled = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && ![...value].some(char => char.charCodeAt(0) < 32)
const timestamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const KEYS: Record<HandoffKind, string[]> = {
  backup: ['bundle_id', 'kind', 'dataset_id', 'source_device_id', 'exported_at', 'base_bundle_id'],
  move: ['bundle_id', 'kind', 'dataset_id', 'source_device_id', 'exported_at', 'base_bundle_id', 'move_id', 'move_secret'],
  fork: ['bundle_id', 'kind', 'dataset_id', 'source_device_id', 'exported_at', 'base_bundle_id', 'parent_dataset_id']
}
/** Exact keys only: heads or any other claim in the manifest are rejected, never trusted. */
export function validateHandoffManifest(value: unknown, datasetId: string): asserts value is HandoffManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('引継ぎ情報が不正です')
  const manifest = value as Record<string, unknown>, keys = KEYS[manifest.kind as HandoffKind]
  if (!keys || Object.keys(manifest).length !== keys.length || keys.some(key => !Object.hasOwn(manifest, key))) throw new Error('引継ぎ情報の項目が不正です')
  if (!filled(manifest.bundle_id) || !filled(manifest.dataset_id) || !filled(manifest.source_device_id) || !timestamp(manifest.exported_at) || !(manifest.base_bundle_id === null || filled(manifest.base_bundle_id)) || manifest.base_bundle_id === manifest.bundle_id) throw new Error('引継ぎ情報が不正です')
  if (manifest.dataset_id !== datasetId) throw new Error('引継ぎ情報のデータセットが本文と一致しません')
  if (manifest.kind === 'move' && (!filled(manifest.move_id) || typeof manifest.move_secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(manifest.move_secret))) throw new Error('移行情報が不正です')
  if (manifest.kind === 'fork' && (!filled(manifest.parent_dataset_id) || manifest.parent_dataset_id === manifest.dataset_id)) throw new Error('複製元の情報が不正です')
}

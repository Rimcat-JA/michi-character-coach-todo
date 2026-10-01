import { db } from './db'
import { uid, type Settings, type WorkflowConfig, type WorkflowPreset } from './domain'
import { NAV_FEATURE_IDS, visibleNavigation } from './navigation'
import { OPTIONAL_FEATURE_IDS, revokeHiddenFeatureAuthority } from './features'

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value)
const validIds = (value: unknown, allowed: readonly string[]) => Array.isArray(value) && value.length <= allowed.length && new Set(value).size === value.length && value.every(id => typeof id === 'string' && allowed.includes(id))

export function validateWorkflowConfig(value: unknown): asserts value is WorkflowConfig {
  if (!isRecord(value) || !exactKeys(value, ['navDesktop', 'navMobile', 'hiddenFeatures', 'daySectionMode', 'taskListLimit', 'dailyMinutes', 'dailyPoints'])
    || !validIds(value.navDesktop, NAV_FEATURE_IDS) || !validIds(value.navMobile, NAV_FEATURE_IDS) || !validIds(value.hiddenFeatures, OPTIONAL_FEATURE_IDS)
    || !['halfday', 'category', 'timeblock', 'custom'].includes(value.daySectionMode as string)
    || value.taskListLimit !== null && ![5, 10, 20, 50].includes(value.taskListLimit as number)
    || !Number.isInteger(value.dailyMinutes) || (value.dailyMinutes as number) < 0 || (value.dailyMinutes as number) > 10080
    || !Number.isInteger(value.dailyPoints) || (value.dailyPoints as number) < 0 || (value.dailyPoints as number) > 100000) throw new Error('ワークフロー設定が不正です')
}

export function validateWorkflowPreset(value: unknown): asserts value is WorkflowPreset {
  if (!isRecord(value) || !exactKeys(value, ['id', 'name', 'version', 'config', 'createdAt', 'updatedAt'])
    || typeof value.id !== 'string' || !value.id || value.id.length > 100
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100
    || !Number.isInteger(value.version) || (value.version as number) < 1 || (value.version as number) > 100000
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('ワークフロープリセットが不正です')
  validateWorkflowConfig(value.config)
}

export function captureWorkflowConfig(settings: Settings): WorkflowConfig {
  return { navDesktop: [...visibleNavigation(settings.navDesktop, 'desktop')], navMobile: [...visibleNavigation(settings.navMobile, 'mobile')], hiddenFeatures: [...(settings.hiddenFeatures ?? [])], daySectionMode: settings.daySectionMode ?? 'halfday', taskListLimit: settings.taskListLimit ?? null, dailyMinutes: settings.dailyMinutes, dailyPoints: settings.dailyPoints }
}

export async function saveWorkflowPreset(name: string, existingId?: string): Promise<string> {
  name = name.trim()
  if (!name || name.length > 100) throw new Error('プリセット名は1〜100文字にしてください')
  return db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    const presets = settings.workflowPresets ?? [], prior = existingId ? presets.find(preset => preset.id === existingId) : undefined
    if (existingId && !prior) throw new Error('プリセットがありません')
    const at = new Date().toISOString(), id = prior?.id ?? uid()
    const next: WorkflowPreset = { id, name, version: prior ? prior.version + 1 : 1, config: captureWorkflowConfig(settings), createdAt: prior?.createdAt ?? at, updatedAt: at }
    if (next.version > 100000 || (!prior && presets.length >= 100)) throw new Error('プリセットの上限に達しました')
    await db.settings.put({ ...settings, workflowPresets: prior ? presets.map(preset => preset.id === id ? next : preset) : [...presets, next] })
    return id
  })
}

export async function applyWorkflowConfig(config: WorkflowConfig): Promise<void> {
  validateWorkflowConfig(config)
  const newlyHidden = await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    await db.settings.put({ ...settings, navDesktop: [...config.navDesktop], navMobile: [...config.navMobile], hiddenFeatures: [...config.hiddenFeatures], daySectionMode: config.daySectionMode, taskListLimit: config.taskListLimit, dailyMinutes: config.dailyMinutes, dailyPoints: config.dailyPoints })
    return config.hiddenFeatures.filter(id => !settings.hiddenFeatures?.includes(id))
  })
  // A preset that hides a feature revokes the same pending previews as the individual toggle.
  revokeHiddenFeatureAuthority(newlyHidden)
}

export async function applyWorkflowPreset(id: string): Promise<void> {
  const settings = await db.settings.get('main'), preset = settings?.workflowPresets?.find(item => item.id === id)
  if (!preset) throw new Error('プリセットがありません')
  await applyWorkflowConfig(preset.config)
}

export function exportWorkflowPreset(preset: WorkflowPreset): string {
  validateWorkflowPreset(preset)
  return JSON.stringify({ format: 'michi-workflow-preset', formatVersion: 1, preset: { name: preset.name, version: preset.version, config: preset.config } }, null, 2)
}

export async function importWorkflowPreset(raw: string): Promise<string> {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('プリセットJSONが不正です') }
  if (!isRecord(parsed) || !exactKeys(parsed, ['format', 'formatVersion', 'preset']) || parsed.format !== 'michi-workflow-preset' || parsed.formatVersion !== 1 || !isRecord(parsed.preset) || !exactKeys(parsed.preset, ['name', 'version', 'config'])) throw new Error('共有プリセットの形式が不正です')
  const item = parsed.preset
  if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || !Number.isInteger(item.version) || (item.version as number) < 1 || (item.version as number) > 100000) throw new Error('共有プリセットの版が不正です')
  validateWorkflowConfig(item.config)
  const name = item.name.trim(), version = item.version as number, config = item.config
  return db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    if ((settings.workflowPresets ?? []).length >= 100) throw new Error('プリセットの上限に達しました')
    const id = uid(), at = new Date().toISOString()
    await db.settings.put({ ...settings, workflowPresets: [...(settings.workflowPresets ?? []), { id, name, version, config, createdAt: at, updatedAt: at }] })
    return id
  })
}

export async function deleteWorkflowPreset(id: string): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    await db.settings.put({ ...settings, workflowPresets: (settings.workflowPresets ?? []).filter(item => item.id !== id) })
  })
}

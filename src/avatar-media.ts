export type AvatarMode = 'idle' | 'speaking' | 'listening' | 'thinking'
export type AvatarRights = { ownsOrLicensed: true; usageNote: string; redistributionAllowed: boolean }
export type AvatarFile = { name: string; size: number; webkitRelativePath?: string; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }
export type AvatarBundle = { name: string; manifest: Readonly<Record<string, unknown>>; resources: ReadonlyMap<string, Blob>; rights: AvatarRights }
export type AvatarHandle = { setMode(mode: AvatarMode): void; setPaused(paused: boolean): void; dispose(): void }
export type Live2DAdapter = { localOnly: true; sdkRightsConfirmed: true; load(canvas: HTMLCanvasElement, bundle: AvatarBundle): Promise<AvatarHandle> }

function path(value: unknown, reference = true): string {
  if (typeof value !== 'string' || !value || value.length > 500 || value.includes('\\') || value.includes(':') || value.includes('\0') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..') || reference && !/\.(moc3|json|png|jpg|jpeg|webp|wav|mp3|ogg)$/i.test(value)) throw new Error('モデル参照は選択フォルダー内のデータファイルだけにしてください')
  return value
}
export async function importAvatarBundle(files: AvatarFile[], rights: AvatarRights): Promise<AvatarBundle> {
  if (!rights || rights.ownsOrLicensed !== true || typeof rights.usageNote !== 'string' || !rights.usageNote.trim() || rights.usageNote.length > 2000 || typeof rights.redistributionAllowed !== 'boolean') throw new Error('素材の利用権利と確認メモを入力してください')
  if (!Array.isArray(files) || !files.length || files.length > 300 || files.some(file => !Number.isSafeInteger(file.size) || file.size < 0) || files.reduce((total, file) => total + file.size, 0) > 100 * 1024 * 1024) throw new Error('モデルフォルダーは300ファイル・100 MiBまで選択できます')
  const byPath = new Map<string, AvatarFile>()
  for (const file of files) { const filePath = path(file.webkitRelativePath || file.name, false); if (byPath.has(filePath)) throw new Error('モデルファイルのパスが重複しています'); byPath.set(filePath, file) }
  const entries = [...byPath.entries()].filter(([name]) => name.endsWith('.model3.json'))
  if (entries.length !== 1) throw new Error('model3.jsonを1つ含むモデルフォルダーを選択してください')
  const [modelPath, modelFile] = entries[0]
  if (modelFile.size > 1024 * 1024) throw new Error('モデル設定は1 MiBまでです')
  let manifest: Record<string, unknown>
  try { const parsed: unknown = JSON.parse(await modelFile.text()); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); manifest = parsed as Record<string, unknown> } catch { throw new Error('モデル設定JSONを読めませんでした') }
  const refs = manifest.FileReferences
  if (manifest.Version !== 3 || !refs || typeof refs !== 'object' || Array.isArray(refs)) throw new Error('Cubism model3形式の設定を選択してください')
  const reference = refs as Record<string, unknown>, required: string[] = [path(reference.Moc)]
  if (!required[0].toLowerCase().endsWith('.moc3') || !Array.isArray(reference.Textures) || !reference.Textures.length || reference.Textures.length > 50) throw new Error('モデル本体とtexture参照を確認してください')
  for (const item of reference.Textures) { const image = path(item); if (!/\.(png|jpg|jpeg|webp)$/i.test(image)) throw new Error('textureは画像にしてください'); required.push(image) }
  for (const key of ['Physics', 'Pose', 'UserData']) if (reference[key] !== undefined) required.push(path(reference[key]))
  if (reference.Expressions !== undefined) {
    if (!Array.isArray(reference.Expressions) || reference.Expressions.length > 100) throw new Error('表情ファイルの参照を確認してください')
    for (const item of reference.Expressions) { if (!item || typeof item !== 'object') throw new Error('表情の参照を確認してください'); required.push(path(item.File)) }
  }
  if (reference.Motions !== undefined) {
    if (!reference.Motions || typeof reference.Motions !== 'object' || Array.isArray(reference.Motions)) throw new Error('motionの参照を確認してください')
    for (const group of Object.values(reference.Motions)) {
      if (!Array.isArray(group) || group.length > 100) throw new Error('motionの参照を確認してください')
      for (const item of group) { if (!item || typeof item !== 'object') throw new Error('motionの参照を確認してください'); required.push(path(item.File)); if (item.Sound !== undefined) required.push(path(item.Sound)) }
    }
  }
  const base = modelPath.includes('/') ? modelPath.slice(0, modelPath.lastIndexOf('/') + 1) : '', resources = new Map<string, Blob>()
  for (const name of new Set(required)) { const file = byPath.get(base + name); if (!file || !file.size) throw new Error(`モデルに必要なローカルファイルがありません: ${name}`); resources.set(name, new Blob([await file.arrayBuffer()])) }
  return { name: modelFile.name, manifest, resources, rights: { ...rights, usageNote: rights.usageNote.trim() } }
}

export function createAvatarController(adapter: Live2DAdapter | null, changed: (state: { status: 'static' | 'loading' | 'animated'; notice: string }) => void) {
  let epoch = 0, handle: AvatarHandle | null = null, mode: AvatarMode = 'idle', paused = false
  const disposeHandle = () => { const old = handle; handle = null; try { old?.dispose() } catch { /* Static fallback remains available. */ } }
  const fallback = (notice = '') => { epoch++; disposeHandle(); changed({ status: 'static', notice }) }
  return {
    async load(canvas: HTMLCanvasElement, bundle: AvatarBundle) {
      if (!adapter || adapter.localOnly !== true || adapter.sdkRightsConfirmed !== true) { fallback('Live2Dの実行SDKは未提供です。静止キャラクターとテキストを利用できます。'); return }
      if (!bundle?.rights || bundle.rights.ownsOrLicensed !== true) { fallback('素材の利用権利を確認してください。静止キャラクターを表示します。'); return }
      const generation = ++epoch; disposeHandle(); changed({ status: 'loading', notice: '' })
      try { const next = await adapter.load(canvas, bundle); if (generation !== epoch) { next.dispose(); return }; handle = next; handle.setMode(mode); handle.setPaused(paused); changed({ status: 'animated', notice: '' }) }
      catch { if (generation === epoch) fallback('モデルを読み込めませんでした。静止キャラクターとテキストを利用できます。') }
    },
    setMode(value: AvatarMode) { if (!['idle', 'speaking', 'listening', 'thinking'].includes(value)) throw new Error('キャラクター状態を確認してください'); mode = value; try { handle?.setMode(value) } catch { fallback('キャラクター動作を停止しました。静止表示を利用できます。') } },
    setPaused(value: boolean) { paused = value; try { handle?.setPaused(value) } catch { fallback('キャラクター動作を停止しました。静止表示を利用できます。') } },
    fallback,
    dispose() { epoch++; disposeHandle() },
  }
}

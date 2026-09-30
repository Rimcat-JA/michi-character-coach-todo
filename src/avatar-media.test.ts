import { describe, expect, it, vi } from 'vitest'
import { createAvatarController, importAvatarBundle, type AvatarFile, type AvatarHandle } from './avatar-media'

const rights = { ownsOrLicensed: true as const, usageNote: '本人作成・この端末での利用許諾を確認', redistributionAllowed: false }
function file(name: string, content: string): AvatarFile { return { name: name.split('/').at(-1)!, webkitRelativePath: name, size: new TextEncoder().encode(content).length, text: async () => content, arrayBuffer: async () => new TextEncoder().encode(content).buffer } }
function files(moc = 'avatar.moc3') { return [file('本人/avatar.model3.json', JSON.stringify({ Version: 3, FileReferences: { Moc: moc, Textures: ['texture.png'] } })), file('本人/avatar.moc3', 'local-model-data'), file('本人/texture.png', 'local-image-data'), file('本人/README.txt', '利用許諾メモ')] }
const canvas = {} as HTMLCanvasElement
describe('本人素材の取込と静止キャラクターへの縮退', () => {
  it('権利確認なしの取込を拒否し、必要な本人ローカルデータだけ渡す', async () => {
    await expect(importAvatarBundle(files(), { ...rights, ownsOrLicensed: false } as unknown as typeof rights)).rejects.toThrow('利用権利')
    const bundle = await importAvatarBundle(files(), rights)
    expect([...bundle.resources.keys()]).toEqual(['avatar.moc3', 'texture.png'])
    expect(bundle.rights.redistributionAllowed).toBe(false)
    expect(bundle.resources.has('README.txt')).toBe(false)
  })
  it.each(['https://example.org/model.moc3', '../other.moc3', '/private/model.moc3', 'C:\\secret.moc3', 'code.js'])('外部/逸脱/実行形式の参照%sを拒否する', async reference => {
    await expect(importAvatarBundle(files(reference), rights)).rejects.toThrow('選択フォルダー内')
  })
  it('欠落textureを読込失敗として返す', async () => { await expect(importAvatarBundle(files().filter(item => !item.name.endsWith('.png')), rights)).rejects.toThrow('必要なローカルファイル') })
  it('SDK未提供/読込失敗時に静止表示を残す', async () => {
    const bundle = await importAvatarBundle(files(), rights), changed = vi.fn()
    await createAvatarController(null, changed).load(canvas, bundle)
    expect(changed).toHaveBeenLastCalledWith({ status: 'static', notice: expect.stringContaining('未提供') })
    const adapter = { localOnly: true as const, sdkRightsConfirmed: true as const, load: vi.fn(async (): Promise<AvatarHandle> => { throw new Error('model-error') }) }
    await createAvatarController(adapter, changed).load(canvas, bundle)
    expect(changed).toHaveBeenLastCalledWith({ status: 'static', notice: expect.stringContaining('静止キャラクターとテキスト') })
  })
  it('停止/取消後の遅いモデルをdisposeし、話す状態と背景停止を独立に渡す', async () => {
    const bundle = await importAvatarBundle(files(), rights), changed = vi.fn(), handle: AvatarHandle = { setMode: vi.fn(), setPaused: vi.fn(), dispose: vi.fn() }
    let resolve!: (value: AvatarHandle) => void
    const controller = createAvatarController({ localOnly: true, sdkRightsConfirmed: true, load: () => new Promise<AvatarHandle>(done => { resolve = done }) }, changed)
    const pending = controller.load(canvas, bundle); controller.fallback(); resolve(handle); await pending
    expect(handle.dispose).toHaveBeenCalledOnce(); expect(changed).toHaveBeenLastCalledWith({ status: 'static', notice: '' })
    const active = createAvatarController({ localOnly: true, sdkRightsConfirmed: true, load: async () => handle }, changed)
    active.setPaused(true); active.setMode('speaking'); await active.load(canvas, bundle)
    expect(handle.setMode).toHaveBeenLastCalledWith('speaking'); expect(handle.setPaused).toHaveBeenLastCalledWith(true)
    active.setMode('idle'); expect(handle.setMode).toHaveBeenLastCalledWith('idle'); active.dispose()
  })
})

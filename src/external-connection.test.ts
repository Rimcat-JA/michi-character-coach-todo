import { afterEach, expect, it, vi } from 'vitest'
import { invalidateExternalConnection } from './external-connection'

afterEach(() => vi.unstubAllGlobals())
it('restore cancels the loopback API even if another connection fails', async () => {
  const api=vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window',{michiFileBridge:{invalidate:()=>Promise.reject(Error('failed'))},michiLocalAPI:{invalidate:api}})
  await expect(invalidateExternalConnection()).rejects.toThrow('取消')
  expect(api).toHaveBeenCalledOnce()
})
it('ファイル接続の取消失敗でもPC操作の権限を取り消す', async () => {
  const pc = vi.fn().mockResolvedValue(undefined), failure = new Error('file system unavailable')
  vi.stubGlobal('window', { michiFileBridge: { invalidate: () => Promise.reject(failure) }, michiLocalActions: { invalidate: pc } })
  await expect(invalidateExternalConnection()).rejects.toMatchObject({ errors: [failure] })
  expect(pc).toHaveBeenCalledOnce()
})
it('PC操作側の同期例外でもファイル接続の取消を完了する', async () => {
  const files = vi.fn().mockResolvedValue(undefined), failure = new Error('native connection unavailable')
  vi.stubGlobal('window', { michiFileBridge: { invalidate: files }, michiLocalActions: { invalidate: () => { throw failure } } })
  await expect(invalidateExternalConnection()).rejects.toMatchObject({ errors: [failure] })
  expect(files).toHaveBeenCalledOnce()
})
it('別接続の取消失敗でもGitHub公開の承認を取り消す', async () => {
  const github = vi.fn().mockResolvedValue(undefined), failure = new Error('connection unavailable')
  vi.stubGlobal('window', { michiFileBridge: { invalidate: () => Promise.reject(failure) }, michiGitHubAchievements: { invalidate: github } })
  await expect(invalidateExternalConnection()).rejects.toMatchObject({ errors: [failure] })
  expect(github).toHaveBeenCalledOnce()
})

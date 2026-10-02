/** The stored OpenRouter key is read on screen open only while AI is ON; with AI OFF only an explicit owner check reads it. */
export function keyStatusOnOpen<T>(aiEnabled: boolean, status: (() => Promise<T>) | undefined): Promise<T> | null {
  return aiEnabled && status ? status() : null
}
/** On the owner's own save click an unknown key status is read first, so a model-only save with AI OFF never demands the key again. */
export async function keyStatusForSave<T extends { configured: boolean }>(known: T | null, keyInput: string, status: () => Promise<T>): Promise<T> {
  const current = known ?? await status()
  if (!current.configured && !keyInput) throw new Error('APIキーを入力してください')
  return current
}

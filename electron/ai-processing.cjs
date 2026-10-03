function createAIProcessingGuard(getSettings) {
  async function read() {
    const settings = await getSettings(), epoch = settings?.aiConnectionEpoch ?? 0, policyEpoch = settings?.changePolicy?.epoch ?? 0
    if (settings?.aiEnabled !== true || !['active',undefined].includes(settings.datasetMode) || !Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(policyEpoch) || policyEpoch < 0 || typeof settings.profileId !== 'string' || typeof settings.datasetId !== 'string') throw new Error('AI処理は停止中、または許可を確認できません。入力と下書きは残ります')
    return { ownerId: settings.profileId, datasetId: settings.datasetId, epoch, policyEpoch }
  }
  return { begin: read, async assertCurrent(binding) { const current = await read(); if (!binding || Object.keys(current).some(key => current[key] !== binding[key])) throw new Error('AI処理の許可が変わりました。古い応答は採用しません') } }
}
module.exports = { createAIProcessingGuard }

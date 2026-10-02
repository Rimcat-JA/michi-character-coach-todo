/** One OpenRouter model-ID check shared by every main-process AI handler (a copied literal once lost its backslash). */
const MODEL_ID = /^[\w~./:-]{3,120}$/
const isModelId = model => typeof model === 'string' && MODEL_ID.test(model)
function assertModelId(model) { if (!isModelId(model)) throw new Error('モデルIDを確認してください') }

/** N03 split request arguments, checked before any request is made. */
function validateTaskSplitRequest({ model, message, task }) {
  assertModelId(model)
  if (typeof message !== 'string' || !message.trim() || message.length > 4000) throw new Error('分割の相談文は1〜4000文字で入力してください')
  if (!task || typeof task !== 'object' || Array.isArray(task) || Object.keys(task).length !== 5 || !['id', 'title', 'revision', 'scoreMode', 'manualPoints'].every(key => Object.hasOwn(task, key)) || typeof task.id !== 'string' || !task.id || task.id.length > 200 || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 300 || !Number.isSafeInteger(task.revision) || task.revision < 1 || !['unset', 'manual', 'formula', 'allocated'].includes(task.scoreMode) || task.manualPoints !== null && (!Number.isSafeInteger(task.manualPoints) || task.manualPoints < 0 || task.manualPoints > 100000)) throw new Error('分割するタスクが不正です')
}

module.exports = { isModelId, assertModelId, validateTaskSplitRequest }

/** File/MCP clock values contain only a canonical UTC instant and a valid IANA zone. */
function validDueClock(value) {
  if (value === null) return true
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'at') || !Object.hasOwn(value, 'timezone') || typeof value.at !== 'string' || typeof value.timezone !== 'string' || !value.timezone || value.timezone.length > 100) return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.at) || !Number.isFinite(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at) return false
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format(0); return Boolean(value.timezone) } catch { return false }
}
module.exports = { validDueClock }

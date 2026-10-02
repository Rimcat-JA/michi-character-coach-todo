/** No document body, browsing history, authentication or page fetch is read. */
export function readSelectedFragment() {
  return { title: document.title, url: location.href, quote: getSelection()?.toString() ?? '' }
}
export function buildCapsule({ title, url, quote, capturedAt = new Date().toISOString(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone }) {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw Error('http/httpsページの引用を選んでください。')
  parsed.username = ''; parsed.password = ''; parsed.hash = ''
  if (typeof quote !== 'string' || !quote.trim() || quote.length > 50000) throw Error('引用は1〜50,000文字で選んでください。')
  if (typeof title !== 'string' || typeof timezone !== 'string' || !timezone || timezone.length > 100 || typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt || parsed.href.length > 2000) throw Error('引用の出典情報を確認してください。')
  new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  // Reject controls and unpaired surrogates; data is later rendered only as text.
  const cleanTitle = (title.trim() || parsed.hostname).slice(0, 200)
  // eslint-disable-next-line no-control-regex
  if (Array.from(quote + cleanTitle).some(c => c.length === 1 && /[\ud800-\udfff]/.test(c)) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(quote + cleanTitle) || /[\r\n\t\u202a-\u202e\u2066-\u2069]/.test(cleanTitle)) throw Error('引用に未対応の制御文字があります。')
  const capsule = { version: 1, kind: 'web-selection', title: cleanTitle, url: parsed.href, capturedAt, timezone, selection: { quote, start: 0, end: quote.length, coordinate: 'selected-fragment-utf16' }, coverage: { complete: false, kind: 'selected-quote' } }
  if (new TextEncoder().encode(JSON.stringify(capsule, null, 2)).length > 120 * 1024) throw Error('選択引用ファイルは120KBまでです。引用を短く選び直してください。')
  return capsule
}

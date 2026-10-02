import http from 'node:http'
import { createHash } from 'node:crypto'
const hash = value => createHash('sha256').update(value).digest('hex')
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const start = '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">'
const response = (href, props) => `<d:response><d:href>${xml(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
export const syntheticCalDAVEvent = (version = 1, uid = 'fixture-event') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic CalDAV//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSEQUENCE:${version}\r\nDTSTAMP:20261001T000000Z\r\nDTSTART:20261003T010000Z\r\nDTEND:20261003T020000Z\r\nSUMMARY:Synthetic CalDAV ${version}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
export async function createCalDAVFixtureServer() {
  const objects = new Map(), journal = [], requests = []
  let sequence = 0, mode = 'normal', race = null
  function put(href, data) { const record = { data, etag: `"${hash(data)}"` }; objects.set(href, record);journal.push({ sequence: ++sequence, href, deleted: false });return record }
  function remove(href) { objects.delete(href);journal.push({ sequence: ++sequence, href, deleted: true }) }
  put('/calendars/read/meeting.ics', syntheticCalDAVEvent())
  const server = http.createServer(async (req, res) => {
    const chunks = [];let size = 0
    for await (const chunk of req) { size += chunk.length;if (size > 3 * 1048576) { res.writeHead(413).end();return }chunks.push(chunk) }
    const body = Buffer.concat(chunks).toString('utf8'), href = new URL(req.url, 'http://127.0.0.1').pathname
    requests.push({ method: req.method, href, ifMatch: req.headers['if-match'] ?? null, ifNoneMatch: req.headers['if-none-match'] ?? null, bodySha256: hash(body), authorized: req.headers.authorization === 'Basic ' + Buffer.from('fixture-user:fixture-app-password').toString('base64') })
    if (!requests.at(-1).authorized) { res.writeHead(401).end('Unauthorized');return }
    const send = (status, text = '', headers = {}) => res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8', ...headers }).end(text)
    if (mode === 'busy') { send(503, '', {'Retry-After':'120'});return }
    if (mode === 'capacity') { send(507, '<d:error xmlns:d="DAV:"><d:number-of-matches-within-limits/></d:error>');return }
    if (mode === 'xxe') { send(207, '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///secret">]><d:multistatus xmlns:d="DAV:">&secret;</d:multistatus>');return }
    if (req.method === 'PROPFIND') {
      if (href === '/dav/') send(207, start + response('/dav/', '<d:current-user-principal><d:href>/principal/fixture/</d:href></d:current-user-principal>') + '</d:multistatus>')
      else if (href === '/principal/fixture/') send(207, start + response(href, '<c:calendar-home-set><d:href>/calendars/</d:href></c:calendar-home-set>') + '</d:multistatus>')
      else if (href === '/calendars/') send(207, start + ['read', 'michi'].map(name => response(`/calendars/${name}/`, `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${name === 'read' ? '合成・読取用' : '合成・michi専用'}</d:displayname><cs:getctag>${sequence}</cs:getctag><d:sync-token>token-${sequence}</d:sync-token><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>`)).join('') + '</d:multistatus>')
      else send(404)
      return
    }
    if (req.method === 'REPORT' && ['/calendars/read/', '/calendars/michi/'].includes(href)) {
      if (body.includes('sync-collection')) {
        if (mode === 'no_sync') { send(405);return }
        const token = /<d:sync-token>(.*?)<\/d:sync-token>/.exec(body)?.[1] ?? ''
        if (mode === 'invalid_token' || token && !/^token-\d+$/.test(token)) { if (mode === 'invalid_token') mode = 'normal';send(403, '<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>');return }
        const entries = token ? journal.filter(row => row.sequence > Number(token.slice(6))) : [...objects.keys()].map(href => ({ href, deleted: false })), latest = new Map(entries.filter(row => row.href.startsWith(href)).map(row => [row.href, row]))
        send(207, start + [...latest.values()].map(row => row.deleted ? `<d:response><d:href>${xml(row.href)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>` : response(row.href, `<d:getetag>${xml(objects.get(row.href).etag)}</d:getetag>`)).join('') + `<d:sync-token>token-${sequence}</d:sync-token></d:multistatus>`)
      } else if (body.includes('calendar-multiget')) {
        const hrefs = [...body.matchAll(/<d:href>(.*?)<\/d:href>/g)].map(match => match[1])
        send(207, start + hrefs.map(href => objects.has(href) ? response(href, `<d:getetag>${xml(objects.get(href).etag)}</d:getetag><c:calendar-data>${xml(objects.get(href).data)}</c:calendar-data>`) : `<d:response><d:href>${xml(href)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`).join('') + '</d:multistatus>')
      } else if (body.includes('calendar-query')) send(207, start + [...objects].filter(([key]) => key.startsWith(href)).map(([key, value]) => response(key, `<d:getetag>${xml(value.etag)}</d:getetag>`)).join('') + '</d:multistatus>')
      else send(400)
      return
    }
    if (req.method === 'GET') { const record = objects.get(href);if (record) send(200, record.data, { 'Content-Type': 'text/calendar; charset=utf-8', ETag: record.etag });else send(404);return }
    if (['PUT', 'DELETE'].includes(req.method) && href.startsWith('/calendars/michi/')) {
      if (race) { const value = race;race = null;put(href, value) }
      const record = objects.get(href)
      if (req.headers['if-none-match'] === '*' && record || req.headers['if-match'] && req.headers['if-match'] !== record?.etag) { send(412);return }
      if (!req.headers['if-match'] && req.headers['if-none-match'] !== '*') { send(428);return }
      if (req.method === 'DELETE') { remove(href);send(204);return }
      const next = put(href, body);send(record ? 204 : 201, '', { ETag: next.etag });return
    }
    send(405)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, url: origin + '/dav/', requests, objects, put, remove, setMode: value => { mode = value }, raceNextWrite: value => { race = value }, close: () => new Promise(resolve => { server.closeAllConnections();server.close(resolve) }) }
}

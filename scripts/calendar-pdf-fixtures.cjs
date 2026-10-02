const { app, BrowserWindow } = require('electron')
const { mkdir, writeFile } = require('node:fs/promises')
const path = require('node:path')
app.disableHardwareAcceleration()
const root = path.join(__dirname, '..', 'docs', 'examples') + path.sep
const fixtures = {
  'roster-pdf-table': [['shift_id', 'record_revision', 'person_ref', 'published', 'status', 'start_date', 'start_time', 'end_date', 'end_time'], ['night', '1', 'staff-001', 'true', 'scheduled', '2026-10-03', '22:00', '2026-10-04', '06:00'], ['other', '1', 'staff-002', 'true', 'scheduled', '2026-10-03', '09:00', '2026-10-03', '17:00']],
  'calendar-pdf-table': [['record_id', 'record_revision', 'date', 'status'], ['holiday', '1', '2026-10-05', 'closed']],
}
;(async () => { await app.whenReady()
try {
  await mkdir(root, { recursive: true })
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false } })
  for (const [name, rows] of Object.entries(fixtures)) {
    // Each fixed-width cell is one text item; these fixtures intentionally avoid merged and multi-line cells.
    const html = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{margin:0;font:10px Arial}table{table-layout:fixed;border-collapse:collapse;width:1100px}td{width:120px;height:35px;padding:0;white-space:nowrap}</style><table>' + rows.map(row => '<tr>' + row.map(cell => `<td>${cell}</td>`).join('') + '</tr>').join('') + '</table>'
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await writeFile(root + name + '.pdf', await win.webContents.printToPDF({ printBackground: true, pageSize: { width: 13, height: 8.27 }, margins: { top: 0, bottom: 0, left: 0, right: 0 } }))
    await writeFile(root + name + '.csv', rows.map(row => row.join(',')).join('\n') + '\n')
  }
  win.destroy()
} finally { app.quit() }

})().catch(error => { console.error(error); app.exit(1) })

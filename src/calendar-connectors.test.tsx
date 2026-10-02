import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { calendarConnectorKinds, capabilityPermissionManifest, connectorStatus } from './calendar-connectors'
import { IntegrationsView } from './IntegrationsView'
describe('calendar connector capabilities', () => {
  it('separates file read/local edits from external writes and PWA transport support', () => {
    const runtime = { desktop: true, networkPolicy: 'explicit_online' as const }
    expect(connectorStatus('ics_file', runtime).write.status).toBe('unsupported')
    for (const kind of ['ics_url', 'caldav', 'google'] as const) expect(connectorStatus(kind, { ...runtime, desktop: false }).incoming_events.status).toBe('unsupported')
    expect(connectorStatus('csv', { ...runtime, desktop: false, networkPolicy: 'offline_only' }).incoming_events.status).toBe('available')
    expect(connectorStatus('xlsx', { ...runtime, desktop: false }).incoming_events.status).toBe('unsupported')
  })
  it('requires policy, authentication, independent scopes and a dedicated write collection', () => {
    const runtime = { desktop: true, networkPolicy: 'explicit_online' as const, authenticated: true, adapterPresent: true, readCollection: true }
    expect(connectorStatus('caldav', { ...runtime, networkPolicy: 'offline_only' }).incoming_events.status).toBe('policy_blocked')
    expect(connectorStatus('google', { ...runtime, authenticated: false }).incoming_events.status).toBe('needs_auth')
    expect(connectorStatus('google', runtime).incoming_events.status).toBe('needs_scope')
    expect(connectorStatus('google', { ...runtime, scopes: capabilityPermissionManifest.google.read }).write.status).toBe('needs_scope')
    expect(connectorStatus('caldav', runtime).write.status).toBe('needs_scope')
    expect(connectorStatus('caldav', { ...runtime, writeCollection: true }).write.status).toBe('available')
    expect(connectorStatus('caldav', { ...runtime, stale: true }).incoming_events.status).toBe('degraded')
    expect(Object.keys(capabilityPermissionManifest)).toEqual([...calendarConnectorKinds])
  })
  it('renders distinct capability rows without an ambiguous connected claim', () => {
    const screen = renderToStaticMarkup(<IntegrationsView runtime={{ desktop: true, networkPolicy: 'offline_only' }} />)
    for (const text of ['読取', '書込', '差分取得', '削除検知', '取得範囲', '最終確認', '設定により停止']) expect(screen).toContain(text)
    expect(screen).not.toMatch(/接続済み|同期済|同期しました|双方向/)
  })
})

import { useEffect, useState } from 'react'
import type { Settings } from './domain'
import type { AIStatus } from './ai'
import type { CapabilityEnvironment } from './capabilities'
import { effectiveNetworkPolicy, networkStatus, type NetworkStatus } from './runtime-profile'

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  useEffect(() => { const update = () => setOnline(navigator.onLine); window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) } }, [])
  return online
}
export function useCapabilityEnvironment(settings: Settings): { env: CapabilityEnvironment; network: NetworkStatus | null } {
  const online = useOnline(), [aiStatus, setAiStatus] = useState<AIStatus | null>(null), [network, setNetwork] = useState<NetworkStatus | null>(null)
  const electron = typeof window !== 'undefined' && Boolean(window.michiAI)
  useEffect(() => { window.michiAI?.status().then(setAiStatus).catch(() => setAiStatus(null)) }, [settings.aiEnabled, settings.aiModel])
  useEffect(() => { void networkStatus().then(setNetwork) }, [settings.runtimeProfile?.network_policy, settings.aiEnabled])
  const policy = effectiveNetworkPolicy(settings, network?.legacyOnlineConfigured).policy
  const notificationPermission = typeof window === 'undefined' ? 'unsupported' : window.michiDesktop ? settings.notifications ? 'granted' : 'default' : 'Notification' in window ? Notification.permission : 'unsupported'
  return { env: { electron, policy, online, aiKeyConfigured: Boolean(aiStatus?.configured), aiEnabled: settings.aiEnabled, aiModel: Boolean(settings.aiModel), notificationPermission }, network }
}

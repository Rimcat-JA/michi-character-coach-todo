import type { ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import type { NetworkPolicy } from './domain'
import { effectiveNetworkPolicy } from './runtime-profile'

/** Under offline_only an external URL is shown as text, never opened or fetched by this app. */
export function ExternalLinkView({ href, policy, children }: { href: string; policy: NetworkPolicy; children: ReactNode }) {
  if (policy === 'offline_only') return <span className="external-link-offline" title={href}>{children}（通信が必要・オフライン専用のため開きません）</span>
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>
}
export default function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const settings = useLiveQuery(() => db.settings.get('main'), [])
  return <ExternalLinkView href={href} policy={settings ? effectiveNetworkPolicy(settings).policy : 'offline_only'}>{children}</ExternalLinkView>
}

import { FEATURE_REGISTRY, type PanelFeatureId } from './features'
import type { ConnectionKind } from './external-connection'
import { ConnectionStopButton, type ConnectionGateways } from './FeatureConnectionsView'

/** Hidden in-screen feature: display only. The separate stop control is the feature's existing connection stop. */
export default function FeatureOffCard({ id, onShow, connection, gateways }: { id: PanelFeatureId; onShow: () => void; connection?: ConnectionKind; gateways?: ConnectionGateways }) {
  const info = FEATURE_REGISTRY[id]
  return <section className="card setting-section feature-off-card" aria-label={`${info.label}の表示はOFF`}>
    <h3>{info.label}は表示だけ停止中</h3>
    <p>表示だけ停止中。保存データ・接続・権限・自動処理は変わりません。{info.keptWhileHidden}</p>
    <div className="change-set-actions"><button type="button" className="secondary-button" onClick={onShow}>{info.label}を表示</button>{connection && <ConnectionStopButton kind={connection} gateways={gateways} />}</div>
  </section>
}

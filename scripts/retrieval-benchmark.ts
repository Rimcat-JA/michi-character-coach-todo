import { db, ensureSettings } from '../src/db'
import { importLocalSource, defaultSourcePermissions, setSourcePermissions } from '../src/source-library'
import { buildSourceEmbeddings, searchHybrid, refreshHybridRetrieval } from '../src/hybrid-retrieval'

/** Synthetic load only: real Chromium IndexedDB, deterministic vectors, no model or network. */
async function benchmark() {
  await ensureSettings()
  await db.settings.update('main', { embedding: { provider: 'loopback-openai-compatible', endpoint: 'http://127.0.0.1:8080', model: 'synthetic-load-only' } })
  const text = Array.from({ length: 10000 }, (_, i) => `資料${String(i).padStart(5,'0')} ${i === 9999 ? '特別照合' : '通常行'}`).join('\n')
  const started = performance.now()
  const id = await importLocalSource({ title:'合成1万span', text, provider:'local', externalId:null, conversation:null, author:null, sourceUrl:null, date:'2026-10-03', fromDate:'2026-10-01', toDate:'2026-10-31', permissions:defaultSourcePermissions(), allowedModels:[], retentionUntil:null })
  const importMs = performance.now()-started
  const snapshot = (await db.contextSnapshots.get(`${id}:1`))!
  if (snapshot.spans.length !== 10000) throw Error('SPAN_COUNT')
  const dims=384
  const embed = async (inputs:string[]) => inputs.map(value => Array.from({length:dims},(_,i)=>i===(value.includes('特別照合')?0:1)?1:0))
  console.log('BENCH imported 10000 spans')
  const indexing = performance.now(), index = await buildSourceEmbeddings(id,embed), indexMs = performance.now()-indexing
  console.log('BENCH indexed',index.windows)
  const lexicalStarted=performance.now(), lexical=await searchHybrid('特別照合','2026-10-01','2026-10-31',null), lexicalMs=performance.now()-lexicalStarted
  if(lexical?.hits[0]?.id!==snapshot.spans[9999].id)throw Error('LEXICAL_TAIL')
  const runs=[]
  for(let i=0;i<3;i++) {
    const begin=performance.now(), result=await searchHybrid('特別照合','2026-10-01','2026-10-31',embed), ms=performance.now()-begin
    if(result?.engine!=='hybrid'||result.hits[0]?.id!==snapshot.spans[9999].id||result.hits.some(hit=>snapshot.text.slice(hit.start,hit.end)!==hit.quote)||result.coverage.some(row=>row.complete!==false))throw Error('HYBRID_RESULT')
    runs.push({ms,hits:result.hits.length,firstSpan:9999})
    console.log('BENCH hybrid',i+1,ms)
    if(i===2) {
      await setSourcePermissions(id,1,{...defaultSourcePermissions(),index:false},[],null)
      if((await refreshHybridRetrieval(result))?.hits.length!==0||await db.sourceArtifacts.count()!==0)throw Error('REVOKED_RESULTS')
    }
  }
  return {scope:'Synthetic 10000 spans, real Chromium IndexedDB; 384-dimensional deterministic vectors. No real-model quality, OS offline or human acceptance claim.',spans:10000,textChars:text.length,importMs,indexMs,index,lexicalMs,runs,revocationCleared:true,tasks:await db.tasks.count(),ledger:await db.ledger.count()}
}
Object.assign(window,{benchmarkPromise:benchmark()})

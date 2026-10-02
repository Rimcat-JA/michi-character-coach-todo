const id=location.hash.slice(1),preview=document.getElementById('preview'),notice=document.getElementById('notice'),save=document.getElementById('save')
try {
  const result=await chrome.runtime.sendMessage({action:'preview',id})
  if(result.error)notice.textContent=result.error
  else if(result.capsule){preview.textContent=JSON.stringify(result.capsule,null,2);save.disabled=false}
  else notice.textContent='引用が見つかりません。もう一度選んでください。'
} catch {notice.textContent='確認中の引用が失われました。もう一度選んでください。'}
save.addEventListener('click',async event=>{
  if(!event.isTrusted||save.disabled)return
  save.disabled=true
  try {const result=await chrome.runtime.sendMessage({action:'save',id});notice.textContent=result.error??'保存先を選択しました。ブラウザのダウンロード結果を確認してください。';if(result.error)save.disabled=false}
  catch {notice.textContent='保存を確認できませんでした。もう一度引用を選んでください。'}
})
document.getElementById('cancel').addEventListener('click',async event=>{if(!event.isTrusted)return;await chrome.runtime.sendMessage({action:'cancel',id}).catch(()=>{});window.close()})

import {APP_RELEASE} from './release-version.js';
import {createWorkspaceSync} from './workspace-sync.js';
import {createAiProxy} from './ai-proxy.js';
import {validateSaved} from './model.js';
import {normalizeInitialTemplate} from './initial-data.js';
import {createDefaultInitialTemplate} from './default-scenario.js';
import {displayLabel} from './display-labels.js';

const TEMPLATE_KEY='zhihui-initial-template-v1';
const DOCS=[['settings','profile','个人配置'],['template','default','默认模板'],['run','current','当前运行']];
const labels={ready:'已保存至云端',empty:'尚无云存档',saving:'正在保存',pending:'等待保存',offline:'离线 · 本机待同步',conflict:'多端版本冲突',recovery:'发现本机待同步副本',error:'保存失败'};
export function aiProbeQuota(config){
 const usage=config?.usage;
 if(!usage)return {text:'',available:false};
 return config.limits.dailyRequests===null?
  {text:`今日已受理 ${usage.used} 次；每日次数不限。`,available:usage.remaining===null}:
  {text:`今日已受理 ${usage.used} / ${config.limits.dailyRequests} 次，剩余 ${usage.remaining} 次；每日按UTC重置。`,available:usage.remaining>0};
}
const defaults=()=>({displayName:'',ai:{provider:null,model:null},preferences:{notes:'',sortMode:'auto'}});
const clone=value=>JSON.parse(JSON.stringify(value));
// Match workspace-sync's object-key canonicalization. Equality here is exact;
// the short fingerprint below only tracks local UI changes across reloads.
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)
 ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
function localFingerprint(value){
 let first=0x811c9dc5,second=0x9e3779b9;
 for(let i=0;i<value.length;i++){
  const unit=value.charCodeAt(i);
  first=Math.imul(first^unit,0x01000193);
  second=Math.imul(second^(unit+(i&255)),0x85ebca6b);
 }
 return `${value.length.toString(36)}-${(first>>>0).toString(16).padStart(8,'0')}${(second>>>0).toString(16).padStart(8,'0')}`;
}

// A disabled adapter prevents startup and failed cloud loads from touching the
// anonymous namespace. Anonymous archives are only read after a static 404.
export function createWorkspaceStorage(raw=localStorage){
 let context=undefined,epoch=0;
 const prefix=id=>`zhihui-workspace-ui:${encodeURIComponent(id)}:`;
 const key=name=>context===null?name:prefix(context)+name;
 return {
  get generation(){return epoch;},get userId(){return context;},
  getItem(name){return context===undefined?null:raw.getItem(key(name));},
  setItem(name,value){if(context===undefined)throw new Error('个人空间尚未就绪，未保存。');raw.setItem(key(name),value);},
  removeItem(name){if(context!==undefined)raw.removeItem(key(name));},
  setContext(id){context=id;epoch++;},
  clearContext(){try{if(typeof context==='string'){const p=prefix(context);for(let i=raw.length-1;i>=0;i--){const k=raw.key(i);if(k?.startsWith(p))raw.removeItem(k);}}}catch{/* Disable all access even if the browser refuses cache removal. */}finally{context=undefined;epoch++;}},
 };
}

export function setupWorkspaceUI({model,initialUI,storage,$,esc,escRaw=esc,render,notify,clearPersonal,onRestored,onProfileSort,onAiStateChange=()=>{}}){
 let mode='checking',user=null,profile=defaults(),initialized=false,generation=0,errorText='',usage=null;
 let history=[],historySelection=null,backedUp=new Map(),panelOpen=false,resolutionToken=null;
 const dialog=$('workspace-dialog'),body=$('workspace-body');
 let sync;
 const aiProxy=createAiProxy({onChange:()=>renderAiProbe(),onAuthError:()=>invalidate('登录状态已变化，请重新验证账号。')});
 async function api(path,{method='GET',body:payload,headers={}}={}){
  const requestGeneration=generation;
  const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),15000);
  try{
  const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:abort.signal,headers:{'X-App-Release':APP_RELEASE,...(user&&path!=='/api/me'?{'X-Workspace-User':user.id}:{}),...headers,...(payload===undefined?{}:{'Content-Type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  const contentType=response.headers.get('content-type')||'';
  let data=null;try{if(contentType.includes('application/json'))data=await response.json();}catch{/* malformed response is never treated as empty */}
  if(!response.ok){const error=Object.assign(new Error(data?.error||`请求失败（${response.status}）`),{status:response.status,code:data?.error||'HTTP_ERROR',static404:response.status===404&&!contentType.includes('application/json')});
   if(requestGeneration===generation&&path!=='/api/me'&&!path.startsWith('/api/auth/')&&([401,403].includes(response.status)||error.code==='SESSION_CHANGED'))invalidate('登录状态已变化，请重新验证账号。');if(error.code==='RELEASE_REQUIRED')error.message='页面版本已过期，请刷新到最新版本；待同步副本仍已保留。';throw error;
  }
  if(data===null)throw Object.assign(new Error('云端响应格式异常，未覆盖存档。'),{code:'INVALID_RESPONSE'});
  return data;
  }catch(error){if(error.name==='AbortError')throw Object.assign(new Error('连接超时，变更尚未保存至云端。'),{code:'NETWORK_TIMEOUT'});throw error;}finally{clearTimeout(timeout);}
 }
 const snapshot=()=>sync?.snapshot()||{documents:[],pending:false};
 const entry=(kind,id)=>snapshot().documents.find(x=>x.kind===kind&&x.id===id);
 const fingerprint=row=>JSON.stringify({revision:row?.revision,value:row?.value,remote:row?.remote,recovery:row?.recovery,recoveries:row?.recoveries});
 const unresolved=()=>resolutionToken!==null||snapshot().documents.some(x=>['conflict','recovery','error'].includes(x.status));
 const deletedDocument=()=>snapshot().documents.some(x=>x.remote?.deleted&&x.value==null);
 const canEdit=()=>mode==='anonymous'||mode==='cloud'&&initialized&&!unresolved()&&!deletedDocument();
 const canRestore=()=>mode==='cloud'&&!unresolved()&&DOCS.every(([kind,id])=>entry(kind,id)?.loaded);
 function statusText(){
  if(mode==='checking')return '正在验证账号…';
  if(mode==='anonymous')return '匿名使用 · 存档仅在此浏览器';
  if(mode!=='cloud')return errorText||'个人云空间未就绪';
  if(resolutionToken)return '正在核对并恢复所选副本 · 编辑已暂停';
  if(deletedDocument())return '个人文档已删除 · 请显式恢复或重建';
  if(!initialized)return errorText||'正在读取个人空间 · 编辑已暂停';
  if(snapshot().pending&&snapshot().documents.some(x=>x.localBackupError))return '本机恢复副本保存失败 · 请立即导出备份';
  const rows=snapshot().documents,priority=['conflict','recovery','error','offline','saving','pending'];
  const found=priority.find(state=>rows.some(x=>x.status===state));
  return found?labels[found]:'个人空间已保存';
 }
 function refreshStatus(){
  const locked=!canEdit();document.querySelector('main').inert=locked;
  $('workspace-state').textContent=statusText();$('workspace-state').dataset.state=mode;
  $('workspace-user').textContent=user?(profile.displayName||user.username||user.email||user.id):mode==='anonymous'?'匿名使用':'账号与个人空间';
  $('workspace-lock').hidden=!locked;$('workspace-lock-text').textContent=errorText||'个人空间加载完成后可以编辑。';
  $('save-indicator').textContent=mode==='anonymous'?$('save-indicator').textContent:statusText();
  if(panelOpen){$('workspace-save-status').textContent=statusText();renderDocuments();}
  onAiStateChange();
 }
 function getAiContext(){
  // A transient browser offline signal must not discard the original request
  // ID kept for explicit recovery. Actual offline/pending document states and
  // local model changes still make this context unsendable or invalidate it.
  if(mode!=='cloud'||!initialized||!user?.id||unresolved())return null;
  const state=snapshot(),run=state.documents.find(row=>row.kind==='run'&&row.id==='current');
  if(!run?.loaded||!Number.isSafeInteger(run.revision)||run.revision<1||
   ['offline','error','conflict','recovery','loading','empty'].includes(run.status)||
   state.documents.some(row=>['offline','error','conflict','recovery'].includes(row.status)))return null;
  const current=canonical(JSON.parse(model.serialize()));
  const saved=canonical(run.value);
  return {userId:user.id,runDocumentId:'current',documentRevision:run.revision,
   localVersion:localFingerprint(current),synced:run.status==='ready'&&current===saved};
 }
 async function prepareAiContext(){
  if(mode!=='cloud'||!initialized||!user?.id||!navigator.onLine||unresolved())throw new Error('个人空间或网络未就绪，请先处理账号与同步状态。');
  const epoch=generation,owner=user.id;
  stageCurrent();
  await sync.flush();
  if(epoch!==generation||owner!==user?.id)throw new Error('账号已变化，请重新打开当前运行。');
  const context=getAiContext();
  if(!context?.synced)throw new Error('当前运行尚未完成云端保存，请检查个人空间的同步状态。');
  return context;
 }
 function invalidate(message){
  generation++;resolutionToken=null;initialized=false;mode='locked';errorText=message;user=null;profile=defaults();usage=null;history=[];historySelection=null;backedUp.clear();
  aiProxy.setUser(null);
  sync?.disconnect();storage.clearContext();clearPersonal();initialUI.resetStorage();render();
  if(panelOpen)renderPanel();refreshStatus();
 }
 sync=createWorkspaceSync({api,storage:localStorage,debounceMs:900,onChange:state=>{
  if(mode==='cloud'&&(state.error==='REAUTH_REQUIRED'||state.userId===null)){invalidate('登录已失效或账号已切换，请重新验证。');return;}
  refreshStatus();
 }});
 function download(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 function backup(){download({format:'zhihui-personal-backup-1',exportedAt:new Date().toISOString(),profile,template:initialUI.template(),run:JSON.parse(model.serialize()),documents:snapshot().documents},'智汇现金-个人空间与待同步副本.json');notify('已导出当前运行和保留的云端、本机副本。');}
 function apply(kind,value){
  if(value==null)return;
  if(kind==='settings')profile={...defaults(),...clone(value),ai:{...defaults().ai,...value.ai},preferences:{...defaults().preferences,...value.preferences}};
  if(kind==='template')initialUI.replaceTemplate(value);
  if(kind==='run'){const check=validateSaved(value);if(!check.ok)throw new Error('运行存档校验失败：'+check.errors.join('；'));model.load(value);onRestored();}
 }
 async function initializeLoaded(epoch){
  if(epoch!==generation||mode!=='cloud')return;
  let rows=DOCS.map(([kind,id])=>entry(kind,id));
  if(rows.some(x=>!x||x.loaded===false||!['ready','empty','conflict','recovery','pending','saving'].includes(x.status))){errorText='个人空间读取失败，编辑已暂停；请重试，不会用默认场景覆盖云端。';refreshStatus();return;}
  if(rows.some(x=>['conflict','recovery'].includes(x.status))){errorText='请选择云端或本机副本，处理完成后恢复编辑。';refreshStatus();return;}
  if(rows.some(x=>x.remote?.deleted&&x.value==null)){errorText='个人文档已有删除记录。请选择历史恢复或显式重建，编辑已暂停。';refreshStatus();return;}
  if(rows.some(row=>['pending','saving'].includes(row.status))){
   await sync.flush();if(epoch!==generation||mode!=='cloud')return;
   rows=DOCS.map(([kind,id])=>entry(kind,id));
  }
  if(rows.some(row=>!['ready','empty'].includes(row.status))){errorText='请先完成副本同步，原数据安全保存后再更新默认运行。';refreshStatus();return;}
  errorText='正在核对版本并备份旧运行…';refreshStatus();
  try {
   const upgraded=await api('/api/workspace/upgrade',{method:'POST',body:{
    expectedRunRevision:entry('run','current').revision,
    expectedTemplateRevision:entry('template','default').revision}});
   if(epoch!==generation||mode!=='cloud')return;
   if(upgraded.release!==APP_RELEASE)throw new Error('前后端版本不一致，请刷新到最新版本。');
   if(upgraded.upgraded||upgraded.run?.revision!==entry('run','current').revision||upgraded.template?.revision!==entry('template','default').revision){
    await Promise.all([sync.open('run','current'),sync.open('template','default')]);
    if(epoch!==generation||mode!=='cloud')return;
    rows=DOCS.map(([kind,id])=>entry(kind,id));
    if(rows.some(row=>!['ready','empty'].includes(row.status)))throw new Error('新版初始数据读取未完成，请刷新重试。');
    notify(`已更新至 ${APP_RELEASE}，原运行已自动备份到历史，当前使用最新默认数据。`);
   }
  }catch(error){
   if(epoch===generation){errorText=error.code==='REVISION_CONFLICT'?'其他页面已修改运行，请刷新后完成版本更新。':error.message||'版本更新失败，原运行保留，编辑已暂停。';refreshStatus();}
   return;
  }
  for(const row of rows)apply(row.kind,row.value);
  const templateRow=entry('template','default'),runRow=entry('run','current');
  if(templateRow.status==='empty')initialUI.replaceTemplate(createDefaultInitialTemplate());
  if(runRow.status==='empty'){model.startFromTemplate(initialUI.template());onProfileSort(profile.preferences.sortMode);model.generateProposal('AUTO');}
  initialized=true;errorText='';
  // Only successful 404/empty reads may initialize new personal documents.
  for(const [kind,id] of DOCS)if(entry(kind,id).status==='empty')sync.stage(kind,id,kind==='settings'?profile:kind==='template'?initialUI.template():JSON.parse(model.serialize()));
  render();refreshStatus();if(panelOpen)renderPanel();
 }
 async function verify(){
  const epoch=++generation;resolutionToken=null;initialized=false;mode='checking';errorText='';user=null;profile=defaults();usage=null;history=[];historySelection=null;backedUp.clear();
  aiProxy.setUser(null);
  sync.disconnect();storage.clearContext();clearPersonal();initialUI.resetStorage();render();refreshStatus();if(panelOpen)renderPanel();
  try{
   const data=await api('/api/me');if(epoch!==generation)return;
   if(!data.user||typeof data.user.id!=='string'||!data.features?.cloudStorage)throw new Error('云存储未配置，编辑已暂停。');
   user=data.user;storage.setContext(user.id);sync.connect(user.id);mode='cloud';refreshStatus();
   aiProxy.setUser(user.id);
   await Promise.all(DOCS.map(([kind,id])=>sync.open(kind,id)));if(epoch!==generation)return;
   await initializeLoaded(epoch);
   if(epoch===generation&&mode==='cloud')void aiProxy.refresh();
  }catch(error){if(epoch!==generation)return;
   if(error.static404){mode='anonymous';storage.setContext(null);initialUI.reloadStorage();model.startFromTemplate(initialUI.template());model.generateProposal('AUTO');render();}
   else{mode=error.status===401?'login':'unavailable';errorText=error.status===401?'请登录后读取个人空间。':error.status===503?'个人云空间未配置或暂不可用，编辑已暂停。':error.status===403?'当前账号没有访问此个人空间的权限。':error.message||'个人空间连接失败，编辑已暂停。';}
   refreshStatus();if(panelOpen)renderPanel();
  }
 }
 async function login(form){
  if(mode!=='login')return;
  const username=String(form.elements.username.value).trim(),password=form.elements.password.value;
  form.elements.password.value='';
  if(!username||!password){panelError(new Error('请输入用户名和密码。'));return;}
  form.querySelector('fieldset').disabled=true;
  try{await api('/api/auth/login',{method:'POST',body:{username,password}});await verify();if(mode==='cloud')dialog.close();}
  catch(error){
   const message=error.status===401?'用户名或密码错误。':error.status===429?'尝试次数过多，请稍后重试。':error.code==='NETWORK_TIMEOUT'||error instanceof TypeError?'登录连接失败，请稍后重试。':'登录未完成，请稍后重试。';
   if(mode==='login'){form.querySelector('fieldset').disabled=false;panelError(new Error(message));}
  }
 }
 async function logout(){
  backup();initialized=false;mode='checking';errorText='正在退出个人空间…';refreshStatus();sync.disconnect();
  aiProxy.setUser(null);
  try{await api('/api/auth/logout',{method:'POST'});}
  catch(error){if(error.status!==401){await verify();throw new Error('退出未完成，请检查连接后重试。');}}
  invalidate('已退出个人空间，请使用账号登录。');mode='login';renderPanel();refreshStatus();
 }
 function stageCurrent(immediate=false){if(mode==='cloud'&&canEdit()){sync.stage('run','current',JSON.parse(model.serialize()));const sortMode=onProfileSort();if(profile.preferences.sortMode!==sortMode){profile.preferences.sortMode=sortMode;sync.stage('settings','profile',profile);}if(immediate)sync.flush().catch(panelError);refreshStatus();}}
 function stageTemplate(value){if(mode==='cloud'&&canEdit()){sync.stage('template','default',value);refreshStatus();}}
 async function save(){if(mode!=='cloud')return false;if(!canEdit())throw new Error('请先处理个人空间加载或版本冲突。');stageCurrent();await sync.flush();refreshStatus();notify(snapshot().pending?'变更仍保留在本机，尚未完成云端保存。':'个人空间已保存至云端。');return true;}
 function documentTitle(kind){return DOCS.find(x=>x[0]===kind)?.[2]||kind;}
 function renderDocuments(){
  const target=$('workspace-documents');if(!target)return;
  target.innerHTML=snapshot().documents.map(row=>{
   const hasChoice=['conflict','recovery'].includes(row.status),id=`${row.kind}/${row.id}`,exported=backedUp.get(id)===fingerprint(row);
   return `<div class="workspace-document"><div><b>${documentTitle(row.kind)}</b><span>云端第 ${row.revision??0} 版 · ${labels[row.status]||'正在读取'}</span>${row.error?`<small class="form-error">${esc(typeof row.error==='string'?row.error:row.error.code||'保存失败')}</small>`:''}${row.localBackupError?'<small class="form-error">此浏览器无法保存恢复副本，请立即导出个人备份。</small>':''}</div>${row.remote?.deleted&&row.value==null?`<p>此文档已删除，不会自动用示例覆盖。</p><button data-workspace-rebuild="${id}">导出当前并显式重建此文档</button>`:''}${hasChoice?`<p>云端和本机副本均已保留。先导出双方，再选择用于继续工作的版本。</p><div class="workspace-actions"><button data-workspace-export="${id}">导出双方副本</button><button data-workspace-resolve="remote" data-doc="${id}" ${exported?'':'disabled'}>使用云端副本</button><button data-workspace-resolve="${row.status==='recovery'?'recovery':'local'}" data-doc="${id}" class="negative" ${exported?'':'disabled'}>使用本机副本并保存</button></div>`:''}</div>`;
  }).join('');
 }
 function renderPanel(){
  const cloud=mode==='cloud',enabled=cloud&&canEdit();
  body.innerHTML=`<div class="workspace-intro"><b>${user?esc(user.username||user.email||user.id):mode==='anonymous'?'匿名浏览器存档':'个人账号'}</b><p>五人独立空间 · 每个账号独立保存配置、模板和运行数据。</p><p id="workspace-save-status" role="status">${esc(statusText())}</p></div>${mode==='login'?`<section class="workspace-section workspace-login"><h3>登录个人空间</h3><form id="workspace-login" autocomplete="on"><fieldset><div class="form-grid"><label>用户名<input name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z](?:[A-Za-z0-9._]|-){2,31}" title="字母开头，3–32位字母、数字、点、下划线或连字符" autofocus><small class="muted">字母开头，3–32位字母、数字、点、下划线或连字符</small></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label></div><div class="workspace-actions"><button type="submit" class="primary">登录</button></div></fieldset></form><p class="muted">登录后读取该账号的个人空间；原匿名存档仅在手动选择导入后上传。</p></section><p id="workspace-error" class="form-error" role="alert"></p>`:''}${!cloud&&mode!=='login'?`<p class="origin-note">${mode==='anonymous'?'当前站点未连接个人空间；匿名存档仅保留在此浏览器。登录后需手动导入。':esc(errorText||'正在检查登录状态。')}</p><div class="workspace-actions"><button data-workspace="verify">重新检查账号</button></div>`:''}<div id="workspace-documents"></div>${mode!=='login'?`<section class="workspace-section"><h3>个人AI配置与长期备注</h3><p class="muted">以下只保存非秘密配置，服务商和模型名称是个人偏好；实际调用以服务端配置为准。请勿填写API密钥或密码。</p><form id="workspace-profile"><fieldset ${enabled?'':'disabled'}><div class="form-grid"><label>显示名称<input name="displayName" maxlength="80" value="${escRaw(profile.displayName)}"></label><label>模型服务商<input name="provider" maxlength="120" placeholder="待指定" value="${escRaw(profile.ai.provider||'')}"></label><label>模型名称<input name="model" maxlength="120" placeholder="待指定" value="${escRaw(profile.ai.model||'')}"></label><label>排序偏好<select name="sortMode"><option value="auto" ${profile.preferences.sortMode==='auto'?'selected':''}>自动排序</option><option value="reverse_repo_first" ${profile.preferences.sortMode==='reverse_repo_first'?'selected':''}>融券下单优先</option><option value="liquidity_last" ${profile.preferences.sortMode==='liquidity_last'?'selected':''}>平头寸优先</option></select></label><label class="wide">长期备注<textarea name="notes" maxlength="4000" placeholder="偏好与背景；不改变硬约束">${escRaw(profile.preferences.notes)}</textarea></label></div><div class="workspace-actions"><button type="submit" class="primary">保存个人配置</button></div></fieldset></form></section>`:''}${cloud?`<section class="workspace-section"><h3>存档与恢复</h3><p>普通编辑自动保存。刷新恢复保留输入、偏好与运行记录；请刷新快照、重新计算并审核后继续下达。历史仅展示本账号版本。</p><div class="workspace-actions"><button data-workspace="flush" ${enabled?'':'disabled'}>立即同步</button><button data-workspace="backup">导出个人空间副本</button><button data-workspace="anonymous-import" ${enabled?'':'disabled'}>选择导入原匿名本地存档</button><button data-workspace="history">查看云端运行历史</button><button data-workspace="usage">查看空间用量</button></div><div id="workspace-history"></div><div id="workspace-usage"></div></section><section class="workspace-section"><h3>退出与账号切换</h3><p>退出会清除页面个人内容和界面缓存。本机待同步副本仍按原账号隔离，可在该账号重新登录后选择恢复。</p><div class="workspace-actions"><button data-workspace="verify-backup">导出并重新验证账号</button><button data-workspace="logout" class="negative">导出个人副本并退出／切换账号</button></div></section>`:''}${mode==='login'?'':'<p id="workspace-error" class="form-error" role="alert"></p>'}`;
  renderDocuments();
  if(cloud){$('workspace-profile').closest('section').insertAdjacentHTML('afterend','<section class="workspace-section" id="workspace-ai"></section>');renderAiProbe();}
  if(mode==='login')$('workspace-login').onsubmit=e=>{e.preventDefault();void login(e.target);};
  if(mode!=='login')$('workspace-profile').onsubmit=e=>{e.preventDefault();try{if(!canEdit()||mode!=='cloud')throw new Error('个人空间未就绪。');const fd=new FormData(e.target);profile={displayName:fd.get('displayName').trim(),ai:{provider:fd.get('provider').trim()||null,model:fd.get('model').trim()||null},preferences:{notes:fd.get('notes'),sortMode:fd.get('sortMode')}};sync.stage('settings','profile',profile);onProfileSort(profile.preferences.sortMode);stageCurrent();refreshStatus();notify('个人配置已加入保存队列。');}catch(error){panelError(error);}};
 }
 function panelError(error){const target=$('workspace-error');if(target)target.textContent=error.message||String(error);else notify(error.message||String(error));}
 function renderAiProbe(){
  const target=$('workspace-ai');if(!target)return;
  if(mode!=='cloud'){target.innerHTML='';return;}
  const s=aiProxy.snapshot(),c=s.config,status=c?.state??c?.status;
  const titles={unconfigured:'尚未配置服务',disabled:'服务已停用',mock_ready:'离线响应可用',real_ready:'AI服务已配置',provider_unsupported:'当前服务商尚未接入',credential_missing:'服务端密钥待配置',config_invalid:'服务端配置需修正'};
  const busy=['running','cancelling'].includes(s.phase),active=!!s.requestId||!!c?.activeRequestId;
  const phase={running:`正在进行${s.requestMode==='real_ready'?'AI服务':'离线响应'}测试…`,cancelling:'正在请求取消…',cancelled:'请求已取消。',completed:s.result?.simulated?'离线响应测试完成，未调用外部AI。':'AI服务连接测试完成。',error:'本次测试未完成。'}[s.phase]||'';
  const testLabel=status==='real_ready'?'AI服务连接测试':'离线响应测试';
  const quota=aiProbeQuota(c);
  const canTest=['mock_ready','real_ready'].includes(status)&&!busy&&!active&&
   quota.available;
  target.innerHTML=`<h3>AI连接准备</h3><p>仅测试请求通路，不生成或应用交易草案。上方服务商和模型名称是个人偏好；下列是服务端实际配置。</p><p id="workspace-ai-status" role="status"><b>${esc(titles[status]||'尚未读取配置状态')}</b>${c?.provider?` · ${esc(c.provider)} / ${esc(c.model||'未指定')}`:''}</p>${c?.usage?`<p class="muted">${esc(quota.text)}每人同时1个请求，超时 ${esc(c.limits.timeoutMs/1000)} 秒。失败和取消仍计次。</p>`:''}<div class="workspace-actions"><button data-workspace="ai-status">刷新配置状态</button><button data-workspace="ai-test" ${canTest?'':'disabled'}>${testLabel}</button><button data-workspace="ai-cancel" ${active&&s.phase!=='cancelling'?'':'disabled'}>取消进行中的请求</button></div><p class="muted">${status==='real_ready'?'连接测试会调用外部AI服务，可能产生费用。':'离线响应测试不调用外部AI服务。'}测试只发送固定连接提示词，不发送业务数据；结果不会加入完整聊天或拟单。无需在页面填写密钥。</p><p id="workspace-ai-progress" role="status">${esc(phase)}</p>${s.result?`<p id="workspace-ai-result" class="workspace-ai-result"><b>${s.result.simulated?'离线响应':'AI服务响应'}</b><br>${esc(s.result.text)}</p>`:''}<p id="workspace-ai-error" class="form-error" role="alert">${esc(s.cancelError||s.error)}</p>`;
 }
 function show(){panelOpen=true;renderPanel();if(!dialog.open)dialog.showModal();}
 $('workspace-open').onclick=show;$('workspace-lock-open').onclick=show;$('workspace-close').onclick=()=>dialog.close();
 dialog.addEventListener('close',()=>{const password=body.querySelector('#workspace-login [name="password"]');if(password)password.value='';panelOpen=false;});
 async function resolve(kind,id,choice){
  if(resolutionToken)throw new Error('正在恢复副本，请等待完成。');
  const epoch=generation,owner=user?.id,key=`${kind}/${id}`;
  if(backedUp.get(key)!==fingerprint(entry(kind,id)))throw new Error('副本已有变化，请先重新导出双方副本。');
  const token={};resolutionToken=token;refreshStatus();
  let failure=null;
  try{
   // The model must accept the selected value before sync advances its CAS
   // revision or removes recovery copies. This callback must stay synchronous.
   const row=await sync.resolve(kind,id,choice,{apply:value=>{
    if(epoch!==generation||owner!==user?.id)throw new Error('账号已变化，未恢复副本。');
    apply(kind,value);
   }});
   if(epoch!==generation)return;
   if(row&&['ready','empty','pending'].includes(row.status)){
    backedUp.delete(key);
    if(!initialized)await initializeLoaded(epoch);else render();
   }else if(row){
    failure=row.error==='REMOTE_CHANGED_AGAIN'?'云端副本又有变化，请重新导出双方副本并选择。':
     '所选副本未能恢复，编辑仍暂停；双方副本已保留，请核对后重试。';
   }
  }finally{
   if(resolutionToken===token)resolutionToken=null;
   if(epoch===generation){refreshStatus();if(panelOpen)renderPanel();}
  }
  if(failure)throw new Error(failure);
 }
 async function showHistory(){
  const epoch=generation;
  const [result,releases]=await Promise.all([api('/api/documents/run/current/history'),api('/api/workspace/backups')]);
  if(epoch!==generation)return;
  history=result.history||[];
  if(!Array.isArray(history)||!Array.isArray(releases.backups))throw new Error('历史响应格式异常。');
  $('workspace-history').innerHTML=releases.backups.map(row=>`<div class="workspace-history-row"><span>更新至 ${esc(row.release)} 前的自动备份 · ${esc(row.createdAt)}</span><button data-workspace-backup="${escRaw(row.release)}">查看及恢复</button></div>`).join('')+
   (history.map(row=>`<div class="workspace-history-row"><span>第 ${row.revision} 版 · ${esc(row.updatedAt||row.createdAt||'时间未提供')}${row.deleted?' · 删除记录':''}</span><button data-workspace-history="${row.revision}">查看及恢复</button></div>`).join('')||'<p>暂无常规历史版本。</p>');
 }
 async function inspectHistory(revision,release=null){
  const epoch=generation,result=await api(release?`/api/workspace/backups/${encodeURIComponent(release)}`:`/api/documents/run/current/history/${revision}`);
  if(epoch!==generation)return;
  const row=release?result.backup.document:result.document||result.version||result;
  historySelection=row.value;
  if(historySelection==null)throw new Error('该版本没有可恢复的正文。');
  const check=validateSaved(historySelection);if(!check.ok)throw new Error('历史运行格式校验失败。');
  $('workspace-history').innerHTML=`<p>${release?`更新至 ${esc(release)} 前的自动备份`:`第 ${Number(revision)} 版`} · ${esc(displayLabel(historySelection.initialData?.label||historySelection.scenarioId))}。恢复将写为新的运行版本；恢复后需要重算重审。</p><div class="workspace-actions"><button data-workspace="export-history">导出此历史版本</button><button data-workspace="restore-history" ${canRestore()?'':'disabled'}>先导出当前副本并恢复此版</button><button data-workspace="history">返回历史列表</button></div>`;
 }
 function importAnonymous(){
  const candidates=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith('zhihui-simulator-')){try{const value=JSON.parse(localStorage.getItem(key));if(validateSaved(value).ok)candidates.push({key,value});}catch{/* invalid anonymous data stays untouched */}}}
  const template=localStorage.getItem(TEMPLATE_KEY);let validTemplate=null;try{if(template)validTemplate=normalizeInitialTemplate(JSON.parse(template));}catch{/* show only validated candidate */}
  $('workspace-history').innerHTML=`<p>请选择原匿名存档。此操作显式上传所选副本到当前个人空间，先导出当前副本；原匿名存档保留。</p>${candidates.map((x,i)=>`<div class="workspace-history-row"><span>${esc(displayLabel(x.value.initialData?.label||x.value.scenarioId))} · ${esc(x.key)}</span><button data-workspace-anonymous="${i}">导出当前并导入此运行</button></div>`).join('')||'<p>此浏览器没有有效的匿名运行存档。</p>'}${validTemplate?'<button id="workspace-import-template">导出当前并导入匿名默认模板</button>':''}`;
  $('workspace-history').querySelectorAll('[data-workspace-anonymous]').forEach(button=>button.onclick=()=>{try{if(!canEdit())throw new Error('个人空间未就绪。');backup();apply('run',candidates[Number(button.dataset.workspaceAnonymous)].value);stageCurrent();render();refreshStatus();notify('已导入所选匿名运行并加入个人保存队列；请重算重审。');}catch(error){panelError(error);}});
  if(validTemplate)$('workspace-import-template').onclick=()=>{try{if(!canEdit())throw new Error('个人空间未就绪。');backup();apply('template',validTemplate);stageTemplate(validTemplate);render();refreshStatus();notify('已导入匿名默认模板；当前运行不变。');}catch(error){panelError(error);}};
 }
 body.addEventListener('click',async e=>{const action=e.target.closest('[data-workspace]'),exportButton=e.target.closest('[data-workspace-export]'),resolveButton=e.target.closest('[data-workspace-resolve]'),historyButton=e.target.closest('[data-workspace-history]'),releaseBackupButton=e.target.closest('[data-workspace-backup]'),rebuildButton=e.target.closest('[data-workspace-rebuild]');try{
  if(exportButton){const [kind,id]=exportButton.dataset.workspaceExport.split('/');download(entry(kind,id),'智汇现金-冲突双方副本.json');backedUp.set(`${kind}/${id}`,fingerprint(entry(kind,id)));renderDocuments();}
  if(resolveButton&&!resolveButton.disabled){const [kind,id]=resolveButton.dataset.doc.split('/');await resolve(kind,id,resolveButton.dataset.workspaceResolve);}
  if(rebuildButton){if(!canRestore())throw new Error('请先处理加载失败或版本冲突。');const [kind,id]=rebuildButton.dataset.workspaceRebuild.split('/');backup();let value=kind==='settings'?defaults():kind==='template'?createDefaultInitialTemplate():null;if(kind==='run'){model.startFromTemplate(entry('template','default')?.value||createDefaultInitialTemplate());model.generateProposal('AUTO');value=JSON.parse(model.serialize());}sync.stage(kind,id,value);await initializeLoaded(generation);renderPanel();}
  if(historyButton)await inspectHistory(historyButton.dataset.workspaceHistory);
  if(releaseBackupButton)await inspectHistory(null,releaseBackupButton.dataset.workspaceBackup);
  if(!action)return;switch(action.dataset.workspace){
   case 'verify':await verify();break;
   case 'verify-backup':backup();await verify();break;
   case 'flush':await save();break;
   case 'backup':backup();break;
   case 'anonymous-import':importAnonymous();break;
   case 'history':await showHistory();break;
   case 'export-history':download(historySelection,'智汇现金-云端历史运行.json');break;
   case 'restore-history':if(!canRestore()||!historySelection)throw new Error('请先处理版本冲突。');backup();apply('run',historySelection);sync.stage('run','current',JSON.parse(model.serialize()));if(!initialized)await initializeLoaded(generation);render();refreshStatus();notify('历史版本已恢复并加入保存队列；请刷新、重算和重审。');break;
   case 'usage':{const epoch=generation;usage=await api('/api/usage');if(epoch!==generation)return;const u=usage.usage||{},l=usage.limits||{},mb=n=>n==null?'待提供':(n/1048576).toFixed(2)+' MB';$('workspace-usage').innerHTML=`<p>当前个人空间用量</p><div class="table-scroll"><table><tbody><tr><th>文档</th><td>${esc(u.documents)} / ${esc(l.documents)}</td></tr><tr><th>保留历史</th><td>${esc(u.historyVersions)} 版 · 每份最多 ${esc(l.historyVersionsPerDocument)} 版</td></tr><tr><th>历史正文容量</th><td>${mb(u.historyBytes)} / ${mb(l.historyBytes)}</td></tr><tr><th>保存重试记录</th><td>${esc(u.receipts)} / ${esc(l.receipts)} · 保留 ${esc(l.receiptRetentionDays)} 天</td></tr></tbody></table></div><p class="muted">较早的历史版本会按保留上限回收，重要运行请另行导出备份。</p>`;break;}
   case 'ai-status':await aiProxy.refresh();break;
   case 'ai-test':await aiProxy.run();break;
   case 'ai-cancel':await aiProxy.cancel();break;
   case 'logout':await logout();break;
  }
 }catch(error){panelError(error);}});
 // Inert is the main control; capturing guard also covers toolbar and dialogs
 // opened before a network failure or a session switch.
 for(const name of ['click','change','input','submit'])document.addEventListener(name,e=>{if(canEdit()||e.target.closest('#workspace-dialog,#workspace-open,#workspace-lock'))return;if(e.target.closest('main,#dialog,.toolbar,nav')){e.preventDefault();e.stopImmediatePropagation();notify('个人空间尚未就绪，请先处理账号或版本状态。');}},true);
 window.addEventListener('online',()=>{if(mode==='cloud'&&initialized)sync.flush().catch(panelError);});
 window.addEventListener('focus',()=>{if(mode==='cloud'){const epoch=generation,owner=user?.id;api('/api/me').then(data=>{if(epoch===generation&&user&&data.user?.id!==owner)invalidate('账号已切换，请重新验证。');}).catch(error=>{if(epoch===generation&&[401,403].includes(error.status))invalidate('登录状态已变化，请重新验证账号。');});}});
 return {verify,show,stageCurrent,stageTemplate,save,canEdit,refreshStatus,isCloud:()=>mode==='cloud',snapshot,getAiContext,prepareAiContext};
}

import {normalizeInitialTemplate, bankDepositLimitBps} from './initial-data.js';
import {createDefaultInitialTemplate,createBankOrderInitialTemplate,createRemediationInitialTemplate} from './default-scenario.js';
import {createOriginalInitialTemplate} from './original-scenario.js';
import {BUSINESS_TYPES, BUSINESS_DIRECTIONS, isFinancing, isExchangeRepo} from './business.js';
import {displayLabel, preserveLabel, displayTermsNote, preserveTermsNote} from './display-labels.js';

const TEMPLATE_KEY='zhihui-initial-template-v1', HISTORY_KEY='zhihui-run-history-v1';
const copy=x=>JSON.parse(JSON.stringify(x));
const kinds={deposit:'银行存款',cd:'同业存单',bond:'普通债券',repo:'回购',government_bond:'政府债'};
const cashKinds={repo_maturity:'回购到期',deposit_maturity:'存款到期',security_redemption:'现券兑付'};
const tradeKinds={primary_cd_subscription:'一级存单已认购',secondary_security_trade:'二级现券已成交'};
const direction={inflow:'流入',outflow:'流出'};
const markets={INTERBANK:'银行间',SSE:'上交所',SZSE:'深交所'};
const business=Object.fromEntries(Object.entries(BUSINESS_TYPES).map(([k,v])=>[k,v.label]));
Object.assign(business,{cd_buy:'现券买入（存单）',cd_sell:'现券卖出（存单）',bond_buy:'现券买入（其他）',bond_sell:'现券卖出（其他）'});
const isLabel=field=>field.key==='label'||field.key.endsWith('.label');
const f=(key,label,type='text',options=null)=>({key,label,type,options});
const schemas={
 banks:{title:'银行资格与评级',id:'bankId',fields:[f('label','银行名称'),f('custodyQualified','托管资格','nullableBool'),f('rating','评级','nullable'),f('ratingAsOf','评级日期','nullableDate'),f('quarterlyNetAssetsYuan','季度净资产','money'),f('quarterEnd','季度末日期','nullableDate'),f('depositLimitBps','公司新增存款闸门','select',{'600':'6%（默认）','800':'8%（该行批准）'})]},
 securities:{title:'证券与期限',id:'securityId',fields:[f('label','证券名称'),f('instrumentKind','证券品种','select',kinds),f('issuerBankId','发行银行','bank'),f('issuerType','发行人类型','select',{bank:'商业银行',non_bank:'明确非银行主体',government:'政府',unknown:'未知待核'}),f('remainingTradingDays','剩余天数','integer')]},
 holdings:{title:'本基金持仓',id:'holdingId',fields:[f('securityId','证券','security'),f('amountYuan','持仓金额','money'),f('sellableYuan','可卖金额','money')]},
 otherFundBankExposure:{title:'公司其他货基银行敞口',fields:[f('bankId','银行','bank'),f('depositYuan','存款','money'),f('cdYuan','存单','money'),f('bondYuan','债券','money'),f('otherYuan','其他','money')]},
 maturityCashEvents:{title:'当日逐笔到期收付',id:'eventId',fields:[f('label','事件名称'),f('kind','类别','select',cashKinds),f('direction','现金方向','select',direction),f('amountYuan','金额','money'),f('sourceHoldingId','关联持仓','holding'),f('sourceLiabilityWeightId','正回购到期关联负债','termLiability'),f('sourcePositiveRepoWeightId','正回购到期关联调整项','termRepo'),f('includedInOpeningCash','日初已收付','bool')]},
 pendingSettlements:{title:'一级存单及既有成交收付',id:'tradeId',fields:[f('label','交易名称'),f('kind','交易来源','select',tradeKinds),f('businessType','业务','select',Object.fromEntries(['cd_buy','cd_sell','bond_buy','bond_sell'].map(k=>[k,business[k]]))),f('securityId','证券','security'),f('issuerId','发行银行','bank'),f('amountYuan','成交金额','money'),f('holdingIncludedAtOpen','日初持仓已含该成交变化','bool'),f('cashIncludedAtOpen','日初已收付','bool')]},
 draftPlans:{title:'新运行的计划草案',fields:[f('label','计划名称'),f('businessType','业务类型','select',business),f('counterpartyId','交易对手','bank'),f('issuerId','发行银行','bank'),f('securityId','证券','security'),f('targetYuan','意向金额','money'),f('termsNote','备注','nullable'),f('repoTerms.market','回购市场','select',markets),f('repoTerms.tenorDays','回购期限（天）','integer')]},
};
const read=(o,key)=>key.split('.').reduce((v,k)=>v?.[k],o);
const write=(o,key,v)=>{const keys=key.split('.');let t=o;keys.slice(0,-1).forEach(k=>t=t[k]??={});t[keys.at(-1)]=v;};

export function setupInitialUI({model,$,esc,escRaw=esc,amount,decimalYuan,ratioPercent,parseMoney,parseAnnualRate,openDialog,closeDialog,formFooter,formError,changed,notify,render,setScreen,storage=localStorage,onTemplateChange=()=>{}}){
 const presets={'remediation-sample':{label:'补救案例（默认，未预设卖券）',create:createRemediationInitialTemplate},sample:{label:'三项银行约束（预设卖券）',create:createBankOrderInitialTemplate},'original-sample':{label:'原始样例（零现金／成农商6%）',create:createOriginalInitialTemplate}};
 for(const preset of Object.values(presets))preset.templateId=preset.create().templateId;
 let template=createDefaultInitialTemplate();
 let loadWarning='';
 function reloadStorage(){template=createDefaultInitialTemplate();loadWarning='';try{const saved=storage.getItem(TEMPLATE_KEY);if(saved){const checked=normalizeInitialTemplate(JSON.parse(saved));if(checked.provenance.kind!=='synthetic')throw new Error('旧场景请从运行存档恢复，不能作为新的初始模板。');template=checked;}}catch(e){loadWarning=`已保存的模板无法读取，暂显示内置样例；原存储未覆盖。${e.message}`;}}
 reloadStorage();
 const optionsFor=field=>['termLiability','termRepo'].includes(field.type)?Object.fromEntries((template.termWeights?.[field.type==='termLiability'?'liabilities':'positiveRepos']||[]).map(w=>[w.weightId,displayLabel(w.label)])):field.type==='holding'?Object.fromEntries(template.holdings.map(h=>[h.holdingId,displayLabel(template.securities.find(x=>x.securityId===h.securityId)?.label)||h.holdingId])):field.type==='bank'?Object.fromEntries(template.banks.map(b=>[b.bankId,displayLabel(b.label)])):field.type==='security'?Object.fromEntries(template.securities.map(s=>[s.securityId,displayLabel(s.label)])):field.options;
 const valueText=(field,v)=>{
  if(field.key==='depositLimitBps')v=bankDepositLimitBps({depositLimitBps:v===null?undefined:v});
  if(v==null)return '待补';
  if(field.key==='termsNote')return displayTermsNote(v);
  if(field.type==='money'||field.type==='signedMoney')return amount(v)+' 亿';
  if(field.type==='percent')return ratioPercent(v)+'%';
  if(field.type.endsWith('Bool')||field.type==='bool')return v?'是':'否';
  return isLabel(field)||['bank','security','holding'].includes(field.type)?displayLabel(optionsFor(field)?.[v]??v):optionsFor(field)?.[v]??v;
 };
 const input=(field,obj)=>{
  const v=field.key==='depositLimitBps'?bankDepositLimitBps(obj):read(obj,field.key)??(field.type==='bool'?false:null),opts=optionsFor(field),isBool=['bool','nullableBool'].includes(field.type);
  let control;
  if(opts||isBool){const entries=isBool?[['true','是'],['false','否']]:Object.entries(opts);const allowEmpty=field.type!=='select'&&field.type!=='bool';control=`<select name="${field.key}">${allowEmpty?'<option value="">待补 / 无</option>':''}${entries.map(([k,n])=>`<option value="${escRaw(k)}" ${String(v)===k?'selected':''}>${esc(displayLabel(n))}</option>`).join('')}</select>`;}
  else{const value=v==null?'':['money','signedMoney'].includes(field.type)?decimalYuan(v):field.type==='percent'?ratioPercent(v):isLabel(field)?displayLabel(v):field.key==='termsNote'?displayTermsNote(v):v;control=`<input name="${field.key}" type="${field.type.toLowerCase().includes('date')?'date':'text'}" ${['money','signedMoney','integer','percent'].includes(field.type)?'inputmode="decimal"':''} value="${escRaw(value)}" ${['text','date'].includes(field.type)?'required':''}>`;}
  return `<label>${esc(field.label)}${['money','signedMoney'].includes(field.type)?'（亿元）':''}${control}</label>`;
 };
 const parse=(field,value,original)=>{
  const v=String(value??'').trim();
  if(field.key==='depositLimitBps'){if(!['600','800'].includes(v))throw new Error('新增存款闸门须为6%或该行批准8%');return Number(v);}
  if(isLabel(field))return preserveLabel(v,original);
  if(field.key==='termsNote')return preserveTermsNote(v,original);
  if(field.type==='money')return parseMoney(v,'亿',true);
  if(field.type==='signedMoney')return v.startsWith('-')?-parseMoney(v.slice(1),'亿'):v.startsWith('+')?parseMoney(v.slice(1),'亿'):parseMoney(v,'亿');
  if(field.type==='percent')return parseAnnualRate(v);
  if(field.type==='integer'){if(!v)return null;if(!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v)))throw new Error(`${field.label}须为非负整数`);return Number(v);}
  if(['bool','nullableBool'].includes(field.type))return v===''?null:v==='true';
  return v||(['nullable','nullableDate','bank','security','holding','termLiability','termRepo'].includes(field.type)?null:'');
 };
 function persist(next){if(next.provenance?.kind!=='synthetic')throw new Error('初始数据页只接收当前模板；历史运行请从存档恢复。');next.revision=template.revision+1;const checked=normalizeInitialTemplate(next);storage.setItem(TEMPLATE_KEY,JSON.stringify(checked));template=checked;onTemplateChange(copy(template));loadWarning='';render();notify('默认模板已更新，保存状态见个人空间；当前运行的期初数据与事实保持独立。');}
 function history(){const list=JSON.parse(storage.getItem(HISTORY_KEY)||'[]');if(!Array.isArray(list))throw new Error('运行历史格式异常，请先导出当前运行。');return list;}
 function preserve(){const state=model.serialize(),s=model.getState(),list=history();if(list.some(x=>x.state===state))return;list.unshift({id:crypto.randomUUID(),label:s.initialData?.label||'历史运行',businessDate:s.context.businessDate,time:new Date().toISOString(),state});storage.setItem(HISTORY_KEY,JSON.stringify(list));}
 function begin(next=template,{replaceTemplate=false,presetLabel=''}={}){
  const checked=normalizeInitialTemplate(next);
  // All local writes must succeed before replacing the active run. preserve()
  // is shared by manual template starts and preset switches, so it runs once.
  preserve();
  if(replaceTemplate){
   const old=storage.getItem(TEMPLATE_KEY);
   if(old)storage.setItem(`${TEMPLATE_KEY}-before-single-day`,old);
   storage.setItem(TEMPLATE_KEY,JSON.stringify(checked));
   template=checked;loadWarning='';
  }
  model.startFromTemplate(checked);model.generateProposal('AUTO');
  if(replaceTemplate)onTemplateChange(copy(template));
  setScreen('desk');changed(presetLabel?`已切换至${presetLabel}并新建独立运行，原运行已保留至历史。`:'已按当前模板创建独立运行，原运行已保留至历史。');
 }
 function switchPreset(key){const preset=presets[key];if(!preset)throw new Error('未找到内置样例');begin(preset.create(),{replaceTemplate:true,presetLabel:preset.label});}
 function editRow(key,index){const schema=schemas[key],existing=index>=0?template[key][index]:null;const row=existing?copy(existing):Object.fromEntries(schema.fields.map(x=>[x.key,x.type==='bool'?false:x.type==='select'?Object.keys(x.options)[0]:x.type==='date'?template.businessDate:null]));
  if(key==='maturityCashEvents')row.dueDate??=template.businessDate;
  if(key==='draftPlans'){row.tradeDate??=template.businessDate;row.settlementDate??=template.businessDate;}
  if(key==='pendingSettlements'){row.tradeDate??=template.businessDate;row.settlementDate??=template.businessDate;}
  openDialog(`${existing?'编辑':'新增'} · ${schema.title}`,`<p class="origin-note">修改默认模板，下一次新建运行时生效。金额单位亿元，留空表示未知。银行和证券请先维护，再被其他项目引用。${key==='banks'?'公司新增存款闸门按（本基金＋公司其他货基）同银行存款、存单及银行债／银行季度净资产计算；新增存款后不超过6%，该行批准可用8%，等于限额允许。存单买入继续受其他适用规则限制。':''}</p><form id="initial-row-form"><div class="form-grid">${schema.fields.map(field=>input(field,row)).join('')}</div>${formFooter('保存到默认模板')}</form>`);
  $('initial-row-form').onsubmit=e=>{e.preventDefault();try{const next=copy(template),fd=new FormData(e.target),item=existing?copy(existing):{};for(const field of schema.fields)write(item,field.key,parse(field,fd.get(field.key),read(row,field.key)));if(schema.id&&!item[schema.id])item[schema.id]=`template-${crypto.randomUUID()}`;
   if(key==='securities'){item.isGovernmentBond=item.instrumentKind==='government_bond';if(item.isGovernmentBond)item.issuerType='government';else if(item.issuerBankId)item.issuerType='bank';}
   if(key==='pendingSettlements'||key==='draftPlans')item.direction=BUSINESS_DIRECTIONS[item.businessType];
   if(key==='maturityCashEvents')item.dueDate=template.businessDate;
   if(key==='pendingSettlements'){item.tradeDate=template.businessDate;item.settlementDate=template.businessDate;}
   if(key==='draftPlans'){item.tradeDate=template.businessDate;item.settlementDate=template.businessDate;item.termsNote??='';item.marketTier=['cd_buy','cd_sell','bond_buy','bond_sell'].includes(item.businessType)?'secondary':null;if(item.repoTerms)item.repoTerms.annualRate=null;if(!isFinancing(item.businessType)&&!isExchangeRepo(item.businessType)&&item.businessType!=='reverse_repo')item.repoTerms=null;}
   if(index>=0)next[key][index]=item;else next[key].push(item);persist(next);closeDialog();}catch(error){formError(error);}};
 }
 function editBase(){const fields=[f('label','模板名称'),f('businessDate','业务日期','date'),f('portfolio.label','组合名称'),f('portfolio.navYuan','净资产','money'),f('portfolio.accountCashYuan','日初基础账户现金','money'),f('portfolio.netSubscriptionYuan','净申赎（申购为正、赎回为负）','signedMoney'),f('portfolio.bufferYuan','安全垫','money')];
  openDialog('模板起点',`<p class="origin-note">基础账户现金不含净申赎和当日到期收付。净申赎日初已经到账；逐笔到期款在下方设置“日初已收付”，未收付的仍计入业务头寸，实际付款按真实账户余额核对。金额与持仓变更后请核对完整期限权重。</p><form id="initial-base-form"><div class="form-grid">${fields.map(field=>input(field,template)).join('')}</div>${formFooter('保存模板起点')}</form>`);
  $('initial-base-form').onsubmit=e=>{e.preventDefault();try{const next=copy(template),fd=new FormData(e.target);for(const field of fields)write(next,field.key,parse(field,fd.get(field.key),read(template,field.key)));persist(next);closeDialog();}catch(error){formError(error);}};
 }
 function renderPage(s){
  $('initial-screen').innerHTML=`<section class="panel"><div class="section-head wrap"><h1>初始数据模板</h1><span>单日 · 本金口径</span><button data-initial="base">编辑起点</button><button data-initial="begin" class="primary">从模板新建运行</button></div><div class="template-overview"><p>当前模板选择：${esc(Object.values(presets).find(p=>p.templateId===template.templateId)?.label||'自定义／导入模板')}</p><b>${esc(displayLabel(template.label))} · 第${template.revision}版</b><p>业务日 ${esc(template.businessDate)} · ${esc(displayLabel(template.portfolio.label))} · 净资产 ${amount(template.portfolio.navYuan)}亿 · 基础账户现金 ${amount(template.portfolio.accountCashYuan)}亿 · 净申赎 ${amount(template.portfolio.netSubscriptionYuan??0)}亿</p><p>当前运行：${esc(displayLabel(s.initialData?.label)||'历史运行')}。${s.initialData?.demoMode==='single-day-principal-v1'?'单日简化模式':'历史模式：保留原运行事实；可从简化模板新建运行。'} 模板保存不修改已有运行；新建时自动保留原运行。</p><details class="technical-details"><summary>数据来源</summary><p>当前模板提供期初持仓、资金、银行参数及计划。修改后从模板新建运行生效；当前运行按自己的初始数据和业务事件计算。</p></details><p class="muted">逐笔到期款可标记日初已收付，未收付款计入业务头寸。期限按填写天数，一年按365天；正回购金额与期限仍在完整权重表中维护。</p>${loadWarning?`<p class="form-error">${esc(loadWarning)}</p>`:''}<p class="muted">内置样例一键切换并新建运行，原运行保留历史。</p><div class="storage-grid"><button data-initial="remediation-sample">补救案例（默认，未预设卖券）</button><button data-initial="sample">三项银行约束（预设卖券）</button><button data-initial="original-sample">原始样例（零现金／成农商6%）</button><button data-initial="history">查看运行历史</button><button data-initial="export">导出默认模板</button><button data-initial="import">导入模板</button></div></div></section>`+
  Object.entries(schemas).map(([key,schema])=>`<section class="panel"><div class="section-head"><h2>${schema.title}</h2><span>${template[key].length}条</span><button data-initial-add="${key}">新增</button></div><div class="table-scroll"><table class="template-table"><thead><tr><th>序号</th>${schema.fields.filter(x=>!x.key.startsWith('repoTerms.')).map(x=>`<th>${esc(displayLabel(x.label))}</th>`).join('')}<th>操作</th></tr></thead><tbody>${template[key].map((row,index)=>`<tr><td>${index+1}</td>${schema.fields.filter(x=>!x.key.startsWith('repoTerms.')).map(field=>`<td>${esc(valueText(field,read(row,field.key)))}${key==='securities'&&field.key==='label'?`<small>代码：${esc(row.securityId)}</small>`:''}</td>`).join('')}<td><button data-initial-edit="${key}" data-index="${index}">编辑</button> <button data-initial-delete="${key}" data-index="${index}">删除</button></td></tr>`).join('')||'<tr><td colspan="15" class="empty-record">暂无记录</td></tr>'}</tbody></table></div></section>`).join('')+termSection();
 }
 const termKinds={assets:'资产权重',liabilities:'负债权重',positiveRepos:'债券正回购调整'};
 function termSection(){const weights=template.termWeights;
  return `<section class="panel" id="term-weight-panel"><div class="section-head wrap"><h2>完整资产负债期限权重</h2><span>上限90天 · 权重日期 ${esc(weights?.asOfDate||'待补')}</span><button data-term-date>核对权重日期</button></div><div class="template-overview"><p>平均剩余期限＝（资产加权天数－负债加权天数＋正回购加权天数）÷（基金净值＋存续正回购本金）。现金为0天；正回购已列为负债时，在调整表按同额同期限列示。</p><p class="muted">完整表须覆盖全部资产与负债。修改现金、持仓或净资产后同步核对本表；一年按365天，期限均为填写天数。</p>${!weights?'<p class="warning">当前模板未提供完整期限权重，期限规则将显示待补。</p>':''}</div>`+
  Object.entries(termKinds).map(([key,title])=>`<div class="section-head"><h3>${title}</h3><span>${weights?.[key]?.length||0}条</span><button data-term-add="${key}">新增权重</button></div><div class="table-scroll"><table class="template-table"><thead><tr><th>项目</th><th>金额（亿元）</th><th>剩余天数</th><th>操作</th></tr></thead><tbody>${(weights?.[key]||[]).map((r,i)=>`<tr><td>${esc(displayLabel(r.label))}</td><td>${amount(r.amountYuan)}</td><td>${r.remainingTradingDays==null?'待补':r.remainingTradingDays}</td><td><button data-term-edit="${key}" data-index="${i}">编辑</button> <button data-term-delete="${key}" data-index="${i}">删除</button></td></tr>`).join('')||'<tr><td colspan="4" class="empty-record">无记录；空负债和正回购表表示确认为零，资产表须提供完整权重。</td></tr>'}</tbody></table></div>`).join('')+'</section>';
 }
 function termDateDialog(){openDialog('核对期限权重日期',`<p class="origin-note">日期应等于模板业务日。仅在已核对每项资产负债金额及剩余期限后更新；修改日期不自动滚动期限或交易事实。</p><form id="term-date-form"><label>权重日期<input type="date" name="asOfDate" required value="${escRaw(template.termWeights?.asOfDate||template.businessDate)}"></label><label class="checkline"><input type="checkbox" required>已核对完整权重对应此业务日</label>${formFooter('保存权重日期')}</form>`);$('term-date-form').onsubmit=e=>{e.preventDefault();try{if(!template.termWeights)throw new Error('请先新增完整期限权重。');const next=copy(template);next.termWeights.asOfDate=new FormData(e.target).get('asOfDate');persist(next);closeDialog();}catch(error){formError(error);}};}
 function editTerm(key,index=-1){const existing=template.termWeights?.[key]?.[index],row=existing||{label:'',amountYuan:null,remainingTradingDays:null,sourceHoldingId:null,sourceAccountCash:false},fields=[f('label','项目名称'),f('amountYuan','金额','money'),f('remainingTradingDays','剩余天数','integer'),...(key==='assets'?[f('sourceHoldingId','关联持仓（其他资产留空）','holding'),f('sourceAccountCash','关联基础账户现金','bool')]:[])];
  openDialog(`${existing?'编辑':'新增'} · ${termKinds[key]}`,`<p class="origin-note">只修改下次运行使用的模板。金额按亿元，期限按填写天数。完整权重应覆盖全部资产负债；本表和持仓明细是同一资产的不同视图，不相互重复累加。</p><form id="term-weight-form"><div class="form-grid">${fields.map(field=>input(field,row)).join('')}</div><label class="checkline"><input type="checkbox" required>已核对本项目属于当前模板的完整资产负债范围，未重复列示</label>${formFooter('保存期限权重')}</form>`);
  $('term-weight-form').onsubmit=e=>{e.preventDefault();try{const next=copy(template),fd=new FormData(e.target);next.termWeights??={version:'term-weights-1',coverage:'complete',calendar:template.demoMode==='single-day-principal-v1'?'day-365-demo-v1':'weekday-252-demo-v1',asOfDate:template.businessDate,assets:[],liabilities:[],positiveRepos:[]};const item=existing?copy(existing):{weightId:`weight-${crypto.randomUUID()}`};for(const field of fields)item[field.key]=parse(field,fd.get(field.key),read(row,field.key));if(index<0)next.termWeights[key].push(item);else next.termWeights[key][index]=item;persist(next);closeDialog();}catch(error){formError(error);}};
 }
 function historyDialog(){const rows=history();openDialog('已保留的运行副本',`<p>恢复时先保存当前副本。历史交易及来源编号保留；下达权限需刷新、重算和重新审核。</p>${rows.map(x=>`<div class="history-item"><span><b>${esc(displayLabel(x.label))}</b><small>业务日 ${esc(x.businessDate)} · 保存于 ${esc(new Date(x.time).toLocaleString('zh-CN'))}</small></span><button data-restore-run="${escRaw(x.id)}">恢复此运行</button></div>`).join('')||'<p>尚无历史，新建运行时会自动保留当前副本。</p>'}`);}
 function cashDialog(sourceId){const row=model.getState().summary.settlementRows.find(x=>x.sourceId===sourceId);if(!row)return;
  openDialog(row.direction==='inflow'?'确认整笔到账':'确认整笔付款',`<p>${esc(displayLabel(row.label))} · 尚待${direction[row.direction]} ${amount(row.remainingYuan)}亿。确认后整笔记录实际收付；各笔到期款独立处理。</p><form id="cash-source-form">${formFooter('确认整笔收付')}</form>`);const eventId=`cash-${crypto.randomUUID()}`;
  $('cash-source-form').onsubmit=e=>{e.preventDefault();try{model.recordCashEvent({eventId,sourceId,amountYuan:row.remainingYuan});closeDialog();changed('整笔实际收付已记录；业务头寸与账户现金分别核对。');}catch(error){formError(error);}};
 }
 document.addEventListener('click',e=>{try{if(e.target.closest('[data-term-date]')){termDateDialog();return;}const termAdd=e.target.closest('[data-term-add]'),termEdit=e.target.closest('[data-term-edit]'),termDelete=e.target.closest('[data-term-delete]');if(termAdd){editTerm(termAdd.dataset.termAdd);return;}if(termEdit){editTerm(termEdit.dataset.termEdit,Number(termEdit.dataset.index));return;}if(termDelete){const next=copy(template);next.termWeights[termDelete.dataset.termDelete].splice(Number(termDelete.dataset.index),1);persist(next);return;}const a=e.target.closest('[data-initial]'),add=e.target.closest('[data-initial-add]'),edit=e.target.closest('[data-initial-edit]'),remove=e.target.closest('[data-initial-delete]'),restore=e.target.closest('[data-restore-run]'),cash=e.target.closest('[data-cash-source]');
  if(add)editRow(add.dataset.initialAdd,-1);if(edit)editRow(edit.dataset.initialEdit,Number(edit.dataset.index));if(cash)cashDialog(cash.dataset.cashSource);
  if(remove){const next=copy(template);next[remove.dataset.initialDelete].splice(Number(remove.dataset.index),1);persist(next);}
  if(restore){const saved=history().find(x=>x.id===restore.dataset.restoreRun);if(!saved)throw new Error('未找到运行副本');preserve();model.load(saved.state);closeDialog();setScreen('desk');changed('已恢复历史运行；请刷新并重新计算审核。');}
  if(a){switch(a.dataset.initial){case 'base':editBase();break;case 'begin':begin();break;case 'history':historyDialog();break;
   case 'sample':case 'original-sample':case 'remediation-sample':switchPreset(a.dataset.initial);break;
   case 'export':{const url=URL.createObjectURL(new Blob([JSON.stringify(template,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='智汇现金-初始模板.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);break;}
   case 'import':{openDialog('导入默认模板',`<p>校验后替换默认模板，不覆盖当前运行。文件应由“导出默认模板”生成；运行存档请在“数据与存储”中导入。</p><input type="file" id="initial-import" accept=".json,application/json"><div id="form-error" class="form-error"></div>`);$('initial-import').onchange=async event=>{try{const file=event.target.files[0],epoch=storage.generation;if(!file)return;if(file.size>2e6)throw new Error('模板超过2MB');const text=await file.text();if(epoch!==storage.generation)throw new Error('账号状态已变化，未导入模板。');persist(normalizeInitialTemplate(JSON.parse(text)));closeDialog();}catch(error){formError(error);}};break;}
  }}
 }catch(error){formError(error);}});
 return {renderPage,preserve,resetToDefault(){begin(createDefaultInitialTemplate(),{replaceTemplate:true,presetLabel:presets['remediation-sample'].label});},template:()=>copy(template),reloadStorage,replaceTemplate(value){template=normalizeInitialTemplate(value);loadWarning='';},resetStorage(){template=createDefaultInitialTemplate();loadWarning='';}};
}

// Trade-date totals deliberately differ from settlement-date cash breakdowns.
export function renderCashDashboard(s,{amount,esc,escRaw=esc}){
 const today=s.context.businessDate,q=s.summary,original=q.openingTradeBalances||[],balances=new Map(q.planBalances.map(x=>[x.planId,x]));
 const sum=rows=>rows.some(v=>v==null)?null:rows.reduce((a,b)=>a+b,0);
 const dateOf=p=>p.settlementDate||today;
 const tradeTotal=(dir,completed)=>sum([...s.plans.filter(p=>(p.tradeDate||today)===today&&p.direction===dir).map(p=>completed?balances.get(p.planId).filledYuan:p.targetYuan),...original.filter(x=>x.tradeDate===today&&x.direction===dir).map(x=>x.amountYuan)]);
 const project=q.projectedEndOfDayYuan,end=typeof project==='object'?project?.balanceYuan:project;
 const metric=(title,value,note,scope='')=>`<div class="cash-metric ${scope?'cash-'+scope:''}" ${scope?'data-cash-scope="'+scope+'"':''}><span>${title}${scope?'<b class="cash-scope-label">'+({business:'下达口径',account:'付款口径',projection:'假设投影'}[scope])+'</b>':''}</span><strong>${value}<small>亿</small></strong><em>${note}</em></div>`;
 const first=(s.initialData?.demoMode==='single-day-principal-v1'?[metric('日初业务可用',amount(q.openingBusinessAvailableYuan),'含日初净申赎及当日到期'),metric('计划流入 / 流出',`${amount(tradeTotal('inflow',false))} / ${amount(tradeTotal('outflow',false))}`,'全部当日计划'),metric('已成交流入 / 流出',`${amount(tradeTotal('inflow',true))} / ${amount(tradeTotal('outflow',true))}`,'已成交名义'),metric('实时业务可用',amount(q.availableYuan),'含当日到期及已成交待收款','business'),metric('预计日终',amount(end),'全部目标均成交并收付；不表示当前可执行','projection'),metric('实际账户现金',amount(q.accountCashYuan??q.settledBalanceYuan),'实际付款受已到账余额约束','account')]:[metric('T0日初可用',amount(q.openingBusinessAvailableYuan),'账户现金＋当日待收付到期净额'),metric('T0计划交易',`${amount(tradeTotal('inflow',false))} / ${amount(tradeTotal('outflow',false))}`,'流入 / 流出 · 按交易日'),metric('T0完成交易',`${amount(tradeTotal('inflow',true))} / ${amount(tradeTotal('outflow',true))}`,'流入 / 流出 · 已成交名义'),metric('T0实时可用',amount(q.availableYuan),'已扣今日用款占用与应付','business'),metric('预计日终',amount(end),`${end<0?'缺口 '+amount(-end)+'亿 · ':''}假设当日计划成交且收付完成`,'projection'),metric('实际账户现金',amount(q.accountCashYuan??q.settledBalanceYuan),'付款须受此余额约束','account')]).join('');
 const totals=(types,dir,dateKind)=>{
  const plans=s.plans.filter(p=>types.includes(p.businessType)&&(!dir||p.direction===dir)&&(dateKind==='trade'?(p.tradeDate||today):dateOf(p))===today),old=dateKind==='settle'?original.filter(x=>x.kind==='secondary_security_trade'&&types.includes(x.businessType)&&x.settlementDate===today):[];
  return [sum([...plans.map(p=>p.targetYuan),...old.map(x=>x.amountYuan)]),sum([...plans.map(p=>balances.get(p.planId).filledYuan),...old.map(x=>x.amountYuan)])];
 };
 const pair=(types,dir,dateKind)=>totals(types,dir,dateKind).reverse().map(amount).join(' / ');
 const repoCard=(title,positive,reverse)=>`<div><span>${title}</span><strong class="repo-total">正 ${pair(positive,'inflow','trade')}<small>亿</small></strong><strong class="repo-total">逆 ${pair(reverse,'outflow','trade')}<small>亿</small></strong><em>已成交 / 计划</em></div>`;
 const second=[repoCard('银行间回购',['interbank_repo_financing'],['reverse_repo']),repoCard('交易所回购',['exchange_repo_financing'],['exchange_repo_lending']),metric('银行存款',pair(['deposit'],'outflow','trade'),'已成交 / 计划'),metric('现券买入',pair(['cd_buy','bond_buy'],'outflow','settle'),'已成交 / 计划'),metric('现券卖出',pair(['cd_sell','bond_sell'],'inflow','settle'),'已成交 / 计划')];
 const cd=original.filter(x=>x.kind==='primary_cd_subscription'&&x.settlementDate===today);second.push(metric('一级存单待缴款',amount(sum(cd.map(x=>x.remainingYuan))),`已确认 ${amount(sum(cd.map(x=>x.amountYuan)))}亿 · 只安排缴款`));
 const maturities=(q.settlementRows||[]).filter(x=>Object.hasOwn(cashKinds,x.kind)&&x.settlementDate===today);
 const net=rows=>sum(rows.map(x=>x.amountYuan==null?null:(x.direction==='inflow'?1:-1)*x.amountYuan));
 const netSubscriptions=s.initialData?.portfolio?.netSubscriptionYuan??0;
 second.push(`<div><span>当日到期 / 净申赎</span><strong>${amount(net(maturities)==null?null:net(maturities)+netSubscriptions)}<small>亿</small></strong><em>正数为净流入 · 净申赎已到账</em><details class="cash-breakdown"><summary>分项净额</summary>${Object.entries(cashKinds).map(([kind,label])=>`<p>${label}：${amount(net(maturities.filter(x=>x.kind===kind)))}亿</p>`).join('')}<p>净申赎：${amount(netSubscriptions)}亿</p><button data-screen="execution">查看实际收付</button></details></div>`);
 const openingIds=new Set([...(s.initialData?.maturityCashEvents||[]).map(x=>x.eventId),...(s.initialData?.pendingSettlements||[]).map(x=>x.tradeId)]);
 const pending=(q.settlementRows||[]).filter(row=>openingIds.has(row.sourceId)).map(row=>`<tr><td><b>${esc(displayLabel(row.label))}</b><small>${esc(cashKinds[row.kind]||tradeKinds[row.kind]||'既有现金事件')}</small></td><td>${row.tradeDate?esc(row.tradeDate):'—'}<small>当日收付</small></td><td>${direction[row.direction]}</td><td class="num">${amount(row.amountYuan)}</td><td class="num">${amount(row.settledYuan)}</td><td class="num">${amount(row.remainingYuan)}</td><td>${row.remainingYuan===0?(row.direction==='inflow'?'已回款':'已付款'):row.remainingYuan==null?'金额待补':row.direction==='outflow'&&q.accountCashYuan<row.remainingYuan?'实际现金不足，待整笔付款':row.direction==='inflow'?'未回款':'未付款'}</td><td><button data-cash-source="${escRaw(row.sourceId)}" ${row.remainingYuan===0||row.remainingYuan==null||row.settlementDate>today||row.direction==='outflow'&&q.accountCashYuan<row.remainingYuan?'disabled':''}>${row.direction==='inflow'?'确认整笔回款':'确认整笔付款'}</button></td></tr>`).join('');
 return {first,second:second.join(''),pending:pending||'<tr><td colspan="8" class="empty-record">此运行无期初收付事件，可在初始数据页维护并新建运行。</td></tr>'};
}

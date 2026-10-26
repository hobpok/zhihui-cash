import {createModel, validateSaved, deriveExecutionOrderDependencies} from './model.js';
import {metricPresentation,completionPercent} from './metric-display.js';
import {BUSINESS_TYPES, BUSINESS_DIRECTIONS, isFinancing, isExchangeRepo} from './business.js';
import {deriveTemplateExposure,bankDepositLimitBps} from './initial-data.js';
import {setupInitialUI, renderCashDashboard} from './initial-ui.js';
import {setupCoreUI, CORE_RULE_NAMES} from './c-ui.js';
import {setupAnalysisUI} from './analysis-ui.js';
import {displayLabel, displayText, automaticInstructionLabel, preserveLabel, displayTermsNote, preserveTermsNote} from './display-labels.js';
import {createWorkspaceStorage,setupWorkspaceUI} from './workspace-ui.js';
import {setupAiUI} from './ai-ui.js';
import {createCalculationController} from './calculation-controller.js';
import {renderExecutionOrderHints} from './execution-order-ui.js';
import {setupRemediationUI} from './remediation-ui.js';

const $ = id => document.getElementById(id);
const escRaw = v => String(v ?? '待补').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const esc = v => escRaw(displayText(v));
const decimalYuan = n => {const value=BigInt(n),abs=value<0n?-value:value;const fraction=(abs%100000000n).toString().padStart(8,'0').replace(/0+$/,'');return `${value<0n?'-':''}${abs/100000000n}${fraction?'.'+fraction:''}`;};
const amount = n => {if(n==null)return '待补';const [integer,fraction='']=decimalYuan(n).split('.');return integer.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+fraction.padEnd(2,'0');};
const types = Object.fromEntries(Object.entries(BUSINESS_TYPES).map(([k,v])=>[k,v.label]));
Object.assign(types,{cd_buy:'现券买入（存单）',cd_sell:'现券卖出（存单）',bond_buy:'现券买入（其他）',bond_sell:'现券卖出（其他）'});
const marketNames={INTERBANK:'银行间',SSE:'上交所',SZSE:'深交所'};
const prefNames = {settlement_safety:'资金可用与交收安全',fewer_warnings:'减少预警',metric_headroom:'保留指标余量（正式口径待补）',reverse_repo_first:'融券下单优先',liquidity_last:'平头寸优先'};
const businessPreferenceKeys = ['reverse_repo_first','liquidity_last'];
const sortingMode = s => s.preferences.orderedKeys.find(k=>businessPreferenceKeys.includes(k)) || 'AUTO';
const ratioPercent = r => {const [w,f='']=r.split('.');const n=(BigInt(w)*1000000000000n+BigInt(f.padEnd(12,'0')))*100n;const frac=(n%1000000000000n).toString().padStart(12,'0').replace(/0+$/,'');return (n/1000000000000n).toString()+(frac?'.'+frac:'');};
const tag = (tone,text) => `<span class="tag ${tone}">${esc(text)}</span>`;
const model = createModel();
let calculationController = null;
let remediationUI = null;
let calculationTick = null;
let calculationStartedAt = 0;
let calculationLastProgress = null;
const ruleKinds={calculation:'计算定义',hard_gate:'硬闸门草案',hard_constraint:'已定义硬约束',soft_warning:'观察预警',warning:'软预警',protocol:'执行协议',state_invariant:'状态不变量'};
const runs = new Map();
const activity = new Map();
const storageKey = id => `zhihui-simulator-${id}`;
let screen='desk', selectedPlan=null, records=[], rules=[], lastFocus=null, toastTimer;
let recordSourceKey=null,recordFilterKey=null,recordSearchText=new WeakMap();
let dirty=false;
let skipReview=false,skipReviewRun=null;
const executionSelection=new Set();
let workspace=null;
let aiUI=null;
const localStore=createWorkspaceStorage();
const expandedGroups = new Set();
const initialUI=setupInitialUI({model,$,esc,escRaw,amount,decimalYuan,ratioPercent,parseMoney,parseAnnualRate,openDialog,closeDialog,formFooter,formError,changed,notify,render,setScreen:value=>screen=value,storage:localStore,onTemplateChange:value=>workspace?.stageTemplate(value)});
let displayEntities={};

// Display names only: identifiers in the model, saved data and DOM actions stay unchanged.
const scenarioNames={S13:'五业务完整计划',S10:'10亿分次完成'};
const objectNames={'BANK-A':'A银行','BANK-B':'B银行','BANK-C':'C银行','ISSUER-C':'C发行人','S10-CP-01':'示例回购对手'};
const objectName=id=>displayEntities[id]||objectNames[id]||id||'待补';

const shortRuleNames={...CORE_RULE_NAMES,'DEMO-SETTLEMENT-01':'交收日期预算','DEMO-CASH-01':'资金可用检查','DEMO-EXP-01':'A银行存款投前限制','DEMO-WARN-01':'A银行集中度观察线','DEMO-REPO-TERMS':'回购交易参数','DEMO-REPO-QUOTA':'融资额度检查','DEMO-REPO-PLEDGE':'质押能力检查','DEMO-EXCHANGE-WINDOW':'交易所申报时段'};
const ruleName=id=>shortRuleNames[id]||rules.find(r=>r.ruleId===id)?.name||'未命名规则';
const resultNames={pass:'通过',warn:'预警',block:'阻断',missing:'待补',not_applicable:'不适用',waiting_conditions:'等待资金',open:'时段开放',closed:'时段关闭'};
const resultName=value=>resultNames[value]||'结果待核实';
const resultTone=value=>({waiting_conditions:'wait',not_applicable:'neutral',open:'pass',closed:'block'}[value]||(['pass','warn','block','missing'].includes(value)?value:'missing'));
const eventNames={send:'手动下达',cancel_request:'申请撤改',event:'投管回报',accepted:'确认接收',rejected:'明确拒绝且无占用',fill:'成交回报',cash_settled:'结算确认',cash_available:'资金已可用',cancel_confirmed:'撤改证据',cancel_failed:'撤改失败'};
const qualityNames={fresh:'数据已刷新',stale:'数据已过期',gap:'回报序号有缺口',demo_seed:'日初数据',illustrative_local_lock:'已锁定',illustrative_unknown:'发送结果未知',illustrative_accepted:'投管已接收',illustrative_cancel_pending:'撤改待确认',illustrative_fill:'已成交',illustrative_settled:'已结算',illustrative_cash_available:'资金已可用'};
const scopeNames={...types,all_cash_consuming:'所有用款交易',external_funding:'独立资金到账','deposit:A':'A银行存款','portfolio:A_monitor':'A银行敞口监测',all_instructions:'所有指令',all_events:'所有回报',outflow_fill:'用款交易成交',cancel_confirmed:'撤改确认',dependent_actions:'依赖相关数据的交易',all_plans:'所有计划',complete_candidates:'完整候选方案',search_result:'搜索结果'};
const evaluationNames={projection:'资金预演',before_send:'下达前',cash_available:'资金可用确认',fill:'成交确认',cash_settled:'结算确认',before_deposit:'存款交易前',after_projection:'交易预演后',proposal:'生成建议',prepareDispatch:'准备下达',dispatch:'手动下达',receiveEvent:'接收回报',loadRun:'恢复存档',approve:'经理审核',calculate:'计算方案',updatePlan:'修改计划',rank:'候选排序'};
function planName(s,id){return displayLabel(s.plans.find(p=>p.planId===id)?.label)||'关联交易';}
function planNumber(s,id){const n=s.plans.findIndex(p=>p.planId===id);return n<0?'关联计划':`计划${n+1}`;}
function planSummary(s,id){
 const p=s.plans.find(p=>p.planId===id);
 const security=s.initialData?.securities?.find(item=>item.securityId===p?.securityId);
 const object=p?.issuerId?objectName(p.issuerId):p?.counterpartyId?objectName(p.counterpartyId):
  p?.repoTerms?.market?marketNames[p.repoTerms.market]||p.repoTerms.market:
  security?displayLabel(security.label):'对象待补';
 return [planNumber(s,id),types[p?.businessType],object].filter(Boolean).join(' · ');
}
function stepName(s,step){const id=typeof step==='string'?step:step?.stepId;const list=s.proposal?.steps||[];const n=list.findIndex(st=>st.stepId===id);const st=typeof step==='string'?list[n]:step;return `${n<0?'交易步骤':`第${n+1}步`} · ${planName(s,st?.planId)}`;}
function instructionName(s,i){const n=Object.keys(s.execution?.instructions||{}).indexOf(i.instructionId);return `${n<0?'已下达指令':`指令${n+1}`} · ${planName(s,i.planId)}`;}
function technicalDetails(fields){return `<details class="technical-details"><summary>查看编号与来源记录</summary>${Object.entries(fields).map(([k,v])=>`<div><b>${esc(k)}</b><pre>${esc(typeof v==='string'?v:JSON.stringify(v,null,2))}</pre></div>`).join('')}</details>`;}
function readableText(s,value){
 const names=new Map(Object.entries({...marketNames,...objectNames,...displayEntities,bankExposureYuan:'A银行初始敞口',navYuan:'净资产',issuerId:'发行人',bankId:'存款银行',cash_available:'资金可用确认'}));
 for(const r of rules)names.set(r.ruleId,ruleName(r.ruleId));
 for(const [id,name] of Object.entries(shortRuleNames))names.set(id,name);
 for(const p of s.plans)names.set(p.planId,`${planName(s,p.planId)}（${planNumber(s,p.planId)}）`);
 for(const item of [...s.plans,...(s.initialData?.banks||[]),...(s.initialData?.securities||[])])
  if(item.label&&displayLabel(item.label)!==item.label)names.set(item.label,displayLabel(item.label));
 for(const st of s.proposal?.steps||[])names.set(st.stepId,stepName(s,st));
 for(const i of Object.values(s.execution?.instructions||{}))names.set(i.instructionId,instructionName(s,i));
 const pattern=[...names.keys()].sort((a,b)=>b.length-a.length).map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
 return String(value??'').replace(new RegExp(pattern,'g'),id=>names.get(id)).replace(/(-?\d+)元/g,(_,digits)=>{const n=Number(digits);return Number.isSafeInteger(n)&&Math.abs(n)>=100000000?`${decimalYuan(n)}亿元`:`${Number.isSafeInteger(n)?n.toLocaleString('zh-CN'):digits}元`;}).replace(/banks\.([^.]+)\.(custodyQualified|ratingAsOf|rating|quarterEnd|quarterlyNetAssetsYuan|depositLimitBps)/g,(_,id,key)=>`${objectName(id)}${({custodyQualified:'托管资格',ratingAsOf:'评级日期',rating:'评级',quarterEnd:'季度末日期',quarterlyNetAssetsYuan:'季度净资产',depositLimitBps:'公司新增存款闸门'})[key]}`).replace(/otherFundBankExposure\.([^，、；\s]+)/g,(_,id)=>`${objectName(id)}的公司其他货基敞口`).replace(/termWeights\.([\w.-]+)/g,(_,key)=>`期限权重${key}`).replace(/dateBalances\.availableYuan/g,'当日业务头寸');
}
function conditionText(s,st){
 if(!st.machineConditions?.length)return st.condition==null?'无额外顺序条件；仍须最新校验':readableText(s,typeof st.condition==='string'?st.condition:'有额外条件，请查看原始记录');
 return st.machineConditions.map(c=>{
  const plan=`${planName(s,c.planId)}（${planNumber(s,c.planId)}）`,money=c.minimumYuan==null?'待补':`${amount(c.minimumYuan)}亿`,market=marketNames[c.market]||'对应市场';
  switch(c.kind){
   case 'previous_confirmed':return `${stepName(s,c.stepId)}须完成成交并反映占用`;
   case 'cash_available':return `下达前确认可用资金至少${money}`;
   case 'settlement_capacity':return `${c.valueDate}及后续已确认收付的累计预算可覆盖${money}`;
   case 'funds_available':return s.initialData?.demoMode==='single-day-principal-v1'&&(isFinancing(s.plans.find(p=>p.planId===c.planId)?.businessType)||['cd_sell','bond_sell'].includes(s.plans.find(p=>p.planId===c.planId)?.businessType))?`${plan}累计成交至少${money}`:`${plan}累计可用到账至少${money}`;
   case 'quota_confirmed':return `${market}确认剩余融资额度至少${money}`;
   case 'pledge_confirmed':return `${market}确认剩余质押能力至少${money}`;
   case 'exchange_window_open':return `${market}回购申报时段开放`;
   case 'filled':return `${plan}累计成交至少${money}`;
   case 'payable_cleared':return `${plan}对应应付已结清`;
   case 'holding_confirmed':return `${plan}持仓及可卖量须核实`;
   case 'sale_cash_available':return `${plan}卖券回款须全额确认可用`;
   default:return '其他前置条件待核对（见原始记录）';
  }
 }).join('；')+'；下达前仍须复核最新现金与规则';
}
function ruleScope(r){return r.appliesTo.map(k=>scopeNames[k]||'其他适用范围').join(' / ');}
function ruleSource(r){return r.sourceRef?.startsWith('docs/design/')?'设计资料':r.sourceRef?.split('/').pop()?.split('#')[0]?.replace(/\.md$/,'')||'业务资料';}
function ruleEffect(r){return r.effect.replaceAll('missing','待补数据').replaceAll('proven_infeasible','判定不可行').replaceAll('r与p可不同','成交前保留金额与成交后应付金额可不同');}

function notify(message){$('toast').textContent=displayText(message);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
function log(message){const id=model.getState().scenarioId;const entries=activity.get(id)||[];entries.unshift({time:new Date().toLocaleTimeString('zh-CN'),message});activity.set(id,entries.slice(0,50));}
function changed(message){remediationUI?.reset();calculationController?.cancel(true);hideCalculationProgress();clearCalculationOutcome();dirty=true;log(message);workspace?.stageCurrent(/成交|到账|收付|下达|撤改/.test(message||''));render();workspace?.refreshStatus();if(message)notify(message);}
function clearCalculationOutcome(){$('calculation-outcome').hidden=true;$('calculation-outcome').textContent='';}
function showCalculationOutcome(kind){
 const p=model.getState().proposal;
 const previous=p?`当前仍显示上次建议（版本 ${p.version??'待核'}，${p.pathId==='AUTO'?'自动排序':p.pathId||'原路径'}）。`:'当前没有新建议。';
 $('calculation-outcome').textContent=`本次计算${kind}，未写入新建议。${previous}需要新结果请重新计算。`;
 $('calculation-outcome').hidden=false;
}
function paintCalculationProgress(){
 const p=calculationLastProgress||{stage:'启动计算',nodes:0,candidates:0};
 const elapsed=Math.max(0,Math.floor((performance.now()-calculationStartedAt)/1000));
 $('calculation-progress-text').textContent=`${p.stage} · 已搜索 ${p.nodes??0} 个节点、评估 ${p.candidates??0} 个候选 · 用时 ${elapsed} 秒`;
}
function setCalculationBusy(busy){
 document.querySelectorAll('[data-action="preview"],[data-action="review"],[data-action="send"],[data-action="send-batch"],[data-sort],[data-path]').forEach(button=>{button.disabled=busy;});
}
function hideCalculationProgress(){clearInterval(calculationTick);calculationTick=null;$('calculation-live-progress').hidden=true;setCalculationBusy(false);}
calculationController=createCalculationController({model,
 onProgress(progress){
  if (!calculationTick) {calculationStartedAt=performance.now();calculationTick=setInterval(paintCalculationProgress,250);}
  calculationLastProgress=progress;$('calculation-live-progress').hidden=false;setCalculationBusy(true);paintCalculationProgress();
 },
 onComplete(message){hideCalculationProgress();changed(message);void remediationUI?.inspect();},
 onError(message){hideCalculationProgress();render();showCalculationOutcome('失败');notify(message);},
 onCancel(){hideCalculationProgress();render();showCalculationOutcome('已取消');notify('计算已取消，当前运行未写入新建议。');}
});
function runCalculation(pathId='AUTO',message='已按当前输入重新计算；解释及资金投影见下表。'){
 remediationUI?.reset();
 clearTimeout(toastTimer);$('toast').hidden=true;
 clearCalculationOutcome();
 calculationController.start(pathId,message);
}
remediationUI=setupRemediationUI({model,root:$('remediation-panel'),changed});
function openDialog(title,body){lastFocus=document.activeElement;$('dialog-title').textContent=displayText(title);$('dialog-body').innerHTML=body;$('dialog').showModal();}
function closeDialog(){$('dialog').close();}
$('close-dialog').addEventListener('click',closeDialog);
$('dialog').addEventListener('close',()=>{if(lastFocus?.isConnected)lastFocus.focus();});
function formError(error){const box=$('form-error');if(box)box.textContent=displayText(error.message||String(error));else notify(error.message||String(error));}
function totals(s){const ids=new Set(s.plans.filter(p=>p.direction==='outflow').map(p=>p.planId));const bs=s.summary.planBalances.filter(p=>ids.has(p.planId));return {target:bs.reduce((a,b)=>a+b.targetYuan,0),filled:bs.reduce((a,b)=>a+b.filledYuan,0),locked:bs.reduce((a,b)=>a+b.lockedYuan,0),remaining:bs.reduce((a,b)=>a+b.remainingYuan,0),inflow:s.plans.filter(p=>p.direction==='inflow'&&!isFinancing(p.businessType)).reduce((a,p)=>a+p.targetYuan,0),financing:s.plans.filter(p=>isFinancing(p.businessType)).reduce((a,p)=>a+p.targetYuan,0)};}
function isPreset(s){return s.proposal?.origin==='calculated';}
function legacyPath(s){return null;}
function approvalText(s){if(skipReview)return '跳过人工审核 · 下达仍校验';if(s.approval?.authoritySource==='calculated_skip_review')return '此前跳过人工审核 · 当前需人工审核';return {none:'待审核',valid:'已审核',stale:'内容已变更 · 需重新审核'}[s.approvalStatus]||'待审核';}
function stepState(s,st){
 if(st.blocked)return '硬阻断';
 const instruction=Object.values(s.execution?.instructions||{}).find(i=>i.stepId===st.stepId&&i.approvalId===s.approval?.approvalId);
 if(instruction)return instructionStatus(instruction);
 if(s.approvalStatus!=='valid')return approvalText(s);
 const gate=(s.batchReadiness||s.stepReadiness)?.find?.(g=>g.stepId===st.stepId);
 return gate?(gate.ready?'已审核可下达':readableText(s,gate.reason)||'已审核待条件'):'已审核 · 下达前复核';
}
function creditedCash(s,i){return Object.values(s.execution?.cashFlows||{}).filter(f=>f.type==='cash_available'&&f.instructionId===i.instructionId).reduce((n,f)=>n+f.amountYuan,0);}
function instructionStatus(i,s=model.getState()){if(i.cancelledYuan===i.nominalYuan)return '已全部撤回';if(i.direction==='inflow'&&i.filledYuan>0){const credited=creditedCash(s,i);if(credited===i.filledYuan)return '已到账可用';if(credited>0)return '部分到账 · 余款待确认';if(i.settledYuan===i.filledYuan)return '已结算 · 未确认到账';return '已成交 · 未确认到账';}if(i.filledYuan>0&&i.settledYuan===i.filledYuan&&i.filledYuan+i.cancelledYuan===i.nominalYuan)return '已结算';return instructionLabels[i.status]||i.status;}
const instructionLabels={sending:'发送中',unknown:'发送结果未知',accepted:'投管已接收',rejected:'已拒绝',partial:'部分成交',partially_filled:'部分成交',filled:'已成交待结算',settled:'已结算',cancel_pending:'撤改待确认',cancelled:'已撤回',not_sent:'未发送'};

const coreUI=setupCoreUI({model,$,esc,escRaw,amount,decimalYuan,parseMoney,getSkipReview:()=>skipReview,tag,resultName,resultTone,readableText,stepName,openDialog,closeDialog,formError,formFooter,changed,render,setScreen:value=>screen=value});

const analysisUI=setupAnalysisUI({model,$,esc,escRaw,openDialog,closeDialog,notify,render});


function help(label,text){return `<button type="button" class="help-trigger" data-help="${escRaw(text)}" aria-label="${esc(label)}说明" aria-describedby="help-popover">?</button>`;}
function progressBar(b){const percent=completionPercent(b.filledYuan,b.targetYuan),display=percent==null?'—':percent.toFixed(1).replace(/\.0$/,'')+'%';return `<div class="trade-progress" aria-label="成交完成进度 ${esc(display)}"><span>${display}</span><progress max="100" value="${percent??0}">${display}</progress></div>`;}
const bankScopeNames={C03:'存款及存单',C04:'存款及存单',C05:'公司货基敞口',C06:'全部金融工具',C07:'BB类基金敞口',C08:'BB类银行敞口'};
const isDepositGate=r=>r.ruleId==='C05-DEPOSIT';
const depositGateRate=(row,bank)=>row.threshold?.denominator?row.threshold.numerator/row.threshold.denominator*100:bankDepositLimitBps(bank)/100;
function renderFacts(s,t,q){
 const inp=s.inputs||{},rows=s.coreRules?.rows||[],simple=s.initialData?.demoMode==='single-day-principal-v1';
 const expandedFacts=new Set([...$('facts').querySelectorAll('details[open][data-facts-open]')].map(el=>el.dataset.factsOpen));
 const fact=(label,value,note='',tone='normal')=>`<div><dt>${esc(label)}${note?help(label,note):''}</dt><dd class="metric-${tone}">${value}</dd></div>`;
 const cash=rows.find(r=>r.ruleId==='C02'),term=rows.find(r=>r.ruleId==='C09');
 let html=fact('净资产',`${amount(inp.navYuan)} 亿`);
 if(s.coreRules?.enabled){html+=fact('现金比例',`${esc(coreUI.value(cash||{},'currentValue',s))} / 5%`, '当前现金及一年内政府债占基金净资产比例，5%为下限；5%～6%为黄色，低于5%红色。成交融资及卖券按业务口径计量，到账不重复计入。',metricPresentation(cash).tone);
 html+=fact('平均剩余期限',`${esc(coreUI.value(term||{},'currentValue',s))} / 90${simple?'天':'交易日'}`,'按完整资产负债权重计算，仅此项分母加入存续正回购。显示舍入不参与是否超限的判断。',metricPresentation(term).tone);}
 html+='<div class="facts-extra"><dt>资金与输入明细</dt><dd><details data-facts-open="funds"><summary>查看现金构成与融资到账</summary><dl>';
 html+=fact(simple?'安全垫':'费用 / 安全垫',simple?`${amount(inp.bufferYuan)} 亿`:`${amount(inp.feeYuan)} / ${amount(inp.bufferYuan)} 亿`);
 html+=fact('一年内政府债',`${amount(q.cashRatioBasis?.governmentBondWithinYearYuan)} 亿`,'计入现金比例分子；当前单日模式一年以内按365天展示。');
 html+=fact('现金比例现金基数',`${amount(q.cashRatioBasis?.businessCashYuan)} 亿`,'业务头寸与实际账户现金分开。实际付款始终核验已到账账户现金。');
 html+=fact('融资意向 / 已借本金',`${amount(t.financing)} / ${amount(q.financingPrincipalYuan??0)} 亿`);
 const fi=Object.values(s.execution.instructions).filter(i=>isFinancing(i.businessType)),credited=fi.reduce((n,i)=>n+creditedCash(s,i),0);
 html+=fact('融资已到账 / 待到账',`${amount(credited)} / ${amount((q.financingPrincipalYuan??0)-credited)} 亿`,'融资成交已计业务头寸及比例；到账只增加实际账户，不再次增加业务头寸。');
 html+=fact('卖券已成交待到账',`${amount(q.saleUncreditedYuan??0)} 亿`,'卖券成交即计业务头寸和现金比例；到账不重复计入。');
 html+='</dl></details></dd></div>';
 if(s.coreRules?.enabled){
  html+='<div class="facts-divider"><dt>银行敞口</dt><dd>'+help('银行敞口','同一银行的存款存单、全部金融工具及公司货基规则分子分母不同，逐条展示，不能合并成一个上限。买入下达预占，卖出成交释放。比例距离上限1个百分点以内为黄色，超过上限红色。')+'</dd></div>';
  const involved=new Set(s.plans.flatMap(p=>[p.issuerId,p.counterpartyId]).filter(Boolean));
  const rankBank=bank=>{const relevant=rows.filter(r=>r.subjectId===bank.bankId&&(bankScopeNames[r.ruleId]||isDepositGate(r))&&(r.result!=='not_applicable'||isDepositGate(r)));return Math.min(4,...relevant.map(r=>({over:0,missing:1,near:2,normal:3}[metricPresentation(r).tone]??4)));};
  const orderedBanks=s.initialData.banks.filter(bank=>rows.some(r=>r.subjectId===bank.bankId&&(bankScopeNames[r.ruleId]||isDepositGate(r))&&(r.result!=='not_applicable'||isDepositGate(r)))).sort((a,b)=>rankBank(a)-rankBank(b)||Number(involved.has(b.bankId))-Number(involved.has(a.bankId)));
  const visibleBanks=Math.max(3,orderedBanks.filter(bank=>rankBank(bank)<2).length);
  for(const [bankIndex,bank] of orderedBanks.entries()){
   if(bankIndex===visibleBanks)html+=`<div class="facts-other-banks"><dt>其他银行</dt><dd><details data-facts-open="other-banks"><summary>查看其余 ${orderedBanks.length-visibleBanks} 家银行</summary>`;
   const active=rows.filter(r=>r.subjectId===bank.bankId&&bankScopeNames[r.ruleId]&&r.result!=='not_applicable');
   const depositGates=rows.filter(r=>r.subjectId===bank.bankId&&isDepositGate(r));
   active.push(...depositGates);
   if(!active.length)continue;
   const scored=active.map(r=>({r,view:metricPresentation(r)})).sort((a,b)=>({over:0,missing:1,near:2,normal:3}[a.view.tone]??4)-({over:0,missing:1,near:2,normal:3}[b.view.tone]??4));
   const worst=scored[0],r=worst.r,scope=isDepositGate(r)?`新增存款${depositGateRate(r,bank)}%余量`:bankScopeNames[r.ruleId];
   const summary=isDepositGate(r)?`${amount(r.headroomYuan)} 亿余量`:`${coreUI.value(r,'currentValue',s)} / ${coreUI.threshold(r,s).replace(/^[≤≥]/,'')}`;
   html+=`<div class="bank-fact"><dt>${esc(displayLabel(bank.label))}</dt><dd><details data-facts-open="${escRaw(bank.bankId)}"><summary class="bank-compact metric-${worst.view.tone}"><span>${esc(scope)}</span><b>${esc(summary)}</b>${depositGates.map(g=>`<small class="deposit-headroom ${g.headroomYuan==null?'missing':Number(g.headroomYuan)<=0?'warning':''}">新增存款${depositGateRate(g,bank)}%余量 ${amount(g.headroomYuan)} 亿 · 仅限新增存款</small>`).join('')}<small>查看全部 ${active.length} 项</small></summary>${active.map(r=>{if(isDepositGate(r)){const view=metricPresentation(r),rate=depositGateRate(r,bank),description='本基金与公司其他货基对该银行存款、存单和银行债合计敞口 / 银行季度净资产。';return `<div class="bank-rule metric-${view.tone}"><span>新增存款${rate}%余量${help(displayLabel(bank.label)+`新增存款${rate}%余量`,description+`新增存款后不得超过${rate}%，等于限额允许；默认6%，该行批准可用8%。仅新增存款触发，存单买入仍受其他适用规则约束。存量达到或超过限额不因此标为整体违规。`)}</span><b>${amount(r.headroomYuan)} 亿</b><span>公司敞口 ${amount(r.numeratorYuan)} / 银行净资产 ${amount(r.denominatorYuan)} 亿 · ${esc(coreUI.value(r,'currentValue',s))} / ${rate}% · 仅限新增存款</span></div>`;}const view=metricPresentation(r);return `<div class="bank-rule metric-${view.tone}"><span>${esc(bankScopeNames[r.ruleId])}${help(displayLabel(bank.label)+bankScopeNames[r.ruleId],`${r.name}。${r.ruleId==='C05'||r.ruleId==='C08'?'分母为该银行季度净资产。':'分母为基金净资产。'}${r.reason||''}`)}</span><b>${amount(r.numeratorYuan)} / ${amount(view.limitYuan)} 亿</b><span>${esc(coreUI.value(r,'currentValue',s))} / ${esc(coreUI.threshold(r,s).replace(/^[≤≥]/,''))}</span></div>`;}).join('')}</details></dd></div>`;
  }
  if(orderedBanks.length>visibleBanks)html+='</details></dd></div>';
 }else{const exposure=deriveTemplateExposure(s.initialData);html+=fact('A银行当前敞口',`${amount(exposure.legacyBankExposureYuan==null?null:exposure.legacyBankExposureYuan+(q.exposureAdjustmentsByBankYuan?.['BANK-A']??0))} 亿`,'历史A银行规则，不能推广为其它银行上限。');}
 $('facts').innerHTML=html;
 for(const detail of $('facts').querySelectorAll('details[data-facts-open]'))detail.open=expandedFacts.has(detail.dataset.factsOpen);
}
function render(){
 const s=model.getState(), t=totals(s), path=legacyPath(s), q=s.summary;
 if(skipReviewRun!==s.context.runId){skipReview=false;skipReviewRun=s.context.runId;}
 $('skip-review').checked=skipReview;
 const simple=s.initialData?.demoMode==='single-day-principal-v1';
 displayEntities=Object.fromEntries([...(s.initialData?.banks||[]).map(b=>[b.bankId,displayLabel(b.label)]),...(s.initialData?.securities||[]).map(x=>[x.securityId,displayLabel(x.label)])]);
 $('portfolio-label').textContent=displayLabel(s.initialData?.portfolio?.label)||'货币组合';$('business-date').textContent=`业务日 ${s.context.businessDate}`;
 $('scenario').value=s.scenarioId;$('scenario').querySelector('[value="S13"]').textContent=s.scenarioId==='S13'&&s.initialData?.provenance.kind==='synthetic'?'模板运行':'五业务完整计划';
 $('versions').textContent=`运行副本 · 版本${s.revision} · 偏好版本${s.preferences.version}`;
 $('market-clock').textContent=`业务时钟 ${s.marketClock?.time||'待补'} · ${s.marketClock?.isTradingDay?'交易日':'非交易日'}（上海）`;
 $('market-clock').hidden=false;$('scenario').parentElement.hidden=simple;$('legacy-rule-catalog').hidden=simple;
 $('save-indicator').textContent=dirty?'有未保存修改':'运行副本 · 手动保存';
 $('desk-screen').hidden=screen!=='desk';$('execution-screen').hidden=screen!=='execution';$('initial-screen').hidden=screen!=='initial';$('analysis-screen').hidden=screen!=='analysis';$('ai-analysis-entry').hidden=screen!=='analysis';
 document.querySelectorAll('[data-screen]').forEach(b=>{if(b.dataset.screen===screen)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
 const peak=path?.peakGapYuan??(isPreset(s)?s.proposal.peakShortfallYuan:null);
 const dashboard=renderCashDashboard(s,{amount,esc,escRaw});$('metrics').innerHTML=dashboard.first;$('settlement-metrics').innerHTML=dashboard.second;$('cash-source-rows').innerHTML=dashboard.pending;initialUI.renderPage(s);
 renderPlans(s);
 renderFacts(s,t,q);
 $('rule-summary-mini').innerHTML=`<div class="mini-heading"><b>规则适用范围</b><span>2B-0.1.0</span></div><p>${ratioPercent(s.ruleConfig.depositThreshold)}%：新增A银行存款投前严格大于时阻断（副本阈值）。</p><p>${ratioPercent(s.ruleConfig.observationThreshold)}%：投后软观察线，不是硬限额。</p><p class="warning">正式核心指标待补；${isPreset(s)?'仅校验已定义规则':'请计算当前计划'}。</p>`;
 coreUI.render(s);if(s.coreRules?.enabled){const count=new Set(s.coreRules.rows.map(r=>r.ruleId)).size;$('rule-summary-mini').innerHTML=`<div class="mini-heading"><b>${count}条已定义核心约束</b>${help('规则范围','当前状态与本次交易放行分别判断，具体下达仍须最新复核。已定义约束不等于完整正式制度。')}</div>`;}if(screen==='analysis')analysisUI.render(s);renderDiagnostics(s);renderGroups(s,path);renderPath(s,path);renderProposal(s);renderRecords(s);renderExecution(s);if(simple){$('path-content').querySelector('.execution-notes p')?.remove();$('execution-facts').innerHTML=`<p>实际账户现金：<b>${amount(q.accountCashYuan??q.settledBalanceYuan)}亿</b><br>实时业务可用：<b>${amount(q.availableYuan)}亿</b><br>当日到期待收付净额：<b>${amount(q.unreceivedMaturityYuan)}亿</b></p><p>逐笔到期收付以真实到账或付款确认；业务头寸始终包含当日到期本金。计算后按所选审核流程手动下达，卖券及融资成交即计业务头寸和比例；实际付款仍核验账户现金。</p>`;} $('catalog-rows').innerHTML=rules.map(r=>`<tr><td><b title="${esc(r.ruleId)}">${esc(ruleName(r.ruleId))}</b></td><td>${esc(ruleKinds[r.category]||'其他规则')}<small>${esc(ruleScope(r))}</small></td><td>${esc(ruleEffect(r))}</td><td>${esc(ruleSource(r))}<small>历史规则 · 当前范围</small></td></tr>`).join('');
 $('bottom-status').textContent=displayText(`${s.initialData?.provenance?.kind==='synthetic'?displayLabel(s.initialData.label):scenarioNames[s.scenarioId]||'当前场景'} · ${approvalText(s)} · ${isPreset(s)?'每次下达使用最新状态复核':'输入已更新，请刷新计算'}。`);
 document.querySelectorAll('[data-action="review"]').forEach(button=>{button.disabled=skipReview||!s.canApprove;button.title=displayText(skipReview?'已选择跳过人工审核；下达仍校验当前规则与资金':s.canApprove?'审核当前具体指令包':s.approvalReason||'请先计算可行指令');});
 const mode=sortingMode(s);
 document.querySelectorAll('[data-sort]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.sort===mode)));
 $('sorting-note').textContent=mode==='reverse_repo_first'?'优先安排逆回购与交易所融券；资金或指标受限时，先完成必要的卖券、融资等前置步骤。':mode==='liquidity_last'?'先安排其他既有用款，再安排逆回购与交易所融券出钱；只调整已有计划顺序，不新增交易。':'按经理偏好自动排序；所有方案均须满足资金、指标及执行条件。';
 $('sorting-note').innerHTML=`当前排序：${esc(mode==='AUTO'?'自动排序':prefNames[mode])} ${help('排序偏好',$('sorting-note').textContent)}`;
 workspace?.refreshStatus();
 if(calculationController?.isRunning())setCalculationBusy(true);
}
function renderPlans(s){
 const balances=new Map(s.summary.planBalances.map(b=>[b.planId,b]));
 const groups=Object.entries(types).map(([type,label])=>({type,label,plans:s.plans.filter(p=>p.businessType===type)})).filter(g=>g.plans.length);
 $('plan-count').textContent=`${groups.length}类 / ${s.plans.length}笔 · 展开查看逐笔交易`;
 $('trade-rows').innerHTML=groups.map(g=>{
  const open=expandedGroups.has(g.type),sum=Object.fromEntries(['targetYuan','filledYuan','lockedYuan','remainingYuan','arrangeableYuan'].map(k=>[k,g.plans.reduce((n,p)=>n+balances.get(p.planId)[k],0)]));
  const groupUnknown=Object.values(s.execution.instructions).some(i=>i.status==='unknown'&&g.plans.some(p=>p.planId===i.planId));
  const groupStatus=groupUnknown?tag('wait','发送结果未知'):sum.lockedYuan?tag('wait','含在途交易'):sum.remainingYuan===0?tag('pass','意向已成交'):sum.filledYuan?tag('wait','部分完成'):tag('neutral','待推进');
  const head=`<tr class="business-group" data-group="${g.type}"><th scope="row"><button class="group-toggle" data-toggle-group="${g.type}" aria-expanded="${open}" aria-label="${open?'收起':'展开'}${esc(g.label)} ${g.plans.length}笔"><span aria-hidden="true">${open?'▾':'▸'}</span> ${esc(g.label)} <small>${g.plans.length}笔</small></button></th><td class="num"><b>${amount(sum.targetYuan)}</b></td><td class="num">${amount(sum.filledYuan)}</td><td class="num">${amount(sum.filledYuan+sum.lockedYuan)}</td><td>${progressBar(sum)}</td><td>${groupStatus}<small>${BUSINESS_DIRECTIONS[g.type]==='inflow'?'资金流入':'资金流出'}</small></td><td><button data-new-type="${g.type}" aria-label="新增${esc(g.label)}">新增一笔</button></td></tr>`;
  const rows=g.plans.map(p=>{const b=balances.get(p.planId);return `<tr data-row="${escRaw(p.planId)}" data-parent-group="${g.type}" ${open?'':'hidden'} class="trade-child ${p.planId===selectedPlan?'selected-row':''}"><td><b>${esc(displayLabel(p.label))}</b><small>发行人/银行：${esc(objectName(p.issuerId))} · 对手：${esc(objectName(p.counterpartyId))}</small>${p.securityId?`<small>证券代码：${esc(p.securityId)} · 剩余${esc(s.initialData?.securities.find(sec=>sec.securityId===p.securityId)?.remainingTradingDays??'待补')}天</small>`:''}<small>交易 ${esc(p.tradeDate||s.context.businessDate)} · 交收 ${esc(p.settlementDate||s.context.businessDate)}</small></td><td class="num">${amount(b.targetYuan)}</td><td class="num">${amount(b.filledYuan)}</td><td class="num">${amount(b.filledYuan+b.lockedYuan)}</td><td>${progressBar(b)}</td><td>${Object.values(s.execution.instructions).some(i=>i.planId===p.planId&&i.status==='unknown')?tag('wait','发送结果未知'):b.lockedYuan?tag('wait',s.progressId==='cancel_pending'?'撤改待确认 · 未释放':'在途保留'):b.filledYuan?tag('pass','已成交'):tag('neutral',isPreset(s)?'计算建议':'待计算')}<small>独立计划 · v${p.version}</small></td><td><button data-edit="${escRaw(p.planId)}">编辑</button> <button data-detail="${escRaw(p.planId)}">详情</button></td></tr>`;}).join('');
  return head+rows;
 }).join('')||'<tr><td colspan="7" class="empty-record">暂无计划，点击“新增指令”。</td></tr>';
}
function renderDiagnostics(s){
 const panel=$('calculation-diagnostics'),rows=calculationTrace(s)?.diagnostics||[];
 const unique=new Map();for(const d of rows){const plan=s.plans.find(p=>p.planId===d.planId),message=readableDiagnostic(s,d.message),stem=plan?message.replace(displayLabel(plan.label)||'', '').trim():message,key=`${d.code}|${d.severity}|${stem}`;if(unique.has(key))unique.get(key).count++;else unique.set(key,{...d,count:1});}
 const visible=[...unique.values()];panel.hidden=!visible.length;
 $('diagnostic-count').textContent=`${visible.length}项检查提示`;
 $('diagnostic-list').innerHTML=visible.map(d=>{
  const tone=['missing','block','wait','info'].includes(d.severity)?d.severity:'info';
  const plan=s.plans.find(p=>p.planId===d.planId);
  const sourceAction=['exchange-clock-missing','exchange-window-closed'].includes(d.code)?'repo-settings':d.action;
  const action=sourceAction==='repo-settings'?'<button data-action="repo-settings">核对质押能力与业务时钟</button>':sourceAction==='edit-plan'&&plan&&d.count===1?`<button data-edit="${escRaw(plan.planId)}">编辑该交易</button>`:['cash-missing','fee-missing','buffer-missing','concentration-input-missing'].includes(d.code)?'<button data-action="settings">核对输入</button>':sourceAction==='initial-data'||d.count>1?'<button data-screen="initial">核对初始数据</button>':sourceAction==='auto'&&['deposit-threshold','selected-path-only','special-path-fallback'].includes(d.code)?'<button data-path="AUTO">使用自动排序</button>':'';
  return `<li class="diagnostic-item"><div>${tag(tone==='info'?'neutral':tone,{missing:'待补输入',block:'阻断',wait:'等待条件',info:'计算说明'}[tone])}<b>${d.count>1?`${d.count}笔计划共用此项`:esc(displayLabel(plan?.label)||'当前计划')}</b><p>${esc(readableDiagnostic(s,d.message))}</p></div>${action}</li>`;
 }).join('');
}
function readableDiagnostic(s,value){return readableText(s,value);}
function calculationTrace(s){return s.calculation?.trace||s.calculationTrace||s.proposal?.trace||null;}
function renderGroups(s){
 const result=typeof model.getAdvancementGroups==='function'?model.getAdvancementGroups():null;
 const pending=[...(result?.pending||[])];
 if(!result)for(const st of s.proposal?.steps||[])pending.push({...st,status:'awaiting_calculation',reason:'请重新计算当前指令'});
 for(const inst of Object.values(s.execution?.instructions||{}))if(inst.cancelRequestId&&inst.nominalYuan>inst.filledYuan+inst.cancelledYuan&&!pending.some(item=>item.status==='cancel_pending'&&item.planId===inst.planId))pending.push({planId:inst.planId,label:instructionName(s,inst),nominalYuan:inst.nominalYuan-inst.filledYuan-inst.cancelledYuan,status:'cancel_pending',reason:'双证据齐备前保留占用'});
 const groupRows=[
  ['优先推进',result?.priority||[]],
  ['可同步推进',result?.synchronous||[]],
  ['受限交易',result?.restricted||[]],
  ['待计算',pending.filter(item=>item.status!=='cancel_pending')],
  ['撤改处理中',pending.filter(item=>item.status==='cancel_pending')],
 ];
 const statusText={awaiting_review:'待人工审核',awaiting_calculation:'等待计算',awaiting_refresh:'待核对刷新',cancel_pending:'撤改待确认',calculated_unarranged:'已计算 · 本次未安排'};
 const cards=groupRows.map(([name,items],index)=>`<div class="order-group ${items.length?'has-items':'is-empty'}"><div class="group-head">${name}<span>${items.length}</span></div>${items.map(st=>{
  const plan=s.plans.find(p=>p.planId===st.planId),label=String(plan?.label||st.label||'关联交易').replace(/(-?\d+)元/g,(_,yuan)=>`${decimalYuan(yuan)}亿`);
  const state=statusText[st.status]||(index===2?'业务条件受限':stepState(s,st));
  const reason=st.reason?readableText(s,st.reason):'';
  const note=[state,reason].filter(Boolean).join(' · ');
  const title=displayLabel(label).replace(/\d+(?:\.\d+)?亿/g,'').trim();
  return `<button class="order-item" data-detail="${escRaw(st.planId)}" data-order-reason="${escRaw(note)}" title="${esc(note)}"><b>${esc(title)}</b><span class="order-card-amount">${st.nominalYuan!=null?amount(st.nominalYuan)+'亿':'金额待核'}</span><span class="order-card-state">${esc(state)}</span><span class="order-card-reason">${esc(reason)}</span><span class="order-card-detail">详情</span></button>`;
 }).join('')||'<div class="empty-group">当前无此类建议</div>'}</div>`).join('');
 $('order-groups').innerHTML=cards;
}
function traceMetrics(s,st){
 if(!s.coreRules?.enabled)return `${esc(st.beforeRatio)} → ${esc(st.afterRatio)}`;
 const rows=(st.rules||[]).filter(r=>r.ruleId==='C02'||r.ruleId==='C09');
 return rows.map(r=>`<div>${esc(r.name||CORE_RULE_NAMES[r.ruleId])}<small>${esc(coreUI.value(r,'currentValue',s))} → ${esc(coreUI.value(r,'projectedValue',s))}</small></div>`).join('')||'见逐项规则依据';
}
function traceRules(s,st){
 const rows=st.rules||[],core=rows.filter(r=>Object.hasOwn(CORE_RULE_NAMES,r.ruleId)),other=rows.filter(r=>!Object.hasOwn(CORE_RULE_NAMES,r.ruleId));
 if(!core.length)return other.map(r=>`${esc(r.name||ruleName(r.ruleId))}：${esc(resultName(r.result))}${r.reason&&['block','missing','closed','warn','waiting_conditions'].includes(r.result)?` · ${esc(readableText(s,r.reason))}`:''}`).join('<br>');
 const counts=Object.fromEntries(['pass','warn','block','missing','not_applicable'].map(k=>[k,core.filter(r=>r.result===k).length]));
 const otherFailures=other.filter(r=>['block','missing','closed'].includes(r.result));
 return `<div>${Object.entries(counts).filter(([,n])=>n).map(([k,n])=>tag(resultTone(k),`${resultName(k)} ${n}`)).join(' ')}${otherFailures.length?' '+tag('block',`其他下达条件未通过 ${otherFailures.length}`):''}</div>${core.filter(r=>['warn','block','missing'].includes(r.result)).slice(0,3).map(r=>`<small class="${r.result==='block'?'warning':''}">${esc(r.name||CORE_RULE_NAMES[r.ruleId])}${r.subjectLabel?` · ${esc(displayLabel(r.subjectLabel))}`:''}：${esc(resultName(r.result))} · ${esc(readableText(s,r.reason||''))}</small>`).join('')}<details class="technical-details"><summary>查看${core.length}项主体规则及输入</summary>${core.map(r=>`<p><b>${esc(r.name||CORE_RULE_NAMES[r.ruleId])} · ${esc(displayLabel(r.subjectLabel)||'组合')}</b><br>${esc(coreUI.value(r,'currentValue',s))} → ${esc(coreUI.value(r,'projectedValue',s))} · ${esc(resultName(r.result))}<br>${esc(r.reason||'')}<br>阈值 ${esc(coreUI.threshold(r,s))}</p>`).join('')}</details>`+other.map(r=>`<small class="${['block','missing','closed'].includes(r.result)?'warning':''}">${esc(r.name||ruleName(r.ruleId))}：${esc(resultName(r.result))}${r.reason&&['block','missing','closed','warn','waiting_conditions'].includes(r.result)?` · ${esc(readableText(s,r.reason))}`:''}</small>`).join('');
}
function groupedTraceRows(s,tr){
 const steps=tr.steps||[],membership=new Map(),groups=[];
 for(const g of s.proposal?.groups||[])for(const id of g.stepIds||[])if(!membership.has(id))membership.set(id,g);
 const row=st=>`<tr><td><b>${esc(stepName(s,st.stepId))}</b><small>${esc(planSummary(s,st.planId))}</small><small>交收 ${esc(st.valueDate||s.context.businessDate)}</small></td><td>${amount(st.nominalYuan)}</td><td>${amount(st.beforeCashYuan)} → ${amount(st.afterCashYuan)}${st.valueDate&&st.valueDate!==s.context.businessDate?`<small>${esc(st.valueDate)}预算：${amount(st.futureAvailableBeforeYuan)} → ${amount(st.futureAvailableAfterYuan)}</small>`:''}</td><td>${traceMetrics(s,st)}</td><td>${traceRules(s,st)}</td></tr>`;
 for(const st of steps){const source=membership.get(st.stepId),last=groups.at(-1);if(source?.status==='ready'&&last?.source===source)last.members.push(st);else groups.push({source,status:source?.status||'conditional',members:[st]});}
 return groups.filter(g=>g.members.length).map((g,i)=>g.members.length===1?row(g.members[0]):`<tr class="preview-batch"><td><b>第${i+1}组 · ${g.members.length}笔共同安排候选</b><small>保留独立指令；实际下达按当前批次预检</small></td><td>${amount(g.members.reduce((n,st)=>n+st.nominalYuan,0))}</td><td colspan="3"><details class="preview-batch-details"><summary>展开逐笔金额、头寸及规则</summary><table><tbody>${g.members.map(row).join('')}</tbody></table></details></td></tr>`).join('');
}
function renderPath(s){
 const tr=calculationTrace(s),p=s.proposal;
 if(!tr||!p){$('path-content').innerHTML='<div class="empty-state">当前输入尚未计算。请点击“计算并刷新建议”。</div>';return;}
 const statusNames={feasible:'已定义规则通过',waiting_conditions:'等待条件',blocked_sequence:'此顺序受阻',insufficient_data:'数据不足',search_exhausted:'搜索范围未覆盖',proven_infeasible:'已证明当前条件不可行'};
 $('path-content').innerHTML=`<div class="path-summary"><b>${esc(statusNames[p.status]||'计算状态待核实')}</b><span>${esc(readableText(s,p.message))}</span></div><div class="table-scroll"><table class="preview-table"><thead><tr><th>交易步骤 / 计划</th><th>名义金额</th><th>今日头寸 / 交收预算</th><th>${s.coreRules?.enabled?'核心指标 当前 → 预计':'A银行比例 前 → 后'}</th><th>规则判定</th></tr></thead><tbody>${groupedTraceRows(s,tr)||(s.summary.planBalances.some(b=>b.arrangeableYuan>0)?'<tr><td colspan="5">当前搜索没有返回完整候选。意向与既有事实保留。</td></tr>':'<tr><td colspan="5">当前没有尚可安排的新步骤；已发指令请在投管处理回报，未完成意向继续保留。</td></tr>')}</tbody></table></div><div class="execution-notes"><p>新增流动性峰值：<b>${amount(p.peakShortfallYuan)}亿</b><br>终局条件现金投影：${amount(tr.projectedFinalCashYuan)}亿</p><p>已考察 ${tr.search?.exploredCandidates??0} 个候选，${tr.search?.nodes??0} 个搜索节点。<br>${esc(({selected_split_path:'指定分次路径',selected_path_only:'指定顺序',split_grid_unexplored:'复杂分次网格未穷尽',node_limit:'达到节点预算',action_limit:'达到动作预算',beam_limit:'有界搜索未穷尽',bounded_search:'有界搜索完成',unit_mismatch:'交易单位不匹配'})[tr.search?.boundary]||'当前限定范围已覆盖')}。</p><p>偏好：${(tr.orderedPreferenceKeys||[]).map(k=>prefNames[k]).join(' → ')}。</p></div><p class="warning">${esc(readableText(s,(p.conflicts||[]).join('；')))}</p><p class="inline-note">单位：亿元。负数表示资金缺口。${help('预演口径','交易所回购按1000元面额整数倍；其他业务暂沿用100万元交易单位。名义与现金同额为当前测算假设；付款仍以已到账现金核验。')}</p>`;
}
function renderProposal(s){
 $('approval-state').textContent=displayText(approvalText(s));
 const steps=isPreset(s)?s.proposal.steps:[];
 $('proposal-rows').innerHTML=steps.map(st=>{const p=s.plans.find(x=>x.planId===st.planId);return `<tr><td><b>${esc(stepName(s,st))}</b><small>${esc(planSummary(s,st.planId))}</small></td><td>${esc(objectName(p?.counterpartyId||p?.issuerId))}<small>${esc(displayLabel(p?.label||st.label))}</small></td><td class="num">${amount(st.nominalYuan)}</td><td>${esc(conditionText(s,st))}</td><td>${tag(s.approvalStatus==='valid'&&s.approval?.authoritySource!=='calculated_skip_review'&&!skipReview?'pass':'wait',stepState(s,st))}</td></tr>`;}).join('')||'<tr><td colspan="5" class="empty-record">暂无可审核指令。请刷新计算并检查缺失输入或规则冲突。</td></tr>';
}
function renderRecords(s){
 // Record text depends on these source values, not on snapshot freshness or the
 // selected page. Compare content so imports with a reused run/revision still refresh.
 const steps=calculationTrace(s)?.steps||[],journal=s.execution?.journal||[],entries=activity.get(s.scenarioId)||[];
 const sourceKey=JSON.stringify([s.context?.runId,s.scenarioId,s.plans,s.initialData?.demoMode,steps,journal,entries,rules]);
 if(sourceKey===recordSourceKey){filterRecords();return;}
 records=[{id:'missing',source:'规则覆盖范围',rule:'正式资料待补',input:'正式指标、质押券与真实事件协议未提供',tone:'missing',result:'正式口径待补',detail:'仅计算已定义规则；同额现金、100万元单位及初始零费用/安全垫是合成假设。'}];
 for(const [i,st] of steps.entries()){
  const detail=JSON.stringify(st);
  for(const [j,r] of (st.rules||[]).entries())records.push({id:`calc-${i}-${j}`,source:`计算 / ${planName(s,st.planId)}（${planNumber(s,st.planId)}）`,rule:r.name||ruleName(r.ruleId),input:Object.hasOwn(CORE_RULE_NAMES,r.ruleId)?`${displayLabel(r.subjectLabel)||'组合'} · ${coreUI.value(r,'currentValue',s)} → ${coreUI.value(r,'projectedValue',s)} · ${r.reason||''}`:`投影现金 ${amount(st.beforeCashYuan)} → ${amount(st.afterCashYuan)}亿`,tone:resultTone(r.result),result:resultName(r.result),detail});
 }
 for(const [i,e] of journal.entries())records.push({id:`event-${i}`,source:'投管回报',rule:eventNames[e.event?.type||e.kind]||'业务事件',input:e.event?.sourceSequence?`回报序号 ${e.event.sourceSequence}`:'本地操作记录',tone:'pass',result:'业务事件',detail:JSON.stringify(e)});
 for(const [i,a] of entries.entries())records.push({id:`local-${i}`,source:`界面操作 / ${a.time}`,rule:'操作日志',input:a.message,tone:'pass',result:'本地操作',detail:'界面日志不代替存档中的业务事件。'});
 recordSourceKey=sourceKey;recordFilterKey=null;recordSearchText=new WeakMap();
 $('record-summary').textContent=`共 ${records.length} 条记录`;
 filterRecords();
}
function filterRecords(){
 const filter=$('record-filter').value,search=$('record-search').value.toLowerCase(),filterKey=JSON.stringify([filter,search]);
 if(filterKey===recordFilterKey)return;
 const rs=records.filter(r=>{
  if(filter!=='all'&&r.tone!==filter)return false;
  if(!search)return true;
  // Preserve the original full-JSON search (including raw detail and field names).
  let text=recordSearchText.get(r);
  if(text===undefined){text=JSON.stringify(r).toLowerCase();recordSearchText.set(r,text);}
  return text.includes(search);
 });
 $('record-rows').innerHTML=rs.map(r=>`<tr><td>${esc(r.source)}</td><td><b>${esc(r.rule)}</b></td><td>${esc(r.input)}</td><td>${tag(r.tone,r.result)}</td><td><button data-record="${escRaw(r.id)}">详情</button></td></tr>`).join('')||'<tr><td colspan="5" class="empty-record">没有匹配记录，请调整筛选条件。</td></tr>';
 $('record-count').textContent=`显示 ${rs.length} / ${records.length} 条；记录区分计算依据、投管回报与界面操作。`;
 recordFilterKey=filterKey;
}
function executionOrderDependencies(s){return Object.fromEntries(Object.keys(s.execution?.instructions||{}).map(id=>[id,deriveExecutionOrderDependencies(s,id)]));}
function renderExecution(s){
 const q=s.summary,ex=s.execution;
 $('progress-label').textContent=`回报水位 ${ex?.sourceSequence??0} · ${qualityNames[q.quality]||'状态待核实'}${ex?.requiresRefresh?' · 恢复后待刷新':''}`;
 $('execution-rows').innerHTML=q.planBalances.map(b=>{const p=s.plans.find(x=>x.planId===b.planId);return `<tr><td><b>${esc(displayLabel(p.label))}</b><small>${esc(planSummary(s,b.planId))}</small></td>${['targetYuan','filledYuan','lockedYuan','remainingYuan','arrangeableYuan'].map(k=>`<td class="num">${amount(b[k])}</td>`).join('')}<td>${b.lockedYuan?'在途保留':b.filledYuan?'已确认成交':'尚无执行事实'}</td></tr>`;}).join('');
 const instructions=Object.values(ex?.instructions||{});
 const orderDependencies=executionOrderDependencies(s);
 for(const id of executionSelection)if(!ex.instructions[id])executionSelection.delete(id);
 $('instruction-rows').innerHTML=instructions.map(i=>`<tr><td><input class="execution-select" type="checkbox" data-execution-select="${escRaw(i.instructionId)}" aria-label="选择${esc(instructionName(s,i))}" ${executionSelection.has(i.instructionId)?'checked':''}></td><td><b>${esc(instructionName(s,i))}</b><small>${esc(planSummary(s,i.planId))}</small>${renderExecutionOrderHints(s,i.instructionId,orderDependencies)}</td><td>${amount(i.nominalYuan)} / ${amount(i.filledYuan)} / ${amount(i.settledYuan)}<small>已撤回 ${amount(i.cancelledYuan)}亿</small></td><td>${esc(instructionStatus(i,s))}${i.direction==='inflow'?`<small>已到账 ${amount(creditedCash(s,i))}亿 · 待到账 ${amount(i.filledYuan-creditedCash(s,i))}亿</small>`:''}${i.cancelRequestId?'<small>有撤改申请，双证据配对后才释放</small>':''}</td><td><button data-event="${escRaw(i.instructionId)}">录入投管回报</button></td></tr>`).join('')||'<tr><td colspan="5" class="empty-record">尚无已下达指令。请在交易台计算，按所选审核流程核对后点击底部“手动批量下达指令”。</td></tr>';
 $('execution-select-all-head').innerHTML='<input id="execution-select-all" type="checkbox" aria-label="全选已下达指令">';
 const selectAll=$('execution-select-all');selectAll.checked=instructions.length>0&&executionSelection.size===instructions.length;selectAll.indeterminate=executionSelection.size>0&&executionSelection.size<instructions.length;selectAll.disabled=!instructions.length;
 $('execution-batch-fill').disabled=!executionSelection.size;
 $('execution-batch-settle').disabled=!executionSelection.size;
 $('execution-facts').innerHTML=`<p>实际账户现金：<b>${amount(q.accountCashYuan??q.settledBalanceYuan)}亿</b><br>业务实时头寸：<b>${amount(q.availableYuan)}亿</b><br>当日到期待收付净额：<b>${amount(q.unreceivedMaturityYuan)}亿</b></p><p>本地保留：<b>${amount(q.localReservedYuan)}亿</b><br>投管保留：<b>${amount(q.platformReservedYuan)}亿</b><br>应付保留：<b>${amount(q.payableReservedYuan)}亿</b></p><p>单日业务头寸含当日到期款、已成交待收的卖券及融资款，支持先下达；实际付款须有账户现金。已计入头寸的款项到账不重复增加业务头寸，支付已保留的应付也不重复扣减。</p><p class="warning">一级存单进入时已确认认购并占用，只安排缴款。卖券或融资成交与到账分开。撤改申请不释放占用，仍须双证据。</p><p>未来交收预算：${(q.dateBalances||[]).map(x=>`${esc(x.valueDate)}：${amount(x.availableYuan)}亿`).join('；')||'无新增未来日期'}。按已确认收付与已下达承诺累计。</p>`;
 $('execution-log').innerHTML=(ex?.journal||[]).slice().reverse().map(a=>{const e=a.event||a.receipt||{},i=a.instruction||ex.instructions[e.instructionId||a.request?.instructionId],names={accepted:'确认接收',rejected:'明确拒绝且无占用',fill:'成交回报',cash_settled:'结算确认',cash_available:'资金已可用',cancel_confirmed:'撤改证据',cancel_failed:'撤改失败'};const label=a.kind==='send'?'手动下达':a.kind==='cancel_request'?'申请撤改':a.kind==='opening_cash_event'?'既有现金收付':names[e.type]||'现金事件记录';const n=e.nominalYuan??e.amountYuan??i?.nominalYuan;return `<div class="log-item"><small>${esc(label)}</small><span>${esc(i?instructionName(s,i):(displayLabel(s.summary.settlementRows?.find(x=>x.sourceId===(e.sourceId||a.sourceId||a.cashEvent?.sourceId))?.label)||'独立现金来源'))} · ${amount(n)}亿 ${e.sourceSequence?`· 回报序号 ${e.sourceSequence}`:''}${e.type==='cancel_confirmed'?` · ${e.nominalConfirmed?'名义已确认':''} ${e.releaseConfirmed?'释放已确认':''}`:''}</span></div>`;}).join('')||'<div class="empty-state">尚无业务流水。流水随场景存档恢复。</div>';
}
function eventDialog(id){
 const s=model.getState(),i=s.execution.instructions[id];if(!i)return;
 const pending=i.nominalYuan-i.filledYuan-i.cancelledYuan;
 const businessType=s.plans.find(p=>p.planId===i.planId)?.businessType,financing=isFinancing(businessType),exchange=isExchangeRepo(businessType);
 const eventTypes=[['fill','成交'],['settle','结算']];
 openDialog('录入投管回报',`<p>${esc(instructionName(s,i))} · ${esc(instructionStatus(i))}。录入后更新当前运行账目。成交金额按本次增量输入；结算处理本指令全部已成交待结算金额${i.direction==='inflow'?'及待到账金额':''}。${i.direction==='inflow'?'成交已计入业务头寸；结算到账增加实际账户现金，不重复计入业务头寸。':'结算时核验并扣减实际账户现金。'}</p>${renderExecutionOrderHints(s,id,executionOrderDependencies(s))}<form id="event-form"><div class="form-grid"><label>回报类型<select name="type">${eventTypes.map(([v,n])=>`<option value="${v}">${n}</option>`).join('')}</select></label><label>本次金额（亿元）<input name="amount" inputmode="decimal" required></label>${financing||exchange?`<label id="event-trade-time">实际成交时间（上海）<input name="tradeTime" type="time" step="1" value="${escRaw(s.marketClock?.time)}"></label>`:''}</div><p id="event-amount-note" class="muted"></p>${formFooter('提交回报')}</form>`);
 const eventForm=$('event-form'),credited=creditedCash(s,i);
 const unsettled=Math.max(0,i.filledYuan-i.settledYuan),uncredited=i.direction==='inflow'?Math.max(0,i.filledYuan-credited):0;
 const defaultType=unsettled>0||uncredited>0?'settle':'fill';
 eventForm.elements.type.value=defaultType;
 const updateEventAmount=()=>{const settle=eventForm.elements.type.value==='settle';eventForm.elements.amount.value=decimalYuan(settle?Math.max(unsettled,uncredited):Math.max(0,pending));eventForm.elements.amount.readOnly=settle||businessType==='deposit';if(eventForm.elements.tradeTime){$('event-trade-time').hidden=settle;eventForm.elements.tradeTime.disabled=settle;eventForm.elements.tradeTime.required=!settle;}$('event-amount-note').textContent=settle?`待结算 ${amount(unsettled)} 亿${i.direction==='inflow'?`，待到账 ${amount(uncredited)} 亿；提交后一起确认结算与到账。`:'；提交后确认结算付款。'} 结算金额按已成交事实确定，不能重复处理。`:`已接收后才能成交；超额、冲突和引用不匹配的回报会拒绝。${businessType==='deposit'?'存款须整笔成交。':'部分成交后未成交部分继续锁定。'}`;};
 eventForm.elements.type.onchange=updateEventAmount;updateEventAmount();
 $('event-form').onsubmit=e=>{e.preventDefault();try{const fd=new FormData(e.target),type=fd.get('type');
 if(type==='settle'){const result=model.processExecutionBatch([id],'settle');if(result.stoppedReason)throw new Error(result.stoppedReason);}
 else if(type==='fill'){const event={eventId:`evt-${crypto.randomUUID()}`,sourceSequence:model.getState().execution.sourceSequence+1,type,instructionId:id,fillId:`fill-${crypto.randomUUID()}`,nominalYuan:parseMoney(fd.get('amount'),'亿')};if(financing||exchange){const t=fd.get('tradeTime');event.tradeTime=t?.length===5?t+':00':t;}model.recordEvent(event);}
 else throw new Error('请选择成交或结算。');
 closeDialog();changed(type==='settle'?'结算回报已录入；资金划拨已确认。':'成交回报已录入；账目与占用已核对。');}catch(error){formError(error);}};
}
function executionBatchDialog(action){
 const s=model.getState(),ids=Object.keys(s.execution.instructions).filter(id=>executionSelection.has(id));
 if(!ids.length){notify('请先勾选已下达指令。');return;}
 const title=action==='fill'?'批量成交':'批量结算';
 const explanation=action==='fill'?'逐笔记录剩余未成交金额；成交只更新成交事实，不自动结算或划拨账户现金。':
  '逐笔结算已成交未结算额，并确认对应资金划拨；流入增加实际账户现金，流出核验并扣减实际账户现金。';
 const orderDependencies=action==='fill'?executionOrderDependencies(s):{};
 openDialog(title,`<p>${explanation} 按表格顺序处理；某笔失败即停，已完成的前笔保留。</p><ol>${ids.map(id=>{const i=s.execution.instructions[id],remaining=action==='fill'?i.nominalYuan-i.filledYuan-i.cancelledYuan:i.filledYuan-i.settledYuan;return `<li>${esc(instructionName(s,i))} · 本步待${action==='fill'?'成交':'结算'} ${amount(Math.max(0,remaining))} 亿${action==='settle'&&i.direction==='inflow'?` · 待到账 ${amount(Math.max(0,i.filledYuan-creditedCash(s,i)))} 亿`:''}${action==='fill'?renderExecutionOrderHints(s,id,orderDependencies):''}</li>`;}).join('')}</ol>${action==='fill'?'<p class="muted">前置状态按打开窗口时的成交事实显示；同批前笔成交后，后笔仍逐笔重新检查。存款按整笔成交，不可拆分以绕过存款闸门。</p>':''}<p class="warning">请确认这些回报代表已发生的投管事实。重复金额、未成交结算和实际账户现金不足会被拒绝。</p><form id="execution-batch-form"><label class="checkline"><input type="checkbox" required>已核对所选指令及当前事实</label>${formFooter(`确认${title}`)}</form>`);
 $('execution-batch-form').onsubmit=e=>{e.preventDefault();try{
   const result=model.processExecutionBatch(ids,action);
   executionSelection.clear();closeDialog();changed(`${title}已逐笔处理；请核对结果。`);
   const now=model.getState();
   openDialog(`${title}结果`,`<p>${result.stoppedReason?`于失败指令停止：${esc(readableText(now,result.stoppedReason))}`:'全部选中指令已处理。'}</p><ol>${result.results.map(row=>`<li>${esc(instructionName(now,now.execution.instructions[row.instructionId]))}：${esc(({filled:'已成交，未结算',settled:'已结算并划拨资金',blocked:'失败，未处理',not_processed:'前笔失败，未处理'})[row.status]||row.status)} · ${esc(readableText(now,row.reason))}</li>`).join('')}</ol>`);
  }catch(error){formError(error);}};
}
function fundingDialog(){openDialog('独立资金到账',`<p class="origin-note">录入前请核实资金已实际可用；本操作会增加当前运行的可用余额，不改变已录入的融资交易。</p><form id="funding-form"><label>新增可用金额（亿元）<input name="amount" inputmode="decimal" required></label><label class="checkline"><input type="checkbox" required>确认已核实到账，并录入当前运行</label>${formFooter('确认录入到账')}</form>`);$('funding-form').onsubmit=e=>{e.preventDefault();try{model.confirmFunding(parseMoney(new FormData(e.target).get('amount'),'亿'));closeDialog();changed('资金到账已录入。后续指令仍需手动下达。');}catch(error){formError(error);}};}
function sendDialog(){coreUI.batchDialog();}
function snapshotDialog(){const s=model.getState();openDialog('数据新鲜度',`<p>恢复存档、数据过期或回报序号缺口时，先核对最新账目。刷新只确认当前运行数据，不能补造缺失回报。</p><p>当前水位 ${s.execution?.sourceSequence??0} · ${esc(qualityNames[s.summary.quality]||'状态待核实')}</p><button id="refresh-snapshot" class="primary">确认当前数据</button><button id="stale-snapshot">标记数据过期</button><div id="form-error" class="form-error" role="alert"></div>`);$('refresh-snapshot').onclick=()=>{try{model.refreshSnapshot();closeDialog();changed('最新账目已确认；缺失回报仍需补齐。');}catch(error){formError(error);}};$('stale-snapshot').onclick=()=>{try{model.markSnapshotStale();closeDialog();changed('已标记过期，暂停依赖当前数据的下达。');}catch(error){formError(error);}};}

// Parse human money as an exact decimal scaled to integer yuan, never through float multiplication.
function parseMoney(text,unit,nullable=false){text=String(text).trim();if(!text&&nullable)return null;if(!/^\d+(\.\d+)?$/.test(text))throw new Error('金额须为非负十进制数，不接受指数、负数或逗号。');const [whole,frac='']=text.split('.');const scale=unit==='亿'?8:unit==='万'?4:0;if(frac.length>scale)throw new Error('金额精度不得小于1元。');const n=BigInt(whole)*10n**BigInt(scale)+BigInt((frac+'0'.repeat(scale)).slice(0,scale)||'0');if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('金额超出安全整数范围。');return Number(n);}
function formFooter(label){return `<div id="form-error" class="form-error" role="alert"></div><div class="dialog-actions"><button type="submit" class="primary">${label}</button></div>`;}
const defaultRepoTenorDays = type => isFinancing(type) ? 1 : 7;
function planDialog(id, initialType=null){
 const s=model.getState(),p=s.plans.find(x=>x.planId===id);selectedPlan=id||null;
 const simple=s.initialData?.demoMode==='single-day-principal-v1';
 openDialog(p?'编辑指令':'新增指令',`<form id="plan-form"><datalist id="bank-options">${(s.initialData?.banks||[]).map(b=>`<option value="${escRaw(b.bankId)}">${esc(displayLabel(b.label))}</option>`).join('')}</datalist><p class="origin-note">保存意向金额不要求资金已足够。在途/成交事实始终保留：意向金额不得低于已成交与锁定之和，对象和方向不得覆盖。</p><div class="form-grid"><label>业务类型<select name="businessType">${Object.entries(types).map(([v,t])=>`<option value="${v}" ${p?.businessType===v?'selected':''}>${t}</option>`).join('')}</select></label><label>指令名称（选填）<input name="label" maxlength="80" placeholder="留空时按交易内容自动生成" value="${escRaw(displayLabel(p?.label)||'')}"></label><label>交易对手<select name="counterpartyId"><option value="">待补 / 无</option>${p?.counterpartyId&&!(s.initialData?.banks||[]).some(b=>b.bankId===p.counterpartyId)?`<option value="${escRaw(p.counterpartyId)}" selected>${esc(objectName(p.counterpartyId))}</option>`:''}${(s.initialData?.banks||[]).map(b=>`<option value="${escRaw(b.bankId)}" ${p?.counterpartyId===b.bankId?'selected':''}>${esc(displayLabel(b.label))}</option>`).join('')}</select></label><label>发行人 / 银行<select name="issuerId"><option value="">待补 / 无</option>${p?.issuerId&&!(s.initialData?.banks||[]).some(b=>b.bankId===p.issuerId)?`<option value="${escRaw(p.issuerId)}" selected>${esc(objectName(p.issuerId))}</option>`:''}${(s.initialData?.banks||[]).map(b=>`<option value="${escRaw(b.bankId)}" ${p?.issuerId===b.bankId?'selected':''}>${esc(displayLabel(b.label))}</option>`).join('')}</select></label>${simple?`<input name="tradeDate" type="hidden" value="${escRaw(s.context.businessDate)}"><input name="settlementDate" type="hidden" value="${escRaw(s.context.businessDate)}">`:`<label>交易日<input name="tradeDate" type="date" required value="${escRaw(p?.tradeDate||s.context.businessDate)}"></label><label>交收日<input name="settlementDate" type="date" required value="${escRaw(p?.settlementDate||s.context.businessDate)}"></label>`}<label>证券 / 存款标的<select name="securityId"><option value="">未关联 / 待补</option>${(s.initialData?.securities||[]).map(x=>`<option value="${escRaw(x.securityId)}" ${p?.securityId===x.securityId?'selected':''}>${esc(displayLabel(x.label))}</option>`).join('')}</select></label><label>完整意向金额<input name="amount" inputmode="decimal" required value="${p?decimalYuan(p.targetYuan):''}"></label><label>金额单位<select name="unit"><option>亿</option><option>万</option><option>元</option></select></label><div class="wide form-grid" id="repo-fields" hidden><label>回购市场<select name="repoMarket"><option value="INTERBANK">银行间</option><option value="SSE">上交所</option><option value="SZSE">深交所</option></select></label><label>回购期限（天）<input name="tenorDays" type="number" min="1" step="1" value="${p?.repoTerms?.tenorDays??1}"></label>${simple?'':`<label>年利率（%）<input name="annualRate" inputmode="decimal" value="${p?.repoTerms?.annualRate==null?'':ratioPercent(p.repoTerms.annualRate)}" placeholder="未知留空"></label>`}<p id="repo-note" class="origin-note wide"></p></div><label class="wide">备注<textarea name="termsNote" maxlength="500">${escRaw(displayTermsNote(p?.termsNote)||'')}</textarea></label></div><p id="sale-note" class="origin-note" hidden>卖出先确认成交，再通过结算确认到账。新增卖券计划须提供可卖持仓数据后才能下达；当前可保存意向金额并参与条件测算。</p><p id="amount-summary" class="muted"></p>${p?`<p class="origin-note">当前事实：已成交 ${amount(s.summary.planBalances.find(b=>b.planId===p.planId).filledYuan)}亿，锁定 ${amount(s.summary.planBalances.find(b=>b.planId===p.planId).lockedYuan)}亿。仅修改意向金额与备注时保留这些事实。</p>`:''}${formFooter(p?'保存指令修改':'保存指令')}${p?'<button type="button" id="delete-plan" class="negative">删除这项未执行计划</button>':''}</form>`);
 const form=$('plan-form');if(!p&&initialType&&Object.hasOwn(types,initialType))form.elements.businessType.value=initialType;
 let tenorEdited=false;
 if(!p)form.elements.tenorDays.value=defaultRepoTenorDays(form.elements.businessType.value);
 form.elements.tenorDays.addEventListener('input',()=>{tenorEdited=true;});
 const toggleRepo=()=>{const type=form.elements.businessType.value,financing=isFinancing(type),exchange=isExchangeRepo(type);$('repo-fields').hidden=!(financing||exchange||type==='reverse_repo');$('sale-note').hidden=!['cd_sell','bond_sell'].includes(type);for(const option of form.elements.repoMarket.options)option.hidden=exchange?option.value==='INTERBANK':option.value!=='INTERBANK';if(exchange&&form.elements.repoMarket.value==='INTERBANK')form.elements.repoMarket.value='SSE';if(!exchange)form.elements.repoMarket.value='INTERBANK';$('repo-note').textContent=simple?'金额按本金同额收付，期限按填写天数计算。':exchange?(financing?'资金流入，形成待偿还本金。':'资金流出，用可用现金出借；不占自有质押券，不形成借款负债。')+'通用质押式回购需交易日内成交；新申报在15:30前截止，午休暂停。期限支持1、2、3、4、7、14、28、91、182天；面额1000元整数倍，单笔最多100亿元。':type==='reverse_repo'?'银行间逆回购为资金流出，期限用于平均剩余期限计算；不占自有质押券。':'资金流入，形成待偿还本金。需核对质押券折算后可融资额；不套用交易所15:30截止。';};
 if(p?.repoTerms)form.elements.repoMarket.value=p.repoTerms.market;form.elements.businessType.onchange=()=>{if(!p&&!tenorEdited)form.elements.tenorDays.value=defaultRepoTenorDays(form.elements.businessType.value);toggleRepo();};toggleRepo();
 const hasFacts=p&&s.summary.planBalances.some(b=>b.planId===p.planId&&(b.filledYuan>0||b.lockedYuan>0));if(hasFacts){for(const k of ['businessType','counterpartyId','issuerId','repoMarket','tenorDays','annualRate','tradeDate','settlementDate','securityId'])if(form.elements[k])form.elements[k].disabled=true;$('delete-plan').disabled=true;}const summary=()=>{try{const fd=new FormData(form);$('amount-summary').textContent=`意向 ${parseMoney(fd.get('amount'),fd.get('unit')).toLocaleString('zh-CN')} 元；方向由业务类型确定。`;}catch{$('amount-summary').textContent='请输入金额，保存前请核对单位。';}};form.addEventListener('input',summary);summary();
 form.onsubmit=e=>{e.preventDefault();try{const fd=new FormData(form);const patch={label:preserveLabel(fd.get('label').trim(),p?.label),businessType:fd.get('businessType'),direction:BUSINESS_DIRECTIONS[fd.get('businessType')],counterpartyId:String(fd.get('counterpartyId')??'').trim()||null,issuerId:String(fd.get('issuerId')??'').trim()||null,targetYuan:parseMoney(fd.get('amount'),fd.get('unit')),termsNote:preserveTermsNote(fd.get('termsNote').trim(),p?.termsNote),tradeDate:simple?s.context.businessDate:fd.get('tradeDate'),settlementDate:simple?s.context.businessDate:fd.get('settlementDate'),securityId:fd.get('securityId')||null,marketTier:['cd_buy','cd_sell','bond_buy','bond_sell'].includes(fd.get('businessType'))?'secondary':null,repoTerms:(isFinancing(fd.get('businessType'))||isExchangeRepo(fd.get('businessType'))||fd.get('businessType')==='reverse_repo')?{market:fd.get('repoMarket'),tenorDays:Number(fd.get('tenorDays')),annualRate:simple?null:parseAnnualRate(fd.get('annualRate'))}:null};if(!patch.label)patch.label=automaticInstructionLabel(hasFacts?{...p,targetYuan:patch.targetYuan}:patch,s.initialData);if(p)model.updatePlan(p.planId,hasFacts?{label:patch.label,targetYuan:patch.targetYuan,termsNote:patch.termsNote}:patch);else model.addPlan(patch);expandedGroups.add(p?.businessType||patch.businessType);closeDialog();changed('指令已保存；原成交与占用保留，请重新计算并按所选审核流程核对。');}catch(error){formError(error);}};
 if(p)$('delete-plan').onclick=()=>{try{model.deletePlan(p.planId);closeDialog();changed('未执行计划已删除，原建议需刷新。');}catch(error){formError(error);}};
}
function parseAnnualRate(text){text=String(text??'').trim();if(!text)return null;if(!/^\d+(\.\d{1,8})?$/.test(text))throw new Error('年利率请输入非负百分数，最多8位小数。');const [w,f='']=text.split('.');const n=BigInt(w)*100000000n+BigInt(f.padEnd(8,'0'));if(n>10000000000n)throw new Error('年利率须在0到100%之间。');return (n/10000000000n)+'.'+(n%10000000000n).toString().padStart(10,'0').replace(/0+$/,'').padEnd(1,'0');}
function repoSettingsDialog(){const s=model.getState();openDialog(s.initialData?.demoMode==='single-day-principal-v1'?'业务时钟':'质押资源与业务时钟',`<p class="origin-note">按市场维护质押券折算后可融资额；各市场的质押券不得重复填报。</p><form id="repo-resource-form"><label>市场<select name="market">${Object.entries(marketNames).map(([k,n])=>`<option value="${k}">${n}</option>`).join('')}</select></label><div class="form-grid"><label>质押券折算后可融资额（亿元）<input name="pledge" inputmode="decimal" placeholder="待补"></label></div><button type="submit">保存质押能力</button></form><hr><form id="clock-form"><p>业务日 ${esc(s.context.businessDate)}；使用手动维护的业务时钟。成交时间独立记录，闭市后收到的有效成交回报仍可入账；闭市不会自动撤单或释放占用。</p><div class="form-grid"><label>当前时间（上海）<input type="time" name="time" step="1" value="${escRaw(s.marketClock.time)}" required></label><label>是否交易日<select name="trading"><option value="true" ${s.marketClock.isTradingDay?'selected':''}>是（手动确认）</option><option value="false" ${!s.marketClock.isTradingDay?'selected':''}>否</option></select></label></div><button type="submit">更新业务时钟</button></form><div id="form-error" role="alert" class="form-error"></div><p class="muted">交易所回购新申报：9:15–9:25前、9:30–11:30、13:00–15:30前；9:20–9:25不可撤单。到期偿本付息、交易日历和账户数据须另行核对。</p>`);const form=$('repo-resource-form');form.hidden=s.initialData?.demoMode==='single-day-principal-v1';const redraw=()=>{const key=form.elements.market.value,r=s.repoResources[key];form.elements.pledge.value=r.pledgeConfirmedYuan==null?'':decimalYuan(r.pledgeConfirmedYuan);};form.elements.market.onchange=redraw;redraw();form.onsubmit=e=>{e.preventDefault();try{const fd=new FormData(form);model.setRepoResources(fd.get('market'),{pledgeConfirmedYuan:parseMoney(fd.get('pledge'),'亿',true)});closeDialog();changed('质押能力已更新；请重新计算并按所选审核流程核对。');}catch(error){formError(error);}};$('clock-form').onsubmit=e=>{e.preventDefault();try{const fd=new FormData(e.target),time=fd.get('time');model.setMarketClock({time:time.length===5?time+':00':time,isTradingDay:fd.get('trading')==='true'});closeDialog();changed('业务时钟已更新；下达与成交按对应时点校验。');}catch(error){formError(error);}};}
function detailDialog(id,orderReason=null){const s=model.getState(),p=s.plans.find(p=>p.planId===id);if(!p)return;selectedPlan=id;expandedGroups.add(p.businessType);render();const b=s.summary.planBalances.find(x=>x.planId===id);openDialog('计划关联与依据',`${orderReason?`<p class="origin-note" data-order-reason-detail>${esc(orderReason)}</p>`:''}<h3>${esc(displayLabel(p.label))} · ${esc(planNumber(s,p.planId))}</h3><p>意向 ${amount(b.targetYuan)}亿＝已成交 ${amount(b.filledYuan)}亿＋锁定 ${amount(b.lockedYuan)}亿＋尚可安排 ${amount(b.arrangeableYuan)}亿。</p><p>业务类型：${esc(types[p.businessType])}；方向：${p.direction==='inflow'?'回笼':'流出'}；计划版本 ${p.version}。</p><p>对象：${esc(planSummary(s,p.planId))}。</p><p>期限与参数：${esc(displayTermsNote(p.termsNote)||'待补')}。</p><p>关联规则：资金实际可用、目标守恒、审核版本；${s.initialData?.demoMode==='single-day-principal-v1'?'按当前银行主体核验现金、集中度和期限，逐项依据见核心规则。':p.businessType==='deposit'&&(p.issuerId||(p.counterpartyId))==='BANK-A'?`本项为A银行存款，适用投前严格大于${ratioPercent(s.ruleConfig.depositThreshold)}%的当前限制。`:'A银行存款专属禁令不适用于本项；其余正式指标待接入。'}</p><p class="warning">建议和路径按当前输入测算；名义金额不默认等于结算现金。</p><button data-edit="${escRaw(id)}">编辑此计划</button>${technicalDetails({'原始计划名称':p.label,'计划编号':p.planId,'发行人编号':p.issuerId,'对手编号':p.counterpartyId})}`);}
function reviewDialog(){
 const s=model.getState();if(!s.canApprove)return;
 const eligible=new Set(s.approvalEligibleStepIds),reviewSteps=s.proposal.steps.filter(st=>eligible.has(st.stepId));
 const rows=reviewSteps.map(st=>{const p=s.plans.find(x=>x.planId===st.planId);return `<tr><td><b>${esc(stepName(s,st))}</b><small>${esc(planNumber(s,st.planId))} · 计划版本${p.version}</small></td><td>${esc(objectName(p.counterpartyId||p.issuerId))}<small>${esc(displayLabel(p.label))} · ${p.direction==='outflow'?'流出':'回笼'}</small></td><td>${amount(st.nominalYuan)}</td><td>${esc(conditionText(s,st))}<small>${esc(displayTermsNote(p.termsNote)||'期限/正式参数待补')}</small></td></tr>`;}).join('');
 openDialog('审核指令包',`<p class="origin-note">${esc(displayLabel(s.initialData?.label)||scenarioNames[s.scenarioId]||'当前场景')} · ${esc(s.context.businessDate)} · ${esc(displayLabel(s.initialData?.portfolio?.label)||'货币组合')}<br>当前建议 · 版本${s.proposal.version}<br>规则 ${esc(s.rulesVersion)} / 副本v${s.ruleConfig?.version||1} · 偏好v${s.preferences.version}。此次只审核下表可行或附条件步骤；阻断部分保留意向金额，不在审核范围内。确认时自动核对并刷新当前数据，随后可一次手动批量下达当前可行部分。</p><div class="table-scroll"><table><thead><tr><th>指令 / 计划版本</th><th>对象与方向</th><th>金额（亿）</th><th>条件与必要参数</th></tr></thead><tbody>${rows}</tbody></table></div>${technicalDetails({'建议编号':s.proposal.proposalId,'原始步骤':s.proposal.steps})}<p class="warning">${esc(readableText(s,(s.proposal.conflicts||[]).join('；')))} </p><form id="review-form"><label class="checkline"><input type="checkbox" required>我已核对具体对象、金额、顺序、条件及上述预警，确认本次审核。</label>${formFooter('确认审核')}</form>`);
 $('review-form').onsubmit=e=>{e.preventDefault();try{model.approveProposal();closeDialog();changed('审核已记录，当前数据已核对；当前可行步骤可一次手动批量下达。');}catch(error){formError(error);}};
}
function preferencesDialog(){let order=[...model.getState().preferences.orderedKeys];order=[...order,...['settlement_safety','fewer_warnings','metric_headroom'].filter(k=>!order.includes(k))];openDialog('经理偏好与优先级','<p>硬约束优先于偏好。调整排序会使相关审核失效；刷新计算时按偏好逐级比较候选。正式硬指标余量尚未定义。</p><div id="preferences-list"></div><form id="pref-form">'+formFooter('保存偏好顺序')+'</form>');const redraw=()=>{$('preferences-list').innerHTML=order.map((k,i)=>`<div class="pref-row"><b>${i+1}</b><span>${prefNames[k]}</span><button type="button" data-up="${i}" ${i===0?'disabled':''}>上移</button><button type="button" data-down="${i}" ${i===order.length-1?'disabled':''}>下移</button></div>`).join('');};redraw();$('preferences-list').onclick=e=>{const up=e.target.closest('[data-up]'),down=e.target.closest('[data-down]');if(!up&&!down)return;const i=Number(up?up.dataset.up:down.dataset.down),j=up?i-1:i+1;[order[i],order[j]]=[order[j],order[i]];redraw();};$('pref-form').onsubmit=e=>{e.preventDefault();try{model.setPreferences(order);closeDialog();changed('偏好顺序已保存，相关指令需按所选审核流程重新核对。');}catch(error){formError(error);}};}
function settingsDialog(){const s=model.getState(),v=s.inputs||{};openDialog('数据与场景存储',`<p class="origin-note">编辑当前场景运行副本，期初模板不变。金额以元输入；空值保留未知，不补零。自定义输入将在刷新建议时重新计算。非零费用可参与资金投影；费用分配与结算规则未提供时，不开放该副本的下达。</p>${s.initialData?.provenance.kind==='synthetic'?'<p>当前使用期初模板运行。请到“初始数据”维护起点，并新建运行使其生效；已有交易事实保留。</p>':''}<form id="inputs-form" ${s.initialData?.provenance.kind==='synthetic'?'hidden':''}><div class="form-grid">${[['initialCashYuan','期初实际账户现金'],['navYuan','净资产'],['bankExposureYuan','A银行初始敞口'],['feeYuan','费用'],['bufferYuan','安全垫']].map(([k,n])=>`<label>${n}（元）<input name="${k}" inputmode="numeric" value="${v[k]??''}" placeholder="待补"></label>`).join('')}</div>${formFooter('保存输入')}</form><hr><p>${workspace?.isCloud()?'当前个人运行自动保存到云端，状态见个人空间。':'每个场景有独立本地存档。'}保存计划、审核、指令与事件流水。</p><div class="storage-grid"><button data-action="save">保存当前场景</button><button data-action="load">加载当前场景存档</button><button data-action="export">导出JSON</button><button id="import-button">导入JSON</button><input type="file" id="import-file" accept=".json,application/json" hidden><button data-action="reset" class="negative">重置当前运行副本</button></div><p class="muted">${workspace?.isCloud()?'普通编辑自动保存；关闭前请确认个人空间已保存，离线变更请导出备份。':'手动保存；关闭页面前请保存。'}重置不会删除其他场景或已有存档。导入会严格验证版本和金额/引用，不接受未知结构。</p>`);
 $('inputs-form').onsubmit=e=>{e.preventDefault();try{const fd=new FormData(e.target),inputs={};for(const k of ['initialCashYuan','navYuan','bankExposureYuan','feeYuan','bufferYuan'])inputs[k]=parseMoney(fd.get(k),'元',true);model.setInputs(inputs);closeDialog();changed('输入已保存；请刷新计算。');}catch(error){formError(error);}};
 $('import-button').onclick=()=>$('import-file').click();$('import-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>2e6)throw new Error('存档超过2MB，未读取。');const text=await readScopedFile(file),data=JSON.parse(text),check=validateSaved(data);if(!check.ok)throw new Error(check.errors.join('；'));openDialog('确认恢复存档',`<p>文件：${esc(file.name)}。验证通过，将覆盖当前运行副本，尚未保存的修改会丢失。</p><button id="confirm-import" class="primary">恢复已验证存档</button>`);$('confirm-import').onclick=()=>{try{initialUI.preserve();model.load(data);closeDialog();changed('运行记录已从文件恢复。');}catch(error){formError(error);}};}catch(error){formError(error);}};
}
function progressDialog(){const s=model.getState();openDialog('选择预置进度快照',`<p class="origin-note">切换仅替换已定义的进度快照，展示名义与现金勾稽，不是发送、成交或撤单事件。自定义计划无法套用预置快照。</p><div class="progress-options">${s.progressOptions.map(p=>`<button data-progress="${escRaw(p.id)}" ${s.progressId===p.id?'disabled':''}>${esc(displayLabel(p.label))}<small>${s.progressId===p.id?'当前快照':'预置快照'}</small></button>`).join('')}</div><div id="form-error" class="form-error" role="alert"></div>`);}
function save(){if(workspace?.isCloud()){workspace.save().catch(formError);return;}const s=model.getState();localStore.setItem(storageKey(s.scenarioId),model.serialize());dirty=false;log('手动保存当前运行');render();notify('当前场景已保存到此浏览器。');}
function load(){if(workspace?.isCloud()){workspace.show();return;}const s=model.getState(),text=localStore.getItem(storageKey(s.scenarioId));if(!text)throw new Error('当前场景尚无本地存档。');const parsed=JSON.parse(text);if(parsed.scenarioId!==s.scenarioId)throw new Error('存档场景不匹配，未加载。');const check=validateSaved(parsed);if(!check.ok)throw new Error('存档验证失败：'+check.errors.join('；'));if($('dialog').open)closeDialog();openDialog('加载当前场景存档','<p>将恢复保存时的计划、输入、偏好、审核和已登记的执行事实；当前未保存修改会被覆盖。</p><button id="confirm-load" class="primary">确认加载</button>');$('confirm-load').onclick=()=>{try{initialUI.preserve();model.load(text);activity.set(model.getState().scenarioId,[]);dirty=false;log('加载运行存档');workspace?.stageCurrent();closeDialog();render();notify('存档已恢复。');}catch(error){formError(error);}};}
function rulesDialog(){if(model.getState().coreRules?.enabled){coreUI.rulesDialog();return;}const config=model.getState().ruleConfig;openDialog('历史规则目录',`<p>${rules.length}条已定义的计算、状态与下达控制规则。此处为历史规则范围，请核对具体适用条件。</p><button id="edit-rules">编辑当前副本阈值</button><p>当前副本：存款禁令 ${esc(config?.depositThreshold||'0.08')}；软观察线 ${esc(config?.observationThreshold||'0.082')}（十进制比例）。修改后刷新计算，原审核失效。</p><div class="table-scroll"><table><thead><tr><th>规则名称</th><th>适用动作 / 时点</th><th>公式与边界</th></tr></thead><tbody>${rules.map(r=>`<tr><td><b title="${esc(r.ruleId)}">${esc(ruleName(r.ruleId))}</b></td><td>${esc(ruleScope(r))}<small>${esc(r.evaluationPoints.map(k=>evaluationNames[k]||'其他校验时点').join(' / '))}</small></td><td>${esc(ruleEffect(r))}${technicalDetails({'规则编号':r.ruleId,'原始公式':r.formula,'来源':r.sourceRef})}</td></tr>`).join('')}</tbody></table></div>`);$('edit-rules').onclick=()=>{closeDialog();ruleEditDialog();};}
function ruleEditDialog(){
 const c=model.getState().ruleConfig;
 const percent=r=>{const [w,f='']=r.split('.');const digits=(BigInt(w)*1000000000000n+BigInt(f.padEnd(12,'0')))*100n;const whole=digits/1000000000000n,frac=(digits%1000000000000n).toString().padStart(12,'0').replace(/0+$/,'');return whole+(frac?'.'+frac:'');};
 const ratio=text=>{if(!/^\d+(\.\d{1,10})?$/.test(text))throw new Error('请输入0到100之间的百分数，最多10位小数。');const [w,f='']=text.split('.');const n=BigInt(w)*10000000000n+BigInt(f.padEnd(10,'0'));if(n<=0n||n>1000000000000n)throw new Error('阈值须大于0且不超过100%。');return (n/1000000000000n).toString()+'.'+(n%1000000000000n).toString().padStart(12,'0').replace(/0+$/,'').padEnd(1,'0');};
 openDialog('编辑规则阈值',`<p class="origin-note">仅修改当前运行副本，原规则配置不变。比较符固定：新增A银行存款投前严格大于；观察线投后大于等于。修改后原审核失效，需重新计算。</p><form id="rule-form"><div class="form-grid"><label>存款投前禁令阈值（%）<input name="deposit" value="${percent(c.depositThreshold)}" required></label><label>投后软观察线（%）<input name="observe" value="${percent(c.observationThreshold)}" required></label></div>${formFooter('保存规则副本')}</form>`);
 $('rule-form').onsubmit=e=>{e.preventDefault();try{const fd=new FormData(e.target);model.setRuleConfig({depositThreshold:ratio(fd.get('deposit').trim()),observationThreshold:ratio(fd.get('observe').trim())});closeDialog();changed('规则副本已修改；审核失效，请刷新计算。');}catch(error){formError(error);}};
}
function simpleSettingsDialog(){openDialog('数据与存储',`<p>当前运行来自单日模板。调整起点、净申赎和安全垫请到“初始数据”保存模板并新建运行；现有交易与回报事实保留。</p><div class="storage-grid"><button data-action="save">保存当前运行</button><button data-action="load">加载当前运行存档</button><button data-action="export">导出JSON</button><button id="import-button">导入JSON</button><input type="file" id="import-file" accept=".json,application/json" hidden><button data-action="reset" class="negative">重置当前运行副本</button></div><div id="form-error" class="form-error" role="alert"></div>`);$('import-button').onclick=()=>$('import-file').click();$('import-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>2e6)throw new Error('存档超过2MB，未读取。');const data=JSON.parse(await readScopedFile(file)),check=validateSaved(data);if(!check.ok)throw new Error(check.errors.join('；'));closeDialog();openDialog('确认恢复存档',`<p>${esc(file.name)}已通过校验。恢复前将保存当前运行到历史。</p><button id="confirm-import" class="primary">恢复已验证存档</button>`);$('confirm-import').onclick=()=>{try{initialUI.preserve();model.load(data);closeDialog();changed('运行记录已从文件恢复。');}catch(error){formError(error);}};}catch(error){formError(error);}};}
function simpleAssumptionsDialog(){const s=model.getState();openDialog('单日业务口径',`<p>业务日 ${esc(s.context.businessDate)}。日初业务可用包含净申赎和全部当日到期收付；未到账款仍计入业务头寸，实际付款按已到账账户现金核对。</p><p>每笔计划与到期事件独立。预计日终假设当前所有计划全部成交并完成收付，包含尚未发送或当前受阻的计划；这不是可用现金或下达承诺。</p><p>交易金额按元整数，本金与结算现金同额，不计利息和费用。回购期限及证券剩余期限均按填写天数，90天和一年365天直接使用标示天数。</p><p>现金比例和基金集中度以基金净值为分母；C09期限以基金净值加存续正回购本金为分母。可选择跳过独立人工审核动作；计算、手动下达及最新资金、规则和依赖核对仍须完成。本运行由初始数据模板及人工录入事件形成；交易指令与回报尚未连接交易系统。</p>`);}
const actions={
 'repo-settings':repoSettingsDialog,send:sendDialog,funding:fundingDialog,snapshot:snapshotDialog,'add-plan':()=>planDialog(),preferences:preferencesDialog,settings:settingsDialog,review:reviewDialog,progress:progressDialog,rules:rulesDialog,save,load,
 preview:()=>runCalculation(),
 assumptions:()=>{const s=model.getState();openDialog('业务口径与来源',`<p>${esc(displayLabel(s.initialData?.label)||'当前场景')}：按当前运行的期初模板、计划及已登记事实计算。</p><p>业务日 ${esc(s.context.businessDate)}，实际期初账户 ${amount(s.inputs.initialCashYuan)}亿，业务日初可用 ${amount(s.summary.openingBusinessAvailableYuan)}亿；含当日到期未到账款。实时头寸另扣导入的期初缴款与交收义务。</p><p>预计日终是假设今日计划全部成交且收付完成的投影，尚未成交回款不能当作当前现金。今日T+1用款按未来交收日检查，实际付款独立核验账户现金。一级存单为已确认认购，只安排缴款；二级存单归现券。</p><p>金额按元整数，未知留空。当前场景持仓、名义与现金按同额测算；期限按当前期限字段及交收日计算。新模板使用十条已定义规则与完整期限权重；旧场景保留原规则基线。交易指令与回报按已核对的事实登记。</p>`);},
 export:()=>{const blob=new Blob([model.serialize()],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`zhihui-${model.getState().scenarioId}-ui.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('当前运行记录已导出。');},
 reset:()=>{if($('dialog').open)closeDialog();openDialog('重置当前运行副本','<p>将当前账号的初始模板和运行副本统一重置为“补救案例（未预设卖券）”：5笔初始计划，不含卖券。原运行及成交记录先保留至历史，新副本清除交易进度和审核；不再沿用旧运行或自定义模板。此操作仅影响当前账号。</p><button id="confirm-reset" class="primary">确认重置为无卖券案例</button>');$('confirm-reset').onclick=()=>{try{if(workspace&&!workspace.canEdit())throw new Error('请先处理账号或同步状态，再重置运行。');initialUI.resetToDefault();activity.set(model.getState().scenarioId,[]);closeDialog();render();}catch(error){formError(error);}};}
};
document.addEventListener('click',e=>{
 try{
  if(e.target.closest('#execution-batch-fill')){executionBatchDialog('fill');return;}
  if(e.target.closest('#execution-batch-settle')){executionBatchDialog('settle');return;}
  const group=e.target.closest('[data-toggle-group]'),newType=e.target.closest('[data-new-type]');
  if(group){const type=group.dataset.toggleGroup;if(expandedGroups.has(type))expandedGroups.delete(type);else expandedGroups.add(type);renderPlans(model.getState());document.querySelector(`[data-toggle-group="${type}"]`)?.focus();return;}
  if(newType){planDialog(null,newType.dataset.newType);return;}
  const action=e.target.closest('[data-action]'),nav=e.target.closest('[data-screen]'),path=e.target.closest('[data-path]'),sort=e.target.closest('[data-sort]'),edit=e.target.closest('[data-edit]'),detail=e.target.closest('[data-detail]'),record=e.target.closest('[data-record]'),progress=e.target.closest('[data-progress]');
  const eventButton=e.target.closest('[data-event]');
  if(eventButton)eventDialog(eventButton.dataset.event);
  if(nav){
   const fromDialog=nav.closest('#dialog');
   if(fromDialog){
    // The dialog's close event restores focus asynchronously; use the destination tab.
    lastFocus=document.querySelector(`.topbar [data-screen="${nav.dataset.screen}"]`);
    closeDialog();
   }
   screen=nav.dataset.screen;render();
   if(fromDialog){
    document.querySelector(`.topbar [data-screen="${screen}"]`)?.focus();
    document.querySelector(`#${screen}-screen`)?.scrollIntoView({block:'start'});
   }
  }
  if(path&&!path.disabled){runCalculation(path.dataset.path,`已选择${path.textContent.trim()}，已重新计算该路径。`);}
  if(sort){const label=sort.textContent.trim(),mode=sort.dataset.sort,keys=model.getState().preferences.orderedKeys.filter(k=>!businessPreferenceKeys.includes(k));model.setPreferences(mode==='AUTO'?keys:[mode,...keys]);changed('排序偏好已更新，正在重新计算。');runCalculation('AUTO',`已按${label}重新计算；相关指令需按所选审核流程重新核对。`);}
  if(action){const kind=action.dataset.action,simple=model.getState().initialData?.demoMode==='single-day-principal-v1';if(kind==='cancel-calculation'){calculationController.cancel();return;}if(simple&&kind==='settings')simpleSettingsDialog();else if(simple&&kind==='assumptions')simpleAssumptionsDialog();else actions[kind]?.();}
  if(edit){if($('dialog').open)closeDialog();planDialog(edit.dataset.edit);}
  if(detail)detailDialog(detail.dataset.detail,detail.dataset.orderReason||null);
  if(record){const r=records.find(x=>x.id===record.dataset.record);openDialog('记录依据',`<p>${esc(r.source)} · ${esc(r.rule)}</p><p>${esc(r.input)}</p>${technicalDetails({'原始记录':r.detail})}<p>结果：${esc(r.result)}。版本与范围：当前规则与计算依据。</p>`);}
  if(progress){model.selectProgress(progress.dataset.progress);closeDialog();changed('预置进度已切换；两个板块使用同一账目，未发送交易。');}
 }catch(error){formError(error);}
});
document.addEventListener('change',e=>{
 const item=e.target.closest('[data-execution-select]');
 if(item){if(item.checked)executionSelection.add(item.dataset.executionSelect);else executionSelection.delete(item.dataset.executionSelect);renderExecution(model.getState());return;}
 if(e.target.id==='execution-select-all'){
  executionSelection.clear();
  if(e.target.checked)for(const id of Object.keys(model.getState().execution.instructions))executionSelection.add(id);
  renderExecution(model.getState());
 }
});

$('skip-review').addEventListener('change',event=>{skipReview=event.target.checked;render();notify(skipReview?'已跳过人工审核；下达仍按当前金额、顺序、资金和规则校验。':'已恢复人工审核流程。');});
const popover=$('help-popover');let pinnedHelp=null;
function showHelp(button){popover.textContent=displayText(button.dataset.help);popover.hidden=false;const rect=button.getBoundingClientRect();const width=Math.min(320,window.innerWidth-24);popover.style.width=width+'px';popover.style.left=Math.max(12,Math.min(rect.right-width,window.innerWidth-width-12))+'px';const h=popover.getBoundingClientRect().height;popover.style.top=(rect.bottom+h+10<window.innerHeight?rect.bottom+6:Math.max(8,rect.top-h-6))+'px';}
document.addEventListener('pointerover',event=>{const b=event.target.closest('[data-help]');if(b)showHelp(b);});
document.addEventListener('pointerout',event=>{const b=event.target.closest('[data-help]');if(b&&b!==pinnedHelp)popover.hidden=true;});
document.addEventListener('focusin',event=>{const b=event.target.closest('[data-help]');if(b)showHelp(b);});
document.addEventListener('focusout',event=>{const b=event.target.closest('[data-help]');if(b&&b!==pinnedHelp)popover.hidden=true;});
document.addEventListener('click',event=>{const b=event.target.closest('[data-help]');if(b){pinnedHelp=b;showHelp(b);return;}pinnedHelp=null;popover.hidden=true;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){pinnedHelp=null;popover.hidden=true;}});
window.addEventListener('scroll',()=>{if(pinnedHelp?.isConnected)showHelp(pinnedHelp);else popover.hidden=true;},{capture:true,passive:true});
$('scenario').onchange=e=>{try{calculationController.cancel(true);hideCalculationProgress();clearCalculationOutcome();const current=model.getState();runs.set(current.scenarioId,{state:model.serialize(),dirty});const next=e.target.value;if(runs.has(next)){const saved=runs.get(next);model.load(saved.state);dirty=saved.dirty;}else{model.reset(next);model.generateProposal('AUTO');dirty=true;}selectedPlan=null;workspace?.stageCurrent();render();workspace?.refreshStatus();notify('场景已切换，其他场景运行副本保留。');}catch(error){$('scenario').value=model.getState().scenarioId;formError(error);}};
$('rule-records-toggle').onclick=()=>{const expanded=$('rule-records-body').hidden;$('rule-records-body').hidden=!expanded;$('rule-records-toggle').setAttribute('aria-expanded',String(expanded));$('rule-records-toggle').textContent=expanded?'收起记录':'展开记录';};
$('record-filter').onchange=filterRecords;$('record-search').oninput=filterRecords;
async function readScopedFile(file){const epoch=localStore.generation,text=await file.text();if(epoch!==localStore.generation)throw new Error('账号状态已变化，未导入文件。');return text;}
window.addEventListener('beforeunload',e=>{const pending=workspace?.isCloud()?workspace.snapshot().pending:dirty||[...runs].some(([id,run])=>id!==model.getState().scenarioId&&run.dirty);if(pending){e.preventDefault();e.returnValue='';}});
workspace=setupWorkspaceUI({model,initialUI,storage:localStore,$,esc,escRaw,render,notify,onAiStateChange:()=>aiUI?.refresh(),clearPersonal(){calculationController.cancel(true);hideCalculationProgress();clearCalculationOutcome();skipReview=false;skipReviewRun=null;aiUI?.clear();if($('dialog').open)closeDialog();$('dialog-body').replaceChildren();runs.clear();activity.clear();selectedPlan=null;expandedGroups.clear();dirty=false;initialUI.resetStorage();model.startFromTemplate(initialUI.template());screen='desk';},onRestored(){calculationController.cancel(true);hideCalculationProgress();clearCalculationOutcome();skipReview=false;skipReviewRun=null;runs.clear();activity.clear();selectedPlan=null;expandedGroups.clear();dirty=false;},onProfileSort(mode){if(mode&&(mode==='auto'?'AUTO':mode)!==sortingMode(model.getState())){calculationController.cancel(true);hideCalculationProgress();clearCalculationOutcome();const keys=model.getState().preferences.orderedKeys.filter(k=>!businessPreferenceKeys.includes(k));model.setPreferences(mode==='auto'?keys:[mode,...keys]);model.generateProposal('AUTO');render();dirty=true;}return sortingMode(model.getState())==='AUTO'?'auto':sortingMode(model.getState());}});
aiUI=setupAiUI({model,getContext:()=>workspace.getAiContext(),prepareContext:()=>workspace.prepareAiContext(),onAuthError:()=>workspace.verify(),changed,notify});
const workspaceReady=workspace.verify();
try{const response=await fetch('../data/calculation/v2b/rules.json');if(!response.ok)throw new Error('规则目录读取失败');rules=(await response.json()).rules;render();workspace.refreshStatus();await workspaceReady;}catch(error){$('bottom-status').textContent=displayText('加载失败：'+error.message);console.error(error);}

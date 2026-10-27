// D iteration: read-only analysis of the current simulation. Never mutates the ledger.
import { evaluateCoreRules } from './core-rules.js';
import { HISTORICAL_METRICS } from './metric-catalog.js';
import { governmentBondMaturityRatio } from './metric-display.js';

const CORE_IDS = [...Array.from({length:9},(_,i)=>`C${String(i+1).padStart(2,'0')}`), 'C05-DEPOSIT'];
const CORE_NAMES = {
  C01:'业务头寸非负', C02:'现金与一年内政府债至少5%',
  C03:'无托管资格银行存款及存单不超过5%', C04:'有托管资格银行存款及存单不超过20%',
  C05:'全公司货基同银行存款、存单及债券不超过银行净资产10%',
  'C05-DEPOSIT':'新增存款后公司货基同银行存款、存单及银行债占银行净资产，默认6%／该行批准8%',
  C06:'有托管资格银行全部金融工具不超过基金净值15%',
  C07:'BB或BB-银行全部敞口不超过基金净值2%',
  C08:'BB或BB-银行全部敞口不超过银行净资产5%',
  C09:'资产负债正回购调整平均剩余期限不超过90天',
};
const METRIC_IDS = new Set(HISTORICAL_METRICS.map(x=>x.metricId));
const MAX_PREFERENCES = 256;
const subjectKey = key => typeof key === 'string' && key.length <= 80 &&
  /^(?:C01|C02|C09):PORTFOLIO$|^(?:C0[3-8]|C05-DEPOSIT):(?:[A-Za-z0-9_-]{1,64}|UNRESOLVED)$/.test(key);
const validKey = key => METRIC_IDS.has(key) || subjectKey(key);
const uniqueKeys = raw => {
  const seen = new Set(), result = [];
  if (!Array.isArray(raw)) return result;
  for (const key of raw) {
    if (!validKey(key) || seen.has(key)) continue;
    seen.add(key); result.push(key);
    if (result.length === MAX_PREFERENCES) break;
  }
  return result;
};

export function normalizeAnalysisPreferences(raw) {
  const favorites = uniqueKeys(raw?.favorites);
  const favoriteSet = new Set(favorites);
  const order = uniqueKeys(raw?.order).filter(key=>favoriteSet.has(key));
  for (const key of favorites) if (!order.includes(key)) order.push(key);
  return {version:1,favorites,order};
}

export function updateAnalysisPreference(prefs,key,action) {
  const next = normalizeAnalysisPreferences(prefs);
  if (!validKey(key) || !['toggle','up','down'].includes(action)) return next;
  const index = next.order.indexOf(key);
  if (action === 'toggle') {
    if (next.favorites.includes(key)) {
      next.favorites = next.favorites.filter(x=>x!==key);
      next.order = next.order.filter(x=>x!==key);
    } else if (next.favorites.length < MAX_PREFERENCES) {
      next.favorites.push(key);
      next.order.push(key);
    }
    return next;
  }
  if (index < 0) return next;
  const other = action === 'up' ? index-1 : index+1;
  if (other >= 0 && other < next.order.length)
    [next.order[index],next.order[other]] = [next.order[other],next.order[index]];
  return next;
}

const unitFor = (id,state) => id === 'C01' ? 'yuan' : id === 'C09' ? (state?.initialData?.demoMode==='single-day-principal-v1'?'days':'trading_days') : 'ratio';
const statusFor = result => result === 'not_applicable' ? 'notapp' : result;
const validDisplay = value => typeof value === 'number' && Number.isFinite(value) ||
  typeof value === 'string' && /^-?\d+$/.test(value);
const sameProjectedCheck = (actual,trace) => actual && trace &&
  ['ruleId','subjectId','result','currentValue','projectedValue','headroomYuan'].every(k=>
    Object.is(actual[k] ?? null,trace[k] ?? null)) &&
  JSON.stringify(actual.threshold ?? null) === JSON.stringify(trace.threshold ?? null);
const verifiedSettlement = (state,condition,step) => {
  if (condition?.kind !== 'settlement_capacity' || condition.planId !== step.planId ||
      !Number.isSafeInteger(condition.minimumYuan) || condition.minimumYuan < step.nominalYuan ||
      typeof condition.valueDate !== 'string') return false;
  const balances = state.summary?.dateBalances;
  if (!Array.isArray(balances) || !balances.length) return false;
  const base = balances.filter(x=>x.valueDate<=condition.valueDate).at(-1)?.availableYuan;
  return Number.isSafeInteger(base) && base >= condition.minimumYuan &&
    balances.every(x=>x.valueDate<=condition.valueDate ||
      Number.isSafeInteger(x.availableYuan) && x.availableYuan>=condition.minimumYuan);
};

function selectedProjection(state,stepId,currentRows,nowMs) {
  const unavailable = reason => ({available:false,stepId,scope:'selected_step',conditional:false,
    label:'单笔独立测算，未计其他未发计划或前序条件',reason,rows:null});
  if (!stepId) return unavailable('未选择步骤；当前值含已发送预占及已记录成交。');
  if (typeof stepId !== 'string' || !stepId || stepId.length > 2048)
    return unavailable('步骤编号无效。');
  if (!state?.proposal || state.proposal.origin !== 'calculated' || !state.calculation?.trace?.steps)
    return unavailable('缺当前计算建议或逐步记录。');
  const trace = state.calculation.trace;
  if (trace.rulesVersion !== state.rulesVersion || trace.ruleConfigVersion !== state.ruleConfig?.version ||
      trace.preferencesVersion !== state.preferences?.version)
    return unavailable('建议所用配置已变化，请重新计算。');
  if (Number.isSafeInteger(state.revision) && Number.isSafeInteger(trace.snapshotRevision)) {
    const generated = state.revision === trace.snapshotRevision+1;
    const approved = state.revision === trace.snapshotRevision+2 &&
      state.approval?.proposalId === state.proposal.proposalId &&
      state.approvalStatus === 'valid';
    if (!generated && !approved) return unavailable('运行修订已变化，请重新计算建议。');
  }
  const snapshot = state.execution?.snapshot;
  if (state.execution?.requiresRefresh || state.execution?.requiresReapproval ||
      snapshot?.quality !== 'fresh' ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !Number.isSafeInteger(snapshot?.observedAt) || snapshot.observedAt < 0 ||
      nowMs-snapshot.observedAt < 0 || nowMs-snapshot.observedAt > 30000)
    return unavailable('快照过期或时点待核，需刷新并重新计算。');
  const step = state.proposal.steps?.find(x=>x.stepId===stepId);
  const traceStep = trace.steps.find(x=>x.stepId===stepId);
  if (!step || !traceStep || trace.steps[0]?.stepId !== stepId)
    return unavailable('仅支持当前计算路径的首笔步骤；前序路径需逐笔确认。');
  const conditions = step.machineConditions ?? [];
  if (step.blocked || JSON.stringify(conditions)!==JSON.stringify(traceStep.machineConditions ?? []) ||
      conditions.some(x=>!verifiedSettlement(state,x,step)))
    return unavailable('该步骤存在阻断或未兑现的成交、到账等前序条件，不能作为独立投影。');
  if (Object.values(state.execution?.instructions ?? {}).some(x=>x.stepId===stepId && x.status!=='rejected'))
    return unavailable('该步骤已发送或发送结果未明，当前值已包含相应事实。');
  if (!Number.isSafeInteger(step.nominalYuan) || step.nominalYuan<=0 ||
      traceStep.nominalYuan!==step.nominalYuan || traceStep.planId!==step.planId)
    return unavailable('建议与计算记录的步骤金额不一致。');
  const plan = state.plans?.find(x=>x.planId===step.planId);
  if (!plan || !Number.isSafeInteger(state.summary?.availableYuan) ||
      traceStep.beforeCashYuan!==state.summary.availableYuan)
    return unavailable('当前计划或业务头寸已变化，请重新计算。');
  const projected = evaluateCoreRules(state,{plan,amountYuan:step.nominalYuan,
    cashYuan:state.summary.availableYuan});
  if (projected.rows.find(x=>x.ruleId==='C01' && x.subjectId==='PORTFOLIO')?.result!=='pass')
    return unavailable('本笔后的业务头寸或日期预算未通过，不能显示可靠投影。');
  if (!projected.enabled || projected.rows.length!==currentRows.length ||
      !projected.rows.every(row=>sameProjectedCheck(row,traceStep.rules?.find(x=>
        x.ruleId===row.ruleId && x.subjectId===row.subjectId))))
    return unavailable('最新规则结果与建议记录不一致，请重新计算。');
  return {available:true,stepId,scope:'selected_step',conditional:false,
    label:'单笔独立测算，未计其他未发计划或前序条件',
    reason:'仅供观察；发送前仍须用最新状态审核并手动下达。',rows:projected.rows};
}

export function buildAnalysis(state,{stepId=null,nowMs=null}={}) {
  const result = evaluateCoreRules(state);
  const asOfDate = state?.context?.businessDate ?? state?.initialData?.businessDate ?? null;
  const source = state?.initialData?.provenance?.kind === 'synthetic' ? '初始数据与当前账目' :
    '历史场景；C核心规则未启用';
  const projection = result.enabled ? selectedProjection(state,stepId,result.rows,nowMs) :
    {available:false,stepId,scope:'selected_step',conditional:false,
      label:'单笔独立测算，未计其他未发计划或前序条件',
      reason:result.reason ?? 'C核心规则未启用。',rows:null};
  const projected = new Map((projection.rows ?? []).map(x=>[`${x.ruleId}:${x.subjectId}`,x]));
  const coreRows = result.rows.map(row=>{
    const key = `${row.ruleId}:${row.subjectId}`;
    const after = projected.get(key);
    return {key,ruleId:row.ruleId,name:row.name,subjectId:row.subjectId,
      subjectLabel:row.subjectLabel,currentValue:row.currentValue,
      projectedValue:after?.projectedValue ?? null,unit:unitFor(row.ruleId,state),
      threshold:row.threshold,headroomYuan:row.headroomYuan,
      status:statusFor(row.result),projectedStatus:after ? statusFor(after.result) : null,
      reason:row.reason,needed:[...row.needed],source,asOfDate};
  });
  const ruleDirectory = [
    ...CORE_IDS.map(ruleId=>({ruleId,name:CORE_NAMES[ruleId],status:'configured',
      configured:true,source:ruleId==='C05-DEPOSIT'?'2026-10-19用户确认演示口径':'C迭代规则合同',asOfDate})),
    ...Array.from({length:111},(_,i)=>({ruleId:`D${String(i+10).padStart(3,'0')}`,
      name:'待提供',status:'unprovided',configured:false,source:null,asOfDate:null})),
  ];
  const counts = {catalogTotal:121,configuredRules:10,applicableSubjectChecks:0,
    calculatedSubjectChecks:0,missingSubjectChecks:0,unprovidedRules:111,
    historicalMetrics:HISTORICAL_METRICS.length,externalRead:0,
    pass:0,warn:0,block:0,notapp:0};
  for (const row of coreRows) {
    if (row.status === 'notapp') {counts.notapp++;continue;}
    counts.applicableSubjectChecks++;
    if (row.status === 'missing') {counts.missingSubjectChecks++;continue;}
    if (['pass','warn','block'].includes(row.status) && validDisplay(row.currentValue)) {
      counts.calculatedSubjectChecks++;
      counts[row.status]++;
    }
  }
  return {coreRows,ruleDirectory,counts,governmentBondMaturityRatio:governmentBondMaturityRatio(state),
    context:{runId:state?.context?.runId ?? null,businessDate:asOfDate,
      templateKind:state?.initialData?.provenance?.kind ?? null,
      coreEnabled:result.enabled,source,asOfDate},
    projection,historicalMetrics:HISTORICAL_METRICS};
}

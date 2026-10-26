// C iteration demonstration rules. All threshold decisions use integer cross products.
import { bankIdForPlan, deriveTemplateExposure, SINGLE_DAY_DEMO_MODE, bankDepositLimitBps } from './initial-data.js';
import { executionSummary } from './execution.js';

const NAMES = {
  C01:'业务头寸非负', C02:'现金与一年内政府债至少5%',
  C03:'无托管资格银行存款及存单不超过5%', C04:'有托管资格银行存款及存单不超过20%',
  C05:'全公司货基同银行存款、存单及债券不超过银行净资产10%',
  'C05-DEPOSIT':'新增存款后全公司货基同银行存款、存单及银行债不超过该银行配置上限（通常6%、批准后8%）',
  C06:'有托管资格银行全部金融工具不超过基金净值15%',
  C07:'BB或BB-银行全部敞口不超过基金净值2%',
  C08:'BB或BB-银行全部敞口不超过银行净资产5%',
  C09:'资产负债正回购调整平均剩余期限不超过90交易日',
};
const valid = n => Number.isSafeInteger(n) && n >= 0;
const signed = n => Number.isSafeInteger(n);
const out = n => n === null ? null : n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : n.toString();
const plus = (a,b) => a === null || b === null ? null : a + b;
const row = (ruleId, subjectId, subjectLabel, extra = {}) => ({
  ruleId,name:NAMES[ruleId],subjectId,subjectLabel,result:'not_applicable',currentValue:null,
  projectedValue:null,threshold:null,numeratorYuan:null,denominatorYuan:null,headroomYuan:null,
  needed:[],reason:'',...extra,
});
const miss = (r, needed, reason) => ({...r,result:'missing',needed:[...new Set(needed)],reason});
const bankKind = s => s?.instrumentKind === 'deposit' ? 'depositYuan' : s?.instrumentKind === 'cd' ? 'cdYuan' :
  s?.instrumentKind === 'bond' ? 'bondYuan' : 'otherYuan';
const commitment = i => i.status === 'rejected' ? 0 : i.nominalYuan - i.cancelledYuan;
const isBankTrade = p => ['deposit','cd_buy','cd_sell','bond_buy','bond_sell'].includes(p?.businessType);
const bankRequired = (p,s) => ['deposit','cd_buy','cd_sell'].includes(p?.businessType) ||
  (['bond_buy','bond_sell'].includes(p?.businessType) && !['non_bank','government'].includes(s?.issuerType));
const isPurchase = p => p?.direction === 'outflow';
const isSale = p => p?.direction === 'inflow' && ['cd_sell','bond_sell'].includes(p?.businessType);
const isFinancing = p => ['interbank_repo_financing','exchange_repo_financing'].includes(p?.businessType);
const isRepoAsset = p => ['reverse_repo','exchange_repo_lending'].includes(p?.businessType);
const amount = n => valid(n) ? BigInt(n) : null;
const ratioRow = (r,current,projected,denominator,pct,comparator = 'max') => {
  const missing = [];
  if (current === null || projected === null) missing.push('exposureYuan');
  if (denominator === null || denominator <= 0n) missing.push('denominatorYuan');
  if (missing.length) return miss(r,missing,'敞口或分母缺失，不能判定');
  const [rate,base] = pct;
  const currentPass = comparator === 'max' ? current*base <= denominator*rate : current*base >= denominator*rate;
  const projectedPass = comparator === 'max' ? projected*base <= denominator*rate : projected*base >= denominator*rate;
  const limit = comparator === 'max' ? denominator*rate/base :
    (denominator*rate+base-1n)/base;
  const headroom = comparator === 'max' ? limit-projected : projected-limit;
  return {...r,result:projectedPass?'pass':'block',currentValue:Number(current)/Number(denominator),
    projectedValue:Number(projected)/Number(denominator),threshold:{operator:comparator==='max'?'≤':'≥',
      numerator:Number(rate),denominator:Number(base)},numeratorYuan:out(projected),
    denominatorYuan:out(denominator),headroomYuan:out(headroom),needed:[],
    reason:projectedPass ? (currentPass?'阈值内':'交易后达到阈值') : '交易后违反阈值'};
};

export function coreRulesEnabled(state) {
  return state?.initialData?.provenance?.kind === 'synthetic';
}

// Opening holdings are authoritative. Confirmed opening trades enter only if not included there.
// Sent purchases reserve the whole un-cancelled nominal; sales release only confirmed fills.
export function buildCoreContext(state,{projectedActions=[]}={}) {
  const t = state.initialData, exposure = deriveTemplateExposure(t), securities = new Map(t.securities.map(s=>[s.securityId,s]));
  const oneYearDays = t.demoMode===SINGLE_DAY_DEMO_MODE ? 365 : 252;
  const banks = new Map(t.banks.map(b=>[b.bankId,b]));
  const bankAmounts = new Map(t.banks.map(b=>[b.bankId,{
    depositYuan:amount(exposure.byBank[b.bankId].depositYuan),
    cdYuan:amount(exposure.byBank[b.bankId].cdYuan),
    bondYuan:amount(exposure.byBank[b.bankId].bondYuan),
    otherYuan:amount(exposure.byBank[b.bankId].otherYuan)}]));
  let gov = amount(exposure.governmentBondWithinYearYuan);
  const adjustments=[],unresolved=[],depositGateEvents=[];
  for (const h of t.holdings) {
    const s=securities.get(h.securityId);
    if (!s?.issuerBankId && ['deposit','cd','bond','abs'].includes(s?.instrumentKind) &&
        !['non_bank','government'].includes(s?.issuerType)) unresolved.push(h.holdingId);
  }
  const add = (bankId,kind,delta) => {
    const bucket=bankAmounts.get(bankId); if (!bucket) return;
    bucket[kind]=plus(bucket[kind],delta);
  };
  const securityDelta = (plan,rawAmount,active) => {
    const q=amount(rawAmount), s=securities.get(plan.securityId);
    const bankId=bankIdForPlan(plan,t);
    if (!bankId && bankRequired(plan,s)) unresolved.push(plan.planId ?? plan.tradeId ?? 'unknown');
    if (bankId && isBankTrade(plan)) {
      const kind=bankKind(s ?? {instrumentKind:plan.businessType==='deposit'?'deposit':
        plan.businessType.startsWith('cd_')?'cd':null});
      add(bankId,kind,q===null?null:isPurchase(plan)?q:-q);
    }
    if (s?.isGovernmentBond) {
      if (s.remainingTradingDays === null) gov=null;
      else if (s.remainingTradingDays <= oneYearDays && isSale(plan)) gov=plus(gov,q===null?null:-q);
    }
    adjustments.push({plan,amountYuan:rawAmount,active});
  };
  for (const x of t.pendingSettlements) if (!x.holdingIncludedAtOpen) {
    securityDelta({...x,direction:x.direction},x.amountYuan,'opening_confirmed');
  }
  for (const i of Object.values(state.execution?.instructions ?? {})) {
    const p=state.plans?.find(x=>x.planId===i.planId);
    if (!p || i.status==='rejected') continue;
    if (isPurchase(p)) {
      securityDelta(p,commitment(i),'sent_reserved');
      const s=securities.get(p.securityId);
      if (s?.isGovernmentBond && s.remainingTradingDays!==null && s.remainingTradingDays<=oneYearDays)
        gov=plus(gov,amount(i.settledYuan));
    }
    else if (isSale(p) && i.filledYuan>0) securityDelta(p,i.filledYuan,'filled_sale');
    else if (isFinancing(p) && i.filledYuan>0) securityDelta(p,i.filledYuan,'filled_financing');
  }
  for (const a of projectedActions) {
    if (!a?.plan) continue;
    if (a.plan.businessType==='deposit' && a.amountYuan!==0) {
      const bankId=bankIdForPlan(a.plan,t), before=bankAmounts.get(bankId);
      depositGateEvents.push({bankId,before:before?{...before}:null,amountYuan:a.amountYuan});
      if (!bankId) unresolved.push(a.plan.planId ?? 'projected_deposit');
    }
    if (!valid(a.amountYuan)) continue;
    if (isPurchase(a.plan) || isSale(a.plan) || isFinancing(a.plan)) {
      securityDelta(a.plan,a.amountYuan,'projected');
    }
  }
  const currentCash = state.summary && Object.hasOwn(state.summary,'availableYuan') ? state.summary.availableYuan :
    (state.execution ? executionSummary(state.execution,state.plans,{businessDate:state.context?.businessDate ?? t.businessDate}).availableYuan : null);
  return {t,securities,banks,bankAmounts,gov,adjustments,currentCash,unresolved,depositGateEvents};
}

const total = (...values) => values.some(x=>x===null) ? null : values.reduce((a,b)=>a+b,0n);
const within = (x,limit) => x!==null && limit!==null && x<=limit;

function termLedger(t,adjustments,currentPlan,amountYuan) {
  const weights=t.termWeights;
  const singleDay=t.demoMode===SINGLE_DAY_DEMO_MODE;
  const matured=new Set(singleDay ? t.maturityCashEvents
    .filter(x=>x.dueDate===t.businessDate && x.sourceHoldingId).map(x=>x.sourceHoldingId) : []);
  if (!weights || weights.coverage!=='complete') return {missing:['termWeights'],reason:'缺完整资产负债权重输入'};
  if (weights.asOfDate!==t.businessDate)
    return {missing:['termWeights.asOfDate'],reason:'期限权重基准日与业务日不一致'};
  const unmatched=[...weights.liabilities];
  for (const x of weights.positiveRepos) {
    const index=unmatched.findIndex(y=>y.amountYuan===x.amountYuan &&
      y.remainingTradingDays===x.remainingTradingDays);
    if (index<0) return {missing:[`termWeights.positiveRepos.${x.weightId}`],
      reason:'正回购调整金额及期限缺对应负债权重'};
    unmatched.splice(index,1);
  }
  const linked=weights.assets.filter(x=>x.sourceHoldingId);
  for (const h of t.holdings) {
    const match=linked.filter(x=>x.sourceHoldingId===h.holdingId);
    const s=t.securities.find(x=>x.securityId===h.securityId);
    if (match.length!==1 || match[0].amountYuan!==h.amountYuan ||
        (!matured.has(h.holdingId) && match[0].remainingTradingDays!==s?.remainingTradingDays))
      return {missing:[`termWeights.holding.${h.holdingId}`],reason:'期初持仓与期限权重金额或期限不一致'};
  }
  const cashWeights=weights.assets.filter(x=>x.sourceAccountCash);
  if (cashWeights.length!==1 || cashWeights[0].amountYuan!==t.portfolio.accountCashYuan ||
      cashWeights[0].remainingTradingDays!==0)
    return {missing:['termWeights.accountCash'],reason:'期初账户现金与期限权重不一致'};
  let asset=0n, liability=0n, repo=0n, assetDay=0n,liabilityDay=0n,repoDay=0n;
  for (const [name,rows] of [['asset',weights.assets],['liability',weights.liabilities],['repo',weights.positiveRepos]]) {
    for (const x of rows) {
      if (!valid(x.amountYuan)||(!valid(x.remainingTradingDays) && !(name==='asset' && matured.has(x.sourceHoldingId))))
        return {missing:[`termWeights.${name}.${x.weightId}`],reason:'期限权重金额或期限未知'};
      const a=BigInt(x.amountYuan),d=BigInt(name==='asset' && matured.has(x.sourceHoldingId) ? 0 : x.remainingTradingDays);
      if (name==='asset') {asset+=a;assetDay+=a*d;}
      else if (name==='liability') {liability+=a;liabilityDay+=a*d;}
      else {repo+=a;repoDay+=a*d;}
    }
  }
  if (t.portfolio.navYuan===null || asset-liability!==BigInt(t.portfolio.navYuan))
    return {missing:['termWeights.netAssets'],reason:'期初资产权重减负债权重与基金净值不一致'};
  // A linked same-day repayment enters business cash at opening even before actual payment.
  // Retire its zero-day liability/repo and spend zero-day assets exactly once here;
  // receipt/payment facts only move actual account cash and never reapply term weights.
  const maturedLiabilities=new Set(),maturedRepos=new Set();
  for (const e of singleDay ? t.maturityCashEvents : []) {
    if (e.sourceLiabilityWeightId==null && e.sourcePositiveRepoWeightId==null) continue;
    const l=weights.liabilities.find(x=>x.weightId===e.sourceLiabilityWeightId);
    const r=weights.positiveRepos.find(x=>x.weightId===e.sourcePositiveRepoWeightId);
    if (e.dueDate!==t.businessDate || e.kind!=='repo_maturity' || e.direction!=='outflow' || e.sourceHoldingId ||
        !valid(e.amountYuan) || !l || !r || l.amountYuan!==e.amountYuan || r.amountYuan!==e.amountYuan ||
        l.remainingTradingDays!==0 || r.remainingTradingDays!==0 ||
        maturedLiabilities.has(l.weightId) || maturedRepos.has(r.weightId))
      return {missing:[`maturityCashEvents.${e.eventId}.repoWeights`],reason:'正回购到期缺有效、同额、0天且未重复的负债及正回购关联'};
    maturedLiabilities.add(l.weightId);maturedRepos.add(r.weightId);
    const a=BigInt(e.amountYuan);asset-=a;liability-=a;repo-=a;
  }
  const openingNum=assetDay-liabilityDay+repoDay,openingDen=asset-liability+repo;
  const apply = (p,rawAmount,active) => {
    if (!valid(rawAmount)) return {missing:['amountYuan'],reason:'交易金额未知'};
    const a=BigInt(rawAmount), s=t.securities.find(x=>x.securityId===p.securityId);
    const days=isFinancing(p)||isRepoAsset(p) ? p.repoTerms?.tenorDays : s?.remainingTradingDays;
    if (!valid(days)) return {missing:[p.securityId?'remainingTradingDays':'repoTerms.tenorDays'],reason:'交易期限未知'};
    const d=BigInt(days);
    // Financing adds zero-day cash and the same amount/tenor to liability and repo.
    // Their day weights cancel; the denominator still increases by the financing.
    // Lending spends zero-day cash and adds amount * tenor to the asset day weight.
    if (isFinancing(p)) { asset+=a;liability+=a;repo+=a;liabilityDay+=a*d;repoDay+=a*d; }
    else if (isRepoAsset(p)) assetDay+=a*d;
    else if (isPurchase(p)) assetDay+=a*d;
    else if (isSale(p)) assetDay-=a*d;
    return null;
  };
  for (const a of adjustments) {
    const error=apply(a.plan,a.amountYuan,a.active); if (error) return error;
  }
  const currentNum=assetDay-liabilityDay+repoDay,currentDen=asset-liability+repo;
  if (currentPlan && amountYuan>0) {const error=apply(currentPlan,amountYuan,'candidate');if(error)return error;}
  return {openingNum,openingDen,currentNum,currentDen,projectedNum:assetDay-liabilityDay+repoDay,
    projectedDen:asset-liability+repo};
}

export function evaluateCoreRules(state,{plan=null,amountYuan=0,projectedActions=[],cashYuan}={}) {
  if (!coreRulesEnabled(state)) return {enabled:false,rows:[],blocking:[],missing:[],reason:'历史S10/S13场景保留原规则，未接入C01–C09'};
  const c=buildCoreContext(state,{projectedActions});
  const singleDay=c.t.demoMode===SINGLE_DAY_DEMO_MODE;
  const rows=[],comparisons=[],nav=amount(c.t.portfolio.navYuan), q=amount(amountYuan), candidate=plan && amountYuan>0;
  // Keep BigInt comparisons local: rows are serialized by the model and UI.
  const track=(index,current,projected,currentDen,projectedDen,rate,base,minimum=false)=>{
    if (current===null || projected===null || currentDen===null || projectedDen===null ||
        currentDen<=0n || projectedDen<=0n) return;
    const currentBreached=minimum ? current*base<currentDen*rate : current*base>currentDen*rate;
    const projectedBreached=minimum ? projected*base<projectedDen*rate : projected*base>projectedDen*rate;
    const delta=projected*currentDen-current*projectedDen;
    comparisons.push({index,currentBreached,projectedBreached,
      trend:delta===0n?0:(minimum ? delta>0n : delta<0n)?1:-1});
  };
  const pushRatio=(r,current,projected,den,pct,comparator='max')=>{
    const checked=ratioRow(r,current,projected,den,pct,comparator);
    rows.push(checked);
    if (checked.result==='pass' || checked.result==='block')
      track(rows.length-1,current,projected,den,den,pct[0],pct[1],comparator==='min');
  };
  const beforeCash= cashYuan===undefined ? c.currentCash : cashYuan;
  const cash= signed(beforeCash)?BigInt(beforeCash):null;
  const today=state.context?.businessDate ?? c.t.businessDate;
  const todaySettlement=!plan?.settlementDate || plan.settlementDate<=today;
  const cost=candidate && isPurchase(plan) && todaySettlement?q:0n;
  const afterCash=cash===null||cost===null?null:cash-cost;
  // Assess both financing and security sales under the same fill premise. This
  // projection never credits the ledger; only confirmed fills change business cash.
  const c01Cash=singleDay && candidate && (isFinancing(plan)||isSale(plan)) && todaySettlement ?
    (afterCash===null || q===null ? null : afterCash+q) : afterCash;
  const futureRows=candidate && isPurchase(plan) && !todaySettlement ?
    (state.summary?.dateBalances ?? []).filter(x=>x.valueDate>=plan.settlementDate) : [];
  const futureUnknown=futureRows.some(x=>!signed(x.availableYuan));
  const futureFloor=futureRows.length && q!==null && futureRows.every(x=>signed(x.availableYuan)) ?
    futureRows.reduce((low,x)=>{const v=BigInt(x.availableYuan)-q;return low===null||v<low?v:low;},null) : null;
  let r=row('C01','PORTFOLIO',c.t.portfolio.label,{threshold:{operator:'≥',valueYuan:0}});
  const c01After=futureFloor===null?c01Cash:futureFloor;
  rows.push(cash===null || c01After===null || futureUnknown ?
    miss(r,[futureUnknown?'dateBalances.availableYuan':'businessCashYuan'],'业务头寸或未来日期预算未知') :
    {...r,result:c01After>=0n?'pass':'block',currentValue:out(cash),projectedValue:out(c01After),
      numeratorYuan:out(c01After),headroomYuan:out(c01After),valueDate:futureFloor===null?today:plan.settlementDate,
      reason:c01After>=0n?'头寸非负':'下达后头寸为负'});
  if (!futureUnknown) track(rows.length-1,cash,c01After,1n,1n,0n,1n,true);
  let currentGov=c.gov,projectedGov=c.gov;
  if (candidate && plan.securityId) {
    const s=c.securities.get(plan.securityId);
    if (s?.isGovernmentBond && s.remainingTradingDays===null) projectedGov=null;
    else if (s?.isGovernmentBond && s.remainingTradingDays<=(singleDay?365:252) && isSale(plan))
      projectedGov=plus(projectedGov,q===null?null:-q);
  }
  const currentLiquid=total(cash,currentGov);
  const projectedLiquid=total(afterCash,projectedGov,
    candidate && (isSale(plan)||isFinancing(plan)) ? q : 0n);
  r=row('C02','PORTFOLIO',c.t.portfolio.label);
  let c02=ratioRow(r,currentLiquid,projectedLiquid,nav,[5n,100n],'min');
  if (!singleDay && c02.result==='block' && currentLiquid!==null && projectedLiquid!==null &&
      nav!==null && currentLiquid*100n<nav*5n && projectedLiquid>currentLiquid) {
    c02={...c02,result:'warn',reason:'现状低于5%，本笔改善现金，可条件放行；回款未实际到账前不可用于其他交易付款'};
  }
  rows.push(c02);
  if (c02.result==='pass' || c02.result==='block')
    track(rows.length-1,currentLiquid,projectedLiquid,nav,nav,5n,100n,true);
  const targetBank=candidate?bankIdForPlan(plan,c.t):null;
  const targetSecurity=c.securities.get(plan?.securityId);
  if ((candidate && bankRequired(plan,targetSecurity) && !targetBank) || c.unresolved.length)
    rows.push(miss(row('C03','UNRESOLVED','未确认银行主体'),
      ['issuerBankId',...c.unresolved.map(x=>`exposure.${x}`)],'银行类交易发行人或已有承诺银行归属未知'));
  for (const b of c.t.banks) {
    const bankRowStart=rows.length;
    const amounts=c.bankAmounts.get(b.bankId),bankLabel=b.label, bankId=b.bankId;
    const kind=candidate && bankIdForPlan(plan,c.t)===bankId && isBankTrade(plan) ?
      bankKind(c.securities.get(plan.securityId) ?? {instrumentKind:plan.businessType==='deposit'?'deposit':
        plan.businessType.startsWith('cd_')?'cd':null}) : null;
    const projected={...amounts};
    if (kind) projected[kind]=plus(projected[kind],q===null?null:isPurchase(plan)?q:-q);
    const currentDC=total(amounts.depositYuan,amounts.cdYuan),afterDC=total(projected.depositYuan,projected.cdYuan);
    const currentAll=total(...Object.values(amounts)),afterAll=total(...Object.values(projected));
    for (const [ruleId,qualified,pct] of [['C03',false,[5n,100n]],['C04',true,[20n,100n]]]) {
      r=row(ruleId,bankId,bankLabel);
      if (b.custodyQualified===null) rows.push(miss(r,[`banks.${bankId}.custodyQualified`],'托管资格未知'));
      else if (b.custodyQualified!==qualified) rows.push({...r,reason:'托管资格不适用'});
      else pushRatio(r,currentDC,afterDC,nav,pct);
    }
    const other=c.t.otherFundBankExposure.find(x=>x.bankId===bankId);
    const otherDCB=other ? total(amount(other.depositYuan),amount(other.cdYuan),amount(other.bondYuan)) : null;
    const currentCompany=total(amounts.depositYuan,amounts.cdYuan,amounts.bondYuan,otherDCB);
    const projectedCompany=total(projected.depositYuan,projected.cdYuan,projected.bondYuan,otherDCB);
    r=row('C05',bankId,bankLabel);
    if (!other) rows.push(miss(r,[`otherFundBankExposure.${bankId}`],'缺旗下其他货基同银行完整敞口'));
    else if (!b.quarterEnd || b.quarterEnd>today)
      rows.push(miss(r,[`banks.${bankId}.quarterEnd`],'最近季度净资产基准日期缺失或晚于业务日'));
    else pushRatio(r,currentCompany,projectedCompany,amount(b.quarterlyNetAssetsYuan),[10n,100n]);
    // A bank-specific transaction gate, not a ceiling on existing holdings. Check each
    // projected deposit at its position in the path, before later CDs or bonds.
    if (singleDay) {
    const depositEvents=c.depositGateEvents.filter(x=>x.bankId===bankId);
    if (plan?.businessType==='deposit' && amountYuan!==0 && bankIdForPlan(plan,c.t)===bankId)
      depositEvents.push({bankId,before:amounts,amountYuan});
    const limitBps=bankDepositLimitBps(b), rate=BigInt(limitBps), base=10000n;
    const threshold={operator:'≤',numerator:limitBps/100,denominator:100};
    r=row('C05-DEPOSIT',bankId,bankLabel,{threshold,
      name:`新增存款后全公司货基同银行存款、存单及银行债不超过银行季度净资产${limitBps/100}%`});
    if (!depositEvents.length) {
      const dated=Boolean(b.quarterEnd && b.quarterEnd<=today);
      const denominator=dated?amount(b.quarterlyNetAssetsYuan):null;
      const complete=Boolean(other && currentCompany!==null && denominator!==null && denominator>0n);
      rows.push({...r,currentValue:complete?
        Number(currentCompany)/Number(denominator):null,
        projectedValue:complete?
          Number(currentCompany)/Number(denominator):null,
        threshold,
        numeratorYuan:complete?out(currentCompany):null,denominatorYuan:complete?out(denominator):null,
        headroomYuan:complete?
          out(denominator*rate/base-currentCompany>0n?denominator*rate/base-currentCompany:0n):null,
        needed:complete?[]:[!other?`otherFundBankExposure.${bankId}`:!dated?
          `banks.${bankId}.quarterEnd`:`banks.${bankId}.quarterlyNetAssetsYuan`],
        reason:complete?'仅限制新增存款；存量及其他交易类型另按原规则判断':
          '本笔不新增存款；现状敞口或有效季度净资产待核实'});
    }
    else if (!other) rows.push(miss(r,[`otherFundBankExposure.${bankId}`],'缺旗下其他货基同银行完整敞口，不能判定新增存款'));
    else if (!b.quarterEnd || b.quarterEnd>today)
      rows.push(miss(r,[`banks.${bankId}.quarterEnd`],'最近季度净资产基准日期缺失或晚于业务日'));
    else {
      const denominator=amount(b.quarterlyNetAssetsYuan);
      const checked=depositEvents.map(event=>{
        const before=event.before ? total(event.before.depositYuan,event.before.cdYuan,event.before.bondYuan,otherDCB) : null;
        const after=before===null||!valid(event.amountYuan)?null:before+BigInt(event.amountYuan);
        return {before,after};
      });
      const missing=denominator===null||denominator<=0n||checked.some(x=>x.after===null);
      if (missing) rows.push(miss(r,['exposureYuan','denominatorYuan'],'敞口或银行季度净资产缺失，不能判定新增存款'));
      else {
        const failed=checked.find(x=>x.after*base>denominator*rate);
        const considered=failed??checked.at(-1);
        const limit=denominator*rate/base;
        rows.push({...r,result:failed?'block':'pass',currentValue:Number(considered.before)/Number(denominator),
          projectedValue:Number(considered.after)/Number(denominator),
          threshold,
          numeratorYuan:out(considered.after),denominatorYuan:out(denominator),
          headroomYuan:out(limit-considered.after),
          reason:failed?`新增存款后同银行公司货基合计敞口超过${limitBps/100}%`:`新增存款后同银行公司货基合计敞口不超过${limitBps/100}%`});
      }
    }
    }
    r=row('C06',bankId,bankLabel);
    if (b.custodyQualified===null) rows.push(miss(r,[`banks.${bankId}.custodyQualified`],'托管资格未知'));
    else if (!b.custodyQualified) rows.push({...r,reason:'无托管资格银行不适用'});
    else pushRatio(r,currentAll,afterAll,nav,[15n,100n]);
    const rating=b.rating,asOf=b.ratingAsOf;
    for (const [ruleId,den,pct] of [['C07',nav,[2n,100n]],['C08',amount(b.quarterlyNetAssetsYuan),[5n,100n]]]) {
      r=row(ruleId,bankId,bankLabel);
      if (rating===null||asOf===null||asOf>today)
        rows.push(miss(r,[`banks.${bankId}.rating`,`banks.${bankId}.ratingAsOf`],
          '评级或有效日未知、晚于业务日'));
      else if (!['BB','BB-'].includes(rating)) rows.push({...r,reason:'评级不适用'});
      else if (ruleId==='C08' && (!b.quarterEnd || b.quarterEnd>today))
        rows.push(miss(r,[`banks.${bankId}.quarterEnd`],'银行季度净资产基准日期缺失或晚于业务日'));
      else pushRatio(r,currentAll,afterAll,den,pct);
    }
    if (candidate && targetBank!==bankId) for (let i=bankRowStart;i<rows.length;i++) {
      if (rows[i].ruleId==='C05-DEPOSIT' && c.depositGateEvents.some(x=>x.bankId===bankId)) continue;
      rows[i]={...rows[i],result:'not_applicable',needed:[],reason:'本笔不改变该银行敞口；现状另行展示'};
    }
  }
  r=row('C09','PORTFOLIO',c.t.portfolio.label,{name:singleDay?
    '资产负债正回购调整平均剩余期限不超过90天':NAMES.C09,
    threshold:singleDay ? {operator:'≤',valueDays:90} : {operator:'≤',valueTradingDays:90}});
  const maturityIds=new Set(c.t.maturityCashEvents.map(x=>x.eventId));
  const unmappedCash=[
    ...Object.entries(state.execution?.cashEventReceipts ?? {})
      .filter(([,x])=>valid(x.amountYuan) && x.amountYuan>0 && maturityIds.has(x.sourceId))
      .map(([id,x])=>`maturityCashEvents.${x.sourceId}.receipt.${id}`),
    ...Object.entries(state.execution?.cashFlows ?? {})
      .filter(([,x])=>x.type==='cash_available' && x.instructionId===null &&
        valid(x.amountYuan) && x.amountYuan>0)
      .map(([id])=>`cashFlows.${id}.independentFunding`),
  ];
  const w=termLedger(c.t,c.adjustments,plan,amountYuan);
  if (!singleDay && unmappedCash.length) rows.push(miss(r,unmappedCash,
    '独立到期或无指令到账缺少资产负债期限及NAV映射，需核对更新完整权重'));
  else if (w.missing) rows.push(miss(r,w.missing,w.reason));
  else if (w.currentDen<=0n || w.projectedDen<=0n) rows.push(miss(r,['termWeights.denominator'],
    '资产总额－负债总额＋正回购金额非正'));
  else {
    rows.push({...r,result:w.projectedNum<=90n*w.projectedDen?'pass':'block',
    currentValue:Number(w.currentNum)/Number(w.currentDen),
    projectedValue:Number(w.projectedNum)/Number(w.projectedDen),
    numeratorYuan:out(w.projectedNum),denominatorYuan:out(w.projectedDen),
    headroomYuan:null,reason:w.projectedNum<=90n*w.projectedDen?'平均剩余期限在阈值内':
      `平均剩余期限超过90${singleDay?'天':'交易日'}`,
    weightedUnit:singleDay?'元×天':'元×交易日'});
    track(rows.length-1,w.currentNum,w.projectedNum,w.currentDen,w.projectedDen,90n,1n);
  }
  if (singleDay && candidate) {
    const improves=comparisons.some(x=>x.trend>0);
    // The progressive exception requires every comparable metric to be no worse,
    // including compliant metrics moving towards their limit. Ordinary compliant
    // trades retain their threshold checks and do not need this exception.
    const harmful=comparisons.some(x=>x.trend<0);
    for (const x of comparisons) {
      const current={...rows[x.index],improvementTrend:x.trend};
      rows[x.index]=current;
      if (!x.projectedBreached) continue;
      if (!x.currentBreached) rows[x.index]={...current,result:'block',reason:'本笔使原达标指标新超限'};
      else if (x.trend<0) rows[x.index]={...current,result:'block',reason:'本笔使已超限指标进一步恶化'};
      else if (!improves) rows[x.index]={...current,result:'block',
        reason:'已有指标超限，本笔未改善任何适用指标'};
      else if (harmful) rows[x.index]={...current,result:'block',
        reason:'仍有指标未达标，且本笔使其他指标恶化，不满足渐进改善条件'};
      else if (!harmful) rows[x.index]={...current,result:'warn',
        reason:(x.trend>0 ? '本笔改善已超限指标，但交易后仍未达标；按渐进改善条件放行' :
          '该指标仍超限但未恶化，其他适用指标改善；按渐进改善条件放行')+
          (current.ruleId==='C02' && isSale(plan) ? '；回款未实际到账前不可用于其他交易付款' : '')};
    }
  }
  return {enabled:true,rows,blocking:rows.filter(x=>x.result==='block'),
    missing:rows.filter(x=>x.result==='missing')};
}

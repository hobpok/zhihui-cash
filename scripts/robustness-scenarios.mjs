// Explicit synthetic fixtures; no live data or implicit missing-value replacement.
import { createSyntheticInitialTemplate, normalizeInitialTemplate } from '../app/initial-data.js';
export const YI = 100000000;
export const DATE = '2026-10-03';
const q = n => Math.round(n * YI);
const directions = { reverse_repo:'outflow', interbank_repo_financing:'inflow',
  exchange_repo_financing:'inflow', exchange_repo_lending:'outflow', deposit:'outflow',
  cd_buy:'outflow', cd_sell:'inflow', bond_buy:'outflow', bond_sell:'inflow' };
export function plan(label,businessType,amount,securityId=null,days=7) {
  return {label,businessType,direction:directions[businessType],counterpartyId:null,issuerId:null,
    targetYuan:q(amount),tradeDate:DATE,settlementDate:DATE,securityId,
    marketTier:['cd_buy','cd_sell','bond_buy','bond_sell'].includes(businessType)?'secondary':null,
    repoTerms:businessType.includes('repo')?{market:businessType.startsWith('exchange')?'SSE':'INTERBANK',tenorDays:days,annualRate:null}:null,
    termsNote:'2026-10-03鲁棒性检验合成计划；不连接真实交易'};
}
export function baseTemplate({id,cash=10,gov=0,holdings=[],residualDays=30,bankCAssets=1000,maturities=[]}) {
  const t=createSyntheticInitialTemplate({businessDate:DATE});
  t.templateId=id;t.label=id;t.portfolio.portfolioId=id;t.portfolio.label='100亿合成基金';
  t.provenance.note='鲁棒性检验独立合成场景；所有金额、持仓及残余权重均明确给定';
  t.portfolio.navYuan=q(100);t.portfolio.accountCashYuan=q(cash);t.portfolio.bufferYuan=0;
  t.portfolio.netSubscriptionYuan=0;t.pendingSettlements=[];t.maturityCashEvents=maturities;
  t.banks.forEach(b=>{b.quarterlyNetAssetsYuan=q(b.bankId==='BANK-C'?bankCAssets:1000);});
  t.otherFundBankExposure=t.banks.map(b=>({bankId:b.bankId,depositYuan:0,cdYuan:0,bondYuan:0,otherYuan:0}));
  const sec=(securityId,label,kind,bank,days)=>({securityId,label,instrumentKind:kind,issuerBankId:bank,
    issuerType:bank?'bank':kind==='government_bond'?'government':'non_bank',
    isGovernmentBond:kind==='government_bond',remainingTradingDays:days});
  t.securities=[sec('GOV','一年内政府债','government_bond',null,30),
    sec('DEP-A','A银行存款','deposit','BANK-A',30),sec('DEP-B','B银行存款','deposit','BANK-B',30),
    sec('CD-A','A银行存单','cd','BANK-A',30),sec('CD-B','B银行存单','cd','BANK-B',30),
    sec('CD-C','BB银行存单','cd','BANK-C',30),sec('LONG','长期普通债','bond',null,120),
    sec('SHORT','短期普通债','bond',null,30),sec('DUE','今日到期存款','deposit','BANK-A',0)];
  const items=[...(gov?[{securityId:'GOV',amount:gov,days:30}]:[]),...holdings];
  t.holdings=items.map((h,i)=>({holdingId:h.holdingId??`H-${h.securityId}-${i}`,securityId:h.securityId,
    amountYuan:q(h.amount),sellableYuan:q(h.sellable??h.amount)}));
  items.forEach(h=>{t.securities.find(s=>s.securityId===h.securityId).remainingTradingDays=h.days??t.securities.find(s=>s.securityId===h.securityId).remainingTradingDays;});
  t.termWeights.assets=[{weightId:'W-CASH',label:'账户现金',amountYuan:q(cash),remainingTradingDays:0,sourceAccountCash:true},
    ...t.holdings.map((h,i)=>({weightId:`W-${i}`,label:h.securityId,amountYuan:h.amountYuan,
      remainingTradingDays:t.securities.find(s=>s.securityId===h.securityId).remainingTradingDays,sourceHoldingId:h.holdingId})),
    {weightId:'W-RESIDUAL',label:'明确合成的其他非银行资产权重',amountYuan:q(100-cash-items.reduce((s,h)=>s+h.amount,0)),remainingTradingDays:residualDays}];
  t.termWeights.liabilities=[];t.termWeights.positiveRepos=[];
  t.financingResources.INTERBANK={quotaConfirmedYuan:q(30),pledgeConfirmedYuan:null};
  t.financingResources.SSE={quotaConfirmedYuan:q(10),pledgeConfirmedYuan:null};
  t.financingResources.SZSE={quotaConfirmedYuan:q(10),pledgeConfirmedYuan:null};
  t.draftPlans=[];return t;
}
export function createScenarios() {
  const list=[];
  const add=(id,label,opts,plans,expected)=>{const t=baseTemplate({id,...opts});t.label=label;t.draftPlans=plans;
    list.push({id,label,template:normalizeInitialTemplate(t),expected});};
  add('R01','现金比例3%，卖券与融资修复后完成',
    {cash:3,holdings:[{securityId:'LONG',amount:20,days:120}]},
    [plan('卖长债2亿','bond_sell',2,'LONG'),plan('融资3亿','interbank_repo_financing',3),
     plan('逆回购2亿','reverse_repo',2),plan('买B存单1亿','cd_buy',1,'CD-B')],
    {complete:true,account:q(5),business:q(5),cashRatio:0.05,termNumerator:q(4514),termDenominator:q(103),initialRules:['C02']});
  add('R02','95天期限，卖长债后买短债与逆回购',
    {cash:10,holdings:[{securityId:'LONG',amount:50,days:150}],residualDays:50},
    [plan('卖长债10亿','bond_sell',10,'LONG'),plan('买短债5亿','bond_buy',5,'SHORT'),plan('逆回购3亿','reverse_repo',3)],
    {complete:true,account:q(12),business:q(12),termNumerator:q(8171),termDenominator:q(100),first:'卖长债10亿',initialRules:['C09']});
  add('R03','A银行16%超限，卖存单再存款',
    {cash:10,holdings:[{securityId:'CD-A',amount:16,days:30}]},
    [plan('卖A存单2亿','cd_sell',2,'CD-A'),plan('存A银行1亿','deposit',1,'DEP-A'),plan('买短债2亿','bond_buy',2,'SHORT')],
    {complete:true,account:q(9),business:q(9),bankRule:{ruleId:'C06',subjectId:'BANK-A',value:0.15},initialRules:['C06']});
  add('R04','头寸1亿，融资6亿覆盖三笔支出',
    {cash:1,gov:5},
    [plan('融资6亿','interbank_repo_financing',6),plan('逆回购3亿','reverse_repo',3),
      plan('买短债2亿','bond_buy',2,'SHORT'),plan('存B银行1亿','deposit',1,'DEP-B')],
    {complete:true,account:q(1),business:q(1),cashRatio:0.06});
  add('R05','现金1%、期限95.8天、A银行16%同时受限',
    {cash:1,holdings:[{securityId:'CD-A',amount:16,days:120},{securityId:'LONG',amount:60,days:120}],residualDays:20},
    [plan('卖A存单6亿','cd_sell',6,'CD-A'),plan('卖长债4亿','bond_sell',4,'LONG'),
      plan('融资6亿','interbank_repo_financing',6),plan('买B存单1亿','cd_buy',1,'CD-B'),
      plan('逆回购5亿','reverse_repo',5),plan('买短债2亿','bond_buy',2,'SHORT')],
    {complete:true,account:q(9),business:q(9),termNumerator:q(8505),termDenominator:q(106),
      initialRules:['C02','C06','C09'],first:'卖A存单6亿'});
  add('R06','资金不足且无回笼来源，保留7亿目标',
    {cash:3,gov:3},[plan('买短债7亿','bond_buy',7,'SHORT')],
    {complete:false,projectedEnd:q(-4),blockingRules:['C01','C02']});
  add('R07','B银行购后6%，允许无关交易但保留受阻存单',
    {cash:10,holdings:[{securityId:'CD-B',amount:4,days:30}]},
    [plan('买B存单2亿','cd_buy',2,'CD-B'),plan('买短债1亿','bond_buy',1,'SHORT')],
    {complete:false,blockedLabel:'买B存单2亿',blockingRules:['C03']});
  add('R08','期限98天，卖3亿仍92.6天，不扩大改善例外',
    {cash:10,holdings:[{securityId:'LONG',amount:50,days:180}],residualDays:20},
    [plan('卖长债3亿','bond_sell',3,'LONG'),plan('买短债1亿','bond_buy',1,'SHORT')],
    {complete:false,account:q(10),business:q(10),blockedLabel:'卖长债3亿',blockingRules:['C09']});
  add('R09','到期未收可下达，付款等待真实到账',
    {cash:1,gov:5,holdings:[{securityId:'DUE',holdingId:'H-DUE',amount:2,days:0,sellable:0}],
      maturities:[{eventId:'MAT-R09',label:'当日到期2亿',kind:'deposit_maturity',direction:'inflow',amountYuan:q(2),dueDate:DATE,includedInOpeningCash:false,sourceHoldingId:'H-DUE'}]},
    [plan('逆回购2亿','reverse_repo',2),plan('买B存单1亿','cd_buy',1,'CD-B')],
    {complete:true,account:0,business:0,cashRatio:0.05});
  add('R10','BB银行基金及银行净资产双超限，卖出修复',
    {cash:10,gov:5,bankCAssets:40,holdings:[{securityId:'CD-C',amount:2.5,days:30}]},
    [plan('卖BB存单1亿','cd_sell',1,'CD-C'),plan('买BB存单0.5亿','cd_buy',0.5,'CD-C')],
    {complete:true,account:q(10.5),business:q(10.5),initialRules:['C07','C08'],first:'卖BB存单1亿',
      bankRule:{ruleId:'C07',subjectId:'BANK-C',value:0.02}});
  add('R11','现金5%和无托管银行5%双等号',
    {cash:6,holdings:[{securityId:'CD-B',amount:4,days:30}]},
    [plan('买B存单1亿','cd_buy',1,'CD-B')],
    {complete:true,account:q(5),business:q(5),cashRatio:0.05,bankRule:{ruleId:'C03',subjectId:'BANK-B',value:0.05}});
  add('R12','银行净资产未知，阻断相关计划并完成无关逆回购',
    {cash:10,gov:5},[plan('买B存单1亿','cd_buy',1,'CD-B'),plan('逆回购1亿','reverse_repo',1)],
    {complete:false,account:q(9),business:q(9),blockedLabel:'买B存单1亿',missingRules:['C05']});
  list.at(-1).template.banks.find(b=>b.bankId==='BANK-B').quarterlyNetAssetsYuan=null;
  add('R13','九类业务九笔交易，检验大规模有界排单',
    {cash:20,gov:5,holdings:[{securityId:'CD-A',amount:2,days:30},{securityId:'CD-B',amount:2,days:30},{securityId:'LONG',amount:2,days:30}]},
    [plan('逆回购1亿','reverse_repo',1),plan('银行间融资2亿','interbank_repo_financing',2),
      plan('交易所融资1亿','exchange_repo_financing',1),plan('交易所融券1亿','exchange_repo_lending',1),
      plan('存A银行1亿','deposit',1,'DEP-A'),plan('买B存单1亿','cd_buy',1,'CD-B'),
      plan('卖B存单1亿','cd_sell',1,'CD-B'),plan('买短债1亿','bond_buy',1,'SHORT'),plan('卖普通债1亿','bond_sell',1,'LONG')],
    {complete:true,account:q(20),business:q(20),cashRatio:0.25});
  add('R14','两笔卖出合计可修复期限，首笔仍超限',
    {cash:5,holdings:[{securityId:'LONG',amount:20,days:100}],residualDays:100},
    [plan('卖长债甲3亿','bond_sell',3,'LONG'),plan('卖长债乙3亿','bond_sell',3,'LONG')],
    {complete:false,account:q(5),business:q(5),initialRules:['C09'],blockingRules:['C09'],
      note:'两笔合计可将95天降至89天，但任何首笔完成后92天仍超限；现行合同未提供渐进改善例外。'});
  add('R15','两笔卖出合计可修复集中度，首笔仍超限',
    {cash:10,holdings:[{securityId:'CD-B',amount:6,days:30}],residualDays:50},
    [plan('卖B存单甲0.5亿','cd_sell',0.5,'CD-B'),plan('卖B存单乙0.5亿','cd_sell',0.5,'CD-B')],
    {complete:false,account:q(10),business:q(10),initialRules:['C03'],blockingRules:['C03'],
      note:'两笔合计可将6%降至5%，但任何首笔完成后5.5%仍超限；现行合同未提供渐进改善例外。'});
  return list;
}

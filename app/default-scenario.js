import { INITIAL_TEMPLATE_VERSION, TERM_WEIGHTS_VERSION, SINGLE_DAY_DEMO_MODE,
  normalizeInitialTemplate } from './initial-data.js';

const YI = 100000000;
const yuan = yi => Math.round(yi * YI);

// Use the same business timezone in browsers and UTC-based cloud workers.
export function currentBusinessDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// Old runs keep the seven-day built-in draft in initialData. Refresh that exact
// sample only when the user explicitly resets the run; saved runs and templates
// are never migrated in place, and user-edited terms remain authoritative.
export function prepareInitialTemplateForReset(template) {
  if (template?.templateId !== 'SIM-DEFAULT-COMPLEX-01' || template.revision !== 1 ||
      template.provenance?.kind !== 'synthetic' || !Array.isArray(template.draftPlans)) return template;
  const oldLabel = '银行间正回购融资17.6亿7天';
  const oldPlan = template.draftPlans.find(plan =>
    plan.label === oldLabel && plan.businessType === 'interbank_repo_financing' &&
    plan.targetYuan === yuan(17.6) && plan.repoTerms?.market === 'INTERBANK' &&
    plan.repoTerms.tenorDays === 7);
  if (!oldPlan) return template;
  const refreshed = structuredClone(template);
  const repo = refreshed.draftPlans[template.draftPlans.indexOf(oldPlan)];
  repo.label = '银行间正回购融资17.6亿1天';
  repo.repoTerms.tenorDays = 1;
  return normalizeInitialTemplate(refreshed);
}

// Synthetic company-level deposit gates confirmed on 2026-10-19.
// Bank names are labels; every qualification, rating and amount is illustrative.
export function createDefaultInitialTemplate({ businessDate = currentBusinessDate() } = {}) {
  const bank = (code, label, netAssetsYi=2000, custodyQualified=true, depositLimitBps=600) => ({
    bankId:`SIM-BANK-${code}`,label,custodyQualified,rating:'AAA',ratingAsOf:businessDate,
    quarterlyNetAssetsYuan:yuan(netAssetsYi),quarterEnd:'2026-06-30',depositLimitBps,
  });
  const banks = [
    bank('ABC','农业银行'),bank('GZ','广州银行',1000,false,800),
    bank('JNRCB','江南农商银行',1000,false,600),bank('ICBC','工商银行'),
    bank('CCB','建设银行'),bank('CMB','招商银行'),bank('CIB','兴业银行'),
    bank('BCOM','交通银行'),bank('PSBC','邮储银行'),bank('SPDB','浦发银行'),
  ];
  const sec = (securityId,label,instrumentKind,code,days) => ({
    securityId,label,instrumentKind,issuerBankId:code?`SIM-BANK-${code}`:null,
    issuerType:code?'bank':instrumentKind==='government_bond'?'government':'non_bank',
    isGovernmentBond:instrumentKind==='government_bond',remainingTradingDays:days,
  });
  const securities = [sec('SIM-GOV-30','模拟一年内政府债','government_bond',null,30),
    sec('SIM-REVERSE-OLD','模拟存量逆回购（非当日到期）','repo',null,7)];
  const positions = [['SIM-GOV-30',20,20],['SIM-REVERSE-OLD',75,0]];
  const addPosition=(code,kind,n,days,suffix='OLD')=>{
    const name=banks.find(b=>b.bankId===`SIM-BANK-${code}`).label;
    const id=`SIM-${code}-${kind}-${suffix}`;
    securities.push(sec(id,`模拟${name}${kind==='DEP'?'存款':'存单'}持仓${days}天`,
      kind==='DEP'?'deposit':'cd',code,days));
    positions.push([id,n,kind==='DEP'?0:n]);
  };
  // Three named banks hold 90 yi. Background CDs: 210 yi*110d + 125 yi*111d.
  for(const [code,n] of [['ABC',25],['GZ',10],['JNRCB',10]]) {
    addPosition(code,'DEP',n,90);addPosition(code,'CD',n,90);
  }
  for(const code of ['ICBC','CCB','CMB','CIB'])addPosition(code,'CD',50,110);
  addPosition('BCOM','CD',10,110,'OLD-110');addPosition('BCOM','CD',40,111,'OLD-111');
  addPosition('PSBC','CD',45,111);addPosition('SPDB','CD',40,111);
  for(const code of ['GZ','JNRCB']) {
    const name=banks.find(b=>b.bankId===`SIM-BANK-${code}`).label;
    securities.push(sec(`SIM-${code}-DEP-NEW`,`模拟${name}新存款`,'deposit',code,90),
      sec(`SIM-${code}-CD-NEW`,`模拟${name}新存单`,'cd',code,90));
  }
  const holdings=positions.map(([securityId,n,sellable])=>({
    holdingId:`H-${securityId}`,securityId,amountYuan:yuan(n),sellableYuan:yuan(sellable),
  }));
  const terms={version:TERM_WEIGHTS_VERSION,coverage:'complete',calendar:'day-365-demo-v1',
    asOfDate:businessDate,assets:[{weightId:'TW-SIM-CASH',label:'模拟账户现金',
      amountYuan:yuan(5),remainingTradingDays:0,sourceAccountCash:true},
      ...holdings.map(h=>({weightId:`TW-${h.securityId}`,
        label:securities.find(s=>s.securityId===h.securityId).label,amountYuan:h.amountYuan,
        remainingTradingDays:securities.find(s=>s.securityId===h.securityId).remainingTradingDays,
        sourceHoldingId:h.holdingId}))],
    liabilities:[{weightId:'TW-REPO-LIABILITY',label:'存续正回购负债（当日到期未还）',amountYuan:yuan(25),remainingTradingDays:0}],
    positiveRepos:[{weightId:'TW-REPO-ADJUSTMENT',label:'存续正回购调整（当日到期）',amountYuan:yuan(25),remainingTradingDays:0}],
  };
  const plan=(label,businessType,n,securityId=null,code=null,tenorDays=null)=>({
    label,businessType,direction:businessType==='interbank_repo_financing'?'inflow':'outflow',
    counterpartyId:null,issuerId:code?`SIM-BANK-${code}`:null,targetYuan:yuan(n),
    termsNote:'模拟计划；金额、代码、期限及行情均非真实交易数据',
    repoTerms:tenorDays===null?null:{market:'INTERBANK',tenorDays,annualRate:null},
    tradeDate:businessDate,settlementDate:businessDate,securityId,
    marketTier:businessType==='cd_buy'?'secondary':null,
  });
  return normalizeInitialTemplate({
    templateVersion:INITIAL_TEMPLATE_VERSION,templateId:'SIM-DEFAULT-COMPANY-GATES-20261019',
    label:'500亿基金公司级三银行与日终5亿现金样例',revision:1,demoMode:SINGLE_DAY_DEMO_MODE,
    provenance:{kind:'synthetic',note:'2026-10-19公司级三银行本地模拟。农业银行存款25亿、存单25亿作为背景持仓；广州银行全公司存款＋存单＋债券／银行净资产从7.9%起步，新增存款1亿至8%后再买存单2亿；江南农商银行从5.8%起步，新增存款2亿至6%后再买存单1亿。两行无托管资格，本基金存款＋存单均须不超过NAV的5%。其余335亿为七家有托管资格、AAA背景银行的存单，每家不超过本基金NAV的15%。所有银行评级、资格、银行净资产、公司持仓、证券代码及期限均为合成参数，不代表真实银行资料、行情或制度全文。其他基金广州59亿、江南38亿不计入本基金500亿净资产。'},
    businessDate,portfolio:{portfolioId:'SIM-FUND-500',label:'模拟500亿货币基金',navYuan:yuan(500),
      accountCashYuan:yuan(5),netSubscriptionYuan:0,feeYuan:0,bufferYuan:0,legacyBankExposureYuan:null},
    banks,securities,holdings,termWeights:terms,
    otherFundBankExposure:banks.map(b=>({bankId:b.bankId,depositYuan:0,
      cdYuan:b.bankId==='SIM-BANK-GZ'?yuan(59):b.bankId==='SIM-BANK-JNRCB'?yuan(38):0,
      bondYuan:0,otherYuan:0})),
    financingResources:{INTERBANK:{quotaConfirmedYuan:null,pledgeConfirmedYuan:null},
      SSE:{quotaConfirmedYuan:null,pledgeConfirmedYuan:null},SZSE:{quotaConfirmedYuan:null,pledgeConfirmedYuan:null}},
    ruleInitials:{depositThreshold:'0.08',observationThreshold:'0.082'},
    maturityCashEvents:[{eventId:'SIM-REPO-DUE-TODAY',label:'存续正回购25亿当日到期未还',
      kind:'repo_maturity',direction:'outflow',amountYuan:yuan(25),dueDate:businessDate,
      includedInOpeningCash:false,sourceLiabilityWeightId:'TW-REPO-LIABILITY',
      sourcePositiveRepoWeightId:'TW-REPO-ADJUSTMENT'}],pendingSettlements:[],
    draftPlans:[
      plan('存入广州银行1亿90天','deposit',1,'SIM-GZ-DEP-NEW','GZ'),
      plan('买入广州银行新存单2亿90天','cd_buy',2,'SIM-GZ-CD-NEW','GZ'),
      plan('存入江南农商银行2亿90天','deposit',2,'SIM-JNRCB-DEP-NEW','JNRCB'),
      plan('买入江南农商银行新存单1亿90天','cd_buy',1,'SIM-JNRCB-CD-NEW','JNRCB'),
      plan('银行间逆回购20亿7天','reverse_repo',20,null,null,7),
      plan('银行间正回购融资51亿1天','interbank_repo_financing',51,null,null,1),
    ],
  });
}

// TEST ONLY: pre-2026-10-19 nine-plan scenario for historical regression coverage.
// Move 30yi CD to CCB (same 100-day tenor), and add 30yi other-fund CDRCB CD.
// This preserves original 6% company gate and C09 with the historical fixture assumptions (not the current default rule).
import { INITIAL_TEMPLATE_VERSION, TERM_WEIGHTS_VERSION, SINGLE_DAY_DEMO_MODE,
  normalizeInitialTemplate } from '../initial-data.js';

const YI = 100000000;
const yuan = yi => Math.round(yi * YI);

// Bank labels originate from the historical synthetic scenario; source location omitted.
// All ratings, eligibility, assets, positions, codes and tenors are simulated.
// Chengdu Rural Commercial Bank is a separate synthetic 6% ordering example.
export function createHistoricalComplexTemplate({ businessDate = '2026-10-13' } = {}) {
  const bank = (code, name, custodyQualified, rating, netAssetsYi=1000) => ({
    bankId:`SIM-BANK-${code}`, label:name, custodyQualified, rating,
    ratingAsOf:businessDate, quarterlyNetAssetsYuan:yuan(netAssetsYi), quarterEnd:'2026-06-30',
  });
  const banks = [
    bank('ZY','中原银行',false,'AAA'), bank('GZ','广州银行',false,'AA'),
    bank('XM','厦门银行',false,'AA'), bank('ZZ','郑州银行',true,'BB'),
    bank('WB','微众银行',true,'BB'),
    bank('ICBC','工商银行',true,'AAA',2000),bank('CCB','建设银行',true,'AAA',2000),
    bank('CDRCB','成都农商银行',true,'AAA',1100),
    bank('CMB','招商银行',true,'AAA',2000),bank('CIB','兴业银行',true,'AAA',2000),
  ];
  const sec = (securityId,label,instrumentKind,bankCode,days) => ({
    securityId,label,instrumentKind,
    issuerBankId:bankCode===null?null:`SIM-BANK-${bankCode}`,
    issuerType:bankCode===null?(instrumentKind==='government_bond'?'government':'non_bank'):'bank',
    isGovernmentBond:instrumentKind==='government_bond',remainingTradingDays:days,
  });
  const securities = [
    sec('SIM-GOV-30','模拟一年内政府债','government_bond',null,30),
    sec('SIM-ZY-DEP-OLD','模拟中原银行存款持仓','deposit','ZY',100),
    sec('SIM-ZY-CD-OLD','模拟中原银行旧存单','cd','ZY',30),
    sec('SIM-GZ-DEP-OLD','模拟广州银行存款持仓','deposit','GZ',90),
    sec('SIM-GZ-CD-OLD','模拟广州银行旧存单','cd','GZ',120),
    sec('SIM-XM-DEP-OLD','模拟厦门银行存款持仓','deposit','XM',90),
    sec('SIM-XM-CD-OLD','模拟厦门银行旧存单','cd','XM',120),
    sec('SIM-ZZ-CD-OLD','模拟郑州银行旧存单','cd','ZZ',70),
    sec('SIM-WB-CD-OLD','模拟微众银行旧存单','cd','WB',90),
    sec('SIM-ICBC-DEP-OLD','模拟工商银行存款底仓','deposit','ICBC',100),
    sec('SIM-ICBC-CD-OLD','模拟工商银行存单底仓','cd','ICBC',100),
    sec('SIM-CCB-CD-OLD','历史测试建设银行存单底仓','cd','CCB',100),
    sec('SIM-CDRCB-DEP-OLD','模拟成都农商银行存款底仓','deposit','CDRCB',100),
    sec('SIM-CDRCB-CD-OLD','模拟成都农商银行存单底仓','cd','CDRCB',100),
    sec('SIM-CMB-DEP-OLD','模拟招商银行存款底仓','deposit','CMB',110),
    sec('SIM-CMB-CD-OLD','模拟招商银行存单底仓','cd','CMB',110),
    sec('SIM-CIB-DEP-OLD','模拟兴业银行存款底仓','deposit','CIB',110),
    sec('SIM-CIB-CD-OLD','模拟兴业银行存单底仓','cd','CIB',110),
    sec('SIM-NB-BASKET-75A','模拟分散非银行短融资产束一（非单一真实发行人）','bond',null,70),
    sec('SIM-NB-BASKET-80','模拟分散非银行短融资产束二（非单一真实发行人）','bond',null,80),
    sec('SIM-NB-BASKET-75B','模拟分散非银行短融资产束三（非单一真实发行人）','bond',null,75),
    sec('SIM-ZY-DEP-NEW','模拟中原银行新存款','deposit','ZY',180),
    sec('SIM-CDRCB-DEP-NEW','模拟成都农商银行新存款','deposit','CDRCB',100),
    sec('SIM-ZY-CD-NEW','模拟中原银行新存单','cd','ZY',120),
    sec('SIM-GZ-CD-NEW','模拟广州银行新存单','cd','GZ',150),
    ...[['ICBC','工商银行'],['CCB','建设银行'],['CDRCB','成都农商银行'],['CMB','招商银行'],['CIB','兴业银行']]
      .flatMap(([code,name])=>[30,60,90,120].map(days=>
        sec(`SIM-${code}-CD-${days}`,`模拟${name}可买存单${days}天`,'cd',code,days))),
    sec('SIM-NB-BOND-60','模拟非银行短融买入60天','bond',null,60),
    sec('SIM-NB-BOND-90','模拟非银行短融买入90天','bond',null,90),
  ];
  const positions = [
    ['SIM-GOV-30',25.1,25.1],['SIM-ZY-DEP-OLD',10,0],['SIM-ZY-CD-OLD',14.5,13],
    ['SIM-GZ-DEP-OLD',8,0],['SIM-GZ-CD-OLD',16,16],
    ['SIM-XM-DEP-OLD',5,0],['SIM-XM-CD-OLD',15,15],
    ['SIM-ZZ-CD-OLD',6,6],['SIM-WB-CD-OLD',4,4],
    ['SIM-ICBC-DEP-OLD',25,0],['SIM-ICBC-CD-OLD',40,40],
    ['SIM-CDRCB-DEP-OLD',20,0],['SIM-CDRCB-CD-OLD',10,10],['SIM-CCB-CD-OLD',30,30],
    ['SIM-CMB-DEP-OLD',20,0],['SIM-CMB-CD-OLD',40,40],
    ['SIM-CIB-DEP-OLD',20,0],['SIM-CIB-CD-OLD',40,40],
    ['SIM-NB-BASKET-75A',90,90],['SIM-NB-BASKET-80',51.32,51.32],
    ['SIM-NB-BASKET-75B',10.08,10.08],
  ];
  const holdings = positions.map(([securityId,amount,sellable]) => ({
    holdingId:`H-${securityId}`,securityId,amountYuan:yuan(amount),sellableYuan:yuan(sellable),
  }));
  const terms = {
    version:TERM_WEIGHTS_VERSION,coverage:'complete',calendar:'day-365-demo-v1',asOfDate:businessDate,
    assets:[{weightId:'TW-SIM-CASH',label:'模拟账户现金',amountYuan:0,
      remainingTradingDays:0,sourceAccountCash:true},
    ...holdings.map(h => {
      const s = securities.find(row=>row.securityId===h.securityId);
      return {weightId:`TW-${h.securityId}`,label:s.label,amountYuan:h.amountYuan,
        remainingTradingDays:s.remainingTradingDays,sourceHoldingId:h.holdingId};
    })],liabilities:[],positiveRepos:[],
  };
  const direction = {cd_sell:'inflow',deposit:'outflow',cd_buy:'outflow',bond_buy:'outflow',
    interbank_repo_financing:'inflow',reverse_repo:'outflow'};
  const plan = (label,businessType,amount,securityId=null,bankCode=null,tenorDays=null) => ({
    label,businessType,direction:direction[businessType],counterpartyId:null,
    issuerId:bankCode===null?null:`SIM-BANK-${bankCode}`,targetYuan:yuan(amount),
    termsNote:'模拟计划；金额、代码、期限及行情均非真实交易数据',
    repoTerms:tenorDays===null?null:{market:'INTERBANK',tenorDays,annualRate:null},
    tradeDate:businessDate,settlementDate:businessDate,securityId,
    marketTier:['cd_sell','cd_buy','bond_buy'].includes(businessType)?'secondary':null,
  });
  return normalizeInitialTemplate({
    templateVersion:INITIAL_TEMPLATE_VERSION,templateId:'SIM-DEFAULT-COMPLEX-01',
    label:'收益导向零现金单日模拟样例',revision:1,demoMode:SINGLE_DAY_DEMO_MODE,
    provenance:{kind:'synthetic',note:'银行名称仅为演示标签；全部评级、托管资格、季度净资产、金额、持仓、证券代码、期限和交易计划均为合成模拟参数，并非真实行情或已核实银行资料。非银行短融为分散资产束，不代表单一真实发行人。'},
    businessDate,
    portfolio:{portfolioId:'SIM-FUND-500',label:'模拟500亿货币基金',navYuan:yuan(500),
      accountCashYuan:0,netSubscriptionYuan:0,feeYuan:0,bufferYuan:0,
      legacyBankExposureYuan:null},
    banks,securities,holdings,termWeights:terms,
    otherFundBankExposure:banks.map(b=>({bankId:b.bankId,depositYuan:0,cdYuan:b.bankId==='SIM-BANK-CDRCB'?yuan(30):0,bondYuan:0,otherYuan:0})),
    financingResources:{INTERBANK:{quotaConfirmedYuan:null,pledgeConfirmedYuan:null},
      SSE:{quotaConfirmedYuan:null,pledgeConfirmedYuan:null},
      SZSE:{quotaConfirmedYuan:null,pledgeConfirmedYuan:null}},
    ruleInitials:{depositThreshold:'0.08',observationThreshold:'0.082'},
    maturityCashEvents:[],pendingSettlements:[],
    draftPlans:[
      plan('卖出中原银行旧存单13亿','cd_sell',13,'SIM-ZY-CD-OLD','ZY'),
      plan('存入成都农商银行6亿','deposit',6,'SIM-CDRCB-DEP-NEW','CDRCB'),
      plan('买入中原银行新存单7.5亿120天','cd_buy',7.5,'SIM-ZY-CD-NEW','ZY'),
      plan('买入广州银行新存单1亿150天','cd_buy',1,'SIM-GZ-CD-NEW','GZ'),
      plan('买入成都农商银行新存单1亿60天','cd_buy',1,'SIM-CDRCB-CD-60','CDRCB'),
      plan('买入模拟非银行短融1亿60天','bond_buy',1,'SIM-NB-BOND-60'),
      plan('买入模拟非银行短融1亿90天','bond_buy',1,'SIM-NB-BOND-90'),
      plan('银行间正回购融资17.6亿1天','interbank_repo_financing',17.6,null,null,1),
      plan('银行间逆回购投出13.1亿7天','reverse_repo',13.1,null,null,7),
    ],
  });
}



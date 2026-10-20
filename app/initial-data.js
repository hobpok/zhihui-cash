// Versioned, editable demonstration inputs. Runtime balances and execution facts live in model/execution.
export const INITIAL_TEMPLATE_VERSION = 'initial-template-1';
export const TERM_WEIGHTS_VERSION = 'term-weights-1';
export const SINGLE_DAY_DEMO_MODE = 'single-day-principal-v1';
// Optional on historical templates/runs. Resolve at use time so normalization
// does not rewrite saved facts or invalidate their exact normalized shape.
export const bankDepositLimitBps = bank => bank?.depositLimitBps === undefined ? 600 : bank.depositLimitBps;
const KINDS = ['deposit', 'cd', 'bond', 'abs', 'repo', 'government_bond'];
const CASH_KINDS = ['repo_maturity', 'deposit_maturity', 'security_redemption', 'net_subscription'];
const TRADE_KINDS = ['primary_cd_subscription', 'secondary_security_trade'];
const TRADE_TYPES = ['cd_buy', 'cd_sell', 'bond_buy', 'bond_sell'];
const FINANCING_MARKETS = ['INTERBANK', 'SSE', 'SZSE'];
const PLAN_TYPES = ['reverse_repo', 'interbank_repo_financing', 'exchange_repo_financing',
  'exchange_repo_lending', 'deposit', 'cd_buy', 'cd_sell', 'bond_buy', 'bond_sell'];
const DIRECTION = { reverse_repo:'outflow', interbank_repo_financing:'inflow',
  exchange_repo_financing:'inflow', exchange_repo_lending:'outflow', deposit:'outflow',
  cd_buy:'outflow', cd_sell:'inflow', bond_buy:'outflow', bond_sell:'inflow' };
const copy = value => JSON.parse(JSON.stringify(value));
const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}必须为对象`);
  return value;
};
const keys = (value, allowed, name) => {
  object(value, name);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`${name}含未知字段：${extra.join('、')}`);
};
const string = (value, name, nullable = false) => {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name}必须为非空文本`);
  return value.trim();
};
const money = (value, name, nullable = false) => {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name}必须为非负安全整数元${nullable ? '或null' : ''}`);
  return value;
};
const signedMoney = (value, name) => {
  if (!Number.isSafeInteger(value)) throw new Error(`${name}必须为有符号安全整数元`);
  return value;
};
const positiveMoney = (value, name, nullable = false) => {
  const n = money(value, name, nullable);
  if (n === 0) throw new Error(`${name}必须大于0`);
  return n;
};
const integer = (value, name, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name}必须为不小于${min}的整数`);
  return value;
};
const boolean = (value, name) => {
  if (typeof value !== 'boolean') throw new Error(`${name}必须为布尔值`);
  return value;
};
const oneOf = (value, allowed, name, nullable = false) => {
  if (nullable && value === null) return null;
  if (!allowed.includes(value)) throw new Error(`${name}无效`);
  return value;
};
const date = (value, name) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name}必须为YYYY-MM-DD`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new Error(`${name}不是有效公历日期`);
  return value;
};
const array = (value, name) => {
  if (!Array.isArray(value)) throw new Error(`${name}必须为数组`);
  return value;
};
const unique = (rows, key, name) => {
  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row[key])) throw new Error(`${name}重复ID：${row[key]}`);
    ids.add(row[key]);
  }
};
// A missing security link preserves the legacy seed and means "unverified", not a verified holding.
// A linked bank issuer may supply a missing plan issuer, but conflicting explicit IDs are rejected.
export function validatePlanSecurity(plan, template) {
  object(plan, '交易'); object(template, '初始模板');
  if (plan.securityId === null) return true;
  const security = template.securities?.find(s => s.securityId === plan.securityId);
  if (!security) throw new Error(`交易引用未知证券：${plan.securityId}`);
  const allowed = plan.businessType === 'deposit' ? ['deposit'] :
    ['cd_buy','cd_sell'].includes(plan.businessType) ? ['cd'] :
    ['bond_buy','bond_sell'].includes(plan.businessType) ? ['bond','government_bond','abs'] : null;
  if (allowed === null) throw new Error('该业务不适用证券ID');
  if (allowed && !allowed.includes(security.instrumentKind))
    throw new Error('交易业务类型与证券品种不一致');
  if (allowed && security.issuerBankId !== null && plan.issuerId !== null &&
    plan.issuerId !== security.issuerBankId) throw new Error('交易发行人与证券发行银行不一致');
  if (['non_bank','government'].includes(security.issuerType) && plan.issuerId !== null)
    throw new Error('非银行或政府债交易不得指定银行发行人');
  return true;
}
const sum = (values, name) => {
  if (values.some(value => value === null)) return null;
  const total = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total)) throw new Error(`${name}超出安全整数元范围`);
  return total;
};
const ratio = (value, name) => {
  if (typeof value !== 'string' || !/^(?:0\.[0-9]{1,12}|1(?:\.0{1,12})?)$/.test(value))
    throw new Error(`${name}必须为0到1的小数字符串`);
  return value;
};

export function normalizeInitialTemplate(raw) {
  const t = copy(object(raw, '初始模板'));
  keys(t, ['templateVersion','templateId','label','revision','provenance','businessDate','demoMode','portfolio',
    'banks','securities','holdings','otherFundBankExposure','financingResources','ruleInitials',
    'maturityCashEvents','pendingSettlements','draftPlans','termWeights'], '初始模板');
  if (t.templateVersion !== INITIAL_TEMPLATE_VERSION) throw new Error('初始模板版本不兼容');
  string(t.templateId, '模板ID'); string(t.label, '模板名称'); integer(t.revision, '模板版本号', 1);
  keys(t.provenance, ['kind','note'], '模板来源');
  oneOf(t.provenance.kind, ['synthetic','legacy'], '模板来源类型'); string(t.provenance.note, '模板来源说明');
  date(t.businessDate, '业务日期');
  if (t.demoMode !== undefined) oneOf(t.demoMode, [SINGLE_DAY_DEMO_MODE], '计算模式');
  const singleDay = t.demoMode === SINGLE_DAY_DEMO_MODE;
  keys(t.portfolio, ['portfolioId','label','navYuan','accountCashYuan','feeYuan','bufferYuan',
    'legacyBankExposureYuan','netSubscriptionYuan'], '组合');
  string(t.portfolio.portfolioId, '组合ID'); string(t.portfolio.label, '组合名称');
  for (const key of ['navYuan','accountCashYuan','feeYuan','bufferYuan','legacyBankExposureYuan'])
    money(t.portfolio[key], `组合.${key}`, true);
  if (singleDay && t.portfolio.netSubscriptionYuan === undefined) t.portfolio.netSubscriptionYuan = 0;
  if (t.portfolio.netSubscriptionYuan !== undefined)
    signedMoney(t.portfolio.netSubscriptionYuan, '组合.netSubscriptionYuan');
  if (singleDay && t.portfolio.feeYuan !== 0) throw new Error('单日本金口径费用必须为0');
  if (t.portfolio.navYuan === 0) throw new Error('组合净值不能为0');

  array(t.banks, '银行');
  for (const b of t.banks) {
    keys(b, ['bankId','label','custodyQualified','rating','ratingAsOf','quarterlyNetAssetsYuan','quarterEnd','depositLimitBps'], '银行');
    string(b.bankId, '银行ID'); string(b.label, '银行名称');
    if (b.custodyQualified !== null) boolean(b.custodyQualified, '银行托管资格');
    string(b.rating, '银行评级', true);
    if (b.ratingAsOf !== null) date(b.ratingAsOf, '评级日期');
    money(b.quarterlyNetAssetsYuan, '银行季度净资产', true);
    if (b.quarterEnd !== null) date(b.quarterEnd, '季度末日期');
    if (b.depositLimitBps !== undefined) oneOf(b.depositLimitBps, [600,800], '银行新增存款比例上限（基点）');
  }
  unique(t.banks, 'bankId', '银行');
  const bankIds = new Set(t.banks.map(b => b.bankId));

  array(t.securities, '证券');
  for (const s of t.securities) {
    keys(s, ['securityId','label','instrumentKind','issuerBankId','issuerType','isGovernmentBond','remainingTradingDays'], '证券');
    string(s.securityId, '证券ID'); string(s.label, '证券名称');
    oneOf(s.instrumentKind, KINDS, '证券品种'); string(s.issuerBankId, '证券发行银行ID', true);
    if (singleDay && s.instrumentKind === 'abs') throw new Error('单日本金口径不支持ABS');
    boolean(s.isGovernmentBond, '政府债标志');
    if (s.issuerBankId !== null && !bankIds.has(s.issuerBankId)) throw new Error(`证券引用未知银行：${s.issuerBankId}`);
    if (s.issuerType !== undefined) {
      oneOf(s.issuerType,['bank','non_bank','government','unknown'],'证券发行人类型');
      if (s.issuerType === 'bank' && s.issuerBankId === null) throw new Error('银行证券须有发行银行ID');
      if (s.issuerType !== 'bank' && s.issuerBankId !== null) throw new Error('非银行证券不得有发行银行ID');
      if ((s.issuerType === 'government') !== s.isGovernmentBond) throw new Error('政府债发行人类型与品种不一致');
    }
    if (s.isGovernmentBond !== (s.instrumentKind === 'government_bond')) throw new Error('政府债品种与标志不一致');
    if (s.remainingTradingDays !== null) integer(s.remainingTradingDays, '剩余交易日');
  }
  unique(t.securities, 'securityId', '证券');
  const securities = new Map(t.securities.map(s => [s.securityId, s]));

  array(t.holdings, '持仓');
  for (const h of t.holdings) {
    keys(h, ['holdingId','securityId','amountYuan','sellableYuan'], '持仓');
    string(h.holdingId, '持仓ID'); string(h.securityId, '持仓证券ID');
    if (!securities.has(h.securityId)) throw new Error(`持仓引用未知证券：${h.securityId}`);
    money(h.amountYuan, '持仓金额', true); money(h.sellableYuan, '可卖金额', true);
    if (h.amountYuan !== null && h.sellableYuan !== null && h.sellableYuan > h.amountYuan)
      throw new Error('可卖金额不得超过持仓金额');
  }
  unique(t.holdings, 'holdingId', '持仓');

  // Optional for old saved templates. Absence means C09 has no complete opening ledger.
  if (t.termWeights !== undefined && t.termWeights !== null) {
    const w = t.termWeights;
    keys(w, ['version','coverage','calendar','asOfDate','assets','liabilities','positiveRepos'], '期限权重');
    if (w.version !== TERM_WEIGHTS_VERSION || w.coverage !== 'complete' ||
        w.calendar !== (singleDay ? 'day-365-demo-v1' : 'weekday-252-demo-v1'))
      throw new Error('期限权重版本、覆盖声明或当前日历不兼容');
    if (w.asOfDate !== undefined && w.asOfDate !== null) date(w.asOfDate,'期限权重基准日');
    for (const field of ['assets','liabilities','positiveRepos']) {
      array(w[field], `期限权重.${field}`);
      for (const row of w[field]) {
        keys(row, ['weightId','label','amountYuan','remainingTradingDays','sourceHoldingId','sourceAccountCash'], `期限权重.${field}`);
        string(row.weightId, '权重ID'); string(row.label, '权重名称');
        money(row.amountYuan, '权重金额', true);
        if (row.remainingTradingDays !== null) integer(row.remainingTradingDays, '权重剩余交易日');
        if (row.sourceHoldingId !== undefined && row.sourceHoldingId !== null)
          string(row.sourceHoldingId, '权重持仓来源ID');
        if (row.sourceAccountCash !== undefined) boolean(row.sourceAccountCash, '权重账户现金来源');
        if (field !== 'assets' && (row.sourceHoldingId || row.sourceAccountCash))
          throw new Error('负债及正回购权重不得映射期初资产来源');
        if (row.sourceHoldingId && row.sourceAccountCash) throw new Error('期限权重不得同时映射持仓和账户现金');
      }
      unique(w[field], 'weightId', `期限权重.${field}`);
    }
    const ids = [...w.assets,...w.liabilities,...w.positiveRepos].map(x => x.weightId);
    if (new Set(ids).size !== ids.length) throw new Error('期限权重ID跨类别重复');
    const linked = w.assets.filter(x => x.sourceHoldingId);
    unique(linked, 'sourceHoldingId', '期限权重持仓来源');
    if (linked.some(x => !t.holdings.some(h => h.holdingId === x.sourceHoldingId)))
      throw new Error('期限权重引用未知持仓来源');
  }

  array(t.otherFundBankExposure, '其他货基敞口');
  for (const x of t.otherFundBankExposure) {
    keys(x, ['bankId','depositYuan','cdYuan','bondYuan','otherYuan'], '其他货基敞口');
    string(x.bankId, '其他货基银行ID');
    if (!bankIds.has(x.bankId)) throw new Error(`其他货基敞口引用未知银行：${x.bankId}`);
    for (const key of ['depositYuan','cdYuan','bondYuan','otherYuan']) money(x[key], `其他货基.${key}`, true);
  }
  unique(t.otherFundBankExposure, 'bankId', '其他货基敞口');

  keys(t.financingResources, FINANCING_MARKETS, '融资资源');
  for (const market of FINANCING_MARKETS) {
    const r = t.financingResources[market];
    keys(r, ['quotaConfirmedYuan','pledgeConfirmedYuan'], `${market}融资资源`);
    money(r.quotaConfirmedYuan, `${market}额度`, true);
    money(r.pledgeConfirmedYuan, `${market}质押`, true);
  }
  keys(t.ruleInitials, ['depositThreshold','observationThreshold'], '规则初值');
  ratio(t.ruleInitials.depositThreshold, '存款阈值'); ratio(t.ruleInitials.observationThreshold, '观察阈值');

  array(t.maturityCashEvents, '到期现金事件');
  for (const e of t.maturityCashEvents) {
    keys(e, ['eventId','label','kind','direction','amountYuan','dueDate','includedInOpeningCash','sourceHoldingId',
      'sourceLiabilityWeightId','sourcePositiveRepoWeightId'], '到期现金事件');
    string(e.eventId, '现金事件ID'); string(e.label, '现金事件名称');
    oneOf(e.kind, CASH_KINDS, '现金事件种类'); oneOf(e.direction, ['inflow','outflow'], '现金事件方向');
    positiveMoney(e.amountYuan, '现金事件金额', true); date(e.dueDate, '现金事件到期日');
    boolean(e.includedInOpeningCash, '日初现金已包含');
    if (e.amountYuan === null && e.includedInOpeningCash) throw new Error('未知金额不能声明已计入日初现金');
    const hasLiabilityLink=e.sourceLiabilityWeightId!=null, hasRepoLink=e.sourcePositiveRepoWeightId!=null;
    if (hasLiabilityLink || hasRepoLink) {
      if (!singleDay) throw new Error('到期负债及正回购关联仅适用于单日模式');
      if (!hasLiabilityLink || !hasRepoLink) throw new Error('正回购到期须同时关联负债及正回购权重');
      string(e.sourceLiabilityWeightId,'到期负债权重ID');
      string(e.sourcePositiveRepoWeightId,'到期正回购权重ID');
      const liability=t.termWeights?.liabilities.find(x=>x.weightId===e.sourceLiabilityWeightId);
      const repo=t.termWeights?.positiveRepos.find(x=>x.weightId===e.sourcePositiveRepoWeightId);
      if (!liability || !repo) throw new Error('正回购到期引用未知负债或正回购权重');
      if (e.kind!=='repo_maturity' || e.direction!=='outflow' || e.sourceHoldingId)
        throw new Error('到期负债及正回购关联仅用于正回购整笔到期流出');
      if (liability.amountYuan!==e.amountYuan || repo.amountYuan!==e.amountYuan ||
          liability.remainingTradingDays!==0 || repo.remainingTradingDays!==0)
        throw new Error('正回购到期须与关联负债及正回购权重同额且剩余0天');
    }
    if (singleDay) {
      if (e.kind === 'net_subscription') throw new Error('单日净申赎须填组合净申赎金额');
      if (e.dueDate !== t.businessDate) throw new Error('单日模式仅允许当日到期事件');
      if (e.amountYuan === null) throw new Error('单日模式到期金额必须已知');
      if (e.sourceHoldingId !== undefined && e.sourceHoldingId !== null) {
        const h = t.holdings.find(x => x.holdingId === e.sourceHoldingId);
        if (!h) throw new Error(`到期事件引用未知持仓：${e.sourceHoldingId}`);
        if (e.direction !== 'inflow' || e.amountYuan !== h.amountYuan)
          throw new Error('单日关联到期须与整笔持仓同额流入');
      }
    }
  }
  unique(t.maturityCashEvents, 'eventId', '到期现金事件');
  if (singleDay) {
    unique(t.maturityCashEvents.filter(e=>e.sourceHoldingId), 'sourceHoldingId', '到期持仓来源');
    for (const field of ['sourceLiabilityWeightId','sourcePositiveRepoWeightId'])
      unique(t.maturityCashEvents.filter(e=>e[field]!=null),field,'到期负债及正回购来源');
  }
  if (singleDay && t.portfolio.accountCashYuan !== null) {
    const openingCash = openingAccountCash(t);
    if (openingCash === null) throw new Error('日初实际账户现金超出安全整数元范围');
    if (openingCash < 0) throw new Error('日初净赎回/到期付款超过已到账现金，请调整基础现金或日初收付状态');
  }

  array(t.pendingSettlements, '待交收交易');
  for (const x of t.pendingSettlements) {
    keys(x, ['tradeId','label','kind','businessType','securityId','issuerId','tradeDate','settlementDate',
      'direction','amountYuan','holdingIncludedAtOpen','cashIncludedAtOpen'], '待交收交易');
    string(x.tradeId, '待交收交易ID'); string(x.label, '待交收交易名称');
    oneOf(x.kind, TRADE_KINDS, '待交收交易种类'); oneOf(x.businessType, TRADE_TYPES, '待交收业务类型');
    string(x.securityId, '待交收证券ID'); string(x.issuerId, '待交收发行人ID', true);
    const security = securities.get(x.securityId);
    if (!security) throw new Error(`待交收交易引用未知证券：${x.securityId}`);
    if (x.issuerId !== null && !bankIds.has(x.issuerId)) throw new Error(`待交收交易引用未知银行：${x.issuerId}`);
    validatePlanSecurity(x, t);
    date(x.tradeDate, '原成交日'); date(x.settlementDate, '交收日');
    if (x.settlementDate < x.tradeDate) throw new Error('交收日早于原成交日');
    if (singleDay && x.settlementDate !== t.businessDate) throw new Error('单日模式仅允许今日交收的历史交易');
    oneOf(x.direction, ['inflow','outflow'], '待交收方向');
    if (x.direction !== DIRECTION[x.businessType]) throw new Error('待交收方向与业务类型不一致');
    if (x.kind === 'primary_cd_subscription' && (x.businessType !== 'cd_buy' || security.instrumentKind !== 'cd'))
      throw new Error('一级CD认购只能引用存单买入');
    positiveMoney(x.amountYuan, '待交收金额', true);
    boolean(x.holdingIncludedAtOpen, '持仓已包含'); boolean(x.cashIncludedAtOpen, '现金已包含');
  }
  unique(t.pendingSettlements, 'tradeId', '待交收交易');
  const cashSourceIds = [...t.maturityCashEvents.map(e => e.eventId), ...t.pendingSettlements.map(x => x.tradeId)];
  if (new Set(cashSourceIds).size !== cashSourceIds.length) throw new Error('期初现金来源ID重复');

  array(t.draftPlans, '计划草案');
  for (const p of t.draftPlans) {
    keys(p, ['label','businessType','direction','counterpartyId','issuerId','targetYuan','termsNote',
      'repoTerms','tradeDate','settlementDate','securityId','marketTier'], '计划草案');
    string(p.label, '计划名称'); oneOf(p.businessType, PLAN_TYPES, '计划业务类型');
    if (p.direction !== DIRECTION[p.businessType]) throw new Error('计划方向与业务类型不一致');
    string(p.counterpartyId, '计划交易对手ID', true); string(p.issuerId, '计划发行人ID', true);
    if (p.issuerId !== null && !bankIds.has(p.issuerId) && ['deposit','cd_buy','cd_sell'].includes(p.businessType))
      throw new Error(`计划引用未知银行：${p.issuerId}`);
    if (p.businessType === 'deposit' && p.issuerId === null && p.counterpartyId !== null && !bankIds.has(p.counterpartyId))
      throw new Error(`存款计划引用未知银行：${p.counterpartyId}`);
    positiveMoney(p.targetYuan, '计划金额', true);
    if (typeof p.termsNote !== 'string') throw new Error('计划说明必须为文本');
    if (p.repoTerms !== null) {
      keys(p.repoTerms, ['market','tenorDays','annualRate'], '回购条件');
      oneOf(p.repoTerms.market, FINANCING_MARKETS, '回购市场'); integer(p.repoTerms.tenorDays, '回购期限', 1);
      if (p.repoTerms.annualRate !== null) ratio(p.repoTerms.annualRate, '回购年利率');
      if (singleDay && p.repoTerms.annualRate !== null) throw new Error('单日本金口径不计利息，年利率须为空');
    }
    date(p.tradeDate, '计划交易日'); date(p.settlementDate, '计划交收日');
    if (p.tradeDate !== t.businessDate) throw new Error('新计划交易日须等于模板业务日；历史成交请导入待交收交易');
    if (p.settlementDate < p.tradeDate) throw new Error('计划交收日早于交易日');
    if (singleDay && p.settlementDate !== t.businessDate) throw new Error('单日模式计划必须当日交收');
    string(p.securityId, '计划证券ID', true);
    validatePlanSecurity(p, t);
    oneOf(p.marketTier, ['secondary'], '市场层级', true);
    if (p.marketTier === 'secondary' && !['cd_buy','cd_sell','bond_buy','bond_sell'].includes(p.businessType))
      throw new Error('二级市场层级只适用于现券');
  }
  return t;
}

// Opening ledger cash is actual cash. Unreceived same-day maturities enter business cash separately.
export function openingAccountCash(template) {
  const p = template?.portfolio;
  if (!p || p.accountCashYuan === null || !Number.isSafeInteger(p.accountCashYuan)) return null;
  if (template.demoMode !== SINGLE_DAY_DEMO_MODE) return p.accountCashYuan;
  const net = p.netSubscriptionYuan ?? 0;
  if (!Number.isSafeInteger(net)) return null;
  let cash = BigInt(p.accountCashYuan) + BigInt(net);
  for (const e of template.maturityCashEvents ?? []) {
    if (e.dueDate !== template.businessDate || !e.includedInOpeningCash) continue;
    if (!Number.isSafeInteger(e.amountYuan)) return null;
    cash += BigInt(e.direction === 'outflow' ? -e.amountYuan : e.amountYuan);
  }
  return cash <= BigInt(Number.MAX_SAFE_INTEGER) && cash >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(cash) : null;
}

export function createSyntheticInitialTemplate({ businessDate = '2026-09-07' } = {}) {
  date(businessDate, '业务日期');
  const previousTradeDate = (() => {
    const d = new Date(`${businessDate}T00:00:00Z`);
    do { d.setUTCDate(d.getUTCDate() - 1); } while ([0,6].includes(d.getUTCDay()));
    return d.toISOString().slice(0, 10);
  })();
  const nextDate = (() => {
    const d = new Date(`${businessDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const draft = (label, businessType, issuerId, targetYuan, tradeDate, settlementDate, securityId = null) => ({
    label, businessType, direction:DIRECTION[businessType], counterpartyId:null, issuerId,
    targetYuan, termsNote:'合成演示计划', repoTerms:null, tradeDate, settlementDate,
    securityId, marketTier:securityId !== null && ['cd_buy','cd_sell','bond_buy','bond_sell'].includes(businessType) ? 'secondary' : null,
  });
  return normalizeInitialTemplate({
    templateVersion:INITIAL_TEMPLATE_VERSION, templateId:'SYNTHETIC-B-01', label:'单日同额合成默认模板', revision:3,
    demoMode:SINGLE_DAY_DEMO_MODE,
    provenance:{kind:'synthetic',note:'仅供交易模拟演示；银行、评级、金额和持仓均为虚构输入'},
    businessDate,
    portfolio:{portfolioId:'DEMO-500',label:'合成货币基金',navYuan:50000000000,
      accountCashYuan:300000000,netSubscriptionYuan:0,feeYuan:0,bufferYuan:0,legacyBankExposureYuan:null},
    banks:[
      {bankId:'BANK-A',label:'合成A银行',custodyQualified:true,rating:'AAA',ratingAsOf:businessDate,
        quarterlyNetAssetsYuan:100000000000,quarterEnd:'2026-06-30',depositLimitBps:600},
      {bankId:'BANK-B',label:'合成B银行',custodyQualified:false,rating:'AA',ratingAsOf:businessDate,
        quarterlyNetAssetsYuan:20000000000,quarterEnd:'2026-06-30',depositLimitBps:600},
      {bankId:'BANK-C',label:'合成C银行',custodyQualified:true,rating:'BB',ratingAsOf:businessDate,
        quarterlyNetAssetsYuan:10000000000,quarterEnd:'2026-06-30',depositLimitBps:600},
    ],
    securities:[
      {securityId:'GOV-01',label:'合成短期政府债',instrumentKind:'government_bond',issuerBankId:null,issuerType:'government',isGovernmentBond:true,remainingTradingDays:120},
      {securityId:'DEP-A',label:'合成A银行存款剩余部分',instrumentKind:'deposit',issuerBankId:'BANK-A',issuerType:'bank',isGovernmentBond:false,remainingTradingDays:35},
      {securityId:'DEP-A-T0',label:'合成A银行今日到期存款',instrumentKind:'deposit',issuerBankId:'BANK-A',issuerType:'bank',isGovernmentBond:false,remainingTradingDays:0},
      {securityId:'CD-A',label:'合成A银行存单',instrumentKind:'cd',issuerBankId:'BANK-A',issuerType:'bank',isGovernmentBond:false,remainingTradingDays:50},
      {securityId:'CD-B',label:'合成B银行存单',instrumentKind:'cd',issuerBankId:'BANK-B',issuerType:'bank',isGovernmentBond:false,remainingTradingDays:80},
      {securityId:'CD-C',label:'合成C银行存单',instrumentKind:'cd',issuerBankId:'BANK-C',issuerType:'bank',isGovernmentBond:false,remainingTradingDays:70},
      {securityId:'BOND-C',label:'合成C银行债券',instrumentKind:'bond',issuerBankId:'BANK-C',issuerType:'bank',isGovernmentBond:false,remainingTradingDays:160},
      {securityId:'BOND-X',label:'合成普通债券',instrumentKind:'bond',issuerBankId:null,issuerType:'non_bank',isGovernmentBond:false,remainingTradingDays:110},
    ],
    holdings:[
      {holdingId:'H-GOV',securityId:'GOV-01',amountYuan:2500000000,sellableYuan:2500000000},
      {holdingId:'H-DEP-A',securityId:'DEP-A',amountYuan:300000000,sellableYuan:0},
      {holdingId:'H-DEP-A-T0',securityId:'DEP-A-T0',amountYuan:200000000,sellableYuan:0},
      {holdingId:'H-CD-A',securityId:'CD-A',amountYuan:1000000000,sellableYuan:600000000},
      {holdingId:'H-CD-B',securityId:'CD-B',amountYuan:200000000,sellableYuan:200000000},
      {holdingId:'H-CD-C',securityId:'CD-C',amountYuan:100000000,sellableYuan:100000000},
      {holdingId:'H-BOND-C',securityId:'BOND-C',amountYuan:100000000,sellableYuan:100000000},
      {holdingId:'H-BOND-X',securityId:'BOND-X',amountYuan:150000000,sellableYuan:150000000},
    ],
    termWeights:{version:TERM_WEIGHTS_VERSION,coverage:'complete',calendar:'day-365-demo-v1',asOfDate:businessDate,
      // Explicit full opening asset/liability ledger; the residual is a stated synthetic position,
      // never inferred from NAV or missing holdings by the evaluator.
      assets:[
        {weightId:'TW-CASH',label:'合成账户现金',amountYuan:300000000,remainingTradingDays:0,sourceAccountCash:true},
        {weightId:'TW-GOV',label:'合成短期政府债',amountYuan:2500000000,remainingTradingDays:120,sourceHoldingId:'H-GOV'},
        {weightId:'TW-DEP-A',label:'合成A银行存款剩余部分',amountYuan:300000000,remainingTradingDays:35,sourceHoldingId:'H-DEP-A'},
        {weightId:'TW-DEP-A-T0',label:'合成A银行今日到期存款',amountYuan:200000000,remainingTradingDays:0,sourceHoldingId:'H-DEP-A-T0'},
        {weightId:'TW-CD-A',label:'合成A银行存单',amountYuan:1000000000,remainingTradingDays:50,sourceHoldingId:'H-CD-A'},
        {weightId:'TW-CD-B',label:'合成B银行存单',amountYuan:200000000,remainingTradingDays:80,sourceHoldingId:'H-CD-B'},
        {weightId:'TW-CD-C',label:'合成C银行存单',amountYuan:100000000,remainingTradingDays:70,sourceHoldingId:'H-CD-C'},
        {weightId:'TW-BOND-C',label:'合成C银行债券',amountYuan:100000000,remainingTradingDays:160,sourceHoldingId:'H-BOND-C'},
        {weightId:'TW-BOND-X',label:'合成普通债券',amountYuan:150000000,remainingTradingDays:110,sourceHoldingId:'H-BOND-X'},
        {weightId:'TW-OTHER',label:'合成其他已核算资产',amountYuan:45150000000,remainingTradingDays:25},
      ],liabilities:[],positiveRepos:[]},
    otherFundBankExposure:[
      {bankId:'BANK-A',depositYuan:1000000000,cdYuan:500000000,bondYuan:200000000,otherYuan:0},
      {bankId:'BANK-B',depositYuan:100000000,cdYuan:200000000,bondYuan:0,otherYuan:0},
      {bankId:'BANK-C',depositYuan:20000000,cdYuan:10000000,bondYuan:10000000,otherYuan:0},
    ],
    financingResources:{INTERBANK:{quotaConfirmedYuan:1500000000,pledgeConfirmedYuan:1200000000},
      SSE:{quotaConfirmedYuan:500000000,pledgeConfirmedYuan:500000000},
      SZSE:{quotaConfirmedYuan:500000000,pledgeConfirmedYuan:500000000}},
    ruleInitials:{depositThreshold:'0.08',observationThreshold:'0.082'},
    maturityCashEvents:[
      {eventId:'MAT-T0-DEP-A',label:'合成A银行存款今日到期',kind:'deposit_maturity',direction:'inflow',
        amountYuan:200000000,dueDate:businessDate,includedInOpeningCash:false,sourceHoldingId:'H-DEP-A-T0'},
    ],
    pendingSettlements:[
      {tradeId:'PRIMARY-CD-A',label:'合成一级存单已确认待缴款',kind:'primary_cd_subscription',businessType:'cd_buy',
        securityId:'CD-A',issuerId:'BANK-A',tradeDate:previousTradeDate,settlementDate:businessDate,
        direction:'outflow',amountYuan:100000000,holdingIncludedAtOpen:false,cashIncludedAtOpen:false},
      {tradeId:'SECONDARY-CD-B',label:'合成昨日存单买入今日交收',kind:'secondary_security_trade',businessType:'cd_buy',
        securityId:'CD-B',issuerId:'BANK-B',tradeDate:previousTradeDate,settlementDate:businessDate,
        direction:'outflow',amountYuan:50000000,holdingIncludedAtOpen:true,cashIncludedAtOpen:false},
    ],
    draftPlans:[
      {...draft('合成逆回购', 'reverse_repo', null,100000000,businessDate,businessDate),
        repoTerms:{market:'INTERBANK',tenorDays:1,annualRate:null}},
      draft('合成A银行存款','deposit','BANK-A',100000000,businessDate,businessDate,'DEP-A'),
      draft('合成B银行存单卖出','cd_sell','BANK-B',50000000,businessDate,businessDate,'CD-B'),
      draft('合成普通债券买入T0','bond_buy',null,50000000,businessDate,businessDate,'BOND-X'),
    ],
  });
}

// Explicit opt-in. Unsupported historical facts cause a visible rejection; the caller may start
// with createSyntheticInitialTemplate() instead of silently dropping those facts.
export function upgradeToSingleDayTemplate(raw) {
  const t = normalizeInitialTemplate(raw);
  if (t.demoMode === SINGLE_DAY_DEMO_MODE) return t;
  if (t.provenance.kind !== 'synthetic') throw new Error('旧历史运行不能自动转成单日模板；请从新默认模板开始');
  const next = copy(t);
  next.demoMode = SINGLE_DAY_DEMO_MODE;
  next.revision += 1;
  next.label = `${next.label}（单日同额）`;
  next.provenance.note += '；显式派生单日本金口径，原模板不变';
  if (next.termWeights) next.termWeights.calendar = 'day-365-demo-v1';
  try { return normalizeInitialTemplate(next); }
  catch (error) { throw new Error(`旧模板包含单日模式不支持的事实（${error.message}）；请从新默认模板开始`); }
}

// Frozen historical C seed for existing saved-run regression tests and comparison.
export function createLegacySyntheticInitialTemplate(options = {}) {
  const t = createSyntheticInitialTemplate(options);
  delete t.demoMode;
  delete t.portfolio.netSubscriptionYuan;
  t.label = 'C迭代合成默认模板';
  t.revision = 2;
  t.securities.find(s=>s.securityId==='DEP-A').label = '合成A银行存款';
  t.securities = t.securities.filter(s=>s.securityId!=='DEP-A-T0');
  t.holdings.find(h=>h.holdingId==='H-DEP-A').amountYuan = 500000000;
  t.holdings = t.holdings.filter(h=>h.holdingId!=='H-DEP-A-T0');
  t.termWeights.calendar = 'weekday-252-demo-v1';
  t.termWeights.assets.find(w=>w.weightId==='TW-DEP-A').amountYuan = 500000000;
  t.termWeights.assets.find(w=>w.weightId==='TW-DEP-A').label = '合成A银行存款';
  t.termWeights.assets = t.termWeights.assets.filter(w=>w.weightId!=='TW-DEP-A-T0');
  delete t.maturityCashEvents[0].sourceHoldingId;
  t.maturityCashEvents.push({eventId:'MAT-T0-REPO',label:'合成回购已到账',kind:'repo_maturity',
    direction:'inflow',amountYuan:50000000,dueDate:t.businessDate,includedInOpeningCash:true});
  const d = new Date(`${t.businessDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+1);
  const nextDate = d.toISOString().slice(0,10);
  t.maturityCashEvents.push({eventId:'MAT-T1-NET',label:'合成未来净赎回',kind:'net_subscription',
    direction:'outflow',amountYuan:80000000,dueDate:nextDate,includedInOpeningCash:false});
  t.draftPlans[3].label = '合成普通债券买入T+1';
  t.draftPlans[3].settlementDate = nextDate;
  return normalizeInitialTemplate(t);
}

export function legacyInitialTemplate(state) {
  object(state, '旧运行');
  const businessDate = state.context?.businessDate ?? '2026-09-07';
  const plans = array(state.plans ?? [], '旧计划');
  const draftPlans = plans.map(p => ({label:p.label,businessType:p.businessType,direction:p.direction,
    counterpartyId:p.counterpartyId ?? null,issuerId:p.issuerId ?? null,targetYuan:p.targetYuan,
    termsNote:p.termsNote ?? '',repoTerms:p.repoTerms ?? null,tradeDate:businessDate,
    settlementDate:businessDate,securityId:null,marketTier:null}));
  const banks = [...new Set(plans.flatMap(p => ['deposit','cd_buy','cd_sell'].includes(p.businessType) ?
    [p.issuerId, p.businessType === 'deposit' ? p.counterpartyId : null] : [])
    .filter(id => typeof id === 'string' && id.trim()))].map(bankId => ({bankId,label:bankId,
      custodyQualified:null,rating:null,ratingAsOf:null,quarterlyNetAssetsYuan:null,quarterEnd:null}));
  return normalizeInitialTemplate({
    templateVersion:INITIAL_TEMPLATE_VERSION,templateId:`LEGACY-${state.scenarioId ?? 'RUN'}`,
    label:`旧${state.scenarioId ?? '运行'}兼容模板`,revision:1,
    provenance:{kind:'legacy',note:'旧运行输入忠实映射；聚合银行敞口未拆为持仓明细'},businessDate,
    portfolio:{portfolioId:state.context?.portfolioId ?? 'DEMO-500',label:'旧演示组合',
      navYuan:state.inputs?.navYuan ?? null,accountCashYuan:state.inputs?.initialCashYuan ?? null,
      feeYuan:state.inputs?.feeYuan ?? null,bufferYuan:state.inputs?.bufferYuan ?? null,
      legacyBankExposureYuan:state.inputs?.bankExposureYuan ?? null},
    banks,securities:[],holdings:[],otherFundBankExposure:[],
    financingResources:copy(state.repoResources ?? Object.fromEntries(FINANCING_MARKETS.map(m =>
      [m,{quotaConfirmedYuan:null,pledgeConfirmedYuan:null}]))),
    ruleInitials:{depositThreshold:state.ruleConfig?.depositThreshold ?? '0.08',
      observationThreshold:state.ruleConfig?.observationThreshold ?? '0.082'},
    maturityCashEvents:[],pendingSettlements:[],draftPlans,
  });
}

export function bankIdForPlan(plan, template) {
  if (!plan || typeof plan !== 'object') return null;
  const security = template?.securities?.find(s => s.securityId === plan.securityId);
  const id = plan.issuerId ?? security?.issuerBankId ??
    (plan.businessType === 'deposit' ? plan.counterpartyId : null);
  return typeof id === 'string' && template?.banks?.some(b => b.bankId === id) ? id : null;
}

export function deriveTemplateExposure(template) {
  const t = normalizeInitialTemplate(template);
  const securityById = new Map(t.securities.map(s => [s.securityId, s]));
  const maturedByHolding = new Map(t.demoMode === SINGLE_DAY_DEMO_MODE ?
    t.maturityCashEvents.filter(e=>e.sourceHoldingId && e.dueDate===t.businessDate)
      .map(e=>[e.sourceHoldingId,e.amountYuan]) : []);
  const byBank = Object.fromEntries(t.banks.map(bank => [bank.bankId,
    {depositYuan:0,cdYuan:0,bondYuan:0,otherYuan:0,totalYuan:0,otherFundsYuan:null,companyTotalYuan:null}]));
  let governmentBondWithinYearYuan = 0;
  for (const h of t.holdings) {
    const s = securityById.get(h.securityId);
    if (s.isGovernmentBond) {
      // The new single-day profile uses 365 stated days; historical runs retain 252 trading days.
      if (s.remainingTradingDays === null) governmentBondWithinYearYuan = null;
      else if (s.remainingTradingDays <= (t.demoMode===SINGLE_DAY_DEMO_MODE?365:252))
        governmentBondWithinYearYuan = sum([governmentBondWithinYearYuan,
          h.amountYuan === null ? null : h.amountYuan-(maturedByHolding.get(h.holdingId)??0)], '一年内政府债');
    }
    if (!s.issuerBankId) continue;
    const row = byBank[s.issuerBankId];
    const key = s.instrumentKind === 'deposit' ? 'depositYuan' : s.instrumentKind === 'cd' ? 'cdYuan' :
      s.instrumentKind === 'bond' ? 'bondYuan' : 'otherYuan';
    row[key] = sum([row[key],h.amountYuan === null ? null : h.amountYuan-(maturedByHolding.get(h.holdingId)??0)], '银行敞口');
  }
  const other = new Map(t.otherFundBankExposure.map(x => [x.bankId,x]));
  for (const [bankId,row] of Object.entries(byBank)) {
    row.totalYuan = sum([row.depositYuan,row.cdYuan,row.bondYuan,row.otherYuan], '本基金银行敞口');
    const x = other.get(bankId);
    row.otherFundsYuan = x ? sum([x.depositYuan,x.cdYuan,x.bondYuan,x.otherYuan], '其他货基敞口') : null;
    row.companyTotalYuan = row.otherFundsYuan === null ? null : sum([row.totalYuan,row.otherFundsYuan], '公司敞口');
  }
  return {byBank,legacyBankExposureYuan:t.portfolio.legacyBankExposureYuan,governmentBondWithinYearYuan};
}

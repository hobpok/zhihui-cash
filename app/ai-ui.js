import { createAiConversation } from './ai-conversation.js';
import { createAiDraft } from './ai-draft.js';
import { displayLabel, displayText } from './display-labels.js';

const money = value => {
  if (!Number.isSafeInteger(value)) return '未知';
  const negative = value < 0 ? '−' : '';
  const abs = BigInt(Math.abs(value));
  const whole = (abs / 100000000n).toLocaleString('zh-CN');
  const fraction = (abs % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${negative}${whole}${fraction ? `.${fraction}` : ''} 亿元`;
};
const yesNo = value => value === true ? '是' : value === false ? '否' : '未知';
const quickQuestions = [
  '当前所有指令是否有合理顺序可全部完成？',
  '还需要额外融资多少才能完成当前指令？',
  '目前指令卡在哪一步？',
  '完成当前指令后，还能安排多少逆回购？',
];
const arr = value => Array.isArray(value) ? value : [];
const label = {
  deposit: '存款', cd_buy: '买入存单', cd_sell: '卖出存单',
  bond_buy: '买入现券', bond_sell: '卖出现券',
  interbank_repo_financing: '银行间正回购', reverse_repo: '银行间逆回购',
  automatic: '自动排序', reverse_repo_first: '融券下单优先', liquidity_last: '平头寸优先',
  feasible: '可行', waiting_conditions: '待前提满足', blocked: '受约束阻断',
  verified_candidate: '找到完整候选顺序', not_verified: '尚未验证完整顺序',
  conditional_candidate: '找到条件候选顺序，待核实在途与步骤前提',
  insufficient_data: '数据不足', search_incomplete: '搜索未穷尽',
  improving: '逐步改善', unresolved_execution: '执行状态待核实',
  invalid_intent: '需求无法验证', ok: '已完成',
  add: '新增', update: '调整', delete: '删除',
  in_flight_fill: '在途指令须成交', in_flight_cash_receipt: '在途资金须到账',
  in_flight_settlement: '在途交易须结算',
  government_purchase_settlement: '政府债买入须交收',
  government_bond_purchase_settled: '假设政府债买入已交收',
  conditional_step: '条件步骤', filled: '前置成交',
  cash_available: '现金到账', payable_cleared: '前置应付款结清',
  pass: '通过', block: '阻断', warn: '提示', warning: '提示', missing: '缺失',
  not_applicable: '不适用', unknown: '未知',
};
const text = value => value === null || value === undefined ? '未知' : String(value);
const human = value => label[value] ?? text(value);
const ruleNames = { C01:'业务头寸', C02:'现金与一年内政府债比例', C09:'平均剩余期限' };
const ruleValue = (row, value) => {
  if (row?.ruleId === 'C01') return money(value);
  if (!Number.isFinite(value)) return '未知';
  if (row?.ruleId === 'C09') return `${Number(value.toFixed(2))} 天`;
  return `${Number((value * 100).toFixed(6))}%`;
};
const ruleThreshold = row => {
  const threshold = row?.threshold;
  if (!threshold) return '未知';
  const limit = Number.isSafeInteger(threshold.valueYuan) ? money(threshold.valueYuan) :
    Number.isFinite(threshold.valueDays) ? `${threshold.valueDays} 天` :
    Number.isFinite(threshold.numerator) && Number.isFinite(threshold.denominator) && threshold.denominator !== 0
      ? `${threshold.numerator}/${threshold.denominator}` : '未知';
  return `${threshold.operator ?? ''} ${limit}`.trim();
};
const ruleIdentity = row => `${text(row?.ruleId)}:${text(row?.subjectId)}`;
const ruleTitle = (row, names) => `${text(row?.ruleId)} ${ruleNames[row?.ruleId] ?? '规则'} · ${names.subject(row?.subjectId)}`;
const node = (tag, className, content) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (content !== undefined) item.textContent = displayText(text(content));
  return item;
};
const line = (parent, title, value) => {
  const row = node('div', 'ai-fact');
  row.append(node('span', '', title), node('strong', '', value));
  parent.append(row);
};
const note = (parent, content, className = 'ai-note') => parent.append(node('p', className, content));
const helpNote = (parent, content) => {
  const item = node('details', 'ai-help-note');
  const summary = node('summary', '', '?');
  summary.setAttribute('aria-label', '查看测算说明');
  item.append(summary, node('p', '', content)); parent.append(item);
};
const list = (parent, title, values) => {
  if (!values.length) return;
  const section = node('section', 'ai-detail');
  section.append(node('h4', '', title));
  const ul = node('ul');
  values.forEach(value => ul.append(node('li', '', value)));
  section.append(ul); parent.append(section);
};
const details = (parent, title, render) => {
  const section = node('details', 'ai-technical');
  section.append(node('summary', '', title));
  render(section); parent.append(section);
};

function remediationConsent(parent, id) {
  const consent = node('label', 'ai-consent');
  const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.id = id;
  consent.append(checkbox, node('span', '', '我同意新增所列卖券补救动作，并确认本方案融资金额；原投资目标保留。'));
  parent.append(consent);
}

export function diagnosticPresentation(diagnostic) {
  if (!diagnostic) return null;
  const reasons = {
    json_parse: '答复格式无法解析', decision_shape: '答复结构不完整', answer_shape: '答复结构不完整',
    reference_missing: '答复缺少核算引用', required_reference: '答复缺少必要核算引用',
    reference_unknown: '答复引用了未取得的依据', reference_duplicate: '核算引用重复',
    reference_stale: '答复引用的依据已经过期', required_tool: '尚未取得本次所需的核算结果',
    no_useful_evidence: '尚未取得有效核算依据', required_answer: '尚未生成可验证的答复',
    narrative_amount: '解释中的金额与核算结果不一致', narrative_percentage: '解释中的比例与核算结果不一致',
    narrative_entity: '解释中的交易对象与依据不一致', narrative_cash: '解释混淆了成交、到账或现金口径',
  };
  const recovery = {
    trusted_summary: '已保留可信工具核算摘要；可加入的方案仍须通过本地复核。',
    rewritten_answer: '解释已按本轮核算依据修复；金额与条件以下方核算结果为准。',
    refresh_run: '请先保存当前运行，再重新发送需求取得最新测算。旧方案不能继续加入。',
    retry: '需求已保留，无需为内部校验失败补充交易要素；可重新发送原需求。',
    clarify: '请补充下方明确列出的缺失交易要素，再重新测算。',
  };
  return { reason: reasons[diagnostic.reason] ?? '答复未通过依据校验',
    recovery: recovery[diagnostic.recovery] ?? '请保留请求编号，重新测算后再核对。' };
}

export function managerFixedTrades(result) {
  // Remediation plans are appended to the normalized intent. Remove only that
  // many matching occurrences, not an identical explicit manager trade as well.
  const remaining = arr(result.remediation?.actions).map(action => ({ ...action }));
  return arr(result.intent?.fixedTrades).slice().reverse().filter(item => {
    const index = remaining.findIndex(action => action.businessType === item.businessType &&
      action.securityId === item.securityId && action.targetYuan === item.targetYuan);
    if (index < 0) return true;
    remaining.splice(index, 1); return false;
  }).reverse();
}

function planningEvidence(parent, result, names) {
  const section = node('section', 'ai-evidence');
  section.append(node('h3', '', '方案测算'));
  line(section, '状态', human(result.status));
  if (Number.isSafeInteger(result.intent?.financing?.maxAmountYuan))
    line(section, '本次融资意向上限', money(result.intent.financing.maxAmountYuan));
  line(section, '融资期限', Number.isSafeInteger(result.intent?.financing?.tenorDays)
    ? `${result.intent.financing.tenorDays} 天` : '未知');
  line(section, '逆回购指定意向金额', result.intent?.reverseRepo?.amountYuan === null
    ? '未指定，由约束内余款测算' : money(result.intent?.reverseRepo?.amountYuan));
  line(section, '逆回购期限', Number.isSafeInteger(result.intent?.reverseRepo?.tenorDays)
    ? `${result.intent.reverseRepo.tenorDays} 天` : '未知');
  for (const term of arr(result.termAssumptions)) {
    note(section, `${human(term.businessType)}按 ${term.tenorDays} 天建议期限测算；加入指令区即确认本方案期限，可先在对话中修改。`, 'ai-warning');
  }
  const corrective = arr(result.remediation?.actions);
  if (result.remediation) {
    list(section, '补救核算说明', arr(result.remediation.reasons).map(text));
    list(section, '待经理确认的新增卖券', corrective.map(item =>
      `${human(item.businessType)} · ${names.asset(item.securityId)} · ${money(item.targetYuan)}；${text(item.reason)}`));
    if (corrective.length) note(section, '原投资目标完整保留。卖券实际成交后才释放额度，实际付款仍核验账户现金。', 'ai-warning');
  }
  const fixed = managerFixedTrades(result).map(item =>
    `${human(item.businessType)} · ${names.asset(item.securityId)} · ${money(item.targetYuan)}`);
  list(section, '经理固定交易目标', fixed);
  list(section, '保留的已有交易', arr(result.existingFixedTargets).map(item =>
    `${names.plan(item.planId)} · ${names.asset(item.securityId)} · 尚需 ${money(item.remainingYuan)}${Number.isSafeInteger(item.remainingTradingDays) ? ` · 剩余 ${item.remainingTradingDays} 天` : ''}`));
  for (const [key, title] of [['main', '主方案'], ['alternative', '备选方案']]) {
    const item = result[key];
    if (!item) continue;
    const card = node('section', 'ai-candidate');
    card.append(node('h4', '', title));
    line(card, '可应用性', yesNo(item.applicable));
    line(card, '状态', human(item.status));
    line(card, result.intent?.financing?.planId === null ? '本次新增融资' : '融资计划意向金额', money(item.financingYuan));
    line(card, result.intent?.reverseRepo?.planId === null ? '本次新增逆回购' : '逆回购计划意向金额', money(item.reverseRepoYuan));
    line(card, '预计期末余额（按结算假设）', money(item.projectedFinalCashYuan));
    if (item.requiresTargetChange) {
      note(card, `需经理同意调整原逆回购目标：${money(item.targetChange?.fromYuan)} → ${money(item.targetChange?.toYuan)}。`, 'ai-warning');
    }
    const conditions = [];
    if (item.requiresInFlightFinancingReceipt) conditions.push('依赖在途融资到账');
    if (item.unconfirmedFinancingResource) conditions.push('融资资源尚未确认');
    if (item.unresolvedExecution) conditions.push('执行路径仍有未解决前提');
    if (item.search?.complete === false) helpNote(card, '搜索未穷尽，仅代表已验证候选。');
    if (arr(item.governmentBondSettlementAssumptions).length) conditions.push('含政府债交收假设');
    list(card, '前提与限制', conditions);
    list(card, '执行前提', arr(item.executionPrerequisites).map(x =>
      `${human(x.kind)} · ${names.plan(x.planId)}${Number.isSafeInteger(x.amountYuan) ? ` · ${money(x.amountYuan)}` : ''}`));
    details(card, '查看执行路径条件', section => list(section, '路径条件',
      arr(item.executionPath).filter(x => x.condition || x.blocked)
        .map(x => `${names.plan(x.planId)} · ${x.blocked ? '受阻；' : ''}${text(x.condition)}`)));
    list(card, '未满足目标', arr(item.unmetTargets).map(x =>
      `${names.plan(x.planId)}：未安排 ${money(x.unarrangedYuan)}`));
    list(card, '阻断及缺失规则', [...arr(item.finalRules?.blocking), ...arr(item.finalRules?.missing)]
      .map(x => `${text(x.ruleId)} · ${names.subject(x.subjectId)} · ${human(x.result)}`));
    section.append(card);
  }
  if (result.search?.complete === false) helpNote(section, '全局搜索未穷尽；结论仅限已验证候选。');
  list(section, '限制规则', arr(result.limitations).map(x => `${text(x.ruleId)} · ${human(x.result)}`));
  parent.append(section);
}

function metricsEvidence(parent, result) {
  const section = node('section', 'ai-evidence');
  section.append(node('h3', '', '当前指标证据'));
  line(section, '净资产', money(result.portfolio?.navYuan));
  line(section, '账户现金', money(result.portfolio?.accountCashYuan));
  line(section, '业务可用头寸', money(result.portfolio?.businessAvailableYuan));
  const rules = result.currentRules;
  if (rules) {
    line(section, '规则状态', `阻断 ${arr(rules.blocking).length} · 缺失 ${arr(rules.missing).length}`);
    list(section, '关键指标', arr(rules.rows).filter(x => ['C01', 'C02', 'C09'].includes(x.ruleId))
      .map(x => {
        return `${ruleNames[x.ruleId]}：${ruleValue(x, x.currentValue)}；${human(x.result)}`;
      }));
  }
  parent.append(section);
}

function completionEvidence(parent, result, names) {
  const section = node('section', 'ai-evidence ai-completion-simulation');
  section.append(node('h3', '', '现有指令全部完成后的条件测算'));
  helpNote(section, '按现有指令的原金额、原期限测算；期末值以全部成交和收付完成为前提。');
  line(section, '条件期末规则', human(result.terminalStatus));
  line(section, '当前可下达状态', '需交易台本地最新快照复核');
  line(section, '逐笔直接推进初筛', `${arr(result.currentDispatch?.immediatelyEligiblePlanIds).length} 项；仍须计算、审核与核实付款`);
  list(section, '当前直接推进的计划', arr(result.currentDispatch?.immediatelyEligiblePlanIds).map(id => names.plan(id)));
  line(section, '完整顺序', human(result.pathStatus));
  line(section, '当前排单执行', human(result.executionStatus));
  line(section, '条件期末业务头寸', money(result.projectedFinalCashYuan));
  line(section, '全部收付完成后的实际账户现金', money(result.projectedFinalAccountCashYuan));
  if (result.accountCashProjection) {
    details(section, '查看实际现金收付核算', body => {
      const cash = result.accountCashProjection;
      line(body, '当前实际账户现金', money(cash.currentAccountCashYuan));
      line(body, '计划未到账总额（含已成交）', money(cash.remainingPlanInflowsYuan));
      line(body, '计划未付款总额（含已成交）', money(cash.remainingPlanOutflowsYuan));
      line(body, '其中：已成交尚未收款', money(cash.outstandingFilledInflowsYuan));
      line(body, '其中：已成交尚未付款', money(cash.outstandingFilledOutflowsYuan));
      line(body, '期初待收款', money(cash.outstandingOpeningReceiptsYuan));
      line(body, '期初待付款', money(cash.outstandingOpeningPaymentsYuan));
      list(body, '待核实信息', arr(cash.needed));
      note(body, cash.assumption || '仅为全部现有计划成交、结算和资金划拨完成后的条件投影；不代表当前可付款金额。');
    });
  }
  const current = result.currentRules ?? {}, final = result.finalRules ?? {};
  line(section, '当前规则', `阻断 ${arr(current.blocking).length} · 缺失 ${arr(current.missing).length}`);
  line(section, '期末规则', `阻断 ${arr(final.blocking).length} · 缺失 ${arr(final.missing).length}`);
  if (current.enabled === false || final.enabled === false)
    note(section, '当前运行未启用完整规则，期末指标不能据此判为通过。', 'ai-warning');
  const currentById = new Map(arr(current.rows).map(row => [ruleIdentity(row), row]));
  const finalById = new Map(arr(final.rows).map(row => [ruleIdentity(row), row]));
  const allIds = [...new Set([...currentById.keys(), ...finalById.keys()])];
  const describe = id => {
    const before = currentById.get(id), after = finalById.get(id);
    const row = after ?? before;
    return `${ruleTitle(row, names)}：${ruleValue(row, before?.currentValue)} → ${ruleValue(row, after?.projectedValue)}；阈值 ${ruleThreshold(row)}；当前 ${human(before?.result)}，期末 ${human(after?.result)}`;
  };
  list(section, '关键指标（当前 → 条件期末）', allIds.filter(id =>
    ['C01:PORTFOLIO', 'C02:PORTFOLIO', 'C09:PORTFOLIO'].includes(id)).map(describe));
  details(section, '查看全部规则值与阈值', body => list(body, '逐项规则', allIds.map(describe)));
  if (current.rowsTruncated || final.rowsTruncated || result.outputTruncated)
    note(section, '规则明细已截断；缺失的值不能据此判为通过。', 'ai-warning');
  list(section, '期末阻断及缺失', [...arr(final.blocking), ...arr(final.missing)].map(row =>
    `${ruleTitle(row, names)}：${human(row.result)}；阈值 ${ruleThreshold(row)}${arr(row.needed).length ? `；待补 ${row.needed.join('、')}` : ''}`));
  list(section, '候选执行顺序与前提', arr(result.executionPath).map((step, index) =>
    `${index + 1}. ${step.planLabel || names.plan(step.planId)}${Number.isSafeInteger(step.nominalYuan) ? ` · ${money(step.nominalYuan)}` : ''}：${step.blocked ? '受阻；' : ''}${step.condition || '仍须使用最新快照核验并完成成交结算'}`));
  list(section, '在途成交及交收到账前提', arr(result.inFlightPrerequisites).map(item =>
    `${human(item.kind)} · ${names.plan(item.planId)}${Number.isSafeInteger(item.amountYuan) ? ` · ${money(item.amountYuan)}` : ''}`));
  list(section, '当前未满足目标', arr(result.unmetTargets).map(row =>
    `${names.plan(row.planId)}：未安排 ${money(row.unarrangedYuan)}`));
  if (result.executionPathTruncated || result.unmetTargetsTruncated)
    note(section, '执行路径或未满足目标明细已截断。', 'ai-warning');
  if (result.search?.complete === false)
    helpNote(section, '执行路径搜索未穷尽；过程结论仅限已验证路径。');
  if (result.pathStatus === 'not_verified')
    note(section, '有界搜索未找到完整顺序，不等于证明全部指令无解。', 'ai-warning');
  if (arr(result.assumptions).length) details(section, '测算假设', body => list(body, '假设', arr(result.assumptions)));
  parent.append(section);
}

function sortingEvidence(parent, result) {
  const section = node('section', 'ai-evidence');
  section.append(node('h3', '', '排单复核'));
  line(section, '复核模式', label[result.reviewedMode] ?? text(result.reviewedMode));
  line(section, '当前计划排单', human(result.currentProposal?.status));
  line(section, '未安排金额', money(result.currentProposal?.unarrangedYuan));
  list(section, '候选顺序', arr(result.orderedRoles).map(x => x === 'main' ? '主方案' : x === 'alternative' ? '备选方案' : text(x)));
  parent.append(section);
}

function executionEvidence(parent, result, names) {
  const section = node('section', 'ai-evidence ai-execution-diagnosis');
  section.append(node('h3', '', '未完成交易与下一步'));
  const unfinished = arr(result.unfinishedPlans);
  line(section, '未完成计划', `${unfinished.length} 笔`);
  line(section, '当前账户现金', money(result.cashReconciliation?.accountCashYuan));
  line(section, '当前业务头寸', money(result.current?.cash?.businessCashYuan));
  line(section, '已成交卖券待收款（已计入头寸）', money(result.current?.cash?.saleUncreditedYuan));
  line(section, '一年内政府债（另计）', money(result.current?.cash?.governmentBondWithinYearYuan));
  for (const action of arr(result.settlementActions)) {
    const kind = {receive_cash:'待确认到账并可用',settle_inflow:'待确认结算',pay_cash:'待确认付款',verify_unknown:'接收状态待核实',receive_opening_cash:'日初应收款待确认到账',pay_opening_cash:'日初应付款待确认付款'}[action.kind] || human(action.kind);
    const countedSale = action.kind === 'receive_cash' && ['cd_sell','bond_sell'].includes(action.businessType)
      && Number.isSafeInteger(result.current?.cash?.saleUncreditedYuan);
    note(section, `${names.plan(action.planId)}：${countedSale ? '卖券款待收，已按成交计入业务头寸及比例' : kind}${Number.isSafeInteger(action.amountYuan) ? ` ${money(action.amountYuan)}` : ''}。`, countedSale ? 'ai-info' : 'ai-warning');
  }
  list(section, '建议操作顺序', arr(result.recommendations).map(item => item.text).filter(Boolean));
  const bridge = result.liquidityBridge;
  if (bridge) {
    const card = node('section', 'ai-detail');
    card.append(node('h4', '', '完成剩余付款后的条件测算'));
    line(card, '账户现金（卖券款尚未到账）', money(bridge.accountCashAfterRemainingOutflowsYuan));
    line(card, '业务头寸（含已成交待收款）', money(bridge.businessCashAfterRemainingOutflowsYuan));
    if (Number.isFinite(bridge.projectedC02RatioAfterRemainingOutflows))
      line(card, '预计现金与一年内政府债比例', `${Number((bridge.projectedC02RatioAfterRemainingOutflows * 100).toFixed(6))}%`);
    line(card, '距比例下限的金额余量', money(bridge.projectedC02HeadroomYuan));
    note(card, bridge.condition); section.append(card);
  }
  details(section, '逐笔阻断依据', body => {
    for (const plan of unfinished) {
      const card = node('section', 'ai-detail');
      card.append(node('h4', '', names.plan(plan.planId)));
      line(card, '未成交目标', money(plan.remainingYuan));
      line(card, '已下达未成交', money(plan.lockedYuan));
      list(card, '当前直接推进的限制', arr(plan.immediateBlockers).map(row =>
        `${text(row.ruleId)}：${human(row.result)}${Number.isSafeInteger(row.headroomYuan) && row.headroomYuan < 0 ? `，缺口 ${money(-row.headroomYuan)}` : ''}${arr(row.needed).length ? `，待补 ${row.needed.join('、')}` : ''}`));
      body.append(card);
    }
  });
  details(section, '现金对账与测算范围', body => {
    const cash = result.cashReconciliation ?? {};
    line(body, '日初现金', money(cash.initialCashYuan));
    line(body, '已确认流入', money(cash.creditedInflowYuan));
    line(body, '已付款', money(cash.paidOutflowYuan));
    line(body, '账户余额核对一致', yesNo(cash.matches));
    list(body, '测算范围', arr(result.limitations));
  });
  parent.append(section);
}

function localCandidate(parent, key, title, candidate, names) {
  if (!candidate) return;
  const card = node('section', 'ai-candidate ai-local-candidate');
  card.append(node('h4', '', title));
  line(card, '可应用性', yesNo(candidate.applicable));
  line(card, '状态', human(candidate.status));
  line(card, '本地融资意向金额', money(candidate.financingYuan));
  line(card, '本地逆回购意向金额', money(candidate.reverseRepoYuan));
  line(card, '本地预计期末余额（按结算假设）', money(candidate.projectedFinalCashYuan));
  if (candidate.requiresTargetChange || key === 'alternative') {
    note(card, '该方案改变逆回购固定目标，确认前须明确同意。', 'ai-warning');
  }
  const conditions = [];
  if (candidate.requiresInFlightFinancingReceipt) conditions.push('须核实在途融资到账');
  if (candidate.unconfirmedFinancingResource) conditions.push('融资资源须确认');
  if (candidate.unresolvedExecution) conditions.push('执行路径尚有前提');
  if (candidate.search?.complete === false) helpNote(card, '搜索未穷尽，仅展示已验证候选。');
  if (arr(candidate.governmentBondSettlementAssumptions).length) conditions.push('含政府债交收假设');
  list(card, '本地复核前提', conditions);
  list(card, '计划变化', arr(candidate.deltas).map(x => {
    const plan = x.plan ?? x.patch ?? {};
    const title = x.kind === 'add' ? `${human(plan.businessType)}${plan.securityId ? ` · ${names.asset(plan.securityId)}` : ''}` : names.plan(x.planId);
    return `${human(x.kind)} · ${title}${x.kind === 'delete' ? '' : ` · ${money(plan.targetYuan)}`}`;
  }));
  list(card, '未满足目标', arr(candidate.unmetTargets).map(x => `${names.plan(x.planId)}：未安排 ${money(x.unarrangedYuan)}`));
  list(card, '执行前提', arr(candidate.stagedVerification?.prerequisites).map(x =>
    `${human(x.kind)} · ${names.plan(x.planId)}${Number.isSafeInteger(x.amountYuan) ? ` · ${money(x.amountYuan)}` : ''}`));
  details(card, '查看执行路径条件', section => list(section, '路径条件',
    arr(candidate.executionPath).filter(x => x.condition || x.blocked)
      .map(x => `${names.plan(x.planId)} · ${x.blocked ? '受阻；' : ''}${text(x.condition)}`)));
  list(card, '阻断及缺失规则', [...arr(candidate.finalRules?.blocking), ...arr(candidate.finalRules?.missing)]
    .map(x => `${text(x.ruleId)} · ${human(x.result)}`));
  parent.append(card);
}

export const canStartNewAiSession = (snapshot, busy, cancelBusy) =>
  !busy && !cancelBusy && snapshot.phase !== 'cancelling';
export const completedAiInput = (currentValue, submittedValue, phase) =>
  phase === 'completed' && submittedValue !== null && currentValue === submittedValue ? '' : currentValue;
const streamStatus = phase => ({ tools: '正在核算当前运行与交易条件…', generating: '正在生成答复…',
  validating: '正在核验答复依据与方案…' }[phase] ?? '正在分析你的需求并核算方案。');

export function setupAiUI({ model, getContext, prepareContext, onAuthError = () => {},
  changed = () => {}, notify = () => {} } = {}) {
  if (!model || typeof getContext !== 'function' || typeof prepareContext !== 'function')
    throw new Error('AI面板缺少本地运行或同步接口');
  const dialog = node('dialog', 'ai-panel'); dialog.id = 'ai-panel';
  dialog.setAttribute('aria-labelledby', 'ai-title');
  dialog.innerHTML = `
    <div class="ai-head"><div><h2 id="ai-title">智汇现金 AI 助手</h2><small>当前工作区 · 测算与经理确认</small></div><button type="button" id="ai-close" aria-label="关闭AI助手">关闭</button></div>
    <div class="ai-scroll"><p class="ai-intro">可以为已有买券计算融资和余款逆回购，也可描述新增交易、金额或期限。确认建议后加入指令区。</p>
      <div id="ai-status" role="status" aria-live="polite"></div><p id="ai-wait-clock" role="timer" aria-live="off" hidden></p><div id="ai-results"></div><section id="ai-preview" class="ai-answer ai-preview" hidden><h3>答复生成中</h3><p class="ai-preview-notice">以下为尚未校验的临时正文，不构成方案。金额、条件与可加入的指令以完成后的核验结果为准。</p><p id="ai-preview-text"></p></section><div id="ai-local"></div><div id="ai-feedback" role="status" aria-live="polite"></div></div>
    <div class="ai-compose"><div class="ai-quick-questions" role="group" aria-label="快捷提问"></div><label for="ai-message">经理需求 <span id="ai-count">0/1600</span></label><textarea id="ai-message" maxlength="1600" rows="3" placeholder="选择上方问题，或描述您的交易需求…"></textarea>
      <div class="ai-actions"><button type="button" id="ai-new">新会话</button><button type="button" id="ai-recover" hidden>重试原请求</button><button type="button" id="ai-cancel" hidden>取消请求</button><button type="button" id="ai-send" class="primary">发送需求</button></div></div>`;
  document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector);
  const status = $('#ai-status'), waitClock = $('#ai-wait-clock'), results = $('#ai-results'), local = $('#ai-local'), feedback = $('#ai-feedback');
  const preview = $('#ai-preview'), previewText = $('#ai-preview-text');
  const message = $('#ai-message'), send = $('#ai-send'), recover = $('#ai-recover'), cancel = $('#ai-cancel');
  for (const question of quickQuestions) {
    const button = node('button', 'ai-quick-question', question);
    button.type = 'button';
    button.title = '填入提问框，可编辑后发送';
    button.addEventListener('click', () => {
      message.value = question;
      message.dispatchEvent(new Event('input', { bubbles: true }));
      message.focus();
    });
    $('.ai-quick-questions').append(button);
  }
  const draft = createAiDraft({ model });
  let currentContext = null, lastResultKey = '', reviewed = null, busy = false,
    cancelBusy = false, applied = false, renderKey = '', accountEpoch = 0, clockTimer = null;

  let pendingStorage = null;
  try { pendingStorage = window.sessionStorage; } catch { /* Private browsing may disable storage. */ }
  const conversation = createAiConversation({ onAuthError, onChange: snapshot => render(snapshot), pendingStorage });
  const names = {
    asset(id) {
      if (!id) return '无需指定资产';
      const found = model.getState().initialData?.securities?.find(item => item.securityId === id);
      return displayLabel(found?.label) || '当前资产';
    },
    plan(id) {
      if (!id) return '相关计划';
      const found = model.getState().plans?.find(item => item.planId === id);
      if (found?.label) return displayLabel(found.label);
      const suffix = /(?:^|-)P-(\d+)$/.exec(id)?.[1];
      return suffix ? `拟新增计划${suffix}` : '拟新增计划';
    },
    subject(id) {
      if (id === 'PORTFOLIO') return '组合';
      const state = model.getState();
      return displayLabel(state.initialData?.banks?.find(item => item.bankId === id)?.label ||
        state.initialData?.securities?.find(item => item.securityId === id)?.label ||
        state.plans?.find(item => item.planId === id)?.label) || '相关对象';
    },
  };
  function showFeedback(message, kind = 'ai-error', scroll = true) {
    feedback.replaceChildren();
    if (message) note(feedback, message, kind);
    if (scroll && message) feedback.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function invalidateDraft() {
    draft.invalidate(); reviewed = null; applied = false; local.replaceChildren();
  }
  function refresh() {
    const next = getContext() ?? null;
    const fingerprint = JSON.stringify(next);
    if (fingerprint !== JSON.stringify(currentContext)) {
      currentContext = next ? structuredClone(next) : null;
      invalidateDraft(); lastResultKey = ''; renderKey = '';
      conversation.setContext(next);
    } else updateControls(conversation.snapshot());
  }
  function clear() {
    accountEpoch++;
    stopClock();
    currentContext = null; lastResultKey = ''; renderKey = ''; busy = false; cancelBusy = false;
    invalidateDraft(); conversation.setContext(null);
    showFeedback('', 'ai-note', false);
    message.value = ''; $('#ai-count').textContent = '0/1600';
    refresh();
  }
  function updateControls(snapshot) {
    const hasContext = Boolean(snapshot.context?.synced);
    // A first login may need a save before getContext can produce a document revision.
    send.disabled = busy || cancelBusy || ['running', 'cancelling'].includes(snapshot.phase) || snapshot.recoverable;
    send.textContent = snapshot.phase === 'error' && !snapshot.recoverable ? '重新发送需求'
      : snapshot.userTurns.length && snapshot.phase === 'completed' ? '发送追问' : '发送需求';
    recover.hidden = !snapshot.recoverable;
    recover.disabled = busy || cancelBusy || !hasContext;
    cancel.hidden = !['running', 'cancelling'].includes(snapshot.phase) && !snapshot.recoverable;
    cancel.textContent = snapshot.phase === 'cancelling' ? '取消中…' : '取消请求';
    cancel.disabled = cancelBusy;
    $('#ai-new').disabled = !canStartNewAiSession(snapshot, busy, cancelBusy);
    dialog.querySelectorAll('[data-ai-stage]').forEach(button => {
      button.disabled = busy || cancelBusy || applied || !hasContext || ['running', 'cancelling'].includes(snapshot.phase);
    });
  }
  function stopClock() {
    if (clockTimer !== null) { clearInterval(clockTimer); clockTimer = null; }
  }
  function updateClock(snapshot = conversation.snapshot()) {
    if (!Number.isFinite(snapshot.elapsedMs)) { waitClock.hidden = true; waitClock.textContent = ''; return; }
    const seconds = Math.floor(snapshot.elapsedMs / 1000);
    waitClock.hidden = false;
    waitClock.textContent = snapshot.recoverable && snapshot.phase === 'error'
      ? `距原请求发起 ${seconds} 秒` : ['running', 'cancelling'].includes(snapshot.phase)
        ? `已等待 ${seconds} 秒` : `本次耗时 ${seconds} 秒`;
  }
  function syncClock(snapshot) {
    updateClock(snapshot);
    if (dialog.open && (['running', 'cancelling'].includes(snapshot.phase) || snapshot.recoverable)) {
      if (clockTimer === null) clockTimer = setInterval(() => updateClock(), 1000);
    } else stopClock();
  }
  function render(snapshot) {
    const resultKey = snapshot.result ? JSON.stringify(snapshot.result) : '';
    if (resultKey !== lastResultKey) {
      invalidateDraft(); lastResultKey = resultKey;
      renderKey = '';
    }
    const key = JSON.stringify([snapshot.phase, snapshot.error, snapshot.requestId, snapshot.context,
      snapshot.recovering, snapshot.startedAt, snapshot.completedAt, snapshot.transcript]);
    if (key !== renderKey) {
      renderKey = key;
      status.replaceChildren();
      if (!snapshot.context) note(status, '请先登录并打开当前工作区。', 'ai-warning');
      else if (!snapshot.context.synced) note(status, '发送需求时会先保存当前运行，再根据最新状态分析。', 'ai-info');
      if (snapshot.phase === 'running') note(status, snapshot.recovering
        ? '正在自动查询原请求状态；如已完成，仅取回同一请求的答复。'
        : streamStatus(snapshot.streamPhase), 'ai-info ai-stream-status');
      if (snapshot.phase === 'cancelling') note(status, '正在请求服务端取消；本地等待已停止，请稍候确认结果。', 'ai-info');
      if (snapshot.phase === 'cancelled') note(status, '本次请求已取消。');
      if (snapshot.error) note(status, snapshot.error, 'ai-error');
      const diagnostic = snapshot.diagnostic ?? snapshot.result?.diagnostic;
      const diagnosticView = diagnosticPresentation(diagnostic);
      if (diagnosticView) {
        note(status, `${diagnostic.recovered ? '已恢复：' : '失败原因：'}${diagnosticView.reason}。${diagnosticView.recovery}`, diagnostic.recovered ? 'ai-info' : 'ai-warning');
      }
      if ((diagnosticView || snapshot.error) && snapshot.requestId)
        note(status, `请求编号：${snapshot.requestId}`, 'ai-note');
      if (snapshot.recoverable) note(status, '请点“重试原请求”核对同一请求；确认前不能重新发送。若放弃追问上下文，可明确开启新会话。', 'ai-warning');
      else if (snapshot.phase === 'error' && snapshot.context?.synced && !diagnosticView)
        note(status, '需求仍在输入框中；可修改后重新发送，或开启新会话整理完整需求。', 'ai-info');
      results.replaceChildren();
      if (arr(snapshot.transcript).length) {
        const history = node('section', 'ai-transcript');
        history.append(node('h3', '', `本会话记录（${snapshot.transcript.length}轮）`));
        snapshot.transcript.forEach((turn, index) => {
          const item = node('div', 'ai-transcript-turn');
          const oldBasis = turn.basisRevision !== snapshot.context?.documentRevision ||
            turn.basisLocalVersion !== snapshot.context?.localVersion;
          item.append(node('p', 'ai-transcript-user', `经理：${turn.userMessage}${oldBasis ? '（旧依据，仅供回看）' : ''}`));
          if (index < snapshot.transcript.length - 1 || !snapshot.result)
            item.append(node('p', 'ai-transcript-answer', `AI${oldBasis ? '（旧依据，仅供回看）' : ''}：${turn.assistantAnswer}`));
          history.append(item);
        });
        results.append(history);
      }
      if (snapshot.result) {
        const answer = node('section', 'ai-answer');
        answer.append(node('h3', '', snapshot.result.status === 'clarification' ? '需补充信息' :
          snapshot.result.status === 'unsupported' ? '当前无法支持' : 'AI答复'));
        if (snapshot.result.status === 'answer') {
          if (snapshot.result.narrative) {
            answer.append(node('p', 'ai-narrative', snapshot.result.narrative));
            note(answer, 'AI解读 · 金额与执行条件见下方核算依据。', 'ai-note');
            if (snapshot.result.answer !== snapshot.result.narrative)
              details(answer, '查看工具核算摘要', section => section.append(node('p', 'ai-raw-answer', snapshot.result.answer)));
          } else answer.append(node('p', 'ai-narrative', snapshot.result.answer));
        } else answer.append(node('p', '', snapshot.result.answer));
        results.append(answer);
        if (snapshot.result.basis) {
          details(results, '查看测算依据版本', basis => {
            line(basis, '已保存文档修订', snapshot.result.basis.documentRevision ?? '未知');
            line(basis, '本地运行修订', snapshot.result.basis.versions?.runRevision ?? '未知');
            line(basis, '规则版本', snapshot.result.basis.versions?.rules ?? '未知');
            line(basis, '知识库版本', snapshot.result.basis.knowledgeVersion ?? '未知');
            line(basis, '偏好版本', snapshot.result.basis.versions?.preferences ?? '未知');
            line(basis, '融资资源版本', snapshot.result.basis.versions?.resources ?? '未知');
          });
        }
        if (snapshot.result.status === 'answer') {
          for (const item of arr(snapshot.result.evidence)) {
            if (item.name === 'plan_trades') planningEvidence(results, item.result ?? {}, names);
            else if (item.name === 'read_metrics') details(results, '查看当前指标核算依据', section => metricsEvidence(section, item.result ?? {}));
            else if (item.name === 'review_sorting') details(results, '查看排单核算依据', section => sortingEvidence(section, item.result ?? {}));
            else if (item.name === 'diagnose_execution') details(results, '查看未完成交易核算依据', section => executionEvidence(section, item.result ?? {}, names));
            else if (item.name === 'simulate_completion') completionEvidence(results, item.result ?? {}, names);
          }
          const planning = arr(snapshot.result.evidence).findLast(x => x.name === 'plan_trades' && x.result?.intent);
          if (planning) {
            const executable = ['main', 'alternative'].filter(role => planning.result[role]?.applicable);
            if (executable.length) {
              const actionSection = node('section', 'ai-one-click');
              actionSection.append(node('h3', '', '加入指令区'));
              note(actionSection, '确认金额与期限后加入指令区。');
              if (planning.result.remediation?.requiresManagerConfirmation)
                remediationConsent(actionSection, 'ai-stage-remediation-consent');
              if (executable.some(role => role === 'alternative' || planning.result[role]?.requiresTargetChange)) {
                const consent = node('label', 'ai-consent');
                const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.id = 'ai-stage-target-consent';
                consent.append(checkbox, node('span', '', '我同意所选方案调整原逆回购固定目标。'));
                actionSection.append(consent);
              }
              const actions = node('div', 'ai-confirm-actions');
              for (const role of executable) {
                const button = node('button', role === 'main' ? 'primary' : '',
                  role === 'main' ? '将主方案加入指令区' : '将备选方案加入指令区');
                button.type = 'button'; button.dataset.aiStage = role;
                button.addEventListener('click', () => void stageSuggestion(role)); actions.append(button);
              }
              actionSection.append(actions); results.append(actionSection);
            }
            const button = node('button', 'primary', '本地复核方案'); button.id = 'ai-local-review'; button.type = 'button';
            button.addEventListener('click', () => void review()); results.append(button);
          }
        }
      }
    }
    // Keep a stable text node during streaming. Never scroll or rebuild cards for
    // a preview update; only the completed result above can render plan actions.
    const previewValue = displayText(snapshot.phase === 'running' && !snapshot.recovering && !snapshot.result
      ? snapshot.previewText || '' : '');
    preview.hidden = !previewValue;
    if (previewText.textContent !== previewValue) previewText.textContent = previewValue;
    const progressStatus = status.querySelector('.ai-stream-status');
    if (progressStatus && !snapshot.recovering) progressStatus.textContent = streamStatus(snapshot.streamPhase);
    if (snapshot.recoverable && snapshot.pendingMessage && !message.value) {
      message.value = snapshot.pendingMessage;
      $('#ai-count').textContent = `${[...message.value].length}/1600`;
    }
    syncClock(snapshot);
    updateControls(snapshot);
  }
  async function stageSuggestion(role) {
    const snapshot = conversation.snapshot();
    if (busy || applied || !snapshot.result || !currentContext?.synced) return;
    const consent = $('#ai-stage-target-consent')?.checked === true;
    const epoch = accountEpoch;
    let committed = false;
    busy = true; showFeedback('', 'ai-note', false); updateControls(snapshot);
    try {
      const latest = await prepareContext();
      if (epoch !== accountEpoch) return;
      if (JSON.stringify(latest ?? null) !== JSON.stringify(currentContext)) {
        refresh(); throw new Error('运行已变化，请重新获取AI建议。');
      }
      const prepared = draft.prepare(snapshot.result, {
        requestId: snapshot.requestId, documentRevision: currentContext.documentRevision,
      });
      if (prepared.error) throw new Error(prepared.error);
      const candidate = prepared.result?.[role];
      if (!candidate?.applicable) throw new Error('所选方案未通过本地复核，不能加入指令区。');
      if ((role === 'alternative' || candidate.requiresTargetChange) && !consent)
        throw new Error('请先明确同意调整逆回购固定目标。');
      const outcome = draft.confirm(role, { acceptTargetChanges: consent,
        acceptRemediation: $('#ai-stage-remediation-consent')?.checked === true });
      if (outcome.error) throw new Error(outcome.error);
      if (outcome.appliedRole !== role) throw new Error('未完成方案加入。');
      committed = true; applied = true;
      changed('方案已加入指令区，请返回交易台计算。');
      const savedContext = await prepareContext();
      if (epoch !== accountEpoch) return;
      if (!savedContext?.synced) throw new Error('云端尚未确认保存。');
      refresh();
      showFeedback('方案已加入指令区并保存。请返回交易台计算、按所选流程核对并手动下达。', 'ai-success', false);
      notify('AI方案已加入指令区，等待你计算、按所选流程核对并手动下达。');
    } catch (error) {
      if (epoch === accountEpoch) showFeedback(committed
        ? `方案已加入本地指令区，但云端保存尚未确认。请先处理个人空间同步状态，不要重复加入。${error.message || ''}`
        : error.message || '方案复核或加入失败');
    } finally {
      if (epoch === accountEpoch) { busy = false; updateControls(conversation.snapshot()); }
    }
  }
  async function review() {
    const snapshot = conversation.snapshot();
    if (!snapshot.result || !currentContext?.synced || busy) return;
    showFeedback('', 'ai-note', false);
    const epoch = accountEpoch;
    busy = true; updateControls(snapshot);
    try {
      const latest = await prepareContext();
      if (epoch !== accountEpoch) return;
      if (JSON.stringify(latest ?? null) !== JSON.stringify(currentContext)) {
        refresh(); throw new Error('运行已变化，请重新获取AI建议。');
      }
      const outcome = draft.prepare(snapshot.result, {
        requestId: snapshot.requestId, documentRevision: currentContext.documentRevision,
      });
      reviewed = outcome;
      local.replaceChildren();
      const section = node('section', 'ai-local-review');
      section.append(node('h3', '', '本地复核结果'));
      note(section, '以下为本地重算结果。');
      if (outcome?.error) {
        note(section, typeof outcome.error === 'string' ? outcome.error : JSON.stringify(outcome.error), 'ai-error');
      }
      const result = outcome?.result;
      if (result) {
        line(section, '本地测算状态', human(result.status));
        if (result.serverMismatch) {
          note(section, '服务端证据与本地结果不一致，须重新请求AI测算后再确认。', 'ai-error');
          list(section, '差异', arr(result.serverDiscrepancies).map(text));
        }
        localCandidate(section, 'main', '本地主方案', result.main, names);
        localCandidate(section, 'alternative', '本地备选方案', result.alternative, names);
        if (result.search?.complete === false) helpNote(section, '本地搜索未穷尽。');
        const confirmable = result.serverMismatch ? [] : ['main', 'alternative']
          .filter(role => result[role]?.applicable && result[role]?.draftId);
        if (confirmable.length && result.remediation?.requiresManagerConfirmation)
          remediationConsent(section, 'ai-remediation-consent');
        if (confirmable.includes('alternative') || confirmable.includes('main') && result.main?.requiresTargetChange) {
          const consent = node('label', 'ai-consent');
          const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.id = 'ai-target-consent';
          checkbox.addEventListener('change', () => showFeedback('', 'ai-note', false));
          consent.append(checkbox, node('span', '', '我同意调整原逆回购固定目标，并确认按本地复核金额应用。'));
          section.append(consent);
        }
        const actions = node('div', 'ai-confirm-actions');
        for (const role of confirmable) {
          const button = node('button', role === 'main' ? 'primary' : '',
            role === 'main' ? '将本地主方案加入指令区' : '将本地备选方案加入指令区');
          button.type = 'button'; button.dataset.aiConfirm = role;
          button.addEventListener('click', () => void confirm(role)); actions.append(button);
        }
        section.append(actions);
      } else if (!outcome?.error) {
        note(section, '本次答复没有可供本地拟单的结构化方案。', 'ai-note');
      }
      local.append(section);
      local.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (error) { if (epoch === accountEpoch) showFeedback(error.message || '本地复核失败'); }
    finally { if (epoch === accountEpoch) { busy = false; updateControls(conversation.snapshot()); } }
  }
  async function confirm(role) {
    if (busy || applied || !reviewed?.result?.[role]?.applicable) return;
    const candidate = reviewed.result[role];
    const consent = $('#ai-target-consent')?.checked === true;
    if ((role === 'alternative' || candidate.requiresTargetChange) && !consent) {
      showFeedback('请先明确同意调整逆回购固定目标。'); return;
    }
    showFeedback('', 'ai-note', false);
    const epoch = accountEpoch;
    busy = true; updateControls(conversation.snapshot());
    try {
      const latest = await prepareContext();
      if (epoch !== accountEpoch) return;
      if (JSON.stringify(latest ?? null) !== JSON.stringify(currentContext)) {
        refresh(); throw new Error('运行已变化，请重新获取AI建议。');
      }
      draft.confirm(role, { acceptTargetChanges: consent,
        acceptRemediation: $('#ai-remediation-consent')?.checked === true });
      const outcome = draft.snapshot();
      if (outcome.error) throw new Error(outcome.error);
      if (outcome.appliedRole !== role) throw new Error('本地确认未完成');
      applied = true;
      local.querySelectorAll('[data-ai-confirm]').forEach(button => { button.disabled = true; });
      changed('方案已加入指令区，请返回交易台计算。');
      showFeedback('方案已加入指令区，请返回交易台计算。', 'ai-success', false);
      dialog.close();
      notify('方案已加入指令区，请返回交易台计算。');
    } catch (error) { if (epoch === accountEpoch) showFeedback(error.message || '确认失败，请重新复核'); }
    finally { if (epoch === accountEpoch) { busy = false; refresh(); updateControls(conversation.snapshot()); } }
  }
  async function submit() {
    const snapshot = conversation.snapshot();
    if (busy || cancelBusy || ['running', 'cancelling'].includes(snapshot.phase) || snapshot.recoverable) return;
    const submittedValue = message.value;
    const input = submittedValue.trim();
    if (!input || [...input].length > 1600) { showFeedback('请输入不超过1600字的需求。'); return; }
    showFeedback('', 'ai-note', false);
    const epoch = accountEpoch;
    busy = true; updateControls(conversation.snapshot());
    try {
      await prepareContext(); refresh();
      if (epoch !== accountEpoch) return;
      if (!currentContext?.synced) throw new Error('请先保存当前运行并处理同步冲突。');
      await conversation.send(input);
      if (epoch !== accountEpoch) return;
      message.value = completedAiInput(message.value, submittedValue, conversation.snapshot().phase);
      $('#ai-count').textContent = `${[...message.value].length}/1600`;
    } catch (error) { if (epoch === accountEpoch) showFeedback(error.message || 'AI请求未发出'); }
    finally { if (epoch === accountEpoch) { busy = false; updateControls(conversation.snapshot()); } }
  }
  function open() {
    refresh();
    if (!dialog.open) dialog.showModal();
    syncClock(conversation.snapshot());
    message.focus();
  }
  document.addEventListener('click', event => {
    if (event.target.closest('[data-ai-open]')) { event.preventDefault(); open(); }
  });
  $('#ai-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', stopClock);
  message.addEventListener('input', () => { $('#ai-count').textContent = `${[...message.value].length}/1600`; });
  message.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); }
  });
  send.addEventListener('click', () => void submit());
  recover.addEventListener('click', async () => {
    if (busy || cancelBusy) return;
    showFeedback('', 'ai-note', false);
    const epoch = accountEpoch;
    const pendingMessage = conversation.snapshot().pendingMessage;
    const submittedValue = message.value === pendingMessage ? message.value : null;
    busy = true; updateControls(conversation.snapshot());
    try {
      await prepareContext(); refresh();
      if (epoch !== accountEpoch) return;
      await conversation.recover();
      if (epoch !== accountEpoch) return;
      message.value = completedAiInput(message.value, submittedValue, conversation.snapshot().phase);
      $('#ai-count').textContent = `${[...message.value].length}/1600`;
    } catch (error) { if (epoch === accountEpoch) showFeedback(error.message || '恢复失败'); }
    finally { if (epoch === accountEpoch) { busy = false; updateControls(conversation.snapshot()); } }
  });
  cancel.addEventListener('click', async () => {
    if (cancelBusy) return;
    cancelBusy = true; updateControls(conversation.snapshot());
    try { await conversation.cancel(); }
    finally { cancelBusy = false; updateControls(conversation.snapshot()); }
  });
  $('#ai-new').addEventListener('click', () => {
    const snapshot = conversation.snapshot();
    if (!canStartNewAiSession(snapshot, busy, cancelBusy)) return;
    if (snapshot.recoverable || snapshot.phase === 'running') {
      if (!window.confirm('开启新会话会放弃原请求的恢复入口。若服务端尚未确认取消，该请求可能仍在处理或已完成。确定继续吗？')) return;
    }
    showFeedback('', 'ai-note', false);
    invalidateDraft(); conversation.reset(); message.value = ''; $('#ai-count').textContent = '0/1600';
  });
  refresh();
  return { refresh, clear, open };
}


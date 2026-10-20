// E5 boundary: server evidence describes intent; only the current local E2 model can create/apply a draft.
import { BUSINESS_TYPES, unitFor } from './business.js';
import { readPlanningSnapshot, preparePlanningDraft, applyConfirmedDraft } from './planning.js';

const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idPattern = /^[\w.:-]{1,128}$/;
const planTypes = new Set(['deposit', 'cd_buy', 'cd_sell', 'bond_buy', 'bond_sell']);
const instrumentFor = type => type === 'deposit' ? 'deposit' : type.startsWith('cd_') ? 'cd' : 'bond';
const validId = value => typeof value === 'string' && idPattern.test(value);
const money = (value, label, positive = false) => {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new Error(`${label}须为安全整数元`);
  return value;
};
const exact = (value, allowed, label) => {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw new Error(`${label}结构无效`);
};
const planId = (value, type, state, label) => {
  if (value === null) {
    const balances = new Map(state.summary.planBalances.map(balance => [balance.planId, balance]));
    if (state.plans.some(plan => plan.businessType === type &&
      (balances.get(plan.planId)?.remainingYuan ?? plan.targetYuan) > 0))
      throw new Error(`${label}已有计划须使用当前精确ID`);
    return undefined;
  }
  if (!validId(value) || !state.plans.some(plan => plan.planId === value && plan.businessType === type))
    throw new Error(`${label}计划ID与当前运行不符`);
  return value;
};

function checkBasis(basis, versions, documentRevision) {
  exact(basis, ['documentRevision', 'runId', 'contractVersion', 'knowledgeVersion',
    'toolVersion', 'versions', 'synthetic'], '证据依据');
  exact(basis.versions, ['runRevision', 'rules', 'ruleConfig', 'preferences', 'resources', 'snapshot'], '证据版本');
  if (!Number.isSafeInteger(documentRevision) || documentRevision < 1 ||
    basis.documentRevision !== documentRevision || basis.runId !== versions.runId ||
    basis.toolVersion !== versions.tool || basis.knowledgeVersion !== versions.knowledge ||
    basis.versions.runRevision !== versions.revision || basis.versions.rules !== versions.rules ||
    basis.versions.ruleConfig !== versions.ruleConfig ||
    basis.versions.preferences !== versions.preferences ||
    basis.versions.resources !== versions.resources || basis.versions.snapshot !== versions.snapshot)
    throw new Error('对话依据与当前运行或已保存文档版本不符，请保存后重新测算');
  if (basis.contractVersion !== 'ai-planning-contract-0.1') throw new Error('对话拟单合同版本不受支持');
}

function reconstructIntent(projected, snapshot, requestId) {
  exact(projected, ['fixedTrades', 'financing', 'reverseRepo', 'allowReduceReverseRepo'], '规范化意图');
  if (!Array.isArray(projected.fixedTrades) || projected.fixedTrades.length > 32)
    throw new Error('固定交易集合无效');
  if (typeof projected.allowReduceReverseRepo !== 'boolean') throw new Error('备选方案开关无效');
  const state = snapshot.state;
  const fixedPlans = projected.fixedTrades.map((trade, index) => {
    exact(trade, ['businessType', 'securityId', 'targetYuan'], `固定交易${index + 1}`);
    const { businessType, securityId } = trade;
    if (!planTypes.has(businessType) || !validId(securityId)) throw new Error('固定交易类型或资产ID无效');
    const security = state.initialData.securities.find(row => row.securityId === securityId);
    if (!security || security.instrumentKind !== instrumentFor(businessType) ||
      !Number.isSafeInteger(security.remainingTradingDays) || security.remainingTradingDays < 0)
      throw new Error('固定交易资产与当前运行不符');
    const targetYuan = money(trade.targetYuan, '固定交易金额', true);
    if (targetYuan % unitFor(businessType)) throw new Error('固定交易金额不符合交易单位');
    const issuerId = security.issuerBankId ?? null;
    if (['deposit', 'cd_buy', 'cd_sell'].includes(businessType) &&
      (!validId(issuerId) || !state.initialData.banks.some(bank => bank.bankId === issuerId)))
      throw new Error('固定交易发行行未知');
    const businessDate = state.context.businessDate;
    return { label: `AI拟单${businessType}`, businessType, direction: BUSINESS_TYPES[businessType].direction,
      counterpartyId: null, issuerId, targetYuan, termsNote: 'AI拟单草案；须经理确认并重审',
      repoTerms: null, tradeDate: businessDate, settlementDate: businessDate, securityId,
      marketTier: businessType === 'cd_buy' ? 'secondary' : null };
  });
  exact(projected.financing, ['planId', 'maxAmountYuan', 'tenorDays', 'unitYuan'], '融资意图');
  exact(projected.reverseRepo, ['planId', 'amountYuan', 'tenorDays', 'unitYuan'], '逆回购意图');
  const financingId = planId(projected.financing.planId, 'interbank_repo_financing', state, '融资');
  const reverseId = planId(projected.reverseRepo.planId, 'reverse_repo', state, '逆回购');
  for (const [spec, type, label] of [[projected.financing, 'interbank_repo_financing', '融资'],
    [projected.reverseRepo, 'reverse_repo', '逆回购']]) {
    if (!Number.isSafeInteger(spec.tenorDays) || spec.tenorDays < 1 || spec.tenorDays > 3660)
      throw new Error(`${label}期限无效`);
    money(spec.unitYuan, `${label}交易单位`, true);
    if (spec.unitYuan % unitFor(type)) throw new Error(`${label}交易单位无效`);
  }
  const financing = { ...(financingId ? { planId: financingId } : {}),
    // The server projects an omitted intent cap as null; preserve automatic local solving.
    ...(projected.financing.maxAmountYuan === null ? {} : {
      maxAmountYuan: money(projected.financing.maxAmountYuan, '融资上限') }),
    tenorDays: projected.financing.tenorDays, unitYuan: projected.financing.unitYuan };
  const reverseRepo = { ...(reverseId ? { planId: reverseId } : {}),
    amountYuan: projected.reverseRepo.amountYuan === null ? null : money(projected.reverseRepo.amountYuan, '逆回购金额'),
    tenorDays: projected.reverseRepo.tenorDays, unitYuan: projected.reverseRepo.unitYuan };
  return { requestId, fixedPlans, financing, reverseRepo,
    allowReduceReverseRepo: projected.allowReduceReverseRepo };
}

function discrepancies(server, local) {
  const found = [];
  if (server.status !== local.status) found.push('总体状态');
  for (const [role, label] of [['main', '主方案'], ['alternative', '备选方案']]) {
    const from = server[role], now = local[role];
    if (Boolean(from) !== Boolean(now)) { found.push(`${label}存在性`); continue; }
    if (!from) continue;
    for (const [field, title] of [['applicable', '可应用状态'], ['status', '状态'],
      ['financingYuan', '融资金额'], ['reverseRepoYuan', '逆回购金额'],
      ['projectedFinalCashYuan', '预计现金'], ['requiresTargetChange', '目标调整']]) {
      if (from[field] !== now[field]) found.push(`${label}${title}`);
    }
  }
  return found;
}

function publicResult(value) {
  const result = copy(value);
  for (const role of ['main', 'alternative']) {
    if (result[role]) delete result[role].appliedSaved;
  }
  return result;
}

export function createAiDraft({ model } = {}) {
  if (!model || typeof model.serialize !== 'function' || typeof model.getState !== 'function')
    throw new Error('需要当前工作区计算模型');
  let prepared = null, state = { result: null, error: '', appliedRole: null };
  const snapshot = () => copy(state);
  const invalidate = () => { prepared = null; state = { result: null, error: '', appliedRole: null }; return snapshot(); };

  function prepare(dialogue, { requestId, documentRevision } = {}) {
    invalidate();
    try {
      if (!validId(requestId)) throw new Error('请求ID无效');
      const local = readPlanningSnapshot(model);
      if (!object(dialogue) || !Array.isArray(dialogue.references) || !Array.isArray(dialogue.evidence))
        throw new Error('对话证据格式无效');
      checkBasis(dialogue.basis, local.versions, documentRevision);
      if (['clarification', 'unsupported'].includes(dialogue.status)) return snapshot();
      if (dialogue.status !== 'answer') throw new Error('对话状态无效');
      if (dialogue.references.length !== dialogue.evidence.length ||
        new Set(dialogue.references).size !== dialogue.references.length ||
        dialogue.evidence.some((item, index) => !validId(dialogue.references[index]) ||
          item?.callId !== dialogue.references[index] || typeof item.name !== 'string'))
        throw new Error('对话引用与工具证据不匹配');
      const plans = dialogue.evidence.filter(item => item.name === 'plan_trades' &&
        item.result?.status !== 'invalid_intent' && object(item.result?.intent));
      if (!plans.length) return snapshot();
      const server = plans.at(-1).result;
      const intent = reconstructIntent(server.intent, local, requestId);
      const result = preparePlanningDraft(model, intent);
      if (result.status === 'invalid_intent') throw new Error(result.errors.join('；') || '本地意图无效');
      const differences = discrepancies(server, result);
      state.result = { ...publicResult(result), intent, serverMismatch: differences.length > 0,
        serverDiscrepancies: differences, evidenceCallId: plans.at(-1).callId };
      prepared = { token: local.token, mainDraftId: result.main?.draftId ?? null,
        alternativeDraftId: result.alternative?.draftId ?? null };
    } catch (error) { state.error = error?.message || '本地拟单失败'; }
    return snapshot();
  }

  function confirm(role, { acceptTargetChanges = false } = {}) {
    state.error = '';
    try {
      if (!['main', 'alternative'].includes(role) || !prepared || !state.result)
        throw new Error('没有可确认的本地草案，请重新测算');
      if (state.appliedRole) throw new Error('草案已应用，请重新测算');
      if (state.result.serverMismatch) throw new Error('服务端摘要与本地结果不一致，请重新请求并核对差异');
      if (readPlanningSnapshot(model).token !== prepared.token)
        throw new Error('本地运行已变化，请重新测算');
      const draftId = role === 'main' ? prepared.mainDraftId : prepared.alternativeDraftId;
      if (!draftId) throw new Error('所选方案不可应用');
      const applied = applyConfirmedDraft(model, { draftId, confirmed: true, acceptTargetChanges });
      if (applied.status !== 'applied') throw new Error('草案已应用，请重新测算');
      state.appliedRole = role;
    } catch (error) { state.error = error?.message || '应用草案失败'; }
    return snapshot();
  }

  return { prepare, confirm, invalidate, snapshot };
}

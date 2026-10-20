// Local deterministic planning facade. No model/API credentials or dispatch tools.
import { createModel } from './model.js';
import { BUSINESS_TYPES, unitFor } from './business.js';
import { SINGLE_DAY_DEMO_MODE } from './initial-data.js';
import { solveFundingAndReverseRepo as solve, simulateDraft as simulate } from './planning-solver.js';

export const PLANNING_VERSION = 'planning-tools-1';
export const KNOWLEDGE_VERSION = 'ai-knowledge-0.3';
const copy = value => structuredClone(value);
const canonical = value => JSON.stringify(value, function(key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item;
});
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
const snapshots = new WeakSet();
const drafts = new WeakMap();
const comparable = new WeakMap();
let nextDraft = 1;
const money = (n, label, positive = false) => {
  if (!Number.isSafeInteger(n) || n < (positive ? 1 : 0)) throw new Error(`${label}须为安全整数元`);
};
const keys = (o, allowed, label) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${label}须为对象`);
  if (Object.keys(o).some(k => !allowed.includes(k))) throw new Error(`${label}含未知字段`);
};

export function solveFundingAndReverseRepo(snapshot, intent, options = {}) {
  const checked = validateIntent(snapshot,intent);
  if (!checked.ok) return {status:'invalid_intent',errors:checked.errors,main:null,alternative:null};
  return solve(snapshot,checked.intent,options);
}
export function simulateDraft(snapshot,deltas,options = {}) {
  if (!snapshots.has(snapshot)) throw new Error('须使用本地读取的可信快照');
  return simulate(snapshot,deltas,options);
}

// token is an exact local comparison value, not an authentication token or API payload.
export function readPlanningSnapshot(model) {
  const saved = JSON.parse(model.serialize());
  const state = model.getState();
  if (saved.initialData.demoMode !== SINGLE_DAY_DEMO_MODE || saved.progressId !== 'initial')
    throw new Error('拟单工具仅支持当前单日运行');
  const snapshot = freeze({ saved, state, token: canonical(saved), versions: {
    tool: PLANNING_VERSION, knowledge: KNOWLEDGE_VERSION, runId: saved.context.runId,
    revision: saved.revision, rules: saved.rulesVersion, ruleConfig: saved.ruleConfig.version,
    preferences: saved.preferences.version, resources: saved.repoResourcesVersion,
    snapshot: saved.execution.snapshot.version,
  }});
  snapshots.add(snapshot);
  return snapshot;
}

export function validateIntent(snapshot, input) {
  const errors = [];
  let intent;
  try {
    if (!snapshots.has(snapshot)) throw new Error('须使用本地读取的可信快照');
    keys(input, ['requestId','fixedPlans','financing','reverseRepo','allowReduceReverseRepo'], '意图');
    if (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 128)
      throw new Error('requestId无效');
    if (!Array.isArray(input.fixedPlans) || input.fixedPlans.length > 64) throw new Error('固定计划集合无效');
    if (input.allowReduceReverseRepo !== undefined && typeof input.allowReduceReverseRepo !== 'boolean')
      throw new Error('备选方案开关须为布尔值');
    intent = copy(input);
    const isolated = createModel(snapshot.saved);
    for (const plan of intent.fixedPlans) {
      keys(plan, ['label','businessType','direction','counterpartyId','issuerId','targetYuan','termsNote',
        'repoTerms','tradeDate','settlementDate','securityId','marketTier'], '固定交易');
      if (!BUSINESS_TYPES[plan.businessType]) throw new Error('未知业务类型');
      money(plan.targetYuan, '固定金额', true);
      if (plan.targetYuan % unitFor(plan.businessType)) throw new Error('固定金额不符合交易单位');
      if (['reverse_repo','interbank_repo_financing','exchange_repo_financing','exchange_repo_lending'].includes(plan.businessType))
        throw new Error('新增融资/逆回购请使用专用需求字段');
      if (!plan.securityId || !snapshot.state.initialData.securities.some(s => s.securityId === plan.securityId))
        throw new Error('固定交易须指定已知证券/存款资产及期限');
      isolated.addPlan(plan);
    }
    for (const [name, type] of [['financing','interbank_repo_financing'],['reverseRepo','reverse_repo']]) {
      const spec = intent[name];
      keys(spec, name === 'financing' ? ['planId','tenorDays','maxAmountYuan','unitYuan'] :
        ['planId','amountYuan','tenorDays','unitYuan'], name);
      const existing = spec.planId ? snapshot.state.plans.find(p => p.planId === spec.planId) : null;
      if (spec.planId !== undefined && (!existing || existing.businessType !== type))
        throw new Error(`${name}计划ID或业务类型不匹配`);
      spec.tenorDays ??= existing?.repoTerms?.tenorDays ?? (name === 'financing' ? 1 : 7);
      if (!Number.isSafeInteger(spec.tenorDays) || spec.tenorDays < 1) throw new Error(`${name}期限缺失或无效`);
      if (existing && existing.repoTerms?.tenorDays !== spec.tenorDays) throw new Error('已有回购期限不允许由金额测算隐式修改');
      spec.unitYuan ??= unitFor(type);
      money(spec.unitYuan, '交易单位', true);
      if (spec.unitYuan % unitFor(type)) throw new Error('求解网格须为业务单位的整数倍');
      if (name === 'financing') {
        if (spec.maxAmountYuan != null) {
          money(spec.maxAmountYuan, '本次融资意向上限');
          if (spec.maxAmountYuan % spec.unitYuan) throw new Error('本次融资意向上限不符合求解单位');
        } else delete spec.maxAmountYuan;
      } else {
        if (spec.amountYuan === undefined && existing) spec.amountYuan = existing.targetYuan;
        if (spec.amountYuan === undefined) spec.amountYuan = null;
        if (existing && spec.amountYuan === null) spec.amountYuan = existing.targetYuan;
        if (spec.amountYuan !== null) {
          money(spec.amountYuan, '逆回购金额');
          if (spec.amountYuan % spec.unitYuan) throw new Error('逆回购金额不符合求解单位');
          const b = snapshot.state.summary.planBalances.find(x => x.planId === spec.planId);
          if (b && spec.amountYuan < b.filledYuan + b.lockedYuan) throw new Error('逆回购意向金额低于成交与在途占用');
        }
      }
    }
  } catch (error) { errors.push(error.message); }
  return { ok: errors.length === 0, errors, intent: errors.length ? null : intent };
}

export function preparePlanningDraft(model, input, options = {}) {
  const previous = drafts.get(model);
  if (previous) for (const [id,entry] of previous) if (!entry.applied) previous.delete(id);
  const snapshot = readPlanningSnapshot(model);
  const checked = validateIntent(snapshot, input);
  if (!checked.ok) return { status: 'invalid_intent', errors: checked.errors };
  const result = solveFundingAndReverseRepo(snapshot, checked.intent, options);
  let registry = drafts.get(model);
  if (!registry) { registry = new Map(); drafts.set(model, registry); }
  // Bound session memory; stale drafts are safe to recompute, never silently reused.
  while (registry.size > 30) registry.delete(registry.keys().next().value);
  const output = copy(result);
  for (const role of ['main','alternative']) {
    const candidate = output[role];
    if (!candidate?.applicable) continue;
    const draftId = `${snapshot.versions.runId}-DRAFT-${nextDraft++}`;
    candidate.draftId = draftId;
    candidate.versions = copy(snapshot.versions);
    registry.set(draftId, { snapshot, candidate: copy(candidate), options: copy(options),
      role, intent: checked.intent, applied: false });
    comparable.set(candidate,{signature:canonical(candidate),scope:snapshot.token+canonical(checked.intent)});
  }
  return output;
}

export function applyConfirmedDraft(model, { draftId, confirmed = false, acceptTargetChanges = false } = {}) {
  const entry = drafts.get(model)?.get(draftId);
  if (!entry) throw new Error('草案不存在或会话已恢复，请重新测算');
  if (confirmed !== true) throw new Error('须明确确认草案');
  if (entry.applied) return { status: 'already_applied', draftId };
  if ((entry.role === 'alternative' || entry.candidate.requiresTargetChange) && acceptTargetChanges !== true)
    throw new Error('备选方案改变逆回购意向金额，须明确接受');
  if (canonical(JSON.parse(model.serialize())) !== entry.snapshot.token) throw new Error('草案已过期，请重新测算');
  const checked = simulateDraft(entry.snapshot, entry.candidate.deltas, entry.options);
  if (!checked.applicable) throw new Error('最新草案复核未通过');
  if (!checked.appliedSaved) throw new Error('缺少经过校验的计划差量副本');
  if (canonical(checked.deltas) !== canonical(entry.candidate.deltas) ||
      canonical(checked.finalRules) !== canonical(entry.candidate.finalRules) ||
      checked.projectedFinalCashYuan !== entry.candidate.projectedFinalCashYuan)
    throw new Error('复核结果与已确认草案不一致，请重新测算');
  // Single validated replacement: a failed draft cannot leave half of its edits live.
  model.load(checked.appliedSaved);
  entry.applied = true;
  return { status: 'applied', draftId, state: model.getState(), requiresReview: true };
}

export function compareDrafts(candidates) {
  // Compare only untouched local candidates for the same snapshot and request.
  let scope;
  for (const candidate of candidates) {
    const proof = comparable.get(candidate);
    if (!proof || proof.signature !== canonical(candidate) || (scope && scope !== proof.scope))
      throw new Error('只能比较同快照同需求下未改写的本地候选');
    scope = proof.scope;
  }
  return candidates.filter(c => c?.applicable).map(copy).sort((a,b) =>
    Number(Boolean(a.requiresTargetChange)) - Number(Boolean(b.requiresTargetChange)) ||
    (a.financingYuan ?? 0) - (b.financingYuan ?? 0) ||
    (b.reverseRepoYuan ?? 0) - (a.reverseRepoYuan ?? 0));
}

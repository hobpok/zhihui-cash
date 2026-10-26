import { readPlanningSnapshot, preparePlanningDraft, applyConfirmedDraft } from './planning.js';
import { findRemediation } from './remediation.js';
import { displayLabel } from './display-labels.js';

const money = value => Number.isSafeInteger(value) ? `${value / 100000000}亿元` : '待核实';
const element = (tag, text) => { const el = document.createElement(tag); if (text) el.textContent = text; return el; };

export function existingPlanIntent(state, requestId = 'local-remediation') {
  const select = type => {
    const matches = state.plans.filter(plan => plan.businessType === type &&
      state.summary.planBalances.some(b => b.planId === plan.planId && b.remainingYuan > 0));
    if (matches.length > 1) throw new Error('存在多笔融资或逆回购，请先明确需保留的规划对象。');
    return matches[0];
  };
  const financing = select('interbank_repo_financing'), reverse = select('reverse_repo');
  return { requestId, fixedPlans: [], allowReduceReverseRepo: false,
    financing: financing ? { planId: financing.planId, tenorDays: financing.repoTerms.tenorDays } : { tenorDays: 1 },
    reverseRepo: reverse ? { planId: reverse.planId, tenorDays: reverse.repoTerms.tenorDays, amountYuan: reverse.targetYuan }
      : { tenorDays: 7, amountYuan: 0 } };
}

export function setupRemediationUI({ model, root, changed }) {
  let generation = 0;
  const reset = () => { generation++; root.replaceChildren(); root.hidden = true; };
  const note = text => root.append(element('p', text));
  async function inspect() {
    reset();
    const state = model.getState();
    if (state.initialData?.demoMode !== 'single-day-principal-v1' ||
        !state.plans.some(p => p.businessType === 'deposit' && state.proposal?.planCoverage?.some(b =>
          b.planId === p.planId && b.unarrangedYuan > 0))) return;
    const current = generation, token = model.serialize();
    root.hidden = false;
    note('正在核算补救路径，原计划保持不变……');
    await new Promise(resolve => setTimeout(resolve, 30));
    if (current !== generation || model.serialize() !== token) return;
    try {
      const snapshot = readPlanningSnapshot(model);
      const found = findRemediation(snapshot, existingPlanIntent(snapshot.state));
      if (current !== generation || model.serialize() !== token) { reset(); return; }
      root.replaceChildren();
      if (found.status === 'not_needed') { root.hidden = true; return; }
      root.append(element('h3', found.status === 'candidate' ? '发现可核算的卖券补救方案' : '补救路径核算结果'));
      for (const reason of found.reasons ?? []) note(reason.message ?? reason);
      if (found.status !== 'candidate') {
        note('本轮仅搜索同银行可卖存单及银行债；未找到完整候选不代表所有方案无解。原计划保留。');
        return;
      }
      const list = element('ul');
      for (const action of found.actions) {
        const security = state.initialData.securities.find(s => s.securityId === action.securityId);
        list.append(element('li', `建议新增卖出 ${displayLabel(security?.label ?? action.securityId)} ${money(action.targetYuan)}。${action.reason ?? ''}`));
      }
      root.append(list);
      const candidate = found.result.main;
      note(`全部原目标保留。融资意向 ${money(candidate.financingYuan)}，逆回购意向 ${money(candidate.reverseRepoYuan)}。`);
      note('卖券须实际成交后才释放额度；实际付款仍须账户资金足够。以下为核验后的条件路径，不代表已经成交或到账。');
      const details = element('details'); details.append(element('summary', '查看执行路径与条件'));
      const path = element('ol');
      const planMap = new Map([...(candidate.appliedSaved?.plans ?? state.plans)].map(p => [p.planId, p]));
      for (const step of candidate.executionPath ?? []) {
        const plan = planMap.get(step.planId);
        path.append(element('li', `${displayLabel(plan?.label ?? step.planId)} · ${money(step.nominalYuan ?? step.amountYuan)}${step.condition ? `；${step.condition}` : ''}`));
      }
      details.append(path); root.append(details);
      const label = element('label'); label.className = 'checkline';
      const consent = element('input'); consent.type = 'checkbox'; consent.id = 'remediation-consent';
      label.append(consent, document.createTextNode('我同意新增上述卖券，并按所列金额更新融资计划；保留全部原投资目标。'));
      root.append(label);
      const button = element('button', '确认补救方案加入计划'); button.className = 'primary'; button.id = 'remediation-apply';
      button.disabled = true; consent.addEventListener('change', () => { button.disabled = !consent.checked; });
      const feedback = element('p'); feedback.setAttribute('role', 'status');
      button.addEventListener('click', () => {
        button.disabled = true;
        try {
          if (!consent.checked || model.serialize() !== token) throw new Error('运行已变化或尚未确认，请重新计算补救方案。');
          const prepared = preparePlanningDraft(model, found.intent);
          if (!prepared.main?.applicable || !prepared.main.draftId) throw new Error('最新补救复核未通过，请重新计算。');
          applyConfirmedDraft(model, { draftId: prepared.main.draftId, confirmed: true });
          changed('补救方案已加入计划；请重新计算、核对并手动下达。卖券尚未成交。');
        } catch (error) { feedback.textContent = error.message; }
      });
      root.append(button, feedback);
    } catch (error) {
      if (current !== generation) return;
      root.replaceChildren(); note(`暂无法核算补救方案：${error.message}`);
    }
  }
  return { inspect, reset };
}

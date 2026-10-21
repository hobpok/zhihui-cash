import {displayLabel} from './display-labels.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount = value => {
  if (!Number.isSafeInteger(value) || value < 0) return '待核实';
  const n = BigInt(value), fraction = (n % 100000000n).toString().padStart(8,'0').replace(/0+$/,'');
  return `${n / 100000000n}${fraction ? `.${fraction}` : ''}亿`;
};
const name = (state, planId) => displayLabel(state.plans?.find(p => p.planId === planId)?.label) || '关联计划';
const wholeDeposit = (state, planId) => state.plans?.find(p => p.planId === planId)?.businessType === 'deposit' ? '（存款须整笔成交）' : '';

// The dependency provider is shared with the execution gate. The view does not
// infer an ordering from a bank name, table position, or an accepted receipt.
export function executionOrderHintRows(state, instructionId, dependenciesByInstruction = {}) {
  const instruction = state.execution?.instructions?.[instructionId];
  if (!instruction || instruction.status === 'rejected') return [];
  const rows = [];
  for (const dependency of dependenciesByInstruction[instructionId] || []) {
    const actual = dependency.actualYuan;
    const minimum = dependency.minimumYuan;
    const known = Number.isSafeInteger(actual) && actual >= 0 && Number.isSafeInteger(minimum) && minimum >= 0;
    const ready = known && actual >= minimum;
    const cash = dependency.basis === 'cash_available';
    const prerequisite = cash ? '累计到账可用' : '累计成交';
    const actualLabel = cash ? '前置已到账可用' : '前置已成交';
    rows.push({kind:'prerequisite',ready,
      text:`成交顺序：先${name(state,dependency.planId)}${prerequisite}至少${amount(minimum)}${cash ? '' : wholeDeposit(state,dependency.planId)}，再成交本笔；${actualLabel}${amount(actual)} / 至少${amount(minimum)}${known ? ready ? '，前置已完成' : `，尚差${amount(minimum-actual)}` : '，前置状态待核实'}。`});
  }
  for (const [dependentId, dependencies] of Object.entries(dependenciesByInstruction)) {
    if (dependentId === instructionId) continue;
    const dependent = state.execution?.instructions?.[dependentId];
    if (!dependent || dependent.status === 'rejected' || dependent.nominalYuan <= dependent.filledYuan + (dependent.cancelledYuan || 0)) continue;
    for (const dependency of dependencies || []) if (dependency.planId === instruction.planId) {
      const cash = dependency.basis === 'cash_available';
      rows.push({kind:'successor',ready:false,
        text:`先完成本计划${cash ? '累计到账可用' : '累计成交'}至少${amount(dependency.minimumYuan)}${cash ? '' : wholeDeposit(state,instruction.planId)}，再成交${name(state,dependent.planId)}。`});
    }
  }
  return rows;
}

export function renderExecutionOrderHints(state, instructionId, dependenciesByInstruction = {}) {
  const rows = executionOrderHintRows(state,instructionId,dependenciesByInstruction);
  if (!rows.length) return '';
  return `<div class="execution-order-hint">${rows.map(row => `<small class="${row.kind === 'prerequisite' && !row.ready ? 'warning' : 'muted'}">${escape(row.text)}</small>`).join('')}<small class="muted">下达／投管接收不计成交；成交仍须按最新事实与规则校验。</small></div>`;
}

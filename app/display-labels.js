// Presentation aliases only. Stored labels, IDs and provenance remain unchanged.
import {createSyntheticInitialTemplate, createLegacySyntheticInitialTemplate} from './initial-data.js';
import {createDefaultInitialTemplate} from './default-scenario.js';
import {BUSINESS_TYPES} from './business.js';

// Names describe the entered target; naming never changes trading fields.
export function automaticInstructionLabel(plan, initialData) {
  const securities=initialData?.securities||[],banks=initialData?.banks||[];
  const security=securities.find(x=>x.securityId===plan.securityId);
  const bank=banks.find(x=>x.bankId===(plan.issuerId||plan.counterpartyId));
  const subject=displayLabel(security?.label||bank?.label||plan.securityId||plan.issuerId||plan.counterpartyId||'');
  const yuan=BigInt(plan.targetYuan);
  const scale=yuan>=100000000n?100000000n:yuan>=10000n?10000n:1n;
  const fraction=(yuan%scale).toString().padStart(scale.toString().length-1,'0').replace(/0+$/,'');
  const money=`${yuan/scale}${fraction?'.'+fraction:''}${scale===100000000n?'亿':scale===10000n?'万':'元'}`;
  const tenor=plan.repoTerms?.tenorDays??security?.remainingTradingDays;
  const parts=[BUSINESS_TYPES[plan.businessType]?.label||'交易',money,tenor!=null?`${tenor}天`:''];
  const suffix=parts.filter(Boolean).join(' · ');
  return subject?`${subject.slice(0,Math.max(0,77-suffix.length))} · ${suffix}`:suffix;
}

const aliases = new Map([
  ['C迭代合成默认模板', '默认模板'],
  ['单日同额合成默认模板', '单日基础模板'],
  ['收益导向复杂单日模拟样例', '收益与约束联动方案'],
  ['买入模拟非银行短融1亿60天', '买入非银行短融1亿60天'],
  ['买入模拟非银行短融1亿90天', '买入非银行短融1亿90天'],
]);
function collect(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.label === 'string' && /^(合成|模拟)/.test(value.label))
    aliases.set(value.label, value.label.slice(2).replace('（非单一真实发行人）', '（组合资产）'));
  for (const child of Object.values(value)) collect(child);
}
collect(createSyntheticInitialTemplate());
collect(createLegacySyntheticInitialTemplate());
collect(createDefaultInitialTemplate());

// Match complete built-in names, so unrelated custom names keep their wording.
export const displayLabel = value => aliases.get(value) ?? value;

// Editing another field must not silently rewrite a stored name to its alias.
export const preserveLabel = (submitted, original) =>
  original != null && submitted === displayLabel(original) ? original : submitted;

const noteAliases = new Map([["模拟计划；金额、代码、期限及行情均非真实交易数据", "按当前计划金额、期限和交收参数执行"], ["合成演示计划", "按当前计划参数执行"]]);
export const displayTermsNote = note => noteAliases.get(note) ?? note;
export const preserveTermsNote = (submitted, original) => original != null && submitted === displayTermsNote(original) ? original : submitted;

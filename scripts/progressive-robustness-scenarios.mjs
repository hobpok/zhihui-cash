// Progressive-improvement fixtures; never change the 6-0.9.2 evidence.
import { createScenarios, baseTemplate, plan, YI } from './robustness-scenarios.mjs';
import { normalizeInitialTemplate } from '../app/initial-data.js';

const q = n => Math.round(n * YI);
export { YI };

export function createProgressiveScenarios() {
  const original = createScenarios();
  for (const row of original) {
    row.expected = structuredClone(row.expected);
    if (row.id === 'R05') delete row.expected.first;
    if (row.id === 'R06') Object.assign(row.expected, {
      complete: false, account: q(2), business: q(2), filledByLabel: {'买短债7亿': q(1)},
      remainingByLabel: {'买短债7亿': q(6)}, cashRatio: 0.05,
    });
    if (row.id === 'R07') Object.assign(row.expected, {
      complete: false, account: q(8), business: q(8),
      filledByLabel: {'买B存单2亿': q(1), '买短债1亿': q(1)},
      remainingByLabel: {'买B存单2亿': q(1), '买短债1亿': 0},
      bankRule: {ruleId:'C03', subjectId:'BANK-B', value:0.05},
    });
    if (row.id === 'R08') Object.assign(row.expected, {
      complete: false, account: q(13), business: q(13),
      blockedLabel: '买短债1亿',
      filledByLabel: {'卖长债3亿': q(3), '买短债1亿': 0},
      remainingByLabel: {'卖长债3亿': 0, '买短债1亿': q(1)},
      termNumerator: q(9260), termDenominator: q(100),
      persistentRules: ['C09'],
    });
    if (row.id === 'R14') Object.assign(row.expected, {
      complete: true, account: q(11), business: q(11),
      termNumerator: q(8900), termDenominator: q(100),
      filledByLabel: {'卖长债甲3亿': q(3), '卖长债乙3亿': q(3)},
    });
    if (row.id === 'R15') Object.assign(row.expected, {
      complete: true, account: q(11), business: q(11),
      bankRule: {ruleId:'C03', subjectId:'BANK-B', value:0.05},
      filledByLabel: {'卖B存单甲0.5亿': q(0.5), '卖B存单乙0.5亿': q(0.5)},
    });
    // Old explanatory notes described the prior strict gate.
    delete row.expected.note;
  }
  const source = original.find(row => row.id === 'R08').template;
  const add = (id, label, draftPlans, expected) => {
    const t = structuredClone(source);
    t.templateId = id; t.label = label; t.portfolio.portfolioId = id;
    t.draftPlans = draftPlans;
    original.push({id,label,template:normalizeInitialTemplate(t),expected});
  };
  add('P01','期限98天仅卖长债3亿，交易完成但C09仍超限',
    [plan('卖长债3亿','bond_sell',3,'LONG')],
    {complete:true,account:q(13),business:q(13),termNumerator:q(9260),
      termDenominator:q(100),initialRules:['C09'],persistentRules:['C09'],
      filledByLabel:{'卖长债3亿':q(3)}});
  add('P02','期限98天正回购融资10亿后达标',
    [plan('融资10亿','interbank_repo_financing',10)],
    {complete:true,account:q(20),business:q(20),termNumerator:q(9800),
      termDenominator:q(110),initialRules:['C09'],
      filledByLabel:{'融资10亿':q(10)}});
  add('P03','期限98天正回购融资3亿后仍超限但完成',
    [plan('融资3亿','interbank_repo_financing',3)],
    {complete:true,account:q(13),business:q(13),termNumerator:q(9800),
      termDenominator:q(103),initialRules:['C09'],persistentRules:['C09'],
      filledByLabel:{'融资3亿':q(3)}});
  return original;
}

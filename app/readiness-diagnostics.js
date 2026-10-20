// Presentation only. All readiness decisions remain in model.js and use integer yuan.
export function yi(value) {
  if (typeof value !== 'bigint' && !Number.isSafeInteger(value)) return '未知';
  const n = BigInt(value), abs = n < 0n ? -n : n;
  const fraction = (abs % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${abs / 100000000n}${fraction ? `.${fraction}` : ''}亿`;
}

export function amountDetail(minimumYuan, actualYuan) {
  if (typeof minimumYuan !== 'bigint' && !Number.isSafeInteger(minimumYuan)) return '最低金额未知';
  if (!Number.isSafeInteger(actualYuan)) return `最低${yi(minimumYuan)}，当前未知，缺口待核实`;
  const shortfall = BigInt(minimumYuan) - BigInt(actualYuan);
  return `最低${yi(minimumYuan)}，当前${yi(actualYuan)}，尚差${shortfall > 0n ? yi(shortfall) : '0亿'}`;
}

export function ratioLimitYuan(baseYuan, decimal) {
  if (!Number.isSafeInteger(baseYuan) || typeof decimal !== 'string' || !/^(?:0\.[0-9]{1,12}|1(?:\.0{1,12})?)$/.test(decimal)) return null;
  const [whole, fraction = ''] = decimal.split('.');
  const scale = 10n ** BigInt(fraction.length);
  return BigInt(baseYuan) * (BigInt(whole) * scale + BigInt(fraction)) / scale;
}

export function coreRuleDetail(rule) {
  const subject = rule.subjectLabel ?? rule.subjectId;
  const parts = [`${rule.name ?? rule.ruleId ?? '核心规则'}${subject ? `（${subject}）` : ''}：${rule.reason ?? '校验未通过'}`];
  if (rule.result === 'missing' && rule.needed?.length) parts.push(`缺少${rule.needed.join('、')}`);
  if (rule.result === 'block' && rule.headroomYuan !== null && rule.headroomYuan !== undefined) {
    const raw = rule.headroomYuan;
    if ((typeof raw === 'string' && /^-?\d+$/.test(raw)) || Number.isSafeInteger(raw)) {
      const headroom = BigInt(raw);
      if (headroom < 0n) parts.push(`超出${yi(-headroom)}`);
    } else parts.push('金额缺口待核实');
  }
  return parts.join('；');
}

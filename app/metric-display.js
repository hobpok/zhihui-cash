// Presentation only. Threshold decisions in the trading engine remain independent.
import {deriveTemplateExposure} from './initial-data.js';

// Opening portfolio composition: intraday cash flows never change this metric.
export function governmentBondMaturityRatio(state) {
  const template = state?.initialData;
  const denominatorYuan = template?.portfolio?.navYuan ?? null;
  if (!Number.isSafeInteger(denominatorYuan) || denominatorYuan <= 0)
    return {numeratorYuan:null, denominatorYuan, value:null};
  const numeratorYuan = deriveTemplateExposure(template).governmentBondWithinYearYuan;
  const value = Number.isSafeInteger(numeratorYuan) && numeratorYuan >= 0 &&
    Number.isSafeInteger(denominatorYuan) && denominatorYuan > 0 ? numeratorYuan / denominatorYuan : null;
  return {numeratorYuan, denominatorYuan, value};
}

const integer = n => typeof n === 'number' && Number.isSafeInteger(n) || typeof n === 'string' && /^-?\d+$/.test(n);
export function metricPresentation(row) {
  // Deposit gates describe permission for a new trade, not a stock violation.
  if (row?.ruleId==='C05-DEPOSIT' && row.result==='not_applicable')
    return {tone:row.headroomYuan==null?'missing':Number(row.headroomYuan)<=0?'near':'normal',limitYuan:null};
  if (!row || row.result === 'not_applicable' || row.currentValue == null) return {tone:'missing',limitYuan:null};
  const t=row.threshold;
  if (integer(row.numeratorYuan) && integer(row.denominatorYuan) && t?.numerator!=null && t?.denominator>0) {
    const n=BigInt(row.numeratorYuan),d=BigInt(row.denominatorYuan),a=BigInt(t.numerator),b=BigInt(t.denominator);
    if(d<=0n)return {tone:'missing',limitYuan:null};
    const gap=t.operator==='≥'?n*b-d*a:d*a-n*b;
    return {tone:gap<0n?'over':gap*100n<=d*b?'near':'normal',limitYuan:(d*a/b).toString()};
  }
  const n=Number(row.currentValue),limit=t?.valueDays??t?.valueTradingDays??t?.valueYuan;
  if(!Number.isFinite(n)||limit==null)return {tone:'missing',limitYuan:null};
  return {tone:(t.operator==='≥'?n<limit:n>limit)?'over':'normal',limitYuan:null};
}
export function completionPercent(filledYuan,targetYuan) {
  if(!Number.isSafeInteger(filledYuan)||!Number.isSafeInteger(targetYuan)||targetYuan<=0)return null;
  return Math.min(100,Math.max(0,filledYuan/targetYuan*100));
}

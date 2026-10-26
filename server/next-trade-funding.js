// Read-only counterfactual for one existing target. All execution below is on a
// disposable model; no simulated receipt, identifier or journal is returned.
import { createModel, actualFilledRuleState, executionFillReadiness } from '../app/model.js';
import { evaluateCoreRules } from '../app/core-rules.js';
import { unitFor, isFinancing } from '../app/business.js';

const money = x => Number.isSafeInteger(x) ? x : null;
const c02 = checked => checked.rows.find(x => x.ruleId === 'C02' && x.subjectId === 'PORTFOLIO');
const safeRule = row => ({ ruleId:row.ruleId, subjectId:row.subjectId, result:row.result,
  numeratorYuan:money(row.numeratorYuan), denominatorYuan:money(row.denominatorYuan),
  projectedValue:Number.isFinite(row.projectedValue) ? row.projectedValue : null,
  headroomYuan:money(row.headroomYuan), reason:String(row.reason ?? '').slice(0,400),
  needed:(row.needed ?? []).slice(0,8) });
const blocks = checked => [...checked.missing,...checked.blocking].map(row =>
  ({ kind:'core_rule',...safeRule(row) }));

export function assessNextTradeFunding(saved, state, planId, currentCashRequirement) {
  const plan = state.plans.find(x => x.planId === planId);
  if (!plan) throw new Error('下一笔须引用当前已存在的精确计划ID');
  const balance = state.summary.planBalances.find(x => x.planId === planId);
  const result = { status:'insufficient_data',scope:'next_existing_trade',
    target:{planId,label:plan.label,businessType:plan.businessType,targetYuan:plan.targetYuan,
      filledYuan:balance?.filledYuan ?? null,lockedYuan:balance?.lockedYuan ?? null,
      nominalYuan:balance?.arrangeableYuan ?? null},
    currentCashRequirement,
    nextTradeRequirement:{mathematicalAdditionalFinancingYuan:null,additionalFinancingFillYuan:null,
      currentNumeratorYuan:currentCashRequirement.currentNumeratorYuan,
      targetOutflowYuan:null,requiredNumeratorYuan:currentCashRequirement.requiredNumeratorYuan,
      projectedC02Ratio:null},
    financing:{existingUnfilledYuan:currentCashRequirement.financingUnfilledYuan,
      availableCapacityYuan:null,verifiedFillYuan:null,unitYuan:null,allocations:[],basis:'existing_nominal_targets_not_external_guarantee'},
    payment:{accountCashYuan:money(state.summary.accountCashYuan),paymentYuan:null,
      reservedYuan:null,availableForPaymentYuan:null,shortfallYuan:null},
    currentTargetRules:[],projectedTargetRules:[],remainingBlockers:[],needed:[],
    canDispatchNow:false,executionAuthority:'requires_refresh_recalculate_review_and_manual_dispatch',
    constraints:[
      '仅测算所选现有目标的下一笔，不完成其他计划，不修改任何目标或真实执行记录。',
      '融资金额表示尚需新增成交，非待到账金额；已成交待到账融资、卖券不重复计入。',
      '比例通过不等于可下达；实际账户付款、其余规则、刷新、重算和审核须分别满足。',
      '仅验证单个现有未完成融资目标的业务单位和有限执行路径；不新增融资目标，不承诺外部成交。',
      '单日演示模式按现行规则不以质押券资源或交易所窗口作为闸门，不能据此认定真实市场融资可执行。',
    ] };
  const stop = (status,reason,kind='assessment') => {
    result.status=status; result.reason=reason;
    result.remainingBlockers.push({kind,reason}); return result;
  };
  if (!balance || !['filledYuan','lockedYuan','arrangeableYuan'].every(k => money(balance[k]) !== null))
    return stop('insufficient_data','所选计划余额未知。');
  if (balance.remainingYuan === 0) return stop('complete','所选目标已全部成交，无下一笔可下达。');
  if (balance.lockedYuan > 0) return stop('blocked','所选目标已有未成交指令占用，须核实或完成现有指令，不能重复下达。','target_in_flight');
  if (currentCashRequirement.status !== 'ok') {
    result.needed=[...currentCashRequirement.needed];
    return stop(currentCashRequirement.status,'当前比例或执行事实不完整，不能确定下一笔融资缺口。');
  }
  if (!['deposit','cd_buy','bond_buy','reverse_repo','exchange_repo_lending'].includes(plan.businessType) ||
      plan.direction !== 'outflow' || plan.settlementDate !== state.context.businessDate)
    return stop('unsupported','本测算仅支持当日付款的现有存款、买券或逆回购目标。');
  const amount = balance.arrangeableYuan;
  if (amount <= 0 || amount % unitFor(plan.businessType) !== 0)
    return stop('blocked','下一笔剩余金额不符合当前业务交易单位。','target_amount');
  result.nextTradeRequirement.targetOutflowYuan=amount;
  result.payment.paymentYuan=amount;
  const reserved = ['localReservedYuan','platformReservedYuan','payableReservedYuan']
    .map(key => money(state.summary[key]));
  if (reserved.every(x => x !== null) && money(reserved.reduce((n,x)=>n+x,0)) !== null) {
    result.payment.reservedYuan=reserved.reduce((n,x)=>n+x,0);
    if (result.payment.accountCashYuan !== null) {
      result.payment.availableForPaymentYuan=result.payment.accountCashYuan-result.payment.reservedYuan;
      result.payment.shortfallYuan=Math.max(0,amount+(state.inputs.bufferYuan ?? 0)-result.payment.availableForPaymentYuan);
    }
  }
  // Use the same filled-only exposure basis as execution fill checks. Keep all
  // cash commitments; unrelated sent sales are never credited as completed.
  const immediate=evaluateCoreRules(actualFilledRuleState(state),{plan,amountYuan:amount});
  result.currentTargetRules=immediate.rows.map(safeRule);
  const row=c02(immediate), threshold=row?.threshold;
  if (!row || money(row.numeratorYuan) === null || money(row.denominatorYuan) === null ||
      !Number.isSafeInteger(threshold?.numerator) || !Number.isSafeInteger(threshold?.denominator) ||
      threshold.denominator <= 0 || threshold.operator !== '≥')
    return stop('insufficient_data','下一笔C02数据或比例合同不完整。');
  const required=(BigInt(row.denominatorYuan)*BigInt(threshold.numerator)+BigInt(threshold.denominator)-1n)/BigInt(threshold.denominator);
  const gap=required>BigInt(row.numeratorYuan) ? required-BigInt(row.numeratorYuan) : 0n;
  if (gap>BigInt(Number.MAX_SAFE_INTEGER)) return stop('insufficient_data','下一笔缺口超出安全整数范围。');
  result.nextTradeRequirement.mathematicalAdditionalFinancingYuan=Number(gap);
  let privateModel=createModel(structuredClone(saved));
  if (gap>0n) {
    const plans=state.plans.filter(x => isFinancing(x.businessType) &&
      state.summary.planBalances.find(b => b.planId===x.planId)?.remainingYuan>0);
    if (plans.length!==1) return stop('unsupported','需要唯一的现有未完成融资目标，才能验证业务单位及可成交路径。','financing_selection');
    const financing=plans[0], unit=unitFor(financing.businessType);
    const rounded=(gap+BigInt(unit)-1n)/BigInt(unit)*BigInt(unit);
    if (rounded>BigInt(Number.MAX_SAFE_INTEGER)) return stop('insufficient_data','按业务单位取整后超出安全整数范围。');
    const funding=Number(rounded), b=state.summary.planBalances.find(x=>x.planId===financing.planId);
    result.financing.unitYuan=unit;
    result.nextTradeRequirement.additionalFinancingFillYuan=funding;
    // Existing accepted orders may fill; merely sent/unknown orders may not be
    // silently turned into acknowledgements. Unarranged amounts must pass a
    // fresh deterministic calculation on the private model first.
    const live=Object.values(state.execution.instructions).filter(x => x.planId===financing.planId &&
      ['accepted','partial'].includes(x.status)).map(x => ({...x,
        remainder:x.nominalYuan-x.filledYuan-x.cancelledYuan})).filter(x=>x.remainder>0);
    const capacity=live.reduce((n,x)=>n+x.remainder,0)+b.arrangeableYuan;
    result.financing.availableCapacityYuan=money(capacity);
    if (capacity<funding) return stop('blocked','现有可确认融资指令及可安排余额不足以覆盖下一笔缺口。','financing_capacity');
    let remaining=funding;
    try {
      for (const instruction of live) {
        if (!remaining) break;
        const fill=Math.min(remaining,instruction.remainder);
        const gate=executionFillReadiness(privateModel.getState(),instruction.instructionId,fill);
        if (!gate.ready) throw new Error(gate.reason);
        privateModel.simulateEvent('fill',{instructionId:instruction.instructionId,nominalYuan:fill});
        result.financing.allocations.push({planId:financing.planId,amountYuan:fill,basis:'hypothetical_existing_instruction_fill'});
        remaining-=fill;
      }
      if (remaining) {
        privateModel.refreshSnapshot();
        const recalculated=privateModel.recalculateDispatchBatch([{planId:financing.planId,nominalYuan:remaining}]);
        const failed=recalculated.recalculationRows.find(x=>!x.ready);
        if (failed) throw new Error(failed.reason);
        privateModel.approveProposal();
        const sent=privateModel.send();
        privateModel.simulateEvent('accepted',{instructionId:sent.sentInstructionId});
        privateModel.simulateEvent('fill',{instructionId:sent.sentInstructionId,nominalYuan:remaining});
        result.financing.allocations.push({planId:financing.planId,amountYuan:remaining,basis:'hypothetical_new_instruction_within_existing_target'});
      }
      result.financing.verifiedFillYuan=funding;
    } catch (error) {
      result.financing.allocations=[];
      return stop('blocked',`融资成交条件未通过：${String(error.message).slice(0,400)}`,'financing_execution');
    }
  } else result.nextTradeRequirement.additionalFinancingFillYuan=0;
  const projectedState=privateModel.getState();
  const projected=evaluateCoreRules(actualFilledRuleState(projectedState),{plan,amountYuan:amount});
  result.projectedTargetRules=projected.rows.map(safeRule);
  const after=c02(projected);
  result.nextTradeRequirement.projectedC02Ratio=after?.projectedValue ?? null;
  result.remainingBlockers.push(...blocks(projected));
  // Recalculate exactly this target to pick up holdings, payment buffers,
  // remaining-plan ordering and other execution gates beyond C01-C09.
  try {
    privateModel.refreshSnapshot();
    const checked=privateModel.recalculateDispatchBatch([{planId,nominalYuan:amount}]);
    for (const failed of checked.recalculationRows.filter(x=>!x.ready))
      result.remainingBlockers.push({kind:'target_execution',ruleId:failed.ruleId ?? null,reason:failed.reason});
  } catch(error) { result.remainingBlockers.push({kind:'target_execution',reason:String(error.message).slice(0,400)}); }
  if (result.payment.shortfallYuan === null) result.remainingBlockers.push({kind:'payment_unknown',reason:'实际账户付款能力未知，须核验账户余额及已占用款项。'});
  else if (result.payment.shortfallYuan>0) result.remainingBlockers.push({kind:'payment_receipt',reason:'实际账户可付款现金不足；融资成交改善C02后，仍需核验足额到账付款。',amountYuan:result.payment.shortfallYuan});
  result.status=result.remainingBlockers.length?'blocked':'ok';
  result.reason=result.status==='ok'?'所示融资成交增量按当前规则测算通过；仍须刷新、重算、审核后手动下达。':'所示融资增量仅解决比例条件，仍有其他阻断。';
  return result;
}

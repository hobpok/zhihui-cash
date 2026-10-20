// Rendering and manual interaction for the C deterministic rule and batch contract.
import {displayLabel} from './display-labels.js';
import {metricPresentation} from './metric-display.js';
import {bankDepositLimitBps} from './initial-data.js';
import {BUSINESS_DIRECTIONS} from './business.js';
export const CORE_RULE_NAMES = {
  C01:'业务头寸非负', C02:'现金与一年内政府债比例', C03:'无托管资格银行存款及存单',
  C04:'有托管资格银行存款及存单', C05:'公司全部货基银行集中度',
  'C05-DEPOSIT':'公司新增存款闸门（默认6%／该行批准8%）',
  C06:'有托管资格银行全部金融工具', C07:'BB类银行占基金净值',
  C08:'BB类银行占银行净资产', C09:'平均剩余期限',
};

export function setupCoreUI({model,$,esc,amount,decimalYuan,parseMoney,getSkipReview=()=>false,
  tag,resultName,resultTone,readableText,stepName,
  openDialog,closeDialog,formError,formFooter,changed,render,setScreen}) {
  let ruleFilter='all',rulesExpanded=false,dispatchBusinessCache=null;
  const rowsOf=s=>s.coreRules?.rows||[];
  const value=(row,key)=>{
    const n=row[key];
    if(n==null)return row.result==='not_applicable'?'—':'待补';
    if(typeof n==='object')return n.display??n.value??'待补';
    if(typeof n==='string'&&!Number.isFinite(Number(n)))return n;
    const number=Number(n);
    if(row.ruleId==='C01')return `${amount(number)} 亿`;
    if(row.ruleId==='C09')return `${number.toFixed(2)} ${model.getState().initialData?.demoMode==='single-day-principal-v1'?'天':'交易日'}`;
    return `${(number*100).toFixed(4).replace(/0+$/,'').replace(/\.$/,'')}%`;
  };
  const threshold=row=>{const t=row.threshold,simple=model.getState().initialData?.demoMode==='single-day-principal-v1';if(t==null)return ({C01:'≥0元',C02:'≥5%',C03:'≤5%',C04:'≤20%',C05:'≤10%','C05-DEPOSIT':`新增存款后≤${bankDepositLimitBps(model.getState().initialData?.banks?.find(b=>b.bankId===row.subjectId))/100}%`,C06:'≤15%',C07:'≤2%',C08:'≤5%',C09:simple?'≤90天':'≤90交易日'})[row.ruleId]||'待补';if(typeof t!=='object')return t;if(t.numerator!=null&&t.denominator)return `${t.operator||''}${(t.numerator/t.denominator*100).toFixed(4).replace(/0+$/,'').replace(/\.$/,'')}%`;return `${t.operator||''}${t.value??t.valueDays??t.valueTradingDays??t.valueYuan??t.days??t.amountYuan??''}${row.ruleId==='C09'?(simple?'天':'交易日'):row.ruleId==='C01'?'元':''}`;};
  function rowDetail(s,row){
    openDialog(`${row.name||CORE_RULE_NAMES[row.ruleId]} · ${displayLabel(row.subjectLabel)||'组合'}`,
      `<p>${tag(resultTone(row.result),resultName(row.result))} ${esc(row.reason||'按当前输入判断')}</p>`+
      `<div class="core-detail-grid"><p>当前值<b>${esc(value(row,'currentValue'))}</b></p><p>预计值<b>${esc(value(row,'projectedValue'))}</b></p><p>阈值<b>${esc(threshold(row))}</b></p><p>金额余量<b>${row.headroomYuan==null?'待补 / 不适用':amount(row.headroomYuan)+' 亿'}</b></p></div>`+
      `<p>数据日期：${esc(s.context.businessDate)}。当前运行第${s.revision}版；来源为本运行初始模板与已录入的业务事件。显示舍入不参与放行。</p>`+
      `${row.needed?.length?`<p class="warning">需要补充：${esc(readableText(s,row.needed.join('、')))}</p>`:''}`+
      `<details class="technical-details"><summary>查看公式输入、来源及规则编号</summary><pre>${esc(JSON.stringify(row,null,2))}</pre></details>`);
  }
  function ruleTable(s,filter='all'){
    const rows=rowsOf(s).filter(r=>filter==='all'||r.result===filter);
    return `<div class="table-scroll"><table class="core-rule-table"><thead><tr><th>规则 / 主体</th><th>当前值</th><th>阈值</th><th>余量</th><th>状态与依据</th><th>核对</th></tr></thead><tbody>`+
      rows.map(r=>`<tr><td><b>${esc(r.name||CORE_RULE_NAMES[r.ruleId])}</b><small>${esc(displayLabel(r.subjectLabel)||'当前组合')}</small></td><td class="metric-${metricPresentation(r).tone}">${esc(value(r,'currentValue'))}</td><td>${esc(threshold(r))}</td><td>${r.headroomYuan==null?'—':amount(r.headroomYuan)+' 亿'}</td><td>${tag(resultTone(r.result),resultName(r.result))}<small>${esc(r.reason||'')}</small></td><td><button data-core-detail="${rowsOf(s).indexOf(r)}">依据</button></td></tr>`).join('')+
      (rows.length?'':'<tr><td colspan="6" class="empty-record">没有匹配的规则结果</td></tr>')+'</tbody></table></div>';
  }
  function renderRules(s){
    const enabled=s.coreRules?.enabled,rows=rowsOf(s),counts=Object.fromEntries(['pass','warn','block','missing','not_applicable'].map(k=>[k,rows.filter(r=>r.result===k).length]));
    $('core-rules-panel').hidden=!enabled;
    const definedCount=new Set(rows.map(r=>r.ruleId)).size;
    $('core-rules-count').textContent=enabled?`${definedCount}条已定义规则 · ${rows.length}项主体判断`:'旧场景保留历史规则';
    $('core-rule-counts').innerHTML=Object.entries(counts).map(([k,n])=>tag(resultTone(k),`${resultName(k)} ${n}`)).join(' ');
    $('core-rule-content').innerHTML=enabled?ruleTable(s,ruleFilter):'';
    if(enabled){
      const cash=rows.find(r=>r.ruleId==='C02'),term=rows.find(r=>r.ruleId==='C09');
      $('rule-summary-mini').innerHTML=`<div class="mini-heading"><b>核心规则 · 当前值</b><span>${definedCount}条已定义约束</span></div><p>现金比例：${esc(cash?value(cash,'currentValue'):'待补')} · 下限5%</p><p>平均剩余期限：${esc(term?value(term,'currentValue'):'待补')} · 上限90${s.initialData?.demoMode==='single-day-principal-v1'?'天':'交易日'}</p><p>按银行、品种及公司聚合；新增存款另按公司货基同银行敞口／银行季度净资产校验：默认6%，该行批准8%，等于限额允许。</p><p class="muted">当前状态与本次交易放行分别判断，具体下达仍须最新复核。</p>`;
    }
  }
  function renderProgress(s){
    const tr=s.calculation?.trace||s.calculationTrace||s.proposal?.trace;
    const progress=tr?.progress||s.calculation?.progress||s.proposal?.progress;
    const stages=Array.isArray(progress)?progress:progress?.stages||tr?.stages||[];
    $('calculation-progress').hidden=!tr;
    $('calculation-stage-list').innerHTML=stages.length?stages.map((p,i)=>`<li class="${p.status==='done'?'stage-complete':''}"><span>${i+1}</span><div><b>${esc(p.label||p.name||p.stage)}</b><small>${esc(p.message||p.detail||p.status||'状态待核实')}${p.count!=null?' · '+p.count+'项':''}</small></div></li>`).join(''):'<li><div><b>本次计算结果已返回</b><small>计算追踪保留候选、节点和停止原因。</small></div></li>';
    const search=tr?.search||{},boundary=search.stopReason||search.boundary;
    const names={candidate_budget:'达到候选预算，未穷尽',action_budget:'达到动作预算，未完整搜索',complete:'当前限定范围已完成',none:'当前限定范围已完成',node_limit:'已达到节点预算',action_limit:'已达到动作预算',beam_limit:'按候选宽度保留，未穷尽',bounded_search:'有界搜索完成，未穷尽',split_grid_unexplored:'复杂分次网格未穷尽',selected_path_only:'仅计算指定顺序',selected_split_path:'仅计算指定分次路径',unit_mismatch:'金额单位不匹配'};
    $('calculation-search-summary').textContent=`已考察 ${search.exploredCandidates??0} 个候选 / ${search.nodes??0} 个节点。${names[boundary]||search.message||'搜索边界见计算追踪'}。未安排的意向金额继续保留。`;
    const steps=s.proposal?.steps||[];
    const sent=new Set(Object.values(s.execution?.instructions||{}).filter(i=>i.status!=='rejected').map(i=>i.stepId));
    const pending=steps.filter(st=>!sent.has(st.stepId));
    const skipReview=Boolean(getSkipReview());
    const reviewed=s.approvalStatus==='valid'&&s.approval?.authoritySource!=='calculated_skip_review';
    const awaitingReview=!skipReview&&!reviewed;
    const item=st=>({stepId:st.stepId,nominalYuan:st.nominalYuan});
    const businessPreview=members=>model.previewDispatchBatch(members.map(item),{skipReview:true});
    const fresh=s.execution?.snapshot?.quality==='fresh'&&!s.execution.requiresRefresh&&Date.now()-s.execution.snapshot.observedAt<=30000;
    const cacheKey=`${s.context.runId}/${s.revision}/${s.proposal?.proposalId||''}/${s.proposal?.version||''}/${fresh}`;
    let cards,globalError='';
    if(dispatchBusinessCache?.key===cacheKey){({cards,globalError}=dispatchBusinessCache);}
    else{
      cards=[];
      const readyGroups=[];
      let firstPreview=null;
      if(pending.length&&typeof model.previewDispatchBatch==='function'){
        try{firstPreview=businessPreview([pending[0]]);}catch(error){globalError=error.message||String(error);}
      }
      if(!globalError&&typeof model.previewDispatchBatch==='function'){
        // Only actual cumulative virtual sends can establish a jointly dispatchable group.
        for(const st of pending){
          let single;
          try{single=st===pending[0]?firstPreview:businessPreview([st]);}
          catch(error){cards.push({members:[st],businessReady:false,reason:error.message||String(error)});continue;}
          if(!single.ready){cards.push({members:[st],businessReady:false,reason:single.reason});continue;}
          let placed=false;
          for(const group of readyGroups){
            try{if(businessPreview([...group.members,st]).ready){group.members.push(st);placed=true;break;}}
            catch{/* This combination is not established as safe; try another group. */}
          }
          if(!placed)readyGroups.push({members:[st],businessReady:true,reason:'按本组当前顺序逐笔及累计业务预检通过'});
        }
      }else{
        // A missing calculation or pending report is an overall gate, not evidence that every step fails alone.
        const byId=new Map(pending.map(st=>[st.stepId,st])),used=new Set();
        for(const g of s.proposal?.groups||[]){
          const members=(g.stepIds||[]).filter(id=>byId.has(id)&&!used.has(id)).map(id=>{used.add(id);return byId.get(id);});
          if(members.length)cards.push({members,businessReady:false,reason:globalError||g.reason||'等待当前计算和预检'});
        }
        for(const st of pending)if(!used.has(st.stepId))cards.push({members:[st],businessReady:false,reason:globalError||'等待当前计算和预检'});
      }
      cards.push(...readyGroups);
      cards.sort((a,b)=>steps.indexOf(a.members[0])-steps.indexOf(b.members[0]));
      dispatchBusinessCache={key:cacheKey,cards,globalError};
    }
    const planBalances=new Map((s.summary?.planBalances||[]).map(row=>[row.planId,row]));
    $('dispatch-groups').innerHTML=cards.map((g,i)=>{
      let sendPreview=null,sendError='';
      if(g.businessReady&&!awaitingReview){
        try{sendPreview=model.previewDispatchBatch(g.members.map(item),{skipReview});}
        catch(error){sendError=error.message||String(error);}
      }
      const sendReady=g.businessReady&&(awaitingReview||sendPreview?.ready);
      const status=!g.businessReady?(globalError?'待计算或补齐回报':'资金或前置条件待满足'):
        awaitingReview?'待人工审核 · 可共同下达候选':sendReady?'可共同下达':'下达前需刷新或复核';
      const reason=!g.businessReady?g.reason:awaitingReview?'业务条件通过；下达前须完成当前指令包的人工审核。':
        sendPreview?.reason||sendError||g.reason;
      const nominalYuan=g.members.reduce((n,st)=>n+st.nominalYuan,0);
      return `<div class="dispatch-group"><b>${status} · 批次${i+1}</b><span>${amount(nominalYuan)} 亿</span><small>按当前可共同下达性合组，不改变预演路径。${g.members.length}笔独立指令；批量窗口可改金额与顺序，并重新校验每个前缀。</small><ol class="dispatch-group-members">${g.members.map(st=>{const b=planBalances.get(st.planId);return `<li>${esc(stepName(s,st))}<small>本次建议 ${amount(st.nominalYuan)} 亿 · 意向 ${amount(b?.targetYuan)} 亿 · 已下达 ${amount(b?b.filledYuan+b.lockedYuan:null)} 亿 · 未下达 ${amount(b?.arrangeableYuan)} 亿 · 已成交 ${amount(b?.filledYuan)} 亿</small><small>${g.businessReady?(awaitingReview?'业务条件通过，待人工审核':sendReady?'可下达':'下达前待复核'):'本笔受阻'}</small></li>`;}).join('')}</ol><small>${esc(readableText(s,reason))}</small></div>`;
    }).join('')||'<p class="muted">完成计算后，按最新资金、规则和前置条件列出可下达批次。</p>';
  }
  function rulesDialog(){
    const s=model.getState();
    const count=new Set(rowsOf(s).map(r=>r.ruleId)).size;
    openDialog('已定义规则与判断依据',`<p>${count}条已定义规则按适用主体展开，判断数量可能超过规则条数。新增存款闸门＝（本基金与公司其他货基同银行存款＋存单＋银行债）／银行季度净资产；新增存款后不得超过该行参数，默认6%，该行批准8%，等于限额允许。仅新增存款触发；存单买入仍须通过其他适用规则。演示8%为合成批准参数，未连接真实审批系统。现有敞口不据此直接标为违规。现金比例与基金集中度以基金净值为分母；单日模式的C09期限以基金净值加存续正回购本金为分母。</p>${ruleTable(s)}<p>当前值、预计值、输入时点和计算证据均可逐项查看。</p>`);
  }
  function batchDialog(){
    const s=model.getState(),skipReview=Boolean(getSkipReview());
    const calculated=s.proposal?.origin==='calculated'?(s.proposal.steps||[]):[];
    const recommendedPlans=new Set(calculated.map(step=>step.planId));
    const defaultSelected=new Set();
    const defaultItems=[];
    for(const step of calculated){
      const group=(s.proposal?.groups||[]).find(item=>item.stepIds.includes(step.stepId));
      const staleBlocked=s.proposal.pathId==='CUSTOM-ORDER'&&step.blocked&&
        /快照过期|尚未刷新/.test(group?.reason||'');
      if(!staleBlocked&&step.blocked)continue;
      const candidate=[...defaultItems,{stepId:step.stepId,nominalYuan:step.nominalYuan}];
      if(staleBlocked){defaultItems.push(candidate.at(-1));defaultSelected.add(step.stepId);continue;}
      try{
        const check=model.previewDispatchBatch(candidate,{skipReview:true,assumeFreshSnapshot:true});
        if(check.ready){
          defaultItems.push(candidate.at(-1));defaultSelected.add(step.stepId);
        }
      }catch{/* Keep the step unselected if other execution facts cannot be checked. */}
    }
    const balances=new Map((s.summary?.planBalances||[]).map(b=>[b.planId,b]));
    const plans=[...calculated.filter(step=>(balances.get(step.planId)?.arrangeableYuan??0)>0)
      .map(step=>({plan:s.plans.find(p=>p.planId===step.planId),step})),
      ...s.plans.filter(p=>!recommendedPlans.has(p.planId)&&
        (balances.get(p.planId)?.arrangeableYuan??0)>0).map(plan=>({plan,step:null}))];
    const complete=s.plans.filter(p=>(balances.get(p.planId)?.arrangeableYuan??0)===0);
    openDialog('手动批量下达指令',`<form id="batch-form"><div class="batch-sticky-summary" aria-live="polite"><div class="batch-summary-metrics"><strong id="batch-selected-count">已选 0 笔</strong><span id="batch-inflow">流入 0 亿</span><span id="batch-outflow">流出 0 亿</span></div><div class="batch-summary-status"><span id="batch-validation-status">待复核</span><span id="batch-approval-status">审核待核</span></div></div><div id="batch-scroll-content" class="batch-scroll-content" tabindex="0" role="region" aria-label="批次指令与重算结果"><p class="origin-note">勾选指令并核对金额、顺序；变更后重新计算。</p><div class="batch-toolbar"><button id="batch-refresh" type="button">核对并刷新当前数据</button><button id="batch-recalculate" type="button" class="primary">按所选顺序和金额重新计算</button></div><label class="batch-select-all"><input id="batch-select-all" type="checkbox" ${plans.length?'':'disabled'}>全选未完成指令</label><div id="batch-options" class="batch-options" role="list" aria-label="本次批次顺序">`+
      plans.map(({plan:p,step:st})=>{const b=balances.get(p.planId),cap=Math.min(st?.nominalYuan??b.arrangeableYuan,b.arrangeableYuan);return `<div class="batch-option batch-edit-row" role="listitem" data-plan-id="${esc(p.planId)}" data-step-id="${esc(st?.stepId||'')}"><span class="batch-drag-handle" aria-hidden="true" title="拖拽调整顺序">⋮⋮</span><label class="batch-select"><input type="checkbox" name="planId" value="${esc(p.planId)}" ${st&&defaultSelected.has(st.stepId)?'checked':''}><span class="batch-order-number"></span><b>${esc(displayLabel(p.label))}</b></label><label class="batch-money">本次金额（亿元）<input class="batch-amount" inputmode="decimal" autocomplete="off" value="${esc(decimalYuan(cap))}" aria-label="${esc(displayLabel(p.label))}本次金额，单位亿元"></label><span class="batch-move"><button type="button" data-batch-move="up" aria-label="上移${esc(displayLabel(p.label))}">↑</button><button type="button" data-batch-move="down" aria-label="下移${esc(displayLabel(p.label))}">↓</button></span><small class="batch-row-reason" aria-live="polite"></small><details class="batch-step-meta"><summary>明细</summary><span>${st?`计算步骤 ${st.sequenceIndex||''} · ${amount(st.nominalYuan)} 亿`:'未列入原推荐'} · 意向 ${amount(b.targetYuan)} 亿 · 已下达 ${amount(b.filledYuan+b.lockedYuan)} 亿 · 未下达 ${amount(b.arrangeableYuan)} 亿 · 已成交 ${amount(b.filledYuan)} 亿 · 本次金额可安排范围 0–${amount(b.arrangeableYuan)} 亿</span></details></div>`;}).join('')+
      (plans.length?'':'<p>全部意向已成交或下达占用；请核对投管事实。</p>')+
      `</div>${complete.length?`<details class="batch-complete-note"><summary>已完成或全部占用 · ${complete.length}笔</summary>${complete.map(p=>{const b=balances.get(p.planId);return `<p>${esc(displayLabel(p.label))} · 意向 ${amount(b.targetYuan)} 亿 · 已下达 ${amount(b.filledYuan+b.lockedYuan)} 亿 · 未下达 ${amount(b.arrangeableYuan)} 亿 · 已成交 ${amount(b.filledYuan)} 亿</p>`;}).join('')}</details>`:''}<div class="batch-preview" aria-live="polite"><b>所选顺序重算结果</b><p id="batch-preview-summary">请点击重新计算。</p><ol id="batch-preview-rows"></ol></div></div><div class="batch-sticky-footer"><label class="checkline"><input type="checkbox" name="confirmed" required><span id="batch-confirm-text">我已核对重算后的对象、金额、顺序、逐笔结果，并确认手动下达</span></label><p id="batch-submit-reason" class="batch-submit-reason" role="status"></p>${formFooter('确认下达所选0笔')}</div></form>`);
    const form=$('batch-form'),list=$('batch-options'),selectAll=$('batch-select-all'),submit=form.querySelector('button[type="submit"]');
    let recalculated=calculated.length?{revision:s.revision,
      baseRows:calculated.map(step=>({stepId:step.stepId,planId:step.planId,
        nominalYuan:step.nominalYuan,ready:s.approvalEligibleStepIds.includes(step.stepId),
        reason:(s.proposal.groups||[]).find(group=>group.stepIds.includes(step.stepId))?.reason||''})),
      items:[],ready:false}:null;
    let untouched=true;
    const rows=()=>[...list.querySelectorAll('.batch-edit-row')];
    let validationMessage='尚未复核所选指令';
    let snapshotExpiryTimer=null;
    const updateBatchChrome=()=>{
      const selected=rows().filter(row=>row.querySelector('[name="planId"]').checked);
      const now=model.getState();
      const sums={inflow:0n,outflow:0n},invalid={inflow:false,outflow:false};
      let unknownDirection=false;
      for(const row of selected){
        const plan=now.plans.find(item=>item.planId===row.dataset.planId);
        const direction=BUSINESS_DIRECTIONS[plan?.businessType]||plan?.direction;
        if(direction!=='inflow'&&direction!=='outflow'){unknownDirection=true;continue;}
        try{sums[direction]+=BigInt(parseMoney(row.querySelector('.batch-amount').value,'亿'));}
        catch{invalid[direction]=true;}
      }
      $('batch-selected-count').textContent=`已选 ${selected.length} 笔`;
      $('batch-inflow').textContent=`流入 ${unknownDirection?'方向待核':invalid.inflow?'金额待核':amount(sums.inflow.toString())+' 亿'}`;
      $('batch-outflow').textContent=`流出 ${unknownDirection?'方向待核':invalid.outflow?'金额待核':amount(sums.outflow.toString())+' 亿'}`;
      const snapshot=now.execution?.snapshot;
      const fresh=snapshot?.quality==='fresh'&&!now.execution?.requiresRefresh&&
        Number.isFinite(snapshot.observedAt)&&Date.now()-snapshot.observedAt<=30000;
      clearTimeout(snapshotExpiryTimer);
      if(fresh)snapshotExpiryTimer=setTimeout(()=>{if(form.isConnected)updateBatchChrome();},
        Math.max(1,snapshot.observedAt+30001-Date.now()));
      const checked=Boolean(form.elements.confirmed.checked);
      const revisionCurrent=recalculated?.revision===now.revision;
      const current=Boolean(selected.length&&recalculated?.ready&&revisionCurrent&&
        !invalid.inflow&&!invalid.outflow&&!unknownDirection&&fresh);
      const status=current?'通过':!selected.length?'未选择指令':!fresh?'当前数据待核对并刷新':
        !revisionCurrent&&recalculated?'运行已变化，须重新计算':validationMessage;
      $('batch-validation-status').textContent=`最新复核：${status}`;
      const approved=now.approvalStatus==='valid'&&now.approval?.authoritySource!=='calculated_skip_review';
      $('batch-approval-status').textContent=skipReview?'审核：本次跳过人工审核':approved?'审核：已通过':
        '审核：尚未审核；确认下达将同时审核本次计算指令包';
      $('batch-confirm-text').textContent=skipReview?
        '我已核对重算后的对象、金额、顺序、逐笔结果，并确认跳过人工审核后手动下达':
        approved?'我已核对重算后的对象、金额、顺序、逐笔结果，并确认手动下达':
        '我已核对重算后的对象、金额、顺序、逐笔结果，确认同时审核本次计算指令包并手动下达';
      submit.textContent=`确认下达所选${selected.length}笔`;
      // Preserve the existing calculation gate; the required checkbox remains the final confirmation gate.
      submit.disabled=!current;
      $('batch-submit-reason').textContent=!selected.length?'请先选择至少一笔指令。':
        unknownDirection?'所选指令方向待核，暂不能下达。':
        invalid.inflow||invalid.outflow?'所选金额有误，请修正后重新计算。':
        !fresh?'当前执行事实待核对并刷新。':
        !current?`${status}；请调整选择或重新计算。`:
        checked?'已核对所选批次；点击后仍按最新事实逐笔校验。':'请勾选核对确认后下达。';
    };
    const numberRows=()=>{const ordered=rows();ordered.forEach((row,i)=>{
      row.querySelector('.batch-order-number').textContent=`${i+1}. `;
      row.querySelector('[data-batch-move="up"]').disabled=i===0;
      row.querySelector('[data-batch-move="down"]').disabled=i===ordered.length-1;
    });};
    const syncSelectAll=()=>{
      const boxes=rows().map(row=>row.querySelector('[name="planId"]'));
      const checked=boxes.filter(box=>box.checked).length;
      selectAll.checked=boxes.length>0&&checked===boxes.length;
      selectAll.indeterminate=checked>0&&checked<boxes.length;
    };
    const selectedItems=()=>rows().filter(row=>row.querySelector('[name="planId"]').checked).map(row=>{
      try{return {planId:row.dataset.planId,stepId:row.dataset.stepId,
        nominalYuan:parseMoney(row.querySelector('.batch-amount').value,'亿')};}
      catch(error){
        row.querySelector('.batch-row-reason').textContent=`金额错误：${error.message||String(error)}`;
        throw new Error(`${displayLabel(s.plans.find(p=>p.planId===row.dataset.planId)?.label)}金额错误：${error.message||String(error)}`);
      }
    });
    const preview=()=>{
      numberRows();
      syncSelectAll();
      const summary=$('batch-preview-summary'),details=$('batch-preview-rows');
      recalculated=null;
      validationMessage='所选内容已变更，须重新计算';
      summary.textContent='顺序或金额已变更，请点击“按所选顺序和金额重新计算”；原结果已失效。';
      details.replaceChildren();
      rows().forEach(row=>row.querySelector('.batch-row-reason').textContent=row.querySelector('[name="planId"]').checked?'待重新计算':'未选，本次不发送');
      updateBatchChrome();
    };
    const selectionChanged=(clearConfirmation=true)=>{
      numberRows();syncSelectAll();
      if(clearConfirmation)form.elements.confirmed.checked=false;
      if(!recalculated||model.getState().revision!==recalculated.revision){preview();return;}
      let chosen;
      try{chosen=selectedItems();}catch{preview();return;}
      const byStep=new Map(recalculated.baseRows.map((row,index)=>[row.stepId,{...row,index}]));
      const selected=chosen.map(item=>({item,base:byStep.get(item.stepId)}));
      const basisChanged=selected.some(({item,base},index)=>!base||item.nominalYuan!==base.nominalYuan||
        (index>0&&selected[index-1].base&&selected[index-1].base.index>=base.index));
      rows().forEach(row=>{
        const base=byStep.get(row.dataset.stepId),checked=row.querySelector('[name="planId"]').checked;
        row.querySelector('.batch-row-reason').textContent=!checked?'未选，本次不发送':
          basisChanged?'金额或顺序已变更，须重新计算（旧结果已失效）':
          !base?'新增或调整步骤，须重新计算':
          !base.ready?`原计算阻断：${readableText(model.getState(),base.reason||'当前计算步骤不可审核')}`:
          '原计算步骤，待最新逐前缀复核';
      });
      const unchanged=selected.length>0&&selected.every(({item,base},index)=>base?.ready&&
        item.nominalYuan===base.nominalYuan&&(index===0||selected[index-1].base.index<base.index));
      if(!unchanged){
        recalculated.items=[];recalculated.ready=false;
        validationMessage='所选步骤或金额、顺序须重新计算';
        $('batch-preview-summary').textContent='所选步骤包含未通过项，或金额、顺序、范围已变更；请调整选择或重新计算。';
        $('batch-preview-rows').replaceChildren();
        updateBatchChrome();
        return;
      }
      const items=selected.map(({base})=>({stepId:base.stepId,nominalYuan:base.nominalYuan}));
      try{
        const check=model.previewDispatchBatch(items,{skipReview:true});
        recalculated.items=items;recalculated.ready=check.ready;
        validationMessage=check.ready?'逐前缀复核通过':'逐前缀复核受阻';
        rows().forEach(row=>{if(row.querySelector('[name="planId"]').checked){
          const gate=check.rows.find(item=>item.stepId===row.dataset.stepId);
          row.querySelector('.batch-row-reason').textContent=`${gate?.ready?'可下达':'阻断'}：${readableText(model.getState(),gate?.reason||check.reason)}`;
        }});
        $('batch-preview-rows').innerHTML=check.rows.map((row,i)=>`<li>${i+1}. ${esc(displayLabel(model.getState().plans.find(p=>p.planId===
          model.getState().proposal.steps.find(step=>step.stepId===row.stepId)?.planId)?.label))} · ${esc(decimalYuan(row.nominalYuan))} 亿：${row.ready?'可下达':'阻断'} · ${esc(readableText(model.getState(),row.reason))}</li>`).join('');
        $('batch-preview-summary').textContent=check.ready?
          `所选 ${items.length} 笔沿用原计算顺序，最新逐前缀校验通过；仍须核对并手动下达。`:
          `所选批次当前受阻：${readableText(model.getState(),check.reason)}；请重新计算或核对资金与依赖。`;
      }catch(error){
        recalculated.ready=false;
        validationMessage='当前无法复核';
        $('batch-preview-rows').replaceChildren();
        $('batch-preview-summary').textContent=`当前无法复核：${error.message||String(error)}；请核对并刷新当前数据。`;
      }
      updateBatchChrome();
    };
    const recalculateSelected=()=>{
      const items=selectedItems();
      if(!items.length)throw new Error('请至少勾选一笔未完成指令。');
      if(new Set(items.map(item=>item.planId)).size!==items.length)
        throw new Error('同一计划的多笔原计算步骤可按原金额和顺序直接下达；若要改金额或顺序，请逐笔选择并重算。');
      const currentSteps=new Map((model.getState().proposal?.steps||[]).map(step=>[step.stepId,step]));
      if(items.some(item=>item.stepId&&!currentSteps.has(item.stepId)&&
        calculated.filter(step=>step.planId===item.planId).length>1))
        throw new Error('该计划的分次方案已变化，请返回交易台重新计算后再调整。');
      const result=model.recalculateDispatchBatch(items.map(({planId,stepId,nominalYuan})=>({
        planId,nominalYuan,...(stepId&&currentSteps.get(stepId)?.planId===planId?{sourceStepId:stepId}:{})
      }))),now=model.getState();
      const chosen=rows().filter(row=>row.querySelector('[name="planId"]').checked);
      chosen.forEach((row,index)=>row.dataset.stepId=result.recalculationRows[index].stepId);
      recalculated={revision:now.revision,baseRows:result.recalculationRows,
        items:result.recalculationRows.map(row=>({stepId:row.stepId,nominalYuan:row.nominalYuan})),ready:result.recalculationReady};
      selectionChanged();
      return result;
    };
    $('batch-recalculate').onclick=()=>{try{
      recalculateSelected();untouched=false;
      changed('所选批次已重新计算；请核对结果后手动下达。');
    }catch(error){validationMessage='重新计算失败';if(recalculated)recalculated.ready=false;updateBatchChrome();formError(error);}};
    form.elements.confirmed.addEventListener('change',updateBatchChrome);
    selectAll.addEventListener('change',()=>{
      untouched=false;
      rows().forEach(row=>row.querySelector('[name="planId"]').checked=selectAll.checked);
      selectionChanged();
    });
    list.addEventListener('input',()=>{untouched=false;selectionChanged();});
    list.addEventListener('change',()=>{untouched=false;selectionChanged();});
    list.addEventListener('click',event=>{
      const button=event.target.closest('[data-batch-move]');if(!button)return;
      untouched=false;
      const row=button.closest('.batch-edit-row');
      if(button.dataset.batchMove==='up'&&row.previousElementSibling?.classList.contains('batch-edit-row'))list.insertBefore(row,row.previousElementSibling);
      if(button.dataset.batchMove==='down'&&row.nextElementSibling?.classList.contains('batch-edit-row'))list.insertBefore(row.nextElementSibling,row);
      selectionChanged();
      const currentButton=row.querySelector(`[data-batch-move="${button.dataset.batchMove}"]`);
      (currentButton.disabled?row.querySelector(`[data-batch-move="${button.dataset.batchMove==='up'?'down':'up'}"]`):currentButton).focus();
    });
    const dialog=$('dialog'),dialogBody=$('batch-scroll-content'),listeners=new AbortController();
    const animations=new WeakMap(),activeAnimations=new Set();
    let dragging=null;
    const animateOthers=before=>{
      for(const row of rows()){
        const previous=animations.get(row);
        if(previous){previous.cancel();activeAnimations.delete(previous);}
        const shift=before.get(row)-row.getBoundingClientRect().top;
        if(Math.abs(shift)>1&&typeof row.animate==='function'&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){
          const animation=row.animate([{transform:`translateY(${shift}px)`},{transform:'translateY(0)'}],{duration:150,easing:'ease-out'});
          animations.set(row,animation);
          activeAnimations.add(animation);
          animation.addEventListener('finish',()=>activeAnimations.delete(animation),{once:true});
        }
      }
    };
    const placePlaceholder=()=>{
      const ordered=rows(),before=new Map(ordered.map(row=>[row,row.getBoundingClientRect().top]));
      const next=ordered.find(row=>dragging.y<row.getBoundingClientRect().top+row.getBoundingClientRect().height/2);
      if((next||null)===(dragging.placeholder.nextElementSibling||null))return;
      list.insertBefore(dragging.placeholder,next||null);
      animateOthers(before);
    };
    const edgeSpeed=(value,start,end)=>value<start+38&&value>=start-40?-Math.min(18,(start+38-value)/3):value>end-38&&value<=end+40?Math.min(18,(value-(end-38))/3):0;
    const dragFrame=()=>{
      if(!dragging?.active)return;
      const {row,x,y,offsetX,offsetY}=dragging;
      row.style.left=`${x-offsetX}px`;
      row.style.top=`${y-offsetY}px`;
      const listRect=list.getBoundingClientRect();
      const listSpeed=edgeSpeed(y,listRect.top,listRect.bottom);
      if(listSpeed&&list.scrollHeight>list.clientHeight)list.scrollTop+=listSpeed;
      else{
        const bodyRect=dialogBody.getBoundingClientRect();
        const bodySpeed=edgeSpeed(y,bodyRect.top,bodyRect.bottom);
        if(bodySpeed&&dialogBody.scrollHeight>dialogBody.clientHeight)dialogBody.scrollTop+=bodySpeed;
      }
      placePlaceholder();
      dragging.frame=requestAnimationFrame(dragFrame);
    };
    const startDrag=()=>{
      const drag=dragging,rect=drag.row.getBoundingClientRect();
      drag.active=true;
      drag.originalNext=drag.row.nextElementSibling;
      drag.oldStyle=drag.row.getAttribute('style');
      drag.placeholder=document.createElement('div');
      drag.placeholder.className='batch-drop-placeholder';
      drag.placeholder.setAttribute('aria-hidden','true');
      drag.placeholder.style.height=`${rect.height}px`;
      drag.placeholder.style.width=`${rect.width}px`;
      list.insertBefore(drag.placeholder,drag.row);
      dialog.appendChild(drag.row); // Stay in the dialog top layer, outside its scrolling body.
      Object.assign(drag.row.style,{position:'fixed',left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`,boxSizing:'border-box',margin:'0',zIndex:'3'});
      drag.row.classList.add('batch-dragging');
      try{drag.handle.setPointerCapture(drag.pointerId);}catch{/* Window listeners still finish the drag. */}
      drag.frame=requestAnimationFrame(dragFrame);
    };
    const finishDrag=commit=>{
      if(!dragging)return;
      const drag=dragging;
      dragging=null;
      if(drag.frame)cancelAnimationFrame(drag.frame);
      for(const animation of activeAnimations)animation.cancel();
      activeAnimations.clear();
      if(drag.active){
        if(commit&&drag.placeholder.isConnected)drag.placeholder.replaceWith(drag.row);
        else if(drag.originalNext?.parentElement===list)list.insertBefore(drag.row,drag.originalNext);
        else list.appendChild(drag.row);
        drag.placeholder.remove();
        if(drag.oldStyle==null)drag.row.removeAttribute('style');
        else drag.row.setAttribute('style',drag.oldStyle);
        drag.row.classList.remove('batch-dragging');
      }
      try{if(drag.handle.hasPointerCapture(drag.pointerId))drag.handle.releasePointerCapture(drag.pointerId);}catch{/* Capture may already be gone. */}
      if(drag.active&&commit&&dialog.open)selectionChanged();
    };
    list.addEventListener('pointerdown',event=>{
      const handle=event.target.closest('.batch-drag-handle');
      if(!handle||event.isPrimary===false||event.button!==0||dragging)return;
      const row=handle.closest('.batch-edit-row');
      if(!row)return;
      event.preventDefault();
      dragging={row,handle,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY,offsetX:event.clientX-row.getBoundingClientRect().left,offsetY:event.clientY-row.getBoundingClientRect().top,active:false,frame:0};
      try{handle.setPointerCapture(event.pointerId);}catch{/* Window listeners still track this pointer. */}
    },{signal:listeners.signal});
    window.addEventListener('pointermove',event=>{
      if(!dragging||event.pointerId!==dragging.pointerId)return;
      dragging.x=event.clientX;dragging.y=event.clientY;
      if(!dragging.active&&Math.hypot(event.clientX-dragging.startX,event.clientY-dragging.startY)>4)startDrag();
      if(dragging.active)event.preventDefault();
    },{signal:listeners.signal});
    window.addEventListener('pointerup',event=>{if(dragging?.pointerId===event.pointerId)finishDrag(true);},{signal:listeners.signal});
    window.addEventListener('pointercancel',event=>{if(dragging?.pointerId===event.pointerId)finishDrag(false);},{signal:listeners.signal});
    window.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&dragging){event.preventDefault();event.stopPropagation();finishDrag(false);}
    },{capture:true,signal:listeners.signal});
    dialog.addEventListener('close',()=>{
      // close is queued; a refreshed batch can already be open on the same dialog.
      if(dialog.open&&form.isConnected)return;
      finishDrag(false);
      clearTimeout(snapshotExpiryTimer);
      listeners.abort();
    },{signal:listeners.signal});
    $('batch-refresh').onclick=()=>{try{
      const now=model.refreshSnapshot();
      if(recalculated)recalculated.revision=now.revision;
      const staleCalculation=recalculated&&model.getState().proposal?.pathId==='CUSTOM-ORDER'&&
        recalculated.baseRows.some(row=>!row.ready&&/快照过期|尚未刷新/.test(row.reason||''));
      if(staleCalculation){
        const current=selectedItems();
        const base=new Map(recalculated.baseRows.map(row=>[row.stepId,row]));
        if(current.length&&current.every(item=>base.get(item.stepId)?.nominalYuan===item.nominalYuan)&&
          new Set(current.map(item=>item.planId)).size===current.length)recalculateSelected();
      }
      if(untouched&&!rows().some(row=>row.querySelector('[name="planId"]').checked)){
        const candidates=[];
        for(const row of rows()){
          const base=recalculated?.baseRows.find(item=>item.stepId===row.dataset.stepId);
          if(!base?.ready)continue;
          const next=[...candidates,{stepId:base.stepId,nominalYuan:base.nominalYuan}];
          try{if(model.previewDispatchBatch(next,{skipReview:true}).ready){
            row.querySelector('[name="planId"]').checked=true;candidates.push(next.at(-1));
          }}catch{/* Keep the step unselected until its facts can be checked. */}
        }
      }
      selectionChanged();
      changed('当前执行快照已刷新；请核对批次结果。');
    }catch(e){validationMessage='刷新或复核失败';if(recalculated)recalculated.ready=false;updateBatchChrome();formError(e);}};
    form.onsubmit=e=>{e.preventDefault();try{
      if(!recalculated?.ready||model.getState().revision!==recalculated.revision)
        throw new Error('重算结果已失效，请按当前顺序和金额重新计算。');
      const currentItems=selectedItems();
      const expected=recalculated.items;
      if(currentItems.length!==expected.length||currentItems.some((item,i)=>item.nominalYuan!==expected[i].nominalYuan||
        model.getState().proposal.steps.find(step=>step.stepId===expected[i].stepId)?.planId!==item.planId))
        throw new Error('批次顺序或金额已变化，请重新计算。');
      if(!model.previewDispatchBatch(expected,{skipReview:true}).ready)
        throw new Error('最新逐前缀校验未通过，请重新计算或核对当前数据。');
      if(!skipReview&&(model.getState().approvalStatus!=='valid'||
        model.getState().approval?.authoritySource==='calculated_skip_review'))model.approveProposal();
      const result=model.sendCustomBatch(recalculated.items,{skipReview});
      closeDialog();changed('手动批次已逐笔处理，请核对接收结果；成交与收付继续由投管回报确认。');
      const now=model.getState();
      openDialog('本次批量下达结果',`<p>${esc(readableText(now,result.stoppedReason||'本次所选步骤已处理完成。'))}</p><ul>${(result.results||[]).map(r=>`<li><b>${esc(stepName(now,r.stepId))}</b>${r.nominalYuan==null?'':` · ${esc(decimalYuan(r.nominalYuan))} 亿`}：${esc(({accepted:'已登记接收',unknown:'发送未知，保留占用',rejected:'明确拒绝',not_sent:'尚未发送',sent:'已发送',blocked:'校验阻断'})[r.status]||r.status)}${r.reason?' · '+esc(readableText(now,r.reason)):''}</li>`).join('')}</ul><p>未选指令及本批停止后的指令均未发送。部分下达后请重新计算剩余意向金额；成交与收付仍待投管回报。</p><div class="dialog-actions"><button type="button" data-screen="desk">返回交易台</button><button type="button" data-screen="execution" class="primary">前往投管处理</button></div>`);
    }catch(error){validationMessage='下达前复核失败';if(recalculated)recalculated.ready=false;updateBatchChrome();formError(error);}};
    if(recalculated)selectionChanged(false);else preview();
  }
  // Expansion is view state only; calculations, filtering and approval stay independent.
  $('core-rules-toggle').onclick=()=>{
    rulesExpanded=!rulesExpanded;
    $('core-rules-body').hidden=!rulesExpanded;
    $('core-rule-filter-label').hidden=!rulesExpanded;
    $('core-rules-toggle').setAttribute('aria-expanded',String(rulesExpanded));
    $('core-rules-toggle').textContent=rulesExpanded?'收起规则':'展开规则';
  };
  $('core-rule-filter').onchange=e=>{ruleFilter=e.target.value;renderRules(model.getState());};
  document.addEventListener('click',e=>{
    const detail=e.target.closest('[data-core-detail]');
    if(detail){const s=model.getState(),r=rowsOf(s)[Number(detail.dataset.coreDetail)];if(r){if($('dialog').open)closeDialog();rowDetail(s,r);}}
    if(e.target.closest('[data-action="send-batch"]'))try{batchDialog();}catch(error){formError(error);}
  });
  return {render:s=>{renderRules(s);renderProgress(s);},rulesDialog,batchDialog,value,threshold};
}


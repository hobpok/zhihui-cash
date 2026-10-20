(async function () {
  'use strict';
  const data = await window.ZHDesignAdapter.loadViewModel();
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '待确认').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const amount = value => value === null ? '待确认' : (value / 100000000).toFixed(2);
  const signed = value => `${value > 0 ? '+' : ''}${amount(value)}`;
  const tag = (tone, text) => `<span class="tag ${escape(tone)}">${escape(text)}</span>`;
  const ruleMap = Object.fromEntries(data.rules.map(rule => [rule.id, rule]));
  const tradeMap = Object.fromEntries(data.trades.map(trade => [trade.id, trade]));
  let currentPath = 'A';
  let records = [];
  let lastFocus = null;

  function renderCatalog() {
    $('catalog-rows').innerHTML = data.rules.map(rule => `<tr><td>${escape(rule.id)}</td><td><b>${escape(rule.name)}</b><small>${escape(rule.category)}</small></td><td>${escape(rule.level)}<small>${escape(rule.stage)}</small></td><td>${escape(rule.expression)}</td><td>${escape(rule.source)}</td></tr>`).join('');
    $('rule-count').textContent = data.rules.length;
  }
  function renderTrades() {
    $('trade-rows').innerHTML = data.trades.map(trade => `<tr><td><b>${escape(trade.type)}</b><small>${escape(trade.id)}</small></td><td>${escape(trade.object)}<small>${escape(trade.direction)} · ${escape(trade.role)}</small></td><td class="num"><b>${amount(trade.amountYuan)}</b></td><td class="num ${trade.cashFlowYuan > 0 ? 'pass' : ''}">${signed(trade.cashFlowYuan)}</td><td>${escape(trade.status)}</td><td>${escape(trade.condition)}<small>${escape(trade.ruleIds.join(' / '))}</small></td><td><button data-trade="${escape(trade.id)}">详情</button></td></tr>`).join('');
  }
  function renderGroups() {
    // 人工指定的设计分组，仅负责表达顺序角色；不是自动排单算法。
    const groups = [
      {name:'必须先做', items:[['SELL-001','先推进回笼，确认可用后才能使用2亿'], ['DEP-001','A/C先存款，再做A银行存单']]},
      {name:'可以并行',items:[]},
      {name:'条件执行',items:[['CD-001','A/C等待存款成交确认'],['RR-001','全额需资金条件兑现；可手动分次']]},
      {name:'建议后置',items:[['BOND-001','本候选排在银行两项之后；未证明整批可并行']]},
      {name:'替换 / 取消',items:[]}
    ];
    if(currentPath==='B') {
      groups[0].items=[['SELL-001','先确认卖券回款可用']];
      groups[0].items.push(['CD-001','反例先买存单，比例升至8.1%']);
      groups[2].items=[['DEP-001','阻断待重排；1亿目标保留，未取消'],['RR-001','反例已中止，后续不宣告可发']];
      groups[3].items=[['BOND-001','反例中止，待重排后再评估']];
    }
    if(currentPath==='C') {
      groups[0].items=[['DEP-001','仍先存款，保护新增存款路径']];
      groups[2].items=[['CD-001','等待存款成交确认'],['RR-001','卖券款未可用时，峰值需10亿'],['SELL-001','本路径假定回款最后可用；非建议拖延卖券']];
    }
    $('order-groups').innerHTML=groups.map(group=>`<div class="order-group"><div class="group-head">${escape(group.name)}<span>${group.items.length}</span></div>${group.items.length ? group.items.map(([id,note])=>`<div class="order-item"><b>${escape(id)} · ${escape(tradeMap[id].type)} ${amount(tradeMap[id].amountYuan)}亿</b><span>${escape(note)}</span></div>`).join('') : '<div class="empty-group">本候选暂无此类建议<br>不为了填满分组生成交易</div>'}</div>`).join('');
  }

  function buildPresetLogs(path) {
    // 由明确人工预期字段组装记录视图；不进行正式规则求值或候选搜索。
    const rows = data.logsCommon.map(row=>({...row}));
    let previous = data.initialCashYuan;
    for (const step of path.steps) {
      rows.push({step:`${step.n}`,trade:step.trade,rule:'DEMO-CASH-01',input:`上步${amount(previous)}亿；本步${signed(step.flowYuan)}亿`,formula:`${amount(previous)} ${step.flowYuan<0?'−':'+'} ${amount(Math.abs(step.flowYuan))} = ${amount(step.balanceYuan)} 亿`,before:`投影${amount(previous)}亿`,after:`投影${amount(step.balanceYuan)}亿`,result:step.balanceYuan<0?'wait':'pass',label:step.balanceYuan<0?'缺资金条件':'示例投影非负',reason:step.balanceYuan<0?`本步缺口${amount(step.gapYuan)}亿；负投影不得当可用资金`:step.status==='block'?'存款被其他规则阻断，本步现金流为0':'仅此现金算式，不代表全规则或发送校验通过'});
      previous=step.balanceYuan;
      if(step.trade==='SELL-001') rows.push({step:String(step.n),trade:step.trade,rule:'DEMO-CASH-03',input:'卖出2亿，日初未计入',formula:'仅确认可用事件才可加2亿',before:'预计回笼2亿 / 此前确认回笼0',after:'本路径假定本步确认可用',result:'wait',label:'条件假设',reason:'尚无实时事件；不能用候选路径修改当前3亿实际资金'});
      if(step.trade==='DEP-001') rows.push({step:String(step.n),trade:step.trade,rule:'DEMO-EXP-01',input:`A银行交易前${step.before}；NAV500亿`,formula:`${step.before} ${step.status==='block'?'>':'≤'} 8%`,before:step.before,after:step.after,result:step.status==='block'?'block':'pass',label:step.status==='block'?'阻断新增存款':'本条不阻断',reason:step.status==='block'?'存款1亿不执行，目标保留，敞口不再加1亿':'投前7.9%未超过8%；投后8.1%不追溯否决此步'});
      if(step.trade==='CD-001') {
        rows.push({step:String(step.n),trade:step.trade,rule:'DEMO-EXP-01',input:'业务=存单买入；限制动作=新增存款',formula:'动作不适用，不把存款禁令扩大到所有买入',before:step.before,after:step.after,result:'na',label:'本条不适用',reason:'其他适用限制仍需独立校验，不能据此声称全部合规'});
        if(currentPath!=='B') {
          rows.push({step:String(step.n),trade:step.trade,rule:'DEMO-PATH-01',input:'DEP-001成交确认是前置事件',formula:'先发送存款不等于已成交',before:'当前尚无成交',after:'候选假定已确认',result:'wait',label:'前置事件待确认',reason:'仅在事件实际确认后方可沿此候选推进'});
          rows.push({step:String(step.n),trade:step.trade,rule:'DEMO-WARN-01',input:'预计A银行敞口41.5亿 / NAV500亿',formula:'8.3% ≥ 8.2%（合成观察线）',before:step.before,after:step.after,result:'warn',label:'模拟软预警',reason:'提示经理审核接受；不自动阻断存单，也不能覆盖硬限制'});
        }
      }
      if(step.trade==='RR-001') rows.push({step:String(step.n),trade:step.trade,rule:'DEMO-CASH-02',input:`此步需补${amount(step.gapYuan)}亿；融资可用确认尚无`,formula:'所需融资 ≠ 已可用融资',before:'当前未确认融资',after:`需补${amount(step.gapYuan)}亿条件`,result:'wait',label:'等待资金',reason:'融资额度/质押券待补；本页不自动新增融资或下达'});
    }
    return rows.map((row,index)=>({...row,id:`PRESET-${currentPath}-${String(index+1).padStart(2,'0')}`,path:currentPath,snapshot:data.context.snapshot,ruleVersion:data.context.ruleVersion,evidence:'人工预期 / 设计样例'}));
  }

  function renderRecords() {
    const filter=$('result-filter').value;
    const search=$('rule-search').value.trim().toLowerCase();
    const filtered=records.filter(row=>(filter==='all'||row.result===filter)&&(!search||[row.rule,ruleMap[row.rule].name,row.trade,row.input,row.reason,row.label].join(' ').toLowerCase().includes(search)));
    const count=tone=>records.filter(row=>row.result===tone).length;
    $('record-summary').textContent=`候选${currentPath} · ${records.length}条样例 · 阻断${count('block')} / 预警${count('warn')} / 待补${count('missing')}`;
    $('record-rows').innerHTML=filtered.length?filtered.map(row=>`<tr><td>${escape(row.step)}<small>${escape(row.trade)}</small></td><td><b>${escape(row.rule)}</b><small>${escape(ruleMap[row.rule].name)}</small></td><td>${escape(row.input)}<small>${escape(row.formula)}</small></td><td>${escape(row.before)}<small>→ ${escape(row.after)}</small></td><td>${tag(row.result,row.label)}</td><td>${escape(row.reason)}</td><td><button data-record="${escape(row.id)}" aria-label="查看${escape(row.id)}记录明细">展开</button></td></tr>`).join(''):'<tr><td colspan="7" class="empty-record">没有匹配记录；请调整结果筛选或检索词。</td></tr>';
    $('record-foot').textContent=`显示${filtered.length} / ${records.length}条 · 输入快照 ${data.context.snapshot} · 规则版本 ${data.context.ruleVersion} · 所有记录为预置人工预期，无真实引擎执行时间。`;
  }
  function renderPath() {
    const path=data.paths[currentPath];
    $('peak-metric').innerHTML=path.peakGapYuan===null?'<span style="font-size:18px">未完整测算</span>':`${amount(path.peakGapYuan)}<small>亿</small>`;
    $('peak-note').textContent=path.peakGapYuan===null?'路径阻断；不是需求为0':'未计新增融资的投影';
    $('path-summary').innerHTML=`<b>${escape(path.label)}</b>${tag(path.tone,path.conclusion)}`;
    $('path-explanation').textContent=path.explanation;
    let cumulativeGap=0;
    $('path-rows').innerHTML=path.steps.map(step=>{
      cumulativeGap=Math.max(cumulativeGap,step.gapYuan);
      return `<tr><td>${step.n}</td><td><b>${escape(step.action)}</b><small>${escape(step.trade)}</small></td><td class="num">${signed(step.flowYuan)}</td><td class="num ${step.balanceYuan<0?'negative':''}">${amount(step.balanceYuan-step.flowYuan)} → <b>${amount(step.balanceYuan)}</b></td><td class="num">${amount(step.gapYuan)}<small>峰值 ${amount(cumulativeGap)}</small></td><td>${escape(step.before)} → ${escape(step.after)}</td><td>${tag(step.status,step.result)}<small>${escape(step.condition)}</small></td></tr>`;
    }).join('');
    document.querySelectorAll('[data-path]').forEach(button=>{const selected=button.dataset.path===currentPath;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
    $('path-panel').setAttribute('aria-labelledby',`path-${currentPath}`);
    renderGroups();records=buildPresetLogs(path);renderRecords();
    const highlights=[records.find(row=>row.result==='missing'),records.find(row=>row.rule==='DEMO-EXP-01'&&row.trade==='DEP-001'),records.find(row=>row.rule==='DEMO-CASH-02')].filter(Boolean);
    $('rule-summary-mini').innerHTML=`<div class="mini-heading"><b>规则检查摘要 · 候选${currentPath}</b><a href="#rule-records">全部${records.length}条 ↓</a></div>${highlights.map(row=>`<button data-record="${escape(row.id)}"><b>${escape(row.rule)}</b>${tag(row.result,row.label)}<small>${escape(row.formula)}</small></button>`).join('')}<div class="mini-foot">11项模拟规则 · 人工预期，非引擎日志</div>`;
  }
  function renderExecution() {
    $('execution-rows').innerHTML=data.trades.map(trade=>{
      const occupied=trade.id==='RR-001'?data.execution.occupiedYuan:0;
      return `<tr><td><b>${escape(trade.id)}</b><small>${trade.id==='RR-001'?'RR-I01（合成）':'未生成指令'}</small></td><td>${escape(trade.type)}</td><td class="num">${amount(trade.amountYuan)}</td><td class="num">0.00</td><td class="num">${amount(occupied)}</td><td class="num">${amount(trade.amountYuan-occupied)}</td><td>${trade.id==='RR-001'?tag('wait','已接收未成交'):trade.id==='SELL-001'?tag('wait','未成交 / 回款未可用'):tag('neutral','未下达')}</td><td><button data-trade="${escape(trade.id)}">关联计划与规则</button></td></tr>`;
    }).join('');
    $('event-rows').innerHTML=data.execution.events.map(event=>`<tr><td>${escape(event.time)}<small>${escape(event.id)}</small></td><td>${escape(event.trade)}</td><td>${escape(event.event)}</td><td>${escape(event.cash)}</td><td>${escape(event.state)}</td><td>${escape(event.note)}</td></tr>`).join('');
  }
  function openDialog(title,html) {
    lastFocus=document.activeElement;
    $('dialog-title').textContent=title;$('dialog-body').innerHTML=html;
    $('detail-dialog').showModal();$('close-dialog').focus();
  }
  const lines=entries=>entries.map(([key,value])=>`<div class="detail-line"><b>${escape(key)}</b><span>${escape(value)}</span></div>`).join('');
  function openNamed(name) {
    if(name==='rules') openDialog('规则全案 · 11项模拟设计规则',`<p class="origin-note">这些是演示规则与业务不变量草案，不是正式制度。规则目录与规则记录分别建模，后续可替换数据来源。</p><div class="table-scroll"><table><thead><tr><th>ID / 名称</th><th>输入 / 检查时点</th><th>表达式 / 性质</th><th>来源</th></tr></thead><tbody>${data.rules.map(rule=>`<tr><td>${escape(rule.id)}<small>${escape(rule.name)}</small></td><td>${escape(rule.inputs)}<small>${escape(rule.stage)}</small></td><td>${escape(rule.expression)}<small>${escape(rule.level)}</small></td><td>${escape(rule.source)}</td></tr>`).join('')}</tbody></table></div>`);
    if(name==='preferences') openDialog('经理偏好与冲突处理',`<p>硬约束先筛选；偏好不能覆盖资金与适用硬限制。以下为已确认的默认排序。</p>${lines(data.preferences.map(pref=>[`${pref.rank}. ${pref.name}`,pref.kind]))}<p style="margin-top:12px">候选A：先存款保护路径，卖券先回款降低峰值；逆回购后置是此候选的演示选择，不是永久品种顺序。候选C：若卖券款晚到，峰值升到10亿。未知交易时间窗不假装已满足。</p><p>实现阶段允许编辑优先级；保存新版本后，相关未发送指令重新计算并按范围重审。当前设计稿不保存偏好变更。</p>`);
    if(name==='assumptions') openDialog('场景假设与来源',`<ol>${data.assumptions.map(item=>`<li>${escape(item)}</li>`).join('')}</ol><p>本页增加的8.2%软观察线仅为说明预警展示而设；正式规则、公式、交易参数和时点需后续确认。截图旧有的“全部禁止”等结论不会继承。</p>`);
    if(name==='plan') openDialog('计划输入字段 · 文字设计',`<p>日初资金不足不阻止保存完整计划；编辑后的目标须覆盖已有成交和在途事实。此窗口是字段规范，不提交业务。</p><div class="table-scroll"><table><thead><tr><th>字段</th><th>示例</th><th>约束</th></tr></thead><tbody><tr><td>业务类型 / 方向 / 对象</td><td>存款 / 存入 / A银行</td><td>用对象ID关联规则，不仅按名称</td></tr><tr><td>计划名义金额</td><td>1.00亿元</td><td>底层人民币元整数；保留金额单位</td></tr><tr><td>预计结算现金</td><td>−1.00亿元（本例同额）</td><td>与名义金额分开，后续由交易模型计算</td></tr><tr><td>交易 / 交收日期</td><td>2026-09-07</td><td>本轮均当日收付，不等于已经到账</td></tr><tr><td>利率 / 价格 / 到期 / 时窗</td><td>待用户或接口补充</td><td>未知保持null；相关正式校验不能放行</td></tr><tr><td>纳入日初与否</td><td>否（用户明确）</td><td>防止现金流重复计入</td></tr></tbody></table></div><p>新增/编辑计划的完整表单将在合同明确后的原型阶段实现。</p>`);
    if(name==='approval') openDialog('审核指令包 · 完整字段设计',`${lines([['范围','场景、组合、交易日、父计划ID与版本'],['每笔指令','指令ID、对象、方向、金额、顺序、必要交易参数'],['条件','前置成交/资金可用事件；已接受预警与冲突'],['版本','规则、偏好、输入快照与建议版本'],['审核效果','只建立许可，不发送、不占用资金'],['后续下达','每次手动点击，最新校验；变更清单重新呈示，内容变更重审']])}<p style="margin-top:12px">本例未建立审核包，也未确认新增融资，不能把候选路径当作可发送批次。同次审核可覆盖明确后续条件项，但条件始终不足时保留未完成目标。</p>`);
    if(name==='adapter') openDialog('场景与接口替换入口',`<p class="origin-note">设计期view model，版本 ${escape(data.schemaVersion)}。当前由本地fixture加载，未建立完整阶段2A接口合同。</p>${lines([['数据入口','dense-data.js → ZHDesignAdapter.loadViewModel()'],['页面消费','context / trades / rules / paths / logsCommon / execution'],['金额单位','人民币元整数；页面换算为亿元'],['结果来源','preset_design：人工预期；不得冒充live_engine'],['后续替换','已分离展示数据入口；阶段2按合同补齐字段映射，模板文案同步更新'],['当前不具备','正式规则求值、自动搜索、审核写入、指令下达、持久化']])}<p style="margin-top:10px">预置路径切换只更换展示结果，不更新当前资金或成交事实。</p><button id="download-model">下载当前视图数据JSON</button><pre>${escape(JSON.stringify({schemaVersion:data.schemaVersion,mode:data.mode,scenarioId:data.scenarioId,context:data.context,initialCashYuan:data.initialCashYuan,feeYuan:data.feeYuan,bufferYuan:data.bufferYuan,financingLimitYuan:data.financingLimitYuan,trades:data.trades},null,2))}</pre>`);
  }
  document.addEventListener('click',event=>{
    const named=event.target.closest('[data-dialog]');if(named)openNamed(named.dataset.dialog);
    const pathButton=event.target.closest('[data-path]');if(pathButton){currentPath=pathButton.dataset.path;renderPath();}
    const tradeButton=event.target.closest('[data-trade]');if(tradeButton){const trade=tradeMap[tradeButton.dataset.trade];openDialog(`${trade.id} · ${trade.type}`,lines([['目标 / 现金',`${amount(trade.amountYuan)}亿 / ${signed(trade.cashFlowYuan)}亿`],['对象 / 方向',`${trade.object} / ${trade.direction}`],['状态 / 条件',`${trade.status}；${trade.condition}`],['规则关联',trade.ruleIds.join(' / ')],['数据说明',trade.note],['本页操作','只查看，不新增指令、成交或现金事件']]))}
    const recordButton=event.target.closest('[data-record]');if(recordButton){const row=records.find(record=>record.id===recordButton.dataset.record);openDialog(`${row.id} · ${ruleMap[row.rule].name}`,`<p class="origin-note">${escape(row.evidence)}，无实际引擎执行时间。展示“如果按候选与假设推进”的预期判断。</p>${lines([['候选 / 步骤 / 业务',`${row.path} / ${row.step} / ${row.trade}`],['规则 / 版本',`${row.rule} / ${row.ruleVersion}`],['输入快照',row.snapshot],['输入',row.input],['算式',row.formula],['前值 → 后值',`${row.before} → ${row.after}`],['预期结果',row.label],['判断依据',row.reason],['规则来源',ruleMap[row.rule].source]])}`)}
    const screenButton=event.target.closest('[data-screen]');if(screenButton){const execution=screenButton.dataset.screen==='execution';$('desk-screen').hidden=execution;$('execution-screen').hidden=!execution;$('snapshot').textContent=execution?'S13-INTRADAY-PRESET':data.context.snapshot;document.querySelectorAll('[data-screen]').forEach(button=>{if(button===screenButton)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current')});}
    if(event.target.closest('#download-model')){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='zhihui-design-view-v03.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  });
  const pathButtons=[...document.querySelectorAll('[data-path]')];
  pathButtons.forEach((button,index)=>button.addEventListener('keydown',event=>{let next;if(event.key==='ArrowRight')next=(index+1)%3;else if(event.key==='ArrowLeft')next=(index+2)%3;else if(event.key==='Home')next=0;else if(event.key==='End')next=2;else return;event.preventDefault();currentPath=pathButtons[next].dataset.path;renderPath();pathButtons[next].focus();}));
  $('close-dialog').addEventListener('click',()=>$('detail-dialog').close());
  $('detail-dialog').addEventListener('close',()=>lastFocus?.focus());
  $('result-filter').addEventListener('change',renderRecords);$('rule-search').addEventListener('input',renderRecords);
  renderCatalog();renderTrades();renderPath();renderExecution();
})().catch(error=>{
  console.error(error);
  const warning=document.createElement('p');warning.textContent='设计数据未能加载，请检查本地脚本文件是否完整。';document.body.prepend(warning);
});

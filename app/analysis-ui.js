// D iteration: read-only indicators and source-aware catalog presentation.
import {buildAnalysis, normalizeAnalysisPreferences, updateAnalysisPreference} from './analysis.js';
import {displayLabel, displayText} from './display-labels.js';

const STORAGE_KEY = 'zhihui-analysis-preferences-v1';
const FILTERS = new Set(['all', 'favorite', 'abnormal', 'missing']);
const VIEWS = new Set(['core', 'historical', 'rules']);
const STATUS = {
  pass: ['通过', 'pass'], warn: ['预警', 'warn'], block: ['阻断', 'block'],
  missing: ['待补', 'missing'], notapp: ['不适用', 'na'], not_applicable: ['不适用', 'na'],
  configured: ['已配置', 'pass'], unprovided: ['待提供', 'missing'],
};

function readPreferences() {
  try { return normalizeAnalysisPreferences(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); }
  catch { return normalizeAnalysisPreferences(null); }
}

function writePreferences(value) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); return true; }
  catch { return false; }
}

function numeric(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function decimal(value, places = 6) {
  const n = numeric(value);
  if (n === null) return '待补';
  return n.toLocaleString('zh-CN', {maximumFractionDigits: places});
}

function displayValue(value, unit) {
  if (value == null) return '待补';
  if (typeof value === 'object') return value.display ?? (value.value == null ? '待补' : displayValue(value.value, unit));
  const n = numeric(value);
  if (n === null) return String(value);
  if (unit === 'ratio') return `${decimal(n * 100, 6)}%`;
  if (unit === 'trading_days') return `${decimal(n, 4)}交易日`;
  if (unit === 'days') return `${decimal(n, 4)}天`;
  if (unit === 'yuan') return `${decimal(n / 100000000, 8)}亿元`;
  return decimal(n, 8);
}

function thresholdText(threshold, unit) {
  if (threshold == null) return '待补';
  if (typeof threshold !== 'object') return String(threshold);
  const op = threshold.operator || '';
  if (threshold.numerator != null && threshold.denominator != null && Number(threshold.denominator) !== 0)
    return `${op}${displayValue(Number(threshold.numerator) / Number(threshold.denominator), 'ratio')}`;
  if (threshold.valueTradingDays != null || threshold.days != null)
    return `${op}${displayValue(threshold.valueTradingDays ?? threshold.days, 'trading_days')}`;
  if (threshold.valueDays != null)
    return `${op}${displayValue(threshold.valueDays, 'days')}`;
  if (threshold.valueYuan != null || threshold.amountYuan != null)
    return `${op}${displayValue(threshold.valueYuan ?? threshold.amountYuan, 'yuan')}`;
  if (threshold.value != null) return `${op}${displayValue(threshold.value, unit)}`;
  return '待补';
}

function statusOf(row) {
  return row.status || row.result || (row.configured ? 'configured' : 'unprovided');
}

function missingOf(row) {
  if (statusOf(row) === 'configured') return false;
  return ['missing', 'unprovided'].includes(statusOf(row)) ||
    (row.value == null && row.currentValue == null && !['notapp', 'not_applicable'].includes(statusOf(row)));
}

function matchFilter(row, key, filter, favorites) {
  if (filter === 'favorite') return favorites.has(key);
  if (filter === 'abnormal') return ['warn', 'block'].includes(statusOf(row));
  if (filter === 'missing') return missingOf(row);
  return true;
}

function sortRows(rows, keyOf, preferences) {
  const favorites = new Set(preferences.favorites || []);
  const order = new Map((preferences.order || []).map((key, index) => [key, index]));
  return rows.map((row, index) => ({row, index})).sort((a, b) => {
    const ka = keyOf(a.row), kb = keyOf(b.row);
    if (favorites.has(ka) !== favorites.has(kb)) return favorites.has(ka) ? -1 : 1;
    const oa = order.get(ka), ob = order.get(kb);
    if (oa != null || ob != null) return (oa ?? Number.MAX_SAFE_INTEGER) - (ob ?? Number.MAX_SAFE_INTEGER);
    return a.index - b.index;
  }).map(x => x.row);
}

export function setupAnalysisUI({model, $, esc, escRaw=esc, openDialog, closeDialog, notify, render}) {
  let view = 'core', filter = 'all', search = '', selectedStep = '', preferences = readPreferences();
  let latest = null, runId = null, projectionExpiryTimer = null;
  const root = $('analysis-screen');
  if (!root) throw new Error('缺少 #analysis-screen 容器');
  const rawSafe = value => escRaw(value == null ? '' : value);
  const safe = value => esc(value == null ? '待补' : displayText(value));
  const neededText = items => [...new Set(items.map(value=>String(value)
    .replace(/banks\.([^.]+)\.custodyQualified/g,(_,id)=>`${displayLabel(model.getState().initialData?.banks?.find(b=>b.bankId===id)?.label)||id}托管资格`)
    .replace(/banks\.([^.]+)\.ratingAsOf/g,(_,id)=>`${displayLabel(model.getState().initialData?.banks?.find(b=>b.bankId===id)?.label)||id}评级日期`)
    .replace(/banks\.([^.]+)\.rating/g,(_,id)=>`${displayLabel(model.getState().initialData?.banks?.find(b=>b.bankId===id)?.label)||id}评级`)
    .replace(/banks\.([^.]+)\.quarterEnd/g,(_,id)=>`${displayLabel(model.getState().initialData?.banks?.find(b=>b.bankId===id)?.label)||id}季度净资产日期`)
    .replace(/otherFundBankExposure\.([\w-]+)/g,'公司其他货基同银行敞口')
    .replace(/termWeights\./g,'期限权重：').replace(/dateBalances\.availableYuan/g,'当日业务头寸')))].join('；');
  const statusTag = value => {
    const [label, tone] = STATUS[value] || ['待核实', 'missing'];
    return `<span class="analysis-status analysis-status--${tone}">${label}</span>`;
  };
  const control = (key, label, isFavorite, canOrder) =>
    `<div class="analysis-row-actions"><button type="button" data-analysis-action="toggle" data-key="${rawSafe(key)}" aria-label="${isFavorite ? '取消常用' : '加入常用'}：${safe(label)}" title="${isFavorite ? '取消常用' : '加入常用'}">${isFavorite ? '★' : '☆'}</button>`+
    (canOrder ? `<button type="button" data-analysis-action="up" data-key="${rawSafe(key)}" aria-label="上移：${safe(label)}" title="上移">↑</button><button type="button" data-analysis-action="down" data-key="${rawSafe(key)}" aria-label="下移：${safe(label)}" title="下移">↓</button>` : '') + '</div>';
  const searched = (row, fields) => !search || fields.some(x => String(x ?? '').toLocaleLowerCase('zh-CN').includes(search));

  function buildCoreRows() {
    const source = latest.coreRows || [];
    const favorites = new Set(preferences.favorites || []);
    const rows = sortRows(source, x => x.key, preferences).filter(row =>
      matchFilter(row, row.key, filter, favorites) && searched(row, [row.ruleId, row.name, row.subjectLabel, row.reason]));
    return `<div class="analysis-table-wrap"><table class="analysis-table analysis-table--core"><thead><tr><th>常用 / 顺序</th><th>指标与主体</th><th>当前值</th><th>选定步骤交易后预计</th><th>阈值 / 当前余量</th><th>判断</th><th>来源</th></tr></thead><tbody>`+
      rows.map((row, i) => {
        const status = statusOf(row), projected = latest.projection?.available ? row.projectedValue : null;
        const notapp = ['notapp', 'not_applicable'].includes(status);
        const currentText = notapp && row.currentValue == null ? '—/不适用' : displayValue(row.currentValue, row.unit);
        const projectedText = notapp && projected == null ? '—/不适用' : displayValue(projected, row.unit);
        const threshold = notapp && row.threshold == null ? '—' : thresholdText(row.threshold, row.unit);
        const headroom = row.ruleId === 'C09' ? '金额余量不适用' :
          row.headroomYuan == null ? (notapp ? '—/不适用' : '待补') : displayValue(row.headroomYuan, 'yuan');
        return `<tr data-analysis-row="core" data-key="${rawSafe(row.key)}"><td>${control(row.key, row.name, favorites.has(row.key), favorites.has(row.key))}</td>`+
          `<td><b>${safe(row.name)}</b><small>${safe(displayLabel(row.subjectLabel) || '当前组合')}${row.ruleId==='C09'&&row.unit==='days'?' · 分母为净值＋存续正回购本金':''}</small></td>`+
          `<td class="analysis-number">${safe(currentText)}</td>`+
          `<td class="analysis-number">${latest.projection?.available || notapp ? safe(projectedText) : '—'}</td>`+
          `<td><div class="analysis-band analysis-band--${STATUS[status]?.[1] || 'missing'}"><b>${safe(threshold)}</b><small>当前余量 ${safe(headroom)}</small></div></td>`+
          `<td>当前 ${statusTag(status)}${latest.projection?.available && row.projectedStatus ? `<small>预计 ${statusTag(row.projectedStatus)}</small>` : ''}<small>${safe(row.reason || '')}</small></td>`+
          `<td><button type="button" data-analysis-detail="core" data-index="${source.indexOf(row)}">依据</button></td></tr>`;
      }).join('') + (rows.length ? '' : '<tr><td colspan="7" class="analysis-empty">没有匹配的核心指标</td></tr>') +
      '</tbody></table></div>';
  }

  function buildHistoricalRows() {
    const source = latest.historicalMetrics || [];
    const favorites = new Set(preferences.favorites || []);
    const rows = sortRows(source, x => x.metricId, preferences).filter(row =>
      matchFilter(row, row.metricId, filter, favorites) && searched(row, [row.metricId, row.name, row.category, row.unitEvidence]));
    return `<p class="analysis-note">历史目录保留原始名称与证据；当前数值、阈值和公式均待数据接入。历史组合代码只在来源详情中展示。</p>`+
      `<div class="analysis-table-wrap"><table class="analysis-table analysis-table--history"><thead><tr><th>常用 / 顺序</th><th>指标名称</th><th>类别（推断）</th><th>当前值</th><th>单位证据</th><th>状态</th><th>来源</th></tr></thead><tbody>`+
      rows.map(row => `<tr data-analysis-row="historical" data-key="${rawSafe(row.metricId)}"><td>${control(row.metricId, row.name, favorites.has(row.metricId), favorites.has(row.metricId))}</td>`+
        `<td><b>${safe(row.name)}</b><small>${safe(row.metricId)}</small></td><td>${safe(row.category)}</td><td class="analysis-number">待补</td>`+
        `<td>${safe(row.unitEvidence || '待核实')}</td><td>${statusTag('missing')}</td>`+
        `<td><button type="button" data-analysis-detail="historical" data-index="${source.indexOf(row)}">来源</button></td></tr>`).join('')+
      (rows.length ? '' : '<tr><td colspan="7" class="analysis-empty">没有匹配的历史指标</td></tr>') + '</tbody></table></div>';
  }

  function buildRuleRows() {
    const source = latest.ruleDirectory || [];
    const favoriteRules = new Set((preferences.favorites || []).filter(key => key.startsWith('C')).map(key => key.split(':')[0]));
    const rows = source.filter(row => matchFilter(row, row.ruleId, filter, favoriteRules) &&
      searched(row, [row.ruleId, row.name, row.source]));
    return `<p class="analysis-note">原120项目录保留，另增1项公司新增存款闸门；合计121项，10项已配置、111项待提供。主体判断数量另计；不适用不计作通过。</p>`+
      `<div class="analysis-table-wrap"><table class="analysis-table analysis-table--rules"><thead><tr><th>目录编号</th><th>规则名称</th><th>配置状态</th><th>实际判断</th><th>依据</th></tr></thead><tbody>`+
      rows.map(row => `<tr data-analysis-row="rules" data-key="${rawSafe(row.ruleId)}"><td>${safe(row.ruleId)}</td><td><b>${safe(row.name || '待提供')}</b></td>`+
        `<td>${statusTag(statusOf(row))}</td><td>${row.configured ? '见核心实时指标' : '待提供规则内容与输入'}</td>`+
        `<td><button type="button" data-analysis-detail="rules" data-index="${source.indexOf(row)}">详情</button></td></tr>`).join('')+
      (rows.length ? '' : '<tr><td colspan="5" class="analysis-empty">没有匹配的目录项</td></tr>') + '</tbody></table></div>';
  }

  function detail(kind, index) {
    const row = (kind === 'core' ? latest.coreRows : kind === 'historical' ? latest.historicalMetrics : latest.ruleDirectory)?.[index];
    if (!row) return;
    const line = (label, value) => `<div class="analysis-detail-line"><b>${safe(label)}</b><span>${safe(value)}</span></div>`;
    let body = '';
    if (kind === 'core') {
      const notapp = ['notapp', 'not_applicable'].includes(statusOf(row));
      const currentText = notapp && row.currentValue == null ? '—/不适用' : displayValue(row.currentValue, row.unit);
      const projectedText = notapp && row.projectedValue == null ? '—/不适用' : displayValue(row.projectedValue, row.unit);
      body = `<p>${statusTag(statusOf(row))} ${safe(row.reason || '判断依据待补')}</p>`+
        line('主体', displayLabel(row.subjectLabel) || '当前组合') + line('当前值', currentText)+
        line('原始当前值', row.currentValue == null ? (notapp ? '—/不适用' : '待补') : String(row.currentValue))+
        line('交易后预计值', latest.projection?.available || notapp ? projectedText : '未取得可靠测算结果')+
        line('交易后预计值原始字段', latest.projection?.available && row.projectedValue != null ? String(row.projectedValue) : (notapp ? '—/不适用' : '待补 / 未测算'))+
        line('阈值', notapp && row.threshold == null ? '—' : thresholdText(row.threshold, row.unit))+
        line('阈值原始字段', row.threshold == null ? (notapp ? '—' : '待补') : JSON.stringify(row.threshold))+
        line('当前余量', row.ruleId === 'C09' ? '金额余量不适用' : row.headroomYuan == null ? (notapp ? '—/不适用' : '待补') : displayValue(row.headroomYuan, 'yuan'))+
        line('当前余量原始元数', row.ruleId === 'C09' ? '金额余量不适用' : row.headroomYuan == null ? (notapp ? '—/不适用' : '待补') : String(row.headroomYuan))+
        line('数据日期', row.asOfDate || latest.context?.asOfDate || latest.context?.businessDate)+
        line('运行版本', model.getState().revision == null ? '待补' : `第${model.getState().revision}版`)+
        line('来源', typeof row.source === 'string' ? row.source : JSON.stringify(row.source || latest.context?.source || '当前工作区'))+
        line('缺项', row.needed?.length ? neededText(row.needed) : '无已标记缺项');
    } else if (kind === 'historical') {
      const source = row.source || {};
      body = `<p class="analysis-note">原始目录证据。名称、适用范围和单位需要按原件核实；没有接入当前值或阈值。</p>`+
        line('指标编号', row.metricId)+line('类别（推断）', row.category)+line('单位证据', row.unitEvidence || '待核实')+
        line('原件文件名', source.fileName || '待补')+line('工作表', source.sheet || '待补')+
        line('原件行 / 区域', `${source.row ?? '待补'} / ${source.range || '待补'}`)+
        line('适用性证据', row.applicabilityEvidence?.length ? JSON.stringify(row.applicabilityEvidence) : '待核实')+
        line('质量备注', row.qualityNotes?.length ? JSON.stringify(row.qualityNotes) : '无');
    } else {
      body = line('目录编号', row.ruleId)+line('名称', row.name || '待提供')+
        line('状态', row.configured ? '已配置规则或交易闸门' : '规则定义、阈值、输入与实际结果待提供')+
        line('来源', typeof row.source === 'string' ? row.source : JSON.stringify(row.source || '待提供'))+
        line('数据日期', row.asOfDate || latest.context?.asOfDate || '待提供');
    }
    openDialog(`${row.name || '指标详情'} · 来源与缺项`, `<div class="analysis-detail">${body}</div>`);
  }

  function renderScreen(state) {
    if (projectionExpiryTimer !== null) { clearTimeout(projectionExpiryTimer); projectionExpiryTimer = null; }
    if (runId !== state.context?.runId) { selectedStep = ''; runId = state.context?.runId ?? null; }
    if (selectedStep && !(state.proposal?.steps || []).some(step => step.stepId === selectedStep)) selectedStep = '';
    const nowMs = Date.now();
    latest = buildAnalysis(state, {stepId: selectedStep || null, nowMs});
    const counts = latest.counts || {}, projection = latest.projection || {};
    const steps = state.proposal?.steps || [];
    const currentView = VIEWS.has(view) ? view : 'core';
    root.innerHTML = `<div class="analysis-header"><div><h1>指标与分析</h1><p>当前工作区 · ${safe(latest.context?.businessDate || state.context?.businessDate)} · 第${safe(state.revision)}版</p></div><div class="analysis-header-meta">${latest.context?.coreEnabled ? '10项规则与闸门已配置' : '历史运行：核心规则未启用'}<small>外部系统读取 0 · 基于工作区数据测算</small></div></div>`+
      `<div class="analysis-counts" aria-label="目录与实际计算数量">`+
      [['目录总数', counts.catalogTotal ?? 121], ['已配置规则', counts.configuredRules ?? 10], ['实际计算主体项', counts.calculatedSubjectChecks ?? 0], ['主体待补', counts.missingSubjectChecks ?? 0], ['规则待提供', counts.unprovidedRules ?? 111], ['历史指标目录', counts.historicalMetrics ?? 102], ['外部读取', counts.externalRead ?? 0]].map(([label, value]) => `<div><span>${label}</span><b>${safe(value)}</b></div>`).join('')+
      `</div><div class="analysis-toolbar"><div class="analysis-tabs" role="tablist" aria-label="分析视图">`+
      [['core','核心实时指标'],['historical','历史102指标'],['rules','规则目录与新增闸门']].map(([key,label]) => `<button type="button" id="analysis-tab-${key}" data-analysis-view="${key}" role="tab" aria-selected="${currentView === key}">${label}</button>`).join('')+
      `</div><div class="analysis-query"><label for="analysis-search">搜索</label><input id="analysis-search" type="search" value="${rawSafe(search)}" placeholder="名称、主体或编号" autocomplete="off"><label for="analysis-filter">筛选</label><select id="analysis-filter">`+
      [['all','全部'],['favorite','常用'],['abnormal','异常'],['missing','待补']].map(([key,label]) => `<option value="${key}" ${filter === key ? 'selected' : ''}>${label}</option>`).join('')+
      `</select></div></div>`+
      (currentView === 'core' ? `<div class="analysis-projection"><label for="analysis-step">单笔交易后预计值</label><select id="analysis-step"><option value="">仅当前值</option>${steps.map((step, index) => `<option value="${rawSafe(step.stepId)}" ${selectedStep === step.stepId ? 'selected' : ''}>第${index+1}步 · ${safe(displayLabel(state.plans?.find(p => p.planId === step.planId)?.label) || '交易步骤')}</option>`).join('')}</select><span class="analysis-projection-note ${projection.available ? 'analysis-projection-note--ready' : ''}">${safe(projection.available ? `${projection.label || '单笔独立测算，未计其他未发计划或前序条件'}；仍须最新审核与手动下达。` : projection.reason || '选择交易步骤后核对预计值。')}</span></div>` : '')+
      `<section class="analysis-panel" aria-labelledby="analysis-section-title"><div class="analysis-panel-head"><h2 id="analysis-section-title">${currentView === 'core' ? '核心规则 · 按适用主体逐项展开' : currentView === 'historical' ? '历史指标来源目录' : '规则目录与新增闸门'}</h2><span>${currentView === 'core' ? `10项配置规则与闸门 · ${safe(counts.applicableSubjectChecks ?? 0)}项适用主体判断 · 不适用${safe(counts.notapp ?? 0)}项` : currentView === 'historical' ? '102项仅作历史目录' : '10项已配置 / 111项待提供'}</span></div>`+
      (currentView === 'core' ? latest.context?.coreEnabled ? buildCoreRows() : '<div class="analysis-empty">该历史运行未启用当前核心规则，不能沿用当前模板的规则结果。</div>' : currentView === 'historical' ? buildHistoricalRows() : buildRuleRows())+
      `</section><p class="analysis-foot">当前值来自工作区账目；交易后预计值仅在选定步骤可可靠测算时显示。阈值色带按当前判断状态标示，不代表额外预警线。未知保持待补；不适用不计作通过。</p>`;
    const observedAt = state.execution?.snapshot?.observedAt;
    const expiryDelay = Number.isFinite(observedAt) ? observedAt + 30001 - nowMs : 0;
    if (selectedStep && projection.available && !root.hidden && expiryDelay > 0) {
      const scheduledStep = selectedStep, scheduledRunId = runId;
      projectionExpiryTimer = setTimeout(() => {
        projectionExpiryTimer = null;
        if (root.hidden || !root.isConnected || selectedStep !== scheduledStep) return;
        const current = model.getState();
        if (current.context?.runId !== scheduledRunId) return;
        renderScreen(current);
      }, expiryDelay);
    }
  }

  root.addEventListener('click', event => {
    const tab = event.target.closest('[data-analysis-view]');
    if (tab) { view = tab.dataset.analysisView; renderScreen(model.getState()); return; }
    const action = event.target.closest('[data-analysis-action]');
    if (action) {
      preferences = updateAnalysisPreference(preferences, action.dataset.key, action.dataset.analysisAction);
      if (!writePreferences(preferences)) notify('浏览器未能保存分析页常用项；本次会话仍可继续查看。');
      renderScreen(model.getState()); return;
    }
    const detailButton = event.target.closest('[data-analysis-detail]');
    if (detailButton) detail(detailButton.dataset.analysisDetail, Number(detailButton.dataset.index));
  });
  root.addEventListener('change', event => {
    if (event.target.id === 'analysis-filter') { filter = FILTERS.has(event.target.value) ? event.target.value : 'all'; renderScreen(model.getState()); }
    if (event.target.id === 'analysis-step') { selectedStep = event.target.value; renderScreen(model.getState()); }
  });
  root.addEventListener('input', event => {
    if (event.target.id !== 'analysis-search') return;
    const start = event.target.selectionStart, end = event.target.selectionEnd;
    search = event.target.value.trim().toLocaleLowerCase('zh-CN');
    renderScreen(model.getState());
    const input = $('analysis-search'); input.focus(); input.setSelectionRange(start, end);
  });
  return {render: renderScreen};
}

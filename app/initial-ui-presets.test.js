import assert from 'node:assert/strict';
import test from 'node:test';
import {setupInitialUI} from './initial-ui.js';
import {createModel} from './model.js';
import {createDefaultInitialTemplate,createBankOrderInitialTemplate,createAiFinancingInitialTemplate} from './default-scenario.js';
import {createOriginalInitialTemplate} from './original-scenario.js';

const TEMPLATE_KEY='zhihui-initial-template-v1',HISTORY_KEY='zhihui-run-history-v1';
function harness(t,{failKey=null,savedTemplate=null,savedRun=null}={}){
 const originalDocument=globalThis.document,handlers=[],nodes=new Map(),values=new Map();
 globalThis.document={addEventListener(type,fn){if(type==='click')handlers.push(fn);}};
 t.after(()=>{if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;});
 const model=createModel(savedRun??undefined);if(!savedRun){model.startFromTemplate();model.generateProposal('AUTO');}
 if(savedTemplate)values.set(TEMPLATE_KEY,JSON.stringify(savedTemplate));
 let failure=failKey;
 const writes=[],errors=[],staged=[],changes=[],screens=[];
 const storage={getItem:key=>values.get(key)??null,setItem(key,value){if(key===failure)throw new Error('storage full');writes.push(key);values.set(key,value);}};
 const $=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:''});return nodes.get(id);};
 let ui;
 const render=()=>ui.renderPage(model.getState());
 ui=setupInitialUI({model,$,storage,esc:v=>String(v??''),amount:v=>String(v),decimalYuan:String,
  ratioPercent:String,parseMoney:Number,parseAnnualRate:String,openDialog(){},closeDialog(){},
  formFooter:()=>'',formError:error=>errors.push(error.message),notify(){},render,
  changed:message=>{changes.push({message,run:JSON.parse(model.serialize()),template:ui.template()});render();},
  onTemplateChange:value=>staged.push(value),setScreen:screen=>screens.push(screen)});
 const click=(selector,dataset)=>handlers.forEach(fn=>fn({target:{closest:query=>query===selector?{dataset}:null}}));
 return {model,ui,values,writes,errors,staged,changes,screens,render,$,
  clickPreset:key=>click('[data-initial]',{initial:key}),restore:id=>click('[data-restore-run]',{restoreRun:id}),
  stopFailing:()=>{failure=null;}};
}

test('preset-sale and original buttons create independent six- and nine-plan runs and preserve each previous run once',t=>{
 const h=harness(t);h.model.setPreferences(['liquidity_last']);const before=h.model.serialize();
 h.render();assert.match(h.$('initial-screen').innerHTML,/三项银行约束（预设卖券）/);
 assert.match(h.$('initial-screen').innerHTML,/原始样例（零现金／成农商6%）/);
 h.clickPreset('original-sample');
 assert.deepEqual(h.errors,[]);
 assert.equal(h.model.getState().initialData.templateId,createOriginalInitialTemplate().templateId);
 assert.equal(h.model.getState().initialData.portfolio.accountCashYuan,0);
 assert.equal(h.model.getState().plans.length,9);
 assert.notEqual(h.model.getState().context.runId,JSON.parse(before).context.runId);
 assert.equal(JSON.parse(h.values.get(HISTORY_KEY))[0].state,before);
 assert.deepEqual(JSON.parse(h.values.get(TEMPLATE_KEY)),h.ui.template());
 assert.match(h.$('initial-screen').innerHTML,/当前模板选择：原始样例（零现金／成农商6%）/);
 const originalRun=h.model.serialize();h.clickPreset('sample');
 assert.equal(h.model.getState().initialData.templateId,createBankOrderInitialTemplate().templateId);
 assert.equal(h.model.getState().plans.length,6);
 assert.equal(h.model.getState().plans.filter(plan=>plan.businessType==='cd_sell').length,1);
 assert.equal(h.model.getState().initialData.portfolio.accountCashYuan,500000000);
 const history=JSON.parse(h.values.get(HISTORY_KEY));assert.equal(history.length,2);
 assert.equal(history[0].state,originalRun);assert.equal(history[1].state,before);
 assert.equal(h.writes.filter(key=>key===HISTORY_KEY).length,2);
 assert.equal(h.staged.length,2);assert.equal(h.changes.length,2);assert.deepEqual(h.screens,['desk','desk']);
 for(let i=0;i<2;i++)assert.deepEqual(h.changes[i].run.initialData,h.staged[i]);
 assert.deepEqual(JSON.parse(h.values.get(`${TEMPLATE_KEY}-before-single-day`)),h.staged[0]);
});

test('remediation preset omits the planned CD sale while retaining sellable GZ inventory and prior run history',t=>{
 const h=harness(t),defaultTemplate=createDefaultInitialTemplate(),originalTemplate=createOriginalInitialTemplate();
 const originalRun=h.model.serialize();
 h.render();assert.match(h.$('initial-screen').innerHTML,/AI融资案例（默认，未预设融资及卖券）/);
 h.clickPreset('remediation-sample');
 assert.deepEqual(h.errors,[]);
 const state=h.model.getState(),template=createAiFinancingInitialTemplate();
 assert.equal(state.initialData.templateId,template.templateId);
 assert.equal(state.initialData.revision,1);
 assert.match(state.initialData.provenance.note,/未预设融资及卖券/);
 assert.equal(state.initialData.draftPlans.length,4);
 assert.equal(state.initialData.draftPlans.some(plan=>plan.businessType==='cd_sell'),false);
 assert.equal(state.plans.length,4);
 assert.equal(state.plans.some(plan=>plan.businessType==='cd_sell'),false);
 const gzCd=state.initialData.holdings.find(holding=>holding.securityId==='SIM-GZ-CD-OLD');
 assert.ok(gzCd);assert.ok(gzCd.sellableYuan>0);
 assert.deepEqual(createDefaultInitialTemplate(),defaultTemplate);
 assert.deepEqual(createOriginalInitialTemplate(),originalTemplate);
 assert.equal(JSON.parse(h.values.get(HISTORY_KEY))[0].state,originalRun);
 assert.equal(JSON.parse(h.values.get(TEMPLATE_KEY)).templateId,template.templateId);
 assert.equal(h.staged.length,1);assert.deepEqual(h.changes[0].run.initialData,h.staged[0]);
});

test('first use, storage reload and reset select the four-plan financing default without overwriting storage or the run',t=>{
 const h=harness(t),before=h.model.serialize();
 const check=()=>{
  assert.equal(h.ui.template().templateId,createAiFinancingInitialTemplate().templateId);
  assert.equal(h.ui.template().draftPlans.length,4);
  assert.equal(h.ui.template().draftPlans.some(plan=>plan.businessType==='cd_sell'),false);
 };
 check();h.render();
 const html=h.$('initial-screen').innerHTML;
 assert.match(html,/当前模板选择：AI融资案例（默认，未预设融资及卖券）/);
 assert.ok(html.indexOf('data-initial="remediation-sample"')<html.indexOf('data-initial="sample"'));
 assert.ok(html.indexOf('data-initial="sample"')<html.indexOf('data-initial="original-sample"'));
 h.ui.replaceTemplate(createBankOrderInitialTemplate());h.ui.reloadStorage();check();
 h.ui.replaceTemplate(createOriginalInitialTemplate());h.ui.resetStorage();check();
 assert.equal(h.model.serialize(),before);assert.deepEqual(h.writes,[]);
 h.clickPreset('begin');
 const state=h.model.getState();
 assert.equal(state.initialData.templateId,createAiFinancingInitialTemplate().templateId);
 assert.equal(state.plans.length,4);assert.equal(state.plans.some(plan=>plan.businessType==='cd_sell'),false);
 assert.ok(state.initialData.holdings.find(holding=>holding.securityId==='SIM-GZ-CD-OLD').sellableYuan>=200000000);
 assert.equal(JSON.parse(h.values.get(HISTORY_KEY))[0].state,before);
});

test('saved six-plan templates and runs remain authoritative on initialization and storage reload',t=>{
 const oldTemplate=createBankOrderInitialTemplate({businessDate:'2026-10-19'});
 oldTemplate.label='已保存的六笔模板';oldTemplate.revision=7;
 const oldModel=createModel();oldModel.startFromTemplate(oldTemplate);oldModel.generateProposal('AUTO');
 const savedRun=createModel(oldModel.serialize()).serialize(),h=harness(t,{savedTemplate:oldTemplate,savedRun});
 assert.deepEqual(h.ui.template(),oldTemplate);assert.equal(h.model.serialize(),savedRun);
 h.ui.reloadStorage();h.render();
 assert.deepEqual(h.ui.template(),oldTemplate);assert.equal(h.model.serialize(),savedRun);
 assert.equal(h.values.get(TEMPLATE_KEY),JSON.stringify(oldTemplate));assert.deepEqual(h.writes,[]);
 assert.match(h.$('initial-screen').innerHTML,/当前模板选择：三项银行约束（预设卖券）/);
 h.clickPreset('begin');assert.equal(h.model.getState().plans.length,6);
 assert.deepEqual(h.model.getState().initialData,oldTemplate);
 assert.equal(JSON.parse(h.values.get(HISTORY_KEY))[0].state,savedRun);
});

test('editing or replacing the template remains separate until manual new-run, and history restores the previous run',t=>{
 const h=harness(t),before=h.model.serialize(),old=JSON.parse(before);
 const edited=h.ui.template();edited.label='本地修改的起点';edited.revision++;
 h.ui.replaceTemplate(edited);assert.equal(h.model.serialize(),before);
 h.clickPreset('begin');assert.equal(h.model.getState().initialData.label,'本地修改的起点');
 assert.equal(h.staged.length,0);assert.equal(JSON.parse(h.values.get(HISTORY_KEY)).length,1);
 const saved=JSON.parse(h.values.get(HISTORY_KEY))[0];h.restore(saved.id);
 assert.deepEqual(h.errors,[]);assert.equal(h.model.getState().context.runId,old.context.runId);
 assert.deepEqual(h.model.getState().initialData,old.initialData);
 assert.deepEqual(h.model.getState().plans,old.plans);
 assert.equal(JSON.parse(h.values.get(HISTORY_KEY)).length,2);
});

for(const failKey of [HISTORY_KEY,`${TEMPLATE_KEY}-before-single-day`,TEMPLATE_KEY]){
 test(`failed ${failKey} storage does not replace the run or stage a template; retry preserves one backup`,t=>{
  const h=harness(t,{failKey,savedTemplate:createDefaultInitialTemplate()}),before=h.model.serialize(),template=h.ui.template();
  h.clickPreset('original-sample');
  assert.deepEqual(h.errors,['storage full']);assert.equal(h.model.serialize(),before);
  assert.deepEqual(h.ui.template(),template);assert.equal(h.staged.length,0);assert.equal(h.changes.length,0);
  h.stopFailing();h.clickPreset('original-sample');
  const history=JSON.parse(h.values.get(HISTORY_KEY));assert.equal(history.length,1);assert.equal(history[0].state,before);
  assert.equal(h.model.getState().initialData.portfolio.accountCashYuan,0);
  assert.equal(h.staged.length,1);assert.equal(h.changes.length,1);
 });
}

test('reset-current action replaces a customized template and old run with the canonical no-sale case and stages both',t=>{
 const old=createBankOrderInitialTemplate();old.label='自定义旧起点';old.draftPlans[0].targetYuan=300000000;
 const h=harness(t,{savedTemplate:old});h.model.startFromTemplate(old);h.model.generateProposal('AUTO');
 const before=h.model.serialize();h.ui.resetToDefault();
 const state=h.model.getState(),expected=createDefaultInitialTemplate();
 assert.deepEqual(state.initialData,expected);assert.deepEqual(h.ui.template(),expected);
 assert.equal(state.plans.length,4);assert.ok(state.plans.every(p=>p.businessType!=='cd_sell'));
 assert.equal(Object.keys(state.execution.instructions).length,0);assert.equal(Object.keys(state.execution.fills).length,0);
 assert.notEqual(state.context.runId,JSON.parse(before).context.runId);
 assert.equal(JSON.parse(h.values.get(HISTORY_KEY))[0].state,before);
 assert.deepEqual(JSON.parse(h.values.get(`${TEMPLATE_KEY}-before-single-day`)),old);
 assert.deepEqual(JSON.parse(h.values.get(TEMPLATE_KEY)),expected);
 assert.equal(h.staged.length,1);assert.deepEqual(h.staged[0],expected);
 assert.equal(h.changes.length,1);assert.deepEqual(h.changes[0].run.initialData,expected);
});

for(const failKey of [HISTORY_KEY,`${TEMPLATE_KEY}-before-single-day`,TEMPLATE_KEY]){
 test(`reset-current aborts before changing run or staging cloud state if ${failKey} backup/save fails`,t=>{
  const h=harness(t,{failKey,savedTemplate:createBankOrderInitialTemplate()}),before=h.model.serialize(),template=h.ui.template();
  assert.throws(()=>h.ui.resetToDefault(),/storage full/);
  assert.equal(h.model.serialize(),before);assert.deepEqual(h.ui.template(),template);
  assert.equal(h.staged.length,0);assert.equal(h.changes.length,0);
  h.stopFailing();h.ui.resetToDefault();assert.equal(JSON.parse(h.values.get(HISTORY_KEY)).length,1);
  assert.equal(h.model.getState().plans.length,4);
 });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {setupInitialUI} from './initial-ui.js';
import {createModel} from './model.js';
import {createDefaultInitialTemplate} from './default-scenario.js';
import {createOriginalInitialTemplate} from './original-scenario.js';

const TEMPLATE_KEY='zhihui-initial-template-v1',HISTORY_KEY='zhihui-run-history-v1';
function harness(t,{failKey=null,savedTemplate=null}={}){
 const originalDocument=globalThis.document,handlers=[],nodes=new Map(),values=new Map();
 globalThis.document={addEventListener(type,fn){if(type==='click')handlers.push(fn);}};
 t.after(()=>{if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;});
 const model=createModel();model.startFromTemplate(createDefaultInitialTemplate());model.generateProposal('AUTO');
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

test('both built-in buttons immediately create independent runs, save templates and preserve each previous run once',t=>{
 const h=harness(t);h.model.setPreferences(['liquidity_last']);const before=h.model.serialize();
 h.render();assert.match(h.$('initial-screen').innerHTML,/三项银行约束（默认）/);
 assert.match(h.$('initial-screen').innerHTML,/原始样例（零现金／成农商6%）/);
 h.clickPreset('original-sample');
 assert.deepEqual(h.errors,[]);
 assert.equal(h.model.getState().initialData.templateId,createOriginalInitialTemplate().templateId);
 assert.equal(h.model.getState().initialData.portfolio.accountCashYuan,0);
 assert.notEqual(h.model.getState().context.runId,JSON.parse(before).context.runId);
 assert.equal(JSON.parse(h.values.get(HISTORY_KEY))[0].state,before);
 assert.deepEqual(JSON.parse(h.values.get(TEMPLATE_KEY)),h.ui.template());
 assert.match(h.$('initial-screen').innerHTML,/当前模板选择：原始样例（零现金／成农商6%）/);
 const originalRun=h.model.serialize();h.clickPreset('sample');
 assert.equal(h.model.getState().initialData.templateId,createDefaultInitialTemplate().templateId);
 assert.equal(h.model.getState().initialData.portfolio.accountCashYuan,500000000);
 const history=JSON.parse(h.values.get(HISTORY_KEY));assert.equal(history.length,2);
 assert.equal(history[0].state,originalRun);assert.equal(history[1].state,before);
 assert.equal(h.writes.filter(key=>key===HISTORY_KEY).length,2);
 assert.equal(h.staged.length,2);assert.equal(h.changes.length,2);assert.deepEqual(h.screens,['desk','desk']);
 for(let i=0;i<2;i++)assert.deepEqual(h.changes[i].run.initialData,h.staged[i]);
 assert.deepEqual(JSON.parse(h.values.get(`${TEMPLATE_KEY}-before-single-day`)),h.staged[0]);
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

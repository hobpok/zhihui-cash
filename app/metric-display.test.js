import test from 'node:test';
import assert from 'node:assert/strict';
import {metricPresentation,completionPercent} from './metric-display.js';
test('percentage warning uses one percentage point and exact unrounded boundaries',()=>{
  const r=n=>({currentValue:n/100000, numeratorYuan:n,denominatorYuan:100000,threshold:{operator:'≤',numerator:5,denominator:100},result:'pass'});
  assert.equal(metricPresentation(r(3999)).tone,'normal');
  assert.equal(metricPresentation(r(4000)).tone,'near');
  assert.equal(metricPresentation(r(5000)).tone,'near');
  assert.equal(metricPresentation(r(5001)).tone,'over');
  assert.equal(metricPresentation(r(4000)).limitYuan,'5000');
  const min=n=>({...r(n),threshold:{operator:'≥',numerator:5,denominator:100}});
  assert.equal(metricPresentation(min(4999)).tone,'over');
  assert.equal(metricPresentation(min(5000)).tone,'near');
  assert.equal(metricPresentation(min(6000)).tone,'near');
  assert.equal(metricPresentation(min(6001)).tone,'normal');
});
test('bank-specific denominators, unknowns and completion are retained',()=>{
  assert.equal(metricPresentation({currentValue:.08,numeratorYuan:80,denominatorYuan:1000,threshold:{operator:'≤',numerator:10,denominator:100},result:'pass'}).limitYuan,'100');
  assert.equal(metricPresentation({currentValue:null,result:'missing'}).tone,'missing');
  assert.equal(metricPresentation({currentValue:90,threshold:{operator:'≤',valueDays:90},result:'pass'}).tone,'normal');
  assert.equal(metricPresentation({currentValue:90.0001,threshold:{operator:'≤',valueDays:90},result:'block'}).tone,'over');
  assert.equal(completionPercent(300000000,1000000000),30);
  assert.equal(completionPercent(0,0),null);
});

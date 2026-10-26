import test from 'node:test';
import assert from 'node:assert/strict';
import {createDefaultInitialTemplate} from './default-scenario.js';
import {createOriginalInitialTemplate} from './original-scenario.js';
import {displayLabel, displayText, displayTermsNote, preserveLabel, preserveTermsNote} from './display-labels.js';

test('旧模板显示名称与备注兼容，展示及未改名保存保持原数据', () => {
  for (const template of [createDefaultInitialTemplate(), createOriginalInitialTemplate()]) {
    const original = JSON.stringify(template);
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.label === 'string') {
        assert.doesNotMatch(displayLabel(value.label), /模拟|演示|合成/);
        assert.equal(preserveLabel(displayLabel(value.label), value.label), value.label);
      }
      if (typeof value.termsNote === 'string') {
        assert.doesNotMatch(displayTermsNote(value.termsNote), /模拟|演示|合成/);
        assert.equal(preserveTermsNote(displayTermsNote(value.termsNote), value.termsNote), value.termsNote);
      }
      Object.values(value).forEach(visit);
    };
    visit(template);
    assert.equal(JSON.stringify(template), original);
  }
  assert.equal(displayLabel('自定义模拟成都农商银行存款'), '自定义成都农商银行存款');
  assert.equal(preserveLabel('新名称', '模拟旧名称'), '新名称');
});

test('历史受限提示去除基金括号，测算前提与数字原样保留', () => {
  assert.equal(displayText('业务头寸非负（模拟500亿货币基金）'), '业务头寸非负');
  assert.equal(displayText('业务头寸非负(500亿货币基金)'), '业务头寸非负');
  const condition = '测算以全部成交和收付完成为前提；49亿融资未到账。';
  assert.equal(displayText(condition), condition);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from './api.js';
import { createAiService } from './ai-service.js';
import { createStore } from './storage.js';
import { seed, sqliteD1 } from './test-support/sqlite-d1.js';
import { createModel } from '../app/model.js';
import { createAiConversation } from '../app/ai-conversation.js';

test('a transient final usage read failure recovers the completed original ID without another generation', async () => {
  const { sqlite, db } = sqliteD1();
  const origin = 'https://workspace.local.test';
  let invocationCount = 0, failUsageOnce = false, failedUsageReads = 0, issuedIds = 0;
  const network = [];
  const observations = [];
  try {
    seed(sqlite, 'u1', 'synthetic@example.test');
    sqlite.prepare('INSERT INTO auth_credentials(member_id,username,salt,password_hash,iterations) VALUES(?,?,?,?,?)')
      .run('u1', 'u1', 'synthetic-salt', 'synthetic-hash', 100000);
    const model = createModel(); model.startFromTemplate();
    await createStore(db).putDocument('u1', 'run', 'current', {
      expectedRevision: 0, mutationId: 'stream-recovery-seed-01', value: JSON.parse(model.serialize()),
    });
    // Fail only the usage query after the real service has durably finalized the
    // first request. The stream reports 503, while GET can still find completed.
    const wrappedDb = new Proxy(db, {
      get(target, key) {
        if (key !== 'prepare') {
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return sql => {
          const statement = target.prepare(sql);
          if (!sql.startsWith('SELECT COUNT(*) AS used FROM ai_requests')) return statement;
          const wrap = current => new Proxy(current, {
            get(item, property) {
              if (property === 'bind') return (...args) => wrap(item.bind(...args));
              if (property === 'first') return (...args) => {
                if (failUsageOnce) {
                  failUsageOnce = false; failedUsageReads++;
                  assert.equal(sqlite.prepare('SELECT status FROM ai_requests WHERE request_id=?')
                    .get('stream-recovery-0001').status, 'completed');
                  throw new Error('SYNTHETIC_TRANSIENT_D1_FAILURE');
                }
                return item.first(...args);
              };
              const value = Reflect.get(item, property, item);
              return typeof value === 'function' ? value.bind(item) : value;
            },
          });
          return wrap(statement);
        };
      },
    });
    const reply = {
      text: '核算完成。', simulated: false, usage: { inputTokens: 9, outputTokens: 6 },
      dialogue: { status: 'answer', answer: '核算完成。', references: [], evidence: [] },
    };
    const env = { DB: wrappedDb, APP_ORIGIN: origin, AI_KEY_TEST: 'synthetic-test-only',
      AI_ACCOUNT_CONFIG_JSON: JSON.stringify({ u1: { mode: 'real', provider: 'deepseek',
        model: 'deepseek-flash', keyBinding: 'AI_KEY_TEST', dailyLimit: 30, timeoutMs: 1000 } }) };
    const service = createAiService({ dialogueInvoke: async ({ onProgress }) => {
      invocationCount++;
      onProgress({ type: 'preview', text: '尚未核验的临时正文', round: 0 });
      failUsageOnce = true;
      return reply;
    } });
    const api = createApi({ ai: service, authenticate: async () => ({ memberId: 'u1' }),
      observabilityFactory: () => null });
    const conversation = createAiConversation({
      makeId: () => `stream-recovery-${String(++issuedIds).padStart(4, '0')}`,
      onChange: snapshot => observations.push(snapshot),
      fetchImpl: async (path, init) => {
        network.push({ path, method: init.method, accept: init.headers.Accept,
          body: init.body ? JSON.parse(init.body) : null });
        return api(new Request(origin + path, { ...init, headers: { ...init.headers, Origin: origin } }), env);
      },
    });
    conversation.setContext({ userId: 'u1', runDocumentId: 'current', documentRevision: 1,
      localVersion: 'synthetic-stream-recovery-v1', synced: true });
    await conversation.send('查看当前头寸');

    assert.equal(failedUsageReads, 1);
    assert.equal(invocationCount, 1);
    assert.equal(issuedIds, 1);
    assert.deepEqual(network.map(({ method, path }) => [method, path]), [
      ['POST', '/api/ai/dialogue'],
      ['GET', '/api/ai/requests/stream-recovery-0001'],
      ['POST', '/api/ai/dialogue'],
    ]);
    assert.deepEqual(network[2].body, network[0].body);
    assert.equal(network[0].accept, 'text/event-stream');
    assert.equal(network[2].accept, undefined);
    assert.equal(conversation.snapshot().phase, 'completed');
    assert.equal(conversation.snapshot().recoverable, false);
    assert.equal(conversation.snapshot().previewText, '');
    assert.deepEqual(conversation.snapshot().result, reply.dialogue);
    assert.ok(observations.some(snapshot => snapshot.recovering && snapshot.previewText === '' && snapshot.result === null));
    assert.equal((await service.status(db, env, 'u1')).usage.used, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM ai_requests').get().count, 1);
    const stored = sqlite.prepare('SELECT status,result_json,input_tokens,output_tokens FROM ai_requests').get();
    assert.equal(stored.status, 'completed');
    assert.equal(stored.input_tokens, 9); assert.equal(stored.output_tokens, 6);
    assert.ok(!stored.result_json.includes('尚未核验的临时正文'));
    assert.ok(!JSON.stringify(conversation.snapshot()).includes('SYNTHETIC_TRANSIENT_D1_FAILURE'));
  } finally { sqlite.close(); }
});

// Inspect staged Git blobs, not private local folders. Never print matched values.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const secrets = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['provider-key', /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{24,}\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/],
  ['credential-url', /https?:\/\/[^\s/:@]+:[^\s/@]{8,}@/],
  ['telegram-token', /\b\d{8,12}:[A-Za-z0-9_-]{32,}\b/],
];

export function inspectText(path, text) {
  const findings = [];
  for (const [rule, expression] of secrets) {
    const match = expression.exec(text);
    if (match) findings.push({ path, rule, line: text.slice(0, match.index).split('\n').length });
  }
  return findings;
}

export function auditIndex(cwd = process.cwd()) {
  const git = args => execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  const entries = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, sha, stage] = entry.slice(0, tab).split(' ');
    return { mode, sha, stage, path: entry.slice(tab + 1) };
  });
  if (!entries.length) throw new Error('No staged/tracked files to audit');
  const findings = [];
  let bytes = 0;
  // check-ignore normally omits tracked files; --no-index also checks forced adds.
  let ignored = [];
  try {
    ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
      cwd, input: entries.map(entry => entry.path).join('\0') + '\0', encoding: 'utf8',
    }).split('\0').filter(Boolean);
  } catch (error) {
    if (error.status !== 1) throw new Error('Could not verify ignore policy');
  }
  for (const path of ignored) findings.push({ path, rule: 'excluded-by-sharing-policy' });
  for (const entry of entries) {
    if (entry.stage !== '0' || !['100644', '100755'].includes(entry.mode)) {
      findings.push({ path: entry.path, rule: 'unmerged-or-nonregular-file' }); continue;
    }
    const content = git(['cat-file', 'blob', entry.sha]);
    bytes += content.length;
    if (content.length > 5 * 1024 * 1024) findings.push({ path: entry.path, rule: 'oversized-file-review-required' });
    if (/\.(?:webp|png)$/.test(entry.path)) {
      if (!entry.path.startsWith('tutorial/images/')) findings.push({ path: entry.path, rule: 'unreviewed-image' });
      continue;
    }
    if (content.includes(0)) { findings.push({ path: entry.path, rule: 'unexpected-binary' }); continue; }
    if (/\.sql$/i.test(entry.path) && !/^migrations\/\d+_[^/]+\.sql$/.test(entry.path))
      findings.push({ path: entry.path, rule: 'non-migration-sql' });
    findings.push(...inspectText(entry.path, content.toString('utf8')));
  }
  return { files: entries.length, bytes, findings,
    scope: 'Git index only; path policy and common credential patterns. Manual review remains necessary for business data and unknown secret formats.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditIndex();
  console.log(JSON.stringify(result, null, 2));
  if (result.findings.length) process.exitCode = 1;
}

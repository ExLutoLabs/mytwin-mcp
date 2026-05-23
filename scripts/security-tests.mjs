// Session-1 + ctx-refactor security tests.
// Run with: node scripts/security-tests.mjs
// Standalone — does NOT need DB credentials. Tests validation paths that
// throw UserError before reaching Supabase/Pinecone/OpenAI.

import { addKnowledge, addFromUrl, addDocument, addVoiceNote } from '../tools/storage.js';

const ctx = { userId: 'test' };

let pass = 0, fail = 0;

function ok(name)          { console.log(`  ✓ ${name}`); pass++; }
function bad(name, why)    { console.log(`  ✗ ${name} — ${why}`); fail++; }

async function expectUserError(name, fn, mustMatch) {
  try {
    await fn();
    bad(name, 'expected UserError, got success');
  } catch (err) {
    if (!err.userFacing) return bad(name, `expected userFacing error, got: ${err.message}`);
    if (mustMatch && !mustMatch.test(err.message)) return bad(name, `message didn't match — got: "${err.message}"`);
    ok(name);
  }
}

console.log('\n── ITEM 12: SSRF protection on add_from_url ──');

await expectUserError('rejects http:// scheme',
  () => addFromUrl(ctx, { url: 'http://example.com' }),
  /only https/i);

await expectUserError('rejects file:// scheme',
  () => addFromUrl(ctx, { url: 'file:///etc/passwd' }),
  /only https/i);

await expectUserError('rejects ftp:// scheme',
  () => addFromUrl(ctx, { url: 'ftp://example.com' }),
  /only https/i);

await expectUserError('rejects malformed URL',
  () => addFromUrl(ctx, { url: 'not a url at all' }),
  /not valid|valid/i);

await expectUserError('blocks https://localhost',
  () => addFromUrl(ctx, { url: 'https://localhost/' }),
  /blocked host|private|reserved/i);

await expectUserError('blocks https://127.0.0.1 (loopback)',
  () => addFromUrl(ctx, { url: 'https://127.0.0.1/' }),
  /private|reserved|blocked/i);

await expectUserError('blocks https://169.254.169.254 (AWS/GCP metadata)',
  () => addFromUrl(ctx, { url: 'https://169.254.169.254/latest/meta-data/' }),
  /private|reserved|blocked/i);

await expectUserError('blocks https://10.0.0.1 (RFC1918)',
  () => addFromUrl(ctx, { url: 'https://10.0.0.1/' }),
  /private|reserved|blocked/i);

await expectUserError('blocks https://192.168.1.1 (RFC1918)',
  () => addFromUrl(ctx, { url: 'https://192.168.1.1/' }),
  /private|reserved|blocked/i);

await expectUserError('blocks https://172.16.0.1 (RFC1918)',
  () => addFromUrl(ctx, { url: 'https://172.16.0.1/' }),
  /private|reserved|blocked/i);

await expectUserError('blocks https://[::1] (IPv6 loopback)',
  () => addFromUrl(ctx, { url: 'https://[::1]/' }),
  /private|reserved|blocked/i);

await expectUserError('blocks DNS rebinding via hostname → 127.0.0.1',
  // localtest.me resolves to 127.0.0.1 — common DNS rebinding helper
  () => addFromUrl(ctx, { url: 'https://localtest.me/' }),
  /private|reserved|blocked|resolve/i);


console.log('\n── ITEM 11: Input size limits ──');

const sixtyK = 'x'.repeat(60_000);
const sixHundredK = 'x'.repeat(600_000);
const longTitle = 't'.repeat(600);

await expectUserError('add_knowledge rejects content > 50,000 chars',
  () => addKnowledge(ctx, { type: 'note', content: sixtyK }),
  /exceeds.*limit|character/i);

await expectUserError('add_knowledge rejects title > 500 chars',
  () => addKnowledge(ctx, { type: 'note', content: 'small', title: longTitle }),
  /exceeds.*limit|character/i);

await expectUserError('add_knowledge rejects empty content',
  () => addKnowledge(ctx, { type: 'note', content: '' }),
  /required/i);

await expectUserError('add_voice_note rejects transcript > 50,000 chars',
  () => addVoiceNote(ctx, { transcript: sixtyK }),
  /exceeds.*limit|character/i);

await expectUserError('add_voice_note rejects empty transcript',
  () => addVoiceNote(ctx, { transcript: '' }),
  /required/i);

await expectUserError('add_document rejects content > 500,000 chars',
  () => addDocument(ctx, { filename: 'big.txt', content: sixHundredK }),
  /exceeds.*limit|character/i);

await expectUserError('add_document rejects empty content',
  () => addDocument(ctx, { filename: 'x.txt', content: '' }),
  /required/i);


console.log('\n── Session 2 step 2: tenant fail-closed ──');

import { createServer } from '../lib/create-server.js';

function expectThrow(name, fn, mustMatch) {
  try {
    fn();
    bad(name, 'expected throw, got success');
  } catch (err) {
    if (mustMatch && !mustMatch.test(err.message)) return bad(name, `message didn't match — got: "${err.message}"`);
    ok(name);
  }
}

expectThrow('createServer rejects ctx with no userId',
  () => createServer({ tenantId: 't1' }),
  /userId.*tenantId|tenantId.*userId/i);

expectThrow('createServer rejects ctx with no tenantId',
  () => createServer({ userId: 'u1' }),
  /userId.*tenantId|tenantId.*userId/i);

expectThrow('createServer rejects empty ctx',
  () => createServer({}),
  /userId.*tenantId|tenantId.*userId/i);

expectThrow('createServer rejects null ctx',
  () => createServer(null),
  /userId.*tenantId|tenantId.*userId/i);


console.log('\n── ctx-refactor smoke: signature shape ──');

// Confirm every tool function exposes the new (ctx, input) signature shape.
// We call each with empty input and confirm we don't get a TypeError from
// destructuring (which would mean the signature is wrong). Tool functions
// are async, so we await + .catch() to handle both sync and async errors.
async function sig(name, fn, badInput) {
  try {
    await fn(ctx, badInput);
    ok(`${name} accepts (ctx, input)`);
  } catch (err) {
    if (/Cannot destructure|Cannot read prop|is not a function/i.test(err?.message || '')) {
      bad(`${name} accepts (ctx, input)`, `signature broken — ${err.message}`);
    } else {
      // Any other error (UserError "Content is required", network, etc.) just
      // proves the function got past arg-binding — signature is fine.
      ok(`${name} accepts (ctx, input)`);
    }
  }
}
// We pass an empty input — tools that need fields will reject with a UserError
// or sbError, NOT a TypeError. That's the signature contract we want to verify.
await sig('addKnowledge',  addKnowledge,  {});
await sig('addFromUrl',    addFromUrl,    {});
await sig('addDocument',   addDocument,   {});
await sig('addVoiceNote',  addVoiceNote,  {});


console.log('\n── Pinecone cold-start retry behaviour ──');

const { isTransientError, wrapWithRetry } = await import('../lib/pinecone.js');

// 1) Classification — transient vs permanent
const transientCases = [
  { msg: 'ECONNRESET while connecting',   want: true },
  { msg: 'ETIMEDOUT after 30s',           want: true },
  { msg: 'fetch failed',                  want: true },
  { msg: 'socket hang up',                want: true },
  { msg: 'HTTP 503 Service Unavailable',  want: true },
  { msg: 'HTTP 504 Gateway Timeout',      want: true },
  { msg: 'getaddrinfo EAI_AGAIN',         want: true },
  { msg: 'Unauthorized (401)',            want: false },
  { msg: 'Not found',                     want: false },
  { msg: 'invalid api key',               want: false },
  { msg: 'BadRequest 400',                want: false },
];
for (const c of transientCases) {
  const got = isTransientError(new Error(c.msg));
  if (got === c.want) ok(`isTransientError "${c.msg}" → ${c.want}`);
  else                bad(`isTransientError "${c.msg}" → ${c.want}`, `got ${got}`);
}

// 2) wrapWithRetry — retries once on transient, not on permanent
function makeMock(behaviorQueue) {
  const calls = { query: 0 };
  const target = {
    async query() {
      calls.query++;
      const next = behaviorQueue.shift();
      if (next === 'transient') throw new Error('ECONNRESET while connecting');
      if (next === 'permanent') throw new Error('401 Unauthorized');
      return { ok: true, attempt: calls.query };
    },
  };
  return { wrapped: wrapWithRetry(target, 'mock'), calls };
}

// Case A: transient then success → 2 calls, returns success
{
  const { wrapped, calls } = makeMock(['transient', 'ok']);
  const result = await wrapped.query();
  if (calls.query === 2 && result.ok && result.attempt === 2)
    ok('retry-once recovers from a transient first failure');
  else
    bad('retry-once recovers from a transient first failure', `calls=${calls.query}, result=${JSON.stringify(result)}`);
}

// Case B: transient then transient → 2 calls, second propagates (no infinite retry)
{
  const { wrapped, calls } = makeMock(['transient', 'transient']);
  try {
    await wrapped.query();
    bad('retry-once does not retry forever', 'expected throw');
  } catch (err) {
    if (calls.query === 2 && /ECONNRESET/.test(err.message)) ok('retry-once does not retry forever');
    else bad('retry-once does not retry forever', `calls=${calls.query}, msg=${err.message}`);
  }
}

// Case C: permanent error on first attempt → 1 call, no retry
{
  const { wrapped, calls } = makeMock(['permanent']);
  try {
    await wrapped.query();
    bad('permanent errors do not retry', 'expected throw');
  } catch (err) {
    if (calls.query === 1 && /401/.test(err.message)) ok('permanent errors do not retry');
    else bad('permanent errors do not retry', `calls=${calls.query}, msg=${err.message}`);
  }
}

// Case D: clean success on first attempt → 1 call, no retry
{
  const { wrapped, calls } = makeMock(['ok']);
  const result = await wrapped.query();
  if (calls.query === 1 && result.ok) ok('successful calls do not retry');
  else bad('successful calls do not retry', `calls=${calls.query}`);
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

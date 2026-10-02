// 서버 함수(proxy.js) 단위 테스트: Supabase와 Cloudflare를 흉내 낸 가짜(mock)로 돌린다. Run: node --test tests/proxy.test.js
// 주의: 여기의 '권한 없음' 결과는 가짜 DB가 흉내 낸 것이라 실제 RLS·MFA·동시성을 증명하지 않는다.
//   실제 PostgreSQL에서 확인하는 테스트는 tests/db/run.sh, 운영 DB 상태는 sql/check_security.sql로 확인한다.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const COURSE_ID = '11111111-1111-4111-8111-111111111111';
const FULL_ID = '22222222-2222-4222-8222-222222222222';

let db;
let outboundCalls;
let viewExists;

function resetDb() {
  db = {
    courses: [
      { id: COURSE_ID, title: '세무회계 실무', capacity: 2, deadline: null, payment_info: '무료|||' },
      { id: FULL_ID, title: '인사노무 실무', capacity: 1, deadline: null, payment_info: '' }
    ],
    education_apply: [
      { id: 'a-full', course_id: FULL_ID, req_id: 'x', name: '기존', company: 'A', email: 'a@a', phone: '010', agree_privacy: true, sync_status: 'success' }
    ],
    admin_access_log: []
  };
  outboundCalls = [];
  outboundBodies = [];
  lookupCount = {};
  lastRpcClientKey = null;
  lastLookupClientKey = null;
  viewExists = true;
}

// ---- Supabase fake -------------------------------------------------------
// JWT 형태의 가짜 토큰. who=admin/user, aal=aal1(비밀번호만)/aal2(OTP까지)
function fakeJwt(payload) {
  return 'h.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.s';
}
function claimsOf(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch (e) { return {}; }
}
const ADMIN_TOKEN = fakeJwt({ who: 'admin', aal: 'aal2' });
const ADMIN_AAL1_TOKEN = fakeJwt({ who: 'admin', aal: 'aal1' });
const USER_TOKEN = fakeJwt({ who: 'user', aal: 'aal2' });
const STAFF_TOKEN = fakeJwt({ who: 'staff', aal: 'aal2' });
const STAFF_AAL1_TOKEN = fakeJwt({ who: 'staff', aal: 'aal1' });

function roleOf(client) {
  if (client.key === 'service') return 'service';
  const auth = client.headers.Authorization || '';
  const who = claimsOf(auth.replace('Bearer ', '')).who;
  if (who === 'admin') return 'admin';
  if (who === 'staff') return 'staff';
  if (who === 'user') return 'authenticated';
  return 'anon';
}

// sql/12·14 흉내: 명단 조회는 슈퍼관리자·일반관리자, 쓰기는 슈퍼관리자만, 접속 기록은 서버 키만
function canRead(role, table) {
  if (table === 'courses' || table === 'public_courses') return true;
  if (table === 'admin_access_log') return role === 'service';
  return role === 'admin' || role === 'staff' || role === 'service';
}
function canWrite(role, table) {
  if (table === 'admin_access_log') return role === 'service';
  return role === 'admin' || role === 'service';
}

function makeQuery(client, table) {
  const q = { op: 'select', filters: [], cols: '*', lim: null, single: null, returning: false };
  const role = roleOf(client);
  const api = {
    select(cols) { if (q.op === 'select') q.cols = cols || '*'; else q.returning = true; return api; },
    insert(rows) { q.op = 'insert'; q.rows = rows; return api; },
    update(fields) { q.op = 'update'; q.fields = fields; return api; },
    delete() { q.op = 'delete'; return api; },
    eq(k, v) { q.filters.push([k, v]); return api; },
    in(k, vs) { q.filters.push([k, vs, 'in']); return api; },
    order() { return api; },
    limit(n) { q.lim = n; return api; },
    single() { q.single = 'single'; return api; },
    maybeSingle() { q.single = 'maybe'; return api; },
    then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); }
  };
  const match = row => q.filters.every(([k, v, op]) => (op === 'in' ? v.includes(row[k]) : row[k] === v));

  function embed(row) {
    const out = { ...row };
    if (q.cols.includes('education_apply(')) {
      out.education_apply = canRead(role, 'education_apply') ? db.education_apply.filter(a => a.course_id === row.id) : [];
    }
    if (q.cols.includes('courses(')) {
      const c = db.courses.find(c => c.id === row.course_id);
      out.courses = c ? { title: c.title } : null;
    }
    return out;
  }

  function run() {
    if (table === 'public_courses') {
      if (!viewExists) return { data: null, error: { message: 'relation "public_courses" does not exist', code: '42P01' } };
      return { data: db.courses.map(c => ({ ...c, current: db.education_apply.filter(a => a.course_id === c.id).length })), error: null };
    }
    const rows = db[table];
    if (q.op === 'select') {
      let data = canRead(role, table) ? rows.filter(match).map(embed) : [];
      if (q.lim) data = data.slice(0, q.lim);
      if (q.single) return { data: data[0] || null, error: null };
      return { data, error: null };
    }
    if (!canWrite(role, table)) {
      if (q.op === 'insert') return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } };
      return { data: [], error: null }; // RLS silently filters UPDATE/DELETE
    }
    if (q.op === 'insert') {
      const inserted = q.rows.map(r => ({ id: 'new-' + rows.length, ...r }));
      rows.push(...inserted);
      return { data: inserted, error: null };
    }
    const hit = rows.filter(match);
    // sql/12: 신청자가 있는 과정은 삭제 불가(ON DELETE RESTRICT)
    if (q.op === 'delete' && table === 'courses' && hit.some(c => db.education_apply.some(a => a.course_id === c.id))) {
      return { data: null, error: { message: 'violates foreign key constraint', code: '23503' } };
    }
    if (q.op === 'update') hit.forEach(r => Object.assign(r, q.fields));
    if (q.op === 'delete') db[table] = rows.filter(r => !match(r));
    return { data: q.returning ? hit.map(r => ({ id: r.id })) : null, error: null };
  }
  return api;
}

function raise(message) {
  return { data: null, error: { message, code: 'P0001' } };
}

let lastRpcParams = null;
let lastRpcClientKey = null;
let lastLookupClientKey = null;
function atomicCourseApply(p) {
  lastRpcParams = p;
  const existing = db.education_apply.find(a => a.req_id === p.p_req_id);
  if (existing) {
    if (existing.course_id !== p.p_course_id) return raise('요청 식별자 충돌(Collision). 비정상적인 재시도입니다.');
    return { data: existing.id, error: null };
  }
  const course = db.courses.find(c => c.id === p.p_course_id);
  if (!course) return raise('해당 과정을 찾을 수 없습니다.');
  if (!p.p_agree_privacy) return raise('개인정보 수집 및 이용에 동의해야 합니다.');
  const current = db.education_apply.filter(a => a.course_id === p.p_course_id).length;
  if (course.capacity > 0 && current >= course.capacity) return raise('정원이 초과되었습니다.');
  const id = 'apply-' + (db.education_apply.length + 1);
  db.education_apply.push({
    id, req_id: p.p_req_id, course_id: p.p_course_id, company: p.p_company, name: p.p_name,
    phone: p.p_phone, email: p.p_email, agree_privacy: p.p_agree_privacy, sync_status: 'pending'
  });
  return { data: id, error: null };
}

// sql/08_lookup_applications.sql 흉내: 3가지 일치 시 과정명·일시만 반환, 같은 번호 5회 넘으면 거절
let lookupCount = {};
function lookupMyApplications(p) {
  const digits = String(p.p_phone).replace(/\D/g, '');
  lookupCount[digits] = (lookupCount[digits] || 0) + 1;
  if (lookupCount[digits] > 5) return raise('조회 요청이 많습니다. 잠시 후 다시 시도해주세요.');
  const rows = db.education_apply
    .filter(a => a.name === p.p_name && String(a.phone).replace(/\D/g, '') === digits && String(a.email).toLowerCase() === String(p.p_email).toLowerCase())
    .map(a => {
      const c = db.courses.find(c => c.id === a.course_id) || {};
      return { course_title: c.title, course_date: c.date || '', applied_at: '2026-10-01 10:00' };
    });
  return { data: rows, error: null };
}

function createClient(url, key, opts = {}) {
  const client = { key, headers: (opts.global && opts.global.headers) || {} };
  client.from = table => makeQuery(client, table);
  client.rpc = async (name, params) => {
    if (name === 'atomic_course_apply') { lastRpcClientKey = client.key; return atomicCourseApply(params); }
    if (name === 'lookup_my_applications') { lastLookupClientKey = client.key; return lookupMyApplications(params); }
    return raise('unknown rpc');
  };
  client.auth = {
    async getUser(token) {
      const who = claimsOf(token).who;
      if (who === 'admin') return { data: { user: { id: 'u1', app_metadata: { role: 'admin' } } }, error: null };
      if (who === 'user') return { data: { user: { id: 'u2', app_metadata: {} } }, error: null };
      if (who === 'staff') return { data: { user: { id: 'u3', email: 'staff1@staff.dcciedu.co.kr', app_metadata: { role: 'staff' } } }, error: null };
      return { data: { user: null }, error: { message: 'invalid token' } };
    }
  };
  return client;
}

// ---- Loading the handler with the fake -----------------------------------
const PROXY_PATH = path.join(__dirname, '..', 'netlify', 'functions', 'proxy.js');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient };
  return origLoad.apply(this, arguments);
};

function loadHandler(env) {
  for (const k of ['SUPABASE_URL', 'SUPABASE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_SCRIPT_URL', 'APPS_SCRIPT_SECRET',
    'TURNSTILE_SECRET', 'TURNSTILE_DISABLED', 'TURNSTILE_HOSTNAMES']) delete process.env[k];
  // 운영과 같이 로봇 확인 키가 있는 상태가 기본. env에 undefined를 주면 그 값은 없는 상태로 테스트한다.
  const merged = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_KEY: 'anon', TURNSTILE_SECRET: 'ts-secret', ...env };
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) process.env[k] = v;
  delete require.cache[require.resolve(PROXY_PATH)];
  return require(PROXY_PATH).handler;
}

// 신청 정보는 DB에만 저장해야 하므로 외부로 나가는 요청은 모두 기록해 검사한다.
// Turnstile 확인 요청만 허용된다. 토큰별 가짜 응답:
//   good-token: 성공(dcciedu.co.kr, action=apply) / other-host: 다른 사이트에서 발급 / other-action: 다른 화면에서 발급
//   down: 계속 장애 / flaky: 첫 시도만 장애 / 그 밖: 실패
let outboundBodies = [];
global.fetch = async (url, init = {}) => {
  outboundCalls.push(String(url));
  const body = init.body ? Object.fromEntries(new URLSearchParams(init.body.toString())) : {};
  outboundBodies.push(body);
  if (body.response === 'down') throw new Error('ECONNRESET');
  if (body.response === 'flaky' && outboundCalls.length === 1) throw new Error('ECONNRESET');
  const ok = ['good-token', 'flaky', 'other-host', 'other-action'].includes(body.response);
  const json = {
    success: ok,
    hostname: body.response === 'other-host' ? 'evil.example' : 'dcciedu.co.kr',
    action: body.response === 'other-action' ? 'login' : 'apply'
  };
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
};

function applyForm(overrides = {}) {
  return new URLSearchParams({
    course: '세무회계 실무', course_id: COURSE_ID, bizName: '대구상사', bizNo: '123-45-67890', dept: '총무팀',
    position: '대리', name: '홍길동', phone: '010-1234-5678', email: 'hong@example.com', privacy: '동의함', captcha: 'good-token', ...overrides
  }).toString();
}

function call(handler, { method = 'GET', type = 'public', body, token, query } = {}) {
  return handler({
    httpMethod: method,
    queryStringParameters: query === undefined ? (type ? { type } : {}) : query,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body || null,
    isBase64Encoded: false
  }).then(res => ({ ...res, json: res.body ? JSON.parse(res.body) : null }));
}

beforeEach(resetDb);

// ---- Public course list ---------------------------------------------------
test('public GET returns courses with applicant counts from public_courses view', async () => {
  const handler = loadHandler();
  const res = await call(handler);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.json[FULL_ID].current, 1);
  assert.strictEqual(res.json[COURSE_ID].current, 0);
  assert.strictEqual(res.json[COURSE_ID].cost, '무료');
  assert.ok(res.headers['Cache-Control']);
});

test('public GET falls back to plain courses when the view is missing', async () => {
  viewExists = false;
  const handler = loadHandler();
  const res = await call(handler);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.json[FULL_ID].current, 0);
});

test('public GET uses service-role counts when the key is configured', async () => {
  viewExists = false;
  const handler = loadHandler({ SUPABASE_SERVICE_ROLE_KEY: 'service' });
  const res = await call(handler);
  assert.strictEqual(res.json[FULL_ID].current, 1);
});

test('missing queryStringParameters does not crash (treated as admin -> 401)', async () => {
  const handler = loadHandler();
  const res = await call(handler, { query: null });
  assert.strictEqual(res.statusCode, 401);
});

// ---- Public application ---------------------------------------------------
test('application from index.html without action field is accepted', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: applyForm() });
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(res.json.result, 'success');
  const row = db.education_apply.find(a => a.course_id === COURSE_ID);
  assert.ok(row);
  assert.strictEqual(row.agree_privacy, true);
  assert.strictEqual(row.company, '대구상사');
});

test('application with action=apply is accepted', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: applyForm({ action: 'apply' }) });
  assert.strictEqual(res.statusCode, 200);
});

test('JSON body is accepted too', async () => {
  const handler = loadHandler();
  const body = JSON.stringify(Object.fromEntries(new URLSearchParams(applyForm())));
  const res = await call(handler, { method: 'POST', body });
  assert.strictEqual(res.statusCode, 200);
});

test('privacy not agreed is rejected', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: applyForm({ privacy: '미동의' }) });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.json.msg, /동의/);
  assert.strictEqual(db.education_apply.length, 1);
});

test('missing required fields / bad phone are rejected without calling the DB', async () => {
  const handler = loadHandler();
  let res = await call(handler, { method: 'POST', body: applyForm({ name: '' }) });
  assert.strictEqual(res.statusCode, 400);
  res = await call(handler, { method: 'POST', body: applyForm({ phone: '12' }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.education_apply.length, 1);
});

test('course is resolved by course_id, not by title', async () => {
  db.courses.push({ id: '33333333-3333-4333-8333-333333333333', title: '세무회계 실무', capacity: 0 });
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: applyForm({ course_id: '33333333-3333-4333-8333-333333333333' }) });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(db.education_apply.find(a => a.course_id === '33333333-3333-4333-8333-333333333333'));
});

test('title fallback still works when course_id is not a uuid', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: applyForm({ course_id: 'course_1' }) });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(db.education_apply.find(a => a.course_id === COURSE_ID));
});

test('unknown course returns 404', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: applyForm({ course_id: '', course: '없는 과정' }) });
  assert.strictEqual(res.statusCode, 404);
});

test('full course returns the DB business message', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: applyForm({ course_id: FULL_ID }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.json.msg, '정원이 초과되었습니다.');
});

test('resubmitting the same application is idempotent', async () => {
  const handler = loadHandler();
  await call(handler, { method: 'POST', body: applyForm() });
  const res = await call(handler, { method: 'POST', body: applyForm() });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.education_apply.filter(a => a.course_id === COURSE_ID).length, 1);
});

test('colleagues sharing one company phone number are both registered', async () => {
  const handler = loadHandler();
  await call(handler, { method: 'POST', body: applyForm({ phone: '053-222-3109' }) });
  const res = await call(handler, { method: 'POST', body: applyForm({ phone: '053-222-3109', name: '김철수' }) });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.education_apply.filter(a => a.course_id === COURSE_ID).length, 2);
});

test('system DB errors are not exposed to the user', async () => {
  const handler = loadHandler();
  db.courses = null; // makes the course lookup throw inside the fake
  const res = await call(handler, { method: 'POST', body: applyForm() });
  assert.strictEqual(res.statusCode, 500);
  assert.doesNotMatch(res.json.msg, /Cannot|undefined|null/);
});

// ---- Input validation / data minimisation --------------------------------
test('too long input is rejected without calling the DB', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: applyForm({ name: '가'.repeat(51) }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.education_apply.length, 1);
});

test('invalid email is rejected', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: applyForm({ email: 'not-an-email' }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.education_apply.length, 1);
});

test('applications are not copied to an external service (only the captcha check goes out, even with an old sheet URL set)', async () => {
  const handler = loadHandler({ GOOGLE_SCRIPT_URL: 'https://script.example/exec', SUPABASE_SERVICE_ROLE_KEY: 'service' });
  const res = await call(handler, { method: 'POST', body: applyForm() });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(outboundCalls, ['https://challenges.cloudflare.com/turnstile/v0/siteverify']);
});

test('lookup id and password hash are not stored', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: applyForm() });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(lastRpcParams.p_lookup_id, null);
  assert.strictEqual(lastRpcParams.p_lookup_password_hash, null);
});

// ---- Bot protection (honeypot + Turnstile) -------------------------------
test('honeypot field filled by a bot is rejected without saving', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: applyForm({ website: 'http://spam.example' }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.education_apply.length, 1);
});

test('without TURNSTILE_SECRET applications are refused (fail-closed) unless explicitly disabled', async () => {
  let handler = loadHandler({ TURNSTILE_SECRET: undefined });
  const res = await call(handler, { method: 'POST', body: applyForm() });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(db.education_apply.length, 1);
  handler = loadHandler({ TURNSTILE_SECRET: undefined, TURNSTILE_DISABLED: 'true' });
  assert.strictEqual((await call(handler, { method: 'POST', body: applyForm({ captcha: '' }) })).statusCode, 200);
  assert.deepStrictEqual(outboundCalls, []);
});

test('with TURNSTILE_SECRET: missing or failed captcha is rejected, valid captcha is saved', async () => {
  const handler = loadHandler({ TURNSTILE_SECRET: 'ts-secret' });
  assert.strictEqual((await call(handler, { method: 'POST', body: applyForm({ captcha: '' }) })).statusCode, 400);
  assert.strictEqual((await call(handler, { method: 'POST', body: applyForm({ captcha: 'bad-token' }) })).statusCode, 400);
  assert.strictEqual(db.education_apply.length, 1);
  const ok = await call(handler, { method: 'POST', body: applyForm({ captcha: 'good-token' }) });
  assert.strictEqual(ok.statusCode, 200, ok.body);
  assert.strictEqual(db.education_apply.length, 2);
});

test('captcha check sends only the token (no personal data) to Cloudflare', async () => {
  const handler = loadHandler({ TURNSTILE_SECRET: 'ts-secret' });
  await call(handler, { method: 'POST', body: applyForm({ captcha: 'good-token' }) });
  assert.deepStrictEqual(outboundCalls, ['https://challenges.cloudflare.com/turnstile/v0/siteverify']);
  assert.deepStrictEqual(Object.keys(outboundBodies[0]).sort(), ['response', 'secret']);
  assert.doesNotMatch(JSON.stringify(outboundBodies), /홍길동|010|hong@|대구상사/);
});

test('Cloudflare outage: retried once, then the application is refused (fail-closed)', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: applyForm({ captcha: 'down' }) });
  assert.strictEqual(res.statusCode, 503);
  assert.match(res.json.msg, /잠시 후/);
  assert.strictEqual(outboundCalls.length, 2);
  assert.strictEqual(db.education_apply.length, 1);
});

test('a single network blip is absorbed by the retry', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: applyForm({ captcha: 'flaky' }) });
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(outboundCalls.length, 2);
});

test('captcha tokens issued for another hostname or another action are rejected', async () => {
  const handler = loadHandler();
  assert.strictEqual((await call(handler, { method: 'POST', body: applyForm({ captcha: 'other-host' }) })).statusCode, 400);
  assert.strictEqual((await call(handler, { method: 'POST', body: applyForm({ captcha: 'other-action' }) })).statusCode, 400);
  assert.strictEqual(db.education_apply.length, 1);
  const custom = loadHandler({ TURNSTILE_HOSTNAMES: 'evil.example' });
  assert.strictEqual((await call(custom, { method: 'POST', body: applyForm({ captcha: 'other-host' }) })).statusCode, 200);
});

test('applications use the server-only key when it is configured', async () => {
  let handler = loadHandler({ SUPABASE_SERVICE_ROLE_KEY: 'service' });
  await call(handler, { method: 'POST', body: applyForm() });
  assert.strictEqual(lastRpcClientKey, 'service');
  resetDb(); lastRpcClientKey = null;
  handler = loadHandler();
  await call(handler, { method: 'POST', body: applyForm() });
  assert.strictEqual(lastRpcClientKey, 'anon');
});

// ---- Admin: delete one application ---------------------------------------
test('OTP admin can delete one application; others cannot', async () => {
  const handler = loadHandler();
  const body = id => new URLSearchParams({ action: 'delete_application', id }).toString();
  db.education_apply[0].id = '33333333-3333-4333-8333-333333333333';
  const id = db.education_apply[0].id;

  assert.strictEqual((await call(handler, { method: 'POST', body: body(id) })).statusCode, 403); // 공개 경로
  assert.strictEqual((await call(handler, { method: 'POST', type: 'admin', token: USER_TOKEN, body: body(id) })).statusCode, 403);
  assert.strictEqual((await call(handler, { method: 'POST', type: 'admin', token: ADMIN_AAL1_TOKEN, body: body(id) })).statusCode, 403);
  assert.strictEqual((await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: body('not-a-uuid') })).statusCode, 400);
  assert.strictEqual(db.education_apply.length, 1);

  const ok = await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: body(id) });
  assert.strictEqual(ok.statusCode, 200, ok.body);
  assert.strictEqual(db.education_apply.length, 0);

  const again = await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: body(id) });
  assert.strictEqual(again.statusCode, 403);
});

test('admin applicant list includes the application id for deletion', async () => {
  const handler = loadHandler();
  const res = await call(handler, { type: 'admin', token: ADMIN_TOKEN });
  assert.strictEqual(res.json[FULL_ID].applicants[0].id, 'a-full');
});

// ---- Applicant self lookup ------------------------------------------------
function lookupForm(overrides = {}) {
  return new URLSearchParams({ action: 'lookup', name: '홍길동', phone: '010-1234-5678', email: 'HONG@example.com', ...overrides }).toString();
}

test('lookup returns only course title/date/applied time, never personal data', async () => {
  const handler = loadHandler();
  await call(handler, { method: 'POST', body: applyForm() });
  const before = db.education_apply.length;
  const res = await call(handler, { method: 'POST', body: lookupForm() });
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(res.json.items.length, 1);
  assert.deepStrictEqual(Object.keys(res.json.items[0]).sort(), ['appliedAt', 'courseDate', 'courseTitle']);
  assert.strictEqual(res.json.items[0].courseTitle, '세무회계 실무');
  assert.doesNotMatch(res.body, /010|hong@|대구상사|123-45/i);
  assert.strictEqual(db.education_apply.length, before); // 조회는 신청을 만들지 않음
});

test('lookup with one wrong field returns the same empty answer', async () => {
  const handler = loadHandler();
  await call(handler, { method: 'POST', body: applyForm() });
  for (const o of [{ name: '김철수' }, { phone: '010-9999-9999' }, { email: 'x@example.com' }]) {
    const res = await call(handler, { method: 'POST', body: lookupForm(o) });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json.items, []);
  }
});

test('lookup input is validated and repeated lookups are limited', async () => {
  const handler = loadHandler();
  assert.strictEqual((await call(handler, { method: 'POST', body: lookupForm({ email: '' }) })).statusCode, 400);
  assert.strictEqual((await call(handler, { method: 'POST', body: lookupForm({ phone: '12' }) })).statusCode, 400);
  assert.strictEqual((await call(handler, { method: 'POST', body: lookupForm({ email: 'bad' }) })).statusCode, 400);
  let last;
  for (let i = 0; i < 6; i++) last = await call(handler, { method: 'POST', body: lookupForm() });
  assert.strictEqual(last.statusCode, 429);
  assert.match(last.json.msg, /잠시 후/);
});

test('lookup uses the server-only key when it is configured (sql/13)', async () => {
  const handler = loadHandler({ SUPABASE_SERVICE_ROLE_KEY: 'service' });
  await call(handler, { method: 'POST', body: lookupForm() });
  assert.strictEqual(lastLookupClientKey, 'service');
});

test('lookup is only on the public endpoint and does not touch admin data', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', type: 'admin', token: USER_TOKEN, body: lookupForm() });
  assert.strictEqual(res.statusCode, 403);
});

// ---- Admin ---------------------------------------------------------------
test('public endpoint cannot run admin actions', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: new URLSearchParams({ action: 'delete_course', id: COURSE_ID }).toString() });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(db.courses.length, 2);
});

test('admin endpoints require a valid token', async () => {
  const handler = loadHandler();
  assert.strictEqual((await call(handler, { type: 'admin' })).statusCode, 401);
  assert.strictEqual((await call(handler, { type: 'admin', token: 'bogus' })).statusCode, 401);
});

test('admin with password only (aal1, no OTP) is refused and sees no applicants', async () => {
  const handler = loadHandler();
  const res = await call(handler, { type: 'admin', token: ADMIN_AAL1_TOKEN });
  assert.strictEqual(res.statusCode, 403);
  assert.match(res.json.msg, /2단계/);
  const del = await call(handler, { method: 'POST', type: 'admin', token: ADMIN_AAL1_TOKEN, body: new URLSearchParams({ action: 'delete_course', id: COURSE_ID }).toString() });
  assert.strictEqual(del.statusCode, 403);
  assert.strictEqual(db.courses.length, 2);
});

test('admin GET returns applicants; logged-in non-admin is refused by the server', async () => {
  const handler = loadHandler();
  const admin = await call(handler, { type: 'admin', token: ADMIN_TOKEN });
  assert.strictEqual(admin.json[FULL_ID].applicants.length, 1);
  const user = await call(handler, { type: 'admin', token: USER_TOKEN });
  assert.strictEqual(user.statusCode, 403);
  assert.strictEqual(user.json.applicants, undefined);
});

test('admin add/update/delete course; non-admin gets 403 or error', async () => {
  const handler = loadHandler();
  const add = await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: new URLSearchParams({ action: 'add_course', title: '신규', capacity: '10', cost: '무료', endDate: '2026-12-31' }).toString() });
  assert.strictEqual(add.statusCode, 200);
  db.courses.find(c => c.title === '신규').id = '44444444-4444-4444-8444-444444444444';
  const id = '44444444-4444-4444-8444-444444444444';
  assert.strictEqual(db.courses.find(c => c.id === id).end_date, '2026-12-31');

  const upd = await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: new URLSearchParams({ action: 'update_course', id, title: '변경', endDate: '2026-12-31' }).toString() });
  assert.strictEqual(upd.statusCode, 200);
  assert.strictEqual(db.courses.find(c => c.id === id).title, '변경');

  const updUser = await call(handler, { method: 'POST', type: 'admin', token: USER_TOKEN, body: new URLSearchParams({ action: 'update_course', id, title: 'X', endDate: '2026-12-31' }).toString() });
  assert.strictEqual(updUser.statusCode, 403);

  const delUser = await call(handler, { method: 'POST', type: 'admin', token: USER_TOKEN, body: new URLSearchParams({ action: 'delete_course', id }).toString() });
  assert.strictEqual(delUser.statusCode, 403);

  const addUser = await call(handler, { method: 'POST', type: 'admin', token: USER_TOKEN, body: new URLSearchParams({ action: 'add_course', title: 'X', endDate: '2026-12-31' }).toString() });
  assert.strictEqual(addUser.statusCode, 403);
  assert.ok(!db.courses.find(c => c.title === 'X'));

  const del = await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: new URLSearchParams({ action: 'delete_course', id }).toString() });
  assert.strictEqual(del.statusCode, 200);
  assert.ok(!db.courses.find(c => c.id === id));
});

test('course without an end date (retention basis) is refused', async () => {
  const handler = loadHandler();
  const add = await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: new URLSearchParams({ action: 'add_course', title: '종료일 없음' }).toString() });
  assert.strictEqual(add.statusCode, 400);
  assert.match(add.json.msg, /종료일/);
  const bad = await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: new URLSearchParams({ action: 'update_course', id: COURSE_ID, title: 'x', endDate: '12/31' }).toString() });
  assert.strictEqual(bad.statusCode, 400);
  assert.strictEqual(db.courses.length, 2);
});

test('course with applicants cannot be deleted (server check, and DB restrict as backup)', async () => {
  const handler = loadHandler();
  const del = await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: new URLSearchParams({ action: 'delete_course', id: FULL_ID }).toString() });
  assert.strictEqual(del.statusCode, 409);
  assert.match(del.json.msg, /신청자가 있는 과정/);
  assert.ok(db.courses.find(c => c.id === FULL_ID));
  assert.strictEqual(db.education_apply.length, 1);
  const badId = await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: new URLSearchParams({ action: 'delete_course', id: 'x' }).toString() });
  assert.strictEqual(badId.statusCode, 400);
});

test('retry_sync (old sheet re-send) is no longer accepted', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: new URLSearchParams({ action: 'retry_sync', id: 'a-full' }).toString() });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(outboundCalls, []);
});

test('OPTIONS preflight returns CORS headers', async () => {
  const handler = loadHandler();
  const res = await handler({ httpMethod: 'OPTIONS', queryStringParameters: null, headers: {} });
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['Access-Control-Allow-Headers'], /Authorization/);
});

test('admin GET formats applicant timestamps in Korea time', async () => {
  db.education_apply[0].created_at = '2026-10-01T08:22:05Z';
  const handler = loadHandler();
  const res = await call(handler, { type: 'admin', token: ADMIN_TOKEN });
  assert.strictEqual(res.json[FULL_ID].applicants[0].timestamp, '2026. 10. 01 17:22:05');
});

test('courses expose the end date to the admin page', async () => {
  db.courses[0].end_date = '2026-11-30';
  const handler = loadHandler();
  const res = await call(handler, { type: 'admin', token: ADMIN_TOKEN });
  assert.strictEqual(res.json[COURSE_ID].endDate, '2026-11-30');
});

// ---- 관리자 등급 (sql/14): 슈퍼관리자(admin) / 일반관리자(staff) ---------------
const A = (o) => new URLSearchParams(o).toString();
const IDS = ['55555555-5555-4555-8555-555555555551', '55555555-5555-4555-8555-555555555552', '55555555-5555-4555-8555-555555555553'];
function seedApps() {
  IDS.forEach((id, i) => db.education_apply.push({ id, course_id: COURSE_ID, req_id: 'r' + i, name: '시험' + i, company: 'C', email: 'e@e', phone: '010', agree_privacy: true }));
}

test('staff (OTP) can view the applicant list; staff without OTP cannot', async () => {
  const handler = loadHandler({ SUPABASE_SERVICE_ROLE_KEY: 'service' });
  const ok = await call(handler, { type: 'admin', token: STAFF_TOKEN });
  assert.strictEqual(ok.statusCode, 200, ok.body);
  assert.strictEqual(ok.json[FULL_ID].applicants.length, 1);
  const aal1 = await call(handler, { type: 'admin', token: STAFF_AAL1_TOKEN });
  assert.strictEqual(aal1.statusCode, 403);
});

test('staff cannot change anything (courses, deletes, bulk delete)', async () => {
  seedApps();
  const handler = loadHandler({ SUPABASE_SERVICE_ROLE_KEY: 'service' });
  const tries = [
    { action: 'add_course', title: 'X', endDate: '2026-12-31' },
    { action: 'update_course', id: COURSE_ID, title: 'X', endDate: '2026-12-31' },
    { action: 'delete_course', id: '44444444-4444-4444-8444-444444444444' },
    { action: 'delete_application', id: IDS[0] },
    { action: 'delete_applications', ids: IDS.join(',') }
  ];
  for (const t of tries) {
    const res = await call(handler, { method: 'POST', type: 'admin', token: STAFF_TOKEN, body: A(t) });
    assert.strictEqual(res.statusCode, 403, t.action);
    assert.match(res.json.msg, /슈퍼관리자/);
  }
  assert.strictEqual(db.education_apply.length, 4);
  assert.ok(!db.courses.find(c => c.title === 'X'));
});

test('super admin bulk delete: removes selected rows, validates ids and the 100 limit', async () => {
  seedApps();
  const handler = loadHandler({ SUPABASE_SERVICE_ROLE_KEY: 'service' });
  const bad = await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: A({ action: 'delete_applications', ids: IDS[0] + ',not-a-uuid' }) });
  assert.strictEqual(bad.statusCode, 400);
  const many = Array.from({ length: 101 }, (_, i) => '66666666-6666-4666-8666-' + String(i).padStart(12, '0')).join(',');
  assert.strictEqual((await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: A({ action: 'delete_applications', ids: many }) })).statusCode, 400);
  assert.strictEqual((await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: A({ action: 'delete_applications', ids: '' }) })).statusCode, 400);
  assert.strictEqual(db.education_apply.length, 4);

  const ok = await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: A({ action: 'delete_applications', ids: IDS.slice(0, 2).join(',') }) });
  assert.strictEqual(ok.statusCode, 200, ok.body);
  assert.strictEqual(ok.json.deleted, 2);
  assert.deepStrictEqual(db.education_apply.map(a => a.id).sort(), ['a-full', IDS[2]].sort());
});

test('bulk delete with password-only (aal1) admin is refused', async () => {
  seedApps();
  const handler = loadHandler({ SUPABASE_SERVICE_ROLE_KEY: 'service' });
  const res = await call(handler, { method: 'POST', type: 'admin', token: ADMIN_AAL1_TOKEN, body: A({ action: 'delete_applications', ids: IDS.join(',') }) });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(db.education_apply.length, 4);
});

test('access log records who viewed, downloaded and deleted (via server key only)', async () => {
  seedApps();
  const handler = loadHandler({ SUPABASE_SERVICE_ROLE_KEY: 'service' });
  await call(handler, { type: 'admin', token: STAFF_TOKEN });
  const csv = await call(handler, { method: 'POST', type: 'admin', token: STAFF_TOKEN, body: A({ action: 'log_csv', course_id: COURSE_ID, count: '3' }) });
  assert.strictEqual(csv.statusCode, 200, csv.body);
  await call(handler, { method: 'POST', type: 'admin', token: ADMIN_TOKEN, body: A({ action: 'delete_applications', ids: IDS[0] }) });
  const log = db.admin_access_log;
  assert.deepStrictEqual(log.map(l => [l.user_role, l.action]), [['staff', 'view_list'], ['staff', 'download_csv'], ['admin', 'delete_applications']]);
  assert.strictEqual(log[0].user_email, 'staff1@staff.dcciedu.co.kr');
  assert.doesNotMatch(JSON.stringify(log), /시험0|e@e/); // 신청자 개인정보는 기록하지 않음
});

test('CSV download is refused when the access log cannot be written', async () => {
  const handler = loadHandler(); // 서버 키 없음 → 기록 불가
  const res = await call(handler, { method: 'POST', type: 'admin', token: STAFF_TOKEN, body: A({ action: 'log_csv', course_id: COURSE_ID, count: '1' }) });
  assert.strictEqual(res.statusCode, 500);
  assert.match(res.json.msg, /다운로드/);
});

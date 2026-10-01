// Handler-level tests for netlify/functions/proxy.js with an in-memory Supabase fake
// that mimics the RLS policies in sql/01_setup.sql. Run: node --test tests/
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
    ]
  };
  outboundCalls = [];
  viewExists = true;
}

// ---- Supabase fake -------------------------------------------------------
function roleOf(client) {
  if (client.key === 'service') return 'service';
  const auth = client.headers.Authorization || '';
  if (auth === 'Bearer admin-token') return 'admin';
  if (auth === 'Bearer user-token') return 'authenticated';
  return 'anon';
}

function canRead(role, table) {
  if (table === 'courses' || table === 'public_courses') return true;
  return role === 'admin' || role === 'service';
}
function canWrite(role, table) {
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
    order() { return api; },
    limit(n) { q.lim = n; return api; },
    single() { q.single = 'single'; return api; },
    maybeSingle() { q.single = 'maybe'; return api; },
    then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); }
  };
  const match = row => q.filters.every(([k, v]) => row[k] === v);

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

function createClient(url, key, opts = {}) {
  const client = { key, headers: (opts.global && opts.global.headers) || {} };
  client.from = table => makeQuery(client, table);
  client.rpc = async (name, params) => (name === 'atomic_course_apply' ? atomicCourseApply(params) : raise('unknown rpc'));
  client.auth = {
    async getUser(token) {
      if (token === 'admin-token') return { data: { user: { id: 'u1', app_metadata: { role: 'admin' } } }, error: null };
      if (token === 'user-token') return { data: { user: { id: 'u2', app_metadata: {} } }, error: null };
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
  for (const k of ['SUPABASE_URL', 'SUPABASE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_SCRIPT_URL', 'APPS_SCRIPT_SECRET']) delete process.env[k];
  Object.assign(process.env, { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_KEY: 'anon' }, env);
  delete require.cache[require.resolve(PROXY_PATH)];
  return require(PROXY_PATH).handler;
}

// 신청 정보는 DB에만 저장해야 하므로 외부로 나가는 요청은 모두 기록해 검사한다.
global.fetch = async (url) => {
  outboundCalls.push(String(url));
  return { ok: true, status: 200, text: async () => '{}' };
};

function applyForm(overrides = {}) {
  return new URLSearchParams({
    course: '세무회계 실무', course_id: COURSE_ID, bizName: '대구상사', bizNo: '123-45-67890', dept: '총무팀',
    position: '대리', name: '홍길동', phone: '010-1234-5678', email: 'hong@example.com', privacy: '동의함', ...overrides
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

test('applications are stored only in the DB (no outbound requests, even with an old sheet URL set)', async () => {
  const handler = loadHandler({ GOOGLE_SCRIPT_URL: 'https://script.example/exec', SUPABASE_SERVICE_ROLE_KEY: 'service' });
  const res = await call(handler, { method: 'POST', body: applyForm() });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(outboundCalls, []);
});

test('lookup id and password hash are not stored', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', body: applyForm() });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(lastRpcParams.p_lookup_id, null);
  assert.strictEqual(lastRpcParams.p_lookup_password_hash, null);
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

test('admin GET returns applicants; logged-in non-admin is refused by the server', async () => {
  const handler = loadHandler();
  const admin = await call(handler, { type: 'admin', token: 'admin-token' });
  assert.strictEqual(admin.json[FULL_ID].applicants.length, 1);
  const user = await call(handler, { type: 'admin', token: 'user-token' });
  assert.strictEqual(user.statusCode, 403);
  assert.strictEqual(user.json.applicants, undefined);
});

test('admin add/update/delete course; non-admin gets 403 or error', async () => {
  const handler = loadHandler();
  const add = await call(handler, { method: 'POST', type: 'admin', token: 'admin-token', body: new URLSearchParams({ action: 'add_course', title: '신규', capacity: '10', cost: '무료' }).toString() });
  assert.strictEqual(add.statusCode, 200);
  const id = add.json.id;

  const upd = await call(handler, { method: 'POST', type: 'admin', token: 'admin-token', body: new URLSearchParams({ action: 'update_course', id, title: '변경' }).toString() });
  assert.strictEqual(upd.statusCode, 200);
  assert.strictEqual(db.courses.find(c => c.id === id).title, '변경');

  const updUser = await call(handler, { method: 'POST', type: 'admin', token: 'user-token', body: new URLSearchParams({ action: 'update_course', id, title: 'X' }).toString() });
  assert.strictEqual(updUser.statusCode, 403);

  const delUser = await call(handler, { method: 'POST', type: 'admin', token: 'user-token', body: new URLSearchParams({ action: 'delete_course', id }).toString() });
  assert.strictEqual(delUser.statusCode, 403);

  const addUser = await call(handler, { method: 'POST', type: 'admin', token: 'user-token', body: new URLSearchParams({ action: 'add_course', title: 'X' }).toString() });
  assert.strictEqual(addUser.statusCode, 403);
  assert.ok(!db.courses.find(c => c.title === 'X'));

  const del = await call(handler, { method: 'POST', type: 'admin', token: 'admin-token', body: new URLSearchParams({ action: 'delete_course', id }).toString() });
  assert.strictEqual(del.statusCode, 200);
  assert.ok(!db.courses.find(c => c.id === id));
});

test('retry_sync (old sheet re-send) is no longer accepted', async () => {
  const handler = loadHandler();
  const res = await call(handler, { method: 'POST', type: 'admin', token: 'admin-token', body: new URLSearchParams({ action: 'retry_sync', id: 'a-full' }).toString() });
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
  const res = await call(handler, { type: 'admin', token: 'admin-token' });
  assert.strictEqual(res.json[FULL_ID].applicants[0].timestamp, '2026. 10. 01 17:22:05');
});

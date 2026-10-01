const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; // anon key
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // optional, server only

// Initialize Supabase clients safely
let supabase = null;
let adminDbClient = null; // only used for server-side bookkeeping (counts, sync_status)
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
  } catch (e) {
    console.error("Failed to initialize Supabase client:", e);
  }
}
if (supabaseUrl && supabaseServiceRoleKey) {
  try {
    adminDbClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  } catch (e) {
    console.error("Failed to initialize Supabase admin client:", e);
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Credentials': true,
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS,PATCH,DELETE,POST,PUT',
  'Access-Control-Allow-Headers': 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
};

const GENERIC_ERROR_MSG = '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHEET_TIMEOUT_MS = 6000;

function jsonRes(code, data, extraHeaders = {}) {
  return { statusCode: code, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }, body: JSON.stringify(data) };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function isAgreed(v) {
  return v === true || v === 'Y' || v === 'true' || v === '동의함';
}

// Business errors raised by the DB function (RAISE EXCEPTION -> P0001) are written
// for end users; everything else is logged and replaced with a generic message.
function userMessage(err) {
  if (err && err.code === 'P0001' && err.message) return err.message;
  return GENERIC_ERROR_MSG;
}

function formatTimestamp(isoString) {
  if (!isoString) return "";
  try {
    const d = new Date(isoString);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}. ${mm}. ${dd} ${hh}:${min}:${ss}`;
  } catch (e) {
    return String(isoString);
  }
}

function splitPaymentInfo(raw) {
  const paymentInfo = raw || "";
  if (paymentInfo.includes('|||')) {
    const parts = paymentInfo.split('|||');
    return { cost: parts[0], paymentInfo: parts[1] };
  }
  // Backward compatibility: use the whole string for both if no delimiter
  return { cost: paymentInfo, paymentInfo: paymentInfo };
}

function mapCourse(course, current) {
  const { cost, paymentInfo } = splitPaymentInfo(course.payment_info);
  return {
    id: course.id,
    category: course.category || "",
    title: course.title || "",
    date: course.date || "",
    place: course.place || "",
    capacity: course.capacity || 0,
    deadline: course.deadline || "",
    target: course.target || "",
    goal: course.goal || "",
    content: course.content || "",
    instructor: course.instructor || "",
    instructorBio: course.instructor_bio || "",
    contact: course.contact || "",
    cost: cost,
    paymentInfo: paymentInfo,
    otherInfo: course.other_info || "",
    current: current
  };
}

// Public course list with applicant counts. Applicant rows are hidden from anon by RLS,
// so counts come from the service-role client or the public_courses view.
async function fetchPublicCourses() {
  if (adminDbClient) {
    const { data, error } = await adminDbClient.from('courses').select('*, education_apply(id)');
    if (!error) return data.map(c => mapCourse(c, (c.education_apply || []).length));
    console.error('Public courses via admin client failed:', error);
  }

  const { data: viewData, error: viewError } = await supabase.from('public_courses').select('*');
  if (!viewError) return viewData.map(c => mapCourse(c, c.current || 0));
  console.error('public_courses view query failed:', viewError);

  const { data, error } = await supabase.from('courses').select('*');
  if (error) throw error;
  return data.map(c => mapCourse(c, 0));
}

// Sends one application row to the Google Sheet. Throws on HTTP or Apps Script errors.
async function sendToSheet(payload) {
  const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
  if (!googleScriptUrl) return false;

  const body = new URLSearchParams({ ...payload, secret: process.env.APPS_SCRIPT_SECRET || '' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHEET_TIMEOUT_MS);
  try {
    const res = await fetch(googleScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Apps Script HTTP ${res.status}`);
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* non-JSON reply is treated as success */ }
    if (json && json.result === 'error') throw new Error(`Apps Script error: ${json.msg || 'unknown'}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function updateSyncStatus(client, applyId, fields) {
  if (!client) {
    console.warn('sync_status not updated (SUPABASE_SERVICE_ROLE_KEY not set):', applyId, fields.sync_status);
    return;
  }
  const { error } = await client.from('education_apply').update(fields).eq('id', applyId);
  if (error) console.error('sync_status update failed:', applyId, error);
}

async function handleApply(reqBody) {
  const name = str(reqBody.name);
  const company = str(reqBody.bizName);
  const email = str(reqBody.email);
  const phone = str(reqBody.phone);
  const phoneDigits = phone.replace(/\D/g, '');

  if (!name || !company || !email || !phone) {
    return jsonRes(400, { result: 'error', msg: '필수 입력값이 누락되었습니다.' });
  }
  if (phoneDigits.length < 9 || phoneDigits.length > 11) {
    return jsonRes(400, { result: 'error', msg: '연락처를 정확히 입력해주세요.' });
  }
  if (!isAgreed(reqBody.privacy)) {
    return jsonRes(400, { result: 'error', msg: '개인정보 수집 및 이용에 동의해야 합니다.' });
  }

  // Resolve the course by id when available; title is a fallback for older pages.
  const courseIdParam = str(reqBody.course_id);
  const courseTitleParam = str(reqBody.course);
  let query = supabase.from('courses').select('id, title');
  if (UUID_RE.test(courseIdParam)) query = query.eq('id', courseIdParam);
  else if (courseTitleParam) query = query.eq('title', courseTitleParam);
  else return jsonRes(400, { result: 'error', msg: '교육 과정 정보가 없습니다.' });

  const { data: courseRows, error: courseError } = await query.limit(1);
  if (courseError) throw courseError;
  if (!courseRows || courseRows.length === 0) {
    return jsonRes(404, { result: 'error', msg: '해당 과정을 찾을 수 없습니다.' });
  }
  const course = courseRows[0];

  // Same person + same phone + same course => same req_id (idempotent resubmit).
  // Name is included so colleagues sharing a company phone number are not merged.
  const req_id = crypto.createHash('sha256').update(`${phoneDigits}|${course.id}|${name}`).digest('hex');
  const lookupId = crypto.randomBytes(4).toString('hex').toUpperCase();
  const pwdHash = crypto.createHash('sha256').update(phoneDigits.slice(-4)).digest('hex');

  const { data: applyId, error: applyError } = await supabase.rpc('atomic_course_apply', {
    p_course_id: course.id, p_req_id: req_id,
    p_company: company, p_biz_no: str(reqBody.bizNo), p_dept: str(reqBody.dept),
    p_position: str(reqBody.position), p_name: name, p_phone: phone,
    p_email: email, p_agree_privacy: true,
    p_lookup_id: lookupId, p_lookup_password_hash: pwdHash
  });
  if (applyError) {
    console.error('atomic_course_apply failed:', applyError);
    const status = applyError.code === 'P0001' ? 400 : 500;
    return jsonRes(status, { result: 'error', msg: userMessage(applyError) });
  }

  // The application is stored at this point; sheet sync failures must not fail the request.
  try {
    const sent = await sendToSheet({
      apply_id: applyId, course: course.title, bizName: company, bizNo: str(reqBody.bizNo),
      dept: str(reqBody.dept), position: str(reqBody.position), name, phone, email, privacy: '동의함'
    });
    if (sent) await updateSyncStatus(adminDbClient, applyId, { sync_status: 'success', sync_error: null });
  } catch (err) {
    console.error('Sheet sync failed:', applyId, err);
    await updateSyncStatus(adminDbClient, applyId, { sync_status: 'failed', sync_error: String(err.message || err).slice(0, 500) });
  }

  return jsonRes(200, { result: 'success' });
}

// Admin only: RLS on education_apply lets only app_metadata.role = 'admin' read/update rows,
// so a non-admin token simply finds nothing.
async function handleRetrySync(dbClient, reqBody) {
  const { data: applyData, error: applyDataError } = await dbClient
    .from('education_apply').select('*, courses(title)').eq('id', reqBody.id).maybeSingle();
  if (applyDataError) throw applyDataError;
  if (!applyData) return jsonRes(404, { result: 'error', msg: '신청 내역을 찾을 수 없습니다.' });

  if (!process.env.GOOGLE_SCRIPT_URL) {
    return jsonRes(500, { result: 'error', msg: '시트 연동 주소가 설정되지 않았습니다.' });
  }

  const retries = (applyData.sync_retries || 0) + 1;
  try {
    await sendToSheet({
      apply_id: applyData.id, course: (applyData.courses && applyData.courses.title) || '',
      bizName: applyData.company || '', bizNo: applyData.biz_no || '', dept: applyData.dept || '',
      position: applyData.position || '', name: applyData.name || '', phone: applyData.phone || '',
      email: applyData.email || '', privacy: applyData.agree_privacy ? '동의함' : '미동의'
    });
    await updateSyncStatus(dbClient, applyData.id, { sync_status: 'success', sync_error: null, sync_retries: retries });
    return jsonRes(200, { result: 'success' });
  } catch (err) {
    console.error('Sheet re-sync failed:', applyData.id, err);
    await updateSyncStatus(dbClient, applyData.id, { sync_status: 'failed', sync_error: String(err.message || err).slice(0, 500), sync_retries: retries });
    return jsonRes(502, { result: 'error', msg: '시트 재전송에 실패했습니다.' });
  }
}

function courseFields(reqBody) {
  return {
    category: reqBody.category,
    title: reqBody.title,
    date: reqBody.date,
    place: reqBody.place,
    capacity: parseInt(reqBody.capacity) || 0,
    deadline: reqBody.deadline || null,
    target: reqBody.target,
    goal: reqBody.goal,
    content: reqBody.content,
    instructor: reqBody.instructor,
    instructor_bio: reqBody.instructorBio,
    contact: reqBody.contact,
    payment_info: (reqBody.cost || "") + "|||" + (reqBody.paymentInfo || ""),
    other_info: reqBody.otherInfo
  };
}

exports.handler = async function(event, context) {
  // OPTIONS: Always Allow (CORS)
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (!supabase) {
    return jsonRes(500, { result: 'error', msg: GENERIC_ERROR_MSG });
  }

  const reqBody = parseBody(event);
  const isPublic = (event.queryStringParameters || {}).type === 'public';
  let dbClient = supabase;

  if (!isPublic) {
    const headers = event.headers || {};
    const authHeader = headers['authorization'] || headers['Authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonRes(401, { result: 'error', msg: '로그인이 필요합니다.' });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return jsonRes(401, { result: 'error', msg: '로그인이 필요합니다.' });
    }

    try {
      dbClient = createClient(supabaseUrl, supabaseKey, {
        global: {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      });
    } catch (clientErr) {
      console.error("Failed to create request-scoped client:", clientErr);
      return jsonRes(500, { result: 'error', msg: GENERIC_ERROR_MSG });
    }
  }

  // GET Request: Fetch courses and applicants count/list
  if (event.httpMethod === 'GET') {
    try {
      if (isPublic) {
        const courses = await fetchPublicCourses();
        const responseData = {};
        courses.forEach(course => { responseData[course.id] = course; });
        return jsonRes(200, responseData, { 'Cache-Control': 's-maxage=30, stale-while-revalidate=3600' });
      } else {
        // Admin Request: Fetch courses and full applicant list
        const { data: courses, error } = await dbClient
          .from('courses')
          .select('*, education_apply(*)');

        if (error) throw error;

        const responseData = {};
        courses.forEach(course => {
          const apps = (course.education_apply || []).map(app => ({
            timestamp: formatTimestamp(app.created_at),
            bizName: app.company || "",
            bizNo: app.biz_no || "",
            dept: app.dept || "",
            position: app.position || "",
            name: app.name || "",
            phone: app.phone || "",
            email: app.email || "",
            privacy: app.agree_privacy ? "Y" : "N",
            memberType: "",
            feeStatus: "",
            councilType: ""
          }));

          responseData[course.id] = { ...mapCourse(course, apps.length), applicants: apps };
        });
        return jsonRes(200, responseData);
      }
    } catch (err) {
      console.error('Database GET Error:', err);
      return jsonRes(500, { result: 'error', msg: GENERIC_ERROR_MSG });
    }
  }

  // POST Request: Add/Update/Delete courses or Submit application
  if (event.httpMethod === 'POST') {
    try {
      // The public page posts applications without an action field.
      const action = reqBody.action || (isPublic ? 'apply' : '');

      if (action === 'apply') {
        return await handleApply(reqBody);
      }

      if (isPublic) {
        return jsonRes(403, { result: 'error', msg: '권한이 없습니다.' });
      }

      // 1. Add course
      if (action === 'add_course') {
        const { data, error } = await dbClient
          .from('courses')
          .insert([courseFields(reqBody)])
          .select();

        if (error) throw error;
        return jsonRes(200, { result: 'success', id: data[0].id });
      }

      // 2. Update course
      else if (action === 'update_course') {
        const { data, error } = await dbClient
          .from('courses')
          .update(courseFields(reqBody))
          .eq('id', reqBody.id)
          .select('id');

        if (error) throw error;
        if (!data || data.length === 0) return jsonRes(403, { result: 'error', msg: '권한이 없거나 대상 과정을 찾을 수 없습니다.' });
        return jsonRes(200, { result: 'success' });
      }

      // 3. Delete course
      else if (action === 'delete_course') {
        const { data, error } = await dbClient
          .from('courses')
          .delete()
          .eq('id', reqBody.id)
          .select('id');

        if (error) throw error;
        if (!data || data.length === 0) return jsonRes(403, { result: 'error', msg: '권한이 없거나 대상 과정을 찾을 수 없습니다.' });
        return jsonRes(200, { result: 'success' });
      }

      // 4. Re-send an application to the Google Sheet
      else if (action === 'retry_sync') {
        return await handleRetrySync(dbClient, reqBody);
      }

      return jsonRes(400, { result: 'error', msg: '알 수 없는 요청입니다.' });
    } catch (err) {
      console.error('Database POST Error:', err);
      return jsonRes(500, { result: 'error', msg: userMessage(err) });
    }
  }

  return jsonRes(405, { result: 'error', msg: 'Method Not Allowed' });
};

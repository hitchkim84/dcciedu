const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; // anon key
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // optional, server only

// Initialize Supabase clients safely
let supabase = null;
let adminDbClient = null; // only used for public applicant counts
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 입력값 최대 길이 (DB 함수 sql/06_apply_validation.sql과 같은 기준)
const MAX_LEN = { name: 50, company: 100, email: 100, phone: 20, bizNo: 20, dept: 50, position: 50 };

// 기본은 캐시 금지(신청자 명단 등). 공개 과정 목록만 extraHeaders로 캐시를 허용한다.
function jsonRes(code, data, extraHeaders = {}) {
  return { statusCode: code, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders }, body: JSON.stringify(data) };
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

// 검증이 끝난 JWT의 내용(aal 등)을 읽는다. 서명 검증은 supabase.auth.getUser가 먼저 한다.
function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch (e) {
    return {};
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

// Netlify functions run in UTC, so format explicitly in Korea time.
const KST_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function formatTimestamp(isoString) {
  if (!isoString) return "";
  try {
    const p = Object.fromEntries(KST_PARTS.formatToParts(new Date(isoString)).map(x => [x.type, x.value]));
    return `${p.year}. ${p.month}. ${p.day} ${p.hour}:${p.minute}:${p.second}`;
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

// 로봇 확인(Cloudflare Turnstile). TURNSTILE_SECRET이 없으면 확인하지 않는다(키 등록 전에도 신청이 멈추지 않게).
// Cloudflare로는 확인 토큰과 접속 IP만 보내고 신청 내용(개인정보)은 보내지 않는다.
// Cloudflare 장애로 확인 자체를 못 하면 신청은 받는다(접수 중단 방지). 확인 결과가 '실패'면 거절한다.
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
async function verifyCaptcha(token, ip) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return true;
  if (!token) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const params = { secret, response: token };
    if (ip) params.remoteip = ip;
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: new URLSearchParams(params), signal: controller.signal });
    const json = await res.json();
    return json.success === true;
  } catch (e) {
    console.error('Turnstile verify unavailable, accepting application:', e.message);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function handleApply(reqBody, clientIp) {
  // 사람 눈에 보이지 않는 칸(허니팟)이 채워져 있으면 자동 입력 로봇으로 본다.
  if (str(reqBody.website)) {
    return jsonRes(400, { result: 'error', msg: '요청을 처리할 수 없습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.' });
  }
  if (!(await verifyCaptcha(str(reqBody.captcha), clientIp))) {
    return jsonRes(400, { result: 'error', msg: '자동입력 방지 확인에 실패했습니다. 잠시 후 다시 시도해주세요.' });
  }

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
  const bizNo = str(reqBody.bizNo);
  const dept = str(reqBody.dept);
  const position = str(reqBody.position);
  const lengths = { name, company, email, phone, bizNo, dept, position };
  if (Object.keys(MAX_LEN).some(k => lengths[k].length > MAX_LEN[k])) {
    return jsonRes(400, { result: 'error', msg: '입력값이 너무 깁니다.' });
  }
  if (!EMAIL_RE.test(email)) {
    return jsonRes(400, { result: 'error', msg: '이메일 주소를 정확히 입력해주세요.' });
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

  // 신청 조회 기능은 사용하지 않으므로 조회용 ID·비밀번호는 저장하지 않는다.
  // 서비스 키가 있으면 서버 전용 키로 호출한다(sql/10 적용 후에는 홈페이지 키로 직접 호출 불가).
  const { error: applyError } = await (adminDbClient || supabase).rpc('atomic_course_apply', {
    p_course_id: course.id, p_req_id: req_id,
    p_company: company, p_biz_no: bizNo, p_dept: dept,
    p_position: position, p_name: name, p_phone: phone,
    p_email: email, p_agree_privacy: true,
    p_lookup_id: null, p_lookup_password_hash: null
  });
  if (applyError) {
    console.error('atomic_course_apply failed:', applyError);
    const status = applyError.code === 'P0001' ? 400 : 500;
    return jsonRes(status, { result: 'error', msg: userMessage(applyError) });
  }

  return jsonRes(200, { result: 'success' });
}

// 신청자 본인 확인: 이름 + 휴대폰 + 이메일이 모두 일치하는 신청의 과정명·교육일시·신청일시만 돌려준다.
// 반복 조회 제한과 일치 확인은 DB 함수(sql/08_lookup_applications.sql)에서 한다.
async function handleLookup(reqBody) {
  const name = str(reqBody.name);
  const phone = str(reqBody.phone);
  const email = str(reqBody.email);
  const phoneDigits = phone.replace(/\D/g, '');

  if (!name || !phone || !email) {
    return jsonRes(400, { result: 'error', msg: '이름, 휴대폰, 이메일을 모두 입력해주세요.' });
  }
  if (name.length > MAX_LEN.name || phone.length > MAX_LEN.phone || email.length > MAX_LEN.email) {
    return jsonRes(400, { result: 'error', msg: '입력값이 너무 깁니다.' });
  }
  if (phoneDigits.length < 9 || phoneDigits.length > 11) {
    return jsonRes(400, { result: 'error', msg: '연락처를 정확히 입력해주세요.' });
  }
  if (!EMAIL_RE.test(email)) {
    return jsonRes(400, { result: 'error', msg: '이메일 주소를 정확히 입력해주세요.' });
  }

  const { data, error } = await supabase.rpc('lookup_my_applications', { p_name: name, p_phone: phone, p_email: email });
  if (error) {
    console.error('lookup_my_applications failed:', error);
    const status = error.code === 'P0001' ? 429 : 500;
    return jsonRes(status, { result: 'error', msg: userMessage(error) });
  }
  const items = (data || []).map(r => ({ courseTitle: r.course_title || '', courseDate: r.course_date || '', appliedAt: r.applied_at || '' }));
  return jsonRes(200, { result: 'success', items });
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

    // DB 규칙(RLS)과 별개로 서버에서도 관리자 역할을 확인한다 (이중 잠금).
    if (!user.app_metadata || user.app_metadata.role !== 'admin') {
      return jsonRes(403, { result: 'error', msg: '관리자 권한이 없습니다.' });
    }

    // 비밀번호만 통과한 로그인(aal1)은 거절하고, OTP까지 통과한 로그인(aal2)만 허용한다.
    if (jwtClaims(token).aal !== 'aal2') {
      return jsonRes(403, { result: 'error', msg: '2단계 인증(OTP)이 필요합니다.' });
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
            id: app.id,
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

      if (action === 'lookup' && isPublic) {
        return await handleLookup(reqBody);
      }

      if (action === 'apply') {
        const headers = event.headers || {};
        return await handleApply(reqBody, headers['x-nf-client-connection-ip'] || '');
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

      // 신청 1건 삭제 (OTP 통과 관리자만, DB 규칙 sql/09에서도 확인)
      else if (action === 'delete_application') {
        const id = str(reqBody.id);
        if (!UUID_RE.test(id)) return jsonRes(400, { result: 'error', msg: '잘못된 요청입니다.' });
        const { data, error } = await dbClient
          .from('education_apply')
          .delete()
          .eq('id', id)
          .select('id');

        if (error) throw error;
        if (!data || data.length === 0) return jsonRes(403, { result: 'error', msg: '권한이 없거나 대상 신청을 찾을 수 없습니다.' });
        return jsonRes(200, { result: 'success' });
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

      return jsonRes(400, { result: 'error', msg: '알 수 없는 요청입니다.' });
    } catch (err) {
      console.error('Database POST Error:', err);
      return jsonRes(500, { result: 'error', msg: userMessage(err) });
    }
  }

  return jsonRes(405, { result: 'error', msg: 'Method Not Allowed' });
};

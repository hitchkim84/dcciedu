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
  const { error: applyError } = await supabase.rpc('atomic_course_apply', {
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

      return jsonRes(400, { result: 'error', msg: '알 수 없는 요청입니다.' });
    } catch (err) {
      console.error('Database POST Error:', err);
      return jsonRes(500, { result: 'error', msg: userMessage(err) });
    }
  }

  return jsonRes(405, { result: 'error', msg: 'Method Not Allowed' });
};

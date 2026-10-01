const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; // anon key
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // admin key

let supabase = null;
let adminDbClient = null;

if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
  } catch (e) { console.error("Supabase anon client error:", e); }
}

if (supabaseUrl && supabaseServiceRoleKey) {
  try {
    adminDbClient = createClient(supabaseUrl, supabaseServiceRoleKey);
  } catch (e) { console.error("Supabase service client error:", e); }
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

function hashPassword(password) {
    if (!password) return null;
    return crypto.scryptSync(password, 'dcci_salt_2026_v6', 64).toString('hex');
}

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Credentials': true,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS,PATCH,DELETE,POST,PUT',
    'Access-Control-Allow-Headers': 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  };
  
  let reqBody = {};
  if (event.body) {
      const bodyStr = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
      const cType = event.headers['content-type'] || event.headers['Content-Type'] || '';
      if (cType.includes('application/x-www-form-urlencoded')) {
          reqBody = Object.fromEntries(new URLSearchParams(bodyStr));
      } else {
          try { reqBody = JSON.parse(bodyStr); } catch(e) {}
      }
  }
  
  function jsonRes(code, data, extraHeaders = {}) {
      return { statusCode: code, headers: { ...headers, ...extraHeaders }, body: JSON.stringify(data) };
  }

if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  if (!supabase || !adminDbClient) {
    return jsonRes(500, { result: 'error', msg: 'Server Configuration Error: Supabase clients not initialized.' });
  }

  const isPublic = (event.queryStringParameters && event.queryStringParameters.type) === 'public';
  let dbClient = supabase;
  let isAdmin = false;

  if (!isPublic) {
    const authHeader = (event.headers['authorization'] || event.headers['Authorization']);
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonRes(401, { result: 'error', msg: 'Unauthorized: Missing session token' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return jsonRes(401, { result: 'error', msg: 'Unauthorized: Invalid or expired session' });
    }
    isAdmin = user.app_metadata?.role === 'admin' || user.email === process.env.ADMIN_EMAIL;
    try {
      dbClient = createClient(supabaseUrl, supabaseKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
      });
    } catch (clientErr) {
      return jsonRes(500, { result: 'error', msg: 'Failed to authenticate DB client.' });
    }
  }

  if (event.httpMethod === 'GET') {
    try {
      if (isPublic) {
        headers['Cache-Control'] = 's-maxage=30, stale-while-revalidate=3600';
        const { data: courses, error } = await adminDbClient.from('courses').select('*, education_apply(id)').order('created_at', { ascending: false });
        if (error) throw error;
        
        const responseData = {};
        courses.forEach(course => {
            let cost = "무료 / 별도 문의";
            let paymentInfo = course.payment_info || "";
            if (paymentInfo.includes('|||')) {
              const parts = paymentInfo.split('|||'); cost = parts[0]; paymentInfo = parts[1];
            } else { cost = paymentInfo; }

            responseData[course.id] = {
              id: course.id, category: course.category || "", title: course.title || "",
              date: course.date || "", place: course.place || "", capacity: course.capacity || 0,
              deadline: course.deadline || "", target: course.target || "", goal: course.goal || "",
              content: course.content || "", instructor: course.instructor || "",
              instructorBio: course.instructor_bio || "", contact: course.contact || "",
              cost: cost, paymentInfo: paymentInfo, otherInfo: course.other_info || "",
              current: (course.education_apply || []).length
            };
        });
        return jsonRes(200, responseData);
      } else {
        if (!isAdmin) return jsonRes(403, { result: 'error', msg: 'Forbidden' });
        
        // Admin GET: use dbClient which has admin JWT
        const { data: courses, error } = await dbClient.from('courses').select('*, education_apply(*)').order('created_at', { ascending: false });
        if (error) throw error;

        const responseData = {};
        courses.forEach(course => {
            let cost = "", paymentInfo = course.payment_info || "";
            if (paymentInfo.includes('|||')) {
              const parts = paymentInfo.split('|||'); cost = parts[0]; paymentInfo = parts[1];
            } else { cost = paymentInfo; }

            const apps = (course.education_apply || []).map(app => ({
                id: app.id,
                timestamp: formatTimestamp(app.created_at),
                bizName: app.company || "", bizNo: app.biz_no || "",
                dept: app.dept || "", position: app.position || "",
                name: app.name || "", phone: app.phone || "",
                email: app.email || "", privacy: app.agree_privacy ? "?�의?? : "미동??,
                syncStatus: app.sync_status || "pending", syncError: app.sync_error || ""
            })).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

            responseData[course.id] = {
              id: course.id, category: course.category || "", title: course.title || "",
              date: course.date || "", place: course.place || "", capacity: course.capacity || 0,
              deadline: course.deadline || "", target: course.target || "", goal: course.goal || "",
              content: course.content || "", instructor: course.instructor || "",
              instructorBio: course.instructor_bio || "", contact: course.contact || "",
              cost: cost, paymentInfo: paymentInfo, otherInfo: course.other_info || "",
              current: apps.length, applicants: apps
            };
        });
        return jsonRes(200, responseData);
      }
    } catch (err) {
      return jsonRes(500, { result: 'error', msg: err.message });
    }
  }

  if (event.httpMethod === 'POST') {
    try {
      const { action } = reqBody;

      if (!isPublic && !isAdmin) {
         return jsonRes(403, { result: 'error', msg: 'Forbidden' });
      }

      // --- Admin Actions ---
      if (['add_course', 'update_course', 'delete_course', 'retry_sync'].includes(action)) {
          if (isPublic || !isAdmin) {
             return jsonRes(403, { result: 'error', msg: '관리자 권한???�요?�니??' });
          }

          if (action === 'add_course') {
            const { data, error } = await dbClient.from('courses').insert([{
                category: reqBody.category, title: reqBody.title, date: reqBody.date,
                place: reqBody.place, capacity: parseInt(reqBody.capacity) || 0,
                deadline: reqBody.deadline || null, target: reqBody.target,
                goal: reqBody.goal, content: reqBody.content, instructor: reqBody.instructor,
                instructor_bio: reqBody.instructorBio, contact: reqBody.contact,
                payment_info: (reqBody.cost || "") + "|||" + (reqBody.paymentInfo || ""),
                other_info: reqBody.otherInfo
              }]).select();
            if (error) throw error;
            return jsonRes(200, { result: 'success', id: data[0].id });
          }

          if (action === 'update_course') {
            const { error } = await dbClient.from('courses').update({
                category: reqBody.category, title: reqBody.title, date: reqBody.date,
                place: reqBody.place, capacity: parseInt(reqBody.capacity) || 0,
                deadline: reqBody.deadline || null, target: reqBody.target,
                goal: reqBody.goal, content: reqBody.content, instructor: reqBody.instructor,
                instructor_bio: reqBody.instructorBio, contact: reqBody.contact,
                payment_info: (reqBody.cost || "") + "|||" + (reqBody.paymentInfo || ""),
                other_info: reqBody.otherInfo
              }).eq('id', reqBody.id);
            if (error) throw error;
            return jsonRes(200, { result: 'success' });
          }

          if (action === 'delete_course') {
            const { error } = await dbClient.from('courses').delete().eq('id', reqBody.id);
            if (error) throw error;
            return jsonRes(200, { result: 'success' });
          }

          if (action === 'retry_sync') {
              const { apply_id } = reqBody;
              if (!apply_id) return jsonRes(400, { result: 'error', msg: 'Missing apply_id' });

              const { data: applyData, error } = await adminDbClient.from('education_apply')
                  .select('*, courses(title)')
                  .eq('id', apply_id).single();

              if (error || !applyData) return jsonRes(404, { result: 'error', msg: '?�청 ?�역 ?�음' });

              const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
              if (!googleScriptUrl) return jsonRes(500, { result: 'error', msg: '구�? ?�트 ?�동 URL 미설?? });

              try {
                const formBody = new URLSearchParams({
                  action: 'apply',
                  apply_id: applyData.id,
                  course: applyData.courses.title,
                  bizName: applyData.company, bizNo: applyData.biz_no, dept: applyData.dept,
                  position: applyData.position, name: applyData.name, phone: applyData.phone,
                  email: applyData.email, privacy: applyData.agree_privacy ? "?�의?? : "미동??,
                  secret: process.env.APPS_SCRIPT_SECRET || ""
                });
                const syncRes = await fetch(googleScriptUrl, {
                  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: formBody
                });
                const syncData = await syncRes.json();
                if (syncData.result !== 'success') throw new Error(syncData.msg || 'Unknown Apps Script error');
                await adminDbClient.from('education_apply').update({ sync_status: 'success', sync_error: null, sync_retries: (applyData.sync_retries || 0) + 1 }).eq('id', apply_id);
                return jsonRes(200, { result: 'success' });
              } catch (syncErr) {
                await adminDbClient.from('education_apply').update({ sync_status: 'failed', sync_error: syncErr.message, sync_retries: (applyData.sync_retries || 0) + 1 }).eq('id', apply_id);
                return jsonRes(500, { result: 'error', msg: '구�? ?�트 ?�동 ?�패: ' + syncErr.message });
              }
          }
      }

      // --- Public Actions ---
      else if (action === 'lookup_apply') {
        headers['Cache-Control'] = 'no-store, max-age=0';
        const clientIp = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
        
        // Rate limit check
        const { data: rlData, error: rlError } = await adminDbClient.rpc('check_rate_limit', { p_ip: clientIp });
        if (rlError || !rlData) {
            return jsonRes(429, { result: 'error', msg: '?�무 많�? ?�청??발생?�습?�다. ?�시 ???�시 ?�도?�주?�요.' });
        }

        const { lookup_id, lookup_password } = reqBody;
        const genericError = '?�청 ?�보�?찾을 ???�거??비�?번호가 ?�치?��? ?�습?�다.';
        
        if (!lookup_id || !lookup_password) {
            return jsonRes(401, { result: 'error', msg: genericError });
        }

        const { data: applyData, error } = await adminDbClient.from('education_apply')
            .select('*, courses(title, date, place)')
            .eq('lookup_id', lookup_id.toUpperCase())
            .single();

        if (error || !applyData) {
            return jsonRes(401, { result: 'error', msg: genericError });
        }

        const hashedInput = hashPassword(lookup_password);
        if (applyData.lookup_password_hash !== hashedInput) {
            return jsonRes(401, { result: 'error', msg: genericError });
        }

        // Reset rate limit on success
        await adminDbClient.rpc('reset_rate_limit', { p_ip: clientIp });

        let nameMasked = applyData.name;
        if (nameMasked && nameMasked.length > 2) {
            nameMasked = nameMasked[0] + '*'.repeat(nameMasked.length - 2) + nameMasked[nameMasked.length - 1];
        } else if (nameMasked && nameMasked.length === 2) {
            nameMasked = nameMasked[0] + '*';
        }

        return jsonRes(200, {
            result: 'success',
            data: {
                title: applyData.courses.title,
                date: applyData.courses.date,
                place: applyData.courses.place,
                nameMasked: nameMasked,
                submittedAt: formatTimestamp(applyData.created_at),
                contact: applyData.courses.contact || '?�구상공회?�소 교육?�당??(053-222-3109)'
            }
        });
      }

      else if (action === 'apply') {
        const { course_id, req_id, password } = reqBody;
        if (!course_id || !req_id) return jsonRes(400, { result: 'error', msg: '?�수 ?�청 ?�별?��? ?�락?�었?�니??' });
        if (!password || password.length < 4) return jsonRes(400, { result: 'error', msg: '비�?번호??4?�리 ?�상?�어???�니??' });

        const lookupId = crypto.randomBytes(3).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
        const pwdHash = hashPassword(password);

        const { data: applyId, error } = await adminDbClient.rpc('atomic_course_apply', {
            p_course_id: course_id, p_req_id: req_id,
            p_company: reqBody.bizName, p_biz_no: reqBody.bizNo, p_dept: reqBody.dept,
            p_position: reqBody.position, p_name: reqBody.name, p_phone: reqBody.phone,
            p_email: reqBody.email,
            p_agree_privacy: reqBody.privacy === '?�의?? || reqBody.privacy === 'true' || reqBody.privacy === true,
            p_lookup_id: lookupId, p_lookup_password_hash: pwdHash
        });

        if (error) {
            return jsonRes(400, { result: 'error', msg: error.message });
        }

        const { data: finalData } = await adminDbClient.from('education_apply').select('*, courses(title)').eq('id', applyId).single();
        const finalLookupId = finalData ? finalData.lookup_id : lookupId;
        const finalCourseTitle = finalData ? finalData.courses.title : reqBody.course;

        // Sheets Sync
        const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
        if (googleScriptUrl) {
          try {
            const formBody = new URLSearchParams({
              action: 'apply',
              apply_id: applyId,
              course: finalCourseTitle,
              bizName: finalData.company, bizNo: finalData.biz_no, dept: finalData.dept,
              position: finalData.position, name: finalData.name, phone: finalData.phone,
              email: finalData.email, privacy: finalData.agree_privacy ? "������" : "�̵���",
              secret: process.env.APPS_SCRIPT_SECRET || ""
            });
            const syncRes = await fetch(googleScriptUrl, {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: formBody
            });
            const syncData = await syncRes.json();
            if (syncData.result !== 'success') throw new Error(syncData.msg || 'Apps Script returned error');
            
            await adminDbClient.from('education_apply').update({ sync_status: 'success', sync_error: null }).eq('id', applyId);
          } catch (syncErr) {
            await adminDbClient.from('education_apply').update({ sync_status: 'failed', sync_error: syncErr.message }).eq('id', applyId);
          }
        }
        
        return jsonRes(200, { result: 'success', lookup_id: finalLookupId });
      }
      
      // Invalid action
      else {
        return jsonRes(400, { result: 'error', msg: '?�효?��? ?��? ?�청?�니??' });
      }

    } catch (err) {
      return jsonRes(500, { result: 'error', msg: '?�버 ?��? ?�류가 발생?�습?�다.' });
    }
  }

  return jsonRes(405, { result: 'error', msg: 'Method Not Allowed' });
}




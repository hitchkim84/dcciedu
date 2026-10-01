const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// Initialize Supabase client safely
let supabase = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
  } catch (e) {
    console.error("Failed to initialize Supabase client:", e);
  }
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
    return crypto.createHash('sha256').update(password + 'dcci_salt_2026').digest('hex');
}

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (!supabase) {
    return res.status(500).json({ result: 'error', msg: 'Server Configuration Error: Supabase client is not initialized.' });
  }

  const isPublic = req.query.type === 'public';
  let dbClient = supabase;
  let isAdmin = false;

  if (!isPublic) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ result: 'error', msg: 'Unauthorized: Missing session token' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ result: 'error', msg: 'Unauthorized: Invalid or expired session' });
    }
    isAdmin = user.app_metadata?.role === 'admin';
    try {
      dbClient = createClient(supabaseUrl, supabaseKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
      });
    } catch (clientErr) {
      return res.status(500).json({ result: 'error', msg: 'Failed to authenticate database client.' });
    }
  }

  if (req.method === 'GET') {
    try {
      if (isPublic) {
        res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=3600");
        const { data: courses, error } = await dbClient.from('public_courses').select('*');
        if (error) throw error;
        
        const responseData = {};
        courses.forEach(course => {
            let cost = "무료 / 별도 문의";
            let paymentInfo = course.payment_info || "";
            if (paymentInfo.includes('|||')) {
              const parts = paymentInfo.split('|||');
              cost = parts[0];
              paymentInfo = parts[1];
            } else { cost = paymentInfo; }

            responseData[course.id] = {
              id: course.id, category: course.category || "", title: course.title || "",
              date: course.date || "", place: course.place || "", capacity: course.capacity || 0,
              deadline: course.deadline || "", target: course.target || "", goal: course.goal || "",
              content: course.content || "", instructor: course.instructor || "",
              instructorBio: course.instructor_bio || "", contact: course.contact || "",
              cost: cost, paymentInfo: paymentInfo, otherInfo: course.other_info || "",
              current: course.current_applicants || 0
            };
        });
        return res.status(200).json(responseData);
      } else {
        if (!isAdmin) return res.status(403).json({ result: 'error', msg: 'Forbidden' });
        
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
                bizName: app.company || "",
                bizNo: app.biz_no || "",
                dept: app.dept || "",
                position: app.position || "",
                name: app.name || "",
                phone: app.phone || "",
                email: app.email || "",
                privacy: app.agree_privacy ? "동의함" : "미동의",
                syncStatus: app.sync_status || "pending",
                syncError: app.sync_error || ""
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
        return res.status(200).json(responseData);
      }
    } catch (err) {
      return res.status(500).json({ result: 'error', msg: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { action } = req.body;

      if (!isPublic && !isAdmin) {
         return res.status(403).json({ result: 'error', msg: 'Forbidden' });
      }

      if (action === 'add_course') {
        const { data, error } = await dbClient.from('courses').insert([{
            category: req.body.category, title: req.body.title, date: req.body.date,
            place: req.body.place, capacity: parseInt(req.body.capacity) || 0,
            deadline: req.body.deadline || null, target: req.body.target,
            goal: req.body.goal, content: req.body.content, instructor: req.body.instructor,
            instructor_bio: req.body.instructorBio, contact: req.body.contact,
            payment_info: (req.body.cost || "") + "|||" + (req.body.paymentInfo || ""),
            other_info: req.body.otherInfo
          }]).select();
        if (error) throw error;
        return res.status(200).json({ result: 'success', id: data[0].id });
      }

      else if (action === 'update_course') {
        const { error } = await dbClient.from('courses').update({
            category: req.body.category, title: req.body.title, date: req.body.date,
            place: req.body.place, capacity: parseInt(req.body.capacity) || 0,
            deadline: req.body.deadline || null, target: req.body.target,
            goal: req.body.goal, content: req.body.content, instructor: req.body.instructor,
            instructor_bio: req.body.instructorBio, contact: req.body.contact,
            payment_info: (req.body.cost || "") + "|||" + (req.body.paymentInfo || ""),
            other_info: req.body.otherInfo
          }).eq('id', req.body.id);
        if (error) throw error;
        return res.status(200).json({ result: 'success' });
      }

      else if (action === 'delete_course') {
        const { error } = await dbClient.from('courses').delete().eq('id', req.body.id);
        if (error) throw error;
        return res.status(200).json({ result: 'success' });
      }

      else if (action === 'lookup_apply') {
        const { lookup_id, lookup_password } = req.body;
        if (!lookup_id || !lookup_password) {
            return res.status(400).json({ result: 'error', msg: '신청번호와 비밀번호를 입력해주세요.' });
        }

        // admin bypass
        const { data: applyData, error } = await supabase.from('education_apply')
            .select('*, courses(title, date, place)')
            .eq('lookup_id', lookup_id.toUpperCase())
            .single();

        if (error || !applyData) {
            return res.status(404).json({ result: 'error', msg: '신청 내역을 찾을 수 없거나 정보가 일치하지 않습니다.' });
        }

        if (applyData.locked_until && new Date(applyData.locked_until) > new Date()) {
            return res.status(403).json({ result: 'error', msg: '비밀번호 5회 오류로 인해 계정이 잠겼습니다. 15분 후 다시 시도해주세요.' });
        }

        const hashedInput = hashPassword(lookup_password);
        if (applyData.lookup_password_hash !== hashedInput) {
            const newFails = (applyData.failed_attempts || 0) + 1;
            let locked_until = null;
            if (newFails >= 5) {
                locked_until = new Date(Date.now() + 15 * 60000).toISOString();
            }
            await supabase.from('education_apply').update({ failed_attempts: newFails, locked_until }).eq('id', applyData.id);
            return res.status(401).json({ result: 'error', msg: '비밀번호가 일치하지 않습니다.' });
        }

        // Reset fails
        if (applyData.failed_attempts > 0) {
            await supabase.from('education_apply').update({ failed_attempts: 0, locked_until: null }).eq('id', applyData.id);
        }

        let nameMasked = applyData.name;
        if (nameMasked && nameMasked.length > 2) {
            nameMasked = nameMasked[0] + '*'.repeat(nameMasked.length - 2) + nameMasked[nameMasked.length - 1];
        } else if (nameMasked && nameMasked.length === 2) {
            nameMasked = nameMasked[0] + '*';
        }

        return res.status(200).json({
            result: 'success',
            data: {
                title: applyData.courses.title,
                date: applyData.courses.date,
                place: applyData.courses.place,
                nameMasked: nameMasked,
                submittedAt: formatTimestamp(applyData.created_at),
                contact: applyData.courses.contact || '대구상공회의소 교육담당자 (053-222-3109)'
            }
        });
      }

      else if (action === 'retry_sync') {
          if (!isAdmin) return res.status(403).json({ result: 'error', msg: 'Forbidden' });
          const { apply_id } = req.body;
          if (!apply_id) return res.status(400).json({ result: 'error', msg: 'Missing apply_id' });

          const { data: applyData, error } = await supabase.from('education_apply')
              .select('*, courses(title)')
              .eq('id', apply_id)
              .single();

          if (error || !applyData) return res.status(404).json({ result: 'error', msg: '신청 내역 없음' });

          const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
          if (!googleScriptUrl) return res.status(500).json({ result: 'error', msg: '구글 시트 연동 URL이 설정되지 않았습니다.' });

          try {
            const formBody = new URLSearchParams({
              course: applyData.courses.title,
              bizName: applyData.company, bizNo: applyData.biz_no, dept: applyData.dept,
              position: applyData.position, name: applyData.name, phone: applyData.phone,
              email: applyData.email, privacy: applyData.agree_privacy ? "동의함" : "미동의",
              admin_secret: process.env.APPS_SCRIPT_SECRET || ""
            });

            const syncRes = await fetch(googleScriptUrl, {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: formBody
            });

            const syncText = await syncRes.text();
            if (!syncRes.ok) throw new Error(syncText || 'Unknown error');
            
            await supabase.from('education_apply').update({ sync_status: 'success', sync_error: null, sync_retries: (applyData.sync_retries || 0) + 1 }).eq('id', apply_id);
            return res.status(200).json({ result: 'success' });
          } catch (syncErr) {
            await supabase.from('education_apply').update({ sync_status: 'failed', sync_error: syncErr.message, sync_retries: (applyData.sync_retries || 0) + 1 }).eq('id', apply_id);
            return res.status(500).json({ result: 'error', msg: '구글 시트 연동 실패: ' + syncErr.message });
          }
      }

      // Default: Submit application
      else {
        const { course_id, req_id, password } = req.body;
        if (!course_id || !req_id) return res.status(400).json({ result: 'error', msg: 'Missing course_id or req_id.' });

        const lookupId = crypto.randomBytes(3).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
        const pwdHash = hashPassword(password);

        const { data, error } = await supabase.rpc('atomic_course_apply', {
            p_course_id: course_id,
            p_req_id: req_id,
            p_company: req.body.bizName,
            p_biz_no: req.body.bizNo,
            p_dept: req.body.dept,
            p_position: req.body.position,
            p_name: req.body.name,
            p_phone: req.body.phone,
            p_email: req.body.email,
            p_agree_privacy: req.body.privacy === '동의함' || req.body.privacy === 'true' || req.body.privacy === true,
            p_lookup_id: lookupId,
            p_lookup_password_hash: pwdHash
        });

        if (error) {
            return res.status(400).json({ result: 'error', msg: error.message });
        }

        const applyId = data;

        // Try to fetch lookup_id in case it was a duplicate and lookup_id already existed
        const { data: existingData } = await supabase.from('education_apply').select('lookup_id').eq('id', applyId).single();
        const finalLookupId = existingData ? existingData.lookup_id : lookupId;

        // Google Sheets Sync
        const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
        if (googleScriptUrl) {
          try {
            const formBody = new URLSearchParams({
              course: req.body.course,
              bizName: req.body.bizName, bizNo: req.body.bizNo, dept: req.body.dept,
              position: req.body.position, name: req.body.name, phone: req.body.phone,
              email: req.body.email, privacy: req.body.privacy,
              admin_secret: process.env.APPS_SCRIPT_SECRET || ""
            });

            const syncRes = await fetch(googleScriptUrl, {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: formBody
            });
            const syncText = await syncRes.text();
            if (!syncRes.ok) throw new Error(syncText || 'Unknown error');
            
            await supabase.from('education_apply').update({ sync_status: 'success', sync_error: null }).eq('id', applyId);
          } catch (syncErr) {
            await supabase.from('education_apply').update({ sync_status: 'failed', sync_error: syncErr.message }).eq('id', applyId);
          }
        }
        
        return res.status(200).json({ result: 'success', lookup_id: finalLookupId });
      }
    } catch (err) {
      return res.status(500).json({ result: 'error', msg: err.message });
    }
  }

  return res.status(405).json({ result: 'error', msg: 'Method Not Allowed' });
}

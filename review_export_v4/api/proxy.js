const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
// For secure operations bypassing RLS (like updating sync_status), use service role key
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseKey; 

let supabase = null;
let supabaseAdmin = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (!supabase) {
    return res.status(500).json({ result: 'error', msg: 'Server Configuration Error' });
  }

  const isPublic = req.query.type === 'public';
  let dbClient = supabase;
  let isAdmin = false;

  // Authentication & RBAC (Role-Based Access Control)
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

    // Unify Admin check: matches the logic of RLS
    // Server checks if role === 'admin'
    const hasAdminRole = user.app_metadata && user.app_metadata.role === 'admin';
    
    if (!hasAdminRole) {
      return res.status(403).json({ result: 'error', msg: 'Forbidden: You do not have administrator privileges.' });
    }
    isAdmin = true;

    try {
      dbClient = createClient(supabaseUrl, supabaseKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
      });
    } catch (clientErr) {
      return res.status(500).json({ result: 'error', msg: 'Failed to authenticate database client.' });
    }
  }

  // Helper function to sync with Google Sheets
  async function syncToGoogleSheets(applyId, courseData, payload) {
    const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
    if (!googleScriptUrl) return { success: false, error: 'GOOGLE_SCRIPT_URL not configured' };

    try {
      const formBody = new URLSearchParams({
        secret: process.env.APPS_SCRIPT_SECRET || '', // For auth
        apply_id: applyId,
        course: payload.course || courseData.title,
        bizName: payload.bizName,
        bizNo: payload.bizNo,
        dept: payload.dept,
        position: payload.position,
        name: payload.name,
        phone: payload.phone,
        email: payload.email,
        privacy: payload.privacy
      });

      const sheetRes = await fetch(googleScriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody
      });

      if (!sheetRes.ok) throw new Error(`HTTP Error: ${sheetRes.status}`);
      
      const sheetResultText = await sheetRes.text();
      let sheetResult;
      try {
        sheetResult = JSON.parse(sheetResultText);
      } catch (e) {
        throw new Error(`Invalid JSON from Apps Script: ${sheetResultText.substring(0, 50)}`);
      }
      
      if (sheetResult.result !== 'success') throw new Error(`Logic Error: ${sheetResult.message}`);

      // Must use supabaseAdmin to bypass RLS to update sync_status if triggered by public user
      await supabaseAdmin.from('education_apply').update({ sync_status: 'success', sync_error: null }).eq('id', applyId);
      return { success: true };
    } catch (syncErr) {
      console.error('Failed to sync to Google Sheets:', syncErr);
      
      const { data: applyRow } = await supabaseAdmin.from('education_apply').select('sync_retries').eq('id', applyId).single();
      const retries = applyRow ? (applyRow.sync_retries || 0) + 1 : 1;
      
      await supabaseAdmin.from('education_apply').update({ 
        sync_status: 'failed', 
        sync_error: syncErr.message,
        sync_retries: retries 
      }).eq('id', applyId);

      return { success: false, error: syncErr.message };
    }
  }

  // GET Request: Fetch courses
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
            } else {
              cost = paymentInfo;
            }

            responseData[course.id] = {
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
              current: course.current || 0
            };
        });
        return res.status(200).json(responseData);
      } else {
        if (!isAdmin) return res.status(403).json({ result: 'error', msg: 'Forbidden' });
        
        const { data: courses, error } = await dbClient.from('courses').select('*, education_apply(*)');
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
            privacy: app.agree_privacy ? "동의함" : "미동의",
            memberType: "",
            feeStatus: "",
            councilType: "",
            syncStatus: app.sync_status || "pending",
            syncError: app.sync_error || ""
          }));

          let cost = "무료 / 별도 문의";
          let paymentInfo = course.payment_info || "";
          if (paymentInfo.includes('|||')) {
              const parts = paymentInfo.split('|||');
              cost = parts[0];
              paymentInfo = parts[1];
          } else {
              cost = paymentInfo;
          }

          responseData[course.id] = {
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
            current: apps.length,
            applicants: apps
          };
        });
        return res.status(200).json(responseData);
      }
    } catch (err) {
      console.error('Database GET Error:', err);
      return res.status(500).json({ result: 'error', msg: err.message });
    }
  }

  // POST Request
  if (req.method === 'POST') {
    try {
      const { action } = req.body;

      // Block admin actions for public requests completely
      if (isPublic && ['add_course', 'update_course', 'delete_course', 'retry_sync'].includes(action)) {
        return res.status(401).json({ result: 'error', msg: 'Unauthorized: Admin actions require authentication.' });
      }

      // Restored complete logic for add/update/delete
      if (action === 'add_course') {
        const { data, error } = await dbClient
          .from('courses')
          .insert([{
            category: req.body.category,
            title: req.body.title,
            date: req.body.date,
            place: req.body.place,
            capacity: parseInt(req.body.capacity) || 0,
            deadline: req.body.deadline || null,
            target: req.body.target,
            goal: req.body.goal,
            content: req.body.content,
            instructor: req.body.instructor,
            instructor_bio: req.body.instructorBio,
            contact: req.body.contact,
            payment_info: (req.body.cost || "") + "|||" + (req.body.paymentInfo || ""),
            other_info: req.body.otherInfo
          }])
          .select();

        if (error) throw error;
        return res.status(200).json({ result: 'success', id: data[0].id });
      }
      else if (action === 'update_course') {
        const { error } = await dbClient
          .from('courses')
          .update({
            category: req.body.category,
            title: req.body.title,
            date: req.body.date,
            place: req.body.place,
            capacity: parseInt(req.body.capacity) || 0,
            deadline: req.body.deadline || null,
            target: req.body.target,
            goal: req.body.goal,
            content: req.body.content,
            instructor: req.body.instructor,
            instructor_bio: req.body.instructorBio,
            contact: req.body.contact,
            payment_info: (req.body.cost || "") + "|||" + (req.body.paymentInfo || ""),
            other_info: req.body.otherInfo
          })
          .eq('id', req.body.id);

        if (error) throw error;
        return res.status(200).json({ result: 'success' });
      }
      else if (action === 'delete_course') {
        const { error } = await dbClient
          .from('courses')
          .delete()
          .eq('id', req.body.id);

        if (error) throw error;
        return res.status(200).json({ result: 'success' });
      }
      
      // Retry Sync Action
      else if (action === 'retry_sync') {
        const { apply_id } = req.body;
        if (!isAdmin) return res.status(403).json({ result: 'error', msg: 'Forbidden' });
        
        const { data: applyData, error: applyError } = await dbClient.from('education_apply').select('*, courses(title)').eq('id', apply_id).single();
        if (applyError || !applyData) return res.status(404).json({ result: 'error', msg: 'Application not found' });

        const syncResult = await syncToGoogleSheets(apply_id, applyData.courses, {
          course: applyData.courses.title,
          bizName: applyData.company,
          bizNo: applyData.biz_no,
          dept: applyData.dept,
          position: applyData.position,
          name: applyData.name,
          phone: applyData.phone,
          email: applyData.email,
          privacy: applyData.agree_privacy ? "동의함" : "미동의"
        });

        if (syncResult && !syncResult.success) {
          return res.status(500).json({ result: 'error', msg: '재전송 실패: ' + syncResult.error });
        }
        return res.status(200).json({ result: 'success' });
      }

      // Application Submit (Default Action)
      else {
        const courseId = req.body.course_id;
        const reqId = req.body.req_id; // Added for true idempotency
        
        if (!courseId) return res.status(400).json({ result: 'error', msg: 'Missing course ID.' });
        if (!reqId) return res.status(400).json({ result: 'error', msg: 'Missing request ID.' });
        
        const agreePrivacy = req.body.privacy === '동의함' || req.body.privacy === 'true' || req.body.privacy === true;

        // Call the PostgreSQL RPC for Atomic Processing
        let applyId;
        const { data, error } = await dbClient.rpc('atomic_course_apply', {
          p_course_id: courseId,
          p_req_id: reqId,
          p_company: req.body.bizName,
          p_biz_no: req.body.bizNo,
          p_dept: req.body.dept,
          p_position: req.body.position,
          p_name: req.body.name,
          p_phone: req.body.phone,
          p_email: req.body.email,
          p_agree_privacy: agreePrivacy
        });

        if (error) {
          // Idempotency: Catch unique constraint violations for req_id
          if (error.code === '23505' || error.message.includes('unique_req_id')) {
             const { data: existing } = await supabaseAdmin.from('education_apply').select('id').eq('req_id', reqId).single();
             if (existing) {
               applyId = existing.id; // Proceed to retry sync
             } else {
               return res.status(409).json({ result: 'error', msg: '이미 진행중인 신청입니다.' });
             }
          } else {
            return res.status(400).json({ result: 'error', msg: error.message });
          }
        } else {
          applyId = data; // the returned UUID from RPC
        }

        // Trigger Sync to Sheets
        const syncResult = await syncToGoogleSheets(applyId, { title: req.body.course }, req.body);
        
        // Always return success to user even if sync fails (because DB was successfully saved)
        // Admin will check sync_status
        return res.status(200).json({ result: 'success', apply_id: applyId, sync_success: syncResult.success });
      }
    } catch (err) {
      console.error('Database POST Error:', err);
      return res.status(500).json({ result: 'error', msg: err.message });
    }
  }

  return res.status(405).json({ result: 'error', msg: 'Method Not Allowed' });
}

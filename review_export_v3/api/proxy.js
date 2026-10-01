const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

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

    // RBAC: Verify if the logged-in user is actually an admin
    // This expects the user's role in JWT to be 'admin', or checks against a specific environment variable
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@dcci.or.kr';
    const hasAdminRole = user.app_metadata && user.app_metadata.role === 'admin';
    const isExplicitAdmin = user.email === adminEmail;
    
    if (!hasAdminRole && !isExplicitAdmin) {
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
    if (!googleScriptUrl) return;

    try {
      const formBody = new URLSearchParams({
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
      
      const sheetResult = await sheetRes.json();
      if (sheetResult.result !== 'success') throw new Error(`Logic Error: ${sheetResult.message}`);

      await dbClient.from('education_apply').update({ sync_status: 'success', sync_error: null }).eq('id', applyId);
      return { success: true };
    } catch (syncErr) {
      console.error('Failed to sync to Google Sheets:', syncErr);
      
      // Update DB with failure state and increment retries
      const { data: applyRow } = await dbClient.from('education_apply').select('sync_retries').eq('id', applyId).single();
      const retries = applyRow ? (applyRow.sync_retries || 0) + 1 : 1;
      
      await dbClient.from('education_apply').update({ 
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
        // ... (formatting code omitted for brevity but conceptually identical)
        return res.status(200).json(courses);
      } else {
        if (!isAdmin) return res.status(403).json({ result: 'error', msg: 'Forbidden' });
        
        const { data: courses, error } = await dbClient.from('courses').select('*, education_apply(*)');
        if (error) throw error;
        return res.status(200).json(courses);
      }
    } catch (err) {
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

      if (action === 'add_course') { /* ... omitted ... */ return res.status(200).json({ result: 'success' }); }
      else if (action === 'update_course') { /* ... omitted ... */ return res.status(200).json({ result: 'success' }); }
      else if (action === 'delete_course') { /* ... omitted ... */ return res.status(200).json({ result: 'success' }); }
      
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
          privacy: applyData.agree_privacy
        });

        if (syncResult && !syncResult.success) {
          return res.status(500).json({ result: 'error', msg: '재전송 실패: ' + syncResult.error });
        }
        return res.status(200).json({ result: 'success' });
      }

      // Application Submit (Default Action)
      else {
        const courseId = req.body.course_id;
        if (!courseId) return res.status(400).json({ result: 'error', msg: 'Missing course ID.' });
        
        const agreePrivacy = req.body.privacy === '동의함' || req.body.privacy === 'true' || req.body.privacy === true;

        // Call the PostgreSQL RPC for Atomic Processing
        let applyId;
        const { data, error } = await dbClient.rpc('atomic_course_apply', {
          p_course_id: courseId,
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
          // Idempotency: Catch unique constraint violations
          if (error.code === '23505' || error.message.includes('unique_course_application')) {
             // Already applied. Retrieve the existing apply_id for retry if needed.
             const { data: existing } = await dbClient.from('education_apply').select('id').eq('course_id', courseId).eq('email', req.body.email).eq('biz_no', req.body.bizNo).single();
             if (existing) {
               applyId = existing.id; // We'll just re-trigger Google Sheets sync
             } else {
               return res.status(409).json({ result: 'error', msg: '이미 신청 완료된 내역이 존재합니다.' });
             }
          } else {
            return res.status(400).json({ result: 'error', msg: error.message });
          }
        } else {
          applyId = data; // the returned UUID from RPC
        }

        // Trigger Sync to Sheets
        await syncToGoogleSheets(applyId, { title: req.body.course }, req.body);

        return res.status(200).json({ result: 'success', apply_id: applyId });
      }
    } catch (err) {
      console.error('Database POST Error:', err);
      return res.status(500).json({ result: 'error', msg: err.message });
    }
  }

  return res.status(405).json({ result: 'error', msg: 'Method Not Allowed' });
}

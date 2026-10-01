const { createClient } = require('@supabase/supabase-js');

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

exports.handler = async function(event, context) {
function jsonRes(code, data, extraHeaders = {}) { return { statusCode: code, headers: { 'Access-Control-Allow-Credentials': true, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS,PATCH,DELETE,POST,PUT', 'Access-Control-Allow-Headers': 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization', ...extraHeaders }, body: JSON.stringify(data) }; }
let reqBody = {}; if(event.body){try{reqBody=JSON.parse(event.body)}catch(e){reqBody=Object.fromEntries(new URLSearchParams(event.body))}}
  // CORS headers
  
  
  
  

  // OPTIONS: Always Allow (CORS)
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS,PATCH,DELETE,POST,PUT', 'Access-Control-Allow-Headers': 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization' }, body: '' };
    return;
  }

  if (!supabase) {
    return jsonRes(500, { result: 'error', msg: 'Error' });
  }

  const isPublic = event.queryStringParameters.type === 'public';
  let dbClient = supabase;

  if (!isPublic) {
    const authHeader = event.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonRes(401, { result: 'error', msg: 'Error' });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return jsonRes(401, { result: 'error', msg: 'Error' });
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
      return jsonRes(500, { result: 'error', msg: 'Error' });
    }
  }

  // GET Request: Fetch courses and applicants count/list
  if (event.httpMethod === 'GET') {
    try {
      if (isPublic) {
        res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=3600");
        // Query the public view which has the pre-calculated applicant counts
        const { data: courses, error } = await dbClient.from('courses').select('*, education_apply(id)');

        if (error) throw error;

        // Map to response format
        const responseData = {};
        courses.forEach(course => {
            let cost = 'Free';
            let paymentInfo = course.payment_info || "";
            if (paymentInfo.includes('|||')) {
              const parts = paymentInfo.split('|||');
              cost = parts[0];
              paymentInfo = parts[1];
            } else {
              // Backward compatibility: use the whole string for both if no delimiter (since we just deployed that)
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
        return jsonRes(200, responseData);
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

          let cost = 'Free';
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
        return jsonRes(200, responseData);
      }
    } catch (err) {
      console.error('Database GET Error:', err);
      return jsonRes(500, { result: 'error', msg: err.message });
    }
  }

  // POST Request: Add/Update/Delete courses or Submit application
  if (event.httpMethod === 'POST') {
    try {
      const { action } = reqBody;

      // 1. Add course
      if (action === 'add_course') {
        const { data, error } = await dbClient
          .from('courses')
          .insert([{
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
          }])
          .select();

        if (error) throw error;
        return jsonRes(200, { result: 'success', id: data[0].id });
      }

      // 2. Update course
      else if (action === 'update_course') {
        const { error } = await dbClient
          .from('courses')
          .update({
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
          })
          .eq('id', reqBody.id);

        if (error) throw error;
        return jsonRes(200, { result: 'success' });
      }

      // 3. Delete course
      else if (action === 'delete_course') {
        const { error } = await dbClient
          .from('courses')
          .delete()
          .eq('id', reqBody.id);

        if (error) throw error;
        return jsonRes(200, { result: 'success' });
      }

              else if (action === 'apply') {
          const courseTitle = reqBody.course;
          if (!courseTitle) return jsonRes(400, { result: 'error', msg: 'Course title missing' });
          
          const { data: courseData, error: courseError } = await dbClient.from('courses').select('id').eq('title', courseTitle.trim()).limit(1);
          if (courseError) throw courseError;
          if (!courseData || courseData.length === 0) return jsonRes(404, { result: 'error', msg: 'Course not found' });
          
          const courseId = courseData[0].id;
          const req_id = reqBody.phone + '_' + courseId;
          const crypto = require('crypto');
          const lookupId = crypto.randomBytes(4).toString('hex').toUpperCase();
          const rawPwd = reqBody.phone.slice(-4);
          const pwdHash = crypto.createHash('sha256').update(rawPwd).digest('hex');

          const { data: applyId, error: applyError } = await dbClient.rpc('atomic_course_apply', {
              p_course_id: courseId, p_req_id: req_id,
              p_company: reqBody.bizName || '', p_biz_no: reqBody.bizNo || '', p_dept: reqBody.dept || '',
              p_position: reqBody.position || '', p_name: reqBody.name || '', p_phone: reqBody.phone || '',
              p_email: reqBody.email || '', p_agree_privacy: reqBody.privacy === 'Y' || reqBody.privacy === 'true' || reqBody.privacy === true,
              p_lookup_id: lookupId, p_lookup_password_hash: pwdHash
          });
          if (applyError) throw applyError;

          const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
          if (googleScriptUrl) {
            try {
              const formBody = new URLSearchParams({ course: courseTitle, bizName: reqBody.bizName, bizNo: reqBody.bizNo, dept: reqBody.dept, position: reqBody.position, name: reqBody.name, phone: reqBody.phone, email: reqBody.email, privacy: reqBody.privacy });
              await fetch(googleScriptUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody });
              await dbClient.from('education_apply').update({ sync_status: 'success' }).eq('id', applyId);
            } catch (err) {
              await dbClient.from('education_apply').update({ sync_status: 'failed', sync_error: err.message }).eq('id', applyId);
            }
          }
          return jsonRes(200, { result: 'success' });
        }
        else if (action === 'retry_sync') {
          if (isPublic || !isAdmin) return jsonRes(403, { result: 'error', msg: 'Forbidden' });
          const { data: applyData, error: applyDataError } = await dbClient.from('education_apply').select('*, courses(title)').eq('id', reqBody.id).single();
          if (applyDataError || !applyData) return jsonRes(404, { result: 'error', msg: 'Application not found' });
          
          const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
          if (!googleScriptUrl) return jsonRes(500, { result: 'error', msg: 'Google Script URL not configured' });
          
          try {
              const formBody = new URLSearchParams({
                  course: applyData.courses.title, bizName: applyData.company, bizNo: applyData.biz_no,
                  dept: applyData.dept, position: applyData.position, name: applyData.name,
                  phone: applyData.phone, email: applyData.email, privacy: 'Y'
              });
              await fetch(googleScriptUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody });
              await dbClient.from('education_apply').update({ sync_status: 'success', sync_error: null, sync_retries: (applyData.sync_retries || 0) + 1 }).eq('id', reqBody.id);
              return jsonRes(200, { result: 'success' });
          } catch (err) {
              await dbClient.from('education_apply').update({ sync_status: 'failed', sync_error: err.message, sync_retries: (applyData.sync_retries || 0) + 1 }).eq('id', reqBody.id);
              return jsonRes(500, { result: 'error', msg: err.message });
          }
        }
    } catch (err) {
      console.error('Database POST Error:', err);
      return jsonRes(500, { result: 'error', msg: err.message });
    }
  }

  return jsonRes(405, { result: 'error', msg: 'Error' });
}




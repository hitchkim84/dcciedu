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

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // OPTIONS: Always Allow (CORS)
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS,PATCH,DELETE,POST,PUT', 'Access-Control-Allow-Headers': 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization' }, body: '' };
    return;
  }

  if (!supabase) {
    return return jsonRes(500, { result: 'error', msg: 'Server Configuration Error: Supabase client is not initialized. Please ensure SUPABASE_URL and SUPABASE_KEY environment variables are configured in the Vercel dashboard.' });
  }

  const isPublic = event.queryStringParameters.type === 'public';
  let dbClient = supabase;

  if (!isPublic) {
    const authHeader = event.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return return jsonRes(401, { result: 'error', msg: 'Unauthorized: Missing session token' });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return return jsonRes(401, { result: 'error', msg: 'Unauthorized: Invalid or expired session' });
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
      return return jsonRes(500, { result: 'error', msg: 'Failed to authenticate database client.' });
    }
  }

  // GET Request: Fetch courses and applicants count/list
  if (event.httpMethod === 'GET') {
    try {
      if (isPublic) {
        res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=3600");
        // Query the public view which has the pre-calculated applicant counts
        const { data: courses, error } = await dbClient
          .from('public_courses')
          .select('*');

        if (error) throw error;

        // Map to response format
        const responseData = {};
        courses.forEach(course => {
            let cost = "臾대즺 / 蹂꾨룄 臾몄쓽";
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
        return return jsonRes(200, responseData);
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
            privacy: app.agree_privacy ? "?숈쓽?? : "誘몃룞??,
            memberType: "",
            feeStatus: "",
            councilType: ""
          }));

          let cost = "臾대즺 / 蹂꾨룄 臾몄쓽";
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
        return return jsonRes(200, responseData);
      }
    } catch (err) {
      console.error('Database GET Error:', err);
      return return jsonRes(500, { result: 'error', msg: err.message });
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
        return return jsonRes(200, { result: 'success', id: data[0].id });
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
        return return jsonRes(200, { result: 'success' });
      }

      // 3. Delete course
      else if (action === 'delete_course') {
        const { error } = await dbClient
          .from('courses')
          .delete()
          .eq('id', reqBody.id);

        if (error) throw error;
        return return jsonRes(200, { result: 'success' });
      }

      // 4. Submit applicant registration (No action/default action)
      else {
        const courseTitle = reqBody.course;
        if (!courseTitle) {
          return return jsonRes(400, { result: 'error', msg: 'Missing course title.' });
        }

        // Find course ID by title
        const { data: courseData, error: courseError } = await dbClient
          .from('courses')
          .select('id')
          .eq('title', courseTitle.trim())
          .limit(1);

        if (courseError) throw courseError;
        if (!courseData || courseData.length === 0) {
          return return jsonRes(404, { result: 'error', msg: '?대떦 怨쇱젙??李얠쓣 ???놁뒿?덈떎.' });
        }

        const courseId = courseData[0].id;

        // Insert registration record to Supabase
        const { error: applyError } = await dbClient
          .from('education_apply')
          .insert([{
            course_id: courseId,
            company: reqBody.bizName,
            biz_no: reqBody.bizNo,
            dept: reqBody.dept,
            position: reqBody.position,
            name: reqBody.name,
            phone: reqBody.phone,
            email: reqBody.email,
            agree_privacy: reqBody.privacy === '?숈쓽?? || reqBody.privacy === 'true' || reqBody.privacy === true
          }]);

        if (applyError) throw applyError;

        // Sync registration to Google Sheets (if configured)
        const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
        if (googleScriptUrl) {
          try {
            const formBody = new URLSearchParams({
              course: reqBody.course,
              bizName: reqBody.bizName,
              bizNo: reqBody.bizNo,
              dept: reqBody.dept,
              position: reqBody.position,
              name: reqBody.name,
              phone: reqBody.phone,
              email: reqBody.email,
              privacy: reqBody.privacy
            });

            await fetch(googleScriptUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
              },
              body: formBody
            });
          } catch (syncErr) {
            console.error('Failed to sync to Google Sheets:', syncErr);
            // Non-blocking: we do not fail the request if Google Sheets sync fails
          }
        }

        return return jsonRes(200, { result: 'success' });
      }
    } catch (err) {
      console.error('Database POST Error:', err);
      return return jsonRes(500, { result: 'error', msg: err.message });
    }
  }

  return return jsonRes(405, { result: 'error', msg: 'Method Not Allowed' });
}



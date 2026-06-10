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
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (!supabase) {
    return res.status(500).json({ result: 'error', msg: 'Server Configuration Error: Supabase client is not initialized. Please ensure SUPABASE_URL and SUPABASE_KEY environment variables are configured in the Vercel dashboard.' });
  }

  const isPublic = req.query.type === 'public';

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
  }

  // GET Request: Fetch courses and applicants count/list
  if (req.method === 'GET') {
    try {
      const { data: courses, error } = await supabase
        .from('courses')
        .select('*, education_apply(*)');

      if (error) throw error;

      // Format response to dictionary keyed by ID (matches frontend Apps Script expected format)
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
          privacy: app.agree_privacy ? "동의함" : "미동의",
          memberType: "",
          feeStatus: "",
          councilType: ""
        }));

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
          contact: course.contact || "",
          paymentInfo: course.payment_info || "",
          otherInfo: course.other_info || "",
          current: apps.length,
          applicants: apps
        };
      });

      let finalData = responseData;

      if (isPublic) {
        // Whitelist Filtering for Public Access (Strip out applicants list for privacy)
        const ALLOWED_FIELDS = [
          'id', 'category', 'title', 'date', 'place', 'capacity', 'current',
          'deadline', 'target', 'goal', 'instructor', 'content',
          'paymentInfo', 'otherInfo', 'contact', 'courseName', 'month', 'status', 'link',
          'result', 'msg'
        ];

        const filteredData = {};
        Object.keys(responseData).forEach(key => {
          const item = responseData[key];
          const filteredItem = {};
          ALLOWED_FIELDS.forEach(field => {
            if (item[field] !== undefined) filteredItem[field] = item[field];
          });
          filteredData[key] = filteredItem;
        });
        finalData = filteredData;
      }

      return res.status(200).json(finalData);
    } catch (err) {
      console.error('Database GET Error:', err);
      return res.status(500).json({ result: 'error', msg: err.message });
    }
  }

  // POST Request: Add/Update/Delete courses or Submit application
  if (req.method === 'POST') {
    try {
      const { action } = req.body;

      // 1. Add course
      if (action === 'add_course') {
        const { data, error } = await supabase
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
            contact: req.body.contact,
            payment_info: req.body.paymentInfo,
            other_info: req.body.otherInfo
          }])
          .select();

        if (error) throw error;
        return res.status(200).json({ result: 'success', id: data[0].id });
      }

      // 2. Update course
      else if (action === 'update_course') {
        const { error } = await supabase
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
            contact: req.body.contact,
            payment_info: req.body.paymentInfo,
            other_info: req.body.otherInfo
          })
          .eq('id', req.body.id);

        if (error) throw error;
        return res.status(200).json({ result: 'success' });
      }

      // 3. Delete course
      else if (action === 'delete_course') {
        const { error } = await supabase
          .from('courses')
          .delete()
          .eq('id', req.body.id);

        if (error) throw error;
        return res.status(200).json({ result: 'success' });
      }

      // 4. Submit applicant registration (No action/default action)
      else {
        const courseTitle = req.body.course;
        if (!courseTitle) {
          return res.status(400).json({ result: 'error', msg: 'Missing course title.' });
        }

        // Find course ID by title
        const { data: courseData, error: courseError } = await supabase
          .from('courses')
          .select('id')
          .eq('title', courseTitle.trim())
          .limit(1);

        if (courseError) throw courseError;
        if (!courseData || courseData.length === 0) {
          return res.status(404).json({ result: 'error', msg: '해당 과정을 찾을 수 없습니다.' });
        }

        const courseId = courseData[0].id;

        // Insert registration record to Supabase
        const { error: applyError } = await supabase
          .from('education_apply')
          .insert([{
            course_id: courseId,
            company: req.body.bizName,
            biz_no: req.body.bizNo,
            dept: req.body.dept,
            position: req.body.position,
            name: req.body.name,
            phone: req.body.phone,
            email: req.body.email,
            agree_privacy: req.body.privacy === '동의함' || req.body.privacy === 'true' || req.body.privacy === true
          }]);

        if (applyError) throw applyError;

        // Sync registration to Google Sheets (if configured)
        const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
        if (googleScriptUrl) {
          try {
            const formBody = new URLSearchParams({
              course: req.body.course,
              bizName: req.body.bizName,
              bizNo: req.body.bizNo,
              dept: req.body.dept,
              position: req.body.position,
              name: req.body.name,
              phone: req.body.phone,
              email: req.body.email,
              privacy: req.body.privacy
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

        return res.status(200).json({ result: 'success' });
      }
    } catch (err) {
      console.error('Database POST Error:', err);
      return res.status(500).json({ result: 'error', msg: err.message });
    }
  }

  return res.status(405).json({ result: 'error', msg: 'Method Not Allowed' });
}

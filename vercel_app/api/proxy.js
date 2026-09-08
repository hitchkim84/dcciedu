module.exports = async function handler(req, res) {
  const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbzZiOrqzVLavEDpGmMf1jCj1fpcg9-GowGxVlOrcdZ7xMXZnfSLG2dbEupX25TNZcIUBA/exec";

  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-admin-password');

  // 1. OPTIONS: Always Allow (CORS)
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // [보안 로직] 공개(Public) vs 관리자(Admin) 분리
  const isPublic = req.query.type === 'public';

  if (!isPublic) {
    const serverPassword = process.env.ADMIN_PASSWORD || "dccitpt3102";
    const clientPassword = req.headers['x-admin-password'] || req.query.password;

    if (serverPassword && clientPassword !== serverPassword) {
      return res.status(401).json({ result: 'error', msg: 'Unauthorized: 관리자 비밀번호가 올바르지 않습니다.' });
    }
  }

  try {
    // Google Apps Script 대상 URL 생성
    const targetUrl = new URL(SCRIPT_URL);
    Object.keys(req.query).forEach(key => {
      targetUrl.searchParams.append(key, req.query[key]);
    });

    const options = {
      method: req.method,
      headers: {}
    };

    if (req.method === 'POST') {
      const formBody = new URLSearchParams(req.body);
      options.body = formBody;
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    // Google Apps Script 호출
    const googleResponse = await fetch(targetUrl.toString(), options);
    const text = await googleResponse.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error("Failed to parse JSON from Google Script:", text);
      return res.status(502).json({ result: 'error', msg: 'Google Script 응답 형식 오류', raw: text });
    }

    // 메인 페이지(Public) 조회 시 개인정보 화이트리스트 필터링
    if (isPublic) {
      const ALLOWED_FIELDS = [
        'id', 'category', 'title', 'date', 'place', 'capacity', 'current',
        'deadline', 'target', 'goal', 'instructor', 'content',
        'paymentInfo', 'otherInfo', 'contact', 'courseName', 'month', 'status', 'link',
        'result', 'msg'
      ];

      if (Array.isArray(data)) {
        data = data.map(item => {
          const filtered = {};
          ALLOWED_FIELDS.forEach(field => {
            if (item[field] !== undefined) filtered[field] = item[field];
          });
          return filtered;
        });
      } else if (typeof data === 'object' && data !== null) {
        const filteredData = {};
        Object.keys(data).forEach(key => {
          if (key === 'result' || key === 'msg') {
            filteredData[key] = data[key];
            return;
          }

          const item = data[key];
          if (typeof item === 'object' && item !== null) {
            const filteredItem = {};
            ALLOWED_FIELDS.forEach(field => {
              if (item[field] !== undefined) filteredItem[field] = item[field];
            });
            filteredData[key] = filteredItem;
          }
        });
        data = filteredData;
      }
    }

    res.status(200).json(data);
  } catch (error) {
    console.error('Proxy Error:', error);
    res.status(500).json({ result: 'error', msg: error.message });
  }
};

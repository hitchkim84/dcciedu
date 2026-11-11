const { createClient } = require('@supabase/supabase-js');

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': 'https://dcciedu.co.kr',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version',
    'Cache-Control': 's-maxage=86400, stale-while-revalidate=86400'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // 공개 키 자리에 서비스 키가 잘못 들어가 있으면 브라우저로 내보내지 않는다(DB 규칙을 모두 무시하는 키).
  const key = process.env.SUPABASE_KEY || "";
  let isService = key.startsWith('sb_secret_');
  try { isService = isService || JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString('utf8')).role === 'service_role'; } catch (e) { /* 공개 키 형식 */ }
  if (isService) console.error('SUPABASE_KEY looks like a service key: not sending it to the browser');

  const responseBody = {
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseKey: isService ? "" : key, // anon key only
    naverClientId: process.env.NAVER_CLIENT_ID || "",
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || "", // 공개용 사이트 키 (비밀키 아님)
    hasClient: typeof createClient === 'function'
  };

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(responseBody)
  };
};

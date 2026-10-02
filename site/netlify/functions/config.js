const { createClient } = require('@supabase/supabase-js');

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Credentials': true,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version',
    'Cache-Control': 's-maxage=86400, stale-while-revalidate=86400'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const responseBody = {
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseKey: process.env.SUPABASE_KEY || "", // anon key only
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

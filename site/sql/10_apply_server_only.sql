-- 10. 신청 함수를 서버(Netlify 함수)만 호출하도록 제한
-- 목적: 홈페이지에 공개된 키(anon)로 Supabase에 직접 신청을 보내 로봇 확인(Turnstile)을 건너뛰는 것을 막는다.
-- !! 실행 전 필수: Netlify 환경변수에 SUPABASE_SERVICE_ROLE_KEY가 등록되어 있고,
--    로봇 확인 코드가 배포된 상태여야 한다. 키 없이 실행하면 홈페이지 신청이 모두 실패한다.
-- 되돌리기: GRANT EXECUTE ON FUNCTION atomic_course_apply(uuid, text, text, text, text, text, text, text, text, boolean, text, text) TO anon, authenticated;
-- Supabase SQL Editor에서 전체를 실행한다. 여러 번 실행해도 안전하다.

REVOKE EXECUTE ON FUNCTION atomic_course_apply(uuid, text, text, text, text, text, text, text, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION atomic_course_apply(uuid, text, text, text, text, text, text, text, text, boolean, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

-- 확인: anon=false, service_role=true 여야 한다.
SELECT has_function_privilege('anon', 'atomic_course_apply(uuid, text, text, text, text, text, text, text, text, boolean, text, text)', 'EXECUTE') AS anon_can_call,
       has_function_privilege('service_role', 'atomic_course_apply(uuid, text, text, text, text, text, text, text, text, boolean, text, text)', 'EXECUTE') AS server_can_call;

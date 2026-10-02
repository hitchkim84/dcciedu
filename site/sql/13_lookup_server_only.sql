-- 13. 신청 확인 조회 함수를 서버(Netlify 함수)만 호출하도록 제한
-- !! 실행 전 필수: sql/12 실행 + 조회를 서버 전용 키로 호출하는 새 홈페이지 코드(proxy.js)가 배포된 상태.
--    옛 코드 상태에서 실행하면 홈페이지 '신청 확인'이 실패한다.
-- 되돌리기: GRANT EXECUTE ON FUNCTION public.lookup_my_applications(text, text, text) TO anon, authenticated;
-- Supabase SQL Editor에서 전체를 실행한다. 여러 번 실행해도 안전하다.

REVOKE ALL ON FUNCTION public.lookup_my_applications(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_my_applications(text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

-- 확인: anon=false, service_role=true 여야 한다.
SELECT has_function_privilege('anon', 'public.lookup_my_applications(text, text, text)', 'EXECUTE') AS anon_can_call,
       has_function_privilege('service_role', 'public.lookup_my_applications(text, text, text)', 'EXECUTE') AS server_can_call;

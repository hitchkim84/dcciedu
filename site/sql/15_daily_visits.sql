-- 15. 홈페이지 접속 횟수(날짜별 숫자만)
-- 홈페이지가 열릴 때 서버가 오늘 날짜(한국 시간)의 숫자를 1 올린다.
-- IP·브라우저 정보 등 개인정보는 저장하지 않는다(날짜와 횟수뿐). 사람 수가 아니라 접속 횟수다.
-- 홈페이지·관리자 키로는 읽거나 쓸 수 없고, 서버(서비스 키)만 숫자를 올린다. 조회는 Supabase SQL Editor에서 한다(아래 '조회').
-- 홈페이지 배포 전후 언제 실행해도 된다(배포 전에는 숫자가 쌓이지 않을 뿐). 여러 번 실행해도 안전하다.

BEGIN;

CREATE TABLE IF NOT EXISTS public.daily_visits (
  day date PRIMARY KEY,
  visits integer NOT NULL DEFAULT 0
);
ALTER TABLE public.daily_visits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.daily_visits FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.count_visit() RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.daily_visits (day, visits)
  VALUES ((now() AT TIME ZONE 'Asia/Seoul')::date, 1)
  ON CONFLICT (day) DO UPDATE SET visits = public.daily_visits.visits + 1;
END;
$$;
REVOKE ALL ON FUNCTION public.count_visit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_visit() TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 확인: 표가 있고 함수는 서버 키(service_role)만 실행할 수 있어야 한다(anon=false, authenticated=false, service_role=true).
SELECT has_function_privilege('anon', 'public.count_visit()', 'EXECUTE') AS anon,
       has_function_privilege('authenticated', 'public.count_visit()', 'EXECUTE') AS authenticated,
       has_function_privilege('service_role', 'public.count_visit()', 'EXECUTE') AS service_role;

-- ─────────────────────────────────────────────
-- 조회 (SQL Editor에서 필요한 쿼리만 골라 실행)
-- 최근 30일 날짜별:
--   SELECT day AS 날짜, visits AS 접속 FROM public.daily_visits ORDER BY day DESC LIMIT 30;
-- 월별 합계:
--   SELECT to_char(day, 'YYYY-MM') AS 월, sum(visits) AS 접속 FROM public.daily_visits GROUP BY 1 ORDER BY 1 DESC;
-- ─────────────────────────────────────────────

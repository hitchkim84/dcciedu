-- 19. 홈페이지 유입 경로(날짜별·경로별 접속 횟수)
-- 홈페이지가 열릴 때 서버가 "어디서 왔는지"를 짧은 이름으로만 센다. 개인정보(IP·브라우저·검색어·전체 주소)는 저장하지 않는다.
--   - 홍보 링크에 꼬리표를 붙이면 그 이름으로 센다: https://dcciedu.co.kr/?from=news (영문 소문자·숫자·-·_ 20자 이내)
--   - 꼬리표가 없으면 들어온 사이트 종류로 센다: naver, google, daum, bing, kakaotalk(카톡 안 브라우저), dcci(대구상의 홈페이지), etc(그 밖), direct(주소 직접 입력·즐겨찾기·앱 등)
-- 서버(서비스 키)만 숫자를 올린다. 홈페이지·관리자 키로는 읽거나 쓸 수 없고, 조회는 SQL Editor에서 한다(아래 '조회').
-- 하루에 경로가 50개를 넘으면 새 이름은 etc로 센다(장난으로 꼬리표를 마구 붙여도 표가 커지지 않게).
-- 기존 날짜별 합계(daily_visits, sql/15)도 같은 함수에서 함께 올린다.
-- 홈페이지 배포 전에 실행한다(실행 전에 배포해도 날짜별 합계는 그대로 쌓이고 경로만 빠진다). 여러 번 실행해도 안전하다.

BEGIN;

CREATE TABLE IF NOT EXISTS public.daily_visit_sources (
  day date NOT NULL,
  source text NOT NULL CHECK (source ~ '^[a-z0-9_-]{1,20}$'),
  visits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);
ALTER TABLE public.daily_visit_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.daily_visit_sources FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.count_visit_from(p_source text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_day date := (now() AT TIME ZONE 'Asia/Seoul')::date;
  v_source text := lower(coalesce(p_source, ''));
BEGIN
  IF v_source !~ '^[a-z0-9_-]{1,20}$' THEN
    v_source := 'etc';
  END IF;
  -- 하루 경로 수 제한: 이미 50개면 처음 보는 이름은 etc로
  IF NOT EXISTS (SELECT 1 FROM public.daily_visit_sources WHERE day = v_day AND source = v_source)
     AND (SELECT count(*) FROM public.daily_visit_sources WHERE day = v_day) >= 50 THEN
    v_source := 'etc';
  END IF;

  INSERT INTO public.daily_visits (day, visits)
  VALUES (v_day, 1)
  ON CONFLICT (day) DO UPDATE SET visits = public.daily_visits.visits + 1;

  INSERT INTO public.daily_visit_sources (day, source, visits)
  VALUES (v_day, v_source, 1)
  ON CONFLICT (day, source) DO UPDATE SET visits = public.daily_visit_sources.visits + 1;
END;
$$;
REVOKE ALL ON FUNCTION public.count_visit_from(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_visit_from(text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 확인: 함수는 서버 키(service_role)만 실행할 수 있어야 한다(anon=false, authenticated=false, service_role=true).
SELECT has_function_privilege('anon', 'public.count_visit_from(text)', 'EXECUTE') AS anon,
       has_function_privilege('authenticated', 'public.count_visit_from(text)', 'EXECUTE') AS authenticated,
       has_function_privilege('service_role', 'public.count_visit_from(text)', 'EXECUTE') AS service_role;

-- ─────────────────────────────────────────────
-- 조회 (SQL Editor에서 필요한 쿼리만 골라 실행)
-- 최근 7일 경로별 합계:
--   SELECT source AS 경로, sum(visits) AS 접속 FROM public.daily_visit_sources
--    WHERE day >= (now() AT TIME ZONE 'Asia/Seoul')::date - 6 GROUP BY 1 ORDER BY 2 DESC;
-- 날짜별·경로별:
--   SELECT day AS 날짜, source AS 경로, visits AS 접속 FROM public.daily_visit_sources ORDER BY day DESC, visits DESC LIMIT 100;
-- ─────────────────────────────────────────────

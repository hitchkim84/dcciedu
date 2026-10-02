-- 08. 신청자 본인 확인(조회) 함수
-- (2026-10) 함수 내용·권한은 sql/12, sql/13이 대체한다. 이 파일을 다시 실행했다면 sql/12와 sql/13을 다시 실행한다.
-- 이름 + 휴대폰 + 이메일 3가지가 모두 일치하는 신청만 돌려준다.
-- 돌려주는 값은 과정명·교육일시·신청일시뿐이고, 개인정보(연락처·이메일·회사 등)는 돌려주지 않는다.
-- 반복 조회 제한: 같은 휴대폰 번호 15분에 5회, 전체 10분에 200회. 넘으면 잠시 후 다시 하도록 안내한다.
-- 조회 기록(lookup_log)에는 휴대폰 번호 원문 대신 해시만 남기고, 하루가 지나면 지운다.
-- 신청 접수 함수(atomic_course_apply)와 관리자 규칙은 바꾸지 않는다.
-- Supabase SQL Editor에서 전체를 실행한다. 여러 번 실행해도 안전하다.

CREATE TABLE IF NOT EXISTS lookup_log (
  id bigserial PRIMARY KEY,
  phone_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lookup_log_created_at_idx ON lookup_log (created_at);
CREATE INDEX IF NOT EXISTS lookup_log_phone_key_idx ON lookup_log (phone_key, created_at);

-- 조회 기록은 함수 안에서만 쓴다. 홈페이지 API로는 읽기·쓰기 불가.
ALTER TABLE lookup_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON lookup_log FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION lookup_my_applications(
  p_name text,
  p_phone text,
  p_email text
) RETURNS TABLE (course_title text, course_date text, applied_at text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone_digits text;
  v_phone_key text;
  v_recent_phone int;
  v_recent_all int;
BEGIN
  -- 1. 입력값 검증 (신청 함수와 같은 기준)
  IF coalesce(btrim(p_name), '') = '' OR coalesce(btrim(p_phone), '') = '' OR coalesce(btrim(p_email), '') = '' THEN
    RAISE EXCEPTION '이름, 휴대폰, 이메일을 모두 입력해주세요.';
  END IF;
  IF length(p_name) > 50 OR length(p_phone) > 20 OR length(p_email) > 100 THEN
    RAISE EXCEPTION '입력값이 너무 깁니다.';
  END IF;
  v_phone_digits := regexp_replace(p_phone, '\D', '', 'g');
  IF length(v_phone_digits) NOT BETWEEN 9 AND 11 THEN
    RAISE EXCEPTION '연락처를 정확히 입력해주세요.';
  END IF;

  -- 2. 반복 조회 제한
  v_phone_key := md5('dcciedu-lookup:' || v_phone_digits);
  DELETE FROM lookup_log WHERE created_at < now() - interval '1 day';

  SELECT count(*) INTO v_recent_phone FROM lookup_log
   WHERE phone_key = v_phone_key AND created_at > now() - interval '15 minutes';
  SELECT count(*) INTO v_recent_all FROM lookup_log
   WHERE created_at > now() - interval '10 minutes';
  IF v_recent_phone >= 5 OR v_recent_all >= 200 THEN
    RAISE EXCEPTION '조회 요청이 많습니다. 잠시 후 다시 시도해주세요.';
  END IF;

  INSERT INTO lookup_log (phone_key) VALUES (v_phone_key);

  -- 3. 3가지가 모두 일치하는 신청만 (개인정보는 돌려주지 않음)
  RETURN QUERY
  SELECT c.title::text,
         c.date::text,
         to_char(a.created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI')
    FROM education_apply a
    JOIN courses c ON c.id = a.course_id
   WHERE btrim(a.name) = btrim(p_name)
     AND regexp_replace(a.phone, '\D', '', 'g') = v_phone_digits
     AND lower(btrim(a.email)) = lower(btrim(p_email))
   ORDER BY a.created_at DESC
   LIMIT 20;
END;
$$;

GRANT EXECUTE ON FUNCTION lookup_my_applications(text, text, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

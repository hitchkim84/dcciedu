-- 12. 보안 보강 (외부 교차 검토 반영)
-- 홈페이지 배포 전에 실행해도 된다(지금 운영 중인 코드와 함께 동작한다).
-- 실행 순서: ① sql/check_security.sql(읽기 전용)로 현재 상태 저장 → ② 이 파일 전체 실행
--            → ③ 홈페이지 배포 → ④ sql/13 실행 → ⑤ check_security.sql 다시 실행해 비교
-- 여러 번 실행해도 안전하다. Supabase SQL Editor에서 전체를 한 번에 실행한다(중간에 오류가 나면 전체 취소).
--
-- 바뀌는 것
--  A. 접근 규칙(RLS) 재정비: courses·education_apply·lookup_log의 규칙을 모두 지우고 아래 목록만 다시 만든다.
--     (sql/01의 'Allow admin …'처럼 OTP 조건 없는 옛 규칙이 남아 있어도 함께 지워진다)
--     - 과정 조회: 누구나 / 과정 등록·수정·삭제: 관리자 + OTP(aal2)
--     - 신청자 조회·수정·삭제: 관리자 + OTP(aal2) / 신청 직접 등록: 규칙 없음(=불가, 신청 함수로만)
--     - 조회 기록(lookup_log): 규칙 없음(=API로 접근 불가)
--  B. 표·뷰 권한 축소: 비로그인(anon)은 과정 읽기만, 신청 표는 접근 불가. TRUNCATE 등 쓰지 않는 권한 회수.
--     공개 뷰(public_courses)는 읽기만 허용한다. (Supabase 기본 권한으로 뷰에 쓰기 권한이 있으면
--     홈페이지 키로 뷰를 통해 과정을 고치거나 지울 수 있다. 뷰는 소유자 권한으로 동작해 RLS를 거치지 않기 때문)
--  C. 과정 삭제 보호: 신청자가 있는 과정은 삭제되지 않게 한다(ON DELETE CASCADE → RESTRICT).
--  D. 교육 종료일(end_date) 칸 추가. 개인정보 파기는 '교육 종료일 + 1년' 기준으로만 한다.
--     종료일이 비어 있는 과정의 신청은 지우지 않는다(관리자 페이지에서 종료일을 입력해야 파기 대상이 됨).
--  E. SECURITY DEFINER 함수: search_path를 비우고 모든 표를 public.으로 지정. 신청 함수는 서버 전용 키(service_role)만 실행.
--     (신청 확인 조회 함수는 새 코드 배포 뒤 sql/13에서 서버 전용으로 바꾼다)
--     신청·조회 횟수 제한은 잠금(advisory lock)을 건 뒤 세어서 동시 요청으로 제한을 넘지 못하게 한다.
--  F. 조회 기록 정리를 조회 함수 밖으로 분리해 매일 자동 실행. 자동 실행 성공 여부 확인 쿼리는 check_cron.sql에 있다.
--  G. 위 3개 외에 public 스키마의 SECURITY DEFINER 함수는 홈페이지 키(anon·authenticated)로 실행하지 못하게 한다.

BEGIN;

-- ─────────────────────────────────────────────
-- A. 접근 규칙(RLS) 재정비
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lookup_log (
  id bigserial PRIMARY KEY,
  phone_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lookup_log_created_at_idx ON public.lookup_log (created_at);
CREATE INDEX IF NOT EXISTS lookup_log_phone_key_idx ON public.lookup_log (phone_key, created_at);

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies
            WHERE schemaname = 'public' AND tablename IN ('courses', 'education_apply', 'lookup_log')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.education_apply ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lookup_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read courses" ON public.courses FOR SELECT TO anon, authenticated
  USING (true);
CREATE POLICY "Admin can insert courses" ON public.courses FOR INSERT TO authenticated
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');
CREATE POLICY "Admin can update courses" ON public.courses FOR UPDATE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');
CREATE POLICY "Admin can delete courses" ON public.courses FOR DELETE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');

CREATE POLICY "Admin can view applications" ON public.education_apply FOR SELECT TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');
CREATE POLICY "Admin can update applications" ON public.education_apply FOR UPDATE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');
CREATE POLICY "Admin can delete applications" ON public.education_apply FOR DELETE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');

-- ─────────────────────────────────────────────
-- B. 표 권한 축소 (RLS와 별개로 한 번 더 막는다)
-- ─────────────────────────────────────────────
REVOKE ALL ON public.courses FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.courses TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.courses TO authenticated;

REVOKE ALL ON public.education_apply FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE, DELETE ON public.education_apply TO authenticated;

REVOKE ALL ON public.lookup_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.lookup_log_id_seq FROM PUBLIC, anon, authenticated;

-- public 스키마의 모든 뷰: 쓰기 권한 회수. 홈페이지 공개용 public_courses만 읽기 허용.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, anon, authenticated', r.rel);
  END LOOP;
  IF to_regclass('public.public_courses') IS NOT NULL THEN
    GRANT SELECT ON public.public_courses TO anon, authenticated;
  END IF;
END $$;

-- ─────────────────────────────────────────────
-- C. 신청자가 있는 과정은 삭제 불가 (신청 행이 함께 지워지는 것 방지)
-- ─────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.education_apply'::regclass
              AND confrelid = 'public.courses'::regclass
              AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE public.education_apply DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.education_apply
  ADD CONSTRAINT education_apply_course_id_fkey
  FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE RESTRICT;

-- ─────────────────────────────────────────────
-- D. 교육 종료일
-- ─────────────────────────────────────────────
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS end_date date;
CREATE INDEX IF NOT EXISTS education_apply_course_id_idx ON public.education_apply (course_id);

-- ─────────────────────────────────────────────
-- E-1. 신청 함수 (서버 전용, 같은 전화번호 요청은 잠금 후 처리)
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.atomic_course_apply(
  p_course_id uuid,
  p_req_id text,
  p_company text,
  p_biz_no text,
  p_dept text,
  p_position text,
  p_name text,
  p_phone text,
  p_email text,
  p_agree_privacy boolean,
  p_lookup_id text,
  p_lookup_password_hash text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_capacity int;
  v_current int;
  v_deadline date;
  v_apply_id uuid;
  v_existing_apply_id uuid;
  v_existing_course_id uuid;
  v_phone_digits text;
  v_recent int;
BEGIN
  -- 1. 입력값 검증 (proxy.js의 MAX_LEN과 같은 기준)
  IF coalesce(btrim(p_company), '') = '' OR coalesce(btrim(p_name), '') = ''
     OR coalesce(btrim(p_email), '') = '' OR coalesce(btrim(p_phone), '') = ''
     OR coalesce(p_req_id, '') = '' THEN
    RAISE EXCEPTION '필수 입력값이 누락되었습니다.';
  END IF;

  IF length(p_name) > 50 OR length(p_company) > 100 OR length(p_email) > 100
     OR length(p_phone) > 20 OR length(coalesce(p_biz_no, '')) > 20
     OR length(coalesce(p_dept, '')) > 50 OR length(coalesce(p_position, '')) > 50
     OR length(p_req_id) > 100 THEN
    RAISE EXCEPTION '입력값이 너무 깁니다.';
  END IF;

  v_phone_digits := regexp_replace(p_phone, '\D', '', 'g');
  IF length(v_phone_digits) NOT BETWEEN 9 AND 11 THEN
    RAISE EXCEPTION '연락처를 정확히 입력해주세요.';
  END IF;

  IF p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION '이메일 주소를 정확히 입력해주세요.';
  END IF;

  IF p_agree_privacy IS DISTINCT FROM true THEN
    RAISE EXCEPTION '개인정보 수집 및 이용에 동의해야 합니다.';
  END IF;

  -- 2. 같은 전화번호의 요청은 한 번에 하나씩 처리 (트랜잭션이 끝나면 자동으로 풀림)
  --    잠금 뒤에 세므로 동시에 여러 건을 보내도 10분 5건 제한을 넘지 못한다.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dcciedu-apply:' || v_phone_digits, 0));

  -- 3. 중복 요청(멱등성): 같은 req_id로 이미 저장된 신청이 있으면 그 ID를 그대로 반환
  SELECT id, course_id INTO v_existing_apply_id, v_existing_course_id
  FROM public.education_apply
  WHERE req_id = p_req_id;

  IF FOUND THEN
    IF v_existing_course_id != p_course_id THEN
      RAISE EXCEPTION '요청 식별자 충돌(Collision). 비정상적인 재시도입니다.';
    END IF;
    RETURN v_existing_apply_id;
  END IF;

  -- 4. 반복 신청 제한: 같은 전화번호로 최근 10분 안에 5건 이상이면 거절
  SELECT count(*) INTO v_recent
  FROM public.education_apply
  WHERE created_at > now() - interval '10 minutes'
    AND regexp_replace(phone, '\D', '', 'g') = v_phone_digits;

  IF v_recent >= 5 THEN
    RAISE EXCEPTION '짧은 시간에 신청이 너무 많습니다. 잠시 후 다시 시도해주세요.';
  END IF;

  -- 5. 과정 잠금(동시 신청 시 정원 초과 방지)
  SELECT capacity, deadline INTO v_capacity, v_deadline
  FROM public.courses
  WHERE id = p_course_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '해당 과정을 찾을 수 없습니다.';
  END IF;

  -- 6. 마감일 당일 KST 23:59:59까지 접수
  IF v_deadline IS NOT NULL AND (now() AT TIME ZONE 'Asia/Seoul')::date > v_deadline THEN
    RAISE EXCEPTION '신청 기한이 마감되었습니다.';
  END IF;

  -- 7. 정원 초과 검증
  SELECT count(*) INTO v_current
  FROM public.education_apply
  WHERE course_id = p_course_id;

  IF v_capacity > 0 AND v_current >= v_capacity THEN
    RAISE EXCEPTION '정원이 초과되었습니다.';
  END IF;

  -- 8. 저장 (조회용 ID·비밀번호는 저장하지 않음)
  INSERT INTO public.education_apply (
    req_id, course_id, company, biz_no, dept, position, name, phone, email, agree_privacy
  ) VALUES (
    p_req_id, p_course_id, btrim(p_company), p_biz_no, p_dept, p_position, btrim(p_name), p_phone, btrim(p_email), true
  )
  RETURNING id INTO v_apply_id;

  RETURN v_apply_id;
END;
$$;

-- ─────────────────────────────────────────────
-- E-2. 신청 확인 조회 함수 (서버 전용, 조회 요청은 잠금 후 하나씩 처리)
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lookup_my_applications(
  p_name text,
  p_phone text,
  p_email text
) RETURNS TABLE (course_title text, course_date text, applied_at text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

  -- 2. 반복 조회 제한 (같은 휴대폰 15분 5회, 전체 10분 200회)
  --    전체 제한까지 정확히 지키려고 조회 요청 전체를 한 줄로 세운다(조회는 짧게 끝나므로 대기는 짧다).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dcciedu-lookup', 0));
  v_phone_key := md5('dcciedu-lookup:' || v_phone_digits);

  SELECT count(*) INTO v_recent_phone FROM public.lookup_log
   WHERE phone_key = v_phone_key AND created_at > now() - interval '15 minutes';
  SELECT count(*) INTO v_recent_all FROM public.lookup_log
   WHERE created_at > now() - interval '10 minutes';
  IF v_recent_phone >= 5 OR v_recent_all >= 200 THEN
    RAISE EXCEPTION '조회 요청이 많습니다. 잠시 후 다시 시도해주세요.';
  END IF;

  INSERT INTO public.lookup_log (phone_key) VALUES (v_phone_key);

  -- 3. 3가지가 모두 일치하는 신청만 (개인정보는 돌려주지 않음)
  RETURN QUERY
  SELECT c.title::text,
         c.date::text,
         to_char(a.created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI')
    FROM public.education_apply a
    JOIN public.courses c ON c.id = a.course_id
   WHERE btrim(a.name) = btrim(p_name)
     AND regexp_replace(a.phone, '\D', '', 'g') = v_phone_digits
     AND lower(btrim(a.email)) = lower(btrim(p_email))
   ORDER BY a.created_at DESC
   LIMIT 20;
END;
$$;

-- ─────────────────────────────────────────────
-- E-3. 개인정보 파기 함수: 교육 종료일 + 1년이 지난 신청만 삭제
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_old_applications() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.education_apply a
   USING public.courses c
   WHERE c.id = a.course_id
     AND c.end_date IS NOT NULL
     AND c.end_date < ((now() AT TIME ZONE 'Asia/Seoul')::date - interval '1 year')::date;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- 조회 기록 정리(하루 지난 기록 삭제). 매일 자동 실행한다.
CREATE OR REPLACE FUNCTION public.purge_lookup_log() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.lookup_log WHERE created_at < now() - interval '1 day';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- 실행 권한: 신청은 서버 전용 키만, 파기 함수는 DB 관리자·자동 실행만
-- 조회는 지금 운영 중인 코드가 홈페이지 키로 호출하므로 sql/13 전까지 유지한다.
REVOKE ALL ON FUNCTION public.atomic_course_apply(uuid, text, text, text, text, text, text, text, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_course_apply(uuid, text, text, text, text, text, text, text, text, boolean, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.lookup_my_applications(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_my_applications(text, text, text) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.purge_old_applications() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.purge_lookup_log() FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────
-- G. 그 밖의 SECURITY DEFINER 함수(옛 버전 포함)는 홈페이지 키로 실행 불가
--    (함수를 지우지는 않는다. 어떤 함수였는지는 check_security.sql 결과로 확인)
-- ─────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.prosecdef
              AND p.oid::regprocedure::text NOT IN (
                'atomic_course_apply(uuid,text,text,text,text,text,text,text,text,boolean,text,text)',
                'lookup_my_applications(text,text,text)',
                'purge_old_applications()',
                'purge_lookup_log()')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    RAISE NOTICE '홈페이지 키 실행 권한 회수: %', r.sig;
  END LOOP;
END $$;

COMMIT;

-- ─────────────────────────────────────────────
-- F. 자동 실행 등록 (pg_cron, 시간은 UTC)
--    신청 파기: 매월 1일 03:00 UTC / 조회 기록 정리: 매일 18:10 UTC(한국 새벽 3:10)
-- ─────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('purge-old-applications', 'purge-lookup-log');
SELECT cron.schedule('purge-old-applications', '0 3 1 * *', 'SELECT public.purge_old_applications();');
SELECT cron.schedule('purge-lookup-log', '10 18 * * *', 'SELECT public.purge_lookup_log();');

NOTIFY pgrst, 'reload schema';

-- 확인: 결과 비교는 check_security.sql로 한다.
SELECT jobname, schedule, command, active FROM cron.job WHERE jobname IN ('purge-old-applications', 'purge-lookup-log');

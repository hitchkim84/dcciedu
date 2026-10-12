-- 16. 회원사 교육비 자동 판별 (회비 납부 회원사 = 회원사 교육비, 그 밖 = 비회원사 교육비)
-- - member_companies: 회비 납부 회원사의 사업자등록번호(숫자 10자리)만 저장한다. 회사명·회원 구분·미납 여부·회비 금액은 저장하지 않는다.
--   슈퍼관리자(OTP 통과)만 보고 바꿀 수 있다(관리자 페이지 '회원사 명단'). 홈페이지 키·일반관리자는 읽을 수 없다.
--   반기마다 타부서에서 받은 명단으로 통째로 바꾸고(replace_member_companies), 그 사이에 낸 회사는 한 건씩 추가한다.
-- - courses: 회원사·비회원사 교육비(원, 1인·VAT 포함) 칸 추가. 비워 두면 교육비 없이 구분만 저장한다.
-- - education_apply: 신청 때 판별한 구분(fee_type: member/nonmember)과 적용 교육비(applied_fee) 저장. 관리자가 확인 후 고칠 수 있다.
-- - 신청 함수(atomic_course_apply): 사업자등록번호 필수(숫자 10자리) + 판별 추가. 이름·인자는 그대로다.
-- 실행 순서: sql/12~15 적용 상태에서 이 파일을 실행한 뒤 홈페이지를 배포한다.
--   (배포 전에 실행해도 된다. 다만 실행 후에는 사업자번호 없는 신청이 거절되므로, 홈페이지에서 사업자번호를 필수로 받는 배포를 바로 이어서 한다.)
-- 주의: sql/12를 다시 실행하면 신청 함수가 판별 없는 옛 버전으로 돌아간다. 그 경우 이 파일도 다시 실행한다.
-- 여러 번 실행해도 안전하다.

BEGIN;

-- 1. 회비 납부 회원사 명단
CREATE TABLE IF NOT EXISTS public.member_companies (
  biz_no text PRIMARY KEY CHECK (biz_no ~ '^[0-9]{10}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_companies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_companies FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.member_companies TO authenticated;
DROP POLICY IF EXISTS "Admin can view member companies" ON public.member_companies;
DROP POLICY IF EXISTS "Admin can insert member companies" ON public.member_companies;
DROP POLICY IF EXISTS "Admin can delete member companies" ON public.member_companies;
CREATE POLICY "Admin can view member companies" ON public.member_companies FOR SELECT TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');
CREATE POLICY "Admin can insert member companies" ON public.member_companies FOR INSERT TO authenticated
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');
CREATE POLICY "Admin can delete member companies" ON public.member_companies FOR DELETE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');

-- 명단 통째로 바꾸기: 지우기와 넣기를 한 번에(중간에 실패하면 원래 명단 유지).
-- 호출한 사람 권한으로 실행되므로(SECURITY INVOKER) 위 규칙에 따라 슈퍼관리자(OTP 통과)만 할 수 있다.
CREATE OR REPLACE FUNCTION public.replace_member_companies(p_biz_nos text[]) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF (auth.jwt() -> 'app_metadata' ->> 'role') IS DISTINCT FROM 'admin' OR (auth.jwt() ->> 'aal') IS DISTINCT FROM 'aal2' THEN
    RAISE EXCEPTION '슈퍼관리자(OTP 인증)만 회원사 명단을 바꿀 수 있습니다.';
  END IF;
  IF coalesce(array_length(p_biz_nos, 1), 0) = 0 THEN
    RAISE EXCEPTION '명단이 비어 있습니다.';
  END IF;
  DELETE FROM public.member_companies WHERE biz_no IS NOT NULL;
  INSERT INTO public.member_companies (biz_no)
    SELECT DISTINCT d FROM (SELECT regexp_replace(x, '\D', '', 'g') AS d FROM unnest(p_biz_nos) AS x) s
     WHERE d ~ '^[0-9]{10}$';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.replace_member_companies(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_member_companies(text[]) TO authenticated;

-- 2. 과정별 교육비, 신청별 구분·적용 교육비
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS member_fee integer CHECK (member_fee >= 0);
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS nonmember_fee integer CHECK (nonmember_fee >= 0);
ALTER TABLE public.education_apply ADD COLUMN IF NOT EXISTS fee_type text CHECK (fee_type IN ('member', 'nonmember'));
ALTER TABLE public.education_apply ADD COLUMN IF NOT EXISTS applied_fee integer CHECK (applied_fee >= 0);

-- 3. 신청 함수: 사업자번호 필수 + 회원사 판별 (sql/12 버전에 추가)
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
  v_biz_digits text;
  v_member_fee int;
  v_nonmember_fee int;
  v_fee_type text;
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

  -- 사업자등록번호 필수(숫자 10자리). 회원사 교육비 판별 기준이다(sql/16).
  v_biz_digits := regexp_replace(coalesce(p_biz_no, ''), '\D', '', 'g');
  IF length(v_biz_digits) <> 10 THEN
    RAISE EXCEPTION '사업자등록번호 10자리를 정확히 입력해주세요.';
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
  SELECT capacity, deadline, member_fee, nonmember_fee INTO v_capacity, v_deadline, v_member_fee, v_nonmember_fee
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

  -- 8. 회원사 교육비 판별: 회비 납부 회원사 명단(member_companies)에 있으면 회원사, 없으면 비회원사
  v_fee_type := CASE WHEN EXISTS (SELECT 1 FROM public.member_companies m WHERE m.biz_no = v_biz_digits)
                     THEN 'member' ELSE 'nonmember' END;

  -- 9. 저장 (조회용 ID·비밀번호는 저장하지 않음)
  INSERT INTO public.education_apply (
    req_id, course_id, company, biz_no, dept, position, name, phone, email, agree_privacy, fee_type, applied_fee
  ) VALUES (
    p_req_id, p_course_id, btrim(p_company), p_biz_no, p_dept, p_position, btrim(p_name), p_phone, btrim(p_email), true,
    v_fee_type, CASE WHEN v_fee_type = 'member' THEN v_member_fee ELSE v_nonmember_fee END
  )
  RETURNING id INTO v_apply_id;

  RETURN v_apply_id;
END;
$$;

REVOKE ALL ON FUNCTION public.atomic_course_apply(uuid, text, text, text, text, text, text, text, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_course_apply(uuid, text, text, text, text, text, text, text, text, boolean, text, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 확인: 1줄. member_companies 규칙 3개, 신청 함수는 서버 키만(anon=false, service_role=true)
SELECT (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'member_companies') AS 명단_규칙수,
       has_function_privilege('anon', 'public.atomic_course_apply(uuid,text,text,text,text,text,text,text,text,boolean,text,text)', 'EXECUTE') AS 신청함수_anon,
       has_function_privilege('service_role', 'public.atomic_course_apply(uuid,text,text,text,text,text,text,text,text,boolean,text,text)', 'EXECUTE') AS 신청함수_서버,
       (SELECT count(*) FROM public.member_companies) AS 등록된_회원사수;

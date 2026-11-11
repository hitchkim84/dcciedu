-- 24. 관리자 신청자 명단 조회를 "접속 기록과 한 묶음"으로 (기록 못 하면 명단도 안 나감)
-- 문제(2026-11 점검):
--   1) 서버가 명단을 돌려준 뒤 접속 기록을 남겨서, 기록에 실패해도 명단은 그대로 나갔다.
--   2) 관리자·일반관리자는 공개된 홈페이지 키와 자기 로그인 토큰으로 서버를 거치지 않고
--      DB(education_apply)를 직접 조회할 수 있었고, 이 경로는 접속 기록이 남지 않았다.
-- 해결: 신청자 개인정보는 이 함수로만 읽는다. 함수 안에서
--   ① 등급·OTP 확인(슈퍼관리자=aal2 필수, 일반관리자=명단 보기·엑셀만) → ② 명단 조회 → ③ 접속 기록 저장
--   을 한 번에 처리한다. 기록 저장이 실패하면 함수 전체가 실패해 명단이 나가지 않는다.
--   직접 조회 차단은 sql/25(홈페이지 배포 뒤 실행)에서 한다.
--
-- p_action: 'view_list'(명단 보기) | 'download_csv'(엑셀, p_course_id 필수) | 'notice_targets'(알림톡 대상, 슈퍼관리자만)
-- 실행 순서: 이 파일 → 홈페이지 배포 → sql/25. (이 파일만 실행한 상태에서도 기존 홈페이지는 그대로 동작한다.)
-- 여러 번 실행해도 안전하다. 되돌리기: DROP FUNCTION public.admin_read_applications(text, uuid, uuid[]);

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_read_applications(
  p_action text,
  p_course_id uuid DEFAULT NULL,
  p_ids uuid[] DEFAULT NULL
) RETURNS TABLE (
  id uuid, course_id uuid, created_at timestamptz,
  company text, biz_no text, dept text, "position" text, name text, phone text, email text,
  agree_privacy boolean, fee_type text, applied_fee integer,
  paid_at timestamptz, attended_at timestamptz,
  pay_notice_sent_at timestamptz, cancel_notice_sent_at timestamptz,
  class_notice_sent_at timestamptz, survey_notice_sent_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  -- 값이 없으면 빈 문자열로(NULL이면 아래 비교가 '거절'로 판정되지 않아 통과하는 것을 막음)
  v_role text := coalesce(v_claims -> 'app_metadata' ->> 'role', '');
  v_aal text := coalesce(v_claims ->> 'aal', '');
  v_sub text := v_claims ->> 'sub';
  v_n bigint;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('view_list', 'download_csv', 'notice_targets') THEN
    RAISE EXCEPTION '잘못된 요청입니다.' USING ERRCODE = '22023';
  END IF;
  -- 등급 확인: 슈퍼관리자는 OTP 통과(aal2)만, 일반관리자는 명단 보기·엑셀만
  IF NOT coalesce((v_role = 'admin' AND v_aal = 'aal2')
                   OR (v_role = 'staff' AND p_action IN ('view_list', 'download_csv')), false) THEN
    RAISE EXCEPTION '권한이 없습니다.' USING ERRCODE = '42501';
  END IF;
  IF p_action = 'download_csv' AND p_course_id IS NULL THEN
    RAISE EXCEPTION '잘못된 요청입니다.' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'notice_targets' AND p_course_id IS NULL AND p_ids IS NULL THEN
    RAISE EXCEPTION '잘못된 요청입니다.' USING ERRCODE = '22023';
  END IF;
  IF p_ids IS NOT NULL AND cardinality(p_ids) > 100 THEN
    RAISE EXCEPTION '한 번에 100건까지 조회할 수 있습니다.' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT a.id, a.course_id, a.created_at,
           a.company, a.biz_no, a.dept, a."position", a.name, a.phone, a.email,
           a.agree_privacy, a.fee_type, a.applied_fee,
           a.paid_at, a.attended_at,
           a.pay_notice_sent_at, a.cancel_notice_sent_at, a.class_notice_sent_at, a.survey_notice_sent_at
      FROM public.education_apply a
     WHERE (p_course_id IS NULL OR a.course_id = p_course_id)
       AND (p_ids IS NULL OR a.id = ANY (p_ids))
     ORDER BY a.created_at, a.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- 접속 기록(개인정보는 남기지 않고 건수·과정만). 실패하면 위 결과까지 모두 취소된다.
  INSERT INTO public.admin_access_log (user_id, user_email, user_role, action, detail)
  VALUES (
    CASE WHEN v_sub ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v_sub::uuid END,
    coalesce(v_claims ->> 'email', ''),
    v_role,
    p_action,
    left(concat_ws(', ',
      CASE WHEN p_course_id IS NOT NULL THEN '과정 ' || p_course_id END,
      CASE WHEN p_ids IS NOT NULL THEN '선택 ' || cardinality(p_ids) || '건' END,
      '조회 ' || v_n || '건'), 500)
  );
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_read_applications(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_read_applications(text, uuid, uuid[]) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 확인: definer=true, search_path 고정, 실행 가능 = authenticated만
SELECT p.prosecdef AS definer, p.proconfig AS config,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
  FROM pg_proc p
 WHERE p.oid = 'public.admin_read_applications(text, uuid, uuid[])'::regprocedure;

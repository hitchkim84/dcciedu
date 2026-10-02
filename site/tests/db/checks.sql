-- sql/12 적용 후 확인 (임시 DB 전용). 실패하면 오류로 멈추고, 통과하면 NOTICE를 남긴다.
\set ON_ERROR_STOP 1
UPDATE courses SET end_date = (now() AT TIME ZONE 'Asia/Seoul')::date - interval '2 years' WHERE id = '22222222-2222-2222-2222-222222222222';
UPDATE courses SET end_date = (now() AT TIME ZONE 'Asia/Seoul')::date - interval '6 months' WHERE id = '33333333-3333-3333-3333-333333333333';

CREATE FUNCTION pg_temp.as_role(p_role text, p_claims text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', p_claims, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql INTO v_n;
    RESET ROLE;
    RETURN 'rows=' || coalesce(v_n, 0);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RETURN 'error=' || SQLSTATE;
  END;
END $$;

DO $$
DECLARE
  aal1 text := '{"role":"authenticated","aal":"aal1","app_metadata":{"role":"admin"}}';
  aal2 text := '{"role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
  usr2 text := '{"role":"authenticated","aal":"aal2","app_metadata":{}}';
  staff1 text := '{"role":"authenticated","aal":"aal1","app_metadata":{"role":"staff"}}';
  staff2 text := '{"role":"authenticated","aal":"aal2","app_metadata":{"role":"staff"}}';
  r text;
  procedure_check record;
BEGIN
  -- 신청자 조회
  r := pg_temp.as_role('anon', '{}', 'SELECT count(*) FROM public.education_apply');
  IF r <> 'error=42501' THEN RAISE EXCEPTION '비로그인 신청자 조회: %', r; END IF;
  r := pg_temp.as_role('authenticated', aal1, 'SELECT count(*) FROM public.education_apply');
  IF r <> 'rows=0' THEN RAISE EXCEPTION '관리자 aal1 신청자 조회: %', r; END IF;
  r := pg_temp.as_role('authenticated', usr2, 'SELECT count(*) FROM public.education_apply');
  IF r <> 'rows=0' THEN RAISE EXCEPTION '일반 사용자 aal2 신청자 조회: %', r; END IF;
  r := pg_temp.as_role('authenticated', aal2, 'SELECT count(*) FROM public.education_apply');
  IF r = 'rows=0' OR r LIKE 'error%' THEN RAISE EXCEPTION '관리자 aal2 신청자 조회: %', r; END IF;
  RAISE NOTICE '신청자 조회: 비로그인 권한 없음, 관리자 aal1·일반 aal2는 0건, 관리자 aal2만 보임(%)', r;

  -- 일반관리자(staff, sql/14): OTP 통과 시 조회만, 쓰기·삭제 불가
  r := pg_temp.as_role('authenticated', staff2, 'SELECT count(*) FROM public.education_apply');
  IF r = 'rows=0' OR r LIKE 'error%' THEN RAISE EXCEPTION '일반관리자 aal2 조회: %', r; END IF;
  r := pg_temp.as_role('authenticated', staff1, 'SELECT count(*) FROM public.education_apply');
  IF r = 'rows=0' OR r LIKE 'error%' THEN RAISE EXCEPTION '일반관리자 OTP 없이 조회: %', r; END IF;
  r := pg_temp.as_role('authenticated', staff1, 'WITH x AS (DELETE FROM public.education_apply RETURNING 1) SELECT count(*) FROM x');
  IF r <> 'rows=0' THEN RAISE EXCEPTION '일반관리자 OTP 없이 삭제: %', r; END IF;
  r := pg_temp.as_role('authenticated', staff2, 'WITH x AS (DELETE FROM public.education_apply RETURNING 1) SELECT count(*) FROM x');
  IF r <> 'rows=0' THEN RAISE EXCEPTION '일반관리자 신청 삭제: %', r; END IF;
  r := pg_temp.as_role('authenticated', staff2, $q$WITH x AS (UPDATE public.education_apply SET status = 'x' RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'rows=0' THEN RAISE EXCEPTION '일반관리자 신청 수정: %', r; END IF;
  r := pg_temp.as_role('authenticated', staff2, $q$WITH x AS (UPDATE public.courses SET title = 'x' RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'rows=0' THEN RAISE EXCEPTION '일반관리자 과정 수정: %', r; END IF;
  r := pg_temp.as_role('authenticated', staff2, $q$WITH x AS (INSERT INTO public.courses (title) VALUES ('s') RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'error=42501' THEN RAISE EXCEPTION '일반관리자 과정 등록: %', r; END IF;
  RAISE NOTICE '일반관리자: OTP 없이 명단 조회만 가능, 신청·과정 수정·삭제·등록 불가 (슈퍼관리자 aal1은 계속 0건)';

  -- 접속 기록: 관리자·일반관리자·비로그인 모두 API로 읽기·쓰기 불가, 서버 키만 기록
  r := pg_temp.as_role('authenticated', aal2, 'SELECT count(*) FROM public.admin_access_log');
  IF r <> 'error=42501' THEN RAISE EXCEPTION '관리자 접속기록 조회: %', r; END IF;
  r := pg_temp.as_role('authenticated', staff2, $q$WITH x AS (INSERT INTO public.admin_access_log (action) VALUES ('fake') RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'error=42501' THEN RAISE EXCEPTION '일반관리자 접속기록 위조: %', r; END IF;
  r := pg_temp.as_role('anon', '{}', 'SELECT count(*) FROM public.admin_access_log');
  IF r <> 'error=42501' THEN RAISE EXCEPTION '비로그인 접속기록 조회: %', r; END IF;
  r := pg_temp.as_role('service_role', '{}', $q$WITH x AS (INSERT INTO public.admin_access_log (action) VALUES ('view_list') RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'rows=1' THEN RAISE EXCEPTION '서버 키 접속기록 쓰기: %', r; END IF;
  RAISE NOTICE '접속 기록: 관리자·일반관리자·비로그인은 읽기·쓰기 불가, 서버 키만 기록';

  -- 신청 직접 등록·삭제·수정
  r := pg_temp.as_role('authenticated', aal2, $q$WITH x AS (INSERT INTO public.education_apply (req_id, course_id, name) VALUES ('direct', '55555555-5555-5555-5555-555555555555', 'x') RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'error=42501' THEN RAISE EXCEPTION '관리자 aal2 신청 직접 등록: %', r; END IF;
  r := pg_temp.as_role('anon', '{}', $q$WITH x AS (INSERT INTO public.education_apply (req_id, course_id, name) VALUES ('direct', '55555555-5555-5555-5555-555555555555', 'x') RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'error=42501' THEN RAISE EXCEPTION '비로그인 신청 직접 등록: %', r; END IF;
  r := pg_temp.as_role('authenticated', aal1, 'WITH x AS (DELETE FROM public.education_apply RETURNING 1) SELECT count(*) FROM x');
  IF r <> 'rows=0' THEN RAISE EXCEPTION '관리자 aal1 신청 삭제: %', r; END IF;
  r := pg_temp.as_role('authenticated', aal1, $q$WITH x AS (UPDATE public.education_apply SET status = 'x' RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'rows=0' THEN RAISE EXCEPTION '관리자 aal1 신청 수정: %', r; END IF;
  r := pg_temp.as_role('authenticated', aal2, 'TRUNCATE public.education_apply');
  IF r <> 'error=42501' THEN RAISE EXCEPTION '관리자 TRUNCATE: %', r; END IF;
  RAISE NOTICE '신청 직접 등록 불가(관리자 포함), aal1 삭제·수정 0건, TRUNCATE 권한 없음';

  -- 과정 쓰기
  r := pg_temp.as_role('authenticated', aal1, $q$WITH x AS (INSERT INTO public.courses (title) VALUES ('aal1') RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'error=42501' THEN RAISE EXCEPTION '관리자 aal1 과정 등록: %', r; END IF;
  r := pg_temp.as_role('authenticated', aal1, $q$WITH x AS (UPDATE public.courses SET title = 'aal1' RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'rows=0' THEN RAISE EXCEPTION '관리자 aal1 과정 수정: %', r; END IF;
  r := pg_temp.as_role('anon', '{}', $q$WITH x AS (UPDATE public.courses SET title = 'anon' RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'error=42501' THEN RAISE EXCEPTION '비로그인 과정 수정: %', r; END IF;
  r := pg_temp.as_role('anon', '{}', 'SELECT count(*) FROM public.courses');
  IF r <> 'rows=5' THEN RAISE EXCEPTION '비로그인 과정 조회: %', r; END IF;
  r := pg_temp.as_role('authenticated', aal2, $q$WITH x AS (UPDATE public.courses SET place = '본관' WHERE id = '55555555-5555-5555-5555-555555555555' RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'rows=1' THEN RAISE EXCEPTION '관리자 aal2 과정 수정: %', r; END IF;
  r := pg_temp.as_role('anon', '{}', $q$WITH x AS (UPDATE public.public_courses SET title = 'x' RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'error=42501' THEN RAISE EXCEPTION '비로그인 공개 뷰로 과정 수정: %', r; END IF;
  r := pg_temp.as_role('anon', '{}', $q$WITH x AS (DELETE FROM public.public_courses RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'error=42501' THEN RAISE EXCEPTION '비로그인 공개 뷰로 과정 삭제: %', r; END IF;
  r := pg_temp.as_role('anon', '{}', 'SELECT count(*) FROM public.public_courses');
  IF r <> 'rows=5' THEN RAISE EXCEPTION '비로그인 공개 뷰 조회: %', r; END IF;
  RAISE NOTICE '과정: 누구나 조회, aal1·비로그인 쓰기 불가, 공개 뷰(public_courses)는 읽기만, 관리자 aal2만 수정';

  -- 과정 삭제 보호
  r := pg_temp.as_role('authenticated', aal2, $q$WITH x AS (DELETE FROM public.courses WHERE id = '22222222-2222-2222-2222-222222222222' RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'error=23503' THEN RAISE EXCEPTION '신청자 있는 과정 삭제: %', r; END IF;
  r := pg_temp.as_role('authenticated', aal2, $q$WITH x AS (DELETE FROM public.courses WHERE id = '55555555-5555-5555-5555-555555555555' RETURNING 1) SELECT count(*) FROM x$q$);
  IF r <> 'rows=1' THEN RAISE EXCEPTION '신청자 없는 과정 삭제: %', r; END IF;
  RAISE NOTICE '신청자 있는 과정 삭제 거부(23503), 신청자 없는 과정은 삭제됨';

  -- 함수 실행 권한
  FOR procedure_check IN SELECT * FROM (VALUES
      ('anon', $q$SELECT count(*) FROM public.lookup_my_applications('a','01012345678','a@b.co')$q$),
      ('authenticated', $q$SELECT count(*) FROM public.lookup_my_applications('a','01012345678','a@b.co')$q$),
      ('anon', $q$SELECT public.atomic_course_apply('11111111-1111-1111-1111-111111111111','x','x','','','','x','01012345678','a@b.co',true,null,null)::text::int$q$),
      ('anon', 'SELECT public.purge_old_applications()'),
      ('service_role', 'SELECT public.purge_old_applications()'),
      ('anon', 'SELECT public.purge_lookup_log()')) v(role, q)
  LOOP
    r := pg_temp.as_role(procedure_check.role, aal2, procedure_check.q);
    IF r <> 'error=42501' THEN RAISE EXCEPTION '% 함수 실행: % → %', procedure_check.role, procedure_check.q, r; END IF;
  END LOOP;
  r := pg_temp.as_role('service_role', '{}', $q$SELECT count(*) FROM public.lookup_my_applications('홍길동','010-9999-0001','A@example.com')$q$);
  IF r <> 'rows=1' THEN RAISE EXCEPTION '서버 키 조회(대소문자 무시 이메일): %', r; END IF;
  r := pg_temp.as_role('service_role', '{}', $q$SELECT count(*) FROM public.lookup_my_applications('홍길동','010-9999-0001','wrong@example.com')$q$);
  IF r <> 'rows=0' THEN RAISE EXCEPTION '서버 키 조회(이메일 불일치): %', r; END IF;
  RAISE NOTICE '함수: 신청·조회는 서버 키만, 파기 함수는 서버 키로도 불가, 조회는 3가지 모두 일치할 때만 결과';

  -- 파기
  INSERT INTO public.lookup_log (phone_key, created_at) VALUES ('old', now() - interval '2 days'), ('new', now());
  r := public.purge_lookup_log()::text;
  IF r::int < 1 OR EXISTS (SELECT 1 FROM public.lookup_log WHERE phone_key = 'old')
     OR NOT EXISTS (SELECT 1 FROM public.lookup_log WHERE phone_key = 'new') THEN
    RAISE EXCEPTION '조회 기록 정리 실패';
  END IF;
  r := public.purge_old_applications()::text;
  IF r <> '1' THEN RAISE EXCEPTION '파기 건수가 1이 아님'; END IF;
  IF EXISTS (SELECT 1 FROM public.education_apply WHERE req_id = 'f1') THEN RAISE EXCEPTION '종료 2년 지난 신청이 남음'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.education_apply WHERE req_id = 'f2') THEN RAISE EXCEPTION '종료 6개월 신청이 지워짐'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.education_apply WHERE req_id = 'f3') THEN RAISE EXCEPTION '종료일 미입력 신청이 지워짐'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.courses WHERE id = '22222222-2222-2222-2222-222222222222') THEN RAISE EXCEPTION '과정 행이 지워짐'; END IF;
  RAISE NOTICE '파기: 종료일+1년 지난 신청만 삭제, 종료 6개월·종료일 미입력(5년 전 신청)은 유지, 과정 행 유지, 하루 지난 조회 기록만 삭제';

  -- 자동 실행 등록
  IF (SELECT count(*) FROM cron.job WHERE jobname IN ('purge-old-applications', 'purge-lookup-log', 'purge-admin-access-log')) <> 3 THEN
    RAISE EXCEPTION '자동 실행 등록 수가 3이 아님';
  END IF;
  RAISE NOTICE '자동 실행 3개 등록(두 번 실행해도 중복 없음)';
END $$;

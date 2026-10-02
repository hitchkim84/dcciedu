-- 보안 상태 확인용 (읽기 전용: 아무것도 바꾸지 않는다)
-- Supabase SQL Editor에서 전체를 실행하면 결과가 하나의 표로 나온다(항목·대상·내용·판정).
-- 자동 실행(pg_cron) 결과는 check_cron.sql로 따로 확인한다.
-- 판정이 '확인 필요'인 줄이 있으면 그 줄의 내용을 담당자(또는 Claude)에게 전달한다.
-- 개인정보(이름·연락처 등)는 결과에 나오지 않는다. 숫자(건수)만 나온다.

WITH
pol AS (
  SELECT tablename, policyname, cmd, roles::text AS roles,
         coalesce(qual, '') AS qual, coalesce(with_check, '') AS with_check
    FROM pg_policies
   WHERE schemaname = 'public'
),
fn AS (
  SELECT p.oid, p.oid::regprocedure::text AS sig, p.prosecdef,
         pg_get_userbyid(p.proowner) AS owner,
         coalesce(array_to_string(p.proconfig, ','), '') AS config
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
),
expected_policy(tablename, policyname, cmd) AS (
  VALUES ('courses', 'Anyone can read courses', 'SELECT'),
         ('courses', 'Admin can insert courses', 'INSERT'),
         ('courses', 'Admin can update courses', 'UPDATE'),
         ('courses', 'Admin can delete courses', 'DELETE'),
         ('education_apply', 'Admin can view applications', 'SELECT'),
         ('education_apply', 'Admin can update applications', 'UPDATE'),
         ('education_apply', 'Admin can delete applications', 'DELETE')
)
-- 1. 모든 접근 규칙: 관리자 규칙은 admin과 aal2가 모두 들어 있어야 한다
SELECT '1.규칙' AS 항목, tablename || ' / ' || policyname AS 대상,
       cmd || ' ' || roles || ' USING(' || qual || ') CHECK(' || with_check || ')' AS 내용,
       CASE
         WHEN tablename = 'courses' AND cmd = 'SELECT' THEN '정상(과정 공개)'
         WHEN (qual || with_check) LIKE '%admin%' AND (qual || with_check) LIKE '%aal2%'
              AND (cmd <> 'UPDATE' OR (qual LIKE '%aal2%' AND with_check LIKE '%aal2%')) THEN '정상'
         WHEN (qual || with_check) LIKE '%admin%' AND (qual || with_check) LIKE '%aal2%' THEN '확인 필요(UPDATE 결과 검사 없음)'
         ELSE '확인 필요(OTP 조건 없음)'
       END AS 판정
  FROM pol
UNION ALL
-- 2. 있어야 할 규칙이 빠졌는지
SELECT '2.빠진 규칙', e.tablename || ' / ' || e.policyname, e.cmd, '확인 필요(없음)'
  FROM expected_policy e
 WHERE NOT EXISTS (SELECT 1 FROM pol p WHERE p.tablename = e.tablename AND p.policyname = e.policyname)
UNION ALL
-- 3. RLS 켜짐 여부
SELECT '3.RLS', c.relname, 'rls=' || c.relrowsecurity,
       CASE WHEN c.relrowsecurity THEN '정상' ELSE '확인 필요(RLS 꺼짐)' END
  FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
UNION ALL
-- 4. 홈페이지 키(anon)·로그인 사용자(authenticated)의 표·뷰 권한
SELECT '4.표권한', c.relname || ' (' || r.rolname || ')',
       concat_ws(',',
         CASE WHEN has_table_privilege(r.rolname, c.oid, 'SELECT') THEN 'SELECT' END,
         CASE WHEN has_table_privilege(r.rolname, c.oid, 'INSERT') THEN 'INSERT' END,
         CASE WHEN has_table_privilege(r.rolname, c.oid, 'UPDATE') THEN 'UPDATE' END,
         CASE WHEN has_table_privilege(r.rolname, c.oid, 'DELETE') THEN 'DELETE' END,
         CASE WHEN has_table_privilege(r.rolname, c.oid, 'TRUNCATE') THEN 'TRUNCATE' END),
       CASE
         WHEN c.relname = 'education_apply' AND r.rolname = 'anon'
              AND has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN '확인 필요(비로그인 권한 남음)'
         WHEN c.relname IN ('lookup_log', 'apply_list_by_course')
              AND has_table_privilege(r.rolname, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN '확인 필요(API 접근 가능)'
         WHEN c.relkind IN ('v', 'm') AND has_table_privilege(r.rolname, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE') THEN '확인 필요(뷰 쓰기 가능: RLS 없이 원본 표 변경 위험)'
         WHEN c.relkind IN ('r', 'p') AND has_table_privilege(r.rolname, c.oid, 'TRUNCATE') THEN '확인 필요(TRUNCATE는 RLS를 무시)'
         ELSE '정상'
       END
  FROM pg_class c CROSS JOIN pg_roles r
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p')
   AND r.rolname IN ('anon', 'authenticated')
UNION ALL
-- 5. public 스키마의 모든 함수: SECURITY DEFINER, 소유자, search_path, 실행 가능한 역할
SELECT '5.함수', sig,
       'definer=' || prosecdef || ' owner=' || owner || ' config=[' || config || '] exec='
       || concat_ws(',',
            CASE WHEN has_function_privilege('anon', oid, 'EXECUTE') THEN 'anon' END,
            CASE WHEN has_function_privilege('authenticated', oid, 'EXECUTE') THEN 'authenticated' END,
            CASE WHEN has_function_privilege('service_role', oid, 'EXECUTE') THEN 'service_role' END),
       CASE
         WHEN NOT prosecdef THEN '참고(권한은 호출자 기준)'
         WHEN config NOT LIKE '%search_path=""%' THEN '확인 필요(search_path 미고정)'
         WHEN has_function_privilege('anon', oid, 'EXECUTE') OR has_function_privilege('authenticated', oid, 'EXECUTE') THEN '확인 필요(홈페이지 키로 실행 가능)'
         ELSE '정상'
       END
  FROM fn
UNION ALL
-- 6. 과정 삭제 시 신청자 처리 방식 (r=RESTRICT 정상, c=CASCADE 확인 필요)
SELECT '6.과정삭제', conname, 'on delete=' || confdeltype::text,
       CASE WHEN confdeltype IN ('r', 'a') THEN '정상(신청자 있으면 삭제 불가)' ELSE '확인 필요(과정 삭제 시 신청자 함께 삭제)' END
  FROM pg_constraint
 WHERE conrelid = 'public.education_apply'::regclass AND contype = 'f'
UNION ALL
-- 7. 파기 기준: 종료일이 비어 있어 파기 대상에서 빠진 과정 (종료일 칸이 아직 없으면 이 줄은 오류 없이 건너뜀)
SELECT '7.종료일 미입력', 'courses', count(*)::text || '개 과정 (신청 ' ||
       (SELECT count(*) FROM education_apply a WHERE a.course_id IN (SELECT id FROM courses c2 WHERE (to_jsonb(c2) ->> 'end_date') IS NULL))::text || '건)',
       CASE WHEN count(*) = 0 THEN '정상' ELSE '확인 필요(관리자 페이지에서 교육 종료일 입력)' END
  FROM courses c
 WHERE (to_jsonb(c) ->> 'end_date') IS NULL
UNION ALL
-- 8. 조회 기록 크기 (하루 지난 기록이 많으면 정리 자동 실행이 안 되는 것)
SELECT '8.조회기록', 'lookup_log', '전체 ' || count(*) || '건, 하루 지난 기록 ' || count(*) FILTER (WHERE created_at < now() - interval '1 day') || '건',
       CASE WHEN count(*) FILTER (WHERE created_at < now() - interval '2 days') = 0 THEN '정상' ELSE '확인 필요(정리 미실행)' END
  FROM lookup_log
ORDER BY 1, 2;

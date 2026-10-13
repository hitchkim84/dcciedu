-- ⛔ 보관용 옛 SQL (실행 금지, ARCHIVE_GUARD): 이 파일을 다시 실행하면 2026-10에 막은 권한이 다시 열릴 수 있다.
--    운영 DB는 sql/12 이후 파일로 맞춘다. 실수로 실행해도 아래 줄에서 멈추고 아무것도 바뀌지 않는다. ARCHIVE_GUARD
DO $$ BEGIN RAISE EXCEPTION '보관용 옛 SQL입니다. 실행하지 마세요(권한이 다시 열립니다). 최신 상태는 sql/12 이후 파일로 맞춥니다.'; END $$; -- ARCHIVE_GUARD

-- 04. Supabase 표 화면(Table Editor)에서 과정명과 함께 신청자를 보기 위한 뷰
-- 기존 테이블·데이터는 변경하지 않는다. 여러 번 실행해도 안전하다.
-- 개인정보 보호: security_invoker로 education_apply의 RLS를 그대로 따르고,
-- 홈페이지 API(anon/authenticated)에서는 아예 조회할 수 없도록 권한을 회수한다.

CREATE OR REPLACE VIEW apply_list_by_course
WITH (security_invoker = true) AS
SELECT
  c.title                                                                AS "과정명",
  c.date                                                                 AS "교육일시",
  to_char(a.created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI')  AS "신청일시",
  a.company                                                              AS "회사명",
  a.biz_no                                                               AS "사업자번호",
  a.dept                                                                 AS "부서",
  a.position                                                             AS "직위",
  a.name                                                                 AS "성명",
  a.phone                                                                AS "연락처",
  a.email                                                                AS "이메일",
  CASE WHEN a.agree_privacy THEN '동의' ELSE '미동의' END                AS "개인정보동의",
  a.sync_status                                                          AS "시트전송",
  a.id                                                                   AS "신청ID",
  a.course_id                                                            AS "과정ID"
FROM education_apply a
JOIN courses c ON c.id = a.course_id
ORDER BY c.date, a.created_at;

REVOKE ALL ON apply_list_by_course FROM PUBLIC, anon, authenticated;

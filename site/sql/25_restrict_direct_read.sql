-- 25. 관리자 로그인 토큰으로 신청자 개인정보를 DB에서 직접 읽거나 고치지 못하게 막기
-- sql/24의 조회 함수(접속 기록과 한 묶음)로만 개인정보를 읽게 한다.
-- 관리자·일반관리자(authenticated)가 education_apply에서 직접 읽을 수 있는 칸: 개인정보가 아닌 관리용 칸만
--   (id, course_id, 신청 시각, 회원 구분·교육비, 입금확인·출석·알림톡 발송 시각)
-- 직접 고칠 수 있는 칸: 회원 구분·교육비·입금확인·출석만(슈퍼관리자+OTP, 기존 규칙 sql/12 그대로). 성명·연락처 등은 못 고친다.
-- 삭제 권한·규칙은 그대로(슈퍼관리자+OTP).
--
-- ⚠ 실행 순서: sql/24 → 홈페이지 배포(서버가 sql/24 함수를 쓰는 버전) → 이 파일.
--   이 파일을 먼저 실행하면 옛 홈페이지의 관리자 명단이 열리지 않는다(개인정보가 새 나가는 쪽이 아니라 막히는 쪽).
-- 여러 번 실행해도 안전하다. sql/12를 다시 실행하면 직접 조회 권한이 다시 열리므로 그 뒤에 이 파일도 다시 실행한다.
-- 되돌리기(문제 시): GRANT SELECT, UPDATE ON public.education_apply TO authenticated;  (RLS 규칙은 그대로 남아 있어 관리자만 보인다)

BEGIN;

REVOKE SELECT, UPDATE, INSERT, TRUNCATE, REFERENCES, TRIGGER ON public.education_apply FROM authenticated;
GRANT SELECT (id, course_id, created_at, fee_type, applied_fee, paid_at, attended_at,
              pay_notice_sent_at, cancel_notice_sent_at, class_notice_sent_at, survey_notice_sent_at)
  ON public.education_apply TO authenticated;
GRANT UPDATE (fee_type, applied_fee, paid_at, attended_at) ON public.education_apply TO authenticated;
GRANT DELETE ON public.education_apply TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 확인: 개인정보 칸(name·phone·email·company·biz_no)은 직접 읽기·고치기 모두 false여야 한다.
SELECT c.col,
       has_column_privilege('authenticated', 'public.education_apply', c.col, 'SELECT') AS 직접읽기,
       has_column_privilege('authenticated', 'public.education_apply', c.col, 'UPDATE') AS 직접고치기
  FROM unnest(ARRAY['name', 'phone', 'email', 'company', 'biz_no', 'paid_at', 'attended_at']) AS c(col);

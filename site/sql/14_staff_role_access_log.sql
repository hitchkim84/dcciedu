-- 14. 관리자 등급 나누기(슈퍼관리자·일반관리자) + 관리자 접속 기록
-- 슈퍼관리자(app_metadata.role = 'admin'): 지금 관리자. 모든 기능 사용
-- 일반관리자(app_metadata.role = 'staff'): 신청자 명단 보기와 엑셀(CSV) 다운로드만. 과정 수정·신청 삭제 불가
-- 두 등급 모두 OTP를 통과한 로그인(aal2)이어야 한다.
-- 접속 기록(admin_access_log): 누가 언제 명단을 보고, 내려받고, 지웠는지 서버가 기록한다(개인정보 접속기록 보관).
--   홈페이지·관리자 키로는 읽거나 쓸 수 없고, 서버(서비스 키)만 기록한다. 조회는 Supabase SQL Editor에서 한다.
--   2년이 지난 기록은 매월 자동 삭제한다.
-- 실행 순서: sql/12, sql/13 적용 상태에서 이 파일을 실행한다. 홈페이지 배포 전후 언제 실행해도 된다.
-- 주의: sql/12를 다시 실행하면 일반관리자 조회 규칙이 지워진다(일반관리자가 명단을 못 보는 쪽으로 안전). 그 경우 이 파일도 다시 실행한다.
-- 여러 번 실행해도 안전하다.

BEGIN;

-- 1. 신청자 명단 조회: 슈퍼관리자 또는 일반관리자 + OTP
DROP POLICY IF EXISTS "Admin can view applications" ON public.education_apply;
DROP POLICY IF EXISTS "Admin or staff can view applications" ON public.education_apply;
CREATE POLICY "Admin or staff can view applications" ON public.education_apply FOR SELECT TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin', 'staff') AND (auth.jwt() ->> 'aal') = 'aal2');
-- 수정·삭제와 과정 등록·수정·삭제 규칙은 sql/12 그대로(슈퍼관리자만)

-- 2. 접속 기록
CREATE TABLE IF NOT EXISTS public.admin_access_log (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  user_email text,
  user_role text,
  action text NOT NULL,
  detail text
);
CREATE INDEX IF NOT EXISTS admin_access_log_created_at_idx ON public.admin_access_log (created_at);
ALTER TABLE public.admin_access_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_access_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.admin_access_log_id_seq FROM PUBLIC, anon, authenticated;
GRANT INSERT ON public.admin_access_log TO service_role;
GRANT USAGE ON SEQUENCE public.admin_access_log_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.purge_admin_access_log() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.admin_access_log WHERE created_at < now() - interval '2 years';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_admin_access_log() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;

-- 3. 자동 실행: 매월 1일 03:20 UTC(한국 12:20)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-admin-access-log';
SELECT cron.schedule('purge-admin-access-log', '20 3 1 * *', 'SELECT public.purge_admin_access_log();');

NOTIFY pgrst, 'reload schema';

-- 확인: 2줄. 명단 조회 규칙에 admin과 staff, aal2가 있어야 하고, 자동 실행이 1개 있어야 한다.
SELECT 'policy' AS kind, policyname AS name, qual AS detail FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'education_apply' AND cmd = 'SELECT'
UNION ALL
SELECT 'cron', jobname, schedule FROM cron.job WHERE jobname = 'purge-admin-access-log';

-- ─────────────────────────────────────────────
-- 참고: 직원(일반관리자) 계정 만들기 (슈퍼관리자가 직접, 실행 후 쿼리 삭제)
--  1) Supabase → Authentication → Users → Add user → Create new user
--     이메일 칸: 아이디@staff.dcciedu.co.kr (관리자 페이지에서는 '아이디'만 입력해 로그인)
--     비밀번호: 다른 곳에서 쓰지 않는 16자 이상, Auto Confirm User 체크
--  2) SQL Editor에서 등급 지정:
--     UPDATE auth.users SET raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"staff"}'::jsonb
--      WHERE email = '아이디@staff.dcciedu.co.kr';
--  3) 직원이 처음 로그인하면 OTP 등록(QR) 화면이 나온다.
--  퇴사·이동 시: Authentication → Users에서 Delete user
-- ─────────────────────────────────────────────

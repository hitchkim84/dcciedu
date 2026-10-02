-- 11. 보유기간이 지난 신청자 개인정보 자동 파기 (개인정보처리방침: 교육 종료일로부터 1년)
-- (2026-10) 파기 기준은 sql/12가 "교육 종료일 + 1년"으로 대체한다. 이 파일을 다시 실행하지 말 것(실행했다면 sql/12를 다시 실행).
-- 기준: 과정의 신청 마감일(deadline)로부터 1년 + 1개월(교육 종료 여유)이 지난 신청을 삭제한다.
--       마감일이 없는 과정은 신청일로부터 13개월이 지난 신청을 삭제한다.
-- 과정(courses) 자체와 통계용 인원 정보는 지우지 않고, 신청자 행(education_apply)만 지운다.
-- 실행 방법:
--   1) 이 파일 전체를 Supabase SQL Editor에서 한 번 실행 → 함수 생성 + 매월 1일 새벽 3시(UTC) 자동 실행 등록
--      (pg_cron이 꺼져 있으면 Database → Extensions에서 pg_cron을 켠 뒤 다시 실행)
--   2) 지금 바로 정리하려면: SELECT purge_old_applications();  (지운 건수를 돌려준다)
-- 여러 번 실행해도 안전하다(자동 실행은 같은 이름으로 한 번만 등록된다).

CREATE OR REPLACE FUNCTION purge_old_applications() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM education_apply a
   USING courses c
   WHERE c.id = a.course_id
     AND (
       (c.deadline IS NOT NULL AND c.deadline < (now() AT TIME ZONE 'Asia/Seoul')::date - interval '1 year 1 month')
       OR (c.deadline IS NULL AND a.created_at < now() - interval '13 months')
     );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- 홈페이지·관리자 API에서는 호출할 수 없게 막는다(DB 관리자와 자동 실행만 사용).
REVOKE EXECUTE ON FUNCTION purge_old_applications() FROM PUBLIC, anon, authenticated;

-- 매월 1일 03:00 UTC(한국 12:00) 자동 실행 등록
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-old-applications';
SELECT cron.schedule('purge-old-applications', '0 3 1 * *', 'SELECT public.purge_old_applications();');

-- 확인: 자동 실행 1건이 보여야 한다.
SELECT jobname, schedule, command FROM cron.job WHERE jobname = 'purge-old-applications';

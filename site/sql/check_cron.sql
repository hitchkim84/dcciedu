-- 자동 실행(pg_cron) 목록과 최근 실행 결과 확인 (읽기 전용: 아무것도 바꾸지 않는다)
-- Supabase SQL Editor에서 전체를 실행한다.
--    status가 succeeded여야 한다. failed면 return_message를 확인한다.
SELECT j.jobname, j.schedule, j.active, d.status, d.return_message, d.start_time
  FROM cron.job j
  LEFT JOIN LATERAL (
    SELECT status, return_message, start_time
      FROM cron.job_run_details r
     WHERE r.jobid = j.jobid
     ORDER BY start_time DESC
     LIMIT 3
  ) d ON true
 ORDER BY j.jobname, d.start_time DESC;

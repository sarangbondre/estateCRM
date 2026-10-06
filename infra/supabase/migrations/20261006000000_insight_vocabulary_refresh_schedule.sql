-- insight vocabulary-refresh every 5 minutes (it was "on-demand", but nothing starts it, so insight never loaded the
-- vocabulary or the micromarket hierarchy: locations in questions were ignored and micromarket ids showed instead of
-- names). The same line is generated into 20260927000100_platform_schedules.sql for new environments; cron.schedule
-- replaces a job of the same name, so applying both is safe.
select cron.schedule('estatecrm:insight:job:vocabulary-refresh', '*/5 * * * *', 'select platform.invoke(''insight'', ''/internal/v1/jobs/vocabulary-refresh'')');

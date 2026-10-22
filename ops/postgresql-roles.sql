-- Run once as a PostgreSQL administrator, after migrations. Provision passwords
-- separately; these roles must not own tables or be used for migrations.
CREATE ROLE fpl_analytics_read LOGIN;
GRANT CONNECT ON DATABASE "fpl-trends-db" TO fpl_analytics_read;
GRANT USAGE ON SCHEMA public TO fpl_analytics_read;
GRANT SELECT ON app_metadata, events, analytics_benchmarks, analytics_publications,
 analytics_jobs, analytics_manager_results TO fpl_analytics_read;
GRANT INSERT, UPDATE ON analytics_jobs TO fpl_analytics_read;
ALTER ROLE fpl_analytics_read SET statement_timeout='2s';
ALTER ROLE fpl_analytics_read SET lock_timeout='500ms';
ALTER ROLE fpl_analytics_read SET idle_in_transaction_session_timeout='5s';
ALTER ROLE fpl_analytics_read SET work_mem='4MB';
ALTER ROLE fpl_analytics_read SET temp_file_limit='64MB';

-- Worker/collector share the existing application role initially. Configure a
-- separate migration owner before reducing that role's DDL permissions.
ALTER ROLE fpl SET statement_timeout='60s';
ALTER ROLE fpl SET lock_timeout='2s';
ALTER ROLE fpl SET idle_in_transaction_session_timeout='60s';
ALTER ROLE fpl SET work_mem='8MB';
ALTER ROLE fpl SET temp_file_limit='256MB';

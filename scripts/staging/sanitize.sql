-- Runs against the STAGING database right after restoring a live dump and
-- BEFORE app/worker start. Removes every way staging could reach real people.
-- Usage: psql -v app_domain='http://<staging-host>:4325' -f sanitize.sql
\set ON_ERROR_STOP on
BEGIN;

-- Email: no SMTP server, no sender
UPDATE "Settings"
   SET "smtpServer" = NULL,
       "smtpUsername" = NULL,
       "smtpPassword" = NULL,
       "smtpFromAddress" = NULL,
       "appDomain" = :'app_domain';

-- External notification targets (webhooks, chat integrations)
UPDATE "NotificationDestination" SET "enabled" = false;

-- Browser push subscriptions belong to real devices
DELETE FROM "PushSubscription";

-- Anything still waiting to be sent
DELETE FROM "NotificationQueue";

COMMIT;

-- Report what is left (all must be 0 / NULL)
SELECT 'smtp_configured' AS check, count(*) AS value FROM "Settings" WHERE "smtpServer" IS NOT NULL
UNION ALL SELECT 'destinations_enabled', count(*) FROM "NotificationDestination" WHERE "enabled"
UNION ALL SELECT 'push_subscriptions', count(*) FROM "PushSubscription"
UNION ALL SELECT 'queued_notifications', count(*) FROM "NotificationQueue";

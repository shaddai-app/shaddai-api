-- Restricciones que Prisma no expresa: visibilidad y estado conocidos, anónima solo si es pública y
-- la fecha de respuesta va con el estado "answered".
EXEC('ALTER TABLE [dbo].[PrayerRequest] ADD CONSTRAINT [PrayerRequest_visibility_ck] CHECK ([visibility] IN (''public'', ''pastors'', ''leader''))');
EXEC('ALTER TABLE [dbo].[PrayerRequest] ADD CONSTRAINT [PrayerRequest_status_ck] CHECK ([status] IN (''open'', ''answered''))');
EXEC('ALTER TABLE [dbo].[PrayerRequest] ADD CONSTRAINT [PrayerRequest_anonymous_ck] CHECK ([anonymous] = 0 OR [visibility] = ''public'')');
EXEC('ALTER TABLE [dbo].[PrayerRequest] ADD CONSTRAINT [PrayerRequest_answered_ck] CHECK (([status] = ''answered'' AND [answeredAt] IS NOT NULL) OR ([status] = ''open'' AND [answeredAt] IS NULL AND [testimony] IS NULL))');

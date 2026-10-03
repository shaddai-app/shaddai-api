-- Restricciones que Prisma no expresa: el vencimiento es posterior a la publicación y la audiencia es de un tipo conocido.
EXEC('ALTER TABLE [dbo].[Announcement] ADD CONSTRAINT [Announcement_expires_ck] CHECK ([expiresAt] IS NULL OR [expiresAt] > [publishAt])');
EXEC('ALTER TABLE [dbo].[AnnouncementAudience] ADD CONSTRAINT [AnnouncementAudience_kind_ck] CHECK ([kind] IN (''role'', ''ministry'', ''campus''))');

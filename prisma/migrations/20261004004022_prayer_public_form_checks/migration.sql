-- Peticiones del formulario público: origen conocido, solo las del formulario pueden no tener autor
-- y siempre traen el enlace (hash y cifrado) y la versión del consentimiento; pedir contacto exige
-- teléfono o mail; y lo permitido para el muro es un valor conocido.
EXEC('ALTER TABLE [dbo].[PrayerRequest] ADD CONSTRAINT [PrayerRequest_source_ck] CHECK ([source] IN (''app'', ''form''))');
EXEC('ALTER TABLE [dbo].[PrayerRequest] ADD CONSTRAINT [PrayerRequest_author_ck] CHECK ([createdById] IS NOT NULL OR [source] = ''form'')');
EXEC('ALTER TABLE [dbo].[PrayerRequest] ADD CONSTRAINT [PrayerRequest_form_ck] CHECK ([source] = ''app'' OR ([accessTokenHash] IS NOT NULL AND [accessTokenEnc] IS NOT NULL AND [consentVersion] IS NOT NULL))');
EXEC('ALTER TABLE [dbo].[PrayerRequest] ADD CONSTRAINT [PrayerRequest_contact_ck] CHECK ([wantsContact] = 0 OR [requesterPhone] IS NOT NULL OR [requesterEmail] IS NOT NULL)');
EXEC('ALTER TABLE [dbo].[PrayerRequest] ADD CONSTRAINT [PrayerRequest_wall_share_ck] CHECK ([wallShare] IS NULL OR [wallShare] IN (''anonymous'', ''named''))');

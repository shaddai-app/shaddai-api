-- Restricciones que Prisma no expresa: estados y proveedores conocidos, importes no negativos y
-- período coherente.
EXEC('ALTER TABLE [dbo].[Subscription] ADD CONSTRAINT [Subscription_status_ck] CHECK ([status] IN (''pending'', ''authorized'', ''paused'', ''cancelled''))');
EXEC('ALTER TABLE [dbo].[Subscription] ADD CONSTRAINT [Subscription_provider_ck] CHECK ([provider] IN (''mercadopago'', ''fake''))');
EXEC('ALTER TABLE [dbo].[Subscription] ADD CONSTRAINT [Subscription_amount_ck] CHECK ([amount] >= 0)');
EXEC('ALTER TABLE [dbo].[Invoice] ADD CONSTRAINT [Invoice_status_ck] CHECK ([status] IN (''pending'', ''approved'', ''rejected'', ''refunded''))');
EXEC('ALTER TABLE [dbo].[Invoice] ADD CONSTRAINT [Invoice_provider_ck] CHECK ([provider] IN (''mercadopago'', ''fake'', ''manual''))');
EXEC('ALTER TABLE [dbo].[Invoice] ADD CONSTRAINT [Invoice_amount_ck] CHECK ([amount] >= 0)');
EXEC('ALTER TABLE [dbo].[Invoice] ADD CONSTRAINT [Invoice_period_ck] CHECK ([periodEnd] IS NULL OR [periodStart] IS NULL OR [periodEnd] > [periodStart])');
EXEC('ALTER TABLE [dbo].[Plan] ADD CONSTRAINT [Plan_priceArs_ck] CHECK ([priceArs] IS NULL OR [priceArs] >= 0)');

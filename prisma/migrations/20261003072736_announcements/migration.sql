BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Announcement] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [title] NVARCHAR(150) NOT NULL,
    [body] NVARCHAR(4000) NOT NULL,
    [publishAt] DATETIME2 NOT NULL,
    [expiresAt] DATETIME2,
    [pinned] BIT NOT NULL CONSTRAINT [Announcement_pinned_df] DEFAULT 0,
    [notify] BIT NOT NULL CONSTRAINT [Announcement_notify_df] DEFAULT 1,
    [notifiedAt] DATETIME2,
    [createdById] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Announcement_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [deletedAt] DATETIME2,
    CONSTRAINT [Announcement_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[AnnouncementAudience] (
    [id] INT NOT NULL IDENTITY(1,1),
    [announcementId] INT NOT NULL,
    [kind] VARCHAR(10) NOT NULL,
    [refId] INT NOT NULL,
    CONSTRAINT [AnnouncementAudience_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Announcement_accountId_publishAt_idx] ON [dbo].[Announcement]([accountId], [publishAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AnnouncementAudience_announcementId_idx] ON [dbo].[AnnouncementAudience]([announcementId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AnnouncementAudience_kind_refId_idx] ON [dbo].[AnnouncementAudience]([kind], [refId]);

-- AddForeignKey
ALTER TABLE [dbo].[Announcement] ADD CONSTRAINT [Announcement_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Announcement] ADD CONSTRAINT [Announcement_createdById_fkey] FOREIGN KEY ([createdById]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AnnouncementAudience] ADD CONSTRAINT [AnnouncementAudience_announcementId_fkey] FOREIGN KEY ([announcementId]) REFERENCES [dbo].[Announcement]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

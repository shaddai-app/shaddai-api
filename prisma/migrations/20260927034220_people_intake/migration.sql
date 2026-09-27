BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[NewcomerSubmission] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [firstName] NVARCHAR(80) NOT NULL,
    [lastName] NVARCHAR(80) NOT NULL,
    [phone] VARCHAR(30),
    [email] NVARCHAR(150),
    [address] NVARCHAR(250),
    [city] NVARCHAR(100),
    [birthDate] DATE,
    [howHeard] NVARCHAR(200),
    [prayer] NVARCHAR(1000),
    [wantsVisit] BIT NOT NULL CONSTRAINT [NewcomerSubmission_wantsVisit_df] DEFAULT 0,
    [consent] BIT NOT NULL,
    [consentVersion] VARCHAR(10) NOT NULL,
    [locale] VARCHAR(5),
    [status] VARCHAR(10) NOT NULL CONSTRAINT [NewcomerSubmission_status_df] DEFAULT 'pending',
    [personId] INT,
    [reviewedById] INT,
    [reviewedAt] DATETIME2,
    [ip] VARCHAR(45),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [NewcomerSubmission_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [NewcomerSubmission_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ImportJob] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [createdById] INT NOT NULL,
    [fileName] NVARCHAR(250) NOT NULL,
    [status] VARCHAR(10) NOT NULL CONSTRAINT [ImportJob_status_df] DEFAULT 'preview',
    [rows] NVARCHAR(max) NOT NULL,
    [summary] NVARCHAR(max) NOT NULL,
    [expiresAt] DATETIME2 NOT NULL,
    [committedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ImportJob_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [ImportJob_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [NewcomerSubmission_accountId_status_createdAt_idx] ON [dbo].[NewcomerSubmission]([accountId], [status], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ImportJob_accountId_createdById_createdAt_idx] ON [dbo].[ImportJob]([accountId], [createdById], [createdAt]);

-- AddForeignKey
ALTER TABLE [dbo].[NewcomerSubmission] ADD CONSTRAINT [NewcomerSubmission_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[NewcomerSubmission] ADD CONSTRAINT [NewcomerSubmission_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ImportJob] ADD CONSTRAINT [ImportJob_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

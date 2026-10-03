BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Course] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [name] NVARCHAR(100) NOT NULL,
    [description] NVARCHAR(500),
    [milestoneTypeId] INT,
    [isActive] BIT NOT NULL CONSTRAINT [Course_isActive_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Course_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [deletedAt] DATETIME2,
    CONSTRAINT [Course_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[CourseLevel] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [courseId] INT NOT NULL,
    [name] NVARCHAR(100) NOT NULL,
    [description] NVARCHAR(500),
    [sortOrder] INT NOT NULL,
    [teacherPersonId] INT,
    [isActive] BIT NOT NULL CONSTRAINT [CourseLevel_isActive_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CourseLevel_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [CourseLevel_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[CourseEnrollment] (
    [id] INT NOT NULL IDENTITY(1,1),
    [accountId] INT NOT NULL,
    [levelId] INT NOT NULL,
    [personId] INT NOT NULL,
    [status] VARCHAR(10) NOT NULL CONSTRAINT [CourseEnrollment_status_df] DEFAULT 'active',
    [enrolledAt] DATE NOT NULL,
    [completedAt] DATE,
    [droppedAt] DATE,
    [notes] NVARCHAR(500),
    [createdById] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CourseEnrollment_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [CourseEnrollment_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Course_accountId_isActive_idx] ON [dbo].[Course]([accountId], [isActive]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CourseLevel_accountId_courseId_idx] ON [dbo].[CourseLevel]([accountId], [courseId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CourseLevel_accountId_teacherPersonId_idx] ON [dbo].[CourseLevel]([accountId], [teacherPersonId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CourseEnrollment_accountId_levelId_status_idx] ON [dbo].[CourseEnrollment]([accountId], [levelId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CourseEnrollment_accountId_personId_idx] ON [dbo].[CourseEnrollment]([accountId], [personId]);

-- AddForeignKey
ALTER TABLE [dbo].[Course] ADD CONSTRAINT [Course_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[Account]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Course] ADD CONSTRAINT [Course_milestoneTypeId_fkey] FOREIGN KEY ([milestoneTypeId]) REFERENCES [dbo].[CatalogItem]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CourseLevel] ADD CONSTRAINT [CourseLevel_courseId_fkey] FOREIGN KEY ([courseId]) REFERENCES [dbo].[Course]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CourseLevel] ADD CONSTRAINT [CourseLevel_teacherPersonId_fkey] FOREIGN KEY ([teacherPersonId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CourseEnrollment] ADD CONSTRAINT [CourseEnrollment_levelId_fkey] FOREIGN KEY ([levelId]) REFERENCES [dbo].[CourseLevel]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CourseEnrollment] ADD CONSTRAINT [CourseEnrollment_personId_fkey] FOREIGN KEY ([personId]) REFERENCES [dbo].[Person]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

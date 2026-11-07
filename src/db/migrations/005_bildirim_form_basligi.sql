-- A notification keeps the form title it was written with, so its list never shows a title changed
-- later (to someone who may no longer see the form, e.g. an approver whose step was handed on).
ALTER TABLE dbo.bildirimler ADD form_baslik NVARCHAR(120) COLLATE Turkish_100_CI_AS NULL;
GO

-- Notifications written before this column: the title the form has now is the best there is.
UPDATE b SET form_baslik = f.baslik
FROM dbo.bildirimler b JOIN dbo.masraf_formlari f ON f.id = b.form_id
WHERE b.form_baslik IS NULL;

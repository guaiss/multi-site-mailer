-- Soft delete: threads go to Trash first and are purged (D1 rows + R2 objects)
-- on "Delete forever", "Empty trash", or automatically after 30 days.
ALTER TABLE threads ADD COLUMN deleted_at INTEGER;
CREATE INDEX threads_deleted ON threads(deleted_at);

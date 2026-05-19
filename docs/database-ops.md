# 数据库迁移和备份

## 迁移

所有 PostgreSQL schema 变更放在 `migrations/` 目录，文件名使用递增编号：

```text
migrations/001_initial_schema.sql
migrations/002_add_xxx.sql
```

上线或更新代码后执行：

```bash
npm run db:migrate
```

应用启动时也会自动执行未应用的迁移，并写入 `schema_migrations` 表，避免重复执行。

## 备份

执行一次备份：

```bash
npm run db:backup
```

脚本会调用 `pg_dump --format=custom`，默认输出到 `./backups`，可通过 `.env` 修改：

```env
POSTWAVE_BACKUP_DIR=/var/backups/postwave
PG_DUMP_PATH=pg_dump
```

VPS 上建议加 cron，例如每天 04:20 备份：

```cron
20 4 * * * cd /var/www/postwave && npm run db:backup >> /var/log/postwave-backup.log 2>&1
```

恢复示例：

```bash
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" /var/backups/postwave/postwave-xxxx.dump
```

备份文件不要放在网站公开目录，也不要提交到 Git。

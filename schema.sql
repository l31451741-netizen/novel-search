-- 小说搜索站 建表脚本
-- 在 Cloudflare Dashboard → D1 → 执行 SQL 中运行

-- 小说表
CREATE TABLE IF NOT EXISTS novels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT DEFAULT '',
  description TEXT DEFAULT '',
  drive_links TEXT DEFAULT '[]',   -- JSON 数组: [{"label":"百度网盘","url":"...","code":"ab12"}]
  tags TEXT DEFAULT '',             -- 逗号分隔
  view_count INTEGER DEFAULT 0,    -- 热度值，越大越靠前（热门 Tab 排序依据）
  is_featured INTEGER DEFAULT 0,   -- 精选标记，0=普通 1=精选（精选 Tab 只展示 1）
  created_at TEXT DEFAULT (datetime('now'))
);

-- 留言表
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_name TEXT NOT NULL,
  note TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',   -- pending / accepted / completed / rejected
  created_at TEXT DEFAULT (datetime('now'))
);

-- 全文搜索索引
CREATE VIRTUAL TABLE IF NOT EXISTS novels_fts USING fts5(
  title, author, description, tags,
  content='novels', content_rowid='id'
);

-- 自动同步 FTS 索引的触发器
CREATE TRIGGER IF NOT EXISTS novels_ai AFTER INSERT ON novels BEGIN
  INSERT INTO novels_fts(rowid, title, author, description, tags)
  VALUES (new.id, new.title, new.author, new.description, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS novels_ad AFTER DELETE ON novels BEGIN
  INSERT INTO novels_fts(novels_fts, rowid, title, author, description, tags)
  VALUES ('delete', old.id, old.title, old.author, old.description, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS novels_au AFTER UPDATE ON novels BEGIN
  INSERT INTO novels_fts(novels_fts, rowid, title, author, description, tags)
  VALUES ('delete', old.id, old.title, old.author, old.description, old.tags);
  INSERT INTO novels_fts(rowid, title, author, description, tags)
  VALUES (new.id, new.title, new.author, new.description, new.tags);
END;

-- 留言状态索引（方便按状态筛选）
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

-- ==========================================
-- 已有数据库升级用（如果数据库已建表，执行以下语句添加新字段）
-- ==========================================
-- ALTER TABLE novels ADD COLUMN view_count INTEGER DEFAULT 0;
-- ALTER TABLE novels ADD COLUMN is_featured INTEGER DEFAULT 0;

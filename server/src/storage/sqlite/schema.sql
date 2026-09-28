PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL UNIQUE COLLATE NOCASE,
    content TEXT NOT NULL,
    rev INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_by TEXT NOT NULL
);

-- Every version ever written, including the current one.
CREATE TABLE IF NOT EXISTS revisions (
    title TEXT NOT NULL COLLATE NOCASE,
    rev INTEGER NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY (title, rev)
);

-- dst is a title, not an id, so links to pages that don't exist yet are kept.
CREATE TABLE IF NOT EXISTS links (
    src INTEGER NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
    dst TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (src, dst)
);
CREATE INDEX IF NOT EXISTS links_dst ON links (dst);

-- Kept out of pages so recording a read doesn't fire the FTS update trigger.
CREATE TABLE IF NOT EXISTS visits (
    page INTEGER PRIMARY KEY REFERENCES pages (id) ON DELETE CASCADE,
    at TEXT NOT NULL
);

-- Web UI preferences as one JSON document; the UI owns its shape.
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    value TEXT NOT NULL
);

-- Pages split at ##/### headings, for passage retrieval.
CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY,
    page INTEGER NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    title TEXT NOT NULL,
    heading TEXT NOT NULL,
    body TEXT NOT NULL,
    UNIQUE (page, ord)
);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5 (
    title, content, content = 'pages', content_rowid = 'id', tokenize = 'porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts (rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
    INSERT INTO pages_fts (pages_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
    INSERT INTO pages_fts (pages_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO pages_fts (rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5 (
    title, heading, body, content = 'sections', content_rowid = 'id', tokenize = 'porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS sections_ai AFTER INSERT ON sections BEGIN
    INSERT INTO sections_fts (rowid, title, heading, body) VALUES (new.id, new.title, new.heading, new.body);
END;
CREATE TRIGGER IF NOT EXISTS sections_ad AFTER DELETE ON sections BEGIN
    INSERT INTO sections_fts (sections_fts, rowid, title, heading, body) VALUES ('delete', old.id, old.title, old.heading, old.body);
END;

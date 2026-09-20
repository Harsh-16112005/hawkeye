"""Create the HawkEye SQLite database and schema.

Run:  python init_db.py
Makes hawkeye.db next to this script with the file_versions table.
"""

import os
import sqlite3

# Put the database next to this script (the project root).
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hawkeye.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS file_versions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    path      TEXT    NOT NULL,                       -- file path relative to project root
    content   TEXT,                                   -- full snapshot of the file at this instant
    operation TEXT    NOT NULL                        -- what happened
                CHECK (operation IN ('created', 'modified', 'deleted', 'renamed')),
    time      TEXT    NOT NULL DEFAULT (datetime('now'))  -- ISO-8601 UTC timestamp
);

-- Fast lookup of a single file's history, newest first.
CREATE INDEX IF NOT EXISTS idx_file_versions_path      ON file_versions(path);
CREATE INDEX IF NOT EXISTS idx_file_versions_path_time ON file_versions(path, time DESC);
"""


def main():
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.executescript(SCHEMA)
        conn.commit()
        print(f"OK - database ready at {DB_PATH}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()

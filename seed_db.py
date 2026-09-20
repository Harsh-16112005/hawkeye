"""Seed hawkeye.db with the 3 files in C:\\Users\\Harsh\\Downloads\\testing
and their version history.

Order of changes (chronological):
  1. main.py  created
  2. app.py   created
  3. temp.c   created
  4. main.py  modified
  5. main.py  modified
  6. app.py   modified
  7. app.py   modified
  8. app.py   modified
  9. temp.c   modified

Result: main.py = 3 versions, app.py = 4 versions, temp.c = 2 versions (9 rows).
Each file's LAST version = its current content on disk in the testing folder.
path stores the full folder path, not just the filename.

Run:  python seed_db.py   (run init_db.py first if the table doesn't exist)
"""

import os
import sqlite3

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hawkeye.db")

# The real folder these versions belong to.
FOLDER = r"C:\Users\Harsh\Downloads\testing"


def p(filename):
    return FOLDER + "\\" + filename


# (path, content, operation, time) in the exact order the changes happened.
ROWS = [
    # --- main.py: 3 versions (last = current on disk) ---
    (p("main.py"),
     'a = "hello world"\n',
     "created", "2026-09-20 09:00:00"),

    (p("app.py"),
     'from flask import Flask\napp = Flask(__name__)\n',
     "created", "2026-09-20 09:15:00"),

    (p("temp.c"),
     '#include<stdio.h>\nint main(){\n    return 0;\n}\n',
     "created", "2026-09-20 09:30:00"),

    (p("main.py"),
     'a = "hello world"\nprint(a)\n',
     "modified", "2026-09-20 10:05:00"),

    (p("main.py"),
     'a="hello world"\nprint(a)\n\nif a=="helloworld":\n    print("same")\n',
     "modified", "2026-09-20 11:20:00"),

    # --- app.py: 4 versions (last = current on disk) ---
    (p("app.py"),
     'from flask import Flask\napp = Flask(__name__)\n\n'
     '@app.route("/")\ndef homepage():\n    return "hi"\n',
     "modified", "2026-09-20 11:45:00"),

    (p("app.py"),
     'from flask import Flask, render_template\napp = Flask(__name__)\n\n'
     '@app.route("/")\ndef homepage():\n    return render_template("index.html")\n',
     "modified", "2026-09-20 13:10:00"),

    (p("app.py"),
     'from flask import Flask, render_template\napp=Flask(__name__)\n\n'
     '@app.route("/")\ndef homepage():\n    return render_template("home.html")\n',
     "modified", "2026-09-20 14:30:00"),

    # --- temp.c: 2 versions (last = current on disk) ---
    (p("temp.c"),
     '#include<stdio.h>\nint main(){\n    int a=10;\n    int b=20;\n'
     '    printf(a+b);\n}\n',
     "modified", "2026-09-20 15:00:00"),
]


def main():
    conn = sqlite3.connect(DB_PATH)
    try:
        # Start clean so re-running gives the same deterministic result.
        conn.execute("DELETE FROM file_versions")
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'file_versions'")
        conn.executemany(
            "INSERT INTO file_versions (path, content, operation, time) "
            "VALUES (?, ?, ?, ?)",
            ROWS,
        )
        conn.commit()

        print(f"Seeded {len(ROWS)} rows into {DB_PATH}\n")
        for filename in ("main.py", "app.py", "temp.c"):
            n = conn.execute(
                "SELECT count(*) FROM file_versions WHERE path = ?", (p(filename),)
            ).fetchone()[0]
            print(f"  {p(filename):45} {n} versions")
    finally:
        conn.close()


if __name__ == "__main__":
    main()

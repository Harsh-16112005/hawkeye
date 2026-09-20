"""HawkEye web server.

Runs on the user's own machine, which is what lets it open a native folder
dialog, walk any folder on disk, and write files back on restore. Files come
from disk; version history comes from the SQLite DB (filled by the watcher).
"""

import os
import sqlite3

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# The version database lives next to this file.
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hawkeye.db")


def norm(p):
    """Compare paths regardless of \\ vs / (picker gives /, DB stores \\)."""
    return (p or "").replace("\\", "/")


# --- Pages (each nav tab renders a template) ---

@app.route("/")
def index():
    return render_template("index.html", active_page="home")

@app.route("/dashboard")
def dashboard():
    return render_template("dashboard.html", active_page="dashboard")

@app.route("/timeline")
def timeline():
    return render_template("timeline.html", active_page="timeline")


# --- API (JSON endpoints the frontend calls) ---

@app.route("/api/pick-folder", methods=["POST"])
def pick_folder():
    """Open the OS folder dialog and return the chosen full path.

    Works because HawkEye's server runs on the user's own machine.
    """
    import tkinter
    from tkinter import filedialog

    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    path = filedialog.askdirectory(title="Select a folder to view")
    root.destroy()
    return jsonify({"path": path or ""})

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".idea", ".vscode"}


@app.route("/api/files")
def files():
    """Every real file inside a folder on disk (full paths).

    Works for ANY folder because the server runs on the user's machine.
    Versions still come from the DB per file (empty until the watcher
    records one).
    """
    folder = request.args.get("folder") or ""
    if not os.path.isdir(folder):
        return jsonify([])
    out = []
    for root, dirs, names in os.walk(folder):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for name in names:
            out.append(os.path.join(root, name))
    return jsonify(sorted(out))

@app.route("/api/versions")
def versions():
    """All stored versions of one file, oldest first (exact path match)."""
    name = norm(request.args.get("path"))
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT operation, content, time FROM file_versions "
            "WHERE replace(path, '\\', '/') = ? ORDER BY time",
            (name,),
        ).fetchall()
    finally:
        conn.close()
    return jsonify([dict(r) for r in rows])

@app.route("/api/restore", methods=["POST"])
def restore():
    """Write a stored version's content back to the file on disk.

    Content is read from the DB (by path + time), not trusted from the
    client. Works because the server runs on the user's own machine.
    """
    data = request.get_json(silent=True) or {}
    path = data.get("path") or ""
    when = data.get("time") or ""

    conn = sqlite3.connect(DB_PATH)
    try:
        row = conn.execute(
            "SELECT content FROM file_versions "
            "WHERE replace(path, '\\', '/') = ? AND time = ?",
            (norm(path), when),
        ).fetchone()
    finally:
        conn.close()

    if row is None:
        return jsonify({"ok": False, "error": "version not found"}), 404
    try:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(row[0] or "")
    except OSError as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=True)

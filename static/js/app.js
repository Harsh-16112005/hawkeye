/*
 * HawkEye home page.
 * Explorer (left): folders picked from disk, shown as file trees.
 * View Changes (middle): the selected version diffed against the previous one.
 * Old Versions (right): the file's full history; also drives Restore.
 * All wrapped in an IIFE so nothing leaks to the global scope.
 */
(function () {
  'use strict';

  var MAX_PREVIEW_BYTES = 256 * 1024;  // cap diff input so huge files stay fast
  var INDENT = 14;                     // per-depth indent (px) in the file tree

  // Whole-app state. Everything on screen is derived from this.
  var state = {
    folders: [],        // [{ path, tree }] — every open folder, shown side by side
    versionsByPath: {}, // full path -> [versions, oldest..newest] (cached from the DB)
    activePath: null,   // full path of the file currently open
    activeIndex: -1     // which version of that file is shown (index into its array)
  };

  var LS_KEY = 'hawkeye.folders';     // localStorage key for the open-folder list
  var selectToken = 0;                // bumped per file click to ignore stale loads

  // Normalize a path for comparison: backslashes -> forward slashes.
  function jnorm(p) { return (p || '').replace(/\\/g, '/'); }

  // Persist the open folder paths so they reopen next visit.
  function saveFolders() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state.folders.map(function (f) { return f.path; })));
    } catch (e) { /* private mode / disabled storage — fine, just won't persist */ }
  }

  // Read back the saved folder paths (empty list if none / unreadable).
  function loadFolderPaths() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch (e) { return []; }
  }

  var EXT_ICONS = {
    py: 'fa-brands fa-python',
    js: 'fa-brands fa-js',
    mjs: 'fa-brands fa-js',
    cjs: 'fa-brands fa-js',
    ts: 'fa-solid fa-file-code',
    jsx: 'fa-brands fa-react',
    tsx: 'fa-brands fa-react',
    html: 'fa-brands fa-html5',
    htm: 'fa-brands fa-html5',
    css: 'fa-brands fa-css3-alt',
    scss: 'fa-brands fa-sass',
    sass: 'fa-brands fa-sass',
    json: 'fa-solid fa-file-code',
    md: 'fa-brands fa-markdown',
    txt: 'fa-solid fa-file-lines',
    log: 'fa-solid fa-file-lines',
    sql: 'fa-solid fa-database',
    db: 'fa-solid fa-database',
    sqlite: 'fa-solid fa-database',
    png: 'fa-solid fa-file-image',
    jpg: 'fa-solid fa-file-image',
    jpeg: 'fa-solid fa-file-image',
    gif: 'fa-solid fa-file-image',
    svg: 'fa-solid fa-file-image',
    webp: 'fa-solid fa-file-image',
    ico: 'fa-solid fa-file-image',
    pdf: 'fa-solid fa-file-pdf',
    csv: 'fa-solid fa-file-csv',
    zip: 'fa-solid fa-file-zipper',
    gz: 'fa-solid fa-file-zipper',
    tar: 'fa-solid fa-file-zipper',
    bat: 'fa-solid fa-terminal',
    ps1: 'fa-solid fa-terminal',
    sh: 'fa-solid fa-terminal',
    cmd: 'fa-solid fa-terminal',
    yml: 'fa-solid fa-gear',
    yaml: 'fa-solid fa-gear',
    toml: 'fa-solid fa-gear',
    ini: 'fa-solid fa-gear',
    env: 'fa-solid fa-gear'
  };

  // Short querySelector alias.
  function $(sel) { return document.querySelector(sel); }

  // Create an element with an optional class and text, in one call.
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // Last path segment (the file name) from a Windows or POSIX path.
  function baseName(path) { return path.split(/[\\/]/).pop(); }

  // Pick a Font Awesome icon class from a file's extension.
  function iconFor(name) {
    var ext = name.split('.').pop().toLowerCase();
    return EXT_ICONS[ext] || 'fa-solid fa-file';
  }

  // Human-readable byte size (B / KB / MB).
  function fmtSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  // Short date, e.g. "Sep 20, 2026".
  function fmtDate(ms) {
    if (!ms) return 'unknown';
    return new Date(ms).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric'
    });
  }

  // Time of day, e.g. "10:05:00 AM".
  function fmtTime(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  // Sort a node's children: folders first, then files, each A->Z.
  function sortNodes(nodes) {
    nodes.sort(function (a, b) {
      if (a.kind === b.kind) return a.name.localeCompare(b.name);
      return a.kind === 'dir' ? -1 : 1;
    });
  }

  // Sort the whole tree recursively.
  function sortTree(node) {
    if (!node.children) return;
    sortNodes(node.children);
    node.children.forEach(sortTree);
  }

  // Build a centered "nothing here" placeholder (icon + title + message).
  function emptyState(icon, title, msg) {
    var wrap = el('div', 'empty-state');
    wrap.appendChild(el('i', 'fa-solid ' + icon));
    wrap.appendChild(el('p', 'empty-title', title));
    if (msg) wrap.appendChild(el('p', null, msg));
    return wrap;
  }

  // Treat text as binary if a NUL byte appears in the first 2 KB.
  function looksBinary(text) {
    return text.slice(0, 2000).indexOf('\u0000') !== -1;
  }

  /* ------------------------------------------------------------------ *
   * Folders and the file tree
   * Files come from disk (/api/files); version history comes from the DB.
   * ------------------------------------------------------------------ */

  // Turn a flat list of full file paths into a nested folder/file tree.
  // Each node keeps its full path so it round-trips back to /api/versions.
  function treeFromPaths(folder, paths) {
    var nf = folder.replace(/\\/g, '/').replace(/\/+$/, '');
    var rootName = nf.split('/').pop() || 'Folder';
    var root = { name: rootName, kind: 'dir', path: folder, children: [] };

    paths.forEach(function (full) {
      var rel = full.replace(/\\/g, '/');
      if (rel.indexOf(nf + '/') === 0) rel = rel.slice(nf.length + 1);
      var parts = rel.split('/').filter(Boolean);
      if (!parts.length) return;

      var cur = root;
      for (var j = 0; j < parts.length; j++) {
        var part = parts[j];
        if (j === parts.length - 1) {
          cur.children.push({ name: part, kind: 'file', path: full });
          break;
        }
        var next = null;
        for (var k = 0; k < cur.children.length; k++) {
          if (cur.children[k].kind === 'dir' && cur.children[k].name === part) {
            next = cur.children[k];
            break;
          }
        }
        if (!next) {
          next = { name: part, kind: 'dir', path: nf + '/' + parts.slice(0, j + 1).join('/'), children: [] };
          cur.children.push(next);
        }
        cur = next;
      }
    });

    sortTree(root);
    return root;
  }

  // Ask the backend for every file path inside a folder (walked on disk).
  async function fetchFiles(folder) {
    try {
      var res = await fetch('/api/files?folder=' + encodeURIComponent(folder));
      if (!res.ok) return [];
      return await res.json();
    } catch (err) {
      return [];
    }
  }

  // Load a folder's files from disk and add it alongside the others.
  async function addFolder(path) {
    if (!path) return;
    if (state.folders.some(function (f) { return f.path === path; })) return;  // already open
    var paths = await fetchFiles(path);
    state.folders.push({ path: path, tree: treeFromPaths(path, paths) });
    saveFolders();
    renderExplorer();
  }

  // Ask the server (running on this machine) to open the OS folder dialog,
  // then ADD the chosen folder (keeping any already-open folders).
  async function pickFolder() {
    var path;
    try {
      var res = await fetch('/api/pick-folder', { method: 'POST' });
      path = (await res.json()).path;
    } catch (err) {
      alert('Could not open the folder picker. Is the HawkEye server running?');
      return;
    }
    if (!path) return;  // cancelled
    await addFolder(path);
  }

  function removeFolder(path) {
    state.folders = state.folders.filter(function (f) { return f.path !== path; });
    saveFolders();
    // If the open file lived in this folder, clear the right-hand panes.
    if (state.activePath && jnorm(state.activePath).indexOf(jnorm(path)) === 0) {
      state.activePath = null;
      state.activeIndex = -1;
      renderChangesEmpty('Select a file to view its contents');
      renderVersionsEmpty('Select a file to view its versions');
    }
    renderExplorer();
  }

  // Restore folders saved from a previous session.
  async function restoreFolders() {
    var paths = loadFolderPaths();
    for (var i = 0; i < paths.length; i++) await addFolder(paths[i]);
  }

  // Recursively build the DOM for one tree node (folder or file).
  // onRemove is only passed for a folder ROOT, which adds the "x" button.
  function createTreeEl(node, depth, onRemove) {
    var wrap = el('div');
    var row = el('div', 'tree-row ' + (node.kind === 'dir' ? 'dir' : 'file'));
    row.style.paddingLeft = (depth * INDENT + 8) + 'px';

    if (node.kind === 'dir') {
      var caret = el('i', 'fa-solid fa-caret-down caret');
      var folderIcon = el('i', 'fa-solid fa-folder-open');
      row.appendChild(caret);
      row.appendChild(folderIcon);
      row.appendChild(el('span', 'tree-name', node.name));
      row.title = node.path;

      if (onRemove) {
        row.classList.add('ws-root');
        var rm = el('button', 'tree-remove');
        rm.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        rm.title = 'Remove folder';
        rm.addEventListener('click', function (e) { e.stopPropagation(); onRemove(); });
        row.appendChild(rm);
      }

      var kids = el('div');
      for (var i = 0; i < node.children.length; i++) {
        kids.appendChild(createTreeEl(node.children[i], depth + 1));
      }

      row.addEventListener('click', function () {
        kids.hidden = !kids.hidden;
        var open = !kids.hidden;
        caret.className = 'fa-solid ' + (open ? 'fa-caret-down' : 'fa-caret-right') + ' caret';
        folderIcon.className = 'fa-solid ' + (open ? 'fa-folder-open' : 'fa-folder');
      });

      wrap.appendChild(row);
      wrap.appendChild(kids);
    } else {
      row.appendChild(el('span', 'caret-spacer'));
      row.appendChild(el('i', iconFor(node.name)));
      row.appendChild(el('span', 'tree-name', node.name));
      row.title = node.path;
      if (state.activePath === node.path) row.classList.add('selected');
      row.addEventListener('click', function () { selectFile(node, row); });
      wrap.appendChild(row);
    }

    return wrap;
  }

  // Redraw the Explorer: one tree per open folder, or a prompt if none.
  function renderExplorer() {
    var body = $('#explorer-body');
    body.innerHTML = '';

    if (!state.folders.length) {
      body.appendChild(folderPrompt());
      return;
    }

    state.folders.forEach(function (f) {
      var group = createTreeEl(f.tree, 0, function () { removeFolder(f.path); });
      group.classList.add('ws-group');
      body.appendChild(group);
    });
  }

  // The "no folder open" placeholder with an Add-folder button.
  function folderPrompt() {
    var wrap = el('div', 'empty-state');
    wrap.appendChild(el('i', 'fa-solid fa-folder-open'));
    wrap.appendChild(el('p', 'empty-title', 'No folder open'));
    wrap.appendChild(el('p', null, 'Add one or more folders to view. They stay open across visits.'));
    var btn = el('button');
    btn.appendChild(el('i', 'fa-solid fa-folder-open'));
    btn.appendChild(document.createTextNode(' Add folder'));
    btn.addEventListener('click', pickFolder);
    wrap.appendChild(btn);
    return wrap;
  }

  /* ------------------------------------------------------------------ *
   * Version store (loaded from the backend DB)
   * ------------------------------------------------------------------ */

  // Cached versions for a path (empty array if none loaded yet).
  function versionsFor(path) {
    return state.versionsByPath[path] || [];
  }

  // Load a file's stored versions from the backend DB, oldest first.
  async function fetchDbVersions(path) {
    try {
      var res = await fetch('/api/versions?path=' + encodeURIComponent(path));
      if (!res.ok) return [];
      var rows = await res.json();
      return rows.map(function (r) {
        return {
          time: Date.parse(r.time.replace(' ', 'T') + 'Z'),
          rawTime: r.time,   // exact DB string — the restore lookup key
          size: r.content ? r.content.length : 0,
          operation: r.operation,
          text: r.content || ''
        };
      });
    } catch (err) {
      return [];
    }
  }

  /* ------------------------------------------------------------------ *
   * Restore — modal: pick a version, confirm, write it back to disk
   * ------------------------------------------------------------------ */

  function openRestoreModal() {
    if (!state.activePath || !versionsFor(state.activePath).length) return;
    renderRestorePicker();
    $('#restore-modal').hidden = false;
  }

  function closeRestoreModal() {
    $('#restore-modal').hidden = true;
  }

  // Step 1 — list every version, newest first, to pick which to restore.
  function renderRestorePicker() {
    var path = state.activePath;
    var versions = versionsFor(path);
    $('#restore-modal-title').textContent = 'Restore ' + baseName(path);

    var body = $('#restore-modal-body');
    body.innerHTML = '';
    body.appendChild(el('p', 'modal-note',
      'Pick an earlier version to restore. Its content is written back into the file, ' +
      'replacing the current one. (The latest version is the current file, so it isn’t listed.)'));

    // Skip the latest version — that's already the current file on disk.
    var list = el('div', 'modal-vlist');
    for (var i = versions.length - 2; i >= 0; i--) {
      (function (idx) {
        var v = versions[idx];
        var item = el('button', 'modal-vitem');
        item.appendChild(el('div', 'modal-vitem-name', 'Version ' + (idx + 1)));
        item.appendChild(el('div', 'modal-vitem-meta',
          fmtDate(v.time) + ' · ' + fmtTime(v.time) + ' · ' + (v.operation || 'saved')));
        item.addEventListener('click', function () { renderRestoreConfirm(idx); });
        list.appendChild(item);
      })(i);
    }
    body.appendChild(list);
  }

  // Step 2 — confirm the picked version before overwriting.
  function renderRestoreConfirm(index) {
    var path = state.activePath;
    var versions = versionsFor(path);
    var v = versions[index];
    var verNo = index + 1;
    var name = baseName(path);

    $('#restore-modal-title').textContent = 'Confirm restore';
    var body = $('#restore-modal-body');
    body.innerHTML = '';

    var q = el('p', 'modal-confirm-q');
    q.appendChild(document.createTextNode('Restore '));
    q.appendChild(el('strong', null, name));
    q.appendChild(document.createTextNode(' to Version ' + verNo + '?'));
    body.appendChild(q);

    body.appendChild(el('div', 'modal-vitem-meta',
      fmtDate(v.time) + ' · ' + fmtTime(v.time) + ' · ' + (v.operation || 'saved')));
    body.appendChild(el('p', 'modal-note',
      'This writes that version’s content to the file. It’s saved as a new version, ' +
      'so the current one stays in history and you can switch back anytime.'));

    var actions = el('div', 'modal-actions');
    var back = el('button', 'modal-btn', 'Back');
    back.addEventListener('click', renderRestorePicker);
    var go = el('button', 'modal-btn primary');
    go.appendChild(el('i', 'fa-solid fa-rotate-left'));
    go.appendChild(document.createTextNode(' Restore'));
    go.addEventListener('click', function () { doRestore(path, v, verNo); });
    actions.appendChild(back);
    actions.appendChild(go);
    body.appendChild(actions);
  }

  // Step 3 — ask the backend to write the version's content to disk.
  async function doRestore(path, version, verNo) {
    var name = baseName(path);
    var body = $('#restore-modal-body');
    body.innerHTML = '';
    body.appendChild(el('p', 'modal-note', 'Restoring…'));

    var ok = false, msg = '';
    try {
      var res = await fetch('/api/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path, time: version.rawTime })
      });
      var data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'restore failed');
      ok = true;
    } catch (err) {
      msg = err.message;
    }

    body.innerHTML = '';
    var line = el('p', ok ? 'modal-done' : 'modal-err');
    line.appendChild(el('i', 'fa-solid ' + (ok ? 'fa-circle-check' : 'fa-circle-exclamation')));
    line.appendChild(document.createTextNode(ok
      ? ' ' + name + ' restored to Version ' + verNo + '.'
      : ' Could not restore: ' + msg));
    body.appendChild(line);

    var actions = el('div', 'modal-actions');
    var done = el('button', 'modal-btn primary', 'Done');
    done.addEventListener('click', closeRestoreModal);
    actions.appendChild(done);
    body.appendChild(actions);
  }

  // Open a specific version of the active file: render its diff + history.
  function showVersion(path, index) {
    var versions = versionsFor(path);
    if (!versions.length) return;

    state.activePath = path;
    state.activeIndex = Math.max(0, Math.min(index, versions.length - 1));

    // Restore only makes sense when there's an older version to go back to.
    $('#btn-restore').hidden = versions.length < 2;
    $('#diff-legend').hidden = false;
    renderCompare(path);
    renderVersions();
  }

  // Move to the previous/next version (Alt+Left / Alt+Right).
  function stepVersion(delta) {
    var versions = versionsFor(state.activePath);
    if (!versions.length) return;
    var next = state.activeIndex + delta;
    if (next < 0 || next > versions.length - 1) return;
    showVersion(state.activePath, next);
  }

  /* ------------------------------------------------------------------ *
   * View Changes - selected version vs its previous (side-by-side diff)
   * ------------------------------------------------------------------ */

  // Line-based diff via LCS. Returns rows tagged same | add | del.
  // ponytail: O(n*m) table, fine for source files; inputs capped by caller.
  function diffLines(oldText, newText) {
    var a = oldText.length ? oldText.split('\n') : [];
    var b = newText.length ? newText.split('\n') : [];
    var m = a.length, n = b.length;

    var lcs = [];
    for (var i = 0; i <= m; i++) lcs[i] = new Array(n + 1).fill(0);
    for (i = m - 1; i >= 0; i--) {
      for (var j = n - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }

    var rows = [];
    i = 0; j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { rows.push({ tag: 'same', o: i + 1, n: j + 1, text: b[j] }); i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) { rows.push({ tag: 'del', o: i + 1, n: null, text: a[i] }); i++; }
      else { rows.push({ tag: 'add', o: null, n: j + 1, text: b[j] }); j++; }
    }
    while (i < m) { rows.push({ tag: 'del', o: i + 1, n: null, text: a[i] }); i++; }
    while (j < n) { rows.push({ tag: 'add', o: null, n: j + 1, text: b[j] }); j++; }
    return rows;
  }

  // Pair adjacent del+add runs into 'chg' rows so a modified line lines up
  // left-vs-right. Every row ends with oldText/newText (null = blank side).
  function pairRows(rows) {
    var out = [];
    var i = 0;
    while (i < rows.length) {
      if (rows[i].tag === 'del') {
        var dels = [];
        while (i < rows.length && rows[i].tag === 'del') { dels.push(rows[i]); i++; }
        var adds = [];
        while (i < rows.length && rows[i].tag === 'add') { adds.push(rows[i]); i++; }
        var k = Math.max(dels.length, adds.length);
        for (var x = 0; x < k; x++) {
          var d = dels[x], a = adds[x];
          if (d && a) out.push({ tag: 'chg', o: d.o, n: a.n, oldText: d.text, newText: a.text });
          else if (d) out.push({ tag: 'del', o: d.o, n: null, oldText: d.text, newText: null });
          else out.push({ tag: 'add', o: null, n: a.n, oldText: null, newText: a.text });
        }
      } else if (rows[i].tag === 'add') {
        out.push({ tag: 'add', o: null, n: rows[i].n, oldText: null, newText: rows[i].text });
        i++;
      } else {
        out.push({ tag: 'same', o: rows[i].o, n: rows[i].n, oldText: rows[i].text, newText: rows[i].text });
        i++;
      }
    }
    return out;
  }

  // One side (left or right) of a diff row: line number + line text.
  function diffSide(lineNo, text, cls) {
    var side = el('div', 'diff-side ' + cls);
    side.appendChild(el('span', 'ln', lineNo == null ? '' : String(lineNo)));
    var lc = el('span', 'lc');
    lc.textContent = text == null ? '' : text;
    side.appendChild(lc);
    return side;
  }

  // Render the side-by-side diff of the active version vs the one before it.
  function renderCompare(path) {
    var versions = versionsFor(path);
    var v = versions[state.activeIndex];
    var prev = state.activeIndex > 0 ? versions[state.activeIndex - 1] : null;
    var rightNo = state.activeIndex + 1;

    $('#changes-file').textContent = baseName(path);
    $('#changes-meta').textContent = prev
      ? 'Version ' + (rightNo - 1) + ' (previous)  →  Version ' + rightNo + ' (current)'
      : 'Version 1 — no previous version, everything is new';

    var body = $('#changes-body');
    body.className = 'pane-body compare-body';
    body.innerHTML = '';

    if (looksBinary(v.text) || (prev && looksBinary(prev.text))) {
      body.appendChild(emptyState('fa-file', 'Binary file', 'Compare is not available for binary files.'));
      return;
    }

    var oldText = prev ? prev.text.slice(0, MAX_PREVIEW_BYTES) : '';
    var newText = v.text.slice(0, MAX_PREVIEW_BYTES);
    var rows = pairRows(diffLines(oldText, newText));

    var head = el('div', 'diff-head');
    head.appendChild(el('div', 'diff-head-cell', prev ? 'Version ' + (rightNo - 1) : 'None'));
    head.appendChild(el('div', 'diff-head-cell', 'Version ' + rightNo));
    body.appendChild(head);

    var table = el('div', 'diff-table');
    rows.forEach(function (r) {
      var row = el('div', 'diff-row ' + r.tag);
      var leftCls = r.tag === 'del' || r.tag === 'chg' ? 'old' : (r.tag === 'add' ? 'blank' : 'ctx');
      var rightCls = r.tag === 'add' || r.tag === 'chg' ? 'new' : (r.tag === 'del' ? 'blank' : 'ctx');
      row.appendChild(diffSide(r.o, r.oldText, leftCls));
      row.appendChild(diffSide(r.n, r.newText, rightCls));
      table.appendChild(row);
    });
    body.appendChild(table);
  }

  // Reset the middle pane to an empty placeholder (no file / loading / none).
  function renderChangesEmpty(msg) {
    $('#changes-file').textContent = 'No file selected';
    $('#changes-meta').textContent = '';
    $('#btn-restore').hidden = true;
    $('#diff-legend').hidden = true;
    var body = $('#changes-body');
    body.className = 'pane-body';
    body.innerHTML = '';
    body.appendChild(emptyState('fa-code', 'View Changes', msg));
  }

  /* ------------------------------------------------------------------ *
   * Old Versions pane
   * ------------------------------------------------------------------ */

  // Reset the Old Versions pane to an empty placeholder.
  function renderVersionsEmpty(msg) {
    var body = $('#versions-body');
    $('#versions-count').textContent = '';
    body.innerHTML = '';
    body.appendChild(emptyState('fa-clock-rotate-left', 'Old Versions', msg));
  }

  // Render the version-history timeline (newest first) in the right pane.
  function renderVersions() {
    var body = $('#versions-body');
    body.innerHTML = '';

    var versions = versionsFor(state.activePath);
    var count = $('#versions-count');

    if (!versions.length) {
      count.textContent = '';
      body.appendChild(emptyState(
        'fa-clock-rotate-left',
        'No versions yet',
        'This file has no recorded versions yet.'
      ));
      return;
    }

    count.textContent = versions.length === 1 ? '1 version' : versions.length + ' versions';

    var ul = el('ul', 'ver-list');
    // Newest first.
    for (let i = versions.length - 1; i >= 0; i--) {
      const v = versions[i];
      const isLatest = i === versions.length - 1;

      var li = el('li', 'ver-item' + (i === state.activeIndex ? ' active' : '') + (isLatest ? ' current' : ''));

      var rail = el('div', 'ver-rail');
      rail.appendChild(el('span', 'ver-dot'));
      if (i > 0) rail.appendChild(el('span', 'ver-line'));
      li.appendChild(rail);

      var inner = el('div', 'ver-body');
      var title = el('div', 'ver-title');
      title.appendChild(el('span', null, 'Version ' + (i + 1)));
      if (isLatest) title.appendChild(el('span', 'ver-tag', 'Latest'));
      inner.appendChild(title);
      inner.appendChild(el('div', 'ver-meta', fmtDate(v.time) + ' · ' + fmtSize(v.size)));
      inner.appendChild(el('div', 'ver-meta',
        (v.operation || 'saved') + ' · ' + fmtTime(v.time)));
      li.appendChild(inner);
      li.title = state.activePath + ' — version ' + (i + 1) + ' of ' + versions.length;

      li.addEventListener('click', function () {
        if (state.activeIndex !== i) showVersion(state.activePath, i);
      });

      ul.appendChild(li);
    }

    body.appendChild(ul);
  }

  /* ------------------------------------------------------------------ *
   * File selection and startup
   * ------------------------------------------------------------------ */

  // Open a file: highlight it, load its versions from the DB, show the latest.
  // selectToken guards against a slow earlier click overwriting a newer one.
  async function selectFile(node, row) {
    var token = ++selectToken;

    var prev = document.querySelectorAll('.tree-row.file.selected');
    for (var i = 0; i < prev.length; i++) prev[i].classList.remove('selected');
    if (row) row.classList.add('selected');

    state.activePath = node.path;
    state.activeIndex = -1;
    renderChangesEmpty('Loading file contents…');
    renderVersionsEmpty('Loading version history…');

    var versions = await fetchDbVersions(node.path);
    if (token !== selectToken) return;

    if (!versions.length) {
      renderChangesEmpty('No stored versions for this file yet.');
      renderVersionsEmpty('No versions recorded yet.');
      return;
    }

    state.versionsByPath[node.path] = versions;
    showVersion(node.path, versions.length - 1);
  }

  // Wire up buttons + keyboard, draw the initial empty UI, restore folders.
  function init() {
    $('#btn-add-ws').addEventListener('click', pickFolder);
    $('#btn-restore').addEventListener('click', openRestoreModal);
    $('#restore-modal-close').addEventListener('click', closeRestoreModal);
    $('#restore-modal').addEventListener('click', function (e) {
      if (e.target === this) closeRestoreModal();  // click backdrop to close
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#restore-modal').hidden) { closeRestoreModal(); return; }
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        stepVersion(e.key === 'ArrowLeft' ? -1 : 1);
      }
    });

    renderExplorer();
    renderChangesEmpty('Select a folder to get started');
    renderVersionsEmpty('Select a folder to get started');
    restoreFolders();
  }

  init();
})();

import { useState, useEffect, useCallback, useRef } from "react";

const STORAGE_KEY = "sql-snapshots";

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseData(text) {
  const lines = text.split("\n");
  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.length < 2) return null;
  const first = nonEmpty[0];
  const delim = first.includes("\t") ? "\t" : first.includes("|") ? "|" : ",";
  const clean = (s) => s.trim().replace(/^"|"$/g, "").trim();
  const headers = first.split(delim).map(clean).filter(Boolean);
  const rows = nonEmpty.slice(1)
    .filter(l => !l.match(/^[-|+ ]+$/))
    .map(l => {
      const cells = l.split(delim).map(clean);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cells[i] ?? ""; });
      return obj;
    });
  return { headers, rows };
}

function readFileWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    reader.onload = (e) => { onProgress(100); resolve(e.target.result); };
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsText(file);
  });
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Multi-snapshot diff ───────────────────────────────────────────────────────
// Returns { allHeaders, keyHeaders, diffHeaders, rows[] }
// rows[i] = { key, status, data: Map<snapId, rowObj> }
// status: "same" | "changed" | "partial"

function diffMulti(snaps, keyCols = new Set(), excludedCols = new Set()) {
  const allHeaders = [...new Set(snaps.flatMap(s => s.data.headers))];
  const keyHeaders = keyCols.size > 0
    ? [...keyCols]
    : allHeaders.filter(h => !excludedCols.has(h));
  const diffHeaders = allHeaders.filter(h => !excludedCols.has(h) && !keyCols.has(h));

  const makeKey = (row) => keyHeaders.map(h => row[h] ?? "").join("|||");

  const rowMap = new Map(); // key -> Map(snapId -> rowData)
  for (const snap of snaps) {
    for (const row of snap.data.rows) {
      const k = makeKey(row);
      if (!rowMap.has(k)) rowMap.set(k, new Map());
      rowMap.get(k).set(snap.id, row);
    }
  }

  const snapIds = snaps.map(s => s.id);
  const rows = [];

  for (const [key, snapData] of rowMap) {
    const absentIn = snapIds.filter(id => !snapData.has(id));
    let status;
    if (absentIn.length > 0) {
      status = "partial";
    } else {
      const baseRow = snapData.get(snapIds[0]);
      const changed = diffHeaders.some(h =>
        snapIds.some(id => (snapData.get(id)?.[h] ?? "") !== (baseRow[h] ?? ""))
      );
      status = changed ? "changed" : "same";
    }
    rows.push({ key, status, data: snapData });
  }

  return { allHeaders, keyHeaders, diffHeaders, rows };
}

// ── Export builders ───────────────────────────────────────────────────────────

function buildCSV(result, snaps) {
  const { allHeaders, rows } = result;
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["_status", ...allHeaders.flatMap(h => snaps.map(s => `${h}[${s.label}]`))];
  const lines = [header.map(escape).join(",")];
  for (const row of rows) {
    const cells = [row.status, ...allHeaders.flatMap(h => snaps.map(s => row.data.get(s.id)?.[h] ?? ""))];
    lines.push(cells.map(escape).join(","));
  }
  return lines.join("\n");
}

function buildJSON(result, snaps, keyCols, excludedCols) {
  const summary = { changed: 0, partial: 0, same: 0 };
  result.rows.forEach(r => summary[r.status]++);
  const payload = {
    generatedAt: new Date().toISOString(),
    snapshots: snaps.map(s => ({ label: s.label, ts: s.ts, rows: s.data.rows.length })),
    keyCols: [...keyCols], excludedCols: [...excludedCols],
    summary,
    rows: result.rows.map(row => ({
      _status: row.status,
      ...Object.fromEntries(snaps.map(s => [s.label, row.data.get(s.id) ?? null]))
    }))
  };
  return JSON.stringify(payload, null, 2);
}

function buildHTML(result, snaps, keyCols, excludedCols) {
  const { keyHeaders, diffHeaders, rows } = result;
  const summary = { changed: 0, partial: 0, same: 0 };
  rows.forEach(r => summary[r.status]++);
  const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const statusColor = { changed: "#d97706", partial: "#7c3aed", same: "#6b7280" };
  const statusLabel = { changed: "~", partial: "◑", same: " " };
  const TINTS = ["#3b82f6","#16a34a","#ea580c","#9333ea","#e11d48","#0891b2"];

  const thead = `<tr>
    <th>Δ</th>
    ${keyHeaders.map(h => `<th>${esc(h)} <span class="tag key">key</span></th>`).join("")}
    ${diffHeaders.map(h => `<th colspan="${snaps.length}">${esc(h)}${excludedCols.has(h) ? ' <span class="tag exc">excl</span>' : ""}</th>`).join("")}
  </tr><tr class="subhead">
    <th></th>${keyHeaders.map(() => "<th></th>").join("")}
    ${diffHeaders.flatMap(() => snaps.map((s, si) => `<th style="color:${TINTS[si % TINTS.length]}">${esc(s.label)}</th>`)).join("")}
  </tr>`;

  const tbody = rows.map(row => {
    const baseRow = row.data.get(snaps[0].id);
    const keyCells = keyHeaders.map(h => `<td>${esc(baseRow?.[h] ?? "—")}</td>`).join("");
    const diffCells = diffHeaders.flatMap(h =>
      snaps.map((s, si) => {
        const v = row.data.get(s.id)?.[h] ?? "";
        const absent = !row.data.has(s.id);
        const differs = si > 0 && !absent && v !== (baseRow?.[h] ?? "");
        return `<td class="${absent ? "absent" : differs ? "diff" : ""}">${absent ? "<em>absent</em>" : esc(v) || "—"}</td>`;
      })
    ).join("");
    return `<tr class="row ${row.status}"><td class="badge" style="color:${statusColor[row.status]}">${statusLabel[row.status]}</td>${keyCells}${diffCells}</tr>`;
  }).join("\n");

  // Inline JS — split tag name to avoid JSX parser treating it as a closing tag
  const scriptOpen  = "<scr" + "ipt>";
  const scriptClose = "</scr" + "ipt>";

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Multi-Diff — ${snaps.map(s => esc(s.label)).join(" vs ")}</title>
<style>
*{box-sizing:border-box}body{font-family:'IBM Plex Mono','Courier New',monospace;background:#f9fafb;color:#111;margin:0;padding:32px}
h1{font-size:18px;font-weight:600;margin:0 0 4px}.meta{font-size:12px;color:#6b7280;margin-bottom:16px}
.filters{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center}
.filter-btn{padding:5px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;border:2px solid transparent;transition:all .15s;font-family:inherit}
.filter-btn.changed{background:#fef9c3;color:#d97706;border-color:#fef9c3}
.filter-btn.partial{background:#ede9fe;color:#7c3aed;border-color:#ede9fe}
.filter-btn.same{background:#f3f4f6;color:#6b7280;border-color:#f3f4f6}
.filter-btn.off{background:transparent!important;opacity:.45}
.filter-btn.changed.off{border-color:#fde68a;color:#d97706}
.filter-btn.partial.off{border-color:#ddd6fe;color:#7c3aed}
.filter-btn.same.off{border-color:#e5e7eb;color:#6b7280}
.count{font-size:11px;color:#9ca3af;margin-left:4px}
table{width:100%;border-collapse:collapse;font-size:11px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
thead tr{background:#f3f4f6}th{padding:8px 10px;text-align:left;font-weight:500;color:#6b7280;border-bottom:1px solid #e5e7eb;white-space:nowrap}
tr.subhead th{background:#eef0f3;font-size:10px;padding:4px 10px}
td{padding:6px 10px;border-bottom:1px solid #f3f4f6;white-space:nowrap}tr:last-child td{border-bottom:none}
tr.changed{background:#fffbeb}tr.partial{background:#f5f3ff}
tr.hidden{display:none}
td.badge{font-weight:700;width:24px;text-align:center}td.diff{color:#d97706;font-weight:500}td.absent{color:#9ca3af;font-style:italic}
.tag{font-size:9px;font-weight:600;padding:1px 4px;border-radius:3px;margin-left:4px}
.tag.key{background:#dbeafe;color:#2563eb}.tag.exc{background:#ffedd5;color:#ea580c}
.no-rows{display:none;padding:24px;text-align:center;color:#9ca3af;font-size:13px}
@media print{.filters{display:none}tr.hidden{display:none}}
</style></head><body>
<h1>Multi-Snapshot Diff</h1>
<div class="meta">Snapshots: <strong>${snaps.map(s => esc(s.label)).join(" → ")}</strong><br>
Generated: ${new Date().toLocaleString()}
${keyCols.size > 0 ? `<br>Key: <strong>${[...keyCols].map(esc).join(", ")}</strong>` : ""}
${excludedCols.size > 0 ? `<br>Excluded: <strong>${[...excludedCols].map(esc).join(", ")}</strong>` : ""}
</div>
<div class="filters">
  <button class="filter-btn changed" data-type="changed" onclick="toggle(this)">~ <span class="count">${summary.changed}</span> Changed</button>
  <button class="filter-btn partial" data-type="partial" onclick="toggle(this)">◑ <span class="count">${summary.partial}</span> Partial</button>
  <button class="filter-btn same"    data-type="same"    onclick="toggle(this)"><span class="count">${summary.same}</span> Same</button>
  <span style="font-size:11px;color:#d1d5db;margin-left:4px">click to toggle</span>
</div>
<table>
  <thead>${thead}</thead>
  <tbody id="tbody">${tbody}</tbody>
  <tbody><tr><td class="no-rows" id="empty-msg" colspan="999">No rows match the active filters.</td></tr></tbody>
</table>
${scriptOpen}
  var active = {changed:true,partial:true,same:true};
  function toggle(btn){
    var t=btn.dataset.type;
    active[t]=!active[t];
    btn.classList.toggle('off',!active[t]);
    applyFilter();
  }
  function applyFilter(){
    var rows=document.querySelectorAll('#tbody tr.row');
    var visible=0;
    rows.forEach(function(r){
      var show=active[r.classList[1]];
      r.classList.toggle('hidden',!show);
      if(show)visible++;
    });
    document.getElementById('empty-msg').parentElement.style.display=visible===0?'':'none';
  }
${scriptClose}
</body></html>`;
}

// ── Export Modal ──────────────────────────────────────────────────────────────

// Try a real blob download; returns true if it worked, false if blocked (sandbox).
function triggerDownload(content, filename, mime) {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

function ExportModal({ result, snaps, keyCols, excludedCols, onClose }) {
  const [fmt, setFmt] = useState("csv");
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [canDownload, setCanDownload] = useState(null); // null = unknown, true/false after first try

  const MIME = { csv: "text/csv", json: "application/json", html: "text/html" };

  const content = (() => {
    if (fmt === "csv")  return buildCSV(result, snaps);
    if (fmt === "json") return buildJSON(result, snaps, keyCols, excludedCols);
    if (fmt === "html") return buildHTML(result, snaps, keyCols, excludedCols);
    return "";
  })();

  const safeName = (s) => s.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  const slug = snaps.map(s => safeName(s.label)).join("_vs_");
  const filename = `diff_${slug}.${fmt}`;

  const switchFmt = (f) => { setFmt(f); setCopied(false); setDownloaded(false); };

  const handleDownload = () => {
    const ok = triggerDownload(content, filename, MIME[fmt]);
    setCanDownload(ok);
    if (ok) {
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 2500);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  const FORMATS = [
    { id: "csv",  label: "CSV",  desc: "One row per key, all snaps" },
    { id: "json", label: "JSON", desc: "Structured with summary" },
    { id: "html", label: "HTML", desc: "Self-contained report" },
  ];

  // canDownload===false means we already tried and the sandbox blocked it
  const downloadBlocked = canDownload === false;

  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ background: "#111", border: "1px solid #2a2a2a", borderRadius: 10, width: "100%", maxWidth: 680, maxHeight: "88vh", display: "flex", flexDirection: "column", fontFamily: "'IBM Plex Mono','Courier New',monospace" }}>

        {/* Header */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid #1e1e1e", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: "#888", letterSpacing: "0.12em", textTransform: "uppercase" }}>Export Diff</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 0 }}>×</button>
        </div>

        {/* Format tabs */}
        <div style={{ display: "flex", gap: 6, padding: "14px 20px 0", flexShrink: 0 }}>
          {FORMATS.map(f => (
            <button key={f.id} onClick={() => switchFmt(f.id)} style={{
              flex: 1, background: fmt === f.id ? "#1a1a1a" : "transparent",
              border: `1px solid ${fmt === f.id ? "#3a3a3a" : "#1e1e1e"}`,
              color: fmt === f.id ? "#e0e0e0" : "#555",
              borderRadius: 6, padding: "8px 10px", cursor: "pointer", fontFamily: "inherit", textAlign: "center",
            }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{f.label}</div>
              <div style={{ fontSize: 10, color: fmt === f.id ? "#555" : "#333", marginTop: 2 }}>{f.desc}</div>
            </button>
          ))}
        </div>

        {/* Filename + size */}
        <div style={{ padding: "10px 20px 6px", fontSize: 10, color: "#444", flexShrink: 0 }}>
          {filename} · {content.length.toLocaleString()} chars
        </div>

        {/* Content preview */}
        <div style={{ flex: 1, padding: "0 20px", minHeight: 0, overflow: "hidden" }}>
          {fmt === "html" ? (
            <iframe srcDoc={content} sandbox="allow-same-origin" title="HTML preview"
              style={{ width: "100%", height: "100%", minHeight: 220, border: "1px solid #1e1e1e", borderRadius: 6, background: "#fff", display: "block" }} />
          ) : (
            <textarea readOnly value={content} onClick={e => e.target.select()}
              style={{ width: "100%", height: "100%", minHeight: 220, background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 6, color: "#777", padding: 12, fontSize: 11, fontFamily: "inherit", resize: "none", outline: "none", boxSizing: "border-box", display: "block" }} />
          )}
        </div>

        {/* Actions */}
        <div style={{ padding: "14px 20px", borderTop: "1px solid #1a1a1a", flexShrink: 0, display: "flex", flexDirection: "column", gap: 8 }}>

          {/* Primary: Download */}
          <button
            onClick={handleDownload}
            style={{
              width: "100%", padding: "11px 0",
              background: downloaded ? "#0d2e0d" : "#e0e0e0",
              border: `1px solid ${downloaded ? "#3ddc84" : "transparent"}`,
              color: downloaded ? "#3ddc84" : "#000",
              borderRadius: 6, cursor: "pointer", fontSize: 13,
              fontFamily: "inherit", fontWeight: 600, transition: "all 0.15s",
            }}
          >
            {downloaded ? `✓ Downloaded ${fmt.toUpperCase()}!` : `↓ Download ${fmt.toUpperCase()}`}
          </button>

          {/* Secondary: Copy to clipboard — always shown, promoted if download blocked */}
          <button
            onClick={handleCopy}
            style={{
              width: "100%", padding: "9px 0",
              background: copied ? "#0d2e0d" : "#1a1a1a",
              border: `1px solid ${copied ? "#3ddc84" : "#2a2a2a"}`,
              color: copied ? "#3ddc84" : "#888",
              borderRadius: 6, cursor: "pointer", fontSize: 12,
              fontFamily: "inherit", fontWeight: 500, transition: "all 0.15s",
            }}
          >
            {copied ? "✓ Copied to clipboard!" : "Copy to clipboard"}
          </button>

          {/* Hint — only shown after a blocked download attempt */}
          {downloadBlocked && (
            <div style={{ fontSize: 10, color: "#555", textAlign: "center", lineHeight: 1.5 }}>
              Download blocked by sandbox — use Copy above, paste into a text editor, and save as <span style={{ color: "#666" }}>{filename}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function SQLDiff() {
  const [snapshots, setSnapshots] = useState([]);
  const [tab, setTab] = useState("capture");
  // pending = [{ id, name, size, label, data, progress, error }]
  const [pending, setPending] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [keyCols, setKeyCols] = useState(new Set());
  const [excludedCols, setExcludedCols] = useState(new Set());
  const [result, setResult] = useState(null);
  const [savedCount, setSavedCount] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef();

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSnapshots(JSON.parse(raw));
    } catch {}
  }, []);

  const persist = useCallback((snaps) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snaps)); } catch {}
  }, []);

  const addFiles = async (files) => {
    const fileList = [...files].filter(f => f); // FileList -> array
    if (!fileList.length) return;

    // Create pending entries immediately so UI shows them
    const entries = fileList.map(f => ({
      id: Date.now() + Math.random(),
      name: f.name,
      size: f.size,
      label: f.name.replace(/\.[^.]+$/, ""),
      data: null,
      progress: 0,
      error: null,
    }));
    setPending(prev => [...prev, ...entries]);

    // Read each file and update its entry
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const entryId = entries[i].id;
      try {
        const text = await readFileWithProgress(file, (pct) => {
          setPending(prev => prev.map(e => e.id === entryId ? { ...e, progress: pct } : e));
        });
        const parsed = parseData(text);
        if (!parsed || parsed.rows.length === 0) {
          setPending(prev => prev.map(e => e.id === entryId ? { ...e, error: "Could not parse — check file format", progress: null } : e));
        } else {
          setPending(prev => prev.map(e => e.id === entryId ? { ...e, data: parsed, progress: null } : e));
        }
      } catch (err) {
        setPending(prev => prev.map(e => e.id === entryId ? { ...e, error: err.message, progress: null } : e));
      }
    }
  };

  const onDrop = (e) => {
    e.preventDefault(); setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const removePending = (id) => setPending(prev => prev.filter(e => e.id !== id));
  const updateLabel = (id, lbl) => setPending(prev => prev.map(e => e.id === id ? { ...e, label: lbl } : e));

  const saveAll = () => {
    const valid = pending.filter(e => e.data && !e.error);
    if (!valid.length) return;
    const now = Date.now();
    const newSnaps = valid.map((e, i) => ({
      id: now + i,
      label: e.label.trim() || e.name,
      ts: new Date().toISOString(),
      data: e.data,
      fileName: e.name,
    }));
    const next = [...newSnaps, ...snapshots];
    setSnapshots(next); persist(next);
    setPending([]); // clear queue after saving
    setSavedCount(newSnaps.length);
    setTimeout(() => setSavedCount(0), 2500);
  };

  const handleDelete = (id) => {
    const next = snapshots.filter(s => s.id !== id);
    setSnapshots(next); persist(next);
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n; });
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    setResult(null); setKeyCols(new Set()); setExcludedCols(new Set());
  };

  // Preserve creation order
  const selectedSnaps = snapshots
    .filter(s => selectedIds.has(s.id))
    .sort((a, b) => a.id - b.id);

  const handleCompare = () => {
    if (selectedSnaps.length < 2) return;
    setResult(diffMulti(selectedSnaps, keyCols, excludedCols));
  };

  const compareHeaders = selectedSnaps.length >= 2
    ? [...new Set(selectedSnaps.flatMap(s => s.data.headers))]
    : [];

  const resetColConfig = () => { setKeyCols(new Set()); setExcludedCols(new Set()); setResult(null); };

  const toggleKey = (col) => {
    setKeyCols(prev => { const n = new Set(prev); n.has(col) ? n.delete(col) : n.add(col); return n; });
    setExcludedCols(prev => { const n = new Set(prev); n.delete(col); return n; });
    setResult(null);
  };
  const toggleExclude = (col) => {
    setExcludedCols(prev => { const n = new Set(prev); n.has(col) ? n.delete(col) : n.add(col); return n; });
    setKeyCols(prev => { const n = new Set(prev); n.delete(col); return n; });
    setResult(null);
  };

  const fmtTs = (ts) => new Date(ts).toLocaleString();
  const SNAP_TINTS = ["#4a9eff","#3ddc84","#f97316","#e879f9","#fb7185","#34d399"];

  return (
    <div style={{ fontFamily: "'IBM Plex Mono','Courier New',monospace", background: "#0d0d0d", minHeight: "100vh", color: "#e0e0e0" }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ borderBottom: "1px solid #2a2a2a", padding: "20px 32px", display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#3ddc84" }} />
        <span style={{ fontSize: 13, letterSpacing: "0.15em", color: "#888", textTransform: "uppercase" }}>SQL Snapshot Diff</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 2, background: "#1a1a1a", padding: 3, borderRadius: 6 }}>
          {["capture", "compare"].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: tab === t ? "#222" : "transparent", color: tab === t ? "#e0e0e0" : "#666",
              border: tab === t ? "1px solid #333" : "1px solid transparent",
              borderRadius: 4, padding: "5px 16px", cursor: "pointer", fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase",
            }}>{t}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: "28px 32px", maxWidth: 1300, margin: "0 auto" }}>

        {/* ── CAPTURE TAB ── */}
        {tab === "capture" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 24 }}>
            <div>
              <div style={{ fontSize: 11, color: "#666", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>Load Files</div>

              {/* Drop zone */}
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                style={{ border: `2px dashed ${dragging ? "#3ddc84" : "#2a2a2a"}`, borderRadius: 8, padding: "28px 20px", textAlign: "center", cursor: "pointer", background: dragging ? "#0a1f0a" : "#0f0f0f", transition: "all 0.15s", userSelect: "none" }}
              >
                <input ref={fileInputRef} type="file" accept=".csv,.tsv,.txt" multiple style={{ display: "none" }}
                  onChange={e => addFiles(e.target.files)} />
                <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.4 }}>⬆</div>
                <div style={{ fontSize: 13, color: "#888" }}>Drop CSV / TSV files here</div>
                <div style={{ fontSize: 11, color: "#444", marginTop: 4 }}>or click to browse — multiple files supported</div>
              </div>

              {/* Pending file queue */}
              {pending.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 11, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>
                    Queue ({pending.length} file{pending.length !== 1 ? "s" : ""})
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {pending.map(entry => (
                      <div key={entry.id} style={{ background: "#111", border: `1px solid ${entry.error ? "#3a1515" : entry.data ? "#1a2e1a" : "#1e1e1e"}`, borderRadius: 6, padding: "10px 12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          {/* Status icon */}
                          <div style={{ width: 20, textAlign: "center", fontSize: 13, flexShrink: 0, color: entry.error ? "#ff4d4d" : entry.data ? "#3ddc84" : "#555" }}>
                            {entry.progress !== null ? "…" : entry.error ? "✗" : "✓"}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: entry.data ? 6 : 0 }}>
                              <span style={{ fontSize: 11, color: "#666", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{entry.name}</span>
                              <span style={{ fontSize: 10, color: "#444", flexShrink: 0 }}>{fmtSize(entry.size)}</span>
                            </div>
                            {/* Progress bar */}
                            {entry.progress !== null && (
                              <div style={{ height: 3, background: "#1a1a1a", borderRadius: 2, overflow: "hidden", marginTop: 4 }}>
                                <div style={{ height: "100%", width: `${entry.progress}%`, background: "#3ddc84", transition: "width 0.1s" }} />
                              </div>
                            )}
                            {/* Error */}
                            {entry.error && <div style={{ fontSize: 11, color: "#ff4d4d", marginTop: 2 }}>{entry.error}</div>}
                            {/* Editable label */}
                            {entry.data && (
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <input
                                  value={entry.label}
                                  onChange={e => updateLabel(entry.id, e.target.value)}
                                  onClick={e => e.stopPropagation()}
                                  placeholder="Snapshot label…"
                                  style={{ flex: 1, background: "#0d0d0d", border: "1px solid #222", borderRadius: 4, color: "#e0e0e0", padding: "5px 8px", fontSize: 11, fontFamily: "inherit", outline: "none" }}
                                />
                                <span style={{ fontSize: 10, color: "#444", whiteSpace: "nowrap" }}>
                                  {entry.data.rows.length.toLocaleString()}r · {entry.data.headers.length}c
                                </span>
                              </div>
                            )}
                          </div>
                          <button onClick={() => removePending(entry.id)} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 16, padding: 0, flexShrink: 0, lineHeight: 1 }}>×</button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Save all button */}
                  {pending.some(e => e.data) && (
                    <button onClick={saveAll} style={{
                      marginTop: 12, width: "100%",
                      background: savedCount ? "#0d2e0d" : "#3ddc84",
                      color: savedCount ? "#3ddc84" : "#000",
                      border: `1px solid ${savedCount ? "#3ddc84" : "transparent"}`,
                      borderRadius: 6, padding: "10px 0", cursor: "pointer",
                      fontSize: 12, fontWeight: 600, fontFamily: "inherit", transition: "all 0.2s",
                    }}>
                      {savedCount
                        ? `✓ Saved ${savedCount} snapshot${savedCount !== 1 ? "s" : ""}!`
                        : `Save ${pending.filter(e => e.data).length} Snapshot${pending.filter(e => e.data).length !== 1 ? "s" : ""} →`
                      }
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Saved snapshots panel */}
            <div>
              <div style={{ fontSize: 11, color: "#666", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>
                Saved ({snapshots.length})
              </div>
              {snapshots.length === 0 && <div style={{ fontSize: 12, color: "#444" }}>No snapshots yet.</div>}
              {snapshots.map((s, i) => (
                <div key={s.id} style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 5, padding: "10px 12px", marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 6, height: 6, borderRadius: 2, background: SNAP_TINTS[i % SNAP_TINTS.length], flexShrink: 0 }} />
                    <div>
                      <div style={{ fontSize: 12, color: "#e0e0e0" }}>{s.label}</div>
                      <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{fmtTs(s.ts)} · {s.data.rows.length.toLocaleString()}r</div>
                    </div>
                  </div>
                  <button onClick={() => handleDelete(s.id)} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 14, padding: 0 }}>×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── COMPARE TAB ── */}
        {tab === "compare" && (
          <div>
            {snapshots.length < 2 ? (
              <div style={{ color: "#555", fontSize: 13, textAlign: "center", padding: 60 }}>Save at least 2 snapshots to compare.</div>
            ) : (
              <>
                {/* Snapshot selector */}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 11, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>
                    Select Snapshots
                    <span style={{ color: "#333", marginLeft: 8, textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>pick 2 or more · first selected = baseline</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {snapshots.map((s, si) => {
                      const isSelected = selectedIds.has(s.id);
                      const orderIdx = selectedSnaps.findIndex(x => x.id === s.id);
                      return (
                        <button key={s.id} onClick={() => toggleSelect(s.id)} style={{
                          background: isSelected ? "#111" : "transparent",
                          border: `1px solid ${isSelected ? SNAP_TINTS[orderIdx >= 0 ? orderIdx % SNAP_TINTS.length : 0] : "#1e1e1e"}`,
                          borderRadius: 6, padding: "9px 14px 9px 10px", cursor: "pointer", fontFamily: "inherit",
                          textAlign: "left", position: "relative", display: "flex", alignItems: "flex-start", gap: 8,
                        }}>
                          <div style={{ width: 6, height: 6, borderRadius: 2, marginTop: 3, flexShrink: 0, background: isSelected ? SNAP_TINTS[orderIdx % SNAP_TINTS.length] : "#333" }} />
                          <div>
                            {isSelected && (
                              <div style={{ fontSize: 9, color: orderIdx === 0 ? "#4a9eff" : "#888", fontWeight: 700, marginBottom: 2 }}>
                                {orderIdx === 0 ? "BASELINE" : `SNAP ${orderIdx + 1}`}
                              </div>
                            )}
                            <div style={{ fontSize: 12, color: isSelected ? "#e0e0e0" : "#555" }}>{s.label}</div>
                            <div style={{ fontSize: 10, color: "#444", marginTop: 2 }}>{fmtTs(s.ts)} · {s.data.rows.length.toLocaleString()}r</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {selectedSnaps.length >= 2 && (
                    <div style={{ fontSize: 11, color: "#444", marginTop: 10 }}>
                      {selectedSnaps.map((s, i) => (
                        <span key={s.id}>
                          <span style={{ color: SNAP_TINTS[i % SNAP_TINTS.length] }}>{s.label}</span>
                          {i < selectedSnaps.length - 1 && <span style={{ color: "#333", margin: "0 6px" }}>→</span>}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Column config */}
                {compareHeaders.length > 0 && (
                  <div style={{ marginBottom: 20, padding: "14px 16px", background: "#0f0f0f", border: "1px solid #1e1e1e", borderRadius: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                      <div style={{ fontSize: 11, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase" }}>Column settings</div>
                      <div style={{ display: "flex", gap: 12, fontSize: 10, color: "#444" }}>
                        <span><span style={{ color: "#4a9eff" }}>■</span> Key — row identity</span>
                        <span><span style={{ color: "#ff8c00" }}>■</span> Exclude — ignored</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {compareHeaders.map(col => {
                        const isKey = keyCols.has(col), isExcluded = excludedCols.has(col);
                        return (
                          <div key={col} style={{ display: "flex", alignItems: "stretch", borderRadius: 4, overflow: "hidden", border: `1px solid ${isKey ? "#1a3a5c" : isExcluded ? "#3a2000" : "#222"}` }}>
                            <div style={{ padding: "4px 8px", fontSize: 11, background: isKey ? "#0d1e30" : isExcluded ? "#1e1000" : "#161616", color: isKey ? "#4a9eff" : isExcluded ? "#ff8c00" : "#888" }}>{col}</div>
                            <button onClick={() => toggleKey(col)} style={{ padding: "4px 6px", background: isKey ? "#4a9eff" : "#1a1a1a", border: "none", borderLeft: "1px solid #222", cursor: "pointer", fontSize: 9, color: isKey ? "#000" : "#444", fontWeight: 700 }}>KEY</button>
                            <button onClick={() => toggleExclude(col)} style={{ padding: "4px 6px", background: isExcluded ? "#ff8c00" : "#1a1a1a", border: "none", borderLeft: "1px solid #222", cursor: "pointer", fontSize: 9, color: isExcluded ? "#000" : "#444", fontWeight: 700 }}>EXC</button>
                          </div>
                        );
                      })}
                    </div>
                    {(keyCols.size > 0 || excludedCols.size > 0) && (
                      <div style={{ fontSize: 11, color: "#444", marginTop: 10 }}>
                        {keyCols.size > 0 && <span>Key: <span style={{ color: "#4a9eff" }}>{[...keyCols].join(", ")}</span>{excludedCols.size > 0 ? " · " : ""}</span>}
                        {excludedCols.size > 0 && <span>Excluded: <span style={{ color: "#ff8c00" }}>{[...excludedCols].join(", ")}</span></span>}
                        <button onClick={resetColConfig} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 11, fontFamily: "inherit", textDecoration: "underline", marginLeft: 8, padding: 0 }}>reset</button>
                      </div>
                    )}
                  </div>
                )}

                <button onClick={handleCompare} disabled={selectedSnaps.length < 2} style={{
                  background: selectedSnaps.length >= 2 ? "#e0e0e0" : "#1a1a1a",
                  color: selectedSnaps.length >= 2 ? "#000" : "#444",
                  border: "none", borderRadius: 5, padding: "10px 28px", marginBottom: 24,
                  cursor: selectedSnaps.length >= 2 ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 600,
                }}>Run Diff →</button>

                {result && (
                  <MultiDiffView result={result} snaps={selectedSnaps} keyCols={keyCols} excludedCols={excludedCols} />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Multi-Diff View ───────────────────────────────────────────────────────────

const SNAP_TINTS = ["#4a9eff","#3ddc84","#f97316","#e879f9","#fb7185","#34d399"];
const STATUS_BG    = { changed: "#2a1e00", partial: "#1a0a2e", same: "transparent" };
const STATUS_TEXT  = { changed: "#fbbf24", partial: "#a78bfa", same: "#555" };
const STATUS_LABEL = { changed: "~", partial: "◑", same: " " };

function MultiDiffView({ result, snaps, keyCols, excludedCols }) {
  const [activeFilters, setActiveFilters] = useState(new Set(["changed", "partial", "same"]));
  const [showExport, setShowExport] = useState(false);

  const counts = { changed: 0, partial: 0, same: 0 };
  result.rows.forEach(r => counts[r.status]++);

  const toggleFilter = (key) => {
    if (key === "all") {
      const all = new Set(["changed", "partial", "same"]);
      setActiveFilters(prev => prev.size === 3 ? new Set() : all);
      return;
    }
    setActiveFilters(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  };

  const filtered = result.rows.filter(r => activeFilters.has(r.status));
  const allActive = activeFilters.size === 3;

  const FILTERS = [
    ["all",     allActive ? "All" : `${filtered.length} shown`, "#888"],
    ["changed", `~ ${counts.changed} Changed`,  "#fbbf24"],
    ["partial", `◑ ${counts.partial} Partial`,  "#a78bfa"],
    ["same",    `${counts.same} Same`,           "#555"],
  ];

  const { keyHeaders, diffHeaders } = result;

  return (
    <div>
      {showExport && (
        <ExportModal result={result} snaps={snaps} keyCols={keyCols} excludedCols={excludedCols} onClose={() => setShowExport(false)} />
      )}

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        {FILTERS.map(([key, lbl, col]) => {
          const isOn = key === "all" ? allActive : activeFilters.has(key);
          return (
            <button key={key} onClick={() => toggleFilter(key)} style={{
              background: isOn ? "#222" : "transparent", border: `1px solid ${isOn ? col : "#2a2a2a"}`,
              color: isOn ? col : "#444", borderRadius: 5, padding: "5px 13px",
              cursor: "pointer", fontSize: 11, letterSpacing: "0.07em", transition: "all 0.12s",
            }}>{lbl}</button>
          );
        })}
        <span style={{ fontSize: 10, color: "#333" }}>click to toggle</span>
        <div style={{ marginLeft: "auto" }}>
          <button onClick={() => setShowExport(true)}
            style={{ background: "#161616", border: "1px solid #2a2a2a", color: "#aaa", borderRadius: 5, padding: "6px 14px", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>
            ↓ Export
          </button>
        </div>
      </div>

      {/* Snapshot legend */}
      <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        {snaps.map((s, i) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: SNAP_TINTS[i % SNAP_TINTS.length] }} />
            <span style={{ color: SNAP_TINTS[i % SNAP_TINTS.length] }}>{s.label}</span>
            {i === 0 && <span style={{ fontSize: 9, color: "#555" }}>(baseline)</span>}
          </div>
        ))}
        <div style={{ fontSize: 10, color: "#333", marginLeft: "auto" }}>
          Changed cells = differs from baseline · <span style={{ color: "#a78bfa" }}>◑ partial</span> = row absent in some snapshots
        </div>
      </div>

      <div style={{ overflowX: "auto", border: "1px solid #1e1e1e", borderRadius: 6 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            {/* Row 1: column group headers */}
            <tr style={{ background: "#111", borderBottom: "1px solid #1e1e1e" }}>
              <th style={{ padding: "8px 10px", width: 24 }}></th>
              {keyHeaders.map(h => (
                <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: "#4a9eff", fontWeight: 500, whiteSpace: "nowrap", borderRight: "1px solid #1a1a1a" }}>
                  {h} <span style={{ fontSize: 9, opacity: 0.5 }}>key</span>
                </th>
              ))}
              {diffHeaders.map(h => (
                <th key={h} colSpan={snaps.length} style={{
                  padding: "8px 12px", textAlign: "center", fontWeight: 500, whiteSpace: "nowrap",
                  color: excludedCols.has(h) ? "#2a2a2a" : "#888",
                  borderLeft: "1px solid #1a1a1a", borderRight: "1px solid #1a1a1a",
                }}>
                  {h}{excludedCols.has(h) && <span style={{ fontSize: 9, color: "#ff8c00", marginLeft: 4 }}>excl</span>}
                </th>
              ))}
            </tr>
            {/* Row 2: per-snapshot sub-headers */}
            <tr style={{ background: "#0d0d0d", borderBottom: "1px solid #2a2a2a" }}>
              <th></th>
              {keyHeaders.map(h => <th key={h} style={{ borderRight: "1px solid #1a1a1a" }}></th>)}
              {diffHeaders.flatMap(h =>
                snaps.map((s, si) => (
                  <th key={`${h}-${s.id}`} style={{
                    padding: "4px 10px", fontSize: 10, fontWeight: 500, textAlign: "left",
                    color: SNAP_TINTS[si % SNAP_TINTS.length],
                    opacity: excludedCols.has(h) ? 0.25 : 0.85,
                    whiteSpace: "nowrap",
                    borderRight: si === snaps.length - 1 ? "1px solid #1a1a1a" : "none",
                  }}>{s.label}</th>
                ))
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={1 + keyHeaders.length + diffHeaders.length * snaps.length}
                style={{ padding: 20, textAlign: "center", color: "#444", fontSize: 12 }}>No rows match the active filters.</td></tr>
            )}
            {filtered.map((row, ri) => {
              const baseRow = row.data.get(snaps[0].id);
              return (
                <tr key={ri} style={{ borderBottom: "1px solid #181818", background: STATUS_BG[row.status] }}>
                  <td style={{ padding: "6px 10px", textAlign: "center", color: STATUS_TEXT[row.status], fontWeight: 700, fontSize: 13 }}>
                    {STATUS_LABEL[row.status]}
                  </td>
                  {keyHeaders.map(h => (
                    <td key={h} style={{ padding: "6px 12px", color: "#7ab8e8", whiteSpace: "nowrap", borderRight: "1px solid #161616" }}>
                      {baseRow?.[h] ?? <span style={{ color: "#333" }}>—</span>}
                    </td>
                  ))}
                  {diffHeaders.flatMap(h =>
                    snaps.map((s, si) => {
                      const v = row.data.get(s.id)?.[h];
                      const baseV = baseRow?.[h] ?? "";
                      const absent = !row.data.has(s.id);
                      const differs = si > 0 && !absent && (v ?? "") !== baseV;
                      const isExcluded = excludedCols.has(h);
                      return (
                        <td key={`${h}-${s.id}`} style={{
                          padding: "6px 10px", whiteSpace: "nowrap",
                          opacity: isExcluded ? 0.2 : 1,
                          color: absent ? "#2a2a2a" : differs ? SNAP_TINTS[si % SNAP_TINTS.length] : row.status === "same" ? "#444" : "#aaa",
                          borderRight: si === snaps.length - 1 ? "1px solid #161616" : "none",
                          fontStyle: absent ? "italic" : "normal",
                          background: differs && !isExcluded ? "rgba(251,191,36,0.04)" : "transparent",
                        }}>
                          {absent
                            ? <span style={{ color: "#2a2a2a", fontSize: 10 }}>absent</span>
                            : (v !== undefined && v !== "" ? v : <span style={{ color: "#333" }}>—</span>)
                          }
                        </td>
                      );
                    })
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

# SQL Snapshot Diff

A local web tool for comparing SQL query results across multiple CSV snapshots. Drop in your exported query results, take snapshots over time, and diff them side-by-side — with filtering, column configuration, and export to CSV, JSON, or HTML.

---

## Live demo

Once deployed, your GitHub Pages demo will be live at:

```
https://Mudkipboo.github.io/CSV-diff-viewer/
```

See [Deploying to GitHub Pages](#deploying-to-github-pages) below.

---

## Requirements

- [Node.js](https://nodejs.org/) v18 or higher
- npm (included with Node.js)

---

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/your-username/sql-snapshot-diff.git
cd sql-snapshot-diff

# 2. Install dependencies
npm install

# 3. Start the dev server
npm run dev
```

Then open **http://localhost:5173** in your browser.

---

## Building for production

```bash
npm run build
```

Output is written to `dist/`. Preview it locally with:

```bash
npm run preview
```

---

## Deploying to GitHub Pages

This repo includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that automatically builds and deploys the app to GitHub Pages on every push to `main`.

### One-time setup

**1. Push the repo to GitHub**

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-username/your-repo-name.git
git push -u origin main
```

**2. Enable GitHub Pages**

- Go to your repo on GitHub
- Click **Settings** → **Pages** (in the left sidebar)
- Under **Source**, select **GitHub Actions**
- Click **Save**

**3. That's it.**

The workflow triggers automatically on the next push to `main`. After it completes (usually under a minute), your app will be live at:

```
https://<your-username>.github.io/<your-repo-name>/
```

You can also trigger a deployment manually from the **Actions** tab → **Deploy to GitHub Pages** → **Run workflow**.

### How the base path works

GitHub Pages serves repos at `/<repo-name>/` rather than `/`. The workflow automatically sets `VITE_BASE_PATH=/<repo-name>/` at build time so all asset paths resolve correctly. Locally the dev server always uses `/` — no config changes needed.

---

## How to use

The app has two tabs: **Capture** and **Compare**.

---

### Capture — saving snapshots

1. **Export your query results** from your database client as a CSV or TSV file. Most clients (DBeaver, TablePlus, DataGrip, psql `\copy`, etc.) have a built-in export option.

2. **Drop files onto the upload zone** or click it to browse. You can select multiple files at once — they all appear in a queue.

3. **Edit labels** for each file in the queue. Labels are pre-filled from the filename but you can rename them to something descriptive like `before_migration` or `prod_2024-11-01`.

4. Click **Save Snapshots →** to save them all. Snapshots are stored in `localStorage` and persist between browser sessions.

> **Supported formats:** `.csv`, `.tsv`, and pipe-delimited `.txt`. The first row must be a header row. Delimiters are auto-detected.

---

### Compare — diffing snapshots

1. Switch to the **Compare** tab.

2. **Select two or more snapshots** by clicking their cards. The first one selected becomes the **baseline** — all other snapshots are compared against it.

3. **Configure columns** (optional but recommended):
   - **KEY** — marks a column as the row identity. Rows are matched across snapshots using key column values. If your data has a primary key like `id` or `user_id`, mark it as KEY so the tool can detect actual value changes instead of treating every changed row as a removal + addition.
   - **EXC** — excludes a column from change detection entirely. Useful for auto-incrementing IDs, timestamps, or any column that changes on every export but isn't meaningful to diff.
   - KEY and EXC are mutually exclusive per column.

4. Click **Run Diff →**.

#### Reading the results

| Symbol | Status | Meaning |
|--------|--------|---------|
| `~` | **Changed** | Row exists in all snapshots, but one or more values differ from baseline |
| `◑` | **Partial** | Row is missing from at least one snapshot (appeared or disappeared) |
| _(blank)_ | **Same** | Row is identical across all snapshots |

- Each snapshot gets its own sub-column under every diffed field.
- Cells that differ from the baseline are **highlighted in that snapshot's color**.
- Cells marked `absent` mean that row didn't exist in that snapshot.

Use the filter buttons (`~ Changed`, `◑ Partial`, `Same`) to show or hide row categories independently.

---

### Exporting results

Click **↓ Export** above the diff table to open the export modal.

| Format | Contents | Use case |
|--------|----------|----------|
| **CSV** | One row per key, one column per field per snapshot (e.g. `name[snap1]`, `name[snap2]`) | Open in Excel / Google Sheets |
| **JSON** | Structured payload with summary counts, snapshot metadata, and nested row data | Feed into scripts or other tools |
| **HTML** | Self-contained report with **interactive filters** — click Changed / Partial / Same to show/hide rows | Share with teammates, archive, or print to PDF |

To save the HTML report as a PDF: open it in a browser and use **File → Print → Save as PDF**.

> The in-app export copies content to the clipboard (sandbox limitation). When running locally, the clipboard copy still works, and you can also modify the `buildCSV` / `buildJSON` / `buildHTML` functions in `src/App.jsx` to use `URL.createObjectURL` for direct file downloads.

---

## Tips

- **Large files** — files are read with the browser's `FileReader` API and parsed fully in memory. Files up to a few hundred MB work fine; beyond that depends on your browser and available RAM.
- **Snapshots persist** — saved in `localStorage`. To clear all snapshots, open DevTools → Application → Local Storage → delete the `sql-snapshots` key, or delete snapshots individually with the `×` button in the Capture tab.
- **Multiple key columns** — mark more than one column as KEY to use a composite row identity (like a compound primary key).
- **Comparing 3+ snapshots** — select as many as you want. The diff table grows a sub-column per snapshot for each field. The first selected snapshot is always the baseline.

---

## Project structure

```
sql-snapshot-diff/
├── .github/
│   └── workflows/
│       └── deploy.yml    # GitHub Actions → GitHub Pages
├── index.html            # HTML entry point
├── vite.config.js        # Vite config (reads VITE_BASE_PATH)
├── package.json
├── .gitignore
├── README.md
└── src/
    ├── main.jsx          # React root
    └── App.jsx           # Entire application (single file)
```

The app is intentionally kept as a single `App.jsx` for easy portability and modification.

---

## License

MIT

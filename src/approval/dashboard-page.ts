/**
 * Approval Dashboard Page
 *
 * Single inline HTML page served by the approval server. Vanilla JS, no
 * build step, no external assets.
 *
 * WHY: the dashboard must work on a laptop with no internet and no extra
 * dependencies. Inlining keeps the runtime a single Node process.
 */

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Automaton Approvals</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --border:#262b36; --text:#e6e8ee; --muted:#8b93a7;
          --ok:#3fb950; --bad:#f85149; --warn:#d29922; --accent:#58a6ff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  header { padding:16px 24px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:16px; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  header .status { color:var(--muted); font-size:13px; }
  main { padding:24px; max-width:1100px; margin:0 auto; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:24px 0 12px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:12px; }
  .card.pending { border-left:3px solid var(--warn); }
  .row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .tool { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-weight:600; font-size:15px; }
  .badge { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--border); color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
  .badge.dangerous { color:var(--bad); border-color:var(--bad); }
  .badge.caution { color:var(--warn); border-color:var(--warn); }
  .badge.safe { color:var(--ok); border-color:var(--ok); }
  .badge.approved { color:var(--ok); border-color:var(--ok); }
  .badge.denied, .badge.expired { color:var(--bad); border-color:var(--bad); }
  .time { color:var(--muted); font-size:12px; margin-left:auto; }
  pre { background:#0b0d11; border:1px solid var(--border); border-radius:6px; padding:12px; overflow:auto; margin:12px 0 0; font-size:12.5px; max-height:320px; white-space:pre-wrap; word-break:break-word; }
  .reasoning { color:var(--muted); margin-top:10px; white-space:pre-wrap; font-size:13px; }
  .actions { display:flex; gap:8px; margin-top:12px; align-items:center; }
  input[type=text] { flex:1; min-width:200px; background:#0b0d11; border:1px solid var(--border); color:var(--text); padding:8px 10px; border-radius:6px; font-size:13px; }
  button { border:0; padding:8px 14px; border-radius:6px; font-weight:600; cursor:pointer; font-size:13px; }
  button.approve { background:var(--ok); color:#06130a; }
  button.deny { background:var(--bad); color:#1a0505; }
  button:disabled { opacity:.5; cursor:default; }
  .empty { color:var(--muted); padding:24px; text-align:center; border:1px dashed var(--border); border-radius:8px; }
  .note { color:var(--muted); font-size:12px; margin-top:6px; }
</style>
</head>
<body>
<header>
  <h1>Automaton Approvals</h1>
  <span class="status" id="status">connecting…</span>
</header>
<main>
  <h2>Pending</h2>
  <div id="pending"></div>
  <h2>Recent decisions</h2>
  <div id="recent"></div>
</main>
<script>
(function () {
  var HEADERS = { "Content-Type": "application/json", "X-Automaton-Approval": "1" };
  var pendingEl = document.getElementById("pending");
  var recentEl = document.getElementById("recent");
  var statusEl = document.getElementById("status");
  var lastPendingIds = "";

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }
  function fmtTime(iso) { try { return new Date(iso + (iso.endsWith("Z") ? "" : "Z")).toLocaleTimeString(); } catch (e) { return iso; } }

  function renderPending(rows) {
    if (!rows.length) { pendingEl.innerHTML = '<div class="empty">Nothing waiting. The automaton is working or sleeping.</div>'; return; }
    pendingEl.innerHTML = rows.map(function (r) {
      return '<div class="card pending" data-id="' + esc(r.id) + '">' +
        '<div class="row"><span class="tool">' + esc(r.toolName) + '</span>' +
        '<span class="badge ' + esc(r.riskLevel) + '">' + esc(r.riskLevel) + '</span>' +
        '<span class="badge">' + esc(r.category) + '</span>' +
        '<span class="time">' + fmtTime(r.createdAt) + '</span></div>' +
        (r.reasoning ? '<div class="reasoning">' + esc(r.reasoning) + '</div>' : '') +
        '<pre>' + esc(JSON.stringify(r.args, null, 2)) + '</pre>' +
        '<div class="actions">' +
        '<input type="text" placeholder="Optional note for the agent" data-note>' +
        '<button class="approve" data-action="approve">Approve</button>' +
        '<button class="deny" data-action="deny">Deny</button>' +
        '</div></div>';
    }).join("");
  }

  function renderRecent(rows) {
    if (!rows.length) { recentEl.innerHTML = '<div class="empty">No decisions yet.</div>'; return; }
    recentEl.innerHTML = rows.map(function (r) {
      return '<div class="card"><div class="row"><span class="tool">' + esc(r.toolName) + '</span>' +
        '<span class="badge ' + esc(r.status) + '">' + esc(r.status) + '</span>' +
        '<span class="badge ' + esc(r.riskLevel) + '">' + esc(r.riskLevel) + '</span>' +
        '<span class="time">' + fmtTime(r.resolvedAt || r.createdAt) + '</span></div>' +
        (r.note ? '<div class="note">Note: ' + esc(r.note) + '</div>' : '') +
        '</div>';
    }).join("");
  }

  function refresh() {
    fetch("/api/state").then(function (res) { return res.json(); }).then(function (state) {
      statusEl.textContent = state.pending.length + " pending · " + state.agentState + " · updated " + new Date().toLocaleTimeString();
      var ids = state.pending.map(function (r) { return r.id; }).join(",");
      if (ids !== lastPendingIds) { renderPending(state.pending); lastPendingIds = ids; }
      renderRecent(state.recent);
    }).catch(function () { statusEl.textContent = "runtime unreachable"; });
  }

  pendingEl.addEventListener("click", function (ev) {
    var btn = ev.target.closest("button[data-action]");
    if (!btn) return;
    var card = btn.closest(".card");
    var id = card.getAttribute("data-id");
    var note = card.querySelector("[data-note]").value;
    card.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
    fetch("/api/approvals/" + encodeURIComponent(id) + "/" + btn.getAttribute("data-action"), {
      method: "POST", headers: HEADERS, body: JSON.stringify({ note: note })
    }).then(function () { lastPendingIds = ""; refresh(); });
  });

  refresh();
  setInterval(refresh, 2000);
})();
</script>
</body>
</html>`;

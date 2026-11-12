(function () {
  "use strict";

  var API = "https://danti-api-production.up.railway.app";
  var KEY = "danti_access_key";
  var TZ = "Europe/London";
  var FILTERS = [
    ["upcoming", "Upcoming"], ["past", "Past"], ["cancelled", "Cancelled"],
    ["failed", "Failed"], ["all", "All"]
  ];
  var EMPTY = {
    upcoming: "No upcoming appointments.", past: "No past appointments yet.",
    cancelled: "No cancelled appointments.", failed: "No failed booking attempts.",
    all: "No appointments yet."
  };

  var app = document.getElementById("app");
  var state = { key: "", rows: [], filter: "upcoming", query: "", updated: null, error: "", loading: false, timer: null };

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function getKey() {
    try { return localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || ""; } catch (e) { return ""; }
  }
  function clearKey() {
    try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch (e) {}
  }
  function setKey(k, remember) {
    try { clearKey(); (remember ? localStorage : sessionStorage).setItem(KEY, k); } catch (e) {}
  }
  function fmtWhen(iso) {
    return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  }
  function ukDate(d) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }
  function fmtClock(d) {
    return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(d);
  }

  function request(path, key) {
    return fetch(API + path, { headers: { Authorization: "Bearer " + key } }).then(
      function (res) {
        if (res.status === 401) throw { kind: "auth", message: "That access key is not correct." };
        if (res.status === 503) throw { kind: "config", message: "Dashboard access is not configured on the server." };
        if (!res.ok) throw { kind: "server", message: "The server returned an error (" + res.status + "). The database may be unavailable." };
        return res.json();
      },
      function () {
        throw { kind: "network", message: "Cannot reach the server. Check your connection and try again." };
      }
    );
  }

  function matches(a, filter, now) {
    var t = Date.parse(a.start_time);
    switch (filter) {
      case "upcoming": return a.status === "confirmed" && t >= now;
      case "past": return a.status === "confirmed" && t < now;
      case "cancelled": return a.status === "cancelled";
      case "failed": return a.status === "failed";
      default: return true;
    }
  }

  // ---------- login ----------
  function showLogin(message) {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    app.innerHTML =
      '<div class="login"><div class="login-box">' +
      '<p class="brand">DANTI</p><p class="muted mt4">Reception, automated.</p>' +
      '<form id="lf" autocomplete="off">' +
      '<label class="lbl" for="k">Access key</label>' +
      '<input class="field" id="k" type="password" autocomplete="current-password" placeholder="Paste your access key">' +
      '<label class="check"><input id="rm" type="checkbox" checked> Keep me signed in on this device</label>' +
      '<p class="err" id="le" role="alert"' + (message ? "" : " hidden") + ">" + esc(message || "") + "</p>" +
      '<button class="btn-primary" id="lb" type="submit" disabled>Sign in</button>' +
      "</form>" +
      '<p class="login-note">Patient information is shown here. Only share the access key with practice staff.</p>' +
      "</div></div>";

    var input = document.getElementById("k");
    var btn = document.getElementById("lb");
    var errEl = document.getElementById("le");
    input.addEventListener("input", function () { btn.disabled = !input.value.trim(); });
    document.getElementById("lf").addEventListener("submit", function (e) {
      e.preventDefault();
      var key = input.value.trim();
      if (!key) return;
      btn.disabled = true; btn.textContent = "Checking\u2026"; errEl.hidden = true;
      request("/dashboard/stats", key).then(function () {
        setKey(key, document.getElementById("rm").checked);
        state.key = key;
        showDashboard();
      }, function (err) {
        errEl.textContent = err.message || "Something went wrong."; errEl.hidden = false;
        btn.disabled = false; btn.textContent = "Sign in";
      });
    });
    input.focus();
  }

  // ---------- dashboard ----------
  function showDashboard() {
    app.innerHTML =
      '<div class="shell">' +
      '<aside class="side"><p class="brand">DANTI</p>' +
      '<div class="nav">Appointments</div>' +
      '<div class="foot">' +
      '<div><p class="xs muted"><span class="dot" id="dot"></span><span id="conn">Connecting\u2026</span></p><p class="xs muted mt4" id="upd"></p></div>' +
      '<p class="xs muted lh">Bookings are marked confirmed only after Google Calendar has accepted them.</p>' +
      '<button class="link" id="out1">Sign out</button></div></aside>' +
      '<main class="main">' +
      '<div class="mobilebar"><p class="brand">DANTI</p><button class="link" id="out2">Sign out</button></div>' +
      '<header class="hero"><p class="xs muted">Appointments</p><h1>Every call, accounted for.</h1>' +
      '<p class="lead">DANTI answers, checks the calendar and books the slot. Nothing here is marked confirmed until Google Calendar has actually accepted it.</p></header>' +
      '<div class="alert" id="alert" role="alert" hidden></div>' +
      '<section class="stats" id="stats"></section>' +
      "<section>" +
      '<div class="toolbar"><h2>Appointments</h2><div class="tools">' +
      '<label class="search"><input id="q" placeholder="Search name or phone" autocomplete="off"></label>' +
      '<button class="link" id="refresh">Refresh</button></div></div>' +
      '<div class="tabs" id="tabs"></div>' +
      '<div id="table"></div>' +
      '<p class="note">Showing the most recent 200 records. Times are UK time. Refreshes automatically every minute.</p>' +
      "</section></main></div>";

    document.getElementById("out1").addEventListener("click", logout);
    document.getElementById("out2").addEventListener("click", logout);
    document.getElementById("refresh").addEventListener("click", function () { load(false); });
    document.getElementById("q").addEventListener("input", function (e) {
      state.query = e.target.value; renderTable();
    });
    document.getElementById("tabs").addEventListener("click", function (e) {
      var b = e.target.closest("[data-f]");
      if (!b) return;
      state.filter = b.getAttribute("data-f");
      renderTabs(); renderTable();
    });

    renderAll();
    load(false);
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () { load(true); }, 60000);
  }

  function logout() {
    clearKey();
    state = { key: "", rows: [], filter: "upcoming", query: "", updated: null, error: "", loading: false, timer: state.timer };
    showLogin("");
  }

  function load(silent) {
    if (!state.key) return;
    if (!silent) { state.loading = true; renderStatus(); renderTable(); }
    request("/dashboard/appointments?limit=200", state.key).then(function (data) {
      state.rows = Array.isArray(data) ? data : [];
      state.error = ""; state.updated = new Date(); state.loading = false;
      renderAll();
    }, function (err) {
      state.loading = false;
      if (err && err.kind === "auth") { logout(); return; }
      state.error = (err && err.message) || "Something went wrong.";
      renderAll();
    });
  }

  function renderAll() { renderStatus(); renderStats(); renderTabs(); renderTable(); }

  function renderStatus() {
    var dot = document.getElementById("dot");
    if (!dot) return;
    dot.className = "dot" + (state.error ? " bad" : "");
    document.getElementById("conn").textContent = state.error ? "Connection problem" : (state.updated ? "Connected" : "Connecting\u2026");
    document.getElementById("upd").textContent = state.updated ? "Updated " + fmtClock(state.updated) + " UK time" : "";
    var al = document.getElementById("alert");
    al.hidden = !state.error; al.textContent = state.error;
    var rf = document.getElementById("refresh");
    rf.textContent = state.loading ? "Refreshing\u2026" : "Refresh";
    rf.disabled = state.loading;
  }

  function renderStats() {
    var now = Date.now(), today = ukDate(new Date());
    var rows = state.rows;
    var n = {
      today: rows.filter(function (a) { return a.status === "confirmed" && ukDate(new Date(a.start_time)) === today; }).length,
      upcoming: rows.filter(function (a) { return matches(a, "upcoming", now); }).length,
      cancelled: rows.filter(function (a) { return a.status === "cancelled"; }).length,
      failed: rows.filter(function (a) { return a.status === "failed"; }).length
    };
    function stat(cls, v, l) { return '<div class="stat ' + cls + '"><p class="n">' + v + '</p><p class="l">' + l + "</p></div>"; }
    document.getElementById("stats").innerHTML =
      stat("", n.today, "Today") + stat("sage", n.upcoming, "Upcoming") +
      stat("ash", n.cancelled, "Cancelled") + stat("clay", n.failed, "Failed attempts");
  }

  function renderTabs() {
    var now = Date.now();
    document.getElementById("tabs").innerHTML = FILTERS.map(function (f) {
      var c = state.rows.filter(function (a) { return matches(a, f[0], now); }).length;
      return '<button class="tab' + (state.filter === f[0] ? " on" : "") + '" data-f="' + f[0] + '">' + f[1] + '<span class="c">' + c + "</span></button>";
    }).join("");
  }

  function renderTable() {
    var el = document.getElementById("table");
    if (!el) return;
    if (state.loading && state.rows.length === 0) { el.innerHTML = '<div class="empty">Loading\u2026</div>'; return; }

    var now = Date.now();
    var list = state.rows.filter(function (a) { return matches(a, state.filter, now); });
    var q = state.query.trim().toLowerCase();
    if (q) {
      var digits = q.replace(/\D/g, "");
      list = list.filter(function (a) {
        return String(a.patient_name || "").toLowerCase().indexOf(q) !== -1 ||
          (digits && String(a.phone_number || "").replace(/\D/g, "").indexOf(digits) !== -1);
      });
    }
    var dir = state.filter === "upcoming" ? 1 : -1;
    list = list.slice().sort(function (a, b) { return dir * (Date.parse(a.start_time) - Date.parse(b.start_time)); });

    if (list.length === 0) {
      el.innerHTML = '<div class="empty">' + esc(q ? "Nothing matches your search." : (EMPTY[state.filter] || "Nothing to show.")) + "</div>";
      return;
    }
    var labels = { confirmed: "Confirmed", failed: "Failed", cancelled: "Cancelled" };
    el.innerHTML =
      '<div class="tablewrap"><table><thead><tr><th>Patient</th><th>When (UK time)</th><th>Reason</th><th>Status</th></tr></thead><tbody>' +
      list.map(function (a) {
        var st = labels[a.status] ? a.status : "cancelled";
        return "<tr>" +
          "<td><div>" + esc(a.patient_name) + '</div><div class="sub">' + esc(a.phone_number) + "</div></td>" +
          '<td class="when">' + esc(fmtWhen(a.start_time)) + "</td>" +
          '<td class="muted">' + esc(a.reason || "\u2014") +
          (a.status === "failed" && a.error_message ? '<div class="reason-err">' + esc(a.error_message) + "</div>" : "") + "</td>" +
          '<td><span class="status st-' + st + '"><i></i>' + esc(labels[a.status] || a.status || "Unknown") + "</span></td>" +
          "</tr>";
      }).join("") +
      "</tbody></table></div>";
  }

  // ---------- start ----------
  state.key = getKey();
  if (state.key) showDashboard(); else showLogin("");
})();

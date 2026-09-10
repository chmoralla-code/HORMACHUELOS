/* Hormachuelos — ambient particle field for the industrial skin.
   Decorative only: it never injects UI, never affects layout, and it
   stands still (single frame) when the visitor prefers reduced motion. */
(function () {
  var canvas = document.getElementById("rbg");
  if (!canvas || !canvas.getContext) return;

  var reduce =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var ctx = canvas.getContext("2d");
  var w = 0;
  var h = 0;
  var points = [];
  var frame = 0;

  function size() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function seed() {
    var count = Math.max(22, Math.min(60, Math.round((w * h) / 28000)));
    points = [];
    for (var i = 0; i < count; i++) {
      points.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        r: Math.random() * 1.2 + 0.6,
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    var link = Math.min(w, h) * 0.15;

    for (var i = 0; i < points.length; i++) {
      for (var j = i + 1; j < points.length; j++) {
        var dx = points[i].x - points[j].x;
        var dy = points[i].y - points[j].y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < link) {
          ctx.strokeStyle = "rgba(200,255,46," + ((1 - dist / link) * 0.16).toFixed(3) + ")";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(points[i].x, points[i].y);
          ctx.lineTo(points[j].x, points[j].y);
          ctx.stroke();
        }
      }
    }

    ctx.fillStyle = "rgba(200,255,46,0.45)";
    for (var k = 0; k < points.length; k++) {
      ctx.beginPath();
      ctx.arc(points[k].x, points[k].y, points[k].r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drift() {
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
    }
  }

  function tick() {
    drift();
    draw();
    frame = window.requestAnimationFrame(tick);
  }

  function reset() {
    window.cancelAnimationFrame(frame);
    frame = 0;
    size();
    seed();
    draw();
    if (!reduce) frame = window.requestAnimationFrame(tick);
  }

  reset();

  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(reset, 160);
  });

  // Stop drawing while the tab is in the background.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    } else if (!reduce && !frame) {
      frame = window.requestAnimationFrame(tick);
    }
  });
})();

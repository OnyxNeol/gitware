/* Gitware Pages viewer - no dependencies, no build step. */
(function () {
  "use strict";

  var state = { zoom: 1, panX: 0, panY: 0, dragging: false, net: null, boards: [] };

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  /* ---------- inline SVG layer toggles ---------- */
  function wireLayerToggles() {
    qsa("[data-layer-toggle]").forEach(function (button) {
      button.addEventListener("click", function () {
        var layer = button.getAttribute("data-layer-toggle");
        var groups = qsa('[data-layer="' + layer + '"]');
        var hidden = button.getAttribute("aria-pressed") === "true";
        groups.forEach(function (group) {
          group.style.display = hidden ? "" : "none";
        });
        button.setAttribute("aria-pressed", hidden ? "false" : "true");
      });
    });
  }

  /* ---------- net highlighting on any rendered board ---------- */
  function wireNetHighlight() {
    qsa("[data-net]").forEach(function (node) {
      node.addEventListener("click", function (event) {
        event.stopPropagation();
        var net = node.getAttribute("data-net");
        state.net = state.net === net ? null : net;
        paintHighlight();
        var label = document.getElementById("gitware-net-label");
        if (label) {
          label.textContent = state.net ? "net: " + state.net : "click a trace to inspect its net";
        }
      });
    });
  }

  function paintHighlight() {
    qsa("[data-net]").forEach(function (node) {
      var isTarget = state.net && node.getAttribute("data-net") === state.net;
      node.style.filter = state.net && !isTarget ? "saturate(0.25) brightness(0.65)" : "";
      node.style.opacity = state.net && !isTarget ? "0.55" : "";
    });
  }

  /* ---------- canvas board viewer (pan / zoom / layers) ---------- */
  function createBoard(host) {
    var source = host.getAttribute("data-board-src");
    if (!source || !window.fetch) {
      return;
    }
    var canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.cursor = "grab";
    canvas.style.touchAction = "none";
    host.textContent = "";
    host.appendChild(canvas);
    var ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    var board = null;
    var hidden = {};

    function resize() {
      var rect = host.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }

    function scaleFactor() {
      if (!board) {
        return 1;
      }
      var rect = host.getBoundingClientRect();
      var w = board.bounds.width || 1;
      var h = board.bounds.height || 1;
      return Math.min(rect.width / w, rect.height / h) * 0.9 * state.zoom;
    }

    function project(x, y) {
      var rect = host.getBoundingClientRect();
      var s = scaleFactor();
      var cx = board.bounds.min.x + board.bounds.width / 2;
      var cy = board.bounds.min.y + board.bounds.height / 2;
      return [
        rect.width / 2 + (x - cx) * s + state.panX,
        rect.height / 2 - (y - cy) * s - state.panY
      ];
    }

    function draw() {
      if (!board) {
        return;
      }
      var rect = host.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = board.background || "#0b1120";
      ctx.fillRect(0, 0, rect.width, rect.height);
      var s = scaleFactor();

      board.layers.forEach(function (layer, layerIndex) {
        if (hidden[layer.name]) {
          return;
        }
        ctx.globalAlpha = layer.opacity;
        ctx.strokeStyle = layer.color;
        ctx.fillStyle = layer.color;
        board.primitives.forEach(function (primitive) {
          if (primitive.layer !== layerIndex) {
            return;
          }
          if (state.net && primitive.net && primitive.net !== state.net) {
            return;
          }
          if (primitive.kind === "track") {
            var a = project(primitive.start.x, primitive.start.y);
            var b = project(primitive.end.x, primitive.end.y);
            ctx.lineWidth = Math.max(1, primitive.width * s);
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(a[0], a[1]);
            ctx.lineTo(b[0], b[1]);
            ctx.stroke();
          } else if (primitive.kind === "arc") {
            var center = primitive.center;
            var radius = Math.hypot(primitive.start.x - center.x, primitive.start.y - center.y);
            var a0 = Math.atan2(primitive.start.y - center.y, primitive.start.x - center.x);
            var a1 = Math.atan2(primitive.end.y - center.y, primitive.end.x - center.x);
            var sweep = a1 - a0;
            if (primitive.clockwise) {
              while (sweep > 0) { sweep -= Math.PI * 2; }
              while (sweep < -Math.PI * 2) { sweep += Math.PI * 2; }
            } else {
              while (sweep < 0) { sweep += Math.PI * 2; }
              while (sweep > Math.PI * 2) { sweep -= Math.PI * 2; }
            }
            var arcSteps = Math.max(8, Math.min(96, Math.ceil(Math.abs(sweep) / 0.12)));
            ctx.lineWidth = Math.max(1, (primitive.width || 0.1) * s);
            ctx.lineCap = "round";
            ctx.beginPath();
            for (var step = 0; step <= arcSteps; step += 1) {
              var angle = a0 + (sweep * step) / arcSteps;
              var arcPoint = project(center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius);
              if (step === 0) {
                ctx.moveTo(arcPoint[0], arcPoint[1]);
              } else {
                ctx.lineTo(arcPoint[0], arcPoint[1]);
              }
            }
            ctx.stroke();
          } else if (primitive.kind === "pad" || primitive.kind === "via") {
            var p = project(primitive.at.x, primitive.at.y);
            var shape = primitive.shape || {
              shape: "circle",
              size: { x: primitive.diameter || 0.5, y: primitive.diameter || 0.5 },
              rotation: 0
            };
            if (shape.shape === "circle" || shape.shape === "polygon") {
              var radiusPx = Math.max(1, (shape.size.x || primitive.diameter || 0.5) * s * 0.5);
              ctx.beginPath();
              ctx.arc(p[0], p[1], radiusPx, 0, Math.PI * 2);
              ctx.fill();
            } else {
              var boxW = Math.max(1, shape.size.x * s);
              var boxH = Math.max(1, shape.size.y * s);
              ctx.save();
              ctx.translate(p[0], p[1]);
              ctx.rotate((-((shape.rotation || 0) * Math.PI)) / 180);
              if (shape.shape === "obround") {
                var corner = Math.min(boxW, boxH) / 2;
                ctx.beginPath();
                if (ctx.roundRect) {
                  ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, corner);
                } else {
                  ctx.rect(-boxW / 2, -boxH / 2, boxW, boxH);
                }
                ctx.fill();
              } else {
                ctx.fillRect(-boxW / 2, -boxH / 2, boxW, boxH);
              }
              ctx.restore();
            }
          } else if (primitive.kind === "hole") {
            var h = project(primitive.at.x, primitive.at.y);
            ctx.globalAlpha = 1;
            ctx.fillStyle = board.background || "#0b1120";
            ctx.beginPath();
            ctx.arc(h[0], h[1], Math.max(1, primitive.diameter * s * 0.5), 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = layer.opacity;
            ctx.fillStyle = layer.color;
          } else if (primitive.kind === "region") {
            ctx.beginPath();
            primitive.polygon.forEach(function (point, index) {
              var q = project(point.x, point.y);
              if (index === 0) {
                ctx.moveTo(q[0], q[1]);
              } else {
                ctx.lineTo(q[0], q[1]);
              }
            });
            ctx.closePath();
            ctx.fill();
          }
        });
      });
      ctx.globalAlpha = 1;
    }

    function load() {
      window.fetch(source, { cache: "force-cache" })
        .then(function (response) { return response.json(); })
        .then(function (payload) {
          board = payload;
          state.boards.push({ host: host, draw: draw });
          resize();
        })
        .catch(function () {
          host.textContent = "Board data could not be loaded.";
        });
    }

    canvas.addEventListener("wheel", function (event) {
      event.preventDefault();
      state.zoom = Math.min(12, Math.max(0.3, state.zoom * (event.deltaY < 0 ? 1.12 : 0.89)));
      draw();
    }, { passive: false });

    var start = null;
    canvas.addEventListener("pointerdown", function (event) {
      state.dragging = true;
      start = { x: event.clientX - state.panX, y: event.clientY - state.panY };
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", function (event) {
      if (!state.dragging || !start) {
        return;
      }
      state.panX = event.clientX - start.x;
      state.panY = start.y - event.clientY;
      draw();
    });
    canvas.addEventListener("pointerup", function () {
      state.dragging = false;
      canvas.style.cursor = "grab";
    });
    canvas.addEventListener("dblclick", function () {
      state.zoom = 1;
      state.panX = 0;
      state.panY = 0;
      draw();
    });

    window.addEventListener("resize", function () {
      resize();
    });
    qsa("[data-layer-toggle]").forEach(function (button) {
      button.addEventListener("click", function () {
        hidden[button.getAttribute("data-layer-toggle")] = button.getAttribute("aria-pressed") !== "true";
        draw();
      });
    });

    load();
  }

  /* ---------- simulation card ---------- */
  function wireSimulation() {
    var button = document.getElementById("gitware-run-sim");
    if (!button) {
      return;
    }
    button.addEventListener("click", function () {
      var status = document.getElementById("gitware-sim-status");
      var source = button.getAttribute("data-manifest");
      if (status) {
        status.textContent = "loading Super Engine...";
      }
      window.fetch(source)
        .then(function (response) { return response.json(); })
        .then(function (manifest) {
          if (typeof window.GitwareSim !== "function") {
            if (status) {
              status.textContent = manifest.machine + " firmware ready: " + manifest.wasm;
            }
            return;
          }
          window.GitwareSim(manifest);
          if (status) {
            status.textContent = "running " + manifest.machine;
          }
        })
        .catch(function () {
          if (status) {
            status.textContent = "simulation manifest unavailable";
          }
        });
    });
  }

  function boot() {
    wireLayerToggles();
    wireNetHighlight();
    wireSimulation();
    qsa("[data-board-src]").forEach(createBoard);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.GitwarePages = { state: state, redraw: function () { state.boards.forEach(function (b) { b.draw(); }); } };
})();

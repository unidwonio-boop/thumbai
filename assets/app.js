/* ============================================================================
   ThumbAI - app.js
   All of the page's JavaScript lives in this one file.

   REAL AI SETUP (optional - everything works without it):
   The Studio currently scores and writes prompts with on-device pixel
   analysis. For the deep AI read - subject, expression, on-image text -
   paste a vision API endpoint + key below. Any OpenAI-compatible chat
   endpoint with a vision model works, e.g.:
     endpoint: "https://api.openai.com/v1/chat/completions"
     key:      "sk-..."               (your API key)
     model:    "gpt-4o-mini"          (or any vision-capable model)
   With a key set, each upload is sent to that API and its scores, fixes,
   titles and prompt are used; if the call fails, the page quietly falls
   back to the on-device analysis. Leave endpoint/key empty ("") to stay
   100% on-device.
   ============================================================================ */
var THUMBAI_API = {
  endpoint: "/api/analyze",
  key: "proxy",
  model: "gemini-2.5-flash"
};

    (function(){
      "use strict";
      var $ = function(s, c){ return (c||document).querySelector(s); };
      var $$ = function(s, c){ return Array.prototype.slice.call((c||document).querySelectorAll(s)); };
      var clamp = function(v, a, b){ return Math.max(a, Math.min(b, v)); };
      var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      /* ---------- toast + clipboard + download ---------- */
      var toastTimer = null;
      function toast(msg){
        var t = $("#toast"); t.textContent = msg; t.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function(){ t.classList.remove("show"); }, 2200);
      }
      function copyText(text, msg){
        function done(){ toast(msg || "Copied to clipboard"); }
        if (navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(text).then(done, function(){ fallback(); });
        } else { fallback(); }
        function fallback(){
          var ta = document.createElement("textarea");
          ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); done(); }
          catch(e){ toast("Copy failed — select the text manually"); }
          document.body.removeChild(ta);
        }
      }
      function downloadText(filename, text){
        var blob = new Blob([text], {type:"text/plain;charset=utf-8"});
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        setTimeout(function(){ URL.revokeObjectURL(url); }, 800);
        toast("Downloaded " + filename);
      }

      /* ---------- reveal on scroll ---------- */
      var revealEls = $$(".reveal");
      if ("IntersectionObserver" in window && !reduced){
        var io = new IntersectionObserver(function(entries){
          entries.forEach(function(e){ if (e.isIntersecting){ e.target.classList.add("in"); io.unobserve(e.target); } });
        }, {threshold: .1});
        revealEls.forEach(function(el){ io.observe(el); });
      } else {
        revealEls.forEach(function(el){ el.classList.add("in"); });
      }

      /* ---------- state ---------- */
      var state = {
        mode: "thumb",
        stats: null,
        scores: null,
        fileName: "",
        dims: "",
        aspect: 16/9,
        style: "cinematic",
        format: "universal",
        promptText: "",
        reportText: "",
        aiFixes: null,
        aiTitles: null,
        aiPrompt: null,
        engine: "local"
      };

      /* ---------- color helpers ---------- */
      function rgbToHsl(r, g, b){
        r/=255; g/=255; b/=255;
        var max = Math.max(r,g,b), min = Math.min(r,g,b), l = (max+min)/2, h = 0, s = 0;
        if (max !== min){
          var d = max - min;
          s = l > .5 ? d/(2-max-min) : d/(max+min);
          if (max === r) h = (g-b)/d + (g < b ? 6 : 0);
          else if (max === g) h = (b-r)/d + 2;
          else h = (r-g)/d + 4;
          h *= 60;
        }
        return {h:h, s:s, l:l};
      }
      function hueName(h, s, l){
        if (l < .07) return "black";
        if (l > .93 && s < .25) return "white";
        if (s < .14) return l > .6 ? "light gray" : (l < .3 ? "charcoal" : "gray");
        if (h < 15 || h >= 345) return "red";
        if (h < 42) return "orange";
        if (h < 70) return "yellow";
        if (h < 160) return "green";
        if (h < 195) return "teal";
        if (h < 255) return "blue";
        if (h < 290) return "purple";
        return "pink";
      }
      function colorLabel(r, g, b){
        var hsl = rgbToHsl(r, g, b), name = hueName(hsl.h, hsl.s, hsl.l);
        if (name === "black" || name === "white" || name.indexOf("gray") > -1 || name === "charcoal") return name;
        var adj = "";
        if (hsl.s > .72 && hsl.l >= .35 && hsl.l <= .65) adj = "vivid ";
        else if (hsl.l < .3) adj = "deep ";
        else if (hsl.l > .72) adj = "pale ";
        else if (hsl.s < .3) adj = "muted ";
        return adj + name;
      }
      function toHex(r, g, b){
        function p(v){ var s = Math.round(v).toString(16); return s.length < 2 ? "0"+s : s; }
        return "#" + p(r) + p(g) + p(b);
      }
      function isSkin(r, g, b){
        return r > 95 && g > 40 && b > 20 && r > g && r > b && (r - g) > 12 && (Math.max(r,g,b) - Math.min(r,g,b)) > 15;
      }

      /* ---------- image analysis ---------- */
      function analyzeImage(img){
        var W = 240, H = Math.max(60, Math.round(W * img.naturalHeight / img.naturalWidth));
        var cv = document.createElement("canvas"); cv.width = W; cv.height = H;
        var ctx = cv.getContext("2d", {willReadFrequently:true});
        ctx.drawImage(img, 0, 0, W, H);
        var data = ctx.getImageData(0, 0, W, H).data;
        var n = W * H;

        var lum = new Float32Array(n), gray = new Uint8Array(n);
        var sumLum = 0, sumSat = 0, sumRg = 0, sumYb = 0;
        var rgArr = new Float32Array(n/2), ybArr = new Float32Array(n/2), ci = 0;
        var hist = {};
        var skinPix = 0;
        var GX = 24, GY = 14, skinCells = new Uint8Array(GX*GY), cellSkin = new Float32Array(GX*GY), cellCount = new Float32Array(GX*GY);
        var lumVals = [];

        for (var y = 0; y < H; y++){
          for (var x = 0; x < W; x++){
            var i = y*W + x, p = i*4;
            var r = data[p], g = data[p+1], b = data[p+2];
            var L = .2126*r + .7152*g + .0722*b;
            lum[i] = L; gray[i] = L; sumLum += L;
            var hsl = rgbToHsl(r, g, b); sumSat += hsl.s;
            if ((x + y) % 2 === 0 && ci < rgArr.length){
              var rg = r - g, yb = .5*(r+g) - b;
              rgArr[ci] = rg; ybArr[ci] = yb; ci++; sumRg += rg; sumYb += yb;
            }
            if (i % 3 === 0) lumVals.push(L);
            var key = ((r>>5)<<6) | ((g>>5)<<3) | (b>>5);
            hist[key] = hist[key] || {c:0, r:0, g:0, b:0};
            hist[key].c++; hist[key].r += r; hist[key].g += g; hist[key].b += b;
            var cx = Math.min(GX-1, Math.floor(x / W * GX)), cy = Math.min(GY-1, Math.floor(y / H * GY));
            var cell = cy*GX + cx; cellCount[cell]++;
            if (isSkin(r, g, b)){ skinPix++; cellSkin[cell]++; }
          }
        }
        var meanLum = sumLum / n, avgSat = sumSat / n;
        var varLum = 0;
        for (var j = 0; j < n; j++){ var d0 = lum[j] - meanLum; varLum += d0*d0; }
        var stdLum = Math.sqrt(varLum / n);
        lumVals.sort(function(a,b){ return a-b; });
        var p5 = lumVals[Math.floor(lumVals.length*.05)], p95 = lumVals[Math.floor(lumVals.length*.95)];

        var mRg = sumRg/ci, mYb = sumYb/ci, vRg = 0, vYb = 0;
        for (var k = 0; k < ci; k++){ vRg += Math.pow(rgArr[k]-mRg, 2); vYb += Math.pow(ybArr[k]-mYb, 2); }
        var colorfulness = Math.sqrt(vRg/ci + vYb/ci) + .3 * Math.sqrt(mRg*mRg + mYb*mYb);

        // sharpness: laplacian variance
        var lapMean = 0, lapCount = 0, lapVals = [];
        for (var ly = 1; ly < H-1; ly++){
          for (var lx = 1; lx < W-1; lx++){
            var li = ly*W + lx;
            var lap = 4*gray[li] - gray[li-1] - gray[li+1] - gray[li-W] - gray[li+W];
            lapVals.push(lap); lapMean += lap; lapCount++;
          }
        }
        lapMean /= lapCount;
        var lapVar = 0;
        for (var q = 0; q < lapVals.length; q++) lapVar += Math.pow(lapVals[q]-lapMean, 2);
        lapVar /= lapCount;

        // edge density
        var edges = 0, tot = 0;
        for (var ey = 0; ey < H-1; ey++){
          for (var ex = 0; ex < W-1; ex++){
            var ei = ey*W + ex;
            var grad = Math.abs(gray[ei]-gray[ei+1]) + Math.abs(gray[ei]-gray[ei+W]);
            if (grad > 56) edges++;
            tot++;
          }
        }
        var edgeDensity = edges / tot;

        // face: largest connected cluster of skin-heavy cells
        for (var c2 = 0; c2 < GX*GY; c2++) skinCells[c2] = (cellCount[c2] && cellSkin[c2]/cellCount[c2] > .25) ? 1 : 0;
        var visited = new Uint8Array(GX*GY), bestCluster = 0, bestCx = 0, bestCy = 0;
        for (var s0 = 0; s0 < GX*GY; s0++){
          if (!skinCells[s0] || visited[s0]) continue;
          var stack = [s0], size = 0, sx = 0, sy = 0; visited[s0] = 1;
          while (stack.length){
            var cur = stack.pop(), cxx = cur % GX, cyy = Math.floor(cur / GX);
            size++; sx += cxx; sy += cyy;
            var nb = [[cxx+1,cyy],[cxx-1,cyy],[cxx,cyy+1],[cxx,cyy-1]];
            for (var z = 0; z < 4; z++){
              var nx = nb[z][0], ny = nb[z][1];
              if (nx < 0 || ny < 0 || nx >= GX || ny >= GY) continue;
              var ni = ny*GX + nx;
              if (skinCells[ni] && !visited[ni]){ visited[ni] = 1; stack.push(ni); }
            }
          }
          if (size > bestCluster){ bestCluster = size; bestCx = sx/size; bestCy = sy/size; }
        }
        var faceFrac = bestCluster / (GX*GY);
        var skinRatio = skinPix / n;

        // text zone: flattest edge region (left / right third, top / bottom band)
        var cellVar = new Float32Array(GX*GY);
        for (var gy2 = 0; gy2 < GY; gy2++){
          for (var gx2 = 0; gx2 < GX; gx2++){
            var x0 = Math.floor(gx2 * W / GX), x1 = Math.floor((gx2+1) * W / GX);
            var y0 = Math.floor(gy2 * H / GY), y1 = Math.floor((gy2+1) * H / GY);
            var m = 0, cnt = 0;
            for (var yy = y0; yy < y1; yy++) for (var xx = x0; xx < x1; xx++){ m += gray[yy*W+xx]; cnt++; }
            m /= cnt;
            var v = 0;
            for (var yy2 = y0; yy2 < y1; yy2++) for (var xx2 = x0; xx2 < x1; xx2++){ var dv = gray[yy2*W+xx2]-m; v += dv*dv; }
            cellVar[gy2*GX+gx2] = v / cnt;
          }
        }
        function flatShare(xFrom, xTo, yFrom, yTo){
          var flat = 0, total = 0;
          for (var yy3 = yFrom; yy3 < yTo; yy3++) for (var xx3 = xFrom; xx3 < xTo; xx3++){
            total++; if (cellVar[yy3*GX+xx3] < 110) flat++;
          }
          return total ? flat/total : 0;
        }
        var zones = [
          {name:"left third", v: flatShare(0, 8, 0, GY)},
          {name:"right third", v: flatShare(16, 24, 0, GY)},
          {name:"top band", v: flatShare(0, 24, 0, 5)},
          {name:"bottom band", v: flatShare(0, 24, 9, GY)}
        ];
        zones.sort(function(a,b){ return b.v - a.v; });
        var bestZone = zones[0];

        // palette: top distinct buckets, ranked by area weighted toward saturated colors
        var buckets = Object.keys(hist).map(function(key){
          var bk = hist[key], br = bk.r/bk.c, bg = bk.g/bk.c, bb = bk.b/bk.c;
          var bh = rgbToHsl(br, bg, bb);
          bk.avgR = br; bk.avgG = bg; bk.avgB = bb; bk.sat = bh.s;
          bk.rank = bk.c * (0.25 + bh.s * 1.6);
          return bk;
        });
        buckets.sort(function(a,b){ return b.rank - a.rank; });
        var palette = [];
        for (var bi = 0; bi < buckets.length && palette.length < 3; bi++){
          var bk2 = buckets[bi], br2 = bk2.avgR, bg2 = bk2.avgG, bb2 = bk2.avgB;
          var dup = palette.some(function(pc){
            return pc.name === colorLabel(br2,bg2,bb2) ||
              Math.abs(pc.r-br2) + Math.abs(pc.g-bg2) + Math.abs(pc.b-bb2) < 80;
          });
          if (!dup) palette.push({r:br2, g:bg2, b:bb2, hex: toHex(br2,bg2,bb2), name: colorLabel(br2,bg2,bb2)});
        }

        var scores = {
          colorPop: Math.round(clamp(.65 * clamp(colorfulness/85*100, 0, 100) + .35 * clamp(avgSat/.62*100, 0, 100), 0, 100)),
          contrast: Math.round(clamp(.6 * clamp(stdLum/72*100, 0, 100) + .4 * clamp((p95-p5)/255*100, 0, 100), 0, 100)),
          face: Math.round(clamp((faceFrac/.115*100) * (bestCy < GY*.55 ? 1 : .82), skinRatio > .005 ? 8 : 0, 100)),
          sharp: Math.round(clamp((Math.log(lapVar+1) - 3.1) / 3.5 * 100, 0, 100)),
          textZone: Math.round(clamp(bestZone.v * 118, 0, 100)),
          simple: Math.round(clamp(100 - edgeDensity * 300, 0, 100))
        };
        if (skinRatio < .004) scores.face = Math.min(scores.face, 14);
        var overall = Math.round(
          scores.colorPop*.20 + scores.contrast*.20 + scores.face*.18 +
          scores.sharp*.14 + scores.textZone*.14 + scores.simple*.14
        );

        return { stats: {
          meanLum: meanLum, avgSat: avgSat, stdLum: stdLum, colorfulness: colorfulness,
          sharpVar: lapVar, edgeDensity: edgeDensity, faceFrac: faceFrac, skinRatio: skinRatio,
          zoneName: bestZone.name, zoneShare: bestZone.v, palette: palette
        }, scores: scores, overall: overall };
      }

      /* ---------- verdicts, fixes, titles ---------- */
      function bandOf(score){
        if (score >= 78) return {cls:"good", label:"GREAT — READY TO POST", title:"This one will get clicks.", text:"It does the important things well: bright, clear, and easy to understand at a glance. Post it — or try one version with an even bigger face."};
        if (score >= 58) return {cls:"mid", label:"GOOD — ALMOST GREAT", title:"Good, and close to great.", text:"Most of it works, but one or two weak spots below are costing you clicks. Fix those and check again."};
        if (score >= 38) return {cls:"mid", label:"NEEDS WORK", title:"People will scroll past this.", text:"Right now it blends in with everything else. The fixes below are in order — do the first two before anything else."};
        return {cls:"bad", label:"TOO WEAK — REBUILD IT", title:"This thumbnail is invisible.", text:"The colors are dull, nothing stands out, and there is no clear main subject. Don't patch it — start again with one face or one object and two bright colors."};
      }
      function metricMeta(key, st, sc){
        var map = {
          colorPop: {label:"Bright colors", note: st.avgSat > .3 ? "Colors are bright and strong" : "Colors look dull — brighten them"},
          contrast: {label:"Stands out from background", note: st.stdLum > 55 ? "Subject and background are clearly different" : "Subject blends into the background"},
          face: {label:"Face or main object", note: st.faceFrac > .01 ? "A face/main subject was found, about " + Math.round(st.faceFrac*100) + "% of the picture" : "No clear face or main object found"},
          sharp: {label:"Sharpness", note: st.sharpVar > 400 ? "Nice and sharp" : "Looks soft — use a clearer, bigger picture"},
          textZone: {label:"Space for text", note:"Emptiest area: the " + st.zoneName + " — good place for your words"},
          simple: {label:"Not too cluttered", note: st.edgeDensity > .3 ? "Lots going on — hard to take in quickly" : "Clean and easy to take in"}
        };
        return map[key];
      }
      function fixesFor(st, sc){
        var fixes = [], wins = [];
        if (sc.colorPop < 55) fixes.push({t:"Make the colors brighter and use only 2–3 of them. Dull, many-colored thumbnails are the top reason people scroll past."});
        else if (sc.colorPop >= 80) wins.push({t:"Your colors are bright and eye-catching — keep using these same colors in your next videos too."});
        if (sc.contrast < 55) fixes.push({t:"Make the subject stand out: darken the background, or put a bright glow or outline behind the subject, so it is clear even when the thumbnail is tiny."});
        else if (sc.contrast >= 80) wins.push({t:"The subject stands out clearly from the background — even at small size."});
        if (sc.face < 40) fixes.push({t:"Add a big face with a clear expression, or one big main object. A face people can read at a glance gets more clicks than a busy scene."});
        else if (sc.face >= 70) wins.push({t:"The face or main subject is big and easy to read — exactly what a small phone thumbnail needs."});
        if (sc.sharp < 50) fixes.push({t:"Use a bigger, sharper picture (at least 1280×720). Blurry thumbnails look even worse after YouTube processes them."});
        if (sc.textZone < 50) fixes.push({t:"Free up one area for text: blur or darken the " + st.zoneName + " and use it for at most 3 very big words with a thick outline."});
        else if (sc.textZone >= 75) wins.push({t:"You have a clean empty area (" + st.zoneName + ") — use it for 3 big words or fewer, sized for a phone screen."});
        if (sc.simple < 45) fixes.push({t:"Remove clutter: take out everything that is not the face/object or the text. Every extra thing steals attention in the half-second you get."});
        var out = fixes.slice(0, 3).concat(wins.slice(0, 2));
        return out.map(function(f, i){ return {text: f.t, win: fixes.indexOf(f) === -1}; });
      }
      function titlesFor(overall, topic){
        var T = topic ? topic.trim() : "";
        if (T){
          var cap = T.charAt(0).toUpperCase() + T.slice(1);
          return [
            cap + " — Nobody Expected This",
            "The Truth About " + cap,
            "Stop Doing " + cap + " Wrong",
            "I Tried " + cap + " (Honest Results)",
            "What Nobody Tells You About " + cap
          ];
        }
        if (overall >= 58) return [
          "I Tested It So You Don't Have To",
          "Nobody Is Talking About This",
          "Watch This Before You Scroll Past",
          "This Changes Everything (Really)",
          "The Mistake Everyone Makes"
        ];
        return [
          "Add your video topic above for tailored titles",
          "I Tested It So You Don't Have To",
          "Nobody Is Talking About This",
          "This Changes Everything (Really)",
          "The Mistake Everyone Makes"
        ];
      }

      /* ---------- rendering: thumbnail results ---------- */
      function animateScore(target){
        var numEl = $("#score-num"), ring = $("#ring-fg"), C = 339.3;
        var color = target >= 78 ? "var(--lime)" : (target >= 45 ? "var(--amber)" : "var(--red)");
        ring.style.stroke = color;
        numEl.textContent = target;
        if (reduced){
          ring.style.strokeDashoffset = C * (1 - target/100);
          return;
        }
        var start = null;
        function step(ts){
          if (!start) start = ts;
          var p = clamp((ts - start) / 900, 0, 1);
          var eased = 1 - Math.pow(1 - p, 3);
          ring.style.strokeDashoffset = C * (1 - (target * eased)/100);
          if (p < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      }
      function renderThumb(){
        var st = state.stats, sc = state.scores;
        if (!st || !sc) return;
        var overall = sc.overall, band = bandOf(overall);
        $("#verdict-title").textContent = band.title;
        $("#verdict-text").textContent = band.text;
        var bandEl = $("#verdict-band");
        bandEl.textContent = band.label + " · " + overall + "/100";
        bandEl.className = "band " + band.cls;

        var keys = ["colorPop","contrast","face","sharp","textZone","simple"];
        var mWrap = $("#metrics"); mWrap.innerHTML = "";
        keys.forEach(function(key){
          var meta = metricMeta(key, st, sc[key]);
          var val = sc[key];
          var div = document.createElement("div");
          div.innerHTML =
            '<div class="metric-head"><span>' + meta.label + '</span><span>' + val + '</span></div>' +
            '<div class="bar"><i class="' + (val >= 70 ? "good" : (val < 45 ? "bad" : "")) + '" data-w="' + val + '"></i></div>' +
            '<div class="metric-note">' + meta.note + '</div>';
          mWrap.appendChild(div);
        });
        setTimeout(function(){
          $$("#metrics .bar i").forEach(function(bar){ bar.style.width = bar.getAttribute("data-w") + "%"; });
        }, 60);

        var fixes = (state.aiFixes && state.aiFixes.length) ? state.aiFixes : fixesFor(st, sc);
        var fWrap = $("#fix-list"); fWrap.innerHTML = "";
        fixes.forEach(function(f){
          var div = document.createElement("div");
          div.className = "fix" + (f.win ? " win" : "");
          div.innerHTML = f.win
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m5 12 7 7 7-7"/></svg>';
          var span = document.createElement("span");
          span.textContent = f.text;
          div.appendChild(span);
          fWrap.appendChild(div);
        });

        var topic = $("#topic-input").value;
        var titles = (state.aiTitles && state.aiTitles.length) ? state.aiTitles : titlesFor(overall, topic);
        var tWrap = $("#title-list"); tWrap.innerHTML = "";
        titles.forEach(function(t){
          var div = document.createElement("div");
          div.className = "title-item";
          var span = document.createElement("span"); span.textContent = t;
          var btn = document.createElement("button"); btn.type = "button"; btn.textContent = "Copy";
          btn.addEventListener("click", function(){ copyText(t, "Title copied"); });
          div.appendChild(span); div.appendChild(btn);
          tWrap.appendChild(div);
        });

        var lines = [];
        lines.push("ThumbAI — Thumbnail Audit");
        lines.push("File: " + state.fileName + " (" + state.dims + ")");
        lines.push("SCORE: " + overall + "/100 — " + band.label);
        lines.push("");
        keys.forEach(function(key){
          var meta = metricMeta(key, st, sc[key]);
          lines.push(meta.label + ": " + sc[key] + "/100 — " + meta.note);
        });
        lines.push("");
        lines.push("FIXES FIRST:");
        fixes.forEach(function(f, i){ lines.push((i+1) + ". " + f.text); });
        lines.push("");
        lines.push("TITLE IDEAS:");
        titles.forEach(function(t){ lines.push("- " + t); });
        lines.push("");
        lines.push(state.engine === "ai" ? "Generated with ThumbAI — AI vision analysis via the connected API." : "Generated with ThumbAI — on-device pixel analysis.");
        state.reportText = lines.join("\n");

        var engNote = $("#engine-note");
        if (engNote) engNote.textContent = state.engine === "ai"
          ? "Checked by AI, which looked at the subject, face and any text in your picture."
          : "Your picture was checked right here on your device — nothing was uploaded or saved anywhere.";
        animateScore(overall);
        var heroNum = $("#hero-score"), heroVerdict = $("#hero-verdict");
        if (state.fileName.indexOf("high-energy") > -1){
          heroNum.textContent = overall;
          heroVerdict.textContent = band.label.charAt(0) + band.label.slice(1).toLowerCase();
        }
      }

      /* ---------- rendering: prompt results ---------- */
      function aspectLabel(){ return aspectLabelFor(state.aspect); }
      function aspectLabelFor(r){
        var opts = [[16/9,"16:9"],[4/3,"4:3"],[3/2,"3:2"],[1,"1:1"],[9/16,"9:16"],[21/9,"21:9"]];
        var best = "16:9", bd = 1e9;
        opts.forEach(function(o){ var d = Math.abs(o[0]-r); if (d < bd){ bd = d; best = o[1]; } });
        return best;
      }
      function composePrompt(st, subject, style, format, aspect){
        var styleMap = {
          cinematic: {lead:"cinematic photograph of ", tail:"shallow depth of field, atmospheric haze, photorealistic detail"},
          thumbnail: {lead:"high-impact YouTube thumbnail style image of ", tail:"exaggerated readable expression, bold saturated colors, thick contrast, designed to pop at small size, clean space for big text"},
          product: {lead:"studio product photograph of ", tail:"clean backdrop, softbox lighting, crisp reflections, commercial advertising quality"},
          anime: {lead:"anime illustration of ", tail:"cel shading, clean line art, vibrant palette, richly detailed background"},
          render3d: {lead:"ultra-detailed 3D render of ", tail:"octane render, soft global illumination, ray-traced reflections, detailed textures"}
        };
        var sm = styleMap[style] || styleMap.cinematic;
        var palNames = st.palette.map(function(p){ return p.name; });
        var palPhrase = palNames.length ? "a palette of " + palNames.join(", ").replace(/, ([^,]*)$/, " and $1") : "a balanced palette";
        var lightPhrase = st.meanLum < 70 ? "low-key moody lighting with deep shadows" :
                          st.meanLum > 150 ? "bright, evenly lit, high-key lighting" : "balanced directional lighting";
        var moodPhrase = st.avgSat > .38 ? "vivid and energetic" : (st.avgSat < .16 ? "muted and understated" : "natural, true-to-life color");
        var core = sm.lead + subject + ", " + palPhrase + ", " + lightPhrase + ", " + moodPhrase + " mood, " + sm.tail + ", " + aspectLabelFor(aspect) + " composition";
        var text = core;
        if (format === "midjourney") text = core + " --ar " + aspectLabelFor(aspect) + " --style raw --v 6.1";
        return text;
      }
      function buildPrompt(){
        var st = state.stats;
        if (!st) return;
        var subject = $("#subject-input").value.trim() || "the main subject of the uploaded photo";
        var text;
        if (state.aiPrompt){
          text = state.aiPrompt;
          if (state.format === "midjourney") text += " --ar " + aspectLabel() + " --style raw --v 6.1";
        } else {
          text = composePrompt(st, subject, state.style, state.format, state.aspect);
        }
        state.promptText = text;
        $("#prompt-out").textContent = text;
        var pnote = $("#engine-note-prompt");
        if (pnote) pnote.textContent = state.aiPrompt
          ? "This prompt was written by AI from your photo. The colors below were read from your photo."
          : "The colors above were read from your photo. Paste the prompt into Midjourney, Nano Banana, DALL·E or Stable Diffusion to make a similar picture.";
        var neg = $("#negative-wrap");
        if (state.format === "sd"){
          neg.style.display = "block";
          $("#negative-out").textContent = "blurry, low-resolution, dull colors, cluttered composition, watermark, text artifacts, deformed hands, extra fingers, noisy background";
        } else {
          neg.style.display = "none";
        }
        var prow = $("#palette-row"); prow.innerHTML = "";
        st.palette.forEach(function(p){
          var s = document.createElement("span");
          s.className = "swatch";
          s.innerHTML = '<i style="background:' + p.hex + '"></i>' + p.name + " " + p.hex;
          prow.appendChild(s);
        });
      }
      function renderPrompt(){ if (state.stats) buildPrompt(); }

      /* ---------- real AI: vision API (active when THUMBAI_API has a key) ---------- */
      function validScore(v){
        var n = Math.round(Number(v));
        return isFinite(n) ? clamp(n, 0, 100) : null;
      }
      function runAiAnalysis(dataUrl){
        var instructions = [
          "You are ThumbAI, an expert YouTube thumbnail analyst and image-prompt writer.",
          "Look at the attached image and reply with ONLY a JSON object - no markdown, no commentary:",
          "{",
          '  "scores": {"colorPop": 0-100, "contrast": 0-100, "face": 0-100, "sharp": 0-100, "textZone": 0-100, "simple": 0-100},',
          '  "overall": 0-100,',
          '  "fixes": ["up to 3 specific fixes, most impactful first"],',
          '  "wins": ["up to 2 things already working well"],',
          '  "titles": ["5 clickable YouTube title ideas that fit this thumbnail"],',
          '  "prompt": "one ready-to-paste image-generation prompt that recreates this image",',
          '  "subject": "one short phrase naming the main subject"',
          "}",
          "Score honestly: colorPop = saturation and palette discipline, contrast = dark-light separation, face = size and readability of a face or single focal subject, sharp = detail sharpness, textZone = clean space for big text, simple = lack of clutter."
        ].join("\n");
        var ctrl = ("AbortController" in window) ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function(){ ctrl.abort(); }, 30000) : null;
        return fetch(THUMBAI_API.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + THUMBAI_API.key },
          body: JSON.stringify({
            model: THUMBAI_API.model,
            temperature: 0.4,
            messages: [{ role: "user", content: [
              { type: "text", text: instructions },
              { type: "image_url", image_url: { url: dataUrl } }
            ]}]
          }),
          signal: ctrl ? ctrl.signal : undefined
        }).then(function(r){
          if (timer) clearTimeout(timer);
          if (!r.ok) throw new Error("AI API returned " + r.status);
          return r.json();
        }).then(function(j){
          var text = "";
          if (j && j.choices && j.choices[0] && j.choices[0].message) text = j.choices[0].message.content || "";
          else if (j && j.content && j.content[0]) text = j.content[0].text || "";
          var m = String(text).match(/\{[\s\S]*\}/);
          if (!m) throw new Error("AI reply was not JSON");
          var ai = JSON.parse(m[0]);
          if (!ai || !ai.scores) throw new Error("AI reply missing scores");
          return ai;
        });
      }
      function imageDataUrl(img){
        try {
          var scale = Math.min(1, 1024 / img.naturalWidth);
          var cv = document.createElement("canvas");
          cv.width = Math.max(2, Math.round(img.naturalWidth * scale));
          cv.height = Math.max(2, Math.round(img.naturalHeight * scale));
          cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
          return cv.toDataURL("image/jpeg", 0.82);
        } catch(e){ return null; }
      }

      /* ---------- analysis flow ---------- */
      var scanSteps = ["looking at the colors","checking it stands out","looking for a face","checking sharpness","looking for space for text","checking for clutter"];
      function runAnalysis(img){
        $("#empty-state").style.display = "none";
        $("#thumb-results").classList.remove("show");
        $("#prompt-results").classList.remove("show");
        var an = $("#analyzing"); an.classList.add("show");
        var stepEl = $("#scan-step"), si = 0;
        stepEl.textContent = scanSteps[0];
        var iv = setInterval(function(){ si = (si+1) % scanSteps.length; stepEl.textContent = scanSteps[si]; }, 260);
        var startedAt = Date.now();
        state.aiFixes = null; state.aiTitles = null; state.aiPrompt = null; state.engine = "local";
        var localRes = analyzeImage(img);
        function finish(res){
          var wait = Math.max(0, (reduced ? 200 : 950) - (Date.now() - startedAt));
          setTimeout(function(){
            clearInterval(iv);
            res.scores.overall = res.overall;
            state.stats = res.stats; state.scores = res.scores;
            an.classList.remove("show");
            if (state.mode === "thumb"){
              $("#thumb-results").classList.add("show");
              renderThumb();
            } else {
              $("#prompt-results").classList.add("show");
              renderPrompt();
            }
          }, wait);
        }
        if (THUMBAI_API.endpoint && THUMBAI_API.key){
          var dataUrl = imageDataUrl(img);
          if (dataUrl){
            runAiAnalysis(dataUrl).then(function(ai){
              var keys = ["colorPop","contrast","face","sharp","textZone","simple"];
              var merged = {};
              keys.forEach(function(k){
                var v = validScore(ai.scores[k]);
                merged[k] = (v === null ? localRes.scores[k] : v);
              });
              var ov = validScore(ai.overall);
              var overall = (ov === null)
                ? Math.round(merged.colorPop*.20 + merged.contrast*.20 + merged.face*.18 + merged.sharp*.14 + merged.textZone*.14 + merged.simple*.14)
                : ov;
              var aiFixes = [];
              (ai.fixes || []).slice(0, 3).forEach(function(t){ aiFixes.push({text: String(t), win: false}); });
              (ai.wins || []).slice(0, 2).forEach(function(t){ aiFixes.push({text: String(t), win: true}); });
              state.aiFixes = aiFixes.length ? aiFixes : null;
              state.aiTitles = (ai.titles && ai.titles.length) ? ai.titles.map(String).slice(0, 5) : null;
              state.aiPrompt = ai.prompt ? String(ai.prompt) : null;
              state.engine = "ai";
              if (ai.subject && !$("#subject-input").value) $("#subject-input").value = String(ai.subject);
              finish({ stats: localRes.stats, scores: merged, overall: overall });
            }).catch(function(){ finish(localRes); });
            return;
          }
        }
        finish(localRes);
      }
      function showPreview(src, name, img){
        var box = $("#preview-box"); box.classList.add("show");
        $("#preview-img").src = src;
        state.dims = img.naturalWidth + " × " + img.naturalHeight + " px";
        state.aspect = img.naturalWidth / img.naturalHeight;
        $("#preview-meta").textContent = name + " · " + state.dims;
        $("#preview-frame").classList.remove("tiny");
        $("#tiny-toggle").textContent = "See it small (phone size)";
      }
      function loadImageFromSrc(src, name){
        var img = new Image();
        img.onload = function(){ state.fileName = name; showPreview(src, name, img); runAnalysis(img); };
        img.onerror = function(){ toast("Could not load that image"); };
        img.src = src;
      }
      function handleFile(file){
        if (!file || file.type.indexOf("image/") !== 0){ toast("Please choose an image file"); return; }
        var url = URL.createObjectURL(file);
        loadImageFromSrc(url, file.name);
      }
      function loadSample(btn){
        var src = btn.getAttribute("data-sample");
        var name = btn.getAttribute("data-name") || "sample";
        var mode = btn.getAttribute("data-mode");
        var subject = btn.getAttribute("data-subject");
        if (mode) setMode(mode);
        if (subject) $("#subject-input").value = subject;
        if (!btn.closest || !btn.closest(".studio-shell")){
          document.getElementById("studio").scrollIntoView({behavior: reduced ? "auto" : "smooth"});
        }
        fetch(src).then(function(r){ return r.blob(); }).then(function(blob){
          loadImageFromSrc(URL.createObjectURL(blob), name);
        }).catch(function(){ loadImageFromSrc(src, name); });
      }

      /* ---------- mode switching ---------- */
      function setMode(mode){
        state.mode = mode;
        var isThumb = mode === "thumb";
        $("#tab-thumb").classList.toggle("active", isThumb);
        $("#tab-thumb").setAttribute("aria-selected", isThumb);
        $("#tab-prompt").classList.toggle("active", !isThumb);
        $("#tab-prompt").setAttribute("aria-selected", !isThumb);
        $("#topic-field").style.display = isThumb ? "block" : "none";
        $("#subject-field").style.display = isThumb ? "none" : "block";
        $("#style-field").style.display = isThumb ? "none" : "block";
        $("#format-field").style.display = isThumb ? "none" : "block";
        if (state.stats){
          $("#thumb-results").classList.toggle("show", isThumb);
          $("#prompt-results").classList.toggle("show", !isThumb);
          if (isThumb) renderThumb(); else renderPrompt();
        }
      }
      $("#tab-thumb").addEventListener("click", function(){ setMode("thumb"); });
      $("#tab-prompt").addEventListener("click", function(){ setMode("prompt"); });
      $("#cta-prompt").addEventListener("click", function(){ setMode("prompt"); });

      /* ---------- upload wiring ---------- */
      var dz = $("#dropzone"), fi = $("#file-input");
      $("#browse-btn").addEventListener("click", function(){ fi.click(); });
      dz.addEventListener("click", function(e){ if (e.target.id !== "browse-btn") fi.click(); });
      fi.addEventListener("change", function(){ if (fi.files && fi.files[0]) handleFile(fi.files[0]); fi.value = ""; });
      ["dragenter","dragover"].forEach(function(ev){
        dz.addEventListener(ev, function(e){ e.preventDefault(); dz.classList.add("drag"); });
      });
      ["dragleave","drop"].forEach(function(ev){
        dz.addEventListener(ev, function(e){ e.preventDefault(); dz.classList.remove("drag"); });
      });
      dz.addEventListener("drop", function(e){
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        handleFile(f);
      });
      window.addEventListener("dragover", function(e){ e.preventDefault(); });
      window.addEventListener("drop", function(e){ e.preventDefault(); });
      document.addEventListener("paste", function(e){
        var items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (var i = 0; i < items.length; i++){
          if (items[i].type.indexOf("image/") === 0){ handleFile(items[i].getAsFile()); break; }
        }
      });
      $$("[data-sample]").forEach(function(btn){
        btn.addEventListener("click", function(){ loadSample(btn); });
      });

      /* ---------- studio controls ---------- */
      $("#tiny-toggle").addEventListener("click", function(){
        var frame = $("#preview-frame");
        var tiny = frame.classList.toggle("tiny");
        this.textContent = tiny ? "Back to full size" : "See it small (phone size)";
      });
      $("#topic-input").addEventListener("input", function(){
        if (state.stats && state.mode === "thumb") renderThumb();
      });
      $("#subject-input").addEventListener("input", function(){
        if (state.stats && state.mode === "prompt") renderPrompt();
      });
      $$("#style-chips .chip").forEach(function(chip){
        chip.addEventListener("click", function(){
          $$("#style-chips .chip").forEach(function(c){ c.classList.remove("on"); });
          chip.classList.add("on");
          state.style = chip.getAttribute("data-style");
          if (state.stats && state.mode === "prompt") renderPrompt();
        });
      });
      $$("#format-chips .chip").forEach(function(chip){
        chip.addEventListener("click", function(){
          $$("#format-chips .chip").forEach(function(c){ c.classList.remove("on"); });
          chip.classList.add("on");
          state.format = chip.getAttribute("data-format");
          if (state.stats && state.mode === "prompt") renderPrompt();
        });
      });
      $("#copy-report").addEventListener("click", function(){ if (state.reportText) copyText(state.reportText, "Report copied"); });
      $("#download-report").addEventListener("click", function(){ if (state.reportText) downloadText("thumbai-audit.txt", state.reportText); });
      $("#copy-prompt").addEventListener("click", function(){ if (state.promptText) copyText(state.promptText, "Prompt copied — paste it into your generator"); });
      $("#download-prompt").addEventListener("click", function(){
        if (!state.promptText) return;
        var extra = state.format === "sd" ? "\n\nNegative prompt: blurry, low-resolution, dull colors, cluttered composition, watermark, text artifacts, deformed hands, extra fingers, noisy background" : "";
        downloadText("thumbai-prompt.txt", state.promptText + extra);
      });
      var showcaseBtn = $("#copy-showcase");
      if (showcaseBtn) showcaseBtn.addEventListener("click", function(){
        copyText($("#showcase-prompt").textContent.trim(), "Prompt copied");
      });

      /* ---------- mobile action bar ---------- */
      var mbScore = $("#mb-score"), mbPrompt = $("#mb-prompt");
      if (mbScore) mbScore.addEventListener("click", function(){ setMode("thumb"); });
      if (mbPrompt) mbPrompt.addEventListener("click", function(){ setMode("prompt"); });

      /* ---------- prompt lab showcase: generated from the real photo at runtime ---------- */
      function fillShowcase(){
        var out = $("#showcase-prompt");
        if (!out) return;
        var img = new Image();
        img.onload = function(){
          try {
            var res = analyzeImage(img);
            var subject = "a yellow auto-rickshaw with glowing headlights on a rain-soaked neon street at night";
            out.textContent = composePrompt(res.stats, subject, "cinematic", "universal", img.naturalWidth / img.naturalHeight);
            var prow = $("#showcase-palette");
            if (prow){
              prow.innerHTML = "";
              res.stats.palette.forEach(function(p){
                var s = document.createElement("span");
                s.className = "swatch";
                s.innerHTML = '<i style="background:' + p.hex + '"></i>' + p.name + " " + p.hex;
                prow.appendChild(s);
              });
            }
          } catch(e){ /* keep the written example if analysis fails */ }
        };
        img.src = "assets/prompt-photo.webp";
      }

      /* ---------- boot: analyze the sample so the page is alive ---------- */
      loadImageFromSrc("assets/sample-thumbnail.webp", "high-energy-thumbnail.webp");
      fillShowcase();
    })();

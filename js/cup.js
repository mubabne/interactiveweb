/* =========================================================
   Ember — interactive glass of coffee
   ---------------------------------------------------------
   - Cup is a spring-driven rigid body you can grab & pull.
   - Liquid volume is conserved: for any tilt we solve for the
     surface line that encloses exactly the current volume.
   - The surface follows *effective* gravity (gravity minus the
     cup's acceleration) through a damped spring -> sloshing.
   - Whatever no longer fits below the low lip spills out as
     particles, rendered as gooey liquid through an SVG filter.
   - Released cup springs home; a kettle slides in and refills
     it with real particles that are absorbed by the surface.
   ========================================================= */
(function () {
  "use strict";

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function polyArea(pts) {
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) * 0.5;
  }

  /* Keep the part of a convex polygon where (u . p) <= d  ("below" the surface). */
  function clipBelow(poly, ux, uy, d) {
    const out = [];
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const fa = ux * a.x + uy * a.y - d;
      const fb = ux * b.x + uy * b.y - d;
      if (fa <= 0) out.push(a);
      if ((fa <= 0) !== (fb <= 0)) {
        const t = fa / (fa - fb);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    return out;
  }

  const COLORS = {
    particle: "#3a1c0d",
    line: "rgba(23,17,12,0.16)",
    ink: "rgba(23,17,12,0.34)",
    inkSoft: "rgba(23,17,12,0.16)",
    ember: "#d9622b",
  };

  class CoffeeCup {
    constructor(opts) {
      this.stage = opts.stage;
      this.cupCanvas = opts.cupCanvas;
      this.fxCanvas = opts.fxCanvas;
      this.hit = opts.hit;
      this.hint = opts.hint || null;
      this.blurNode = opts.blurNode || null;

      this.ctx = this.cupCanvas.getContext("2d");
      this.fx = this.fxCanvas.getContext("2d");

      this.particles = [];
      this.waveN = 28;
      this.waveH = new Float32Array(this.waveN);
      this.waveV = new Float32Array(this.waveN);
      this.waveA = new Float32Array(this.waveN);

      this.pos = { x: 0, y: 0 };
      this.vel = { x: 0, y: 0 };
      this.prevVel = { x: 0, y: 0 };
      this.acc = { x: 0, y: 0 };
      this.theta = 0;
      this.omega = 0;
      this.alpha = 0; // world angle of the liquid surface normal
      this.alphaV = 0;
      this.surf = { ux: 0, uy: -1, d: 0 };

      this.V = 0;
      this.Vmax = 0;
      this.spillAcc = 0;
      this.pourAcc = 0;
      this.spilledTotal = 0;
      this.streamCount = 0;

      this.dragging = false;
      this.autoTip = 0;
      this.pointer = { x: 0, y: 0 };
      this.downPointer = { x: 0, y: 0 };
      this.lastPointer = { x: 0, y: 0 };
      this.lastPointerT = 0;
      this.downT = 0;
      this.moved = 0;
      this.grabOff = { x: 0, y: 0 };
      this.thetaBase = 0;
      this.pVel = { x: 0, y: 0 };

      this.refilling = false;
      this.refillDelay = 1.2;
      this.kettle = 0;
      this.steam = 0;
      this.time = 0;
      this.hasInteracted = false;

      this.running = false;
      this.visible = true;
      this.acc_t = 0;
      this.lastT = 0;
      this._hitBox = { x: 0, y: 0, w: 0, h: 0 };
      this._lastSpillShown = -1;

      this._bind();
      this.resize(true);
      this.start();
    }

    /* ---------------------------------------------- setup */
    _bind() {
      this._onDown = this._onDown.bind(this);
      this._onMove = this._onMove.bind(this);
      this._onUp = this._onUp.bind(this);
      this._loop = this._loop.bind(this);

      this.hit.addEventListener("pointerdown", this._onDown);
      this.hit.addEventListener("pointermove", this._onMove);
      this.hit.addEventListener("pointerup", this._onUp);
      this.hit.addEventListener("pointercancel", this._onUp);
      this.hit.addEventListener("lostpointercapture", this._onUp);
      this.hit.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.tip();
        }
      });

      let rT;
      window.addEventListener("resize", () => {
        clearTimeout(rT);
        rT = setTimeout(() => this.resize(), 120);
      });

      if ("IntersectionObserver" in window) {
        new IntersectionObserver((entries) => {
          this.visible = entries[0].isIntersecting;
          if (this.visible) this.start();
        }).observe(this.stage);
      }
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) this.start();
      });
    }

    resize(first) {
      const r = this.stage.getBoundingClientRect();
      const w = Math.max(320, r.width);
      const h = Math.max(400, r.height);
      const fillFrac = this.Vmax ? this.V / this.Vmax : 1;

      this.w = w;
      this.h = h;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.fxDpr = Math.min(window.devicePixelRatio || 1, 1.5);
      this.cupCanvas.width = Math.round(w * this.dpr);
      this.cupCanvas.height = Math.round(h * this.dpr);
      this.fxCanvas.width = Math.round(w * this.fxDpr);
      this.fxCanvas.height = Math.round(h * this.fxDpr);

      const mobile = w < 900;
      this.mobile = mobile;
      const H = clamp(Math.min(w * (mobile ? 0.4 : 0.19), h * 0.3), 120, 260);
      this.H = H;
      this.Wt = H * 0.9;
      this.Wb = H * 0.66;
      this.t = Math.max(4, H * 0.045);
      this.base = H * 0.11;
      this.r = Math.max(5, H * 0.034);
      this.vp = Math.PI * this.r * this.r * 1.1;
      this.g = H * 9.5;
      if (this.blurNode) this.blurNode.setAttribute("stdDeviation", (this.r * 0.62).toFixed(2));

      this.floorY = h * (mobile ? 0.87 : 0.85);
      const homeX = mobile ? w * 0.5 : w * 0.7;
      const sH = H * 0.075;
      this.saucer = { x: homeX, w: this.Wt * 1.95, h: sH, top: this.floorY - sH };
      this.home = { x: homeX, y: this.saucer.top - (H / 2 + this.base) };

      this.poly = [
        { x: -this.Wt / 2, y: -H / 2 },
        { x: this.Wt / 2, y: -H / 2 },
        { x: this.Wb / 2, y: H / 2 },
        { x: -this.Wb / 2, y: H / 2 },
      ];
      this.Vmax = polyArea(clipBelow(this.poly, 0, -1, H / 2 - H * 0.16));
      this.V = clamp(fillFrac, 0, 1) * this.Vmax;

      if (!this.dragging) {
        this.pos.x = this.home.x;
        this.pos.y = this.home.y;
        this.vel.x = this.vel.y = 0;
        this.theta = this.omega = 0;
      }
      this.particles.length = 0;
      this.streamCount = 0;
      this._solveSurface(0);
      this._placeHint();
      this._updateHit(true);
      if (first) this._render();
    }

    _placeHint() {
      if (!this.hint) return;
      const right = this.home.x + this.Wt / 2 + this.H * 0.5;
      if (this.w - right > 250) {
        this.hint.style.transform = `translate(${right}px, ${this.home.y - this.H * 0.55}px)`;
      } else {
        this.hint.style.transform = `translate(${this.home.x - this.Wt * 0.6}px, ${this.home.y - this.H * 1.05}px)`;
      }
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.lastT = performance.now();
      requestAnimationFrame(this._loop);
    }

    /* Intro: the glass drops onto its saucer */
    dropIn() {
      if (this.dragging) return;
      this.pos.y = -this.H * 1.5;
      this.vel.x = this.vel.y = 0;
      this.prevVel.x = this.prevVel.y = 0;
      this.acc.x = this.acc.y = 0;
      this.theta = -0.2;
      this.omega = 0;
      this.refillDelay = 1.2;
    }

    /* Keyboard / programmatic tip-over */
    tip() {
      this._interacted();
      this.autoTip = 1.6;
      this.refilling = false;
      this._emit("cup:grab");
      setTimeout(() => this._emit("cup:release"), 1600);
    }

    _emit(name, detail) {
      this.stage.dispatchEvent(new CustomEvent(name, { detail }));
    }

    _interacted() {
      if (this.hasInteracted) return;
      this.hasInteracted = true;
      if (this.hint) this.hint.classList.add("is-hidden");
    }

    /* ---------------------------------------------- input */
    _toStage(e) {
      const r = this.stage.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    _onDown(e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      try { this.hit.setPointerCapture(e.pointerId); } catch (_) {}
      const p = this._toStage(e);
      this.dragging = true;
      this.autoTip = 0;
      this.refilling = false;
      this.pointer = p;
      this.downPointer = { x: p.x, y: p.y };
      this.lastPointer = { x: p.x, y: p.y };
      this.lastPointerT = performance.now();
      this.downT = this.lastPointerT;
      this.moved = 0;
      this.grabOff = { x: this.pos.x - p.x, y: this.pos.y - p.y };
      this.thetaBase = this.theta;
      this.pVel.x = this.pVel.y = 0;
      this._kick(rand(-this.Wt * 0.3, this.Wt * 0.3), this.H * 0.4);
      this._interacted();
      this._emit("cup:grab");
    }

    _onMove(e) {
      if (!this.dragging) return;
      const p = this._toStage(e);
      const now = performance.now();
      const dt = Math.max(4, now - this.lastPointerT) / 1000;
      const k = 0.35;
      this.pVel.x = lerp(this.pVel.x, (p.x - this.lastPointer.x) / dt, k);
      this.pVel.y = lerp(this.pVel.y, (p.y - this.lastPointer.y) / dt, k);
      this.moved += Math.hypot(p.x - this.lastPointer.x, p.y - this.lastPointer.y);
      this.lastPointer = p;
      this.lastPointerT = now;
      this.pointer = p;
    }

    _onUp() {
      if (!this.dragging) return;
      this.dragging = false;
      this.refillDelay = 0.9;
      // a quick click without a pull -> playful wobble
      if (this.moved < 6 && performance.now() - this.downT < 350) {
        this.omega += rand(-1, 1) > 0 ? 4.5 : -4.5;
        this.vel.y -= this.H * 4;
        for (let i = 0; i < 4; i++) this._kick(rand(-this.Wt / 2, this.Wt / 2), rand(-1, 1) * this.H * 0.9);
      }
      this._emit("cup:release");
    }

    /* ---------------------------------------------- loop */
    _loop(now) {
      if (!this.visible || document.hidden) {
        this.running = false;
        return;
      }
      let frame = (now - this.lastT) / 1000;
      this.lastT = now;
      frame = Math.min(frame, 1 / 20);
      const STEP = 1 / 120;
      this.acc_t += frame;
      let n = 0;
      while (this.acc_t >= STEP && n < 8) {
        this._step(STEP);
        this.acc_t -= STEP;
        n++;
      }
      this._render();
      requestAnimationFrame(this._loop);
    }

    _step(dt) {
      const H = this.H;
      this.time += dt;
      const holding = this.dragging || this.autoTip > 0;

      /* --- cup rigid body (critically-ish damped springs) --- */
      let tx, ty, k, c, thT, kt, ct;
      if (this.dragging) {
        this.pVel.x *= Math.exp(-dt * 6);
        this.pVel.y *= Math.exp(-dt * 6);
        tx = clamp(this.pointer.x + this.grabOff.x, H * 0.55, this.w - H * 0.55);
        ty = clamp(this.pointer.y + this.grabOff.y, H * 0.7, this.home.y);
        k = 420; c = 34;
        const pull = this.pointer.x - this.downPointer.x;
        thT = clamp(this.thetaBase + pull / (H * 0.8) + clamp(this.pVel.x * 0.00032, -0.55, 0.55), -2.45, 2.45);
        kt = 170; ct = 19;
      } else if (this.autoTip > 0) {
        this.autoTip -= dt;
        tx = this.home.x - H * 0.3;
        ty = this.home.y - H * 0.6;
        k = 150; c = 20;
        thT = -2.15; kt = 55; ct = 11;
        if (this.autoTip <= 0) this.refillDelay = 0.9;
      } else {
        tx = this.home.x; ty = this.home.y;
        k = 115; c = 13;
        thT = 0; kt = 125; ct = 11.5;
      }

      this.vel.x += (k * (tx - this.pos.x) - c * this.vel.x) * dt;
      this.vel.y += (k * (ty - this.pos.y) - c * this.vel.y) * dt;
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;

      // land on the saucer with a little bounce
      if (!holding && this.pos.y > this.home.y) {
        if (this.vel.y > H * 1.2) {
          const s = clamp(this.vel.y / (H * 8), 0, 1);
          for (let i = 0; i < 3; i++) this._kick(rand(-this.Wt / 2, this.Wt / 2), -s * H * 1.2);
          this.omega += rand(-1, 1) * s * 2;
        }
        this.pos.y = this.home.y;
        if (this.vel.y > 0) this.vel.y *= -0.25;
      }

      this.omega += (kt * (thT - this.theta) - ct * this.omega) * dt;
      this.theta += this.omega * dt;

      /* --- acceleration -> effective gravity -> slosh --- */
      const rax = (this.vel.x - this.prevVel.x) / dt;
      const ray = (this.vel.y - this.prevVel.y) / dt;
      this.prevVel.x = this.vel.x;
      this.prevVel.y = this.vel.y;
      const sm = 1 - Math.exp(-dt * 18);
      this.acc.x = lerp(this.acc.x, rax, sm);
      this.acc.y = lerp(this.acc.y, ray, sm);
      const am = Math.hypot(this.acc.x, this.acc.y);
      const amax = this.g * 2.2;
      if (am > amax) { this.acc.x *= amax / am; this.acc.y *= amax / am; }

      const gy = Math.max(this.g * 0.3, this.g - this.acc.y);
      const alphaT = Math.atan2(this.acc.x, gy);
      this.alphaV += (110 * (alphaT - this.alpha) - 5 * this.alphaV) * dt;
      this.alpha = clamp(this.alpha + this.alphaV * dt, -1.25, 1.25);

      // surface chatter while being shaken
      if (holding && Math.random() < 0.25) {
        this._kick(rand(-this.Wt / 2, this.Wt / 2), rand(-1, 1) * Math.min(H, (am / this.g) * H * 0.35));
      }

      /* --- volume / spill --- */
      this._solveSurface(dt);

      /* --- refill --- */
      const atRest = !holding &&
        Math.abs(this.pos.x - this.home.x) < 3 && Math.abs(this.pos.y - this.home.y) < 3 &&
        Math.abs(this.theta) < 0.03 && Math.hypot(this.vel.x, this.vel.y) < H * 0.15;

      if (holding) {
        this.refilling = false;
        this.refillDelay = 0.9;
      } else if (!this.refilling && this.V < this.Vmax * 0.97 && atRest) {
        this.refillDelay -= dt;
        if (this.refillDelay <= 0) this.refilling = true;
      }

      if (this.refilling) {
        this.kettle = Math.min(1, this.kettle + dt * 1.5);
        if (this.kettle >= 1) {
          const inflight = this.streamCount * this.vp;
          if (this.V + inflight < this.Vmax) {
            this.pourAcc += (this.Vmax / 2.3) * dt;
            while (this.pourAcc >= this.vp) {
              this.pourAcc -= this.vp;
              this._emitStream();
            }
          } else if (this.streamCount === 0) {
            this.refilling = false;
            this.pourAcc = 0;
          }
        }
      } else {
        this.kettle = Math.max(0, this.kettle - dt * 1.4);
      }

      /* --- steam when full & resting --- */
      const steamT = atRest && !this.refilling && this.V > this.Vmax * 0.6 ? 1 : 0;
      this.steam = lerp(this.steam, steamT, 1 - Math.exp(-dt * (steamT ? 0.9 : 4)));

      this._updateWaves(dt);
      this._updateParticles(dt);
    }

    /* Find the surface line enclosing volume V; spill whatever does not fit. */
    _solveSurface(dt) {
      const poly = this.poly;
      const rel = this.alpha - this.theta;
      const ux = Math.sin(rel), uy = -Math.cos(rel);
      const L = poly[0], R = poly[1];
      const dL = ux * L.x + uy * L.y;
      const dR = ux * R.x + uy * R.y;
      const lowLeft = dL < dR;
      const dLip = lowLeft ? dL : dR;
      const cap = polyArea(clipBelow(poly, ux, uy, dLip));
      let d;

      if (this.V > cap && dt > 0) {
        const excess = this.V - cap;
        let amt = Math.max(excess * (1 - Math.exp(-dt * 7)), this.vp * dt * 4);
        amt = Math.min(amt, excess, this.vp * 6);
        this.V = Math.max(0, this.V - amt);
        this.spillAcc += amt;
        this.spilledTotal += amt;
        while (this.spillAcc >= this.vp) {
          this.spillAcc -= this.vp;
          this._emitSpill(lowLeft, excess);
        }
        d = dLip;
      } else {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < 4; i++) {
          const v = ux * poly[i].x + uy * poly[i].y;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        for (let i = 0; i < 22; i++) {
          const mid = (lo + hi) * 0.5;
          if (polyArea(clipBelow(poly, ux, uy, mid)) < this.V) lo = mid;
          else hi = mid;
        }
        d = Math.min((lo + hi) * 0.5, dLip);
      }
      this.surf.ux = ux;
      this.surf.uy = uy;
      this.surf.d = d;
    }

    _toWorld(lx, ly) {
      const c = Math.cos(this.theta), s = Math.sin(this.theta);
      return { x: this.pos.x + lx * c - ly * s, y: this.pos.y + lx * s + ly * c };
    }

    _emitSpill(lowLeft, excess) {
      if (this.particles.length > 1400) this._cull();
      const side = lowLeft ? -1 : 1;
      const corner = lowLeft ? this.poly[0] : this.poly[1];
      const lx = corner.x + side * (this.t * 0.9 + this.r * 0.5) + rand(-0.4, 0.4) * this.r;
      const ly = corner.y + rand(-0.6, 0.6) * this.r;
      const wp = this._toWorld(lx, ly);
      const rx = wp.x - this.pos.x, ry = wp.y - this.pos.y;
      // rigid-body velocity of the rim point
      let vx = this.vel.x - this.omega * ry;
      let vy = this.vel.y + this.omega * rx;
      // flow out over the lip
      const c = Math.cos(this.theta), s = Math.sin(this.theta);
      const fx = side, fy = -0.2;
      const sp = this.H * 0.25 + Math.min(this.H * 1.1, Math.sqrt(excess) * 2.4);
      vx += (fx * c - fy * s) * sp + rand(-1, 1) * this.H * 0.08;
      vy += (fx * s + fy * c) * sp + rand(-1, 1) * this.H * 0.08;
      const vm = Math.hypot(vx, vy), vlim = this.H * 6;
      if (vm > vlim) { vx *= vlim / vm; vy *= vlim / vm; }
      this.particles.push({ x: wp.x, y: wp.y, vx, vy, r: this.r * rand(0.8, 1.2), age: 0, life: 1, floor: false, stream: false, drop: false, fy: 0 });
    }

    _kettleTip() {
      return { x: this.home.x - (this.mobile ? 1 : -1) * this.Wt * 0.04, y: this.home.y - this.H * 1.08 };
    }

    _emitStream() {
      const tip = this._kettleTip();
      this.particles.push({
        x: tip.x + rand(-1, 1) * this.r * 0.25,
        y: tip.y + this.r,
        vx: rand(-1, 1) * this.H * 0.02,
        vy: this.H * 0.6 + rand(0, this.H * 0.1),
        r: this.r * rand(0.8, 1.0),
        age: 0, life: 1, floor: false, stream: true, drop: false, fy: 0,
      });
      this.streamCount++;
    }

    _cull() {
      // retire the oldest puddle particles first
      let n = 0;
      for (const p of this.particles) {
        if (p.floor && p.life > 0.2) { p.life = 0.2; if (++n > 60) break; }
      }
    }

    _updateParticles(dt) {
      const ps = this.particles;
      const H = this.H;
      const c = Math.cos(this.theta), s = Math.sin(this.theta);
      const hw0 = this.Wt / 2, hw1 = this.Wb / 2;
      const { ux, uy, d } = this.surf;
      const sc = this.saucer;
      const sL = sc.x - sc.w / 2, sR = sc.x + sc.w / 2;
      let stream = 0;
      let floorList = null;

      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i];
        p.age += dt;

        if (!p.floor) {
          const px0 = p.x, py0 = p.y;
          p.vy += this.g * dt;
          p.vx *= 1 - 0.12 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;

          // absorbed by the liquid in the cup?
          if (!p.drop && p.age > (p.stream ? 0 : 0.28)) {
            const dx = p.x - this.pos.x, dy = p.y - this.pos.y;
            const lx = dx * c + dy * s, ly = -dx * s + dy * c;
            if (ly > -H / 2 && ly < H / 2) {
              const hw = lerp(hw0, hw1, (ly + H / 2) / H);
              if (Math.abs(lx) < hw && ux * lx + uy * ly <= d + p.r * 0.6) {
                this.V += this.vp;
                this._kick(lx * -uy + ly * ux, -Math.min(H * 1.4, p.vy * 0.12));
                ps.splice(i, 1);
                continue;
              }
            }
          }

          // floor / saucer collisions
          let fy = this.floorY;
          const bottom = p.r * 0.35;
          if (p.x > sL && p.x < sR) {
            if (py0 + bottom <= sc.top + 1) fy = sc.top;
            else if (px0 <= sL || px0 >= sR) { p.x = px0; p.vx *= -0.3; }
          }
          if (p.y + bottom >= fy) {
            p.y = fy - bottom;
            if (p.vy > H * 2.2 && !p.drop && Math.random() < 0.5) this._splash(p);
            if (p.vy > 0) p.vy *= -0.12;
            p.vx *= 0.5;
            if (Math.abs(p.vy) < H * 0.4 || p.drop) {
              p.floor = true;
              p.fy = fy;
              p.vy = 0;
            }
          }
          if (p.stream) stream++;
          if (p.x < -200 || p.x > this.w + 200 || p.y > this.h + 200) { ps.splice(i, 1); continue; }
        } else {
          // sliding puddle
          if (p.stream) { p.stream = false; } // it missed — just a puddle now
          if (p.fy === sc.top) {
            p.vx += Math.sign(p.x - sc.x || 1) * H * 0.7 * dt; // saucer drains off its rim
            if (p.x < sL || p.x > sR) { p.floor = false; p.fy = 0; }
          }
          p.vx *= Math.exp(-dt * 4);
          p.x += p.vx * dt;
          p.life -= dt * (p.drop ? 0.9 : 0.17);
          const rr = p.r * Math.sqrt(Math.max(p.life, 0));
          if (p.floor) p.y = p.fy - rr * 0.35;
          if (p.life <= 0) { ps.splice(i, 1); continue; }
          if (!floorList) floorList = [];
          floorList.push(p);
        }
      }
      this.streamCount = stream;

      // spread puddles sideways (1D relaxation along the floor)
      if (floorList && floorList.length > 1) {
        floorList.sort((a, b) => a.x - b.x);
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 1; i < floorList.length; i++) {
            const a = floorList[i - 1], b = floorList[i];
            if (a.fy !== b.fy) continue;
            const min = (a.r + b.r) * 0.34;
            const gap = b.x - a.x;
            if (gap < min) {
              const m = (min - gap) * 0.25;
              a.x -= m; b.x += m;
              a.vx -= m * 2; b.vx += m * 2;
            }
          }
        }
      }
    }

    _splash(p) {
      const n = 1 + (Math.random() * 2) | 0;
      for (let k = 0; k < n; k++) {
        this.particles.push({
          x: p.x, y: p.y - p.r,
          vx: p.vx * 0.4 + rand(-1, 1) * this.H * 1.4,
          vy: -rand(0.6, 1.5) * this.H * 1.2,
          r: p.r * rand(0.35, 0.55), age: 0, life: 1, floor: false, stream: false, drop: true, fy: 0,
        });
      }
    }

    /* ---------------------------------------------- surface ripples */
    _kick(s, amount) {
      const N = this.waveN;
      const f = clamp((s / (this.Wt * 1.1) + 0.5) * (N - 1), 0, N - 1);
      const i = Math.round(f);
      this.waveV[i] += amount;
      if (i > 0) this.waveV[i - 1] += amount * 0.5;
      if (i < N - 1) this.waveV[i + 1] += amount * 0.5;
    }

    _updateWaves(dt) {
      const N = this.waveN, h = this.waveH, v = this.waveV, a = this.waveA;
      const lim = this.H * 0.06;
      for (let i = 0; i < N; i++) {
        v[i] += (-160 * h[i] - 3.4 * v[i]) * dt;
      }
      for (let i = 0; i < N; i++) {
        const l = i > 0 ? h[i - 1] : h[i];
        const r = i < N - 1 ? h[i + 1] : h[i];
        a[i] = l + r - 2 * h[i];
      }
      for (let i = 0; i < N; i++) {
        v[i] += a[i] * 2200 * dt;
        h[i] = clamp(h[i] + v[i] * dt, -lim, lim);
      }
    }

    _waveAt(s) {
      const N = this.waveN;
      const f = clamp((s / (this.Wt * 1.1) + 0.5) * (N - 1), 0, N - 1);
      const i = Math.floor(f), j = Math.min(N - 1, i + 1);
      return lerp(this.waveH[i], this.waveH[j], f - i);
    }

    /* ---------------------------------------------- hit area follows the cup */
    _updateHit(force) {
      const H = this.H, t = this.t;
      const c = Math.cos(this.theta), s = Math.sin(this.theta);
      const xs = [-this.Wt / 2 - t, this.Wt / 2 + t + H * 0.42];
      const ys = [-H / 2, H / 2 + this.base];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const lx of xs) for (const ly of ys) {
        const x = this.pos.x + lx * c - ly * s;
        const y = this.pos.y + lx * s + ly * c;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const pad = 12;
      const b = this._hitBox;
      const nx = minX - pad, ny = minY - pad, nw = maxX - minX + pad * 2, nh = maxY - minY + pad * 2;
      if (force || Math.abs(nx - b.x) > 0.5 || Math.abs(ny - b.y) > 0.5) {
        this.hit.style.transform = `translate(${nx.toFixed(1)}px, ${ny.toFixed(1)}px)`;
        b.x = nx; b.y = ny;
      }
      if (force || Math.abs(nw - b.w) > 2 || Math.abs(nh - b.h) > 2) {
        this.hit.style.width = nw.toFixed(1) + "px";
        this.hit.style.height = nh.toFixed(1) + "px";
        b.w = nw; b.h = nh;
      }
    }

    /* ---------------------------------------------- rendering */
    _render() {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);

      // table line
      ctx.strokeStyle = COLORS.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(this.floorY) + 0.5);
      ctx.lineTo(this.w, Math.round(this.floorY) + 0.5);
      ctx.stroke();

      this._drawSaucer(ctx);
      this._drawCupShadow(ctx);
      this._drawSteam(ctx);
      this._drawCup(ctx);
      this._drawKettle(ctx);
      this._renderFx();

      if (!this.dragging) this._updateHit(false);

      const cups = this.Vmax ? this.spilledTotal / this.Vmax : 0;
      const shown = Math.floor(cups * 100);
      if (shown !== this._lastSpillShown) {
        this._lastSpillShown = shown;
        this._emit("cup:spill", { cups });
      }
    }

    _drawSaucer(ctx) {
      const sc = this.saucer;
      const cx = sc.x, top = sc.top, fy = this.floorY;
      const rx = sc.w / 2, ry = sc.h * 0.42;

      // shadow on table
      ctx.fillStyle = "rgba(40,22,10,0.10)";
      ctx.beginPath();
      ctx.ellipse(cx, fy, rx * 0.9, ry * 0.55, 0, 0, TAU);
      ctx.fill();

      // body / side profile
      const g = ctx.createLinearGradient(0, top, 0, fy);
      g.addColorStop(0, "#fbf6ee");
      g.addColorStop(1, "#d9ccb8");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(cx - rx, top + ry);
      ctx.bezierCurveTo(cx - rx * 0.92, fy - sc.h * 0.12, cx - rx * 0.6, fy, cx - rx * 0.45, fy);
      ctx.lineTo(cx + rx * 0.45, fy);
      ctx.bezierCurveTo(cx + rx * 0.6, fy, cx + rx * 0.92, fy - sc.h * 0.12, cx + rx, top + ry);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = COLORS.inkSoft;
      ctx.stroke();

      // top face
      ctx.fillStyle = "#f6efe4";
      ctx.beginPath();
      ctx.ellipse(cx, top + ry, rx, ry, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "rgba(23,17,12,0.22)";
      ctx.stroke();
      // well
      ctx.strokeStyle = "rgba(23,17,12,0.10)";
      ctx.beginPath();
      ctx.ellipse(cx, top + ry * 1.05, rx * 0.55, ry * 0.5, 0, 0, TAU);
      ctx.stroke();
    }

    _drawCupShadow(ctx) {
      const lift = clamp((this.home.y - this.pos.y) / (this.H * 2.2), 0, 1);
      const onSaucer = Math.abs(this.pos.x - this.saucer.x) < this.saucer.w / 2;
      const y = onSaucer ? this.saucer.top + this.saucer.h * 0.42 : this.floorY;
      ctx.fillStyle = `rgba(40,22,10,${(0.2 * (1 - lift * 0.75)).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(this.pos.x, y, (this.Wb / 2 + this.t) * (1 + lift * 0.6), this.saucer.h * 0.28 * (1 + lift), 0, 0, TAU);
      ctx.fill();
    }

    _drawSteam(ctx) {
      if (this.steam < 0.02) return;
      const H = this.H;
      const y0 = this.pos.y - H / 2 - H * 0.04;
      const len = H * 0.85;
      const g = ctx.createLinearGradient(0, y0, 0, y0 - len);
      g.addColorStop(0, "rgba(110,85,65,0)");
      g.addColorStop(0.35, `rgba(110,85,65,${(0.16 * this.steam).toFixed(3)})`);
      g.addColorStop(1, "rgba(110,85,65,0)");
      ctx.strokeStyle = g;
      ctx.lineCap = "round";
      ctx.lineWidth = H * 0.045;
      for (let k = 0; k < 3; k++) {
        const bx = this.pos.x + (k - 1) * this.Wt * 0.22;
        const ph = k * 2.1;
        ctx.beginPath();
        for (let j = 0; j <= 24; j++) {
          const p = j / 24;
          const y = y0 - p * len * (0.75 + 0.25 * Math.sin(this.time * 0.8 + ph));
          const x = bx + Math.sin(p * 5.5 - this.time * 1.8 + ph) * H * 0.06 * p + Math.sin(this.time * 0.6 + ph) * H * 0.03 * p;
          if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
    }

    _outerPath(ctx) {
      const { H, Wt, Wb, t, base } = this;
      const top = -H / 2, bot = H / 2 + base;
      const rr = t * 1.6;
      const bl = -Wb / 2 - t * 0.9, br = Wb / 2 + t * 0.9;
      ctx.moveTo(-Wt / 2 - t, top);
      ctx.lineTo(bl, bot - rr);
      ctx.quadraticCurveTo(bl + rr * 0.15, bot, bl + rr, bot);
      ctx.lineTo(br - rr, bot);
      ctx.quadraticCurveTo(br - rr * 0.15, bot, br, bot - rr);
      ctx.lineTo(Wt / 2 + t, top);
      ctx.closePath();
    }

    _innerPath(ctx) {
      const p = this.poly;
      ctx.moveTo(p[0].x, p[0].y);
      ctx.lineTo(p[1].x, p[1].y);
      ctx.lineTo(p[2].x, p[2].y);
      ctx.lineTo(p[3].x, p[3].y);
      ctx.closePath();
    }

    _drawCup(ctx) {
      const { H, Wt, Wb, t, base } = this;
      const top = -H / 2, bot = H / 2;

      ctx.save();
      ctx.translate(this.pos.x, this.pos.y);
      ctx.rotate(this.theta);

      /* handle (behind the walls) */
      const outerX = (y) => lerp(Wt / 2 + t, Wb / 2 + t * 0.9, (y - top) / (H + base));
      const y1 = top + H * 0.16, y2 = top + H * 0.74;
      const x1 = outerX(y1) - t * 0.5, x2 = outerX(y2) - t * 0.5;
      const hp = new Path2D();
      hp.moveTo(x1, y1);
      hp.bezierCurveTo(x1 + H * 0.46, y1 - H * 0.06, x2 + H * 0.46, y2 + H * 0.02, x2, y2);
      ctx.lineCap = "round";
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = H * 0.085;
      ctx.stroke(hp);
      ctx.strokeStyle = "rgba(250,246,240,0.9)";
      ctx.lineWidth = H * 0.085 - 2.5;
      ctx.stroke(hp);
      ctx.strokeStyle = "rgba(255,255,255,1)";
      ctx.lineWidth = H * 0.016;
      ctx.stroke(hp);

      /* glass tint */
      ctx.beginPath();
      this._outerPath(ctx);
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.fill();

      /* liquid */
      if (this.V > 1) {
        ctx.save();
        ctx.beginPath();
        this._innerPath(ctx);
        ctx.clip();

        const { ux, uy, d } = this.surf;
        const tx = -uy, ty = ux;
        const cx = ux * d, cy = uy * d;
        const S = H * 1.25;
        const M = 36;
        const surf = new Path2D();
        ctx.beginPath();
        for (let i = 0; i <= M; i++) {
          const sv = -S + (2 * S * i) / M;
          const off = this._waveAt(sv);
          const x = cx + tx * sv + ux * off;
          const y = cy + ty * sv + uy * off;
          if (i) { ctx.lineTo(x, y); surf.lineTo(x, y); } else { ctx.moveTo(x, y); surf.moveTo(x, y); }
        }
        ctx.lineTo(cx + tx * S - ux * H * 3, cy + ty * S - uy * H * 3);
        ctx.lineTo(cx - tx * S - ux * H * 3, cy - ty * S - uy * H * 3);
        ctx.closePath();

        const g = ctx.createLinearGradient(cx, cy, cx - ux * H, cy - uy * H);
        g.addColorStop(0, "#c08a55");
        g.addColorStop(0.07, "#7a4424");
        g.addColorStop(0.22, "#43200f");
        g.addColorStop(1, "#1a0a04");
        ctx.fillStyle = g;
        ctx.fill();

        // crema line + glint
        ctx.lineJoin = "round";
        ctx.strokeStyle = "rgba(214,168,116,0.95)";
        ctx.lineWidth = Math.max(2, H * 0.022);
        ctx.stroke(surf);
        ctx.strokeStyle = "rgba(255,240,220,0.45)";
        ctx.lineWidth = 1;
        ctx.stroke(surf);

        // depth shading at the walls
        const sg = ctx.createLinearGradient(-Wt / 2, 0, Wt / 2, 0);
        sg.addColorStop(0, "rgba(0,0,0,0.28)");
        sg.addColorStop(0.25, "rgba(0,0,0,0)");
        sg.addColorStop(0.8, "rgba(0,0,0,0)");
        sg.addColorStop(1, "rgba(0,0,0,0.22)");
        ctx.fillStyle = sg;
        ctx.fillRect(-Wt / 2, top, Wt, H);
        ctx.restore();
      }

      /* glass walls + thick base */
      ctx.beginPath();
      this._outerPath(ctx);
      this._innerPath(ctx);
      ctx.fillStyle = "rgba(255,255,255,0.42)";
      ctx.fill("evenodd");

      const bg = ctx.createLinearGradient(0, bot, 0, bot + base);
      bg.addColorStop(0, "rgba(255,255,255,0.15)");
      bg.addColorStop(1, "rgba(255,255,255,0.55)");
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.moveTo(-Wb / 2, bot);
      ctx.lineTo(Wb / 2, bot);
      ctx.lineTo(Wb / 2 + t * 0.5, bot + base * 0.75);
      ctx.lineTo(-Wb / 2 - t * 0.5, bot + base * 0.75);
      ctx.closePath();
      ctx.fill();

      // edges
      ctx.lineJoin = "round";
      ctx.beginPath();
      this._outerPath(ctx);
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 1.25;
      ctx.stroke();
      ctx.beginPath();
      this._innerPath(ctx);
      ctx.strokeStyle = COLORS.inkSoft;
      ctx.lineWidth = 1;
      ctx.stroke();

      // rounded rim
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.strokeStyle = COLORS.ink;
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(sx * (Wt / 2 + t / 2), top, t * 0.62, 0, TAU);
        ctx.fill();
        ctx.stroke();
      }

      // highlights
      const hl = ctx.createLinearGradient(0, top, 0, bot);
      hl.addColorStop(0, "rgba(255,255,255,0)");
      hl.addColorStop(0.2, "rgba(255,255,255,0.7)");
      hl.addColorStop(0.75, "rgba(255,255,255,0.45)");
      hl.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = hl;
      const hx0 = -Wt / 2 + t * 1.4, hx1 = -Wb / 2 + t * 1.4, hw = H * 0.045;
      ctx.beginPath();
      ctx.moveTo(hx0, top + H * 0.08);
      ctx.lineTo(hx0 + hw, top + H * 0.08);
      ctx.lineTo(hx1 + hw * 0.7, bot - H * 0.06);
      ctx.lineTo(hx1, bot - H * 0.06);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.6;
      const rx0 = Wt / 2 - t * 2.4, rx1 = Wb / 2 - t * 2.4;
      ctx.beginPath();
      ctx.moveTo(rx0, top + H * 0.14);
      ctx.lineTo(rx0 + hw * 0.35, top + H * 0.14);
      ctx.lineTo(rx1 + hw * 0.3, bot - H * 0.22);
      ctx.lineTo(rx1, bot - H * 0.22);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;

      // printed logo
      ctx.fillStyle = COLORS.ember;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `600 ${Math.round(H * 0.08)}px "Inter Tight", system-ui, sans-serif`;
      ctx.fillText("EMBER", 0, H * 0.06);
      ctx.font = `italic ${Math.round(H * 0.07)}px "Instrument Serif", Georgia, serif`;
      ctx.fillText("coffee house", 0, H * 0.06 + H * 0.085);

      ctx.restore();
    }

    _drawKettle(ctx) {
      if (this.kettle <= 0.001) return;
      const H = this.H;
      const e = easeOutCubic(this.kettle);
      const tip = this._kettleTip();
      const dir = this.mobile ? 1 : -1; // desktop: enter from the empty left side
      const ox = dir * (1 - e) * H * 2.2, oy = -(1 - e) * H * 2.2;
      const pour = easeInOutCubic(clamp((this.kettle - 0.6) / 0.4, 0, 1));

      ctx.save();
      ctx.translate(tip.x + ox, tip.y + oy);
      ctx.rotate(dir * (-0.12 * pour + 0.25 * (1 - e)));
      ctx.scale(dir * 0.82, 0.82);
      ctx.globalAlpha = clamp(this.kettle * 2, 0, 1);

      // gooseneck spout
      const sp = new Path2D();
      sp.moveTo(0, 0);
      sp.bezierCurveTo(H * 0.06, -H * 0.14, H * 0.12, -H * 0.34, H * 0.36, -H * 0.4);
      sp.bezierCurveTo(H * 0.52, -H * 0.44, H * 0.58, -H * 0.3, H * 0.72, -H * 0.3);
      ctx.lineCap = "round";
      ctx.strokeStyle = "#1d1814";
      ctx.lineWidth = H * 0.05;
      ctx.stroke(sp);
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = H * 0.012;
      ctx.stroke(sp);

      // body
      const bx = H * 0.68, by = -H * 0.62, bw = H * 0.78, bh = H * 0.62;
      const g = ctx.createLinearGradient(bx, by, bx + bw, by);
      g.addColorStop(0, "#2b241f");
      g.addColorStop(0.3, "#4a403a");
      g.addColorStop(0.55, "#1d1814");
      g.addColorStop(1, "#110d0b");
      ctx.fillStyle = g;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, H * 0.12);
      else ctx.rect(bx, by, bw, bh);
      ctx.fill();
      // lid + knob
      ctx.fillStyle = "#1d1814";
      ctx.fillRect(bx + bw * 0.15, by - H * 0.04, bw * 0.7, H * 0.05);
      ctx.beginPath();
      ctx.arc(bx + bw / 2, by - H * 0.07, H * 0.04, 0, TAU);
      ctx.fill();
      // handle
      ctx.strokeStyle = "#1d1814";
      ctx.lineWidth = H * 0.05;
      ctx.beginPath();
      ctx.moveTo(bx + bw - H * 0.02, by + H * 0.1);
      ctx.bezierCurveTo(bx + bw + H * 0.28, by + H * 0.05, bx + bw + H * 0.28, by + bh - H * 0.05, bx + bw - H * 0.02, by + bh - H * 0.12);
      ctx.stroke();
      // label band
      ctx.fillStyle = COLORS.ember;
      ctx.fillRect(bx, by + bh * 0.62, bw, H * 0.035);

      ctx.restore();
    }

    _renderFx() {
      const fx = this.fx;
      fx.setTransform(this.fxDpr, 0, 0, this.fxDpr, 0, 0);
      fx.clearRect(0, 0, this.w, this.h);
      const ps = this.particles;
      if (!ps.length) return;

      // keep liquid above the table and the saucer face
      const sc = this.saucer;
      fx.save();
      fx.beginPath();
      fx.rect(0, 0, this.w, this.floorY + 1);
      fx.rect(sc.x - sc.w / 2, sc.top + 1, sc.w, this.floorY - sc.top);
      fx.clip("evenodd");

      fx.fillStyle = COLORS.particle;
      fx.beginPath();
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        const rr = p.floor ? p.r * (0.6 + 0.6 * Math.sqrt(Math.max(p.life, 0))) : p.r;
        fx.moveTo(p.x + rr, p.y);
        fx.arc(p.x, p.y, rr, 0, TAU);
      }
      fx.fill();
      fx.restore();
    }
  }

  window.CoffeeCup = CoffeeCup;
})();

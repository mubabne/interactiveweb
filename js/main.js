/* =========================================================
   Ember — page choreography
   Smooth scroll (Lenis) + GSAP ScrollTrigger + small UI toys
   ========================================================= */
(function () {
  "use strict";

  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;

  gsap.registerPlugin(ScrollTrigger);

  /* ---------------------------------------------- smooth scroll */
  const lenis = new Lenis({
    lerp: reduceMotion ? 1 : 0.085,
    smoothWheel: !reduceMotion,
    wheelMultiplier: 1,
  });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
  lenis.stop();

  // anchor links
  $$("[data-scroll-to]").forEach((a) => {
    a.addEventListener("click", (e) => {
      const href = a.getAttribute("href");
      if (!href || !href.startsWith("#")) return;
      e.preventDefault();
      const target = href === "#top" ? 0 : $(href);
      lenis.scrollTo(target, { duration: 1.6, easing: (t) => 1 - Math.pow(1 - t, 4) });
    });
  });

  // header hides on the way down, returns on the way up
  const header = $(".header");
  lenis.on("scroll", ({ scroll, direction }) => {
    header.classList.toggle("is-hidden", direction === 1 && scroll > 240);
  });

  /* ---------------------------------------------- split helpers */
  function splitWords(el) {
    const inners = [];
    const frag = document.createDocumentFragment();
    const make = (content) => {
      const outer = document.createElement("span");
      outer.className = "word";
      const inner = document.createElement("span");
      inner.className = "word__inner";
      if (typeof content === "string") inner.textContent = content;
      else inner.appendChild(content);
      outer.appendChild(inner);
      inners.push(inner);
      return outer;
    };
    Array.from(el.childNodes).forEach((node) => {
      if (node.nodeType === 3) {
        node.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) frag.appendChild(document.createTextNode(" "));
          else frag.appendChild(make(part));
        });
      } else {
        frag.appendChild(make(node.cloneNode(true)));
      }
    });
    el.innerHTML = "";
    el.appendChild(frag);
    return inners;
  }

  function wrapWordsForScrub(el) {
    const words = el.textContent.trim().split(/\s+/);
    el.innerHTML = words.map((w) => `<span class="w">${w}</span>`).join(" ");
    return $$(".w", el);
  }

  /* ---------------------------------------------- the cup */
  const stage = $(".cup-stage");
  const cup = new window.CoffeeCup({
    stage,
    cupCanvas: $(".cup-stage__cup"),
    fxCanvas: $(".cup-stage__fx"),
    hit: $(".cup-stage__hit"),
    hint: $(".cup-hint"),
    blurNode: $("#goo feGaussianBlur"),
  });
  const spilledEl = $(".js-spilled");
  stage.addEventListener("cup:spill", (e) => {
    spilledEl.textContent = e.detail.cups.toFixed(2);
  });

  /* ---------------------------------------------- custom cursor */
  const cursorEl = $(".cursor");
  if (finePointer) {
    document.body.classList.add("has-cursor");
    const dot = $(".cursor__dot");
    const ring = $(".cursor__ring");
    const label = $(".cursor__label");
    let mx = innerWidth / 2, my = innerHeight / 2, rx = mx, ry = my;
    let shown = false;

    window.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      mx = e.clientX;
      my = e.clientY;
      if (!shown) { shown = true; rx = mx; ry = my; gsap.to(cursorEl, { autoAlpha: 1, duration: 0.3 }); }
    });
    document.addEventListener("mouseleave", () => { shown = false; gsap.to(cursorEl, { autoAlpha: 0, duration: 0.3 }); });

    gsap.ticker.add(() => {
      rx = lerp(rx, mx, 0.18);
      ry = lerp(ry, my, 0.18);
      dot.style.transform = `translate(${mx}px, ${my}px)`;
      ring.style.transform = `translate(${rx}px, ${ry}px)`;
    });

    document.addEventListener("mouseover", (e) => {
      const lab = e.target.closest("[data-cursor]");
      const link = e.target.closest("a, button, .menu__item");
      if (lab) {
        label.textContent = lab.dataset.cursor;
        cursorEl.classList.add("is-label");
        cursorEl.classList.remove("is-hover");
      } else if (link) {
        cursorEl.classList.add("is-hover");
        cursorEl.classList.remove("is-label");
      } else {
        cursorEl.classList.remove("is-label", "is-hover");
      }
    });

    stage.addEventListener("cup:grab", () => cursorEl.classList.add("is-grabbing"));
    stage.addEventListener("cup:release", () => cursorEl.classList.remove("is-grabbing"));
  }

  /* ---------------------------------------------- magnetic elements */
  if (finePointer && !reduceMotion) {
    $$("[data-magnetic]").forEach((el) => {
      const strength = el.classList.contains("visit__cta") ? 0.45 : 0.3;
      el.addEventListener("mousemove", (e) => {
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        gsap.to(el, { x: dx * strength, y: dy * strength, duration: 0.6, ease: "power3.out" });
      });
      el.addEventListener("mouseleave", () => {
        gsap.to(el, { x: 0, y: 0, duration: 1.1, ease: "elastic.out(1, 0.35)" });
      });
    });
  }

  /* ---------------------------------------------- horizontal ritual (create pins first) */
  const mm = gsap.matchMedia();
  mm.add("(min-width: 901px)", () => {
    const section = $(".ritual");
    const track = $(".ritual__track");
    const bar = $(".ritual__progress i");
    const dist = () => Math.max(0, track.scrollWidth - window.innerWidth);

    const tween = gsap.to(track, {
      x: () => -dist(),
      ease: "none",
      scrollTrigger: {
        trigger: section,
        start: "top top",
        end: () => "+=" + dist(),
        pin: true,
        scrub: 1,
        invalidateOnRefresh: true,
        onUpdate: (self) => gsap.set(bar, { scaleX: self.progress }),
      },
    });

    $$(".ritual__card").forEach((card) => {
      const img = $("img", card);
      gsap.fromTo(img, { xPercent: -14 }, {
        xPercent: 0,
        ease: "none",
        scrollTrigger: { trigger: card, containerAnimation: tween, start: "left right", end: "right left", scrub: true },
      });
    });
    gsap.from(".ritual__txt", {
      y: 40, autoAlpha: 0, duration: 1.1, stagger: 0.12, ease: "expo.out",
      scrollTrigger: { trigger: section, start: "top 60%" },
    });
  });

  /* ---------------------------------------------- hero intro + parallax */
  const heroLines = $$(".hero__title .line__inner");
  const heroFade = [".hero__meta", ".hero__lede", ".hero__foot"];
  gsap.set(heroLines, { yPercent: 115 });
  gsap.set(heroFade, { autoAlpha: 0, y: 20 });

  gsap.to(".hero__title", {
    yPercent: -30,
    ease: "none",
    scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
  });
  gsap.to(".hero__lede", {
    yPercent: -60,
    ease: "none",
    scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
  });

  /* ---------------------------------------------- marquee driven by scroll velocity */
  const mTrack = $(".marquee__track");
  const mGroup = $(".marquee__group");
  let mX = 0, mDir = 1, mSkew = 0;
  gsap.ticker.add((time, dt) => {
    const v = lenis.velocity || 0;
    if (Math.abs(v) > 0.1) mDir = v > 0 ? 1 : -1;
    const speed = (reduceMotion ? 0.4 : 1) * (1 + Math.min(Math.abs(v) * 0.35, 14));
    const w = mGroup.offsetWidth || 1;
    mX -= speed * mDir * dt * 0.06;
    if (mX <= -w) mX += w;
    if (mX > 0) mX -= w;
    mSkew = lerp(mSkew, reduceMotion ? 0 : clamp(-v * 0.35, -12, 12), 0.1);
    mTrack.style.transform = `translate3d(${mX}px,0,0) skewX(${mSkew.toFixed(2)}deg)`;
  });

  /* ---------------------------------------------- statement words light up */
  $$(".js-words").forEach((el) => {
    const words = wrapWordsForScrub(el);
    gsap.to(words, {
      opacity: 1,
      stagger: 0.1,
      ease: "none",
      scrollTrigger: { trigger: el, start: "top 80%", end: "bottom 50%", scrub: true },
    });
  });

  /* ---------------------------------------------- split titles rise */
  $$(".js-split").forEach((el) => {
    const inners = splitWords(el);
    gsap.set(inners, { yPercent: 110 });
    ScrollTrigger.create({
      trigger: el,
      start: "top 88%",
      once: true,
      onEnter: () => gsap.to(inners, { yPercent: 0, duration: 1.2, stagger: 0.07, ease: "expo.out" }),
    });
  });

  /* ---------------------------------------------- images: clip reveal + parallax */
  $$(".js-clip").forEach((wrap) => {
    const img = $("img", wrap);
    gsap.set(wrap, { clipPath: "inset(100% 0% 0% 0%)" });
    ScrollTrigger.create({
      trigger: wrap,
      start: "top 88%",
      once: true,
      onEnter: () => {
        gsap.to(wrap, { clipPath: "inset(0% 0% 0% 0%)", duration: 1.5, ease: "expo.inOut" });
        gsap.fromTo(img, { scale: 1.5 }, { scale: 1.15, duration: 1.8, ease: "expo.out" });
      },
    });
    gsap.fromTo(img, { yPercent: -7 }, {
      yPercent: 7,
      ease: "none",
      scrollTrigger: { trigger: wrap, start: "top bottom", end: "bottom top", scrub: true },
    });
  });

  $$("[data-speed]").forEach((el) => {
    const speed = parseFloat(el.dataset.speed) || 0;
    gsap.fromTo(el, { y: () => -speed * window.innerHeight * 0.5 }, {
      y: () => speed * window.innerHeight * 0.5,
      ease: "none",
      scrollTrigger: { trigger: el, start: "top bottom", end: "bottom top", scrub: true, invalidateOnRefresh: true },
    });
  });

  // wide image opens up as it crosses the viewport
  const wide = $(".js-wide");
  gsap.fromTo(wide, { clipPath: "inset(12% 16% 12% 16% round 6px)" }, {
    clipPath: "inset(0% 0% 0% 0% round 6px)",
    ease: "none",
    scrollTrigger: { trigger: wide, start: "top 90%", end: "center 55%", scrub: true },
  });
  gsap.fromTo($("img", wide), { yPercent: -18 }, {
    yPercent: 0,
    ease: "none",
    scrollTrigger: { trigger: wide, start: "top bottom", end: "bottom top", scrub: true },
  });

  /* ---------------------------------------------- menu list: floating image */
  if (finePointer) {
    const reveal = $(".hover-reveal");
    const rInner = $(".hover-reveal__inner");
    const rImg = $("img", reveal);
    let mx = 0, my = 0, x = 0, y = 0, active = false;
    // warm the cache so swaps are instant
    $$(".menu__item").forEach((it) => { const i = new Image(); i.src = it.dataset.img; });

    window.addEventListener("pointermove", (e) => { mx = e.clientX; my = e.clientY; });
    $$(".menu__item").forEach((item) => {
      item.addEventListener("mouseenter", () => {
        if (!active) { x = mx; y = my; }
        active = true;
        rImg.src = item.dataset.img;
        gsap.to(reveal, { autoAlpha: 1, duration: 0.3, overwrite: "auto" });
        gsap.to(rInner, { scale: 1, duration: 0.7, ease: "expo.out", overwrite: "auto" });
        gsap.fromTo(rImg, { scale: 1.45 }, { scale: 1.12, duration: 0.9, ease: "expo.out" });
      });
      item.addEventListener("mouseleave", () => {
        active = false;
        gsap.to(reveal, { autoAlpha: 0, duration: 0.35, overwrite: "auto" });
        gsap.to(rInner, { scale: 0.6, duration: 0.5, ease: "power3.in", overwrite: "auto" });
      });
    });
    gsap.ticker.add(() => {
      x = lerp(x, mx, 0.12);
      y = lerp(y, my, 0.12);
      const rot = clamp((mx - x) * 0.06, -14, 14);
      reveal.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg)`;
    });
  }

  /* ---------------------------------------------- stats count-up */
  $$("[data-count]").forEach((el) => {
    const target = parseFloat(el.dataset.count);
    const suffix = el.dataset.suffix || "";
    const obj = { v: 0 };
    ScrollTrigger.create({
      trigger: el,
      start: "top 85%",
      once: true,
      onEnter: () => gsap.to(obj, {
        v: target, duration: 2.2, ease: "power3.out",
        onUpdate: () => { el.textContent = Math.round(obj.v).toLocaleString("en-US") + suffix; },
      }),
    });
  });

  /* ---------------------------------------------- footer wordmark */
  gsap.from(".footer__brand span", {
    yPercent: 100,
    duration: 1.3,
    stagger: 0.07,
    ease: "expo.out",
    scrollTrigger: { trigger: ".footer", start: "top 80%" },
  });

  /* ---------------------------------------------- theme follows the section in view */
  $$("[data-theme]").forEach((sec) => {
    ScrollTrigger.create({
      trigger: sec,
      start: "top 50%",
      end: "bottom 50%",
      onToggle: (self) => {
        if (self.isActive) document.body.classList.toggle("theme-dark", sec.dataset.theme === "dark");
      },
    });
  });

  /* ---------------------------------------------- loader -> intro */
  function intro() {
    const words = $$(".loader__words span");
    const num = $(".loader__num");
    const counter = { v: 0 };
    const minTime = new Promise((r) => setTimeout(r, reduceMotion ? 300 : 1900));
    const loaded = new Promise((r) => (document.readyState === "complete" ? r() : window.addEventListener("load", r, { once: true })));
    const fonts = document.fonts ? document.fonts.ready : Promise.resolve();

    const tl = gsap.timeline();
    tl.to(counter, {
      v: 100, duration: reduceMotion ? 0.3 : 1.9, ease: "power2.inOut",
      onUpdate: () => { num.textContent = Math.round(counter.v); },
    }, 0);
    tl.to(".loader__bar i", { scaleX: 1, duration: reduceMotion ? 0.3 : 1.9, ease: "power2.inOut" }, 0);
    words.slice(0, -1).forEach((_, i) => {
      tl.to(words, { yPercent: -100 * (i + 1), duration: 0.5, ease: "expo.inOut" }, 0.2 + i * 0.5);
    });

    Promise.all([minTime, Promise.race([loaded, new Promise((r) => setTimeout(r, 5000))]), fonts]).then(() => {
      ScrollTrigger.refresh();
      cup.resize();
      const out = gsap.timeline({
        onComplete: () => {
          $(".loader").remove();
          document.body.classList.remove("is-loading");
          lenis.start();
        },
      });
      out.to(".loader", { yPercent: -100, duration: 1.1, ease: "expo.inOut" }, 0);
      out.to(".loader__count, .loader__words", { y: -80, autoAlpha: 0, duration: 0.6, ease: "power3.in" }, 0);
      out.to(heroLines, { yPercent: 0, duration: 1.3, stagger: 0.09, ease: "expo.out" }, 0.55);
      out.to(heroFade, { autoAlpha: 1, y: 0, duration: 1, stagger: 0.08, ease: "expo.out" }, 0.8);
      out.call(() => cup.dropIn(), null, 0.5);
      out.call(() => $(".cup-hint").classList.add("is-ready"), null, 1.9);
    });
  }
  intro();

  window.addEventListener("load", () => ScrollTrigger.refresh());
})();

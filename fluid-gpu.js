async function startFluid() {
  const {
    Renderer, Program, Mesh, Triangle, Geometry, RenderTarget
  } = await import("https://cdn.jsdelivr.net/npm/ogl@1.0.11/+esm");

  const stage = document.getElementById("fluid-stage");
  const canvas = document.getElementById("fluid-canvas");
  const cursor = document.getElementById("fluid-cursor");

  const COUNT = 120000;
  const PW = 512;
  const PH = Math.ceil(COUNT / PW);
  const PRESSURE_ITERATIONS = 40;

  const renderer = new Renderer({
    canvas,
    webgl: 2,
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    dpr: Math.min(window.devicePixelRatio || 1, 1.5)
  });

  const gl = renderer.gl;

  if (
    !gl ||
    typeof gl.texStorage2D !== "function" ||
    !gl.getExtension("EXT_color_buffer_float")
  ) {
    throw new Error("WebGL2 floating-point render targets unavailable.");
  }

  gl.clearColor(0, 0, 0, 0);

  const U = {
    uVelocity: { value: null },
    uPressure: { value: null },
    uDivergence: { value: null },
    uState: { value: null },

    uBall: { value: new Float32Array([1.35, .8, .11]) },
    uBallVelocity: { value: new Float32Array(2) },

    uDt: { value: 1 / 60 },
    uTime: { value: 0 },
    uInit: { value: 0 },
    uDpr: { value: renderer.dpr },
    uColor: { value: new Float32Array([.09, .09, .09]) }
  };

  const vertex = `#version 300 es
    in vec2 position;

    void main() {
      gl_Position = vec4(position, 0., 1.);
    }
  `;

  /*
   * Campo di velocità su griglia MAC.
   * Ogni texel contiene le due componenti su facce sfalsate.
   * Il dominio include un margine esterno all'area visibile.
   */
  const common = `#version 300 es
    precision highp float;
    precision highp int;
    precision highp sampler2D;

    uniform sampler2D uVelocity, uPressure, uDivergence, uState;
    uniform vec3 uBall;
    uniform vec2 uBallVelocity;
    uniform float uDt, uTime;
    uniform int uInit;

    out vec4 result;

    const ivec2 N = ivec2(162, 96);
    const float h = 1. / 60.;

    vec4 cell(sampler2D t, ivec2 c) {
      return texelFetch(t, clamp(c, ivec2(0), N + 1), 0);
    }

    bool solid(ivec2 c) {
      if (c.x < 1 || c.y < 1 || c.x > N.x || c.y > N.y)
        return false;

      return distance((vec2(c) - .5) * h, uBall.xy) < uBall.z;
    }

    float fluid(ivec2 c) {
      if (c.x < 1 || c.y < 1 || c.y > N.y)
        return 0.;

      return solid(c) ? 0. : 1.;
    }

    vec4 linearSample(sampler2D t, vec2 g) {
      ivec2 c = ivec2(floor(g));
      vec2 a = fract(g);

      return mix(
        mix(cell(t, c), cell(t, c + ivec2(1, 0)), a.x),
        mix(cell(t, c + ivec2(0, 1)),
            cell(t, c + ivec2(1, 1)), a.x),
        a.y
      );
    }

    vec2 velocity(vec2 p) {
      return vec2(
        linearSample(uVelocity, p / h + vec2(1., .5)).r,
        linearSample(uVelocity, p / h + vec2(.5, 1.)).g
      );
    }

    vec2 boundary(vec2 v, ivec2 c) {
      if (c.x <= 1) v.x = .55;
      if (c.x == 0) v.y = 0.;
      if (c.y <= 1 || c.y > N.y) v.y = 0.;
      if (c.y == 0 || c.y > N.y) v.x = .55;

      if (solid(c) || solid(c - ivec2(1, 0)))
        v.x = uBallVelocity.x;

      if (solid(c) || solid(c - ivec2(0, 1)))
        v.y = uBallVelocity.y;

      return v;
    }

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
  `;

  const triangle = new Triangle(gl);

  function program(vs, fs, transparent = false) {
    const p = new Program(gl, {
      vertex: vs,
      fragment: fs,
      uniforms: U,
      depthTest: false,
      depthWrite: false,
      cullFace: false,
      transparent
    });

    if (!gl.getProgramParameter(p.program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p.program));
    }

    return p;
  }

  function pass(body) {
    return new Mesh(gl, {
      geometry: triangle,
      program: program(vertex, common + body)
    });
  }

  function target(width, height) {
    const t = new RenderTarget(gl, {
      width,
      height,
      depth: false,
      stencil: false,
      type: gl.FLOAT,
      format: gl.RGBA,
      internalFormat: gl.RGBA32F,
      minFilter: gl.NEAREST,
      magFilter: gl.NEAREST,
      generateMipmaps: false
    });

    renderer.bindFramebuffer({ buffer: t.buffer });

    const complete =
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) ===
      gl.FRAMEBUFFER_COMPLETE;

    renderer.bindFramebuffer({ buffer: null });

    if (!complete) throw new Error("Incomplete framebuffer.");

    return t;
  }

  function pair(width, height) {
    return {
      read: target(width, height),
      write: target(width, height),

      swap() {
        [this.read, this.write] = [this.write, this.read];
      }
    };
  }

  const vel = pair(164, 98);
  const pressure = pair(164, 98);
  const particles = pair(PW, PH);
  const divergence = target(164, 98);

  const run = (mesh, destination) => renderer.render({
    scene: mesh,
    target: destination,
    clear: false
  });

  const seed = pass(`
    void main() {
      vec2 c = gl_FragCoord.xy;

      if (uInit == 1) {
        result = vec4(.55, 0., 0., 1.);
        return;
      }

      if (uInit == 2) {
        vec2 p = vec2(.3) +
          vec2(2.1, 1.) * vec2(hash(c), hash(c + 19.3));

        if (distance(p, uBall.xy) < uBall.z + .003) {
          p = uBall.xy +
            normalize(p - uBall.xy + vec2(.00001, 0.)) *
            (uBall.z + .003);
        }

        result = vec4(p, hash(c + 43.7), 0.);
        return;
      }

      result = vec4(0.);
    }
  `);

  // Avvezione semi-lagrangiana e viscosità.
  const advect = pass(`
    void main() {
      ivec2 c = ivec2(gl_FragCoord.xy);

      vec2 a = (vec2(c) - vec2(1., .5)) * h;
      vec2 b = (vec2(c) - vec2(.5, 1.)) * h;

      vec2 v = vec2(
        velocity(a - uDt * velocity(a)).x,
        velocity(b - uDt * velocity(b)).y
      );

      vec2 lap =
          cell(uVelocity, c + ivec2(1, 0)).rg
        + cell(uVelocity, c - ivec2(1, 0)).rg
        + cell(uVelocity, c + ivec2(0, 1)).rg
        + cell(uVelocity, c - ivec2(0, 1)).rg
        - 4. * cell(uVelocity, c).rg;

      v += .0004 * uDt / (h * h) * lap;

      if (c.x > N.x)
        v.x = cell(uVelocity, c - ivec2(1, 0)).r;

      result = vec4(boundary(v, c), 0., 1.);
    }
  `);

  const divergencePass = pass(`
    void main() {
      ivec2 c = ivec2(gl_FragCoord.xy);
      vec2 v = cell(uVelocity, c).rg;

      float d = (
        cell(uVelocity, c + ivec2(1, 0)).r - v.x +
        cell(uVelocity, c + ivec2(0, 1)).g - v.y
      ) / h;

      result = vec4(d * fluid(c), 0., 0., 1.);
    }
  `);

  const pressurePass = pass(`
    void main() {
      ivec2 c = ivec2(gl_FragCoord.xy);

      if (
        c.x < 1 || c.y < 1 ||
        c.x > N.x || c.y > N.y || solid(c)
      ) {
        result = vec4(0.);
        return;
      }

      ivec2 l = c - ivec2(1, 0);
      ivec2 r = c + ivec2(1, 0);
      ivec2 b = c - ivec2(0, 1);
      ivec2 t = c + ivec2(0, 1);

      vec4 s = vec4(fluid(l), fluid(r), fluid(b), fluid(t));
      float count = dot(s, vec4(1.));

      vec4 p = vec4(
        cell(uPressure, l).r,
        cell(uPressure, r).r,
        cell(uPressure, b).r,
        cell(uPressure, t).r
      );

      float value = (
        dot(s, p) - h * h * cell(uDivergence, c).r
      ) / max(count, 1.);

      result = vec4(value, 0., 0., 1.);
    }
  `);

  const project = pass(`
    void main() {
      ivec2 c = ivec2(gl_FragCoord.xy);
      vec2 v = cell(uVelocity, c).rg;
      float p = cell(uPressure, c).r;

      if (fluid(c) * fluid(c - ivec2(1, 0)) > 0.)
        v.x -= (p - cell(uPressure, c - ivec2(1, 0)).r) / h;

      if (fluid(c) * fluid(c - ivec2(0, 1)) > 0.)
        v.y -= (p - cell(uPressure, c - ivec2(0, 1)).r) / h;

      result = vec4(boundary(v, c), 0., 1.);
    }
  `);

  // Anche le posizioni delle particelle restano sulla GPU.
  const moveParticles = pass(`
    void main() {
      vec4 s = texelFetch(uState, ivec2(gl_FragCoord.xy), 0);

      vec2 mid = s.xy + .5 * uDt * velocity(s.xy);
      vec2 p = s.xy + uDt * velocity(mid);
      float age = s.w + uDt;

      if (
        p.x < .3 || p.x > 2.4 ||
        p.y < .3 || p.y > 1.3 ||
        age > 15. ||
        distance(p, uBall.xy) < uBall.z + .002 ||
        any(isnan(p))
      ) {
        p = vec2(.301, .3 + hash(gl_FragCoord.xy + uTime));
        age = 0.;
      }

      result = vec4(p, s.z, age);
    }
  `);

  U.uInit.value = 1;
  run(seed, vel.read);
  run(seed, vel.write);

  U.uInit.value = 0;
  run(seed, pressure.read);
  run(seed, pressure.write);

  U.uInit.value = 2;
  run(seed, particles.read);

  // Questo array viene creato una sola volta.
  const ids = Float32Array.from({ length: COUNT }, (_, i) => i);

  const geometry = new Geometry(gl, {
    aIndex: { size: 1, data: ids }
  });

  const pointProgram = program(
    `#version 300 es
    precision highp float;
    precision highp int;
    precision highp sampler2D;

    in float aIndex;

    uniform sampler2D uState;
    uniform float uDpr;

    out vec2 vPosition;
    out float vFade;

    void main() {
      int id = int(aIndex);
      vec4 s = texelFetch(uState, ivec2(id % 512, id / 512), 0);
      vec2 p = (s.xy - vec2(.3)) / vec2(2.1, 1.);

      gl_Position = vec4(p * 2. - 1., 0., 1.);
      gl_PointSize = max(1., uDpr * mix(.65, 1.05, s.z));

      vPosition = s.xy;
      vFade =
        smoothstep(0., .08, min(p.x, 1. - p.x)) *
        smoothstep(0., .12, min(p.y, 1. - p.y));
    }`,

    `#version 300 es
    precision highp float;

    uniform vec3 uColor, uBall;

    in vec2 vPosition;
    in float vFade;

    out vec4 result;

    void main() {
      if (distance(vPosition, uBall.xy) < uBall.z)
        discard;

      float d = length(gl_PointCoord - .5);
      float a = (1. - smoothstep(.15, .5, d)) * .27 * vFade;

      if (a < .001) discard;

      result = vec4(uColor, a);
    }`,
    true
  );

  pointProgram.setBlendFunc(
    gl.SRC_ALPHA,
    gl.ONE_MINUS_SRC_ALPHA,
    gl.ONE,
    gl.ONE_MINUS_SRC_ALPHA
  );

  const points = new Mesh(gl, {
    geometry,
    program: pointProgram,
    mode: gl.POINTS
  });

  const goal = new Float32Array([1.35, .8]);
  const lastBall = new Float32Array(goal);
  const motion = matchMedia("(prefers-reduced-motion: reduce)");

  let dark = false;
  let raf = 0;
  let last = null;
  let visible = true;
  let dead = false;
  let snap = false;

  function draw() {
    U.uState.value = particles.read.texture;
    renderer.render({ scene: points, clear: true });
  }

  function resize() {
    const width = stage.getBoundingClientRect().width;
    if (!width) return;

    renderer.setSize(width, width / 2.1);
    U.uDpr.value = renderer.dpr;
    draw();
  }

  function step(dt) {
    const dx = goal[0] - lastBall[0];
    const dy = goal[1] - lastBall[1];
    const jump = snap || Math.hypot(dx, dy) > .25;

    U.uBallVelocity.value[0] = jump
      ? 0 : Math.max(-2.5, Math.min(2.5, dx / dt));

    U.uBallVelocity.value[1] = jump
      ? 0 : Math.max(-2.5, Math.min(2.5, dy / dt));

    lastBall.set(goal);
    snap = false;

    U.uBall.value[0] = goal[0];
    U.uBall.value[1] = goal[1];
    U.uDt.value = dt;
    U.uTime.value += dt;

    U.uVelocity.value = vel.read.texture;
    run(advect, vel.write);
    vel.swap();

    U.uVelocity.value = vel.read.texture;
    run(divergencePass, divergence);
    U.uDivergence.value = divergence.texture;

    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      U.uPressure.value = pressure.read.texture;
      run(pressurePass, pressure.write);
      pressure.swap();
    }

    U.uPressure.value = pressure.read.texture;
    run(project, vel.write);
    vel.swap();

    U.uVelocity.value = vel.read.texture;
    U.uState.value = particles.read.texture;
    run(moveParticles, particles.write);
    particles.swap();
  }

  function loop(now) {
    raf = 0;

    if (dead || !visible || document.hidden || motion.matches)
      return;

    if (last === null) last = now - 1000 / 60;

    if (now - last >= 1000 / 60 - .5) {
      step(Math.min((now - last) / 1000, 1 / 30));
      last = now;
      draw();
    }

    raf = requestAnimationFrame(loop);
  }

  function sync() {
    cancelAnimationFrame(raf);
    last = null;

    if (!dead && visible && !document.hidden && !motion.matches)
      raf = requestAnimationFrame(loop);
  }

  function aim(x, y, jump = false) {
    const ax = Math.max(0, Math.min(1, x));
    const ay = Math.max(0, Math.min(1, y));

    goal[0] = .3 + 2.1 * ax;
    goal[1] = .3 + 1. - ay;

    U.uBall.value[0] = goal[0];
    U.uBall.value[1] = goal[1];

    cursor.style.left = `${ax * 100}%`;
    cursor.style.top = `${ay * 100}%`;

    snap = snap || jump;

    if (motion.matches) draw();
  }

  function pointer(event, jump = false) {
    const r = stage.getBoundingClientRect();

    if (r.width && r.height) {
      aim(
        (event.clientX - r.left) / r.width,
        (event.clientY - r.top) / r.height,
        jump
      );
    }
  }

  stage.addEventListener("pointerenter", e => pointer(e, true));
  stage.addEventListener("pointermove", e => pointer(e));

  stage.addEventListener("pointerdown", e => {
    if (e.pointerType === "touch")
      stage.setPointerCapture(e.pointerId);

    pointer(e, true);
  });

  const release = e => {
    if (stage.hasPointerCapture(e.pointerId))
      stage.releasePointerCapture(e.pointerId);
  };

  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);

  stage.addEventListener("keydown", e => {
    const direction = {
      ArrowLeft: [-.025, 0],
      ArrowRight: [.025, 0],
      ArrowUp: [0, -.05],
      ArrowDown: [0, .05]
    }[e.key];

    if (!direction) return;

    e.preventDefault();

    aim(
      (goal[0] - .3) / 2.1 + direction[0],
      1. - (goal[1] - .3) + direction[1]
    );
  });

  document.getElementById("theme").addEventListener("click", () => {
    dark = !dark;
    document.documentElement.dataset.dark = String(dark);

    const button = document.getElementById("theme");
    button.firstElementChild.textContent = dark ? "☀︎" : "☾";

    button.setAttribute(
      "aria-label",
      dark ? "Attiva il tema chiaro" : "Attiva il tema scuro"
    );

    U.uColor.value.fill(dark ? .94 : .09);
    draw();
  });

  canvas.addEventListener("webglcontextlost", () => {
    dead = true;
    cancelAnimationFrame(raf);
    stage.style.cursor = "auto";
    cursor.hidden = true;

    const status = document.getElementById("status");
    status.hidden = false;
    status.textContent =
      "Animazione interrotta. Ricarica la pagina per riprovare.";
  });

  document.addEventListener("visibilitychange", sync);
  motion.addEventListener("change", sync);

  new ResizeObserver(resize).observe(stage);

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  }).observe(stage);

  resize();
  step(1 / 60);
  draw();

  cursor.hidden = false;
  stage.style.cursor = "none";
  sync();
}

startFluid().catch(error => {
  console.error(error);

  document.getElementById("fluid-stage").style.cursor = "auto";
  document.getElementById("fluid-cursor").hidden = true;

  const status = document.getElementById("status");
  status.hidden = false;
  status.textContent = "Animazione non disponibile su questo dispositivo.";
});

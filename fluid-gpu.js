async function startFluid() {
  const {
    Renderer, Program, Mesh, Triangle, Geometry, RenderTarget
  } = await import("https://cdn.jsdelivr.net/npm/ogl@1.0.11/+esm");

  const stage = document.getElementById("fluid-stage");
  const canvas = document.getElementById("fluid-canvas");

  /* ---------- parametri regolabili ---------- */
  const COUNT = 512 * 500;          // particelle (multiplo di 512)
  const PW = 512;
  const PH = Math.ceil(COUNT / PW);
  const SWEEPS = 24;            // sweep SOR rosso/nero (= 2 passate ciascuno)
  const OMEGA = 1.7;            // sovra-rilassamento SOR
  const TRAIL = .92;            // decadimento della scia per frame a 60 fps
  const TRAIL_GAIN = .22;       // intensità della scia
  const SMOOTH = 40;            // inseguimento del puntatore (1/s)

  const renderer = new Renderer({
    canvas,
    webgl: 2,
    alpha: true,
    premultipliedAlpha: true,
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
    uVelHat: { value: null },
    uPressure: { value: null },
    uDivergence: { value: null },
    uState: { value: null },
    uPrev: { value: null },
    uTrail: { value: null },

    uBall: { value: new Float32Array([1.35, .8, .11]) },
    uBallVelocity: { value: new Float32Array(2) },

    uDt: { value: 1 / 60 },
    uTime: { value: 0 },
    uInit: { value: 0 },
    uParity: { value: 0 },
    uOmega: { value: OMEGA },
    uPert: { value: 0 },
    uDecay: { value: TRAIL },
    uTrailGain: { value: TRAIL_GAIN },
    uRes: { value: new Float32Array([1, 1]) },
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

    uniform sampler2D uVelocity, uVelHat, uPressure, uDivergence, uState;
    uniform vec3 uBall;
    uniform vec2 uBallVelocity;
    uniform float uDt, uTime, uOmega, uPert;
    uniform int uInit, uParity;

    out vec4 result;

    const ivec2 N = ivec2(162, 96);
    const float h = 1. / 60.;
    const float NU = .0004;      // viscosità cinematica
    const float INFLOW = .55;    // velocità della corrente libera

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

    vec2 velocityOf(sampler2D t, vec2 p) {
      return vec2(
        linearSample(t, p / h + vec2(1., .5)).r,
        linearSample(t, p / h + vec2(.5, 1.)).g
      );
    }

    vec2 velocity(vec2 p) {
      return velocityOf(uVelocity, p);
    }

    // Traiettoria RK2: s = -1 all'indietro, s = +1 in avanti.
    vec2 trace(vec2 p, float s) {
      vec2 mid = p + s * .5 * uDt * velocity(p);
      return p + s * uDt * velocity(mid);
    }

    vec2 boundary(vec2 v, ivec2 c) {
      if (c.x <= 1) v.x = INFLOW;
      if (c.x == 0) v.y = uPert;
      if (c.y <= 1 || c.y > N.y) v.y = 0.;
      if (c.y == 0 || c.y > N.y) v.x = INFLOW;

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

  function program(vs, fs, label, blend = null) {
    const p = new Program(gl, {
      vertex: vs,
      fragment: fs,
      uniforms: U,
      depthTest: false,
      depthWrite: false,
      cullFace: false,
      transparent: !!blend
    });

    p.label = label;

    if (blend) p.setBlendFunc(...blend);

    if (!gl.getProgramParameter(p.program, gl.LINK_STATUS)) {
      throw new Error(label + ": " + gl.getProgramInfoLog(p.program));
    }

    return p;
  }

  function pass(label, body, header = common, blend = null) {
    return new Mesh(gl, {
      geometry: triangle,
      program: program(vertex, header + body, label, blend)
    });
  }

  function target(width, height, half = false) {
    const t = new RenderTarget(gl, {
      width,
      height,
      depth: false,
      stencil: false,
      type: half ? gl.HALF_FLOAT : gl.FLOAT,
      format: gl.RGBA,
      internalFormat: half ? gl.RGBA16F : gl.RGBA32F,
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
  const velHat = target(164, 98);
  const divergence = target(164, 98);

  let trail = target(8, 8, true);

  const run = (mesh, destination) => renderer.render({
    scene: mesh,
    target: destination,
    clear: false
  });

  const seed = pass("seed", `
    void main() {
      vec2 c = gl_FragCoord.xy;

      if (uInit == 1) {
        result = vec4(INFLOW, 0., 0., 1.);
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

  /*
   * Avvezione MacCormack con limitatore: il passo semi-lagrangiano
   * (RK2) smorza i vortici, la correzione a due passi li preserva
   * e il clamp ai valori vicini mantiene lo schema stabile.
   */
  const advectHat = pass("advectHat", `
    void main() {
      ivec2 c = ivec2(gl_FragCoord.xy);

      vec2 a = (vec2(c) - vec2(1., .5)) * h;
      vec2 b = (vec2(c) - vec2(.5, 1.)) * h;

      result = vec4(
        velocity(trace(a, -1.)).x,
        velocity(trace(b, -1.)).y,
        0., 1.
      );
    }
  `);

  const advectFix = pass("advectFix", `
    void main() {
      ivec2 c = ivec2(gl_FragCoord.xy);

      vec2 a = (vec2(c) - vec2(1., .5)) * h;
      vec2 b = (vec2(c) - vec2(.5, 1.)) * h;

      vec2 xa = trace(a, -1.);
      vec2 xb = trace(b, -1.);

      vec2 hat = cell(uVelHat, c).rg;

      vec2 back = vec2(
        velocityOf(uVelHat, trace(a, 1.)).x,
        velocityOf(uVelHat, trace(b, 1.)).y
      );

      vec2 v = hat + .5 * (cell(uVelocity, c).rg - back);

      // Limitatore: il risultato resta nell'intervallo dei vicini.
      ivec2 ia = ivec2(floor(xa / h + vec2(1., .5)));
      ivec2 ib = ivec2(floor(xb / h + vec2(.5, 1.)));

      vec4 a0 = cell(uVelocity, ia);
      vec4 a1 = cell(uVelocity, ia + ivec2(1, 0));
      vec4 a2 = cell(uVelocity, ia + ivec2(0, 1));
      vec4 a3 = cell(uVelocity, ia + ivec2(1, 1));

      vec4 b0 = cell(uVelocity, ib);
      vec4 b1 = cell(uVelocity, ib + ivec2(1, 0));
      vec4 b2 = cell(uVelocity, ib + ivec2(0, 1));
      vec4 b3 = cell(uVelocity, ib + ivec2(1, 1));

      v.x = clamp(
        v.x,
        min(min(a0.r, a1.r), min(a2.r, a3.r)),
        max(max(a0.r, a1.r), max(a2.r, a3.r))
      );

      v.y = clamp(
        v.y,
        min(min(b0.g, b1.g), min(b2.g, b3.g)),
        max(max(b0.g, b1.g), max(b2.g, b3.g))
      );

      // Viscosità.
      vec2 lap =
          cell(uVelocity, c + ivec2(1, 0)).rg
        + cell(uVelocity, c - ivec2(1, 0)).rg
        + cell(uVelocity, c + ivec2(0, 1)).rg
        + cell(uVelocity, c - ivec2(0, 1)).rg
        - 4. * cell(uVelocity, c).rg;

      v += NU * uDt / (h * h) * lap;

      if (c.x > N.x)
        v.x = cell(uVelocity, c - ivec2(1, 0)).r;

      if (any(isnan(v)) || any(isinf(v))) v = vec2(0.);

      result = vec4(boundary(v, c), 0., 1.);
    }
  `);

  const divergencePass = pass("divergence", `
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

  // Pressione: SOR rosso/nero (converge molto più in fretta di Jacobi).
  const pressurePass = pass("pressure", `
    void main() {
      ivec2 c = ivec2(gl_FragCoord.xy);
      float old = cell(uPressure, c).r;

      if (
        c.x < 1 || c.y < 1 ||
        c.x > N.x || c.y > N.y || solid(c)
      ) {
        result = vec4(0., 0., 0., 1.);
        return;
      }

      if (((c.x + c.y) & 1) != uParity) {
        result = vec4(old, 0., 0., 1.);
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

      float gs = (
        dot(s, p) - h * h * cell(uDivergence, c).r
      ) / max(count, 1.);

      result = vec4(mix(old, gs, uOmega), 0., 0., 1.);
    }
  `);

  const project = pass("project", `
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
  const moveParticles = pass("move", `
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
  run(seed, particles.write);

  U.uInit.value = 2;
  run(seed, particles.read);

  /* ---------- rendering ---------- */

  const view = `#version 300 es
    precision highp float;
    precision highp int;
    precision highp sampler2D;

    uniform sampler2D uTrail;
    uniform vec3 uBall, uColor;
    uniform vec2 uRes;
    uniform float uDecay, uTrailGain, uDpr;

    out vec4 result;

    const vec2 ORIGIN = vec2(.3);
    const vec2 SPAN = vec2(2.1, 1.);
  `;

  /*
   * La scia vive in una texture a mezza precisione: a ogni frame si
   * moltiplica per il decadimento (anche dentro al cilindro, così
   * non lascia residui), poi si accumulano i segmenti di ogni particella.
   */
  const fade = pass("fade", `
    void main() {
      vec2 p = ORIGIN + gl_FragCoord.xy / uRes * SPAN;
      float inside =
        step(distance(p, uBall.xy), uBall.z + 2.5 / uRes.y);

      result = vec4(0., 0., 0., inside > .5 ? 0. : uDecay);
    }
  `, view, [gl.ONE, gl.SRC_ALPHA, gl.ZERO, gl.SRC_ALPHA]);

  const ids = Float32Array.from({ length: COUNT * 2 }, (_, i) => i);

  const streaks = new Mesh(gl, {
    geometry: new Geometry(gl, { aIndex: { size: 1, data: ids } }),
    program: program(
      `#version 300 es
      precision highp float;
      precision highp int;
      precision highp sampler2D;

      in float aIndex;

      uniform sampler2D uState, uPrev;

      out float vWeight;

      const vec2 ORIGIN = vec2(.3);
      const vec2 SPAN = vec2(2.1, 1.);

      void main() {
        int v = int(aIndex);
        int id = v >> 1;
        float head = float(v & 1);

        ivec2 t = ivec2(id & 511, id >> 9);
        vec4 s = texelFetch(uState, t, 0);
        vec4 q = texelFetch(uPrev, t, 0);

        // Particella appena rinata: nessun segmento.
        bool jump = s.w < q.w || distance(s.xy, q.xy) > .12;
        vec2 pos = jump ? s.xy : mix(q.xy, s.xy, head);

        gl_Position = vec4((pos - ORIGIN) / SPAN * 2. - 1., 0., 1.);
        gl_PointSize = 1.;
        vWeight = mix(.35, 1., s.z);
      }`,

      `#version 300 es
      precision highp float;

      in float vWeight;
      out vec4 result;

      void main() {
        result = vec4(vWeight, 0., 0., vWeight);
      }`,
      "streaks",
      [gl.ONE, gl.ONE, gl.ONE, gl.ONE]
    ),
    mode: gl.LINES
  });

  /*
   * Composizione: scia + cilindro. Il cilindro è disegnato con lo
   * stesso linguaggio delle particelle: un contorno sottile e un
   * mezzitono di puntini che si infittiscono verso il bordo.
   */
  const composite = pass("composite", `
    void main() {
      vec2 uv = gl_FragCoord.xy / uRes;
      vec2 p = ORIGIN + uv * SPAN;
      float px = 1. / uRes.y;

      float I = texelFetch(uTrail, ivec2(gl_FragCoord.xy), 0).r;

      float edge =
        smoothstep(0., .08, min(uv.x, 1. - uv.x)) *
        smoothstep(0., .12, min(uv.y, 1. - uv.y));

      float trail = (1. - exp(-uTrailGain * I)) * edge;

      float R = uBall.z;
      float d = distance(p, uBall.xy);
      float body = 1. - smoothstep(R - px, R, d);

      trail *= 1. - body;

      float ring = 1. - smoothstep(0., 1.5 * px, abs(d - R + .75 * px));

      vec2 g = gl_FragCoord.xy / uDpr / 5.;
      vec2 q = mat2(.7071, -.7071, .7071, .7071) * g;
      float k = length(fract(q) - .5);
      float w = max(fwidth(k), .02);
      float rad = mix(.1, .34, smoothstep(.1, 1., d / R));
      float dots = (1. - smoothstep(rad - w, rad + w, k)) * body;

      float ball = max(ring * .6, dots * .38);
      float a = trail + ball * (1. - trail);

      result = vec4(uColor * a, a);
    }
  `, view, [gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA]);

  const heads = new Mesh(gl, {
    geometry: new Geometry(gl, {
      aIndex: {
        size: 1,
        data: Float32Array.from({ length: COUNT }, (_, i) => i)
      }
    }),
    program: program(
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
        vec4 s = texelFetch(uState, ivec2(id & 511, id >> 9), 0);
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
        float a = (1. - smoothstep(.15, .5, d)) * .3 * vFade;

        if (a < .001) discard;

        result = vec4(uColor * a, a);
      }`,
      "heads",
      [gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA]
    ),
    mode: gl.POINTS
  });

  /* ---------- stato e ciclo ---------- */

  const goal = new Float32Array([1.35, .8]);
  const ball = new Float32Array(goal);
  const motion = matchMedia("(prefers-reduced-motion: reduce)");

  let dark = false;
  let raf = 0;
  let last = null;
  let visible = true;
  let dead = false;
  let snap = false;

  function draw() {
    U.uTrail.value = trail.texture;
    U.uState.value = particles.read.texture;

    renderer.render({ scene: composite, clear: true });
    renderer.render({ scene: heads, clear: false });
  }

  function resize() {
    const width = stage.getBoundingClientRect().width;
    if (!width) return;

    renderer.setSize(width, width / 2.1);
    U.uDpr.value = renderer.dpr;

    const w = canvas.width;
    const h = canvas.height;

    if (trail.width !== w || trail.height !== h) {
      gl.deleteFramebuffer(trail.buffer);

      (trail.textures || [trail.texture]).forEach(
        t => t && gl.deleteTexture(t.texture)
      );

      trail = target(w, h, true);
    }

    U.uRes.value[0] = w;
    U.uRes.value[1] = h;

    draw();
  }

  function step(dt) {
    // Il cilindro insegue il puntatore con un leggero smorzamento,
    // così la velocità trasmessa al fluido è continua.
    const k = snap ? 1 : 1 - Math.exp(-dt * SMOOTH);
    const nx = ball[0] + (goal[0] - ball[0]) * k;
    const ny = ball[1] + (goal[1] - ball[1]) * k;

    const clamp = v => Math.max(-2.5, Math.min(2.5, v));

    U.uBallVelocity.value[0] = snap ? 0 : clamp((nx - ball[0]) / dt);
    U.uBallVelocity.value[1] = snap ? 0 : clamp((ny - ball[1]) / dt);

    ball[0] = nx;
    ball[1] = ny;
    snap = false;

    U.uBall.value[0] = nx;
    U.uBall.value[1] = ny;
    U.uDt.value = dt;
    U.uTime.value += dt;

    // Piccola turbolenza in ingresso: innesca il distacco dei vortici.
    const t = U.uTime.value;
    U.uPert.value = .012 * Math.sin(t * 2.9) + .008 * Math.sin(t * 1.3 + 1);

    U.uVelocity.value = vel.read.texture;
    run(advectHat, velHat);
    U.uVelHat.value = velHat.texture;
    run(advectFix, vel.write);
    vel.swap();

    U.uVelocity.value = vel.read.texture;
    run(divergencePass, divergence);
    U.uDivergence.value = divergence.texture;

    for (let i = 0; i < SWEEPS; i++) {
      for (let parity = 0; parity < 2; parity++) {
        U.uParity.value = parity;
        U.uPressure.value = pressure.read.texture;
        run(pressurePass, pressure.write);
        pressure.swap();
      }
    }

    U.uPressure.value = pressure.read.texture;
    run(project, vel.write);
    vel.swap();

    U.uVelocity.value = vel.read.texture;
    U.uState.value = particles.read.texture;
    run(moveParticles, particles.write);
    particles.swap();

    // Dopo lo swap, `write` contiene le posizioni del frame precedente.
    U.uState.value = particles.read.texture;
    U.uPrev.value = particles.write.texture;
    U.uDecay.value = Math.pow(TRAIL, dt * 60);

    run(fade, trail);
    run(streaks, trail);
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

    snap = snap || jump;

    if (motion.matches) {
      ball.set(goal);
      U.uBall.value[0] = goal[0];
      U.uBall.value[1] = goal[1];
      draw();
    }
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

  stage.style.cursor = "none";
  sync();
}

startFluid().catch(error => {
  console.error(error);

  document.getElementById("fluid-stage").style.cursor = "auto";

  const status = document.getElementById("status");
  status.hidden = false;
  status.textContent = "Animazione non disponibile su questo dispositivo.";
});

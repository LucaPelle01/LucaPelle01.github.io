import { Fluid, Tracers } from './fluid-core.js?v=flow-2';

const canvas=document.getElementById('fluid-canvas');
const stage=document.getElementById('fluid-stage');
const theme=document.getElementById('theme');
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const SETTINGS={ particles:30000, mobileParticles:9000, trailHalfLife:.24, opacity:.11 };
const VERTEX=`attribute vec2 p; varying vec2 uv;
  void main(){uv=p*.5+.5; gl_Position=vec4(p,0.,1.);}`;
const colors=dark=>dark?{bg:[17/255,17/255,17/255],ink:[232/255,232/255,232/255]}:
  {bg:[250/255,250/255,250/255],ink:[32/255,32/255,32/255]};

class GPURenderer {
  constructor(gl) {
    this.gl=gl; this.targets=[]; this.width=0;this.height=0;
    const compile=(vs,fs)=>{
      const p=gl.createProgram();
      for(const [kind,source] of [[gl.VERTEX_SHADER,vs],[gl.FRAGMENT_SHADER,fs]]){
        const s=gl.createShader(kind);gl.shaderSource(s,source);gl.compileShader(s);
        if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));
        gl.attachShader(p,s);gl.deleteShader(s);
      }
      gl.linkProgram(p);
      if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));
      const uniforms={};
      for(let i=0;i<gl.getProgramParameter(p,gl.ACTIVE_UNIFORMS);i++){
        const name=gl.getActiveUniform(p,i).name;uniforms[name]=gl.getUniformLocation(p,name);
      }
      return {p,uniforms,position:gl.getAttribLocation(p,'p')};
    };
    this.fade=compile(VERTEX,`precision highp float; varying vec2 uv;
      uniform sampler2D history; uniform float decay;
      void main(){float a=floor(texture2D(history,uv).r*decay*255.)/255.;gl_FragColor=vec4(a);}`);
    this.lines=compile(`attribute vec2 p; varying vec2 world;
      void main(){world=p;gl_Position=vec4(((p-vec2(.3,.25))/vec2(2.4,1.))*2.-1.,0.,1.);}`,
      `precision mediump float;varying vec2 world;uniform float alpha;uniform vec3 ball;
      void main(){if(distance(world,ball.xy)<ball.z)discard;gl_FragColor=vec4(vec3(alpha),alpha);}`);
    this.screen=compile(VERTEX,`precision highp float;varying vec2 uv;
      uniform sampler2D history;uniform vec3 bg,ink,ball;uniform float pixel;
      void main(){
        vec2 world=vec2(.3,.25)+uv*vec2(2.4,1.);
        float d=distance(world,ball.xy)-ball.z;
        float edge=smoothstep(0.,.09,uv.x)*smoothstep(0.,.09,1.-uv.x)
          *smoothstep(0.,.16,uv.y)*smoothstep(0.,.16,1.-uv.y);
        float a=texture2D(history,uv).r*edge*smoothstep(-pixel,pixel,d);
        float rim=(1.-smoothstep(0.,pixel*1.1,abs(d)))*.11*edge;
        gl_FragColor=vec4(mix(bg,ink,max(a,rim)),1.);
      }`);
    this.quad=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.quad);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
    this.lineBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,SETTINGS.particles*4*4,gl.DYNAMIC_DRAW);
    gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);
  }
  bind(program,buffer){
    const gl=this.gl;
    gl.useProgram(program.p);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.enableVertexAttribArray(program.position);gl.vertexAttribPointer(program.position,2,gl.FLOAT,false,0,0);
  }
  resize(w,h){
    const gl=this.gl;
    this.width=w;this.height=h;
    for(const t of this.targets){gl.deleteTexture(t.texture);gl.deleteFramebuffer(t.fbo);}
    this.targets=Array.from({length:2},()=>{
      const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      const fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Framebuffer incompleto');
      gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
      return {texture,fbo};
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }
  clear(){
    const gl=this.gl;gl.clearColor(0,0,0,0);
    for(const t of this.targets){gl.bindFramebuffer(gl.FRAMEBUFFER,t.fbo);gl.clear(gl.COLOR_BUFFER_BIT);}
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }
  accumulate(data,dt,ball){
    const gl=this.gl,[read,write]=this.targets;
    gl.viewport(0,0,this.width,this.height);gl.bindFramebuffer(gl.FRAMEBUFFER,write.fbo);
    gl.disable(gl.BLEND);this.bind(this.fade,this.quad);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,read.texture);
    gl.uniform1i(this.fade.uniforms.history,0);
    gl.uniform1f(this.fade.uniforms.decay,Math.pow(.5,dt/SETTINGS.trailHalfLife));
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    this.bind(this.lines,this.lineBuffer);gl.bufferSubData(gl.ARRAY_BUFFER,0,data);
    gl.uniform3fv(this.lines.uniforms.ball,ball);
    // Segment length already scales with dt, so opacity must not scale twice.
    gl.uniform1f(this.lines.uniforms.alpha,SETTINGS.opacity);
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.LINES,0,data.length/2);gl.disable(gl.BLEND);
    this.targets=[write,read];
  }
  present(ball,dark){
    const gl=this.gl,c=colors(dark),u=this.screen.uniforms;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,this.width,this.height);
    gl.disable(gl.BLEND);this.bind(this.screen,this.quad);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.targets[0].texture);
    gl.uniform1i(u.history,0);gl.uniform3fv(u.ball,ball);
    gl.uniform3fv(u.bg,c.bg);gl.uniform3fv(u.ink,c.ink);gl.uniform1f(u.pixel,1/this.height);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  }
}

// Same fluid solver on devices without WebGL; only the drawing backend changes.
class CanvasRenderer {
  constructor(){
    this.context=canvas.getContext('2d');
    if(!this.context)throw Error('Canvas non disponibile');
    this.history=document.createElement('canvas');this.hc=this.history.getContext('2d');
    this.frames=0;
  }
  resize(w,h){this.width=w;this.height=h;this.history.width=w;this.history.height=h;}
  clear(){this.hc.clearRect(0,0,this.width,this.height);}
  accumulate(data,dt,ball){
    const c=this.hc,w=this.width,h=this.height;
    c.globalCompositeOperation='destination-out';c.fillStyle=`rgba(0,0,0,${1-Math.pow(.5,dt/SETTINGS.trailHalfLife)})`;c.fillRect(0,0,w,h);
    c.globalCompositeOperation='source-over';c.strokeStyle=`rgba(255,255,255,${SETTINGS.opacity})`;
    c.lineWidth=1;c.beginPath();
    for(let i=0;i<data.length;i+=4){
      c.moveTo((data[i]-.3)/2.4*w,(1.25-data[i+1])*h);
      c.lineTo((data[i+2]-.3)/2.4*w,(1.25-data[i+3])*h);
    }
    c.stroke();
    c.globalCompositeOperation='destination-out';c.fillStyle='#000';c.beginPath();
    c.arc((ball[0]-.3)/2.4*w,(1.25-ball[1])*h,ball[2]*h,0,Math.PI*2);c.fill();
    c.globalCompositeOperation='source-over';
    // Remove low-alpha quantization residue infrequently, outside the hot loop.
    if(++this.frames%90===0){const im=c.getImageData(0,0,w,h);for(let i=3;i<im.data.length;i+=4)if(im.data[i]<12)im.data[i]=0;c.putImageData(im,0,0);}
  }
  present(ball,dark){
    const c=this.context,w=this.width,h=this.height;
    const bg=dark?'#111111':'#fafafa',ink=dark?'#e8e8e8':'#202020';
    c.clearRect(0,0,w,h);c.drawImage(this.history,0,0);
    c.globalCompositeOperation='source-in';c.fillStyle=ink;c.fillRect(0,0,w,h);
    c.globalCompositeOperation='source-over';
    for(const axis of [0,1]){
      const g=c.createLinearGradient(0,0,axis?0:w,axis?h:0);
      g.addColorStop(0,bg);g.addColorStop(axis?.16:.09,dark?'rgba(17,17,17,0)':'rgba(250,250,250,0)');
      g.addColorStop(axis?.84:.91,dark?'rgba(17,17,17,0)':'rgba(250,250,250,0)');g.addColorStop(1,bg);
      c.fillStyle=g;c.fillRect(0,0,w,h);
    }
    const x=(ball[0]-.3)/2.4*w,y=(1.25-ball[1])*h;
    c.beginPath();c.arc(x,y,ball[2]*h,0,Math.PI*2);c.fillStyle=bg;c.fill();
    c.strokeStyle=dark?'rgba(232,232,232,.11)':'rgba(32,32,32,.11)';c.lineWidth=.7;c.stroke();
  }
}

let renderer,fluid,tracers,ball,dark=false,dead=false,visible=true,raf=0,last=0;
let bounds=stage.getBoundingClientRect(),count=0,workAverage=0,slowFrames=0;
const goal=new Float32Array([1.25,.75]);
let snap=false,frames=0,elapsed=0;
const diagnostics=new URLSearchParams(location.search).has('debug');
const status=document.getElementById('status');

function present(){if(!dead&&renderer)renderer.present(ball,dark);}
function resize(){
  bounds=stage.getBoundingClientRect();if(!renderer||dead||!bounds.width)return;
  const dpr=Math.min(devicePixelRatio||1,1.5);
  const w=Math.round(bounds.width*dpr),h=Math.round(bounds.height*dpr);
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;renderer.resize(w,h);seedImage();}
  present();
}
function seedImage(){
  renderer.clear();
  // A short frozen streamline exposure also gives reduced-motion users a real image.
  for(let i=0;i<18;i++)renderer.accumulate(tracers.step(1/60,count),1/60,ball);
}
function advance(dt){
  const ox=ball[0],oy=ball[1];
  const amount=1-Math.exp(-dt/.045);
  ball[0]+= (goal[0]-ball[0])*amount;ball[1]+=(goal[1]-ball[1])*amount;
  const vx=snap?0:Math.max(-1.5,Math.min(1.5,(ball[0]-ox)/dt));
  const vy=snap?0:Math.max(-1.5,Math.min(1.5,(ball[1]-oy)/dt));snap=false;
  fluid.step(dt,ball[0],ball[1],vx,vy);
  renderer.accumulate(tracers.step(dt,count),dt,ball);
}
function frame(now){
  raf=0;if(dead||document.hidden||!visible||reduced.matches)return;
  const dt=last?Math.min((now-last)/1000,1/30):1/60;
  if(last&&now-last<1000/60-.6){raf=requestAnimationFrame(frame);return;}
  const wall=last?(now-last):1000/60;last=now;
  const start=performance.now();
  // At low refresh rates substep the fluid instead of increasing its timestep.
  if(dt>1/48){advance(dt*.5);advance(dt*.5);}else advance(dt);
  present();
  workAverage=workAverage*.96+(performance.now()-start)*.04;
  // Only reduce density after sustained CPU pressure, not after a single slow frame.
  if(workAverage>16&&++slowFrames>90&&count>7000){count=Math.max(7000,Math.floor(count*.8));slowFrames=0;}
  else if(workAverage<=16)slowFrames=0;
  if(diagnostics&&++frames%60===0){status.hidden=false;status.textContent=`${renderer instanceof GPURenderer?'WebGL':'Canvas 2D'} · ${count} particles · CPU ${workAverage.toFixed(1)} ms · frame ${(elapsed/60).toFixed(1)} ms`;elapsed=0;}
  elapsed+=wall;
  raf=requestAnimationFrame(frame);
}
function sync(){cancelAnimationFrame(raf);raf=0;last=0;snap=true;if(!dead&&visible&&!document.hidden&&!reduced.matches)raf=requestAnimationFrame(frame);}
function aim(e,enter=false){
  if(dead)return;if(enter)bounds=stage.getBoundingClientRect();
  goal[0]=.3+Math.max(0,Math.min(1,(e.clientX-bounds.left)/bounds.width))*2.4;
  goal[1]=1.25-Math.max(0,Math.min(1,(e.clientY-bounds.top)/bounds.height));
  if(enter){ball[0]=goal[0];ball[1]=goal[1];snap=true;}
  if(reduced.matches){ball[0]=goal[0];ball[1]=goal[1];fluid.obstacle(ball[0],ball[1],0,0);fluid.project(30);seedImage();present();}
}
theme.addEventListener('click',()=>{
  dark=!dark;document.documentElement.dataset.dark=String(dark);
  theme.setAttribute('aria-pressed',String(dark));theme.setAttribute('aria-label',dark?'Attiva il tema chiaro':'Attiva il tema scuro');present();
});

try{
  const gl=canvas.getContext('webgl',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});
  renderer=gl?new GPURenderer(gl):new CanvasRenderer();
  fluid=renderer instanceof CanvasRenderer?new Fluid(112,56):new Fluid();
  ball=new Float32Array([fluid.cx,fluid.cy,fluid.radius]);
  count=renderer instanceof CanvasRenderer?(bounds.width<480?3000:6000):(bounds.width<480?SETTINGS.mobileParticles:SETTINGS.particles);
  tracers=new Tracers(count,fluid);
  // Establish the pressure field before the first visible frame.
  for(let i=0;i<35;i++)fluid.step(1/60,ball[0],ball[1],0,0);
  resize();stage.style.cursor='none';
  stage.addEventListener('pointerenter',e=>aim(e,true));stage.addEventListener('pointermove',e=>aim(e));
  stage.addEventListener('pointerdown',e=>aim(e,true));
  stage.addEventListener('keydown',e=>{
    const d={ArrowLeft:[-.04,0],ArrowRight:[.04,0],ArrowUp:[0,.04],ArrowDown:[0,-.04]}[e.key];
    if(!d)return;e.preventDefault();goal[0]=Math.max(.3,Math.min(2.7,goal[0]+d[0]));goal[1]=Math.max(.25,Math.min(1.25,goal[1]+d[1]));
    if(reduced.matches){ball[0]=goal[0];ball[1]=goal[1];fluid.obstacle(ball[0],ball[1],0,0);fluid.project(30);seedImage();present();}
  });
  new ResizeObserver(resize).observe(stage);window.addEventListener('resize',resize,{passive:true});
  window.addEventListener('scroll',()=>{bounds=stage.getBoundingClientRect();},{passive:true,capture:true});
  new IntersectionObserver(([e])=>{visible=e.isIntersecting;sync();}).observe(stage);
  document.addEventListener('visibilitychange',sync);
  reduced.addEventListener('change',()=>{seedImage();present();sync();});
  canvas.addEventListener('webglcontextlost',()=>{dead=true;sync();stage.style.cursor='auto';status.hidden=false;status.textContent='Ricarica la pagina per riavviare l’animazione.';});
  sync();
}catch(error){
  dead=true;cancelAnimationFrame(raf);stage.style.cursor='auto';console.error(error);
  status.hidden=false;status.textContent='Animazione non disponibile su questo dispositivo.';
}

"use strict";

document.getElementById("affiliation").textContent=PROFILE.affiliation;
document.getElementById("email").href="mailto:"+PROFILE.email;
for (const id of ["github","linkedin"]) document.getElementById(id).href=PROFILE[id];

const root=document.documentElement;
const themeButton=document.getElementById("theme");
const isLight=()=>root.dataset.theme==="light";
function updateThemeButton() {
  const label=isLight() ? "Attiva il tema scuro" : "Attiva il tema chiaro";
  themeButton.setAttribute("aria-label",label);
  themeButton.title=label;
}
updateThemeButton();
themeButton.addEventListener("click",()=>{
  root.dataset.theme=isLight() ? "dark" : "light";
  try { localStorage.setItem("luca.theme",root.dataset.theme); } catch {}
  updateThemeButton();
  paint();
});

const canvas=document.getElementById("flow");
const ctx=canvas.getContext("2d",{alpha:false});
let fluid, ink, width, height, pixelRatio;
let activePointer=null, previousTime=0, onScreen=true;

// Decode a precomputed, evolved state so that the first frame has a wake.
// This snapshot only initializes the simulation. Every later step runs locally.
function unpack(text,scale) {
  const bytes=atob(text);
  const values=new Float32Array(bytes.length/2);
  for(let i=0;i<values.length;i++) {
    const word=bytes.charCodeAt(2*i) | bytes.charCodeAt(2*i+1)<<8;
    values[i]=((word<<16)>>16)/scale;
  }
  return values;
}
function warmStart(f, pigment) {
  const aspect=f.nx/f.ny;
  const state=WAKE_PRESETS.reduce((a,b)=>Math.abs(a.nx/a.ny-aspect)<Math.abs(b.nx/b.ny-aspect)?a:b);
  const original=new Fluid(state.nx,state.ny,"inflow");
  original.u=unpack(state.u,8192); original.v=unpack(state.v,8192);
  const horizontal=f.nx/state.nx, vertical=f.ny/state.ny;
  for(let j=1;j<=f.ny+1;j++) {
    for(let i=1;i<=f.nx+1;i++) {
      const k=i+j*f.stride;
      f.u[k]=vertical*original.sample(original.u,1+(i-1)/horizontal,.5+(j-.5)/vertical);
      f.v[k]=vertical*original.sample(original.v,.5+(i-.5)/horizontal,1+(j-1)/vertical);
    }
  }
  f.boundaries(0,0);
  const bytes = atob(state.dye);
  const w = state.nx*state.scale, h = state.ny*state.scale;
  for (let y=0; y<pigment.h; y++) {
    const sy=clamp((y+.5)*h/pigment.h-.5,0,h-1.001);
    const iy=Math.floor(sy), by=sy-iy;
    for (let x=0; x<pigment.w; x++) {
      const sx=clamp((x+.5)*w/pigment.w-.5,0,w-1.001);
      const ix=Math.floor(sx), bx=sx-ix, p=iy*w+ix;
      const top=(1-bx)*bytes.charCodeAt(p)+bx*bytes.charCodeAt(p+1);
      const bottom=(1-bx)*bytes.charCodeAt(p+w)+bx*bytes.charCodeAt(p+w+1);
      pigment.dye[x+y*pigment.w]=((1-by)*top+by*bottom)/255;
    }
  }
  pigment.time=state.time;
}

// The simulation and its pigment are independent of display pixel density.
// Only the final disk and the finished image are composited at display resolution.
const inkCanvas = document.createElement("canvas");
const inkContext = inkCanvas.getContext("2d", {alpha:false});
let imageData, rgba, slowFrames=0, stirred=false;
function configurePigmentCanvas() {
  inkCanvas.width=ink.w; inkCanvas.height=ink.h;
  imageData=inkContext.createImageData(ink.w,ink.h);
  rgba=new Uint32Array(imageData.data.buffer);
}

function resize() {
  const rect=canvas.getBoundingClientRect();
  const dpr=Math.min(2,window.devicePixelRatio||1);
  if (!rect.width || !rect.height || (width===rect.width && height===rect.height && pixelRatio===dpr)) return;
  width=rect.width; height=rect.height; pixelRatio=dpr;
  canvas.width=Math.round(width*dpr);
  canvas.height=Math.round(height*dpr);
  const ny=clamp(Math.round(height/6.2),32,48);
  const nx=Math.max(32,Math.round(ny*width/height));
  if(!fluid || nx!==fluid.nx || ny!==fluid.ny) {
    fluid=new Fluid(nx,ny,FLOW_MODE);
    ink=new Ink(fluid,4);
    if(FLOW_MODE==="inflow") warmStart(fluid,ink);
    configurePigmentCanvas();
    stirred=false; slowFrames=0;
  }
  paint();
}

function paint() {
  if(!fluid) return;
  const light=isLight();
  const {w,h,dye}=ink;
  // Directional light on the concentration gradient brings out thin folds.
  // The broad tone and fine highlights both come from the same advected field.
  for (let y=0; y<h; y++) {
    const above=y===0 ? 0 : -w, below=y===h-1 ? 0 : w;
    for (let x=0; x<w; x++) {
      const k=x+y*w;
      const gx=dye[x===w-1?k:k+1]-dye[x===0?k:k-1];
      const gy=dye[k+below]-dye[k+above];
      const slope=-.46*gx-.89*gy;
      const reflection=100*slope/(.19+Math.abs(slope));
      const c=dye[k];
      const tone=light ? 243-132*c-46*c*c+reflection*.62 : 17+78*c+162*c*c+reflection*.94;
      const value=clamp(Math.round(tone),0,255);
      rgba[k]=0xff000000 | value*0x010101;
    }
  }
  inkContext.putImageData(imageData,0,0);
  ctx.setTransform(canvas.width/width,0,0,canvas.height/height,0,0);
  ctx.imageSmoothingEnabled=true;
  ctx.drawImage(inkCanvas,0,0,width,height);
  const x=(fluid.x-1)*width/fluid.nx, y=(fluid.y-1)*height/fluid.ny;
  ctx.beginPath();
  ctx.arc(x,y,fluid.radius*height/fluid.ny,0,Math.PI*2);
  ctx.fillStyle=light?"#eee":"#151515"; ctx.fill();
  ctx.strokeStyle=light?"#666":"#a0a0a0"; ctx.lineWidth=.75; ctx.stroke();
}

function setTarget(x,y) {
  const inset=fluid.radius+1.5;
  fluid.targetX=clamp(x,1+inset,fluid.nx+1-inset);
  fluid.targetY=clamp(y,1+inset,fluid.ny+1-inset);
}
function point(event) {
  const box=canvas.getBoundingClientRect();
  setTarget(1+(event.clientX-box.left)*fluid.nx/box.width,1+(event.clientY-box.top)*fluid.ny/box.height);
}
canvas.addEventListener("pointerdown",event=>{
  if(!event.isPrimary) return;
  activePointer=event.pointerId;
  canvas.setPointerCapture(event.pointerId); point(event);
});
canvas.addEventListener("pointermove",event=>{
  if(event.isPrimary && (event.pointerType==="mouse" || event.pointerId===activePointer)) point(event);
});
function release(event) { if(event.pointerId===activePointer) activePointer=null; }
canvas.addEventListener("pointerup",release);
canvas.addEventListener("pointercancel",release);
canvas.addEventListener("lostpointercapture",release);
canvas.addEventListener("keydown",event=>{
  const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
  if(!direction) return;
  event.preventDefault();
  setTarget(fluid.targetX+direction[0]*fluid.radius*.5,fluid.targetY+direction[1]*fluid.radius*.5);
});

function frame(time) {
  const moving = fluid.x!==fluid.targetX || fluid.y!==fluid.targetY;
  if(moving) stirred=true;
  if(onScreen && !document.hidden && (FLOW_MODE==="inflow" || stirred)) {
    const started=performance.now();
    const dt = clamp(previousTime ? (time-previousTime)*.035 : .5, .06, 1.25);
    // One full interaction update per display frame, including high-refresh displays.
    fluid.step(dt);
    ink.step(fluid,dt);
    paint();
    // If the rendering budget is repeatedly exceeded on this device, retain
    // the evolved dye and lower only its sampling density, keeping input responsive.
    if(ink.scale===4) {
      slowFrames=Math.max(0,slowFrames+(performance.now()-started>15 ? 1 : -1));
      if(slowFrames>=24) {
        ink=ink.reduceResolution(fluid);
        configurePigmentCanvas();
        slowFrames=0;
      }
    }
  }
  previousTime=time;
  requestAnimationFrame(frame);
}
resize();
new ResizeObserver(resize).observe(canvas);
new IntersectionObserver(entries=>{onScreen=entries[0].isIntersecting;}).observe(canvas);
requestAnimationFrame(frame);

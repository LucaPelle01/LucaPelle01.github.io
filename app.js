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
let fluid, lines, width, height, pixelRatio;
let activePointer=null, previousTime=0, debt=0, onScreen=true;

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
function warmStart(f, strands) {
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
  const px=unpack(state.x,128), py=unpack(state.y,128);
  for(let row=0;row<strands.rows;row++) {
    for(let col=0;col<strands.cols;col++) {
      const position=col*(state.cols-1)/(strands.cols-1), index=Math.floor(position);
      const a=row*state.cols+(index+state.head)%state.cols;
      const b=row*state.cols+(Math.min(index+1,state.cols-1)+state.head)%state.cols;
      const fraction=position-index;
      const k=row*strands.cols+col;
      strands.positionsX[k]=1+(px[a]+fraction*(px[b]-px[a])-1)*horizontal;
      strands.positionsY[k]=1+(py[a]+fraction*(py[b]-py[a])-1)*vertical;
    }
  }
  strands.tick=state.tick;
}

function resize() {
  const rect=canvas.getBoundingClientRect();
  const dpr=Math.min(2,window.devicePixelRatio||1);
  if (width===rect.width && height===rect.height && pixelRatio===dpr) return;
  width=rect.width; height=rect.height; pixelRatio=dpr;
  canvas.width=Math.max(1,Math.round(width*dpr));
  canvas.height=Math.max(1,Math.round(height*dpr));
  const ny=clamp(Math.round(height/6.5),44,72);
  const nx=Math.max(38,Math.round(ny*width/height));
  if(!fluid || fluid.nx!==nx || fluid.ny!==ny) {
    fluid=new Fluid(nx,ny,FLOW_MODE);
    lines=new Filaments(fluid);
    if(FLOW_MODE==="inflow") warmStart(fluid,lines);
    debt=0;
  }
  paint();
}

function hash(n) {
  const s=Math.sin(129.87*n+19.27)*43758.5453;
  return s-Math.floor(s);
}
function drawFilaments(light) {
  const {rows,cols,head,positionsX:px,positionsY:py}=lines;
  const sx=width/fluid.nx, sy=height/fluid.ny;
  const maxDistance=(fluid.ny*.053)**2;
  ctx.lineJoin="round"; ctx.lineCap="round";
  for(let row=0;row<rows;row++) {
    const t=(row+.5)/rows, variation=hash(row);
    const core=Math.exp(-((t-.50)**2)/.040);
    const lobe=.5+.5*Math.cos(51*t+.72*Math.sin(19*t));
    const brightness=(.18+.82*core)*(.28+.72*lobe)*(.42+.58*variation);
    const intensity=Math.round(light ? 211-166*brightness : 32+213*brightness);
    ctx.strokeStyle='rgb('+intensity+' '+intensity+' '+intensity+')';
    ctx.lineWidth=Math.max(.48,height*(.0015+.0042*hash(row+900)**3));
    ctx.beginPath();
    let lastX=0, lastY=0;
    for(let n=0;n<cols;n++) {
      const k=row*cols+(n+head)%cols;
      const x=px[k], y=py[k];
      if(x>fluid.nx+1.9) { lastX=0; continue; }
      // Disconnected dye fades into the background as it stretches and exits.
      if(!lastX || (x-lastX)**2+(y-lastY)**2>maxDistance) ctx.moveTo((x-1)*sx,(y-1)*sy);
      else ctx.quadraticCurveTo((lastX-1)*sx,(lastY-1)*sy,((x+lastX)*.5-1)*sx,((y+lastY)*.5-1)*sy);
      lastX=x; lastY=y;
    }
    ctx.stroke();
  }
}

// A low-resolution tonal layer follows local rotation and speed. Interpolation
// gives the dye a continuous body under the individual material filaments.
const washCanvas=document.createElement("canvas");
const wash=washCanvas.getContext("2d");
let washImage;
function drawWash(light) {
  const {nx,ny,stride,u,v,inlet}=fluid;
  if(washCanvas.width!==nx || washCanvas.height!==ny || !washImage) {
    washCanvas.width=nx; washCanvas.height=ny;
    washImage=wash.createImageData(nx,ny);
  }
  const pixels=washImage.data;
  for(let j=1;j<=ny;j++) {
    for(let i=1;i<=nx;i++) {
      const k=i+j*stride;
      const curl=(v[k+1]-v[k-1]-u[k+stride]+u[k-stride])*.5;
      const shear=Math.min(1,Math.abs(curl)*5/inlet);
      const ambient=FLOW_MODE==="inflow" ? inlet : 0;
      const speed=Math.min(1,Math.hypot(u[k]-ambient,v[k])/inlet);
      const tone=light ? 231-19*speed-34*shear : 24+15*speed+34*shear;
      const p=4*((j-1)*nx+i-1);
      pixels[p]=pixels[p+1]=pixels[p+2]=tone; pixels[p+3]=255;
    }
  }
  wash.putImageData(washImage,0,0);
  ctx.drawImage(washCanvas,0,0,width,height);
}
function drawCylinder(light) {
  const x=(fluid.x-1)*width/fluid.nx, y=(fluid.y-1)*height/fluid.ny;
  const r=fluid.radius*height/fluid.ny;
  ctx.save();
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2);
  const metal=ctx.createLinearGradient(x-r,y-r,x+r*.8,y+r);
  metal.addColorStop(0,light?"#d3d3d3":"#999");
  metal.addColorStop(.24,light?"#aaa":"#676767");
  metal.addColorStop(.65,light?"#747474":"#404040");
  metal.addColorStop(1,light?"#5a5a5a":"#313131");
  ctx.fillStyle=metal; ctx.fill();
  ctx.lineWidth=1.15; ctx.strokeStyle=light?"#585858":"#aaa"; ctx.stroke();
  ctx.restore();
}
function paint() {
  if(!fluid) return;
  const light=isLight();
  ctx.setTransform(canvas.width/width,0,0,canvas.height/height,0,0);
  drawWash(light);
  drawFilaments(light);
  // Soft extinction of dye as it travels downstream.
  const fade=ctx.createLinearGradient(0,0,width,0);
  const base=light?"231 231 231":"24 24 24";
  fade.addColorStop(0,'rgb('+base+' / .25)');
  fade.addColorStop(.33,'rgb('+base+' / 0)');
  fade.addColorStop(1,'rgb('+base+' / .27)');
  ctx.fillStyle=fade; ctx.fillRect(0,0,width,height);
  drawCylinder(light);
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
  // Fixed steps and bounded catch-up keep the CFL number independent of frame stalls.
  if(onScreen && !document.hidden) {
    debt+=Math.min((time-(previousTime||time))*0.030,2);
    let advanced=false;
    while(debt>=1) {
      fluid.step(1); lines.step(1); debt-=1; advanced=true;
    }
    if(advanced) paint();
  } else { debt=0; }
  previousTime=time;
  requestAnimationFrame(frame);
}
resize();
new ResizeObserver(resize).observe(canvas);
new IntersectionObserver(entries=>{onScreen=entries[0].isIntersecting;}).observe(canvas);
requestAnimationFrame(frame);

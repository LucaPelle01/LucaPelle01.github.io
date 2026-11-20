"use strict";

document.getElementById("affiliation").textContent=PROFILE.affiliation;
document.getElementById("email").href="mailto:"+PROFILE.email;
for (const id of ["github","linkedin"]) document.getElementById(id).href=PROFILE[id];

const root=document.documentElement;
const themeButton=document.getElementById("theme");
const themeNames = { dark: "scuro", light: "panna", blue: "blu pastello" };
const nextTheme = { dark: "light", light: "blue", blue: "dark" };

function updateThemeButton() {
  const current = root.dataset.theme;
  const label = "Tema " + themeNames[current] + ". Attiva il tema " + themeNames[nextTheme[current]];
  themeButton.setAttribute("aria-label", label);
  themeButton.title = label;
}
updateThemeButton();
themeButton.addEventListener("click",()=>{
  root.dataset.theme = nextTheme[root.dataset.theme];
  try { localStorage.setItem("luca.theme",root.dataset.theme); } catch {}
  updateThemeButton();
  if (renderer) {
    renderer.setTheme(root.dataset.theme);
    renderer.draw(fluid, surface);
  }
});

const canvas = document.getElementById("flow");
const contact = document.querySelector(".contact");
let fluid, surface, renderer, width, height, pixelRatio;
let owner=null, contactId=null, previousInput=0, lastFrame=0, animation=0;
let visible=true, awake=false, elapsedSinceStroke=0;

function schedule() {
  if(!animation && visible && !document.hidden) animation=requestAnimationFrame(frame);
}
function frame(now) {
  animation=0;
  if(!visible || document.hidden) return;
  const dt=clamp(lastFrame ? (now-lastFrame)*.038 : .6,.035,1.1);
  lastFrame=now;
  fluid.step(dt);
  const peak=surface.step(dt);
  renderer.draw(fluid,surface);
  elapsedSinceStroke+=dt;
  if(FLOW_MODE==="still" && peak<.0003 && elapsedSinceStroke>75) {
    // Make the final, imperceptible residual exactly zero; quiet mode can sleep.
    surface.height.fill(0); surface.speed.fill(0);
    fluid.u.fill(0); fluid.v.fill(0);
    renderer.draw(fluid,surface);
    awake=false; lastFrame=0;
  }
  if(awake || FLOW_MODE==="inflow") schedule();
}

function hideObstacle() {
  if(fluid && fluid.active) fluid.leave();
  owner=null;
  contact.hidden=true;
  previousInput=0;
}
function resize() {
  const box=canvas.getBoundingClientRect(), dpr=window.devicePixelRatio||1;
  if(!box.width || !box.height || (width===box.width && height===box.height && pixelRatio===dpr)) return;
  width=box.width; height=box.height; pixelRatio=dpr;
  hideObstacle();
  const referenceRows=clamp(Math.round(height/3),28,48);
  const ny=Math.round(referenceRows*1.5);
  fluid=new Fluid(Math.max(32,Math.round(width*ny/height)),ny,FLOW_MODE);
  fluid.radius=4.5*ny/height;
  surface=new Surface(fluid,ny/referenceRows);
  renderer=new Mercury(canvas,fluid,width,height,root.dataset.theme);
  renderer.draw(fluid,surface);
  elapsedSinceStroke=0; lastFrame=0; awake=false;
  if(FLOW_MODE==="inflow") schedule();
}

function updatePosition(px,py,kind,time) {
  const x=1+px*fluid.nx/width, y=1+py*fluid.ny/height;
  if(owner!==kind || !fluid.active) {
    // Entry creates the obstacle exactly here, with no stroke from a phantom origin.
    fluid.enter(x,y);
    owner=kind;
  } else if(x!==fluid.x || y!==fluid.y) {
    surface.stroke(fluid.x,fluid.y,x,y);
    fluid.moveTo(x,y,clamp((time-previousInput)*.038,.05,1.1));
    awake=true; elapsedSinceStroke=0; schedule();
  }
  previousInput=time;
  // A mouse or hovering pen uses the native, hotspot-centred CSS cursor.
  // Only touch and keyboard input need a separate visual marker.
  contact.hidden=kind!=="touch" && kind!=="keyboard";
  if(!contact.hidden) contact.style.transform="translate("+px+"px,"+py+"px)";
}
function input(event) {
  if(!event.isPrimary || (event.pointerType==="touch" && event.pointerId!==contactId)) return;
  const box=canvas.getBoundingClientRect();
  const px=event.clientX-box.left, py=event.clientY-box.top;
  if(px<0 || px>=box.width || py<0 || py>=box.height) { hideObstacle(); return; }
  updatePosition(px,py,event.pointerType,event.timeStamp);
}
canvas.addEventListener("pointerenter",input);
canvas.addEventListener("pointermove",event=>{
  const samples=event.getCoalescedEvents?.()||[];
  for(const sample of samples) input(sample);
  input(event);
});
canvas.addEventListener("pointerdown",event=>{
  if(!event.isPrimary) return;
  if(event.pointerType==="touch") {
    contactId=event.pointerId;
    canvas.setPointerCapture(event.pointerId);
  }
  input(event);
});
canvas.addEventListener("pointerleave",event=>{ if(event.isPrimary) hideObstacle(); });
function endContact(event) {
  if(event.pointerId!==contactId) return;
  contactId=null; hideObstacle();
}
canvas.addEventListener("pointerup",endContact);
canvas.addEventListener("lostpointercapture",endContact);
canvas.addEventListener("pointercancel",event=>{ if(event.isPrimary) { contactId=null; hideObstacle(); } });
canvas.addEventListener("keydown",event=>{
  const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
  if(!direction) return;
  event.preventDefault();
  if(owner!=="keyboard") updatePosition(width/2,height/2,"keyboard",event.timeStamp);
  const px=(fluid.x-1)*width/fluid.nx, py=(fluid.y-1)*height/fluid.ny;
  updatePosition(clamp(px+direction[0]*4,0,width-.01),clamp(py+direction[1]*4,0,height-.01),"keyboard",event.timeStamp);
});
canvas.addEventListener("blur",()=>{ if(owner==="keyboard") hideObstacle(); });
window.addEventListener("blur",()=>{contactId=null; hideObstacle();});
document.addEventListener("visibilitychange",()=>{
  lastFrame=0;
  if(document.hidden) {contactId=null; hideObstacle();}
  else if(awake || FLOW_MODE==="inflow") schedule();
});
new ResizeObserver(resize).observe(canvas);
new IntersectionObserver(entries=>{
  visible=entries[0].isIntersecting; lastFrame=0;
  if(!visible) hideObstacle();
  else if(awake || FLOW_MODE==="inflow") schedule();
}).observe(canvas);
resize();

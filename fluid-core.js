// Small staggered-grid incompressible solver. No DOM or rendering dependencies.
export class Fluid {
  constructor(nx = 144, ny = 72) {
    this.nx = nx; this.ny = ny; this.h = 3 / nx;
    const n = nx * ny;
    this.u = new Float32Array(n); this.v = new Float32Array(n);
    this.u0 = new Float32Array(n); this.v0 = new Float32Array(n);
    this.open = new Uint8Array(n); this.open.fill(1);
    this.time = 0; this.radius = .085; this.cx = 1.25; this.cy = .75;
    this.u.fill(.45);
    this.obstacle(this.cx, this.cy, 0, 0);
  }

  obstacle(x, y, vx, vy) {
    const {nx, ny, h, open, u, v, radius} = this;
    this.cx = x; this.cy = y;
    const rr = radius * radius;
    for (let j = 0; j < ny; j++) {
      const dy = (j + .5) * h - y;
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i, dx = (i + .5) * h - x;
        const inside = dx * dx + dy * dy < rr;
        // Newly exposed cells inherit a bounded nearby fluid velocity.
        if (!open[k] && !inside) { u[k] = .45; v[k] = 0; }
        open[k] = inside ? 0 : 1;
      }
    }
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      if (!open[k] || !open[k-1]) u[k] = vx;
      if (!open[k] || !open[k-nx]) v[k] = vy;
    }
  }

  sample(a, x, y, face) {
    const {nx, ny, h} = this;
    x = Math.max(0, Math.min(nx - 1.001, x / h - (face === 0 ? 0 : .5)));
    y = Math.max(0, Math.min(ny - 1.001, y / h - (face === 0 ? .5 : 0)));
    const i = x | 0, j = y | 0, ax = x-i, ay = y-j, k = j*nx+i;
    return (a[k]*(1-ax)+a[k+1]*ax)*(1-ay) + (a[k+nx]*(1-ax)+a[k+nx+1]*ax)*ay;
  }

  boundaries() {
    const {u,v,nx,ny,time} = this;
    for (let j=0;j<ny;j++) {
      const k=j*nx;
      u[k]=u[k+1]=.45;
      v[k]=v[k+1]=.004*Math.sin(time*1.7+j*.13);
      u[k+nx-1]=u[k+nx-2]; v[k+nx-1]=v[k+nx-2];
    }
    for(let i=0;i<nx;i++) {
      u[i]=.45; u[(ny-1)*nx+i]=.45;
      v[i]=v[nx+i]=v[(ny-1)*nx+i]=0;
    }
  }

  project(iterations = 18) {
    const {nx,ny,u,v,open} = this;
    // In-place SOR projection; pressure gradients are applied directly to faces.
    for(let it=0;it<iterations;it++) {
      for(let j=1;j<ny-1;j++) for(let i=1;i<nx-1;i++) {
        const k=j*nx+i;
        if(!open[k]) continue;
        const l=open[k-1],r=open[k+1],b=open[k-nx],t=open[k+nx];
        const sum=l+r+b+t;
        if(!sum) continue;
        const correction=-(u[k+1]-u[k]+v[k+nx]-v[k])*1.75/sum;
        u[k]-=l*correction; u[k+1]+=r*correction;
        v[k]-=b*correction; v[k+nx]+=t*correction;
      }
    }
  }

  step(dt, x, y, vx, vy) {
    const {nx,ny,h,u,v,u0,v0,open} = this;
    this.time+=dt;
    u0.set(u); v0.set(v);
    // Semi-Lagrangian advection with a small, stable explicit viscosity term.
    const diffusion=Math.min(.06, .00012*dt/(h*h));
    for(let j=1;j<ny-1;j++) for(let i=1;i<nx-1;i++) {
      const k=j*nx+i;
      if(open[k] && open[k-1]) {
        const x=i*h, y=(j+.5)*h;
        const cross=(v0[k]+v0[k-1]+v0[k+nx]+v0[k+nx-1])*.25;
        u[k]=this.sample(u0,x-dt*u0[k],y-dt*cross,0)
          +diffusion*(u0[k-1]+u0[k+1]+u0[k-nx]+u0[k+nx]-4*u0[k]);
      }
      if(open[k] && open[k-nx]) {
        const x=(i+.5)*h, y=j*h;
        const cross=(u0[k]+u0[k+1]+u0[k-nx]+u0[k-nx+1])*.25;
        v[k]=this.sample(v0,x-dt*cross,y-dt*v0[k],1)
          +diffusion*(v0[k-1]+v0[k+1]+v0[k-nx]+v0[k+nx]-4*v0[k]);
      }
    }
    this.obstacle(x,y,vx,vy);
    this.boundaries();
    this.project();
  }
}

export class Tracers {
  constructor(count, fluid, random = Math.random) {
    this.count=count; this.fluid=fluid; this.random=random;
    this.x=new Float32Array(count); this.y=new Float32Array(count);
    this.age=new Float32Array(count); this.life=new Float32Array(count);
    this.lines=new Float32Array(count*4);
    for(let i=0;i<count;i++) this.spawn(i,true);
  }
  spawn(i, distributed = false) {
    const r=this.random, f=this.fluid;
    let x=distributed ? .3+r()*2.4 : .301+r()*.025, y=.25+r();
    if(Math.hypot(x-f.cx,y-f.cy)<f.radius+.006) {
      x=f.cx-f.radius-.01;
    }
    this.x[i]=x; this.y[i]=y; this.age[i]=0;
    this.life[i]=4+r()*7;
  }
  step(dt, count=this.count) {
    const f=this.fluid, {x,y,age,life,lines}=this;
    const radius=f.radius+.003, rr=radius*radius;
    for(let i=0;i<count;i++) {
      const ox=x[i],oy=y[i];
      const vx=f.sample(f.u,ox,oy,0),vy=f.sample(f.v,ox,oy,1);
      const mx=ox+vx*dt*.5,my=oy+vy*dt*.5;
      let px=ox+f.sample(f.u,mx,my,0)*dt,py=oy+f.sample(f.v,mx,my,1)*dt;
      let dx=px-f.cx,dy=py-f.cy,d2=dx*dx+dy*dy;
      let recycled=false;
      // Project onto the circle, not back to the inlet: no disappearing swarm.
      if(d2<rr) {
        if(d2<1e-12){dx=-radius;dy=0;d2=rr;}
        const d=Math.sqrt(d2)||1e-6;
        px=f.cx+dx/d*radius; py=f.cy+dy/d*radius;
        if(Math.hypot(px-ox,py-oy)>.06) recycled=true;
      }
      age[i]+=dt;
      if(px<.29||px>2.71||py<.24||py>1.26||age[i]>life[i]||!Number.isFinite(px+py)) {
        this.spawn(i,age[i]>life[i]); px=x[i]; py=y[i]; recycled=true;
      }
      x[i]=px;y[i]=py;
      const k=i*4;
      lines[k]=recycled?px:ox;lines[k+1]=recycled?py:oy;
      lines[k+2]=px;lines[k+3]=py;
    }
    return lines.subarray(0,count*4);
  }
}

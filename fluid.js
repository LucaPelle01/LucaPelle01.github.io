// Staggered MAC grid. Distances are in cells and velocities in cells per step.
// Fluid cells have centres (i + 1/2, j + 1/2); u and v live on their faces.
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));

class Fluid {
  constructor(nx, ny, mode) {
    this.nx = nx;
    this.ny = ny;
    this.stride = nx + 3;
    this.mode = mode;
    const size = this.stride * (ny + 3);
    for (const name of ["u", "v", "nextU", "nextV", "tmpU", "tmpV", "weight"]) this[name] = new Float32Array(size);
    this.open = new Uint8Array(size);
    this.radius = ny * .083;
    this.x = 1 + nx * .268;
    this.y = 1 + ny * .50;
    this.targetX = this.x;
    this.targetY = this.y;
    this.inlet = .72 * ny / 64;
    this.viscosity = .018 * (ny / 64) ** 2;
    if (mode === "inflow") this.u.fill(this.inlet);
    this.boundaries(0, 0);
  }
  sample(a, x, y) {
    x = clamp(x, 1, this.nx + .999);
    y = clamp(y, 1, this.ny + .999);
    const i = Math.floor(x), j = Math.floor(y);
    const sx = x - i, sy = y - j;
    const k = i + this.stride * j;
    const bottom = k + this.stride;
    return (1-sy) * (a[k] + sx*(a[k+1]-a[k])) +
      sy * (a[bottom] + sx*(a[bottom+1]-a[bottom]));
  }
  boundaries(bodyU, bodyV) {
    const {nx, ny, stride:s, open, u, v, weight, radius} = this;
    for (let j=1; j<=ny; j++) {
      for (let i=1; i<=nx; i++) {
        const dx=i+.5-this.x, dy=j+.5-this.y;
        open[i+j*s] = dx*dx+dy*dy >= radius*radius;
      }
      // Open outflow, prescribed inflow. The still tank is sealed on all sides.
      open[nx+1+j*s] = this.mode === "inflow";
      u[1+j*s] = this.mode === "inflow" ? this.inlet : 0;
      u[nx+1+j*s] = this.mode === "inflow" ? u[nx+j*s] : 0;
      v[nx+1+j*s] = v[nx+j*s];
    }
    for (let i=1; i<=nx+1; i++) {
      v[i+s] = 0;
      v[i+(ny+1)*s] = 0;
      u[i+(ny+1)*s] = u[i+ny*s];
    }
    for (let j=1; j<=ny; j++) {
      for (let i=1; i<=nx; i++) {
        const k=i+j*s;
        const free=open[k];
        if (i>1 && !(free && open[k-1])) u[k]=bodyU;
        if (j>1 && !(free && open[k-s])) v[k]=bodyV;
        const faces=open[k-1]+open[k+1]+open[k-s]+open[k+s];
        weight[k]=free && faces ? 1.72/faces : 0;
      }
    }
  }
  // Limit the corrected velocity to its source neighbourhood, then apply
  // the discrete Laplacian. Keep the old arrays intact until both components finish.
  correct(old,predicted,k,forwardX,forwardY,dt) {
    const s=this.stride;
    const reverse=this.sample(predicted,forwardX,forwardY);
    const left=old[k-1], right=old[k+1], up=old[k-s], down=old[k+s], center=old[k];
    const limited=clamp(predicted[k]+.5*(center-reverse),
      Math.min(left,right,up,down,center),Math.max(left,right,up,down,center));
    return limited+dt*this.viscosity*(left+right+up+down-4*center);
  }
  step(dt=1) {
    const {nx,ny,stride:s,u,v,nextU,nextV,open,weight} = this;
    // Explicit viscosity, semi-Lagrangian transport and a bounded
    // MacCormack correction to reduce numerical smearing of the wake.
    for (let j=1; j<=ny; j++) {
      for (let i=1; i<=nx; i++) {
        const k=i+j*s;
        const crossV=.25*(v[k]+v[k-1]+v[k+s]+v[k+s-1]);
        const crossU=.25*(u[k]+u[k+1]+u[k-s]+u[k-s+1]);
        nextU[k]=this.sample(u,i-dt*u[k],j-dt*crossV);
        nextV[k]=this.sample(v,i-dt*crossU,j-dt*v[k]);
      }
    }
    for (let j=1; j<=ny; j++) {
      let k=1+j*s;
      for (let i=1; i<=nx; i++,k++) {
        const cu=u[k], cv=v[k];
        const crossV=.25*(v[k]+v[k-1]+v[k+s]+v[k+s-1]);
        const crossU=.25*(u[k]+u[k+1]+u[k-s]+u[k-s+1]);
        this.tmpU[k]=this.correct(u,nextU,k,i+dt*cu,j+dt*crossV,dt);
        this.tmpV[k]=this.correct(v,nextV,k,i+dt*crossU,j+dt*cv,dt);
      }
    }
    this.u=this.tmpU; this.v=this.tmpV; this.tmpU=u; this.tmpV=v;

    const dx=this.targetX-this.x, dy=this.targetY-this.y;
    const blend=Math.min(1-Math.exp(-.13*dt), 1.1*dt/Math.max(.0001,Math.hypot(dx,dy)));
    const bx=dx*blend, by=dy*blend;
    this.x+=bx; this.y+=by;
    this.boundaries(bx/dt,by/dt);

    // In-place SOR pressure projection. Each local pressure increment cancels
    // divergence by correcting only faces shared with another fluid cell.
    const U=this.u, V=this.v;
    for (let iteration=0; iteration<24; iteration++) {
      for (let j=1; j<=ny; j++) {
        for (let k=1+j*s, end=k+nx; k<end; k++) {
          const p=weight[k]*(U[k+1]-U[k]+V[k+s]-V[k]);
          U[k]+=p*open[k-1]; U[k+1]-=p*open[k+1];
          V[k]+=p*open[k-s]; V[k+s]-=p*open[k+s];
        }
      }
    }
  }
}

// Each column of markers is released together. Connecting successive releases
// from the same inlet port gives a material streakline, including inside folds.
class Filaments {
  constructor(fluid) {
    this.f=fluid;
    this.rows=136;
    this.period=2;
    this.cols=Math.ceil(fluid.nx/(this.period*fluid.inlet)*1.6)+8;
    this.positionsX=new Float32Array(this.rows*this.cols);
    this.positionsY=new Float32Array(this.rows*this.cols);
    this.head=0;
    this.clock=0;
    this.tick=0;
    for(let row=0;row<this.rows;row++) {
      for(let col=0;col<this.cols;col++) {
        const k=row*this.cols+col;
        const x=1+fluid.nx*col/(this.cols-1);
        let y=this.port(row,-col*2);
        if(fluid.mode==="still") y+=.012*fluid.ny*Math.sin(4*x/fluid.ny+row*.035);
        const dx=x-fluid.x, dy=y-fluid.y, distance=Math.hypot(dx,dy);
        const inside=distance>0 && distance<fluid.radius;
        this.positionsX[k]=inside ? fluid.x+dx*fluid.radius/distance : x;
        this.positionsY[k]=clamp(inside ? fluid.y+dy*fluid.radius/distance : y,1,fluid.ny+1);
      }
    }
  }
  port(row,time) {
    const y=(row+.5)/this.rows;
    // A fine comb of dye ports. Only the injected dye position varies.
    return 1+this.f.ny*(y+.008*Math.sin(13*y+.012*time)+.004*Math.sin(29*y-.018*time));
  }
  step(dt) {
    const f=this.f;
    this.clock+=dt; this.tick+=dt;
    const emit=this.clock>=this.period && f.mode==="inflow";
    if(emit) {
      this.clock%=this.period;
      this.head=(this.head+this.cols-1)%this.cols;
    }
    const px=this.positionsX, py=this.positionsY;
    for(let k=0;k<px.length;k++) {
      let x=px[k], y=py[k];
      if(x>f.nx+2) continue;
      const vx=f.sample(f.u,x,y-.5), vy=f.sample(f.v,x-.5,y);
      const mx=x+.5*dt*vx, my=y+.5*dt*vy;
      x+=dt*f.sample(f.u,mx,my-.5);
      y+=dt*f.sample(f.v,mx-.5,my);
      const dx=x-f.x, dy=y-f.y, distance=Math.hypot(dx,dy);
      if(distance<f.radius && distance>0) {
        x=f.x+dx*f.radius/distance;
        y=f.y+dy*f.radius/distance;
      }
      px[k]=Math.max(1,x);
      py[k]=clamp(y,1,f.ny+1);
    }
    if(emit) {
      for(let row=0;row<this.rows;row++) {
        const k=row*this.cols+this.head;
        px[k]=1; py[k]=this.port(row,this.tick);
      }
    }
  }
}

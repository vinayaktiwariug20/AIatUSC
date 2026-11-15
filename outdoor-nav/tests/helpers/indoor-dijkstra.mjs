// Independent test oracle: decode NAV, materialize its adjacency, then run Dijkstra.
// Does not import M3, call its search, or reuse its heuristic/priority queue.
export function createDijkstraOracle(nav) {
  const bytes=Buffer.from(nav.nodes,'base64');
  const records=Array.from({length:nav.count},(_,id)=>{
    const i=bytes.readInt16LE(id*8),j=bytes.readInt16LE(id*8+2),height=bytes.readInt16LE(id*8+4)/100;
    return {i,j,height,point:[nav.x0+(i+.5)*nav.cell,height,nav.z0+(j+.5)*nav.cell]};
  });
  const cells=new Map();
  records.forEach((node,id)=>{const key=node.j*nav.nx+node.i;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(id);});
  const adjacency=records.map(node=>{
    const edges=[];
    for(let dj=-1;dj<=1;dj++)for(let di=-1;di<=1;di++) {
      if(!di&&!dj)continue;
      const i=node.i+di,j=node.j+dj;if(i<0||j<0||i>=nav.nx||j>=nav.nz)continue;
      for(const id of cells.get(j*nav.nx+i)||[]) {
        const other=records[id];
        // Preserve the reference graph's edge-existence rule, including stairs.
        if(Math.abs(other.height-node.height)>.24*(di&&dj?1.414:1))continue;
        const distance=Math.hypot(...node.point.map((v,c)=>other.point[c]-v));
        edges.push({to:id,distance});
      }
    }
    return edges;
  });
  return {
    adjacency,points:records.map(record=>record.point),
    solve(start,target) {
      const distances=new Float64Array(nav.count).fill(Infinity),previous=new Int32Array(nav.count).fill(-1);
      const queue=[];
      function insert(entry) {
        queue.push(entry);let index=queue.length-1;
        while(index>0){const parent=(index-1)>>1;if(queue[parent].distance<=entry.distance)break;queue[index]=queue[parent];index=parent;}queue[index]=entry;
      }
      function remove() {
        const first=queue[0],last=queue.pop();
        if(queue.length){let index=0;while(index*2+1<queue.length){let child=index*2+1;if(child+1<queue.length&&queue[child+1].distance<queue[child].distance)child++;if(queue[child].distance>=last.distance)break;queue[index]=queue[child];index=child;}queue[index]=last;}
        return first;
      }
      distances[start]=0;insert({id:start,distance:0});
      while(queue.length) {
        const entry=remove();if(entry.distance!==distances[entry.id])continue;
        if(entry.id===target){const path=[];for(let id=target;id!==-1;id=previous[id])path.push(id);return {distance:entry.distance,path:path.reverse()};}
        for(const edge of adjacency[entry.id]) {
          const distance=entry.distance+edge.distance;
          if(distance<distances[edge.to]){distances[edge.to]=distance;previous[edge.to]=entry.id;insert({id:edge.to,distance});}
        }
      }
      return null;
    },
  };
}

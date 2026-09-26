import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
const el = id => document.getElementById('fk-' + id);
const buttons = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {print:'打印',catalog:'采购',machine:'加工'};
const sources = {visible:'图片可见',inferred:'结构推断',selected:'设计选择'};
const state = {data:null,view:'product',selected:null,meshes:[],sequence:0,scale:100,center:new THREE.Vector3()};
let renderer,scene,camera,controls,group,grid;
try {
  renderer = new THREE.WebGLRenderer({canvas:el('canvas'),antialias:true,alpha:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.setClearColor(0,0);
  scene=new THREE.Scene(); camera=new THREE.PerspectiveCamera(38,1,.1,1000000); camera.up.set(0,0,1);
  controls=new OrbitControls(camera,el('canvas')); controls.enableDamping=true;
  scene.add(new THREE.HemisphereLight(0xffffff,0x91a0b8,2.5));
  const key=new THREE.DirectionalLight(0xffffff,3);key.position.set(2,-3,5);scene.add(key);
  const fill=new THREE.DirectionalLight(0xb7d7ff,2);fill.position.set(-4,3,2);scene.add(fill);
  group=new THREE.Group();scene.add(group);
  const resize=()=>{const r=el('canvas').parentElement.getBoundingClientRect();renderer.setSize(r.width,r.height,false);camera.aspect=r.width/r.height;camera.updateProjectionMatrix()};
  new ResizeObserver(resize).observe(el('canvas').parentElement);resize();
  renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera)});
  let down;
  el('canvas').addEventListener('pointerdown',e=>down=[e.clientX,e.clientY]);
  el('canvas').addEventListener('pointerup',e=>{
    if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;
    const rect=el('canvas').getBoundingClientRect(),ray=new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),camera);
    const hit=ray.intersectObjects(state.meshes)[0];if(hit)select(hit.object.userData.id);
  });
} catch(error) {
  el('view-error').hidden=false;el('view-error').textContent='当前浏览器无法启用三维视图。仍可查看零件清单、验证说明与下方操作回放。';
}
function clear(){
  if(!group)return;
  while(group.children.length){const item=group.children[0];group.remove(item);item.geometry.dispose();item.material.dispose()}
  state.meshes=[];
  if(grid){scene.remove(grid);grid.geometry.dispose();grid.material.dispose();grid=null}
}
function fit(){
  if(!state.meshes.length)return;
  const box=new THREE.Box3().setFromObject(group),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());
  const radius=Math.max(size.x,size.y,size.z,10);controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(1.2,-1.55,1.05).normalize().multiplyScalar(radius*(camera.aspect<1?3.1:2.15)));
  camera.near=radius/1000;camera.far=radius*100;camera.updateProjectionMatrix();controls.update();
}
function explode(){
  const t=Number(el('explode').value)/100;
  for(const mesh of state.meshes){const dir=mesh.userData.center.clone().sub(state.center);if(dir.length()<.001)dir.set(0,0,1);mesh.position.copy(dir.normalize().multiplyScalar(state.scale*t*.48));const edge=group.children.find(x=>x.userData.edgeFor===mesh.userData.id);if(edge)edge.position.copy(mesh.position)}
}
function activeParts(){const ids=new Set(state.data.scene[state.view].map(p=>p.id));return state.data.parts.filter(p=>ids.has(p.id))}
function tree(){
  const groups={};for(const p of activeParts())(groups[p.group]??=[]).push(p);
  el('parts').innerHTML=Object.entries(groups).map(([name,parts])=>`<h4>${esc(name)}</h4>${parts.map(p=>`<button data-fk-part="${esc(p.id)}" aria-pressed="${p.id===state.selected}"><i></i><span>${esc(p.name)}</span><small>${labels[p.route]}</small></button>`).join('')}`).join('');
  buttons('[data-fk-part]').forEach(b=>b.onclick=()=>select(b.dataset.fkPart));
  el('part-count').textContent=activeParts().length+' 件';
}
function select(id){
  state.selected=id;const p=state.data.parts.find(p=>p.id===id);if(!p)return;
  tree();for(const mesh of state.meshes){mesh.material.emissive.set(mesh.userData.id===id?0x183a86:0);mesh.material.emissiveIntensity=.3}
  el('inspector').innerHTML=`<span>${sources[p.source]} · ${esc(p.id)}</span><h3>${esc(p.name)}</h3><p>${esc(p.purpose)}</p><dl><dt>制造路线</dt><dd>${labels[p.route]}${p.route==='machine'?' · 毛坯几何':''}</dd><dt>材料</dt><dd>${esc(p.material)}</dd><dt>尺寸</dt><dd>${p.size.map(n=>Math.round(n*10)/10).join(' × ')} mm</dd><dt>证据层级</dt><dd>概念几何；物理性能待验证</dd></dl>`;
}
function draw(){
  if(!state.data)return;
  buttons('[data-fk-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.fkView===state.view)));
  el('case-title').textContent=state.view==='equipment'?'M₁ · 参数化龙门加工设备':state.data.title;
  clear();const meshes=state.data.scene[state.view];
  if(group){
    for(const p of meshes){const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(p.vertices,3));if(p.indices)geometry.setIndex(p.indices);geometry.computeVertexNormals();const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:p.color,roughness:.58,flatShading:true,metalness:p.route==='machine'?.5:.12,side:THREE.DoubleSide}));mesh.userData={...p,center:new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position')).getCenter(new THREE.Vector3())};group.add(mesh);state.meshes.push(mesh);const edge=new THREE.LineSegments(new THREE.EdgesGeometry(geometry,28),new THREE.LineBasicMaterial({color:0x3b516f,transparent:true,opacity:.16}));edge.userData.edgeFor=p.id;group.add(edge)}
    if(meshes.length){const box=new THREE.Box3().setFromObject(group),size=box.getSize(new THREE.Vector3());state.center=box.getCenter(new THREE.Vector3());state.scale=Math.max(size.x,size.y,size.z);grid=new THREE.GridHelper(state.scale*3,30,0xb9c6d8,0xd7dfe9);grid.rotation.x=Math.PI/2;grid.position.set(state.center.x,state.center.y,box.min.z-state.scale*.025);scene.add(grid);explode();fit()}
  }
  tree();if(meshes.length)select(meshes[0].id);
}
async function load(key){
  const sequence=++state.sequence;el('run-status').textContent='正在载入案例';
  try{
    const response=await fetch(`/fluxkernel/${key}.json`);if(!response.ok)throw Error('load failed');const data=await response.json();if(sequence!==state.sequence)return;
    state.data=data;state.view='product';el('explode').value=0;
    buttons('[data-fk-case]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.fkCase===key)));
    el('input-image').src=`/fluxkernel/${key}-input.png`;el('input-image').alt=data.label+'案例的实际输入图片';
    el('run-status').textContent=`真实运行 · ${data.duration_s.toFixed(1)} s`;
    el('proof-status').textContent=data.proof.accepted?'当前计划：条件化闭合已证明':'当前计划：尚未闭合';
    el('proof-detail').textContent=`${data.counts.steps} 个制造步骤，展开 ${data.counts.equipment_parts} 个设备部件。Lean 检查依赖与路线；物理制造能力仍待验证。`;
    el('assumptions').innerHTML=data.assumptions.map(s=>`<li>${esc(s)}</li>`).join('');el('gaps').innerHTML=data.gaps.map(s=>`<li>${esc(s)}</li>`).join('');draw();
  }catch(error){el('run-status').textContent='案例载入失败，请刷新重试'}
}
buttons('[data-fk-case]').forEach(b=>b.onclick=()=>load(b.dataset.fkCase));
buttons('[data-fk-view]').forEach(b=>b.onclick=()=>{state.view=b.dataset.fkView;draw()});
el('explode').oninput=explode;el('fit').onclick=fit;
load('phone');

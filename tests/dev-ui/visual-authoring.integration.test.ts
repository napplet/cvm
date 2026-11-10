import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalArtifactVerifier } from '../../src/dev/local-artifact-verifier';
import { LocalNappletWorker } from '../../src/dev/local-napplet-worker';
import { canonicalJson } from '../../src/promotion/schema';

const integration=process.env.NAPPLET_RUN_VISUAL_WORKER==='1'?test:test.skip;
integration('offline Three.js and GSAP compile, conform and render in an opaque sandbox',async()=>{
  const files=[{path:'src/capabilities.json',content:'{"required":[],"optional":[]}'},{path:'src/styles.css',content:'html, body, #app { height: 100%; margin:0; } #scene { height:60%; width:100%; } #box { width:20px; height:20px; background:green; }'},{path:'src/main.ts',content:`import './styles.css';
import { runtimeHasDomain } from './domain-availability.js';
import * as THREE from 'three';
import { gsap } from 'gsap';
void runtimeHasDomain('theme');
const root=document.querySelector<HTMLElement>('#app')!;
const sceneRoot=document.createElement('div');sceneRoot.id='scene';
const box=document.createElement('div');box.id='box';
const animate=document.createElement('button');animate.textContent='Animate';
const dispose=document.createElement('button');dispose.textContent='Dispose';
root.replaceChildren(sceneRoot,box,animate,dispose);
const media=gsap.matchMedia();let tween:gsap.core.Tween|undefined;
media.add('(prefers-reduced-motion: no-preference)',()=>{tween=gsap.to(box,{x:40,duration:1,paused:true});});
root.dataset.motion=matchMedia('(prefers-reduced-motion: reduce)').matches?'reduce':'animate';
animate.onclick=()=>{tween?.progress(1);};
let cleanup=()=>{};
try {
 const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
 renderer.setPixelRatio(Math.min(devicePixelRatio,2));sceneRoot.append(renderer.domElement);
 const scene=new THREE.Scene();scene.background=new THREE.Color(0x102030);
 const camera=new THREE.PerspectiveCamera(60,1,0.1,10);camera.position.z=2;
 const geometry=new THREE.BoxGeometry(1,1,1);const material=new THREE.MeshBasicMaterial({color:0xff0000});
 scene.add(new THREE.Mesh(geometry,material));
 const resize=()=>{const {width,height}=sceneRoot.getBoundingClientRect();renderer.setSize(width,height);camera.aspect=width/Math.max(1,height);camera.updateProjectionMatrix();renderer.render(scene,camera);};
 const observer=new ResizeObserver(resize);observer.observe(sceneRoot);resize();root.dataset.webgl='rendered';
 cleanup=()=>{observer.disconnect();geometry.dispose();material.dispose();renderer.dispose();};
} catch {root.dataset.webgl='unavailable';sceneRoot.textContent='3D is unavailable in this browser';}
dispose.onclick=()=>{cleanup();media.revert();root.dataset.disposed='true';};
addEventListener('pagehide',()=>{cleanup();media.revert();},{once:true});
`}];
  const sha=new Bun.CryptoHasher('sha256').update(canonicalJson({files})).digest('hex');
  const output=await new LocalNappletWorker({deadlineMs:240000}).materialize({proposalSha256:sha,proposal:{reference:`proposal:sha256:${sha}`,sha256:sha,files}});
  let browser: Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const html=await readFile(join(output.distRoot,'index.html'),'utf8');
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){return new Response(new URL(request.url).pathname==='/host'?'<iframe sandbox="allow-scripts" src="/applet" style="width:100%;height:90vh"></iframe>':html,{headers:{'content-type':'text/html'}});}});
  try {
    expect(output.commandEvidence.every(stage=>stage.exitCode===0)).toBe(true);
    const artifact=await new LocalArtifactVerifier().verify({ownerId:'ab'.repeat(32),accountId:'visual-test',sessionId:'visual-session',actionId:'visual-action',expectedVersion:0,proposalSha256:sha,toolchainSha256:output.toolchainSha256,distRoot:output.distRoot,commandEvidence:[...output.commandEvidence]});
    expect(artifact.files.some(file=>file.path==='index.html')).toBe(true);
    expect(output.commandEvidence.map(stage=>stage.name)).toEqual(['create','init','skills','install','build','verify','conformance','dry-run']);
    browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader','--use-angle=swiftshader']});
    for(const reducedMotion of ['no-preference','reduce'] as const){
      const page=await browser.newPage({reducedMotion,viewport:{width:800,height:600}});const external:string[]=[];const errors:string[]=[];
      page.on('request',request=>{if(!request.url().startsWith(server.url.origin))external.push(request.url());});page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`${server.url}host`);const frame=page.frames().find(frame=>frame.url().endsWith('/applet'))!;
      await frame.waitForSelector('canvas');expect(await frame.locator('#app').getAttribute('data-webgl')).toBe('rendered');
      expect(await frame.evaluate(()=>{try{void parent.document;return false;}catch{return true;}})).toBe(true);
      expect(await frame.locator('canvas').evaluate(canvas=>{const element=canvas as HTMLCanvasElement;const gl=element.getContext('webgl2')!;const pixel=new Uint8Array(4);gl.readPixels(Math.floor(element.width/2),Math.floor(element.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return [...pixel];})).toEqual([255,0,0,255]);
      const width=await frame.locator('canvas').evaluate(canvas=>(canvas as HTMLCanvasElement).width);
      await page.setViewportSize({width:1000,height:700});await frame.waitForFunction(previous=>document.querySelector('canvas')!.width>previous,width);
      await frame.getByRole('button',{name:'Animate'}).click();
      const transform=await frame.locator('#box').evaluate(box=>getComputedStyle(box).transform);
      expect(transform).toBe(reducedMotion==='reduce'?'none':'matrix(1, 0, 0, 1, 40, 0)');
      await frame.getByRole('button',{name:'Dispose'}).click();expect(await frame.locator('#app').getAttribute('data-disposed')).toBe('true');
      expect(errors).toEqual([]);expect(external).toEqual([]);await page.close();
    }
  } finally {await browser?.close();await server.stop(true);await output.cleanup();}
},300000);

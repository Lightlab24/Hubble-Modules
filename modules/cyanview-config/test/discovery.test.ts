import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPingSweep } from '../src/ping.js';
import { runPingBatch, ipNumber } from '../src/ping-batch.js';
import { Discovery, networkRange } from '../src/discovery.js';
import manifest from '../src/manifest.js';
import { fixture } from './helpers.js';

test('full-page contract preserves the studio frontend identity and bridge commands',()=>{
  assert.equal(manifest.host.minimumVersion,'2.0.18');
  for(const feature of ['module-pages-v1','module-custom-pages-v1','module-custom-pages-full-page-v1','module-workspace-instances-v1','module-documents-v1','host-service-registry-v1'])assert.ok(manifest.host.requiredFeatures.includes(feature));
  assert.ok(manifest.capabilities.includes('service.page.studio'));
  assert.equal(manifest.pages.length,1);const page=manifest.pages[0]!;assert.equal(page.id,'studio');assert.equal(page.layout,'full-page');assert.equal(page.sections.length,1);
  const section=page.sections[0]!;assert.equal(section.id,'frontend');assert.equal(section.entry,'ui/index.html');
  assert.deepEqual(section.commands.map(command=>command.id),['read-plan','read-part','save-plan','save-begin','save-part','save-commit','send','send-begin','send-part','send-commit','scan','stop-scan','probe','find-rig','import-device','import-part','refresh','choice-catalogs','options','remi-state','remi-send','remi-route','camera-control-state','camera-control-mutate']);
});

test('ping sweep bounds concurrency, covers a /16 exactly and streams batches before completion',async()=>{
  const range=networkRange('10.192.0.0/16');let active=0,max=0,finished=false;const batches:{first:string;last:string}[]=[],received:string[]=[],progress:number[]=[];
  const sweep=createPingSweep(async(value,signal)=>{signal.throwIfAborted();active++;max=Math.max(max,active);batches.push(value);await new Promise(resolve=>setTimeout(resolve,1));active--;return {alive:[value.first,'10.20.1.1'],checked:ipNumber(value.last)-ipNumber(value.first)+1};});
  await sweep(range,addresses=>{assert.equal(finished,false);received.push(...addresses);},checked=>progress.push(checked),new AbortController().signal);finished=true;
  assert.equal(max,4);assert.equal(batches.length,64);assert.equal(received.length,64);assert.equal(progress.at(-1),65534);
  batches.sort((a,b)=>ipNumber(a.first)-ipNumber(b.first));assert.equal(batches[0]!.first,'10.192.0.1');assert.equal(batches.at(-1)!.last,'10.192.255.254');
  for(let i=1;i<batches.length;i++)assert.equal(ipNumber(batches[i]!.first),ipNumber(batches[i-1]!.last)+1);
});

test('cancelling a sweep settles all in-flight batches without scheduling another',async()=>{
  const controller=new AbortController();let started=0,settled=0;
  const sweep=createPingSweep(async(_value,signal)=>{started++;await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>{settled++;reject(new Error('cancelled'));},{once:true}));return {alive:[],checked:0};});
  const job=sweep(networkRange('10.192.0.0/16'),()=>assert.fail('No stale results'),()=>assert.fail('No stale progress'),controller.signal);
  assert.equal(started,4);controller.abort();await assert.rejects(job,/cancelled/);assert.equal(settled,4);assert.equal(started,4);
});

test('a frontend ping command stays active until discovery settles and Stop remains concurrent',async()=>{
  let begin!:()=>void,release!:()=>void,settled=false;
  const started=new Promise<void>(resolve=>begin=resolve),hold=new Promise<void>(resolve=>release=resolve);
  const f=fixture({}, {discovery:{ping:async(_range,_receive,_progress,signal)=>{begin();await hold;assert.equal(signal.aborted,true);settled=true;}}});
  try{
    await f.instance.start();let replied=false;
    const command=f.call('scan',{range:'127.0.0.1/32',method:'ping'}).then(()=>{replied=true;});
    await started;assert.equal(replied,false);
    await f.call('stop-scan');assert.equal(replied,false);release();await command;assert.equal(settled,true);
  }finally{release();await f.instance.dispose();}
});

test('closing the frontend cancels and settles its ping operation',async()=>{
  let begin!:()=>void,cancelled=false;
  const started=new Promise<void>(resolve=>begin=resolve),page=new AbortController();
  const f=fixture({}, {discovery:{ping:async(_range,_receive,_progress,signal)=>{begin();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{cancelled=true;resolve();},{once:true}));}}});
  try{
    await f.instance.start();const command=f.instance.call!('page.studio',{sectionId:'frontend',commandId:'scan',value:{range:'127.0.0.1/32',method:'ping'}},f.execution(page.signal));
    await started;page.abort();await assert.rejects(Promise.resolve(command),/aborted/i);assert.equal(cancelled,true);
  }finally{page.abort();await f.instance.dispose();}
});

test('ping replies are filtered through TCP and identity checks; known addresses bypass ICMP',async()=>{
  const checked:string[]=[],verified:string[]=[],updates:any[]=[];let done!:()=>void,release!:()=>void;
  const completed=new Promise<void>(resolve=>done=resolve),hold=new Promise<void>(resolve=>release=resolve);
  const discovery=new Discovery(async address=>{verified.push(address);return {id:address,serial:address==='10.192.1.51'?'10.192.1.50':address,address};},state=>{updates.push(structuredClone(state));if(state.state==='complete')done();},async address=>{checked.push(address);return !['10.192.2.50','10.192.100.235'].includes(address);},{
    seeds:async receive=>receive(['10.192.54.20']),
    ping:async(range,receive,progress)=>{receive(['10.192.1.40','10.192.1.50','10.192.1.51','10.192.2.50','10.192.100.235','10.20.1.1']);await hold;progress(range.count);},
    announcements:async()=>{assert.fail('Ping discovery must not claim UDP 3838');},
  });
  discovery.start('10.192.0.0/16');
  await new Promise(resolve=>setTimeout(resolve,5));assert.ok(updates.some(state=>state.state==='scanning'&&state.results.length===3));release();await completed;
  assert.equal(verified.length,4);assert.equal(checked.length,6);assert.ok(verified.includes('10.192.54.20'));assert.ok(!checked.includes('10.20.1.1'));
  assert.equal(discovery.progress!.results.length,3);assert.equal(discovery.progress!.results.find(row=>row.serial==='10.192.1.50')!.addresses.length,2);discovery.dispose();
});

test('the native ping runner uses four-byte payloads and rejects duplicate or unrelated output',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'cyanview-ping-test-'));const file=path.join(directory,'fping.mjs'),args=path.join(directory,'args.json');
  try{
    await writeFile(file,'#!/usr/bin/env node\nimport fs from "node:fs";fs.writeFileSync('+JSON.stringify(args)+',JSON.stringify(process.argv.slice(2)));process.stdout.write("10.192.1.10\\n10.192.1.10\\n10.20.1.10\\ngarbage\\n");process.exitCode=1;\n',{mode:0o755});
    const reply=await runPingBatch({first:'10.192.1.1',last:'10.192.1.254'},new AbortController().signal,file);
    assert.deepEqual(reply,{alive:['10.192.1.10'],checked:254});const invoked=JSON.parse(await readFile(args,'utf8'));assert.equal(invoked[invoked.indexOf('-b')+1],'4');assert.equal(invoked[invoked.indexOf('-r')+1],'0');
    await assert.rejects(()=>runPingBatch({first:'10.192.1.1',last:'10.192.9.254'},new AbortController().signal,file),/at most 1024/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('cancelling a hung native ping process waits for process termination',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'cyanview-ping-test-'));const file=path.join(directory,'fping.mjs'),pidFile=path.join(directory,'pid');
  const controller=new AbortController();
  try{
    await writeFile(file,'#!/usr/bin/env node\nimport fs from "node:fs";fs.writeFileSync('+JSON.stringify(pidFile)+',String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000);\n',{mode:0o755});
    const task=runPingBatch({first:'127.0.0.1',last:'127.0.0.1'},controller.signal,file);
    let pid=0;for(let i=0;i<200&&!pid;i++){try{pid=Number(await readFile(pidFile,'utf8'));}catch{await new Promise(resolve=>setTimeout(resolve,5));}}
    assert.ok(pid);controller.abort();await assert.rejects(task,/cancelled/);assert.throws(()=>process.kill(pid,0));
  }finally{controller.abort();await rm(directory,{recursive:true,force:true});}
});

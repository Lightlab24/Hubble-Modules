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
  assert.deepEqual(section.commands.map(command=>command.id),['read-plan','read-part','save-plan','save-begin','save-part','save-commit','send','send-begin','send-part','send-commit','scan','stop-scan','probe','find-rig','import-device','import-part','refresh','choice-catalogs','options','remi-state','remi-send','remi-route','camera-control-state','camera-control-mutate','camera-enabled','camera-refresh']);
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

// macOS drops a first packet to a host it hasn't resolved once 1024 are waiting for ARP, but still sends the ARP
// request, so the host shows up in the neighbor cache without ever having answered the probe.
const waitUntil=async(condition:()=>boolean,ms=2000)=>{const deadline=Date.now()+ms;while(!condition()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(condition(),'Timed out');};

test('a controller whose ping was dropped is found once its ARP reply reaches the neighbor cache',async()=>{
  let arp:string[]=[],final:any;const reads:number[]=[];
  const discovery=new Discovery(async address=>({id:address,serial:'CY-RCP-'+address,address}),state=>{if(state.state!=='scanning')final=state;},async()=>true,{
    // The sweep hears nothing from 10.192.46.197; the kernel resolved it while dropping the echo.
    ping:async(range,receive,progress)=>{receive(['10.192.0.10']);arp=['10.192.46.197','10.20.1.5','10.192.0.10'];await new Promise(resolve=>setTimeout(resolve,30));progress(range.count);},
    neighbors:async(_signal,accept)=>{reads.push(Date.now());return arp.filter(address=>accept?.(address)??true);},
    neighborIntervalMs:10,
  });
  discovery.start('10.192.0.0/16');await waitUntil(()=>final);
  assert.equal(final.state,'complete');assert.deepEqual(final.results.map((row:any)=>row.address).sort(),['10.192.0.10','10.192.46.197']);
  assert.ok(reads.length>=2,'reads the cache during and after the sweep');discovery.dispose();
});

test('an address whose first connection was lost gets one more check after it answers ARP',async()=>{
  let arp:string[]=[],final:any;const attempts=new Map<string,number>();
  const discovery=new Discovery(async address=>({id:address,serial:'CY-RIO-'+address,address}),state=>{if(state.state!=='scanning')final=state;},async address=>{const n=(attempts.get(address)??0)+1;attempts.set(address,n);return n>1&&address==='10.192.54.19';},{
    seeds:async receive=>receive(['10.192.54.19','10.192.54.20']),
    ping:async(range,_receive,progress)=>{await new Promise(resolve=>setTimeout(resolve,20));arp=['10.192.54.19','10.192.54.20'];progress(range.count);},
    neighbors:async()=>arp,neighborIntervalMs:5,
  });
  discovery.start('10.192.0.0/16');await waitUntil(()=>final);
  assert.deepEqual(final.results.map((row:any)=>row.address),['10.192.54.19']);
  assert.equal(attempts.get('10.192.54.19'),2);assert.equal(attempts.get('10.192.54.20'),2,'one retry only, never a loop');discovery.dispose();
});

test('a busy /16 still verifies a controller that answers after hundreds of other hosts',async()=>{
  let final:any;const others=Array.from({length:600},(_,i)=>'10.192.'+(1+Math.floor(i/250))+'.'+(1+i%250));
  const discovery=new Discovery(async address=>{if(address!=='10.192.46.197')throw new Error('Not a configurable Cyanview controller');return {id:address,serial:'CY-RCP-46-197',address};},state=>{if(state.state!=='scanning')final=state;},async()=>true,{
    seeds:async receive=>receive(others.slice(0,300)),
    ping:async(range,receive,progress)=>{receive(others.slice(300));receive(['10.192.46.197']);progress(range.count);},
  });
  discovery.start('10.192.0.0/16');await waitUntil(()=>final,5000);
  assert.deepEqual(final.results.map((row:any)=>row.serial),['CY-RCP-46-197']);discovery.dispose();
});

test('stopping a sweep stops reading the neighbor cache',async()=>{
  let reads=0,final:any;
  const discovery=new Discovery(async address=>({id:address,serial:address,address}),state=>{if(state.state!=='scanning')final=state;},async()=>false,{
    ping:async(_range,_receive,_progress,signal)=>{await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));},
    neighbors:async()=>{reads++;return [];},neighborIntervalMs:5,
  });
  discovery.start('10.192.0.0/16');await waitUntil(()=>reads>=2);discovery.stop();await waitUntil(()=>final);
  const after=reads;await new Promise(resolve=>setTimeout(resolve,40));assert.equal(final.state,'stopped');assert.equal(reads,after);
});

test('neighbor reads keep in-range addresses even behind thousands of others',async()=>{
  const { parseNeighbors } = await import('../src/neighbors.js');
  const text=Array.from({length:5000},(_,i)=>'? (172.16.'+Math.floor(i/250)+'.'+(1+i%250)+') at 02:00:00:00:00:01 on en0 ifscope [ethernet]').concat('? (10.192.46.197) at 02:00:00:6:ab:be on en7 ifscope [ethernet]','? (10.192.46.198) at (incomplete) on en7 ifscope [ethernet]').join('\n');
  assert.deepEqual(parseNeighbors(text,networkRange('10.192.0.0/16').contains),['10.192.46.197']);
  assert.equal(parseNeighbors(text).length,4096);
});

test('a tiny range still retries a known address whose check outlasts the sweep',async()=>{
  let final:any,first=true;const attempts:number[]=[],reads:number[]=[];
  const discovery=new Discovery(async address=>({id:address,serial:'CY-RCP-'+address,address}),state=>{if(state.state!=='scanning')final=state;},async()=>{attempts.push(Date.now());if(first){first=false;await new Promise(resolve=>setTimeout(resolve,60));return false;}return true;},{
    seeds:async receive=>receive(['10.192.46.197']),ping:async(range,_receive,progress)=>progress(range.count),
    neighbors:async()=>{reads.push(Date.now()-began);return ['10.192.46.197'];},neighborIntervalMs:1000,
  });
  const began=Date.now();discovery.start('10.192.46.197/32');await waitUntil(()=>final);
  // The final read starts as the sweep ends, not after the slow check, and the retry reuses it.
  assert.equal(reads.length,1);assert.ok(reads[0]!<40,'read at '+reads[0]+' ms');assert.equal(attempts.length,2);assert.deepEqual(final.results.map((row:any)=>row.address),['10.192.46.197']);discovery.dispose();
});

test('Full IP scan is gone, and a page asking for it gets a clear refusal',async()=>{
  const discovery=new Discovery(async()=>assert.fail('No checks'),()=>{},async()=>assert.fail('No checks'));
  assert.throws(()=>discovery.start('10.192.10.0/24','ip' as any),/Choose a discovery method/);discovery.dispose();
});

test('saved devices are checked before the sweep at every address they had, whatever the range',async()=>{
  const steps:string[]=[],states:any[]=[];let final:any;
  const known:Record<string,string>={'10.20.5.5':'CY-RIO-9-1','10.192.9.2':'CY-RCP-9-2'};
  const discovery=new Discovery(async address=>{steps.push('probe '+address);const serial=known[address];if(!serial)throw new Error('Nothing there');return {id:serial,serial,address};},
    state=>{states.push(structuredClone(state));if(state.state!=='scanning')final=state;},
    async address=>{steps.push('reach '+address);return address in known;},{
    saved:async()=>[
      // Its first address no longer answers, and its second is outside the range being searched.
      {serial:'CY-RIO-9-1',addresses:['10.192.9.1','10.20.5.5']},
      {serial:'CY-RCP-9-2',addresses:['10.192.9.2']},
      {serial:'CY-RCP-9-3',addresses:['10.192.9.3']},
    ],
    ping:async(range,receive,progress)=>{steps.push('sweep');receive(['10.192.9.2','10.192.9.4']);progress(range.count);},
  });
  discovery.start('10.192.0.0/16');await waitUntil(()=>final);
  const sweep=steps.indexOf('sweep');
  for(const address of ['10.192.9.1','10.20.5.5','10.192.9.2','10.192.9.3'])assert.ok(steps.indexOf('reach '+address)<sweep,address+' is checked before the sweep');
  // The sweep hears a saved address too, which isn't checked twice.
  assert.equal(steps.filter(step=>step==='reach 10.192.9.2').length,1);
  assert.ok(states.some(state=>state.saved.length===3&&state.saved.every((item:any)=>item.state==='checking')),'listed as checking straight away');
  assert.equal(final.state,'complete');
  assert.deepEqual(final.saved,[{serial:'CY-RIO-9-1',state:'found'},{serial:'CY-RCP-9-2',state:'found'},{serial:'CY-RCP-9-3',state:'missing'}]);
  assert.deepEqual(final.results.map((row:any)=>row.serial).sort(),['CY-RCP-9-2','CY-RIO-9-1']);
  discovery.dispose();
});

test('a saved device answering with another serial is still missing, and broadcast discovery checks saved devices too',async()=>{
  let final:any;
  const discovery=new Discovery(async address=>({id:'CY-RIO-7-7',serial:'CY-RIO-7-7',address}),state=>{if(state.state!=='scanning')final=state;},async()=>true,{
    saved:async()=>[{serial:'CY-RCP-7-1',addresses:['10.192.7.1']}],
    announcements:async(_receive,signal)=>{await new Promise<void>(resolve=>signal.aborted?resolve():signal.addEventListener('abort',()=>resolve(),{once:true}));},
    durationMs:50,
  });
  discovery.start('10.192.0.0/16','broadcast');await waitUntil(()=>final);
  assert.deepEqual(final.saved,[{serial:'CY-RCP-7-1',state:'missing'}]);
  assert.deepEqual(final.results.map((row:any)=>row.serial),['CY-RIO-7-7']);
  discovery.dispose();
});

test('camera logins and saved devices are kept with the workspace, and Discover only checks saved devices not in the list',async()=>{
  const reached:string[]=[];
  const f=fixture({}, {reachable:async address=>{reached.push(address);return false;},discovery:{ping:async(range,_receive,progress)=>progress(range.count)}});
  try{
    await f.instance.start();
    const plan={formatVersion:1,devices:[{id:'CY-RCP-1-20',serial:'CY-RCP-1-20',name:'Master RCP',kind:'RCP',base:'10.192.1.20',address:'10.192.1.20'}],cameras:[],lans:[],uiState:null,
      cameraLogins:[{model:'Burano',login:'admin',password:'Burano2026'},{model:'Panasonic - AW-UE150',login:'admin',password:'12345'}],
      savedDevices:[{serial:'CY-RCP-1-20',name:'Master RCP',kind:'RCP',base:'10.192.1.20',address:'10.192.1.20'},{serial:'CY-RIO-1-60',name:'Spare RIO',kind:'RIO',base:'10.192.1.60',address:''}]};
    const saved:any=await f.call('save-plan',{revision:null,plan});
    const read:any=await f.call('read-plan');
    assert.deepEqual(read.plan.cameraLogins,plan.cameraLogins);
    assert.deepEqual(read.plan.savedDevices,plan.savedDevices);
    // A list that doesn't check out is refused rather than saved in part.
    await assert.rejects(f.call('save-plan',{revision:saved.revision,plan:{...plan,savedDevices:[{serial:'not a serial',base:'10.192.1.1'}]}}),/Invalid saved devices/);
    await assert.rejects(f.call('save-plan',{revision:saved.revision,plan:{...plan,cameraLogins:[{model:'Burano',login:'admin',password:'x'.repeat(161)}]}}),/Invalid camera logins/);
    await f.call('scan',{range:'127.0.0.1/32',method:'ping'});
    const scan=(f.states.at(-1) as any).values.discovery;
    assert.deepEqual(scan.saved,[{serial:'CY-RIO-1-60',state:'missing'}]);
    assert.ok(reached.includes('10.192.1.60'));
    // Logins never leave the worker in its published state.
    assert.doesNotMatch(JSON.stringify(f.states),/Burano2026/);
  }finally{await f.instance.dispose();}
});

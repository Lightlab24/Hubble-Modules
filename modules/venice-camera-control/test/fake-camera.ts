import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { encode,decode } from '@msgpack/msgpack';

export interface FakeCameraOptions { values?:Record<string,string>; status?:(property:string)=>unknown; readDelay?:number; writeDelay?:number; loginDelay?:number; statusFails?:boolean; rejectLogin?:boolean; dropSocket?:boolean; camProperties?:string[]; shutterMenu?:boolean; rejectSubscribe?:boolean }
/** Answers the camera's login and its property calls on a loopback port. No real camera is involved. */
export async function fakeCamera(options:FakeCameraOptions={}) {
  const values={...options.values},writes:Record<string,unknown>[]=[],reads:string[][]=[],statusRequests:Record<string,unknown>[]=[],capabilityRequests:unknown[]=[];
  let logins=0,keepAlives=0,muted=false;
  const subscribes:unknown[]=[],subscribers=new Set<{send(data:Uint8Array):void}>();
  const shown=(key:string)=>options.camProperties?.includes(key)?{cam:values[key]}:values[key];
  const server=http.createServer((request,response)=>{
    const answer=()=>{
      if(request.url==='/rmt.html'){response.writeHead(401,{'WWW-Authenticate':'Digest realm="fixture", nonce="fixture-nonce", algorithm=MD5, qop="auth"'});response.end();}
      else if(request.url==='/cgi-bin/getsavonacred.cgi'){logins++;if(options.rejectLogin){response.writeHead(401);response.end();}else{response.writeHead(200);response.end('internal:fixture-session');}}
      else{response.writeHead(404);response.end();}
    };
    if(options.loginDelay)setTimeout(answer,options.loginDelay);else answer();
  });
  const sockets=new WebSocketServer({server});
  sockets.on('connection',socket=>{if(options.dropSocket)socket.terminate();socket.on('close',()=>subscribers.delete(socket));socket.on('message',bytes=>{
    const [,id,method,args]=decode(bytes as Uint8Array) as any[];const params=args[0];let result:any=null,error:any=null,wait=0;
    if(method==='Property.GetValue'&&'Network.Connection.KeepAlive' in params){keepAlives++;if(muted)return;result={'Network.Connection.KeepAlive':{cam:true}};}
    else if(method==='Notify.Subscribe'){subscribes.push(params);if(options.rejectSubscribe)error=[-1,'unsupported'];else subscribers.add(socket);}
    else if(method==='Property.GetValue'){reads.push(Object.keys(params));result=Object.fromEntries(Object.keys(params).map(key=>[key,shown(key)]));wait=options.readDelay??0;}
    else if(method==='Property.GetStatus'){statusRequests.push(params);if(options.statusFails)error=[-1,'unsupported'];else result=Object.fromEntries(Object.keys(params).map(key=>[key,options.status?.(key)]));}
    else if(method==='Capability.GetValue'){capabilityRequests.push(params);result={};}
    else if(method==='Property.SetValue'){writes.push(params);setTimeout(()=>{
      if(options.shutterMenu&&'P.System.Menu.ShutterMode' in params)values['Camera.Shutter.Mode']=String(params['P.System.Menu.ShutterMode'])==='1'?'Angle':'Speed';
      const{['Camera.Shutter.Mode']:ignored,...kept}=params;Object.assign(values,options.shutterMenu?kept:params);
    },options.writeDelay??5);}
    const reply=()=>socket.send(encode([1,id,error,result]));
    if(wait)setTimeout(reply,wait);else reply();
  });});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const host='127.0.0.1:'+(server.address() as {port:number}).port;
  let closed=false;
  const notify=(changes:Record<string,unknown>)=>{Object.assign(values,changes);const wire=Object.fromEntries(Object.keys(changes).map(key=>[key,shown(key)]));for(const socket of subscribers)socket.send(encode([2,'Notify.Property.Value.Changed',[wire]]));};
  return {host,values,writes,reads,statusRequests,capabilityRequests,subscribes,notify,mute:(value:boolean)=>{muted=value;},get logins(){return logins;},get keepAlives(){return keepAlives;},get subscribers(){return subscribers.size;},close:()=>new Promise<void>(resolve=>{if(closed){resolve();return;}closed=true;for(const socket of sockets.clients)socket.terminate();sockets.close(()=>{server.close(()=>resolve());server.closeAllConnections();});})};
}
/** A loopback address nothing is listening on, like a camera that's switched off. */
export async function absentCameraHost():Promise<string>{
  const server=http.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const host='127.0.0.1:'+(server.address() as {port:number}).port;
  await new Promise<void>(resolve=>server.close(()=>resolve()));return host;
}

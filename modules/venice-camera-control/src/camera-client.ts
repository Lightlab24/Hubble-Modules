import http from 'node:http';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { encode, decodeMulti } from '@msgpack/msgpack';
import { validHost } from './model.js';

export interface Credentials { username:string; password:string }
export interface RpcClient { rpc(method:string,params:unknown,signal?:AbortSignal):Promise<any>; close():void }
/** The connection never came up or was lost, as opposed to a camera that answered and refused. */
export class CameraOfflineError extends Error {}
export class CameraClient implements RpcClient {
  private socket?:WebSocket;
  private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>;stop:()=>void}>();
  private next=crypto.randomInt(1,0x3fffffff);
  private closed=false;
  /** Set by whoever keeps this connection open to receive what the camera pushes. */
  onNotification?:(name:string,data:unknown)=>void;
  onClosed?:()=>void;
  private stopLifetime?:()=>void;
  private constructor(private host:string,private signal:AbortSignal){}
  static async connect(host:string,credentials:Credentials,signal:AbortSignal):Promise<CameraClient>{
    if(!validHost(host))throw Error('Invalid camera address.');
    signal.throwIfAborted();
    const client=new CameraClient(host,signal);
    const abort=()=>client.close();
    signal.addEventListener('abort',abort,{once:true});client.stopLifetime=()=>signal.removeEventListener('abort',abort);
    try {
      const internal=await client.getInternalCredentials(credentials);
      const authorization=await client.authorization(credentials,'/linear');
      client.socket=new WebSocket('ws://'+host+'/linear',{origin:'http://'+host,headers:{Authorization:authorization},handshakeTimeout:4500,maxPayload:1024*1024});
      const socket=client.socket;
      socket.on('message',data=>{
        try {
          const bytes=data instanceof Buffer?data:Buffer.from(data as ArrayBuffer);
          for(const frame of decodeMulti(bytes)) {
            if(Array.isArray(frame)&&frame[0]===2){client.onNotification?.(String(frame[1]),frame[2]);continue;}
            if(!Array.isArray(frame)||frame[0]!==1)continue;
            const request=client.pending.get(Number(frame[1]));if(!request)continue;
            client.pending.delete(Number(frame[1]));clearTimeout(request.timer);request.stop();
            if(frame[2]!=null){const code=Array.isArray(frame[2])&&typeof frame[2][0]==='number'?frame[2][0]:'error';request.reject(Error('Camera rejected the request ('+code+').'));}
            else request.resolve(frame[3]);
          }
        } catch { client.fail(Error('Camera sent an invalid protocol response.')); }
      });
      socket.on('close',()=>{client.fail(new CameraOfflineError('Camera connection closed.'));client.onClosed?.();});
      socket.on('error',()=>client.fail(new CameraOfflineError('Camera WebSocket connection failed.')));
      await new Promise<void>((resolve,reject)=>{
        const abortOpen=()=>{cleanup();reject(Error('Camera connection cancelled.'));};
        const open=()=>{cleanup();resolve();};
        const error=()=>{cleanup();reject(new CameraOfflineError('Camera WebSocket connection failed.'));};
        const cleanup=()=>{signal.removeEventListener('abort',abortOpen);socket.off('open',open);socket.off('error',error);};
        signal.addEventListener('abort',abortOpen,{once:true});socket.once('open',open);socket.once('error',error);
        if(signal.aborted)abortOpen();
      });
      await client.rpc('Alternate.Authentication.Basic',internal,signal);
      return client;
    } catch(error){client.close();throw error;}
  }
  private get(uri:string,headers:Record<string,string>={}):Promise<{status:number;headers:http.IncomingHttpHeaders;text:string}> {
    this.signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const request=http.get('http://'+this.host+uri,{headers,signal:this.signal},response=>{
        let text='';response.setEncoding('utf8');
        response.on('data',chunk=>{text+=chunk;if(text.length>4096)request.destroy();});
        response.on('end',()=>{if(text.length>4096)reject(Error('Unexpected camera authentication response.'));else resolve({status:response.statusCode??0,headers:response.headers,text});});
        response.on('error',()=>reject(new CameraOfflineError('Camera authentication response failed.')));
      });
      request.setTimeout(4500,()=>request.destroy());
      request.on('error',()=>reject(this.signal.aborted?Error('Camera request cancelled.'):new CameraOfflineError('Camera HTTP connection failed.')));
    });
  }
  private async authorization(credentials:Credentials,uri:string):Promise<string>{
    const response=await this.get('/rmt.html');
    const challenge=response.headers['www-authenticate'];
    if(typeof challenge!=='string'||!challenge.startsWith('Digest '))throw Error('Camera did not supply the tested Digest authentication scheme.');
    const p=Object.fromEntries([...challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(m=>[m[1]!,m[2]??m[3]??'']));
    if((p.algorithm??'MD5')!=='MD5'||!p.qop?.split(',').map(s=>s.trim()).includes('auth'))throw Error('Unsupported camera authentication parameters.');
    const md5=(s:string)=>crypto.createHash('md5').update(s).digest('hex'),nc='00000001',cnonce=crypto.randomBytes(16).toString('hex');
    const digest=md5([md5(credentials.username+':'+p.realm+':'+credentials.password),p.nonce,nc,cnonce,'auth',md5('GET:'+uri)].join(':'));
    const quote=(s:string)=>'"'+s.replace(/["\\]/g,'\\$&')+'"';
    return 'Digest '+Object.entries({username:credentials.username,realm:p.realm!,nonce:p.nonce!,uri,response:digest,algorithm:'MD5',qop:'auth',nc,cnonce,...(p.opaque?{opaque:p.opaque}:{})}).map(([k,v])=>k+'='+(['algorithm','qop','nc'].includes(k)?v:quote(v))).join(', ');
  }
  private async getInternalCredentials(credentials:Credentials):Promise<Credentials>{
    const uri='/cgi-bin/getsavonacred.cgi',authorization=await this.authorization(credentials,uri);
    const response=await this.get(uri,{Authorization:authorization});
    if(response.status!==200)throw Error('Camera login was not accepted.');
    const colon=response.text.indexOf(':');
    if(colon<1)throw Error('Invalid camera session credentials.');
    return {username:response.text.slice(0,colon),password:response.text.slice(colon+1).trimEnd()};
  }
  rpc(method:string,params:unknown,signal:AbortSignal=this.signal,timeoutMs=5000):Promise<any>{
    signal.throwIfAborted();
    if(this.closed||this.socket?.readyState!==WebSocket.OPEN)return Promise.reject(new CameraOfflineError('Camera is disconnected.'));
    const id=++this.next;
    return new Promise((resolve,reject)=>{
      const abort=()=>{const p=this.pending.get(id);if(!p)return;this.pending.delete(id);clearTimeout(p.timer);p.stop();reject(Error('Camera request cancelled.'));};
      const stop=()=>signal.removeEventListener('abort',abort);
      const timer=setTimeout(()=>{this.pending.delete(id);stop();reject(new CameraOfflineError('Camera request timed out. It was not replayed.'));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer,stop});signal.addEventListener('abort',abort,{once:true});
      this.socket!.send(encode([0,id,method,[params]]),error=>{if(error){clearTimeout(timer);stop();this.pending.delete(id);reject(new CameraOfflineError('Camera request could not be submitted.'));}});
    });
  }
  private fail(error:Error){for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.stop();pending.reject(error);}this.pending.clear();}
  close(){if(this.closed)return;this.closed=true;this.stopLifetime?.();this.fail(Error('Camera connection closed.'));this.socket?.terminate();}
}

import { execFile } from 'node:child_process';

export type PingResult='answered'|'silent'|'unknown';
const noReply=2,unknownHost=68;
/**
 * A 4-byte ICMP echo, stopping at the first reply. The second packet covers the first one being
 * lost while the network finds a camera that has been idle. 'unknown' means ping itself couldn't
 * run, which says nothing about the camera.
 */
export function pingCamera(host:string,signal:AbortSignal):Promise<PingResult> {
  const address=host.replace(/:\d+$/,'');
  return new Promise(resolve=>{
    execFile('/sbin/ping',['-n','-q','-o','-c','2','-s','4','-t','2',address],{signal,timeout:3000},error=>{
      if(!error)resolve('answered');
      else resolve(error.code===noReply||error.code===unknownHost?'silent':'unknown');
    });
  });
}

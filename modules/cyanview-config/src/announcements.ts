import dgram from 'node:dgram';
import { validIp } from './model.js';

export type DeviceAnnouncement = { role: string; serialHint: string; addresses: string[] };
export type AnnouncementListener = (receive: (device: DeviceAnnouncement) => void, signal: AbortSignal) => Promise<void>;

// Observed Cyanview UDP/3838 packets are whitespace-delimited announcements.
// Treat every address as a hint; the UI only receives identities verified over WebSocket.
export function parseAnnouncement(packet: Buffer, source: string): DeviceAnnouncement | null {
  if (packet.length > 2048 || !validIp(source)) return null;
  const fields = packet.toString('utf8').trim().split(/\s+/);
  const role = fields[0]?.toLowerCase();
  if (!['rcp', 'rio', 'gateway', 'gwy'].includes(role ?? '')) return null;
  const serial = fields.slice(1).map(field => /^(?:cy-)?(rcp|rio|gateway|gwy)-(\d{1,3})-(\d{1,3})$/i.exec(field)).find(Boolean);
  if (!serial || Number(serial[2]) > 255 || Number(serial[3]) > 255) return null;
  const serialHint = `CY-${serial[1]!.toUpperCase()}-${Number(serial[2])}-${Number(serial[3])}`;
  const factory = `10.192.${Number(serial[2])}.${Number(serial[3])}`;
  const advertised = fields.map(field => field.replace(/\.$/, '')).filter(validIp);
  return { role: role!, serialHint, addresses: [...new Set([factory, source, ...advertised])] };
}

export const listenAnnouncements: AnnouncementListener = (receive, signal) => {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let closed = false;
    const finish = (error?: Error) => {
      if (closed) return; closed = true;
      signal.removeEventListener('abort', abort);
      try { socket.close(); } catch { /* The socket may have failed before binding. */ }
      if (error) reject(error); else resolve();
    };
    const abort = () => finish();
    signal.addEventListener('abort', abort, { once: true });
    socket.on('message', (packet, remote) => { const hint = parseAnnouncement(packet, remote.address); if (!closed && hint) receive(hint); });
    socket.on('error', () => finish(new Error('Broadcast discovery is unavailable. Known device addresses and Find by IP still work.')));
    socket.bind(3838, '0.0.0.0');
    if (signal.aborted) abort();
  });
};

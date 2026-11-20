import { z } from "zod";
import type {
  SwitcherDeviceRow,
  SwitcherDeviceSettings,
  SwitcherReading,
} from "./switcher/index.js";

/** What the Setup tab saves about the switcher. Portable: it travels with the workspace. */
export const SWITCHER_DOCUMENT_ID = "switcher";
export const OFFSETS = [0, 10000, 20000, 30000, 40000, 50000] as const;
/** The switcher keeps eight characters. Printable ASCII only, and no space at either end. */
export const DeviceNameSchema = z
  .string()
  .regex(/^[\x21-\x7e](?:[\x20-\x7e]{0,6}[\x21-\x7e])?$/u, "Use 1 to 8 letters or numbers");
export const SwitcherDocumentSchema = z.strictObject({
  host: z.string().trim().max(253).default(""),
  name: DeviceNameSchema.default("HUBBLE"),
  /** Empty means the address this computer uses to reach the switcher. */
  sendTo: z.union([z.literal(""), z.ipv4()]).default(""),
  enabled: z.boolean().default(true),
  screen: z.int().min(0).max(65534).default(0),
  offset: z
    .union([
      z.literal(0),
      z.literal(10000),
      z.literal(20000),
      z.literal(30000),
      z.literal(40000),
      z.literal(50000),
    ])
    .default(0),
  brightness: z.int().min(0).max(3).default(1),
  center: z.boolean().default(false),
  fsfc: z.boolean().default(false),
  busName: z.boolean().default(false),
  umdId: z.boolean().default(false),
  oneSecond: z.boolean().default(false),
  header: z.boolean().default(false),
});
export type SwitcherDocument = z.infer<typeof SwitcherDocumentSchema>;
export const defaultSwitcherDocument = (): SwitcherDocument => SwitcherDocumentSchema.parse({});

/** The receiver settings a switcher has to agree with. */
export interface ReceiverLink {
  readonly protocol: "3.1" | "5.0";
  readonly transport: "udp" | "tcp";
  readonly port: number;
  readonly bindAddress: string;
}
export const ReceiverSettingsSchema = z.object({
  protocol: z.enum(["3.1", "5.0"]).default("3.1"),
  transport: z.enum(["udp", "tcp"]).default("tcp"),
  bindAddress: z.ipv4().default("0.0.0.0"),
  port: z.int().min(1).max(65535).default(5727),
  sourceAddress: z.union([z.literal(""), z.ipv4()]).default(""),
  staleAfterMs: z
    .union([z.literal(0), z.int().min(1000).max(3_600_000)])
    .default(0),
  routingPeer: z.string().default(""),
});
export type ReceiverSettings = z.infer<typeof ReceiverSettingsSchema>;

/** The device Hubble wants on the switcher: the page's choices plus what this computer listens for. */
export function wantedDevice(
  document: SwitcherDocument,
  receiver: ReceiverLink,
  sendTo: string,
): SwitcherDeviceSettings {
  return {
    name: document.name,
    ip: sendTo,
    port: receiver.port,
    protocol: receiver.protocol,
    transport: receiver.transport,
    enabled: document.enabled,
    screen: document.screen,
    offset: document.offset,
    brightness: document.brightness as 0 | 1 | 2 | 3,
    center: document.center,
    fsfc: document.fsfc,
    busName: document.busName,
    umdId: document.umdId,
    oneSecond: document.oneSecond,
    header: document.header,
  };
}

export type Tone = "ok" | "idle" | "warn" | "bad";
export interface LinkStatus {
  readonly tone: Tone;
  readonly title: string;
  readonly text: string;
  /** What Match switcher would set on this computer, when the two ends differ there. */
  readonly match: Pick<ReceiverLink, "protocol" | "transport" | "port"> | null;
}
const format = (link: Pick<ReceiverLink, "protocol" | "transport">) =>
  `TSL ${link.protocol} over ${link.transport.toUpperCase()}`;

/**
 * Whether the switcher's device and this computer's receiver agree. A reading is what the
 * switcher last told us; nothing here reaches the switcher.
 */
export function linkStatus(input: {
  readonly receiver: ReceiverLink;
  readonly reading: SwitcherReading | null;
  readonly readError: string | null;
  readonly localAddresses: readonly string[];
  readonly listening: boolean;
}): LinkStatus {
  const none = (tone: Tone, title: string, text: string): LinkStatus => ({ tone, title, text, match: null });
  if (input.readError) return none("bad", "Switcher offline", input.readError);
  if (!input.reading) return none("idle", "Not checked", "Read the switcher to see what it sends");
  const mine = input.reading.mine;
  if (!mine) return none("idle", "Not set up", "The switcher has no device for this computer. Send to switcher adds one");
  if (!mine.settings)
    return none("idle", "Not checked", "Someone is editing devices on the switcher, so its settings couldn't be read");
  const theirs = mine.settings;
  const receiver = input.receiver;
  const differs =
    theirs.protocol !== receiver.protocol || theirs.transport !== receiver.transport || theirs.port !== receiver.port;
  if (differs)
    return {
      tone: "warn",
      title: "Not matched",
      text: `The switcher sends ${format(theirs)} to port ${theirs.port}. This computer listens for ${format(receiver)} on port ${receiver.port}`,
      match: { protocol: theirs.protocol, transport: theirs.transport, port: theirs.port },
    };
  if (!input.localAddresses.includes(theirs.ip))
    return none("warn", "Not matched", `The switcher sends to ${theirs.ip}, which isn't one of this computer's addresses`);
  if (receiver.bindAddress !== "0.0.0.0" && receiver.bindAddress !== theirs.ip)
    return none("warn", "Not matched", `The switcher sends to ${theirs.ip}, but this computer listens only on ${receiver.bindAddress}`);
  if (!theirs.enabled) return none("warn", "Not matched", "The device is switched off on the switcher");
  if (!input.listening) return none("warn", "Not listening", "The settings match, but this computer isn't listening");
  return none(
    "ok",
    "Matched",
    `The switcher sends ${format(theirs)} to ${theirs.ip} : ${theirs.port}, and this computer is listening for it`,
  );
}

const SENT_FIELDS = [
  "ip", "port", "protocol", "transport", "enabled", "screen", "offset", "brightness",
  "center", "fsfc", "busName", "umdId", "oneSecond", "header",
] as const satisfies readonly (keyof SwitcherDeviceSettings)[];

/** A TSL 3.1 device has none of these on the switcher, so they are neither sent nor compared. */
export const TSL_5_ONLY = ["screen", "offset", "brightness", "header"] as const satisfies readonly (keyof SwitcherDeviceSettings)[];

/** Where this computer's device stands on the switcher, for the line beside Send to switcher. */
export function deviceState(input: {
  readonly reading: SwitcherReading | null;
  readonly wanted: SwitcherDeviceSettings | null;
}): { tone: Tone; text: string; onSwitcher: boolean; unsent: boolean } {
  const mine = input.reading?.mine;
  if (!input.reading) return { tone: "idle", text: "Not checked", onSwitcher: false, unsent: false };
  if (!mine) return { tone: "idle", text: "Not on the switcher yet", onSwitcher: false, unsent: false };
  const unsent =
    !!mine.settings &&
    !!input.wanted &&
    SENT_FIELDS.some(
      (field) =>
        !(input.wanted?.protocol === "3.1" && (TSL_5_ONLY as readonly string[]).includes(field)) &&
        mine.settings?.[field] !== input.wanted?.[field],
    );
  return {
    tone: unsent ? "warn" : "ok",
    text: unsent ? `On the switcher in slot ${mine.slot} · changes here are not sent yet` : `On the switcher in slot ${mine.slot}`,
    onSwitcher: true,
    unsent,
  };
}

/** One line of the switcher's device list, as the page shows it. */
export function deviceLine(row: SwitcherDeviceRow, mine: boolean) {
  return {
    slot: String(row.slot),
    name: row.name,
    format: row.type === "TSL UMD" ? (/^TSL\s*5/iu.test(row.driver) ? "TSL 5.0" : row.driver) : row.type,
    sendsTo: row.ip ? `${row.ip} : ${row.port}` : "",
    enabled: row.enabled ? "On" : "Off",
    mine,
  };
}

/** Why the listener could not start, in the operator's words rather than the system's. */
export function listenerProblem(input: {
  error: string | null;
  bindAddress: string;
  port: number;
  localAddresses: readonly string[];
}): string {
  if (input.bindAddress !== "0.0.0.0" && !input.localAddresses.includes(input.bindAddress))
    return `${input.bindAddress} isn't one of this computer's addresses`;
  if (/EADDRINUSE/u.test(input.error ?? "")) return `port ${input.port} is in use by something else`;
  if (/EACCES/u.test(input.error ?? "")) return `this computer doesn't allow port ${input.port}`;
  return input.error ?? "the port could not be opened";
}

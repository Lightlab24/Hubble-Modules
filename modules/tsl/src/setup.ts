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
  /**
   * The switcher device this page edits, by the name it has on the switcher. Empty until one is
   * picked or sent: then it is the device called `name`, added if the switcher has none.
   */
  device: z.union([z.literal(""), DeviceNameSchema]).default(""),
  /** The device's name as the page wants it. Differs from `device` while a rename is not sent. */
  name: DeviceNameSchema.default("HUBBLE"),
  /** Empty means the address this computer uses to reach the switcher. */
  sendTo: z.union([z.literal(""), z.ipv4()]).default(""),
  /**
   * What the device sends. A setup saved before 1.3.1 has none of these: its device sends what
   * This computer listens for, as it did then.
   */
  protocol: z.enum(["3.1", "5.0"]).optional(),
  transport: z.enum(["udp", "tcp"]).optional(),
  port: z.int().min(1).max(65535).optional(),
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

/** The name the page's device has on the switcher, which is how it is found there. */
export const deviceIdentity = (document: Pick<SwitcherDocument, "device" | "name">): string => document.device || document.name;

/** The device as the page wants it on the switcher. A setup from before 1.3.1 sends what this computer listens for. */
export function wantedDevice(
  document: SwitcherDocument,
  receiver: Pick<ReceiverLink, "protocol" | "transport" | "port">,
  sendTo: string,
): SwitcherDeviceSettings {
  return {
    name: document.name,
    ip: sendTo,
    port: document.port ?? receiver.port,
    protocol: document.protocol ?? receiver.protocol,
    transport: document.transport ?? receiver.transport,
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

/** The page's setup taken from a device as the switcher has it. Nothing else in the setup changes. */
export function documentFromDevice(document: SwitcherDocument, settings: SwitcherDeviceSettings): SwitcherDocument {
  return {
    ...document,
    device: settings.name,
    name: settings.name,
    sendTo: settings.ip,
    protocol: settings.protocol,
    transport: settings.transport,
    port: settings.port,
    enabled: settings.enabled,
    center: settings.center,
    fsfc: settings.fsfc,
    busName: settings.busName,
    umdId: settings.umdId,
    oneSecond: settings.oneSecond,
    // A TSL 3.1 device has none of these, so the page keeps what it had.
    ...(settings.protocol === "5.0"
      ? {
          screen: settings.screen,
          offset: settings.offset as SwitcherDocument["offset"],
          brightness: settings.brightness,
          header: settings.header,
        }
      : {}),
  };
}

/** What the switcher's list already says about a device, before its form is read. */
export function documentFromRow(document: SwitcherDocument, row: SwitcherDeviceRow): SwitcherDocument {
  const ip = z.ipv4().safeParse(row.ip);
  const port = z.int().min(1).max(65535).safeParse(row.port);
  return {
    ...document,
    device: row.name,
    name: row.name,
    sendTo: ip.success ? ip.data : "",
    protocol: /^TSL\s*5/iu.test(row.driver) ? "5.0" : "3.1",
    ...(port.success ? { port: port.data } : {}),
    enabled: row.enabled,
  };
}

export type Tone = "ok" | "idle" | "warn" | "bad";
export interface LinkStatus {
  readonly tone: Tone;
  readonly title: string;
  readonly text: string;
  /**
   * What Match switcher would set on this computer: only for a device that sends here, and only
   * where this computer listens for something else.
   */
  readonly match: Pick<ReceiverLink, "protocol" | "transport" | "port" | "bindAddress"> | null;
}
/** True when a device sends the TSL version, transport and port this computer listens for. */
export const sameFormat = (
  receiver: Pick<ReceiverLink, "protocol" | "transport" | "port">,
  theirs: Pick<SwitcherDeviceSettings, "protocol" | "transport" | "port">,
): boolean => theirs.protocol === receiver.protocol && theirs.transport === receiver.transport && theirs.port === receiver.port;

const format = (link: Pick<ReceiverLink, "protocol" | "transport">) =>
  `TSL ${link.protocol} over ${link.transport.toUpperCase()}`;

/**
 * Whether the switcher's device and this computer's receiver agree. A reading is what the
 * switcher last told us; nothing here reaches the switcher. Matching is offered only for a
 * device that sends to this computer: one that sends elsewhere is someone else's to follow.
 */
export function linkStatus(input: {
  readonly receiver: ReceiverLink;
  readonly reading: SwitcherReading | null;
  readonly readError: string | null;
  readonly localAddresses: readonly string[];
  readonly listening: boolean;
  /** The device the page edits, for the words when the switcher has none by that name. */
  readonly deviceName?: string;
  /** This computer's address on the switcher's network, when it could be worked out. */
  readonly hereAddress?: string | null;
}): LinkStatus {
  const none = (tone: Tone, title: string, text: string): LinkStatus => ({ tone, title, text, match: null });
  if (input.readError) return none("bad", "Switcher offline", input.readError);
  if (!input.reading) return none("idle", "Not checked", "Read the switcher to see what it sends");
  const mine = input.reading.mine;
  if (!mine)
    return none(
      "idle",
      "Not set up",
      input.deviceName
        ? `The switcher has no device named ${input.deviceName}. Pick one from its list, or send to add it`
        : "The switcher has no device for this computer. Send to switcher adds one",
    );
  if (!mine.settings)
    return none("idle", "Not checked", "Someone is editing devices on the switcher, so its settings couldn't be read");
  const theirs = mine.settings;
  const receiver = input.receiver;
  if (!input.localAddresses.includes(theirs.ip)) {
    // Hubble can't take on an address this computer doesn't have, so there is nothing to match
    // here. When the address is all that differs, say so, and give both ways to put it right.
    const here = input.hereAddress && input.localAddresses.includes(input.hereAddress) ? input.hereAddress : null;
    return none(
      "warn",
      "Not matched",
      sameFormat(receiver, theirs)
        ? `Only the address differs: ${mine.name} sends to ${theirs.ip}, and this computer is ${here ?? "not on that address"}. Point ${mine.name} at ${here ?? "this computer"}, or give this computer ${theirs.ip}`
        : `${mine.name} sends to ${theirs.ip} : ${theirs.port}, which isn't this computer${here ? ` (${here})` : ""}. Point it here and send, then match`,
    );
  }
  const differs = !sameFormat(receiver, theirs);
  const elsewhere = receiver.bindAddress !== "0.0.0.0" && receiver.bindAddress !== theirs.ip;
  if (differs || elsewhere)
    return {
      tone: "warn",
      title: "Not matched",
      text: differs
        ? `${mine.name} sends ${format(theirs)} to port ${theirs.port}. This computer listens for ${format(receiver)} on port ${receiver.port}`
        : `${mine.name} sends to ${theirs.ip}, but this computer listens only on ${receiver.bindAddress}`,
      match: {
        protocol: theirs.protocol,
        transport: theirs.transport,
        port: theirs.port,
        bindAddress: elsewhere ? theirs.ip : receiver.bindAddress,
      },
    };
  if (!theirs.enabled) return none("warn", "Not matched", `${mine.name} is switched off on the switcher`);
  if (!input.listening) return none("warn", "Not listening", "The settings match, but this computer isn't listening");
  return none(
    "ok",
    "Matched",
    `${mine.name} sends ${format(theirs)} to ${theirs.ip} : ${theirs.port}, and this computer is listening for it`,
  );
}

const SENT_FIELDS = [
  "name", "ip", "port", "protocol", "transport", "enabled", "screen", "offset", "brightness",
  "center", "fsfc", "busName", "umdId", "oneSecond", "header",
] as const satisfies readonly (keyof SwitcherDeviceSettings)[];
export type SentField = (typeof SENT_FIELDS)[number];

/** A TSL 3.1 device has none of these on the switcher, so they are neither sent nor compared. */
export const TSL_5_ONLY = ["screen", "offset", "brightness", "header"] as const satisfies readonly (keyof SwitcherDeviceSettings)[];

/** The settings the page holds that the switcher's device doesn't have yet. */
export function unsentFields(wanted: SwitcherDeviceSettings | null, kept: SwitcherDeviceSettings | null | undefined): SentField[] {
  if (!wanted || !kept) return [];
  return SENT_FIELDS.filter(
    (field) =>
      !(wanted.protocol === "3.1" && (TSL_5_ONLY as readonly string[]).includes(field)) && kept[field] !== wanted[field],
  );
}

/** Where the page's device stands on the switcher, for the line beside Send to switcher. */
export function deviceState(input: {
  readonly reading: SwitcherReading | null;
  readonly wanted: SwitcherDeviceSettings | null;
}): { tone: Tone; text: string; onSwitcher: boolean; unsent: boolean; fields: SentField[] } {
  const mine = input.reading?.mine;
  if (!input.reading) return { tone: "idle", text: "Not checked", onSwitcher: false, unsent: false, fields: [] };
  if (!mine) return { tone: "idle", text: "Not on the switcher yet", onSwitcher: false, unsent: false, fields: [] };
  const fields = unsentFields(input.wanted, mine.settings);
  const count = fields.length;
  return {
    tone: count ? "warn" : "ok",
    text: count
      ? `Slot ${mine.slot} · ${count === 1 ? "1 change" : `${count} changes`} not sent`
      : `On the switcher in slot ${mine.slot}`,
    onSwitcher: true,
    unsent: count > 0,
    fields,
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
  // The listener keeps trying both of these, so it says it will start rather than that it failed.
  if (input.bindAddress !== "0.0.0.0" && !input.localAddresses.includes(input.bindAddress))
    return `${input.bindAddress} isn't one of this computer's addresses yet · listening starts as soon as it is`;
  if (/EADDRINUSE/u.test(input.error ?? ""))
    return `port ${input.port} is in use by something else · trying again every few seconds`;
  if (/EACCES/u.test(input.error ?? "")) return `this computer doesn't allow port ${input.port}`;
  return input.error ?? "the port could not be opened";
}

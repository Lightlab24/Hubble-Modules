/**
 * The Ethernet Devices list of a Ross Carbonite switcher: the page DashBoard shows under
 * Configuration > Devices. This module reads the list and adds, changes or deletes one
 * TSL UMD device, the one that sends tally to this computer. It never changes another row.
 *
 * The switcher has one edit form that every DashBoard user shares. Choosing a row loads it
 * into the form; Add Device opens a blank one; Save writes the form to the list. So this
 * module only touches the form when nobody else is using it, and always leaves it as it
 * found it: nothing selected.
 *
 * Parameter numbers and behaviour were read from a Carbonite Ultra, software 9.2.1.
 * Adding, reading, changing (options, port, transport and TSL version), enabling, disabling
 * and deleting a device were all run on that switcher.
 */
import {
  cstring,
  int32,
  OgpBinaryClient,
  OgpError,
  readInt,
  readString,
  readStrings,
  type OgpConnect,
} from "./ogp-binary.js";

/** Parameter numbers on the switcher. */
export const SWITCHER_OID = {
  productName: 0x0105,
  software: 0x010b,
  engineType: 0xff01,
  // The list, one entry per row. Row 0 is the serial port.
  listSlot: 0xc327,
  listType: 0xc328,
  listDriver: 0xc329,
  listIp: 0xc32a,
  listName: 0xe7ec,
  listPort: 0xc32b,
  listEnabled: 0xd6bf,
  // The shared edit form.
  selectedRow: 0x5188,
  slot: 0xc32c,
  type: 0x5189,
  driver: 0x518a,
  ip: 0x518b,
  name: 0xe7ed,
  port: 0x518c,
  transport: 0xc333,
  center: 0xc334,
  fsfcLabel: 0xc335,
  showBusName: 0xc336,
  showUmdId: 0xc337,
  oneSecondUpdate: 0xc338,
  tslHeader: 0xd8d1,
  tslBrightness: 0xd8d2,
  tslScreen: 0xd8e9,
  tslAddressOffset: 0xd8ea,
  addDevice: 0xc339,
  deleteDevice: 0xc33a,
  enableDisable: 0xd6c0,
  changes: 0x518d,
} as const;

/** Everything this module may write on a switcher: the Devices form and nothing else. */
export const SWITCHER_WRITABLE_OIDS: ReadonlySet<number> = new Set<number>([
  SWITCHER_OID.selectedRow,
  SWITCHER_OID.slot,
  SWITCHER_OID.type,
  SWITCHER_OID.driver,
  SWITCHER_OID.ip,
  SWITCHER_OID.name,
  SWITCHER_OID.port,
  SWITCHER_OID.transport,
  SWITCHER_OID.center,
  SWITCHER_OID.fsfcLabel,
  SWITCHER_OID.showBusName,
  SWITCHER_OID.showUmdId,
  SWITCHER_OID.oneSecondUpdate,
  SWITCHER_OID.tslHeader,
  SWITCHER_OID.tslBrightness,
  SWITCHER_OID.tslScreen,
  SWITCHER_OID.tslAddressOffset,
  SWITCHER_OID.addDevice,
  SWITCHER_OID.deleteDevice,
  SWITCHER_OID.enableDisable,
  SWITCHER_OID.changes,
]);

const TYPE_TSL_UMD = 11;
const TYPE_TSL_UMD_LABEL = "TSL UMD";
const TYPE_NONE = -1;
const CHANGES_IDLE = -1;
const CHANGES_SAVE = 1;
const CHANGES_CANCEL = 0;
const ADD_DEVICE = 0;
const DELETE_DEVICE = 1;
// The value is the label the button shows afterwards: 2 leaves "Disable Device" showing, so
// the device is on; 3 leaves "Enable Device" showing, so it is off. Seen on the real switcher.
const ENABLE_DEVICE = 2;
const DISABLE_DEVICE = 3;
/** How long the list is given to show a change the switcher has just accepted. */
const LIST_SETTLE_MS = 2500;
/** How long a form that looks in use is watched before it is called busy. */
const FORM_SETTLE_MS = 1200;
/** The real switcher's list shows an Enable or Disable about 400 ms after it is written. */
const ENABLE_SETTLE_MS = 2500;
const TRANSPORT_TCP = 0;
const TRANSPORT_UDP = 1;
const NOT_FOUND = 0x11;
const TIDY_LIMIT_MS = 1000;
export const SWITCHER_ADDRESS_OFFSETS = [0, 10000, 20000, 30000, 40000, 50000] as const;
const OFFSETS: readonly number[] = SWITCHER_ADDRESS_OFFSETS;

export interface SwitcherDeviceRow {
  /** Position in the switcher's list, as its edit form counts rows. */
  row: number;
  slot: number;
  /** The switcher's own word, such as "TSL UMD" or "RossTalk". */
  type: string;
  /** The switcher's own word, such as "TSL 3.1" or "TSL 5". */
  driver: string;
  name: string;
  ip: string;
  port: number;
  enabled: boolean;
}

export interface SwitcherDeviceSettings {
  name: string;
  ip: string;
  port: number;
  protocol: "3.1" | "5.0";
  transport: "udp" | "tcp";
  enabled: boolean;
  screen: number;
  /** 0, 10000, 20000, 30000, 40000 or 50000. */
  offset: number;
  brightness: 0 | 1 | 2 | 3;
  center: boolean;
  fsfc: boolean;
  busName: boolean;
  umdId: boolean;
  oneSecond: boolean;
  header: boolean;
}

export interface SwitcherMine extends SwitcherDeviceRow {
  /**
   * Null when the device's form could not be read: someone is using the switcher's edit
   * form (`formBusy`), or the row is not a TSL UMD device with a TSL 3.1 or TSL 5 driver.
   */
  settings: SwitcherDeviceSettings | null;
}

export interface SwitcherReading {
  /** Such as "Carbonite Ultra". */
  product: string;
  /** Such as "9.2.1.18190". */
  software: string;
  /** Every Ethernet device on the switcher, of any type. The serial-port row is left out. */
  devices: SwitcherDeviceRow[];
  /** The device with the name asked for, or null. */
  mine: SwitcherMine | null;
  /** Someone has the switcher's edit form open, so nothing was selected or changed. */
  formBusy: boolean;
}

export interface SwitcherTarget {
  host: string;
  /** OGP port. Default 5253. */
  port?: number | undefined;
  /** Wait for the connection and for each reply. Default 3000 ms. */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** For tests: supplies the socket. */
  connect?: OgpConnect | undefined;
}

/** A failure the operator can read and act on. */
export class SwitcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwitcherError";
  }
}

const BUSY = "Someone is editing devices on the switcher. Try again when they finish";
const NOT_KEPT = "The switcher didn't keep the change. Read the switcher and try again";
const LIST_CHANGED =
  "The switcher's device list changed while this was working. Read the switcher and try again";

interface Session {
  readonly client: OgpBinaryClient;
  /** An add or edit is open in the form and not saved. */
  editing: boolean;
  /** This session chose a row, so the form must be put back. */
  moved: boolean;
}
interface FormState {
  readonly selected: number;
  readonly type: number;
  readonly changes: number;
}
interface FormDetail {
  readonly slot: number;
  readonly type: number;
  readonly name: string;
  readonly ip: string;
  readonly port: number;
  readonly driverLabel: string;
  readonly settings: SwitcherDeviceSettings | null;
}
type DriverChoices = readonly { readonly key: number; readonly label: string }[];

const protocolOfDriver = (label: string): "3.1" | "5.0" | null =>
  /^TSL\s*3/iu.test(label) ? "3.1" : /^TSL\s*5/iu.test(label) ? "5.0" : null;

/** The form is idle when no device is loaded in it and no change is waiting. */
const formIsIdle = (form: FormState): boolean =>
  form.type === TYPE_NONE && form.changes === CHANGES_IDLE;

function checkName(name: string): string {
  if (!/^[\x20-\x7e]{1,8}$/u.test(name) || name !== name.trim())
    throw new SwitcherError(
      "A device name is 1 to 8 letters, numbers or spaces, with no space at either end",
    );
  return name;
}

function checkTarget(target: SwitcherTarget): void {
  if (!/^\S{1,253}$/u.test(target.host))
    throw new SwitcherError("Enter the switcher's host name or IP address");
  if (
    target.port !== undefined &&
    (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)
  )
    throw new SwitcherError("The switcher's port is a number from 1 to 65535");
}

function checkSettings(settings: SwitcherDeviceSettings): void {
  checkName(settings.name);
  const parts = settings.ip.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/u.test(part) || Number(part) > 255) ||
    settings.ip === "0.0.0.0"
  )
    throw new SwitcherError("Send to needs this computer's IPv4 address, such as 10.0.0.20");
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535)
    throw new SwitcherError("Port is a number from 1 to 65535");
  if (settings.protocol !== "3.1" && settings.protocol !== "5.0")
    throw new SwitcherError("TSL version is 3.1 or 5.0");
  if (settings.transport !== "udp" && settings.transport !== "tcp")
    throw new SwitcherError("Transport is UDP or TCP");
  if (!Number.isInteger(settings.screen) || settings.screen < 0 || settings.screen > 65534)
    throw new SwitcherError("Screen is a number from 0 to 65534");
  if (!OFFSETS.includes(settings.offset))
    throw new SwitcherError("Address offset is 0, 10000, 20000, 30000, 40000 or 50000");
  if (![0, 1, 2, 3].includes(settings.brightness))
    throw new SwitcherError("Brightness is Off, Low, Medium or High");
}

async function withSwitcher<T>(
  target: SwitcherTarget,
  work: (session: Session) => Promise<T>,
): Promise<T> {
  checkTarget(target);
  const client = new OgpBinaryClient({
    host: target.host,
    port: target.port,
    timeoutMs: target.timeoutMs,
    writable: SWITCHER_WRITABLE_OIDS,
    connect: target.connect,
  });
  const session: Session = { client, editing: false, moved: false };
  try {
    await client.connect(target.signal);
    await client.handshake();
    return await work(session);
  } finally {
    // Tidy up even after an abort or a failure: drop an unsaved edit, choose no row.
    client.stopFollowingAbort();
    await tidy(session, Math.min(target.timeoutMs ?? TIDY_LIMIT_MS, TIDY_LIMIT_MS));
    client.close();
  }
}

async function tidy(session: Session, limitMs: number): Promise<void> {
  const attempt = async (oid: number, value: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      session.client.set(oid, int32(value)).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, limitMs);
      }),
    ]);
    clearTimeout(timer);
  };
  if (session.editing) await attempt(SWITCHER_OID.changes, CHANGES_CANCEL);
  if (session.editing || session.moved) await attempt(SWITCHER_OID.selectedRow, 0);
  session.editing = false;
  session.moved = false;
}

const getInt = async (client: OgpBinaryClient, oid: number) => readInt(await client.get(oid));
const getText = async (client: OgpBinaryClient, oid: number) => readString(await client.get(oid));

async function identify(client: OgpBinaryClient): Promise<{ product: string; software: string }> {
  const optional = (oid: number) =>
    getText(client, oid).catch((error: unknown) => {
      if (error instanceof OgpError && error.code !== null) return "";
      throw error;
    });
  const engine = await optional(SWITCHER_OID.engineType);
  const name = await optional(SWITCHER_OID.productName);
  const software = await optional(SWITCHER_OID.software);
  return { product: engine || name || "Ross switcher", software };
}

/**
 * The switcher's list is seven columns read one after another, and the switcher fills them in
 * one at a time just after a save, a delete or a new connection to a device. A read that
 * catches it halfway is taken again for a short while before it is called a real change.
 */
async function readRows(client: OgpBinaryClient): Promise<SwitcherDeviceRow[]> {
  const until = Date.now() + LIST_SETTLE_MS;
  for (;;) {
    try {
      return await readRowsOnce(client);
    } catch (error) {
      if (!(error instanceof SwitcherError) || error.message !== LIST_CHANGED || Date.now() >= until)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

/** Reads the list until it shows what is expected, or the wait runs out. Returns the last reading. */
async function readRowsUntil(
  client: OgpBinaryClient,
  expected: (rows: readonly SwitcherDeviceRow[]) => boolean,
): Promise<SwitcherDeviceRow[]> {
  const until = Date.now() + LIST_SETTLE_MS;
  for (;;) {
    const rows = await readRows(client);
    if (expected(rows) || Date.now() >= until) return rows;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function readRowsOnce(client: OgpBinaryClient): Promise<SwitcherDeviceRow[]> {
  const column = async (oid: number) => readStrings(await client.get(oid));
  let slots: string[];
  try {
    slots = await column(SWITCHER_OID.listSlot);
  } catch (error) {
    if (error instanceof OgpError && error.code === NOT_FOUND)
      throw new SwitcherError(
        "This device doesn't have the device list this module knows. It works with Ross Carbonite switchers",
      );
    throw error;
  }
  const types = await column(SWITCHER_OID.listType);
  const drivers = await column(SWITCHER_OID.listDriver);
  const names = await column(SWITCHER_OID.listName);
  const ips = await column(SWITCHER_OID.listIp);
  const ports = await column(SWITCHER_OID.listPort);
  const enabled = await column(SWITCHER_OID.listEnabled);
  if ([types, drivers, names, ips, ports, enabled].some((list) => list.length !== slots.length))
    throw new SwitcherError(LIST_CHANGED);
  const rows: SwitcherDeviceRow[] = [];
  slots.forEach((slot, row) => {
    // The serial port's row has "SP" for a slot. It is not an Ethernet device.
    if (!/^\d+$/u.test(slot)) return;
    rows.push({
      row,
      slot: Number(slot),
      type: types[row] ?? "",
      driver: drivers[row] ?? "",
      name: names[row] ?? "",
      ip: ips[row] ?? "",
      port: /^\d+$/u.test(ports[row] ?? "") ? Number(ports[row]) : 0,
      enabled: enabled[row] === "On",
    });
  });
  return rows;
}

async function readFormState(client: OgpBinaryClient): Promise<FormState> {
  return {
    selected: await getInt(client, SWITCHER_OID.selectedRow),
    type: await getInt(client, SWITCHER_OID.type),
    changes: await getInt(client, SWITCHER_OID.changes),
  };
}

/**
 * Whether nobody is using the form. The real switcher takes a moment to show an emptied form
 * after a device is put away, so a form that looks in use is looked at again for a short
 * while. Someone editing in DashBoard stays there far longer than this wait.
 */
async function formStaysBusy(client: OgpBinaryClient): Promise<boolean> {
  const until = Date.now() + FORM_SETTLE_MS;
  for (;;) {
    if (formIsIdle(await readFormState(client))) return false;
    if (Date.now() >= until) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function driverChoices(client: OgpBinaryClient): Promise<DriverChoices> {
  return (await client.descriptor(SWITCHER_OID.driver)).choices;
}

/** Reads the device loaded in the form. `enabled` comes from the list, which is where the switcher keeps it. */
async function readDetail(client: OgpBinaryClient, enabled: boolean): Promise<FormDetail> {
  const flag = async (oid: number) => (await getInt(client, oid)) !== 0;
  const slot = await getInt(client, SWITCHER_OID.slot);
  const type = await getInt(client, SWITCHER_OID.type);
  const name = await getText(client, SWITCHER_OID.name);
  const ip = await getText(client, SWITCHER_OID.ip);
  const port = await getInt(client, SWITCHER_OID.port);
  if (type !== TYPE_TSL_UMD)
    return { slot, type, name, ip, port, driverLabel: "", settings: null };
  const driverKey = await getInt(client, SWITCHER_OID.driver);
  const driverLabel =
    (await driverChoices(client)).find((choice) => choice.key === driverKey)?.label ?? "";
  const protocol = protocolOfDriver(driverLabel);
  const transport = await getInt(client, SWITCHER_OID.transport);
  const center = await flag(SWITCHER_OID.center);
  const fsfc = await flag(SWITCHER_OID.fsfcLabel);
  const busName = await flag(SWITCHER_OID.showBusName);
  const umdId = await flag(SWITCHER_OID.showUmdId);
  const oneSecond = await flag(SWITCHER_OID.oneSecondUpdate);
  const header = await flag(SWITCHER_OID.tslHeader);
  const brightness = await getInt(client, SWITCHER_OID.tslBrightness);
  const screen = await getInt(client, SWITCHER_OID.tslScreen);
  const offsetKey = await getInt(client, SWITCHER_OID.tslAddressOffset);
  const settings: SwitcherDeviceSettings | null =
    protocol === null
      ? null
      : {
          name,
          ip,
          port,
          protocol,
          transport: transport === TRANSPORT_UDP ? "udp" : "tcp",
          enabled,
          screen,
          offset: OFFSETS[offsetKey] ?? 0,
          brightness: ([0, 1, 2, 3] as const)[brightness] ?? 1,
          center,
          fsfc,
          busName,
          umdId,
          oneSecond,
          header,
        };
  return { slot, type, name, ip, port, driverLabel, settings };
}

function findMine(rows: readonly SwitcherDeviceRow[], deviceName: string): SwitcherDeviceRow | null {
  const matches = rows.filter((row) => row.name === deviceName);
  if (matches.length > 1)
    throw new SwitcherError(
      `Two devices on the switcher are named ${deviceName}. Rename one in DashBoard, or choose another device name`,
    );
  return matches[0] ?? null;
}

const notTslDevice = (row: SwitcherDeviceRow): string =>
  `${row.name} on the switcher is a ${row.type || "different"} device, not TSL UMD. Choose another device name`;

const sameDevice = (a: SwitcherDeviceRow, b: SwitcherDeviceRow): boolean =>
  a.slot === b.slot &&
  a.type === b.type &&
  a.driver === b.driver &&
  a.name === b.name &&
  a.ip === b.ip &&
  a.port === b.port &&
  a.enabled === b.enabled;

/**
 * Every device but this module's own must be exactly as it was, and no other may have
 * appeared. `mineBefore` and `mineAfter` are this module's device before and after the
 * change, or null where it did not exist.
 */
function checkOthersUnchanged(
  before: readonly SwitcherDeviceRow[],
  after: readonly SwitcherDeviceRow[],
  mineBefore: SwitcherDeviceRow | null,
  mineAfter: SwitcherDeviceRow | null,
): void {
  const was = before.filter((row) => row.slot !== mineBefore?.slot);
  const now = after.filter((row) => row.slot !== mineAfter?.slot);
  for (const row of was) {
    const match = now.find((candidate) => candidate.slot === row.slot);
    if (!match || !sameDevice(row, match))
      throw new SwitcherError(
        `Another device on the switcher changed (slot ${String(row.slot)}, ${row.name || "no name"}). Check the Devices page in DashBoard`,
      );
  }
  const extra = now.find((row) => !was.some((candidate) => candidate.slot === row.slot));
  if (extra)
    throw new SwitcherError(
      `Another device appeared on the switcher (slot ${String(extra.slot)}). Check the Devices page in DashBoard`,
    );
}

async function selectRow(session: Session, row: number): Promise<void> {
  session.moved = true;
  await session.client.set(SWITCHER_OID.selectedRow, int32(row));
}

/** Loads a row into the form and makes sure the form shows the row that was found in the list. */
async function openRow(session: Session, row: SwitcherDeviceRow): Promise<FormDetail> {
  await selectRow(session, row.row);
  const detail = await readDetail(session.client, row.enabled);
  if (
    detail.slot !== row.slot ||
    detail.name !== row.name ||
    detail.ip !== row.ip ||
    detail.port !== row.port
  )
    throw new SwitcherError(LIST_CHANGED);
  return detail;
}

interface FieldWrite {
  readonly oid: number;
  readonly label: string;
  readonly value: number | string;
}

/** Writes one form field and reads it back. The form is only saved if every field reads back. */
async function writeField(session: Session, field: FieldWrite): Promise<void> {
  const { client } = session;
  session.editing = true;
  try {
    await client.set(
      field.oid,
      typeof field.value === "number" ? int32(field.value) : cstring(field.value),
    );
  } catch (error) {
    if (error instanceof OgpError && error.code !== null)
      throw new SwitcherError(`The switcher refused ${field.label}, so nothing was saved`);
    throw error;
  }
  const kept =
    typeof field.value === "number"
      ? await getInt(client, field.oid)
      : await getText(client, field.oid);
  if (kept !== field.value)
    throw new SwitcherError(`The switcher didn't accept ${field.label}, so nothing was saved`);
}

/** The option fields, in the order DashBoard shows them. TSL 3.1 has no header, brightness, screen or offset. */
function optionWrites(settings: SwitcherDeviceSettings): FieldWrite[] {
  const bit = (value: boolean) => (value ? 1 : 0);
  const common: FieldWrite[] = [
    { oid: SWITCHER_OID.center, label: "Center labels", value: bit(settings.center) },
    { oid: SWITCHER_OID.fsfcLabel, label: "FSFC label", value: bit(settings.fsfc) },
    { oid: SWITCHER_OID.showBusName, label: "Show bus name", value: bit(settings.busName) },
    { oid: SWITCHER_OID.showUmdId, label: "Show UMD ID", value: bit(settings.umdId) },
    { oid: SWITCHER_OID.oneSecondUpdate, label: "1 second update", value: bit(settings.oneSecond) },
  ];
  if (settings.protocol !== "5.0") return common;
  return [
    ...common,
    { oid: SWITCHER_OID.tslHeader, label: "TSL header", value: bit(settings.header) },
    { oid: SWITCHER_OID.tslBrightness, label: "Brightness", value: settings.brightness },
    { oid: SWITCHER_OID.tslScreen, label: "Screen", value: settings.screen },
    {
      oid: SWITCHER_OID.tslAddressOffset,
      label: "Address offset",
      value: OFFSETS.indexOf(settings.offset),
    },
  ];
}

async function driverWrite(session: Session, protocol: "3.1" | "5.0"): Promise<FieldWrite> {
  // The switcher makes up the number for each driver, so it is read every time.
  const choice = (await driverChoices(session.client)).find(
    (candidate) => protocolOfDriver(candidate.label) === protocol,
  );
  if (!choice)
    throw new SwitcherError(`The switcher doesn't offer TSL ${protocol} for this device`);
  return { oid: SWITCHER_OID.driver, label: "TSL version", value: choice.key };
}

function mainWrites(settings: SwitcherDeviceSettings): FieldWrite[] {
  return [
    { oid: SWITCHER_OID.ip, label: "Send to", value: settings.ip },
    { oid: SWITCHER_OID.name, label: "Device name", value: settings.name },
    { oid: SWITCHER_OID.port, label: "Port", value: settings.port },
    {
      oid: SWITCHER_OID.transport,
      label: "Transport",
      value: settings.transport === "udp" ? TRANSPORT_UDP : TRANSPORT_TCP,
    },
  ];
}

/** True when what the switcher holds is what was asked for. Fields a TSL 3.1 device lacks are not compared. */
function settingsKept(wanted: SwitcherDeviceSettings, kept: SwitcherDeviceSettings | null): boolean {
  if (!kept) return false;
  const common =
    kept.name === wanted.name &&
    kept.ip === wanted.ip &&
    kept.port === wanted.port &&
    kept.protocol === wanted.protocol &&
    kept.transport === wanted.transport &&
    kept.center === wanted.center &&
    kept.fsfc === wanted.fsfc &&
    kept.busName === wanted.busName &&
    kept.umdId === wanted.umdId &&
    kept.oneSecond === wanted.oneSecond;
  if (wanted.protocol !== "5.0") return common;
  return (
    common &&
    kept.header === wanted.header &&
    kept.brightness === wanted.brightness &&
    kept.screen === wanted.screen &&
    kept.offset === wanted.offset
  );
}

async function save(session: Session): Promise<void> {
  await session.client.set(SWITCHER_OID.changes, int32(CHANGES_SAVE));
  session.editing = false;
}

/**
 * After a save: the list must hold exactly one device with this name, as asked for, and
 * every other device as it was. Returns the saved device, read back from the form.
 */
async function confirmSaved(
  session: Session,
  before: readonly SwitcherDeviceRow[],
  mineBefore: SwitcherDeviceRow | null,
  settings: SwitcherDeviceSettings,
): Promise<{ rows: SwitcherDeviceRow[]; mine: SwitcherMine }> {
  const { client } = session;
  const asAsked = (row: SwitcherDeviceRow) =>
    row.type === TYPE_TSL_UMD_LABEL &&
    protocolOfDriver(row.driver) === settings.protocol &&
    row.ip === settings.ip &&
    row.port === settings.port;
  let rows = await readRowsUntil(client, (list) => {
    const named = list.filter((row) => row.name === settings.name);
    return named.length === 1 && !!named[0] && asAsked(named[0]);
  });
  let saved = rows.filter((row) => row.name === settings.name);
  const row = saved[0];
  if (saved.length !== 1 || !row) {
    // The form may still hold the unsaved device. Tidying will cancel it.
    session.editing = true;
    throw new SwitcherError(NOT_KEPT);
  }
  if (!asAsked(row)) throw new SwitcherError(NOT_KEPT);
  checkOthersUnchanged(before, rows, mineBefore, row);
  // After a save the form shows the saved device. Choose it only if it shows something else.
  if ((await getInt(client, SWITCHER_OID.selectedRow)) !== row.row) await selectRow(session, row.row);
  session.moved = true;
  if (row.enabled !== settings.enabled) {
    // Enable/Disable acts at once on the device loaded in the form, with no Save. The list
    // catches up a moment later, so it is read until it agrees or the wait runs out.
    await client.set(
      SWITCHER_OID.enableDisable,
      int32(settings.enabled ? ENABLE_DEVICE : DISABLE_DEVICE),
    );
    const until = Date.now() + ENABLE_SETTLE_MS;
    for (;;) {
      rows = await readRows(client);
      saved = rows.filter((candidate) => candidate.name === settings.name);
      if (saved.length === 1 && saved[0]?.enabled === settings.enabled) break;
      if (Date.now() >= until) throw new SwitcherError(NOT_KEPT);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    checkOthersUnchanged(before, rows, mineBefore, saved[0] ?? row);
  }
  const final = saved[0] ?? row;
  const detail = await readDetail(client, final.enabled);
  if (detail.slot !== final.slot || !settingsKept(settings, detail.settings))
    throw new SwitcherError(NOT_KEPT);
  return { rows, mine: { ...final, settings: detail.settings } };
}

async function addDevice(
  session: Session,
  before: readonly SwitcherDeviceRow[],
  settings: SwitcherDeviceSettings,
): Promise<void> {
  const { client } = session;
  session.editing = true;
  session.moved = true;
  try {
    await client.set(SWITCHER_OID.addDevice, int32(ADD_DEVICE));
  } catch (error) {
    if (error instanceof OgpError && error.code !== null)
      throw new SwitcherError("The switcher has no room for another device");
    throw error;
  }
  // The switcher proposes the next free slot. Use it unless the list says it is taken.
  const used = new Set(before.map((row) => row.slot));
  const proposed = await getInt(client, SWITCHER_OID.slot);
  let slot = proposed;
  if (proposed < 0 || used.has(proposed)) {
    slot = 0;
    while (used.has(slot)) slot++;
  }
  await writeField(session, { oid: SWITCHER_OID.slot, label: "the slot", value: slot });
  await writeField(session, { oid: SWITCHER_OID.type, label: "the TSL UMD type", value: TYPE_TSL_UMD });
  await writeField(session, await driverWrite(session, settings.protocol));
  for (const field of [...mainWrites(settings), ...optionWrites(settings)])
    await writeField(session, field);
  await save(session);
}

/** Not yet run on a real switcher: load the row, write only what differs, save. */
async function updateDevice(
  session: Session,
  mine: SwitcherDeviceRow,
  settings: SwitcherDeviceSettings,
): Promise<void> {
  const detail = await openRow(session, mine);
  const current = detail.settings;
  const changed: FieldWrite[] = [];
  if (current?.protocol !== settings.protocol)
    changed.push(await driverWrite(session, settings.protocol));
  const wanted = [...mainWrites(settings), ...optionWrites(settings)];
  const held = current ? [...mainWrites(current), ...optionWrites({ ...current, protocol: settings.protocol })] : [];
  for (const field of wanted) {
    const now = held.find((candidate) => candidate.oid === field.oid);
    // After a change of TSL version the switcher may reset its options, so all are written.
    if (!now || now.value !== field.value || current?.protocol !== settings.protocol)
      changed.push(field);
  }
  if (changed.length === 0) return;
  for (const field of changed) await writeField(session, field);
  await save(session);
}

async function startWrite(session: Session): Promise<SwitcherDeviceRow[]> {
  const before = await readRows(session.client);
  if (await formStaysBusy(session.client)) throw new SwitcherError(BUSY);
  return before;
}

/** Reads the switcher's devices. Chooses a row only to read this module's own device, then chooses none again. */
export async function readSwitcher(
  input: SwitcherTarget & { deviceName: string },
): Promise<SwitcherReading> {
  const deviceName = checkName(input.deviceName);
  return withSwitcher(input, async (session) => {
    const { client } = session;
    const about = await identify(client);
    const devices = await readRows(client);
    const formBusy = await formStaysBusy(client);
    const row = findMine(devices, deviceName);
    if (!row) return { ...about, devices, mine: null, formBusy };
    if (formBusy || row.type !== TYPE_TSL_UMD_LABEL)
      return { ...about, devices, mine: { ...row, settings: null }, formBusy };
    const detail = await openRow(session, row);
    return { ...about, devices, mine: { ...row, settings: detail.settings }, formBusy };
  });
}

/**
 * Adds the device named in `settings`, or changes it if the switcher already has one with
 * that name. Every field is read back before saving; if one doesn't match, the form is
 * cancelled and nothing changes. No other device is touched.
 */
export async function sendDevice(
  input: SwitcherTarget & { settings: SwitcherDeviceSettings },
): Promise<SwitcherReading> {
  const settings = { ...input.settings };
  checkSettings(settings);
  return withSwitcher(input, async (session) => {
    const about = await identify(session.client);
    const before = await startWrite(session);
    const mine = findMine(before, settings.name);
    if (mine && mine.type !== TYPE_TSL_UMD_LABEL) throw new SwitcherError(notTslDevice(mine));
    if (mine) await updateDevice(session, mine, settings);
    else await addDevice(session, before, settings);
    const saved = await confirmSaved(session, before, mine, settings);
    return { ...about, devices: saved.rows, mine: saved.mine, formBusy: false };
  });
}

/** Deletes the device with this name, after checking the form shows that device. Does nothing if there is none. */
export async function deleteDevice(
  input: SwitcherTarget & { deviceName: string },
): Promise<SwitcherReading> {
  const deviceName = checkName(input.deviceName);
  return withSwitcher(input, async (session) => {
    const { client } = session;
    const about = await identify(client);
    const before = await startWrite(session);
    const mine = findMine(before, deviceName);
    if (!mine) return { ...about, devices: before, mine: null, formBusy: false };
    if (mine.type !== TYPE_TSL_UMD_LABEL) throw new SwitcherError(notTslDevice(mine));
    await openRow(session, mine);
    await client.set(SWITCHER_OID.deleteDevice, int32(DELETE_DEVICE));
    const after = await readRowsUntil(
      client,
      (list) => !list.some((row) => row.name === deviceName || row.slot === mine.slot),
    );
    if (after.some((row) => row.name === deviceName || row.slot === mine.slot))
      throw new SwitcherError(NOT_KEPT);
    checkOthersUnchanged(before, after, mine, null);
    return { ...about, devices: after, mine: null, formBusy: false };
  });
}

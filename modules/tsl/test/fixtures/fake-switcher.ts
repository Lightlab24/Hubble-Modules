/**
 * A stand-in for a Ross Carbonite switcher's Ethernet Devices form, speaking binary OGP on
 * a real TCP port. It behaves the way a Carbonite Ultra (software 9.2.1) was seen to:
 * one shared edit form, list columns as counted strings, driver numbers the switcher makes
 * up, and frames nobody asked for arriving between replies.
 *
 * Changing a saved device and Enable/Disable follow what the real switcher did. Cancel is
 * as the real switcher answered it: the unsaved device goes and the form shows nothing.
 */
import net from "node:net";

const SYNC = Buffer.from([0xba, 0xd2, 0xac, 0xe5]);
const GET_DESCRIPTOR = 0x47;
const GET_PARAM = 0x49;
const SET_PARAM = 0x4a;
const OK = 0x00;
const NOT_FOUND = 0x11;
const BAD_VALUE = 0x12;
const READ_ONLY = 0x13;
const LOCKED = 0x14;

export const FAKE_OID = {
  connection: 0xff03,
  productName: 0x0105,
  software: 0x010b,
  engineType: 0xff01,
  clock: 0x7f41,
  listSlot: 0xc327,
  listType: 0xc328,
  listDriver: 0xc329,
  listIp: 0xc32a,
  listName: 0xe7ec,
  listPort: 0xc32b,
  listEnabled: 0xd6bf,
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

const TYPES: readonly { key: number; label: string }[] = [
  { key: 8, label: "AudioMixer" },
  { key: 9, label: "AuxPanel" },
  { key: 4, label: "Camera" },
  { key: 12, label: "PBus" },
  { key: 10, label: "RossTalk" },
  { key: 7, label: "RouterPanel" },
  { key: 11, label: "TSL UMD" },
  { key: 2, label: "Server" },
];
/** Made-up driver numbers, unlike the real switcher's, so nothing can depend on them. */
export const FAKE_DRIVER = { tsl31: 1904177331, tsl5: -77012345, rossTalk: 5150 } as const;
const DRIVERS: Readonly<Record<number, readonly { key: number; label: string }[]>> = {
  11: [
    { key: FAKE_DRIVER.tsl31, label: "TSL 3.1" },
    { key: FAKE_DRIVER.tsl5, label: "TSL 5" },
  ],
  10: [{ key: FAKE_DRIVER.rossTalk, label: "RossTalk" }],
  8: [{ key: 60911, label: "Generic" }],
};
const driversOf = (type: number) =>
  type === -1 ? [{ key: 0, label: "--none--" }] : (DRIVERS[type] ?? [{ key: 1, label: "Default" }]);

export interface FakeDevice {
  slot: number;
  type: number;
  driverKey: number;
  name: string;
  ip: string;
  port: number;
  enabled: boolean;
  transport: number;
  center: number;
  fsfc: number;
  busName: number;
  umdId: number;
  oneSecond: number;
  header: number;
  brightness: number;
  screen: number;
  offsetKey: number;
}

interface Form extends Omit<FakeDevice, "enabled"> {
  selected: number;
  changes: number;
}

export interface FakeSwitcherOptions {
  refuseHandshake?: boolean;
  /** Someone has a device open in the edit form. */
  busyForm?: boolean;
  /** Save answers "ok" and does nothing. */
  dropSave?: boolean;
  /** A form field that answers "ok" to a write and keeps its old value. */
  forgetWritesTo?: number;
  /** Save also changes another device's port, as if the switcher went wrong. */
  spoilAnotherOnSave?: boolean;
  /** Not a Carbonite: the device list is missing. */
  noDeviceList?: boolean;
  /**
   * As seen on the real switcher: for this long after a save or a delete, the name column
   * still shows the list as it was, so its length disagrees with the other columns.
   */
  listSettlesAfterMs?: number;
  /** Frames nobody asked for, junk bytes and split replies. On unless set false. */
  chatter?: boolean;
  devices?: FakeDevice[];
}

export interface FakeWrite {
  oid: number;
  value: number | string;
}

const tsl = (
  slot: number,
  name: string,
  ip: string,
  port: number,
  enabled: boolean,
  transport: number,
  driverKey: number = FAKE_DRIVER.tsl31,
): FakeDevice => ({
  slot,
  type: 11,
  driverKey,
  name,
  ip,
  port,
  enabled,
  transport,
  center: 0,
  fsfc: 0,
  busName: 0,
  umdId: 0,
  oneSecond: 0,
  header: 0,
  brightness: 1,
  screen: 0,
  offsetKey: 0,
});

/** The three devices the real switcher had. */
export const realDevices = (): FakeDevice[] => [
  tsl(0, "CP", "192.168.1.204", 7788, false, 0),
  tsl(1, "ADAM", "10.20.100.236", 5727, true, 0),
  tsl(2, "RTR TALL", "10.20.50.50", 4490, true, 1),
];
export const fakeTslDevice = tsl;

const STRING_OIDS = new Set<number>([FAKE_OID.ip, FAKE_OID.name]);
const FIELD_OIDS: Readonly<Record<number, keyof Omit<Form, "selected" | "changes" | "ip" | "name">>> = {
  [FAKE_OID.slot]: "slot",
  [FAKE_OID.type]: "type",
  [FAKE_OID.driver]: "driverKey",
  [FAKE_OID.port]: "port",
  [FAKE_OID.transport]: "transport",
  [FAKE_OID.center]: "center",
  [FAKE_OID.fsfcLabel]: "fsfc",
  [FAKE_OID.showBusName]: "busName",
  [FAKE_OID.showUmdId]: "umdId",
  [FAKE_OID.oneSecondUpdate]: "oneSecond",
  [FAKE_OID.tslHeader]: "header",
  [FAKE_OID.tslBrightness]: "brightness",
  [FAKE_OID.tslScreen]: "screen",
  [FAKE_OID.tslAddressOffset]: "offsetKey",
};
const LIST_OIDS = new Set<number>([
  FAKE_OID.listSlot,
  FAKE_OID.listType,
  FAKE_OID.listDriver,
  FAKE_OID.listIp,
  FAKE_OID.listName,
  FAKE_OID.listPort,
  FAKE_OID.listEnabled,
]);

const int32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
};
const cstring = (text: string) => Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);
const counted = (texts: readonly string[]) =>
  Buffer.concat(
    texts.map((text) => {
      const body = cstring(text);
      return Buffer.concat([Buffer.from([body.length]), body]);
    }),
  );

export class FakeSwitcher {
  devices: FakeDevice[];
  /** Every write received, in order, except the connection request. */
  readonly writes: FakeWrite[] = [];
  /** Every request received: its type and parameter. */
  readonly requests: { type: number; oid: number }[] = [];
  /** Called as each write arrives, before it is applied or held. */
  onWrite: ((write: FakeWrite) => void) | undefined;
  options: FakeSwitcherOptions;
  port = 0;
  #server: net.Server | undefined;
  readonly #sockets = new Set<net.Socket>();
  #form: Form;
  #mode: "idle" | "viewing" | "adding" = "idle";
  #held = false;
  #queue: (() => void)[] = [];
  #replies = 0;
  /** One socket's bytes go out in order, even when a reply is sent in two parts. */
  readonly #sending = new WeakMap<net.Socket, Promise<void>>();

  constructor(options: FakeSwitcherOptions = {}) {
    this.options = options;
    this.devices = options.devices ?? realDevices();
    this.#form = this.#idleForm();
    if (options.busyForm) this.#load(this.devices.length);
  }

  static async start(options: FakeSwitcherOptions = {}): Promise<FakeSwitcher> {
    const fake = new FakeSwitcher(options);
    await fake.listen();
    return fake;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.#accept(socket));
      this.#server = server;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  get openConnections(): number {
    return this.#sockets.size;
  }
  /** What the edit form shows now. */
  get form(): Readonly<Form> {
    return { ...this.#form };
  }
  get formIsIdle(): boolean {
    return this.#form.type === -1 && this.#form.changes === -1;
  }

  /** Stop answering. Requests still arrive and wait. */
  hold(): void {
    this.#held = true;
  }
  /** Answer everything that waited, in order. */
  release(): void {
    this.#held = false;
    for (const run of this.#queue.splice(0)) run();
  }

  #idleForm(): Form {
    return {
      selected: 0,
      slot: 0,
      type: -1,
      // The real switcher shows a meaningless driver number while nothing is loaded.
      driverKey: -304901496,
      name: "",
      ip: "0.0.0.0",
      port: 0,
      transport: 0,
      center: 0,
      fsfc: 0,
      busName: 0,
      umdId: 0,
      oneSecond: 0,
      header: 0,
      brightness: 1,
      screen: 0,
      offsetKey: 0,
      changes: -1,
    };
  }

  #load(row: number): void {
    const device = this.devices[row - 1];
    if (row === 0 || !device) {
      this.#form = this.#idleForm();
      this.#mode = "idle";
      return;
    }
    const { enabled: _enabled, ...fields } = device;
    this.#form = { ...fields, selected: row, changes: -1 };
    this.#mode = "viewing";
  }

  #accept(socket: net.Socket): void {
    this.#sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => this.#sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 9) {
        if (!buffer.subarray(0, 4).equals(SYNC)) {
          socket.destroy();
          return;
        }
        const length = buffer.readUInt16BE(7);
        if (buffer.length < 9 + length) return;
        const type = buffer.readUInt8(6);
        const content = Buffer.from(buffer.subarray(9, 9 + length));
        buffer = buffer.subarray(9 + length);
        const oid = content.readUInt16BE(1);
        this.requests.push({ type, oid });
        let write: FakeWrite | undefined;
        if (type === SET_PARAM && oid !== FAKE_OID.connection) {
          const value = content.subarray(4);
          write = {
            oid,
            value: STRING_OIDS.has(oid)
              ? value.subarray(0, Math.max(0, value.indexOf(0))).toString("utf8")
              : value.length >= 4
                ? value.readInt32BE(0)
                : Number.NaN,
          };
          this.writes.push(write);
          this.onWrite?.(write);
        }
        const run = () => this.#answer(socket, type, oid, content);
        if (this.#held) this.#queue.push(run);
        else run();
      }
    });
  }

  #answer(socket: net.Socket, type: number, oid: number, content: Buffer): void {
    let reply: Buffer;
    if (type === GET_PARAM) reply = this.#get(oid);
    else if (type === SET_PARAM) reply = this.#set(oid, content.subarray(4));
    else if (type === GET_DESCRIPTOR) reply = this.#descriptor(oid);
    else return;
    const frame = this.#frame(type | 0x80, reply);
    this.#replies++;
    if (this.options.chatter === false) {
      this.#send(socket, [frame]);
      return;
    }
    // A value report and a clock update nobody asked for, as the real switcher sends.
    const clock = Buffer.concat([Buffer.from([0, 0x7f, 0x41, 9]), cstring("18:56:56")]);
    const before: Buffer[] = [];
    if (this.#replies % 2 === 0) before.push(this.#frame(0x10, Buffer.from([0x7f, 0x41, 1, 2])));
    if (this.#replies % 3 === 0) before.push(this.#frame(SET_PARAM | 0x80, clock));
    if (this.#replies % 4 === 0) before.push(this.#frame(GET_PARAM | 0x80, clock));
    // Junk that starts like a sync and isn't one.
    if (this.#replies % 5 === 0) before.push(Buffer.from([0x00, 0xba, 0xd2]));
    const lead = Buffer.concat(before);
    // Every other reply arrives in two packets, split inside its header.
    if (this.#replies % 2 === 1)
      this.#send(socket, [Buffer.concat([lead, frame.subarray(0, 6)]), frame.subarray(6)]);
    else this.#send(socket, [Buffer.concat([lead, frame])]);
  }

  #send(socket: net.Socket, parts: readonly Buffer[]): void {
    const previous = this.#sending.get(socket) ?? Promise.resolve();
    this.#sending.set(
      socket,
      previous.then(async () => {
        for (const [index, part] of parts.entries()) {
          if (index > 0) await new Promise<void>((resolve) => setImmediate(resolve));
          if (!socket.destroyed) socket.write(part);
        }
      }),
    );
  }

  #frame(type: number, content: Buffer): Buffer {
    const header = Buffer.alloc(9);
    SYNC.copy(header, 0);
    header.writeUInt8(0x10, 4);
    header.writeUInt8(0x00, 5);
    header.writeUInt8(type, 6);
    header.writeUInt16BE(content.length, 7);
    return Buffer.concat([header, content]);
  }

  #ok(oid: number, value: Buffer, lengthByte = value.length & 0xff): Buffer {
    return Buffer.concat([Buffer.from([OK, oid >> 8, oid & 0xff, lengthByte]), value]);
  }
  #error(oid: number, code: number): Buffer {
    return Buffer.from([code, oid >> 8, oid & 0xff]);
  }

  #get(oid: number): Buffer {
    if (oid === FAKE_OID.productName) return this.#ok(oid, cstring("Carbonite"));
    if (oid === FAKE_OID.software) return this.#ok(oid, cstring("9.2.1.18190"));
    if (oid === FAKE_OID.engineType) return this.#ok(oid, cstring("Carbonite Ultra"));
    if (LIST_OIDS.has(oid)) {
      if (this.options.noDeviceList) return this.#error(oid, NOT_FOUND);
      return this.#ok(oid, counted(this.#column(oid)));
    }
    if (oid === FAKE_OID.selectedRow) return this.#ok(oid, int32(this.#form.selected));
    if (oid === FAKE_OID.changes) return this.#ok(oid, int32(this.#form.changes));
    if (oid === FAKE_OID.ip) return this.#ok(oid, cstring(this.#form.ip));
    if (oid === FAKE_OID.name) return this.#ok(oid, cstring(this.#form.name));
    const field = FIELD_OIDS[oid];
    if (field)
      // Seen on the real switcher: Transport's length byte says 1, and four bytes follow.
      return this.#ok(oid, int32(this.#form[field]), oid === FAKE_OID.transport ? 1 : 4);
    return this.#error(oid, NOT_FOUND);
  }

  #staleNames: { names: string[]; until: number } | undefined;
  /** Call just before the device list changes. */
  #listChanging(): void {
    const wait = this.options.listSettlesAfterMs ?? 0;
    if (wait > 0) this.#staleNames = { names: this.#column(FAKE_OID.listName), until: Date.now() + wait };
  }

  #column(oid: number): string[] {
    if (oid === FAKE_OID.listName && this.#staleNames) {
      if (Date.now() < this.#staleNames.until) return this.#staleNames.names;
      this.#staleNames = undefined;
    }
    const serial: Readonly<Record<number, string>> = {
      [FAKE_OID.listSlot]: "SP",
      [FAKE_OID.listType]: "--none--",
    };
    return [
      serial[oid] ?? "",
      ...this.devices.map((device) => {
        if (oid === FAKE_OID.listSlot) return String(device.slot);
        if (oid === FAKE_OID.listType)
          return TYPES.find((type) => type.key === device.type)?.label ?? "";
        if (oid === FAKE_OID.listDriver)
          return driversOf(device.type).find((driver) => driver.key === device.driverKey)?.label ?? "";
        if (oid === FAKE_OID.listIp) return device.ip;
        if (oid === FAKE_OID.listName) return device.name;
        if (oid === FAKE_OID.listPort) return String(device.port);
        return device.enabled ? "On" : "Off";
      }),
    ];
  }

  #descriptor(oid: number): Buffer {
    const choices =
      oid === FAKE_OID.type ? TYPES : oid === FAKE_OID.driver ? driversOf(this.#form.type) : null;
    const name = cstring(
      oid === FAKE_OID.type ? "Device Type" : oid === FAKE_OID.driver ? "Device Driver" : "Parameter",
    );
    const constraint = choices
      ? Buffer.concat([
          Buffer.from([choices.length]),
          ...choices.map((choice) => {
            const label = cstring(choice.label);
            return Buffer.concat([int32(choice.key), Buffer.from([label.length]), label]);
          }),
        ])
      : Buffer.alloc(0);
    const body = Buffer.concat([
      // version, type (INT32), size, access, precision, widget, name length
      Buffer.from([2, 4, 4, 1, 0, 22, name.length]),
      name,
      Buffer.from([choices ? 2 : 0, constraint.length & 0xff]),
      constraint,
    ]);
    return Buffer.concat([Buffer.from([OK, oid >> 8, oid & 0xff, body.length & 0xff]), body]);
  }

  #set(oid: number, value: Buffer): Buffer {
    if (oid === FAKE_OID.connection)
      return this.#ok(
        oid,
        Buffer.from(this.options.refuseHandshake ? [0, 0, 0, 1, 0, 0] : [0, 1, 0, 1, 0, 0]),
      );
    if (LIST_OIDS.has(oid) || oid === FAKE_OID.productName || oid === FAKE_OID.software)
      return this.#error(oid, READ_ONLY);
    const text = STRING_OIDS.has(oid)
      ? value.subarray(0, Math.max(0, value.indexOf(0))).toString("utf8")
      : "";
    if (!STRING_OIDS.has(oid) && value.length < 4) return this.#error(oid, BAD_VALUE);
    const number = STRING_OIDS.has(oid) ? 0 : value.readInt32BE(0);
    const done = () => this.#ok(oid, value);
    const bad = () => this.#error(oid, BAD_VALUE);
    const form = this.#form;

    if (oid === FAKE_OID.selectedRow) {
      if (number < 0 || number > this.devices.length) return bad();
      this.#load(number);
      return done();
    }
    if (oid === FAKE_OID.addDevice) {
      if (number !== 0) return bad();
      const used = new Set(this.devices.map((device) => device.slot));
      let slot = 0;
      while (used.has(slot)) slot++;
      this.#form = {
        ...this.#idleForm(),
        selected: -1,
        slot,
        type: 8,
        driverKey: driversOf(8)[0]?.key ?? 0,
      };
      this.#mode = "adding";
      return done();
    }
    if (oid === FAKE_OID.changes) {
      if (number === 1) {
        if (this.options.dropSave) return done();
        if (this.#mode === "adding") {
          const { selected: _selected, changes: _changes, ...fields } = form;
          this.#listChanging();
          this.devices.push({ ...fields, enabled: true });
          this.#load(this.devices.length);
        } else if (this.#mode === "viewing") {
          const { selected, changes: _changes, ...fields } = form;
          const device = this.devices[selected - 1];
          if (device) Object.assign(device, fields);
        }
        if (this.options.spoilAnotherOnSave && this.devices[1]) this.devices[1].port = 1;
        this.#form.changes = 1;
        return done();
      }
      if (number === 0) {
        this.#load(this.#mode === "adding" ? 0 : form.selected);
        this.#form.changes = 0;
        return done();
      }
      return bad();
    }
    if (oid === FAKE_OID.deleteDevice) {
      if (number !== 1 || this.#mode !== "viewing") return bad();
      this.#listChanging();
      this.devices.splice(form.selected - 1, 1);
      this.#load(form.selected - 1);
      this.#form.changes = 0;
      return done();
    }
    if (oid === FAKE_OID.enableDisable) {
      const device = this.devices[form.selected - 1];
      if ((number !== 2 && number !== 3) || this.#mode !== "viewing" || !device) return bad();
      // As on the real switcher: 2 turns the device on, 3 turns it off, and the list shows
      // it a moment after the write is answered.
      setTimeout(() => {
        device.enabled = number === 2;
      }, 150);
      return done();
    }

    const isField = STRING_OIDS.has(oid) || FIELD_OIDS[oid] !== undefined;
    if (!isField) return this.#error(oid, NOT_FOUND);
    if (this.#mode === "idle") return this.#error(oid, LOCKED);
    if (this.options.forgetWritesTo === oid) return done();
    if (oid === FAKE_OID.ip) {
      form.ip = text;
      return done();
    }
    if (oid === FAKE_OID.name) {
      if (text.length > 8) return bad();
      form.name = text;
      return done();
    }
    if (oid === FAKE_OID.slot) {
      const taken = this.devices.some(
        (device, index) => device.slot === number && index !== form.selected - 1,
      );
      if (number < 0 || number > 31 || taken) return bad();
      form.slot = number;
      return done();
    }
    if (oid === FAKE_OID.type) {
      if (!TYPES.some((type) => type.key === number)) return bad();
      form.type = number;
      form.driverKey = driversOf(number)[0]?.key ?? 0;
      return done();
    }
    if (oid === FAKE_OID.driver) {
      if (!driversOf(form.type).some((driver) => driver.key === number)) return bad();
      form.driverKey = number;
      return done();
    }
    const limits: Readonly<Record<number, number>> = {
      [FAKE_OID.port]: 65535,
      [FAKE_OID.transport]: 1,
      [FAKE_OID.tslBrightness]: 3,
      [FAKE_OID.tslScreen]: 65534,
      [FAKE_OID.tslAddressOffset]: 5,
    };
    const field = FIELD_OIDS[oid];
    if (!field || number < 0 || number > (limits[oid] ?? 1)) return bad();
    form[field] = number;
    return done();
  }
}

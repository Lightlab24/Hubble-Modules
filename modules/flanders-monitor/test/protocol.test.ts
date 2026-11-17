import { describe, expect, it } from "vitest";
import { KEYS } from "../src/keys.js";
import { crc16x25, decodeKeyPacket, keyPacket } from "../src/protocol.js";

/** The exact bytes each of FSI's "Flanders Controls" shell scripts pipes to the monitor. */
const FSI_SCRIPTS: Record<string, string> = {
  "SDI_1.sh": "0106302d0001001100000000",
  "SDI_2.sh": "01062de10001001200000000",
  "SDI_3.sh": "010626a50001001300000000",
  "SDI_4.sh": "010616790001001400000000",
  "menu_button.sh": "0106efb80001002000000000",
  "up_arrow.sh": "0106e4fc0001002100000000",
  "down_arrow.sh": "0106f9300001002200000000",
  "enter_button.sh": "0106c9ec0001002500000000",
  "f1_button.sh": "010650bc0001003100000000",
  "f2_button.sh": "01064d700001003200000000",
  "f3_button.sh": "010646340001003300000000",
  "f4_button.sh": "010676e80001003400000000",
  "f5_button.sh": "01067dac0001003500000000",
  "volume_mute.sh": "0106631b0001004400000000",
  "volume_up.sh": "0106d75b0001005400000000",
  "volume_down.sh": "0106038a0001006400000000",
};

const scriptFor: Record<string, string> = {
  "sdi-1": "SDI_1.sh",
  "sdi-2": "SDI_2.sh",
  "sdi-3": "SDI_3.sh",
  "sdi-4": "SDI_4.sh",
  menu: "menu_button.sh",
  up: "up_arrow.sh",
  down: "down_arrow.sh",
  enter: "enter_button.sh",
  f1: "f1_button.sh",
  f2: "f2_button.sh",
  f3: "f3_button.sh",
  f4: "f4_button.sh",
  f5: "f5_button.sh",
  mute: "volume_mute.sh",
  "volume-up": "volume_up.sh",
  "volume-down": "volume_down.sh",
};

describe("FSI key packets", () => {
  it("uses the standard CRC-16/X-25", () => {
    expect(crc16x25(Buffer.from("123456789"))).toBe(0x906e);
  });

  it("matches every FSI shell script byte for byte", () => {
    expect(KEYS.map((key) => key.id).sort()).toEqual(Object.keys(scriptFor).sort());
    for (const key of KEYS)
      expect(keyPacket(key.code).toString("hex"), key.id).toBe(FSI_SCRIPTS[scriptFor[key.id]!]);
  });

  it("reads a packet back and rejects a bad checksum", () => {
    expect(decodeKeyPacket(keyPacket(0x31))).toBe(0x31);
    const broken = keyPacket(0x31);
    broken[3]! ^= 1;
    expect(decodeKeyPacket(broken)).toBeNull();
    expect(() => keyPacket(256)).toThrow();
  });
});

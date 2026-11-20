/** Reading and setting the one TSL UMD device a Ross Carbonite switcher keeps for this computer. */
export {
  deleteDevice,
  readSwitcher,
  sendDevice,
  SWITCHER_ADDRESS_OFFSETS,
  SWITCHER_OID,
  SWITCHER_WRITABLE_OIDS,
  SwitcherError,
  type SwitcherDeviceRow,
  type SwitcherDeviceSettings,
  type SwitcherMine,
  type SwitcherReading,
  type SwitcherTarget,
} from "./carbonite-devices.js";
export {
  OGP_DEFAULT_PORT,
  OgpAbortError,
  OgpBinaryClient,
  OgpError,
  type OgpConnect,
} from "./ogp-binary.js";

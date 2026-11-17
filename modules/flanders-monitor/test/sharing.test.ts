import { describe, expect, it } from "vitest";
import { appName, describeApps, parseNetstat } from "../src/sharing.js";

// Lines in the shape `netstat -anv -p tcp` prints on macOS 26.
const TABLE = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs
tcp4       0      0  10.0.0.2.51001         10.0.0.9.18181         ESTABLISHED         1210        4381  408192  146988  Livegrade Studio:4410  00102 00000104 000000000253ecf6 00000080 01000800      2      0 000000
tcp4       0      0  10.0.0.2.51002         10.0.0.9.18181         TIME_WAIT              0           0  131072  131072  HubbleAgentNode:999   00102 00000104 000000000253ecf7 00000080 01000800      2      0 000000
tcp4       0      0  10.0.0.2.51003         10.0.0.9.18181         CLOSE_WAIT             0           0  131072  131072               nc:7001  00102 00000104 000000000253ecf8 00000080 01000800      2      0 000000
tcp4       0      0  10.0.0.2.51004         10.0.0.19.18181        ESTABLISHED            0           0  131072  131072     IPRemoteUtil:7002  00102 00000104 000000000253ecf9 00000080 01000800      2      0 000000
tcp4       0      0  10.0.0.2.51005         10.0.0.9.8080          ESTABLISHED            0           0  131072  131072          Safari:7003  00102 00000104 000000000253ecfa 00000080 01000800      2      0 000000
tcp46      0      0  *.18181                *.*                    LISTEN                 0           0  131072  131072            node:7004  00100 00000106 0000000002514249 00000000 00000800      1      0 000000
tcp6       0      0  ::ffff:10.0.0.2.51006  ::ffff:10.0.0.9.18181  SYN_SENT               0           0  131072  131072     IPRemoteUtil:7005  00102 00000104 000000000253ecfb 00000080 01000800      2      0 000000
tcp4       0      0  10.0.0.2.51007         10.0.0.9.18181         ESTABLISHED            0           0  131072  131072  HubbleAgentNode:999   00102 00000104 000000000253ecfc 00000080 01000800      2      0 000000
`;

describe("finding other apps on the monitor's port", () => {
  it("lists open connections to the monitor and port, by any other process", () => {
    expect(parseNetstat(TABLE, "10.0.0.9", 18181, 999)).toEqual([
      { app: "Livegrade Studio", pid: 4410, state: "ESTABLISHED" },
      { app: "IPRemoteUtil", pid: 7005, state: "SYN_SENT" },
    ]);
  });

  it("ignores closing sockets, other monitors, other ports, listeners and its own process", () => {
    expect(parseNetstat(TABLE, "10.0.0.19", 18181, 999)).toEqual([
      { app: "IPRemoteUtil", pid: 7002, state: "ESTABLISHED" },
    ]);
    expect(parseNetstat(TABLE, "10.0.0.9", 9999, 999)).toEqual([]);
    expect(parseNetstat(TABLE, "10.0.0.99", 18181, 999)).toEqual([]);
  });

  it("still notices a connection when the table has no process column", () => {
    const bare = "tcp4       0      0  10.0.0.2.51001         10.0.0.9.18181         ESTABLISHED";
    expect(parseNetstat(bare, "10.0.0.9", 18181)).toEqual([
      { app: "Another app", pid: null, state: "ESTABLISHED" },
    ]);
  });

  it("names apps from their executable paths", () => {
    expect(appName("/Applications/Livegrade.app/Contents/MacOS/Livegrade\n")).toBe("Livegrade");
    expect(appName("/Applications/Livegrade Studio.app/Contents/MacOS/Livegrade Studio")).toBe("Livegrade Studio");
    expect(appName("/usr/bin/nc\n")).toBe("nc");
    expect(describeApps([{ app: "Livegrade", pid: 1, state: "ESTABLISHED" }])).toBe("Livegrade");
    expect(
      describeApps([
        { app: "Livegrade", pid: 1, state: "ESTABLISHED" },
        { app: "nc", pid: 2, state: "ESTABLISHED" },
        { app: "Livegrade", pid: 3, state: "ESTABLISHED" },
        { app: "IP Remote Utility", pid: 4, state: "ESTABLISHED" },
      ]),
    ).toBe("Livegrade, nc and IP Remote Utility");
  });
});

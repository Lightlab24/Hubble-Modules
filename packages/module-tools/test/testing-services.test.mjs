import test from "node:test";
import assert from "node:assert/strict";
import { createModuleHarness } from "../../module-sdk/dist/testing.js";

test("the public harness supplies exchange and host services to simulated instances", async () => {
  const modules = { subscribe: async () => async () => {} },
    services = {};
  const scope = {
    kind: "host",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    capabilityId: "ccc",
  };
  let received;
  const module = {
    createInstance(context) {
      received = context;
      return {
        execute: async () => ({
          status: "failure",
          category: "invalid-config",
          message: "Fixture",
        }),
        dispose() {},
      };
    },
  };
  const fixture = createModuleHarness(
    module,
    { name: "Fixture" },
    { modules, services, scope, connectionEnabled: false },
  );
  assert.equal(received.modules, modules);
  assert.equal(received.connectionEnabled, false);
  assert.equal(received.services, services);
  assert.deepEqual(received.scope, scope);
  assert.deepEqual(fixture.context.settings, { name: "Fixture" });
  await fixture.instance.dispose();
});

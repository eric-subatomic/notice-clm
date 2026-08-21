import assert from "node:assert/strict";
import test from "node:test";
import { negotiationPublicOrigin } from "../app/lib/negotiation-origin";

test("production negotiation links ignore an attacker-controlled request host", () => {
  assert.equal(
    negotiationPublicOrigin(
      { mode: "production", publicBaseUrl: "https://contracts.wealth.example" },
      "https://attacker.example/api/agreements/42/negotiation",
    ),
    "https://contracts.wealth.example",
  );
});

test("evaluation may derive its loopback origin from the request", () => {
  assert.equal(
    negotiationPublicOrigin(
      { mode: "evaluation", publicBaseUrl: null },
      "http://127.0.0.1:3000/api/agreements/42/negotiation",
    ),
    "http://127.0.0.1:3000",
  );
});

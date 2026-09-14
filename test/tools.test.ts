import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadKB, lookupComponent, calcCircuit, debugStep, checkSafety } from "../src/circuit-tools.js";

const kb = loadKB();

describe("knowledge base", () => {
  it("covers required topics", () => {
    for (const k of ["arduino_uno", "esp32", "breadboard", "led", "gpio", "sensors", "motors", "pwm", "mqtt", "code"]) {
      assert.ok(kb.components[k], `missing ${k}`);
    }
    assert.ok(kb.faults.length >= 6);
  });
});

describe("tools", () => {
  it("lookup finds esp32 + strapping gotcha", () => {
    const r = lookupComponent(kb, "esp32") as any;
    assert.equal(r.id, "esp32");
    assert.match(JSON.stringify(r), /strapping/i);
  });
  it("led resistor math picks E12 >= exact", () => {
    const r = calcCircuit({ kind: "led_resistor", vsupply: 5, vf: 2.0, current_ma: 10 }) as any;
    assert.equal(r.recommended_ohms, 330);
    assert.ok(r.actual_current_ma > 0 && r.actual_current_ma <= 10);
  });
  it("rejects zero/negative/missing physics instead of returning garbage", () => {
    for (const args of [
      { kind: "led_resistor", vsupply: 5, vf: 2.0, current_ma: 0 },
      { kind: "led_resistor", vsupply: 5, vf: 2.0, current_ma: -10 },
      { kind: "led_resistor", vsupply: -5, vf: 2.0, current_ma: 10 },
      { kind: "led_resistor", vsupply: 5, vf: Number.NaN, current_ma: 10 },
      { kind: "led_resistor", vsupply: Number.POSITIVE_INFINITY, vf: 2.0, current_ma: 10 },
      { kind: "led_resistor", vsupply: 5, vf: 2.0, current_ma: 200000 },
    ]) {
      const r = calcCircuit(args) as any;
      assert.ok(r.error, `expected error for ${JSON.stringify(args)}`);
      assert.ok(!("recommended_ohms" in r));
    }
  });
  it("returns a business error for unknown calc kinds", () => {
    const r = calcCircuit({ kind: "woozle" }) as any;
    assert.ok(r.error);
  });
  it("calc refuses to invent missing values", () => {
    const r = calcCircuit({ kind: "led_resistor" }) as any;
    assert.ok(!("recommended_ohms" in r), "must not emit a resistor value without inputs");
    assert.ok(Array.isArray(r.need) && r.need.length === 3);
    const partial = calcCircuit({ kind: "led_resistor", vsupply: 5 }) as any;
    assert.ok(!("recommended_ohms" in partial));
  });
  it("LED symptom asks a disambiguating question, never ohms", () => {
    const r = debugStep(kb, "My Arduino LED isn't lighting up. Can you help me troubleshoot it?") as any;
    assert.equal(r.narrowed, true);
    assert.equal(r.fault_id, "led_dead");
    assert.match(r.next_question, /built-in/i);
    assert.ok(!/[0-9]+\s*(Ω|ohm)/i.test(JSON.stringify(r)), "must not state a resistor value");
    assert.ok(Array.isArray(r.hypotheses) && r.hypotheses.length <= 2);
  });
  it("debug narrows to one next question (no dump)", () => {
    const r = debugStep(kb, "my esp32 resets when the motor starts") as any;
    assert.equal(r.narrowed, true);
    assert.ok(r.next_question);
    assert.ok((r.follow_ups?.length ?? 0) <= 2);
  });
  it("safety triggers only on risky input", () => {
    assert.ok(checkSafety(kb, "switching mains with a relay"));
    assert.equal(checkSafety(kb, "my LED won't light"), null);
  });
  it("dangerous situations demand supervision, not procedures", () => {
    assert.match(checkSafety(kb, "switching mains with a relay") ?? "", /supervise|professional|adult/i);
    assert.match(checkSafety(kb, "my lipo pack is puffy") ?? "", /supervise|adult|stop/i);
  });
});

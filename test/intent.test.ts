import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../src/circuit-tools.js";

describe("classifyIntent", () => {
  // ----- GENUINE TROUBLESHOOTING -----
  it("classifies 'My LED isn't turning on.' as troubleshooting", () => {
    const result = classifyIntent("My LED isn't turning on.");
    assert.strictEqual(result.intent, "troubleshooting");
    assert.strictEqual(result.confidence, 0.95);
  });

  it("classifies 'My ESP32 keeps resetting when I start my motor.' as troubleshooting", () => {
    const result = classifyIntent("My ESP32 keeps resetting when I start my motor.");
    assert.strictEqual(result.intent, "troubleshooting");
  });

  it("classifies 'My MQTT connection isn't working.' as troubleshooting", () => {
    const result = classifyIntent("My MQTT connection isn't working.");
    assert.strictEqual(result.intent, "troubleshooting");
  });

  // ----- KNOWLEDGE -----
  it("classifies 'Why does an LED need a resistor?' as knowledge", () => {
    const result = classifyIntent("Why does an LED need a resistor?");
    assert.strictEqual(result.intent, "knowledge");
  });

  it("classifies 'why do LEDs need resistors' as knowledge", () => {
    const result = classifyIntent("why do LEDs need resistors");
    assert.strictEqual(result.intent, "knowledge");
  });

  it("classifies 'What is PWM?' as knowledge", () => {
    const result = classifyIntent("What is PWM?");
    assert.strictEqual(result.intent, "knowledge");
  });

  it("classifies 'What is the difference between Arduino Uno and ESP32?' as knowledge", () => {
    const result = classifyIntent("What is the difference between Arduino Uno and ESP32?");
    assert.strictEqual(result.intent, "knowledge");
  });

  // ----- CODING -----
  it("classifies 'Can you do coding?' as coding", () => {
    const result = classifyIntent("Can you do coding?");
    assert.strictEqual(result.intent, "coding");
  });

  it("classifies 'How good are you at coding?' as coding", () => {
    const result = classifyIntent("How good are you at coding?");
    assert.strictEqual(result.intent, "coding");
  });

  it("classifies 'Write Arduino code to blink an LED.' as coding", () => {
    const result = classifyIntent("Write Arduino code to blink an LED.");
    assert.strictEqual(result.intent, "coding");
  });

  it("classifies 'Why does my C++ code fail to compile?' as coding", () => {
    const result = classifyIntent("Why does my C++ code fail to compile?");
    assert.strictEqual(result.intent, "coding");
  });

  // ----- PROJECT -----
  it("classifies 'Help me build an obstacle avoiding robot.' as project", () => {
    const result = classifyIntent("Help me build an obstacle avoiding robot.");
    assert.strictEqual(result.intent, "project");
  });

  it("classifies 'How should I connect my ESP32 and sensor?' as project", () => {
    const result = classifyIntent("How should I connect my ESP32 and sensor?");
    assert.strictEqual(result.intent, "project");
  });

  it("classifies 'I want to build a smart plant monitor' as project", () => {
    const result = classifyIntent("I want to build a smart plant monitor");
    assert.strictEqual(result.intent, "project");
  });

  // ----- CALCULATION -----
  it("classifies 'What resistor should I use with 5V?' as calc", () => {
    const result = classifyIntent("What resistor should I use with 5V?");
    assert.strictEqual(result.intent, "calc");
  });

  it("classifies 'What resistor should I use?' as calc", () => {
    const result = classifyIntent("What resistor should I use?");
    assert.strictEqual(result.intent, "calc");
  });

  // ----- OUT OF SCOPE -----
  it("classifies 'Can you build an LLM?' as out_of_scope", () => {
    const result = classifyIntent("Can you build an LLM?");
    assert.strictEqual(result.intent, "out_of_scope");
  });

  it("classifies 'hello' as out_of_scope", () => {
    const result = classifyIntent("hello");
    assert.strictEqual(result.intent, "out_of_scope");
  });

  it("classifies 'What's the weather?' as out_of_scope", () => {
    const result = classifyIntent("What's the weather?");
    assert.strictEqual(result.intent, "out_of_scope");
  });

  // ----- GENERALIZATION VARIANTS (not hardcoded to exact sentences) -----
  it("classifies 'do I need a resistor with my LED?' as knowledge (not calc, no numbers)", () => {
    const result = classifyIntent("do I need a resistor with my LED?");
    assert.strictEqual(result.intent, "knowledge");
  });

  it("classifies 'arduino led resistor value' as knowledge", () => {
    const result = classifyIntent("arduino led resistor value");
    assert.strictEqual(result.intent, "knowledge");
  });

  it("classifies 'my esp32 freezes when wifi connects' as troubleshooting (has 'freezes' + 'esp32')", () => {
    const result = classifyIntent("my esp32 freezes when wifi connects");
    assert.strictEqual(result.intent, "troubleshooting");
  });

  it("classifies 'can you help me with my arduino project' as project (has 'project' + 'arduino')", () => {
    const result = classifyIntent("can you help me with my arduino project");
    assert.strictEqual(result.intent, "project");
  });

  it("classifies 'can you help me with my arduino project' does NOT classify as troubleshooting", () => {
    const result = classifyIntent("can you help me with my arduino project");
    assert.strictNotEqual(result.intent, "troubleshooting");
  });

  it("classifies 'why does my c++ code fail to compile' as coding (not troubleshooting)", () => {
    const result = classifyIntent("why does my c++ code fail to compile");
    assert.strictEqual(result.intent, "coding");
    assert.strictNotEqual(result.intent, "troubleshooting");
  });
});

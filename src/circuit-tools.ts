import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const kbDir = join(here, "knowledge");

export type KnowledgeBase = {
  components: Record<string, any>;
  faults: any[];
  safety: any[];
};

export type Intent = "knowledge" | "coding" | "project" | "troubleshooting" | "calc" | "out_of_scope";

export function loadKB(): KnowledgeBase {
  const components = JSON.parse(readFileSync(join(kbDir, "components.json"), "utf8"));
  const faults = JSON.parse(readFileSync(join(kbDir, "faults.json"), "utf8"));
  const safety = JSON.parse(readFileSync(join(kbDir, "safety.json"), "utf8"));
  return { components, faults, safety };
}

export function lookupComponent(kb: KnowledgeBase, query: string): Record<string, unknown> {
  const q = query.toLowerCase();
  const keys = Object.keys(kb.components);
  // Direct id match first, then fuzzy name/content match.
  const direct = keys.find((k) => k === q || kb.components[k].name?.toLowerCase().includes(q));
  if (direct) return { id: direct, ...kb.components[direct] };
  const scored = keys
    .map((k) => ({ k, text: JSON.stringify(kb.components[k]).toLowerCase() }))
    .filter((e) => q.split(/[\s_/-]+/).some((tok) => tok.length > 2 && e.text.includes(tok)));
  if (scored.length > 0) {
    const k = scored[0].k;
    return { id: k, ...kb.components[k] };
  }
  return { error: `No entry for '${query}'. Try: ${keys.join(", ")}` };
}

export function calcCircuit(args: {
  kind: string;
  vsupply?: number;
  vf?: number;
  current_ma?: number;
}): Record<string, unknown> {
  if (args.kind === "led_resistor") {
    // Never invent values: without Vs + Vf/color + current there is no answer.
    const missing: string[] = [];
    if (args.vsupply === undefined) missing.push("supply voltage (Vs)");
    if (args.vf === undefined) missing.push("LED forward voltage or color");
    if (args.current_ma === undefined) missing.push("target current in mA");
    if (missing.length > 0) {
      return {
        need: missing,
        formula: "R = (Vs - Vf) / I",
        hint: "Ask the builder for the missing values first. Never assume 5V, a red LED, or 10mA.",
      };
    }
    const MAX_VOLTS = 1000;
    const MAX_CURRENT_MA = 100000;
    const invalid = (key: "vsupply" | "vf" | "current_ma", value: number, cap: number): boolean =>
      !(typeof value === "number" && Number.isFinite(value) && value > 0 && value <= cap);
    if (invalid("vsupply", args.vsupply as number, MAX_VOLTS)) return { error: "'vsupply' must be a number greater than 0." };
    if (invalid("vf", args.vf as number, MAX_VOLTS)) return { error: "'vf' must be a number greater than 0." };
    if (invalid("current_ma", args.current_ma as number, MAX_CURRENT_MA)) return { error: "'current_ma' must be a number greater than 0." };
    const vs = args.vsupply as number;
    const vf = args.vf as number;
    const i = (args.current_ma as number) / 1000;
    if (vs <= vf) return { error: `Supply ${vs}V must exceed LED Vf ${vf}V.` };
    const exact = (vs - vf) / i;
    if (exact > 1000000) return { error: "The computed resistor exceeds the supported range." };
    const e12 = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82];
    let best = 10000;
    let found = false;
    for (let decade = 1; decade <= 10000; decade *= 10) {
      for (const v of e12) {
        const r = v * decade;
        if (r >= exact && r < best) {
          best = r;
          found = true;
        }
      }
    }
    if (!found) return { error: "No E12 resistor is large enough for this circuit." };
    const actual_ma = ((vs - vf) / best) * 1000;
    const power_mw = (vs - vf) * actual_ma;
    return {
      exact_ohms: Math.round(exact),
      recommended_ohms: best,
      actual_current_ma: Math.round(actual_ma * 10) / 10,
      resistor_power_mw: Math.round(power_mw * 10) / 10,
      note: "1/4W resistor is plenty. Long LED leg (anode) goes toward + through the resistor.",
    };
  }
  if (args.kind === "divider") {
    // Returns R2/(R1+R2) suggestion for 5V->3V3: R1=1k8? Use classic 1k/2k.
    return {
      suggestion: "For 5V → 3.3V signals use R1=1kΩ (top) + R2=2kΩ (bottom). Vout = 5*2/3 ≈ 3.33V.",
      formula: "Vout = Vin * R2/(R1+R2)",
    };
  }
  if (args.kind === "ohms_law") {
    return { formula: "V=I*R, P=V*I. Example: 5V across 330Ω → I=15mA, P=76mW." };
  }
  return { error: `Unknown calc kind '${args.kind}'. Use led_resistor, divider, or ohms_law.` };
}

const STOPWORDS = new Set(
  "my you help the and for with what when how why not but has have had are was were this that these those from into over under again once here there its me please just like get got try tried thing things something anything still also very much more most than then them they his her our your about into out off all any each few such only own same too will would should could won isn doesn dont cant a an of to in on it as at by be or if so up do does did no yet already ever never always".split(" ")
);

function stem(w: string): string {
  if (w.length > 4) return w.replace(/(ing|ed|es|s)$/, "");
  if (w.length > 3) return w.replace(/(es|s)$/, "");
  return w;
}

function contentTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .map(stem);
}

function scoreFault(f: any, queryTokens: string[]): { total: number; solid: number } {
  const idParts = String(f.id ?? "").toLowerCase().split(/[^a-z0-9]+/).map(stem);
  const words = new Set(contentTokens(`${f.symptom ?? ""} ${idParts.join(" ")} ${(f.causes ?? []).join(" ")}`));
  const hay = [...words].join(" ");
  let total = 0;
  let solid = 0;
  for (const tok of new Set(queryTokens)) {
    if (idParts.includes(tok)) { total += 3; solid++; continue; }
    if (words.has(tok)) { total += 2; solid++; continue; }
    if (hay.includes(tok)) total += 1;
  }
  return { total, solid };
}

const ELECTRONICS_RE =
  /arduino|esp32|led|gpio|pwm|mqtt|sensor|dht|hc[-\s]?sr04|ultrasonic|i2c|motor|servo|l298n|tb6612|breadboard|resistor|capacitor|mosfet|multimeter|voltage|ohm|circuit|micropython/i;

function intentTopic(text: string): string | undefined {
  const t = text.toLowerCase();
  if (/\barduino\b/.test(t)) return "arduino_uno";
  if (/\besp32\b/.test(t)) return "esp32";
  if (/\bgpio\b/.test(t)) return "gpio";
  if (/\bpwm\b/.test(t)) return "pwm";
  if (/\bmqtt\b|\bi2c\b/.test(t)) return "mqtt";
  if (/\bsensor\b|\bdht\b|hc[-\s]?sr04|ultrasonic/.test(t)) return "sensors";
  if (/\bmotor\b|\bservo\b|l298n|tb6612/.test(t)) return "motors";
  if (/\bbreadboard\b/.test(t)) return "breadboard";
  if (/\bled\b|\bresistor\b|\bohm\b|capacitor|multimeter|voltage|circuit/.test(t)) return "led";
  if (/c\+\+|\bpython\b|micropython|\bcompile\b|\bsketch\b|\bfirmware\b|\bcoding\b|\bcode\b/.test(t)) return "code";
  return undefined;
}

/**
 * Lightweight intent router: classifies a user message before responding.
 * Assist layer only — the LLM (or mock UI) still decides the final wording.
 * Priority order resolves overlaps: coding > calc > troubleshooting > project > knowledge > out_of_scope.
 */
export function classifyIntent(message: string): { intent: Intent; topic?: string; confidence: number } {
  const raw = String(message ?? "");
  const text = raw.toLowerCase().trim();
  if (!text) return { intent: "out_of_scope", confidence: 0.6 };
  const norm = text.replace(/["'?,.!;:()]/g, " ").replace(/\s+/g, " ");

  // 1. CODING — explicit programming language beats failure words ("fail to compile").
  const codingRe = /c\+\+|\bcompile\w*|\bsketch\b|\bfirmware\b|\bmicropython\b|\bpython\b|\bcoding\b|\bcode\b|\blink\b.*\bcode\b|\bcode\b.*\b(blink|debug|error|function)\b|\bwrite\b.*\bcode\b|\bdebug\b/;
  if (codingRe.test(text)) {
    return { intent: "coding", topic: intentTopic(text) ?? "code", confidence: 0.9 };
  }

  // 2. CALC — explicit resistor/value calculation request (not "why"/"do I need").
  const resistorCtx = /resistor|ohm|\u03a9/.test(text);
  const isWhyResistor = /^why\b[\s\S]*resistor|why\s+do[\s\S]*resistor/i.test(text);
  const explicitCalcAsk =
    /\bshould\s+i\s+use\b/i.test(text) ||
    /\bwhat\b[\s\S]*\b(resistor|value|ohm)[\s\S]*\buse\b/i.test(text) ||
    /\bcalculat\w*\b[\s\S]*(resistor|ohm|value)|(\bresistor\b|\bohm\b)[\s\S]*\bcalculat\w*\b/i.test(text) ||
    /\bhow\s+many\s+ohms\b/i.test(text) ||
    (resistorCtx && /\d/i.test(text) && /\b(need|use|value|what|which|for|with)\b/i.test(text));
  if (!isWhyResistor && resistorCtx && explicitCalcAsk) {
    return { intent: "calc", topic: "led", confidence: 0.85 };
  }

  // 3. TROUBLESHOOTING — genuine failure language + electronics context.
  const failureRe =
    /isn'?t|aren'?t|not\s+working|not\s+turning\s+on|not\s+lighting|won'?t|doesn'?t\s+work|don'?t\s+work|keeps?\s+resetting|\bresetting\b|\bresets?\b|freez\w*|frozen|broken|\bdead\b|\bfail\w*\b|disconnect\w*|no\s+power|nothing\s+(turns|works|lights)|smoke|burning/i;
  if (failureRe.test(text) && ELECTRONICS_RE.test(text)) {
    return { intent: "troubleshooting", topic: intentTopic(text), confidence: 0.95 };
  }

  // 4. PROJECT — build/design/connect request with a project-domain noun.
  const buildVerb = /\bhelp\b|\bbuild\b|\bdesign\b|\bmake\b|\bcreate\b|\bconstruct\b|\bassemble\b|\bplan\b|\bset\s*up\b|\bconnect\b|\bwire\b|\bhook\s*up\b/i.test(text);
  const projectNoun =
    /\brobot\b|\barduino\b|\besp32\b|\bsensor\b|\bmotor\b|\bservo\b|\biot\b|\bplant\b|\bmonitor\b|\bsmart\b|\bcircuit\b|\bdevice\b|\bsystem\b|\bproject\b|\bdrone\b|\bcar\b|\btank\b|\barm\b|\bobstacle\b|\bhome\s*automation\b/i.test(text);
  if (buildVerb && projectNoun) {
    return { intent: "project", topic: intentTopic(text), confidence: 0.85 };
  }

  // 5. KNOWLEDGE — explanatory question or bare electronics topic phrase.
  const explanatory =
    /^(why|what|how|which|when|where|is|are|do|does|can|explain|define|tell)\b|\bwhy\s+do(es)?\b|\bwhat\s+is\b|\bwhat'?s\b|\bhow\s+does\b|\bdifference\s+between\b|\bvs\.?\b|\bexplain\b|\bdefine\b|\bdo\s+i\s+need\b|\bvalue\b/i.test(text);
  const electronicsTokens = (text.match(/arduino|esp32|led|resistor|gpio|pwm|mqtt|sensor|dht|ultrasonic|i2c|motor|servo|breadboard|capacitor|mosfet|multimeter|voltage|ohm|circuit/g) ?? []).length;
  if (ELECTRONICS_RE.test(text) && (explanatory || electronicsTokens >= 2 || /\bneed\b.*\bresistor\b|\bresistor\b.*\bneed\b/i.test(text))) {
    return { intent: "knowledge", topic: intentTopic(text), confidence: 0.9 };
  }

  // 6. OUT OF SCOPE — default.
  void norm;
  return { intent: "out_of_scope", confidence: 0.6 };
}

export function debugStep(kb: KnowledgeBase, symptom: string): Record<string, unknown> {
  const queryTokens = contentTokens(symptom);
  const scored = kb.faults
    .map((f: any) => ({ f, ...scoreFault(f, queryTokens) }))
    .sort((a, b) => b.total - a.total || b.solid - a.solid);
  const best = scored[0];
  // Require at least one solid (whole-word or id) hit: never guess from noise.
  // Softened fallback: a single gentle prompt, not a troubleshooting checklist.
  if (!best || best.solid === 0) {
    return {
      narrowed: false,
      ask: ["What exactly is happening?"],
      candidates: kb.faults.map((f: any) => f.id),
    };
  }
  // Progressively narrow: top candidate + ONE next question + ranked hypotheses.
  // Never a checklist dump; the caller asks ONLY next_question.
  const f = best.f as any;
  return {
    narrowed: true,
    fault_id: f.id,
    symptom: f.symptom,
    next_question: f.ask?.[0] ?? "What do you measure?",
    follow_ups: (f.ask ?? []).slice(1, 3),
    hypotheses: (f.causes ?? []).slice(0, 2),
    likely_causes: f.causes ?? [],
    fix: f.fix ?? null,
  };
}

export function checkSafety(kb: KnowledgeBase, text: string): string | null {
  const q = text.toLowerCase();
  for (const rule of kb.safety) {
    if ((rule.trigger as string[]).some((t) => q.includes(t))) return rule.message as string;
  }
  return null;
}

import type { MeshNetwork } from "./simulation.ts";

export interface CameraNodeMetric {
  name: string;
  network: string;
  lat: number;
  lng: number;
  online: boolean;
  cpu: number;
  mem: number;
  disk: number;
  gpu: number;
  load1m: number;
  rttMs: number;
  rttP95: number;
  cores: number;
  blobs: number;
}

export interface CameraTarget {
  lat: number;
  lng: number;
  node?: string | null;
  network?: string | null;
  reason?: string;
  distance?: number;
}

export interface CameraContext {
  nodes: CameraNodeMetric[];
  activeNetwork: string;
  timeSec: number;
}

export interface CameraPreset {
  id: string;
  label: string;
  code: string;
}

export const CAMERA_PRESETS: CameraPreset[] = [
  {
    id: "highest-cpu",
    label: "highest CPU",
    code: `// Focus the online node with the highest CPU utilization
export function selectTarget(ctx: CameraContext): CameraTarget | null {
  const hot = maxBy(ctx.nodes.filter(n => n.online), n => n.cpu);
  return hot
    ? { lat: hot.lat, lng: hot.lng, node: hot.name, network: hot.network, reason: "highest CPU " + hot.cpu + "%" }
    : null;
}`,
  },
  {
    id: "lowest-mem",
    label: "lowest MEM",
    code: `// Focus the online node with the lowest memory utilization
export function selectTarget(ctx: CameraContext): CameraTarget | null {
  const cool = minBy(ctx.nodes.filter(n => n.online), n => n.mem);
  return cool
    ? { lat: cool.lat, lng: cool.lng, node: cool.name, network: cool.network, reason: "lowest MEM " + cool.mem + "%" }
    : null;
}`,
  },
  {
    id: "highest-p95",
    label: "highest p95 latency",
    code: `// Focus the node experiencing the highest p95 mesh latency
export function selectTarget(ctx: CameraContext): CameraTarget | null {
  const slow = maxBy(ctx.nodes.filter(n => n.online), n => n.rttP95);
  return slow
    ? { lat: slow.lat, lng: slow.lng, node: slow.name, network: slow.network, reason: "p95 " + slow.rttP95 + "ms" }
    : null;
}`,
  },
  {
    id: "composite-stress",
    label: "composite (CPU + MEM + p95)",
    code: `// Composite score: 45% CPU + 35% MEM + 20% capped p95 latency
export function selectTarget(ctx: CameraContext): CameraTarget | null {
  const score = (n: CameraNodeMetric) =>
    n.cpu * 0.45 + n.mem * 0.35 + Math.min(100, n.rttP95) * 0.20;
  const top = maxBy(ctx.nodes.filter(n => n.online), score);
  return top
    ? { lat: top.lat, lng: top.lng, node: top.name, network: top.network, reason: "stress " + Math.round(score(top)) }
    : null;
}`,
  },
  {
    id: "network-centroid",
    label: "active network centroid",
    code: `// Aim at the geographic centroid of the currently focused network
export function selectTarget(ctx: CameraContext): CameraTarget | null {
  const peers = ctx.nodes.filter(n => n.network === ctx.activeNetwork);
  const center = centroid(peers.length > 0 ? peers : ctx.nodes);
  return center
    ? { lat: center.lat, lng: center.lng, network: ctx.activeNetwork, reason: ctx.activeNetwork + " centroid" }
    : null;
}`,
  },
];

export function buildCameraContext(
  networks: MeshNetwork[],
  activeNetwork: string,
  timeSec = 0,
): CameraContext {
  const nodes: CameraNodeMetric[] = [];
  for (const net of networks) {
    for (const h of net.hosts) {
      const baseRtt =
        typeof h.rtt_ms === "number" && h.rtt_ms > 0 ? h.rtt_ms : 1.8;
      const cpu = Math.round((h.stats.cpu_percent ?? 0) * 10) / 10;
      const mem = Math.round((h.stats.mem_percent ?? 0) * 10) / 10;
      const disk = Math.round((h.stats.disk_percent ?? 0) * 10) / 10;
      const gpu = Math.round((h.gpuLoadPercent ?? 0) * 10) / 10;
      // Realistic p95 latency derived from base RTT + load jitter
      const rttP95 =
        Math.round(baseRtt * (1.28 + (cpu / 100) * 0.42) * 10) / 10;
      nodes.push({
        name: h.name,
        network: net.slug,
        lat: h.lat,
        lng: h.lng,
        online: h.online,
        cpu,
        mem,
        disk,
        gpu,
        load1m: Math.round((h.stats.load_avg_1m ?? 0) * 100) / 100,
        rttMs: Math.round(baseRtt * 10) / 10,
        rttP95,
        cores: h.stats.cpu_cores ?? 0,
        blobs: h.blobStore.objects,
      });
    }
  }
  return { nodes, activeNetwork, timeSec };
}

export interface PolicyEvalResult {
  ok: boolean;
  target: CameraTarget | null;
  error?: string;
}

/* ===== CSP-Safe Sandboxed TypeScript Expression & Policy Interpreter ===== */

type TokenKind =
  | "num"
  | "str"
  | "id"
  | "op"
  | "punc"
  | "eof";

interface Token {
  kind: TokenKind;
  value: string;
}

const MULTI_OPS = new Set([
  "===",
  "!==",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "=>",
]);

function stripCommentsAndTypes(source: string): string {
  // Remove block & line comments while preserving string literals
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i];
        out += c;
        if (c === "\\" && i + 1 < source.length) {
          out += source[i + 1];
          i += 2;
          continue;
        }
        i += 1;
        if (c === quote) break;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }

  // Strip top-level TS `interface ... { ... }` and `type ... = ...;`
  out = out.replace(/\b(?:export\s+)?interface\s+\w+\s*\{[^}]*\}/g, "");
  out = out.replace(/\b(?:export\s+)?type\s+\w+\s*=\s*[^;]+;/g, "");

  // Extract body of `selectTarget(...) { ... }` if present
  const fnMatch = out.match(
    /(?:export\s+)?function\s+selectTarget\s*\(([^)]*)\)(?:\s*:\s*[^\{]+)?\s*\{([\s\S]*)\}\s*$/,
  );
  if (fnMatch) {
    const rawParam = fnMatch[1].split(":")[0].trim() || "ctx";
    const body = fnMatch[2];
    const alias = rawParam === "ctx" ? "" : `const ${rawParam} = ctx;\n`;
    out = alias + body;
  }

  // Strip TypeScript variable type annotations: `const x: number =`
  out = out.replace(
    /(\b(?:const|let)\s+\w+)\s*:\s*[A-Za-z0-9_<>\[\]|\s?.]+(?==)/g,
    "$1 ",
  );
  // Strip TypeScript parameter & return type annotations ONLY on arrow functions `(a: T, b: U): R =>`
  out = out.replace(
    /\(([^()]*)\)(\s*:\s*[A-Za-z0-9_<>\[\]|\s?.]+)?\s*=>/g,
    (_full, rawParams: string) => {
      const cleanParams = rawParams
        .split(",")
        .map((part) => part.split(":")[0].trim())
        .filter(Boolean)
        .join(", ");
      return `(${cleanParams}) =>`;
    },
  );
  out = out.replace(/\bas\s+[A-Za-z0-9_<>\[\]|]+/g, "");

  return out.trim();
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let val = "";
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          val += src[i + 1];
          i += 2;
        } else {
          val += src[i];
          i += 1;
        }
      }
      if (src[i] !== quote) {
        throw new Error("Unterminated string literal");
      }
      i += 1;
      tokens.push({ kind: "str", value: val });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let num = "";
      while (i < src.length && /[0-9.]/.test(src[i])) {
        num += src[i];
        i += 1;
      }
      tokens.push({ kind: "num", value: num });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let id = "";
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) {
        id += src[i];
        i += 1;
      }
      tokens.push({ kind: "id", value: id });
      continue;
    }
    const three = src.slice(i, i + 3);
    if (MULTI_OPS.has(three)) {
      tokens.push({ kind: "op", value: three });
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (MULTI_OPS.has(two)) {
      tokens.push({ kind: "op", value: two });
      i += 2;
      continue;
    }
    if ("+-*/%<>!=".includes(ch)) {
      tokens.push({ kind: "op", value: ch });
      i += 1;
      continue;
    }
    if ("(){}[],.:;?".includes(ch)) {
      tokens.push({ kind: "punc", value: ch });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character '${ch}'`);
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}

type AstNode =
  | { type: "program"; stmts: AstNode[] }
  | { type: "var"; name: string; init: AstNode }
  | { type: "return"; expr: AstNode | null }
  | { type: "if"; test: AstNode; consequent: AstNode; alternate: AstNode | null }
  | { type: "block"; stmts: AstNode[] }
  | { type: "lit"; value: unknown }
  | { type: "id"; name: string }
  | { type: "array"; items: AstNode[] }
  | { type: "object"; props: Array<{ key: string; value: AstNode }> }
  | { type: "arrow"; params: string[]; body: AstNode }
  | { type: "unary"; op: string; arg: AstNode }
  | { type: "binary"; op: string; left: AstNode; right: AstNode }
  | { type: "ternary"; test: AstNode; yes: AstNode; no: AstNode }
  | { type: "member"; obj: AstNode; prop: string }
  | { type: "index"; obj: AstNode; idx: AstNode }
  | { type: "call"; callee: AstNode; args: AstNode[] };

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? { kind: "eof", value: "" };
  }

  private next(): Token {
    const t = this.peek();
    this.pos += 1;
    return t;
  }

  private expect(kind: TokenKind, value?: string): Token {
    const t = this.next();
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw new Error(
        `Expected ${value ?? kind} but found '${t.value || t.kind}'`,
      );
    }
    return t;
  }

  private match(kind: TokenKind, value?: string): boolean {
    const t = this.peek();
    if (t.kind === kind && (value === undefined || t.value === value)) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseProgram(): AstNode {
    const stmts: AstNode[] = [];
    while (this.peek().kind !== "eof") {
      if (this.match("punc", ";")) continue;
      stmts.push(this.parseStmt());
      this.match("punc", ";");
    }
    return { type: "program", stmts };
  }

  private parseStmt(): AstNode {
    const t = this.peek();
    if (t.kind === "id" && (t.value === "const" || t.value === "let")) {
      this.next();
      const name = this.expect("id").value;
      this.expect("op", "=");
      const init = this.parseExpr();
      return { type: "var", name, init };
    }
    if (t.kind === "id" && t.value === "return") {
      this.next();
      if (this.peek().kind === "eof" || this.peek().value === ";" || this.peek().value === "}") {
        return { type: "return", expr: null };
      }
      return { type: "return", expr: this.parseExpr() };
    }
    if (t.kind === "id" && t.value === "if") {
      this.next();
      this.expect("punc", "(");
      const test = this.parseExpr();
      this.expect("punc", ")");
      const consequent = this.parseStmt();
      let alternate: AstNode | null = null;
      if (this.peek().kind === "id" && this.peek().value === "else") {
        this.next();
        alternate = this.parseStmt();
      }
      return { type: "if", test, consequent, alternate };
    }
    if (t.kind === "punc" && t.value === "{") {
      return this.parseBlock();
    }
    return this.parseExpr();
  }

  private parseBlock(): AstNode {
    this.expect("punc", "{");
    const stmts: AstNode[] = [];
    while (this.peek().kind !== "eof" && this.peek().value !== "}") {
      if (this.match("punc", ";")) continue;
      stmts.push(this.parseStmt());
      this.match("punc", ";");
    }
    this.expect("punc", "}");
    return { type: "block", stmts };
  }

  private parseExpr(): AstNode {
    return this.parseArrowOrTernary();
  }

  private parseArrowOrTernary(): AstNode {
    // Single-param arrow: `n => ...`
    if (
      this.peek(0).kind === "id" &&
      this.peek(1).kind === "op" &&
      this.peek(1).value === "=>"
    ) {
      const param = this.next().value;
      this.next(); // =>
      const body =
        this.peek().value === "{" ? this.parseBlock() : this.parseExpr();
      return { type: "arrow", params: [param], body };
    }

    // Multi-param or zero-param arrow: `(a, b) => ...`
    if (this.peek(0).value === "(") {
      const saved = this.pos;
      try {
        this.next();
        const params: string[] = [];
        if (this.peek().value !== ")") {
          while (true) {
            if (this.peek().kind !== "id") throw new Error("not arrow");
            params.push(this.next().value);
            if (!this.match("punc", ",")) break;
          }
        }
        this.expect("punc", ")");
        if (this.match("op", "=>")) {
          const body =
            this.peek().value === "{" ? this.parseBlock() : this.parseExpr();
          return { type: "arrow", params, body };
        }
      } catch {
        // backtrack to normal parenthesized expression
      }
      this.pos = saved;
    }

    const expr = this.parseNullish();
    if (this.match("punc", "?")) {
      const yes = this.parseExpr();
      this.expect("punc", ":");
      const no = this.parseExpr();
      return { type: "ternary", test: expr, yes, no };
    }
    return expr;
  }

  private parseNullish(): AstNode {
    let left = this.parseOr();
    while (this.match("op", "??")) {
      left = { type: "binary", op: "??", left, right: this.parseOr() };
    }
    return left;
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.match("op", "||")) {
      left = { type: "binary", op: "||", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseEquality();
    while (this.match("op", "&&")) {
      left = { type: "binary", op: "&&", left, right: this.parseEquality() };
    }
    return left;
  }

  private parseEquality(): AstNode {
    let left = this.parseCompare();
    while (
      this.peek().kind === "op" &&
      ["===", "!==", "==", "!="].includes(this.peek().value)
    ) {
      const op = this.next().value;
      left = { type: "binary", op, left, right: this.parseCompare() };
    }
    return left;
  }

  private parseCompare(): AstNode {
    let left = this.parseAdd();
    while (
      this.peek().kind === "op" &&
      ["<", "<=", ">", ">="].includes(this.peek().value)
    ) {
      const op = this.next().value;
      left = { type: "binary", op, left, right: this.parseAdd() };
    }
    return left;
  }

  private parseAdd(): AstNode {
    let left = this.parseMul();
    while (
      this.peek().kind === "op" &&
      (this.peek().value === "+" || this.peek().value === "-")
    ) {
      const op = this.next().value;
      left = { type: "binary", op, left, right: this.parseMul() };
    }
    return left;
  }

  private parseMul(): AstNode {
    let left = this.parseUnary();
    while (
      this.peek().kind === "op" &&
      ["*", "/", "%"].includes(this.peek().value)
    ) {
      const op = this.next().value;
      left = { type: "binary", op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): AstNode {
    if (
      this.peek().kind === "op" &&
      (this.peek().value === "!" || this.peek().value === "-")
    ) {
      const op = this.next().value;
      return { type: "unary", op, arg: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): AstNode {
    let node = this.parsePrimary();
    while (true) {
      if (this.match("punc", ".")) {
        const prop = this.expect("id").value;
        node = { type: "member", obj: node, prop };
      } else if (this.match("punc", "[")) {
        const idx = this.parseExpr();
        this.expect("punc", "]");
        node = { type: "index", obj: node, idx };
      } else if (this.match("punc", "(")) {
        const args: AstNode[] = [];
        if (this.peek().value !== ")") {
          while (true) {
            args.push(this.parseExpr());
            if (!this.match("punc", ",")) break;
            if (this.peek().value === ")") break;
          }
        }
        this.expect("punc", ")");
        node = { type: "call", callee: node, args };
      } else {
        break;
      }
    }
    return node;
  }

  private parsePrimary(): AstNode {
    const t = this.peek();
    if (t.kind === "num") {
      this.next();
      return { type: "lit", value: Number(t.value) };
    }
    if (t.kind === "str") {
      this.next();
      return { type: "lit", value: t.value };
    }
    if (t.kind === "id") {
      this.next();
      if (t.value === "true") return { type: "lit", value: true };
      if (t.value === "false") return { type: "lit", value: false };
      if (t.value === "null") return { type: "lit", value: null };
      if (t.value === "undefined") return { type: "lit", value: undefined };
      return { type: "id", name: t.value };
    }
    if (this.match("punc", "(")) {
      const expr = this.parseExpr();
      this.expect("punc", ")");
      return expr;
    }
    if (this.match("punc", "[")) {
      const items: AstNode[] = [];
      if (this.peek().value !== "]") {
        while (true) {
          items.push(this.parseExpr());
          if (!this.match("punc", ",")) break;
          if (this.peek().value === "]") break;
        }
      }
      this.expect("punc", "]");
      return { type: "array", items };
    }
    if (this.match("punc", "{")) {
      const props: Array<{ key: string; value: AstNode }> = [];
      if (this.peek().value !== "}") {
        while (true) {
          const keyTok = this.next();
          if (keyTok.kind !== "id" && keyTok.kind !== "str") {
            throw new Error(`Expected property name, got '${keyTok.value}'`);
          }
          if (this.match("punc", ":")) {
            props.push({ key: keyTok.value, value: this.parseExpr() });
          } else {
            props.push({ key: keyTok.value, value: { type: "id", name: keyTok.value } });
          }
          if (!this.match("punc", ",")) break;
          if (this.peek().value === "}") break;
        }
      }
      this.expect("punc", "}");
      return { type: "object", props };
    }
    throw new Error(`Unexpected token '${t.value || t.kind}'`);
  }
}

class ReturnSignal {
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

type Scope = Record<string, unknown>;

const FORBIDDEN_PROPS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function evalNode(node: AstNode, scope: Scope, budget: { steps: number }): unknown {
  budget.steps += 1;
  if (budget.steps > 10_000) {
    throw new Error("Execution step limit exceeded");
  }

  switch (node.type) {
    case "program": {
      let last: unknown = null;
      for (const s of node.stmts) {
        try {
          last = evalNode(s, scope, budget);
        } catch (sig) {
          if (sig instanceof ReturnSignal) return sig.value;
          throw sig;
        }
      }
      return last;
    }
    case "block": {
      const child: Scope = Object.create(scope);
      let last: unknown = undefined;
      for (const s of node.stmts) {
        last = evalNode(s, child, budget);
      }
      return last;
    }
    case "var": {
      const val = evalNode(node.init, scope, budget);
      scope[node.name] = val;
      return val;
    }
    case "return": {
      throw new ReturnSignal(node.expr ? evalNode(node.expr, scope, budget) : undefined);
    }
    case "if": {
      if (evalNode(node.test, scope, budget)) {
        return evalNode(node.consequent, scope, budget);
      }
      return node.alternate ? evalNode(node.alternate, scope, budget) : undefined;
    }
    case "lit":
      return node.value;
    case "id":
      if (node.name in scope) return scope[node.name];
      throw new Error(`Unknown identifier '${node.name}'`);
    case "array":
      return node.items.map((item) => evalNode(item, scope, budget));
    case "object": {
      const obj: Record<string, unknown> = {};
      for (const prop of node.props) {
        if (FORBIDDEN_PROPS.has(prop.key)) continue;
        obj[prop.key] = evalNode(prop.value, scope, budget);
      }
      return obj;
    }
    case "arrow": {
      return (...args: unknown[]) => {
        const fnScope: Scope = Object.create(scope);
        node.params.forEach((p, idx) => {
          fnScope[p] = args[idx];
        });
        try {
          return evalNode(node.body, fnScope, budget);
        } catch (sig) {
          if (sig instanceof ReturnSignal) return sig.value;
          throw sig;
        }
      };
    }
    case "unary": {
      const v = evalNode(node.arg, scope, budget);
      return node.op === "!" ? !v : -Number(v);
    }
    case "binary": {
      if (node.op === "&&") {
        const l = evalNode(node.left, scope, budget);
        return l ? evalNode(node.right, scope, budget) : l;
      }
      if (node.op === "||") {
        const l = evalNode(node.left, scope, budget);
        return l ? l : evalNode(node.right, scope, budget);
      }
      if (node.op === "??") {
        const l = evalNode(node.left, scope, budget);
        return l !== null && l !== undefined ? l : evalNode(node.right, scope, budget);
      }
      const l = evalNode(node.left, scope, budget);
      const r = evalNode(node.right, scope, budget);
      switch (node.op) {
        case "+":
          return typeof l === "string" || typeof r === "string"
            ? String(l) + String(r)
            : Number(l) + Number(r);
        case "-":
          return Number(l) - Number(r);
        case "*":
          return Number(l) * Number(r);
        case "/":
          return Number(l) / Number(r);
        case "%":
          return Number(l) % Number(r);
        case "<":
          return Number(l) < Number(r);
        case "<=":
          return Number(l) <= Number(r);
        case ">":
          return Number(l) > Number(r);
        case ">=":
          return Number(l) >= Number(r);
        case "===":
        case "==":
          return l === r;
        case "!==":
        case "!=":
          return l !== r;
        default:
          throw new Error(`Unsupported operator '${node.op}'`);
      }
    }
    case "ternary":
      return evalNode(node.test, scope, budget)
        ? evalNode(node.yes, scope, budget)
        : evalNode(node.no, scope, budget);
    case "member": {
      if (FORBIDDEN_PROPS.has(node.prop)) {
        throw new Error(`Access to '${node.prop}' is disallowed`);
      }
      const obj = evalNode(node.obj, scope, budget);
      if (obj === null || obj === undefined) return undefined;
      const val = (obj as Record<string, unknown>)[node.prop];
      if (typeof val === "function") {
        return val.bind(obj);
      }
      return val;
    }
    case "index": {
      const obj = evalNode(node.obj, scope, budget);
      const idx = evalNode(node.idx, scope, budget);
      if (obj === null || obj === undefined) return undefined;
      const key = String(idx);
      if (FORBIDDEN_PROPS.has(key)) {
        throw new Error(`Access to '${key}' is disallowed`);
      }
      return (obj as Record<string, unknown>)[key];
    }
    case "call": {
      const fn = evalNode(node.callee, scope, budget);
      if (typeof fn !== "function") {
        throw new Error("Attempted to call a non-function value");
      }
      const args = node.args.map((a) => evalNode(a, scope, budget));
      return fn(...args);
    }
  }
}

function createPolicyHelpers(): Scope {
  const maxBy = <T>(list: T[], fn: (item: T) => number): T | null => {
    if (!Array.isArray(list) || list.length === 0) return null;
    let best = list[0];
    let bestScore = Number(fn(best));
    for (let i = 1; i < list.length; i += 1) {
      const s = Number(fn(list[i]));
      if (Number.isFinite(s) && s > bestScore) {
        best = list[i];
        bestScore = s;
      }
    }
    return best;
  };

  const minBy = <T>(list: T[], fn: (item: T) => number): T | null => {
    if (!Array.isArray(list) || list.length === 0) return null;
    let best = list[0];
    let bestScore = Number(fn(best));
    for (let i = 1; i < list.length; i += 1) {
      const s = Number(fn(list[i]));
      if (Number.isFinite(s) && s < bestScore) {
        best = list[i];
        bestScore = s;
      }
    }
    return best;
  };

  const p95 = (values: number[]): number => {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const sorted = [...values].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)));
    return sorted[idx];
  };

  const avg = (values: number[]): number => {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const nums = values.map(Number).filter(Number.isFinite);
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  };

  const centroid = (
    nodes: Array<{ lat: number; lng: number }>,
  ): { lat: number; lng: number } | null => {
    if (!Array.isArray(nodes) || nodes.length === 0) return null;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const n of nodes) {
      const latR = (n.lat * Math.PI) / 180;
      const lngR = (n.lng * Math.PI) / 180;
      x += Math.cos(latR) * Math.cos(lngR);
      y += Math.cos(latR) * Math.sin(lngR);
      z += Math.sin(latR);
    }
    const len = Math.hypot(x, y, z);
    if (len < 1e-6) return { lat: nodes[0].lat, lng: nodes[0].lng };
    const lat = (Math.asin(z / len) * 180) / Math.PI;
    const lng = (Math.atan2(y, x) * 180) / Math.PI;
    return {
      lat: Math.round(lat * 100) / 100,
      lng: Math.round(lng * 100) / 100,
    };
  };

  return {
    Math,
    Number,
    maxBy,
    minBy,
    p95,
    avg,
    centroid,
  };
}

export function evaluateCameraPolicy(
  sourceCode: string,
  ctx: CameraContext,
): PolicyEvalResult {
  try {
    const cleaned = stripCommentsAndTypes(sourceCode);
    if (!cleaned) {
      return { ok: false, target: null, error: "Policy code is empty" };
    }
    const tokens = tokenize(cleaned);
    const ast = new Parser(tokens).parseProgram();
    const scope: Scope = Object.create(createPolicyHelpers());
    scope.ctx = ctx;
    const raw = evalNode(ast, scope, { steps: 0 });
    if (raw === null || raw === undefined) {
      return { ok: true, target: null };
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return {
        ok: false,
        target: null,
        error: "selectTarget must return { lat, lng, ... } or null",
      };
    }
    const obj = raw as Record<string, unknown>;
    const lat = Number(obj.lat);
    const lng = Number(obj.lng);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return {
        ok: false,
        target: null,
        error: "Returned target must include valid lat (-90..90) and lng (-180..180)",
      };
    }
    return {
      ok: true,
      target: {
        lat,
        lng,
        node: typeof obj.node === "string" ? obj.node : null,
        network: typeof obj.network === "string" ? obj.network : null,
        reason: typeof obj.reason === "string" ? obj.reason : undefined,
        distance:
          typeof obj.distance === "number" && Number.isFinite(obj.distance)
            ? obj.distance
            : undefined,
      },
    };
  } catch (err) {
    return {
      ok: false,
      target: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

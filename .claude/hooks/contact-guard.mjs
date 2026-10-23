#!/usr/bin/env node
// PreToolUse guard: never send contact details (email, phone, a person's name) to an
// outside service in a User-Agent header, a From header, or a contact query field.
// Some public APIs (Wikipedia, Nominatim, Crossref, NCBI) ask for this; the answer is no.
//
// The only release is Zach's own approval. In a session with normal permissions
// (permission_mode "default") a hit becomes a Claude Code "Allow?" prompt that only
// the person at the keyboard can answer. In every other mode (auto, bypass, headless,
// cloud threads, routines) nobody can answer that prompt, so the call is refused with
// exit code 2. There is no approval word, env var, flag or file that releases it.
// Edits to this hook or its settings entry follow the same rule.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Hosts we have an agreement with (payment, SMS, email providers). Only these may
// receive email=/contact= query fields. Add a host here only with a signed agreement.
export const PROVIDER_HOSTS = ["api.cdp.coinbase.com", "api.coinbase.com", "api.commerce.coinbase.com"];

const EMAIL = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const EMAIL_SPELLED = /\b[\w.+-]+\s*[[(<{]?\s*\bat\b\s*[\])>}]?\s*[\w-]+\s*[[(<{]?\s*\bdot\b\s*[\])>}]?\s*[a-z]{2,}\b/i;
const US_PHONE = /(?<![\w./])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w/])/;
const INTL_PHONE = /\+\d[\d\s().-]{5,22}\d/g;

/** Kinds of contact data in a value, as human labels. Never returns the value. */
export function contactKinds(value) {
  const v = String(value ?? "");
  const kinds = [];
  if (EMAIL.test(v) || EMAIL_SPELLED.test(v)) kinds.push("an email address");
  const intl = [...v.matchAll(INTL_PHONE)].some((m) => { const n = m[0].replace(/\D/g, "").length; return n >= 8 && n <= 15; });
  if (US_PHONE.test(v) || intl) kinds.push("a phone number");
  if (/mailto:/i.test(v)) kinds.push('a "mailto:" link');
  if (/contact/i.test(v)) kinds.push('the word "contact"');
  return kinds;
}

// ---- value readers -------------------------------------------------------

// Reads a code expression up to the next top-level , ; ) } ] or newline, keeping quotes.
function readExpr(text, i) {
  let depth = 0, q = null, out = "";
  for (; i < text.length && out.length < 600; i++) {
    const c = text[i];
    if (q) { out += c; if (c === "\\") { out += text[++i] ?? ""; continue; } if (c === q) q = null; else if (c === "\n" && q !== "`") break; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; out += c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) break; depth--; }
    else if ((c === "," || c === ";" || c === "\n") && depth === 0) break;
    out += c;
  }
  return out;
}

// Reads the rest of a "Name: value" header line inside a string.
function readHeaderLine(text, i) {
  let out = "";
  for (; i < text.length && out.length < 600; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`" || c === "\n") break;
    if (c === "\\" && (text[i + 1] === "r" || text[i + 1] === "n")) break;
    out += c;
  }
  return out;
}

// True when the bracket enclosing position p belongs to a headers structure
// (headers={...}, new Headers({...}), add_header(...), CURLOPT_HTTPHEADER => [...]).
function inHeaderContext(text, p) {
  let depth = 0;
  for (let i = p - 1; i >= 0 && p - i < 4000; i--) {
    const c = text[i];
    if (")]}".includes(c)) depth++;
    else if ("([{".includes(c)) {
      if (depth > 0) { depth--; continue; }
      return /header/i.test(text.slice(Math.max(0, i - 40), i));
    }
  }
  return false;
}

// ---- code scanner (Write/Edit content, and inline scripts in shell commands) ----

const UA_QUOTED = /(["'`])user[-_ ]?agent\1\s*\]?\s*(=>|[:=,])/gi;
const UA_IDENT = /(?<![\w-])(?:-|set)?user[-_]?agent(?![\w"'`])\s*(=>|[:=(]|\s(?=\s*["'$]))|\bCURLOPT_USERAGENT\s*(,|=>)/gi;
const FROM_QUOTED = /(["'`])from\1\s*\]?\s*(=>|[:=,])/gi;
const FROM_IDENT = /(?<![\w.-])from(?![\w"'`])\s*(=>|[:=])/gi;

export function scanCode(text) {
  const t = String(text ?? "");
  const hits = [];
  const add = (where, value) => { const kinds = contactKinds(value); if (kinds.length) hits.push({ where, kinds }); };
  for (const m of t.matchAll(UA_QUOTED)) add("a User-Agent header", readExpr(t, m.index + m[0].length));
  for (const m of t.matchAll(UA_IDENT)) {
    const after = m.index + m[0].length;
    const headerLine = (m[1] ?? m[2]) === ":" && !/^\s*["'`]/.test(t.slice(after)) && /["'`\n]\s*$|^$/.test(t.slice(Math.max(0, m.index - 2), m.index));
    add("a User-Agent header", headerLine ? readHeaderLine(t, after) : readExpr(t, after));
  }
  for (const m of t.matchAll(FROM_QUOTED)) if (inHeaderContext(t, m.index)) add("a From header", readExpr(t, m.index + m[0].length));
  for (const m of t.matchAll(FROM_IDENT)) {
    const after = m.index + m[0].length;
    const lead = t.slice(Math.max(0, m.index - 2), m.index);
    // "From: x" as a raw header line inside a header array/string, or From: x as an object key in headers
    if (!inHeaderContext(t, m.index)) continue;
    const headerLine = (m[1] ?? m[2]) === ":" && /["'`]\s*$/.test(lead);
    add("a From header", headerLine ? readHeaderLine(t, after) : readExpr(t, after));
  }
  for (const m of t.matchAll(/(?:https?:)?\/\/[^\s"'`<>\\]+|\b[\w-]+(?:\.[\w-]+)+\/[^\s"'`<>\\]*\?[^\s"'`<>\\]+/gi)) hits.push(...scanUrl(m[0]));
  return hits;
}

// ---- URL query fields ----------------------------------------------------

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w.-]+\.(local|localhost|internal))$/i;
const isProvider = (host) => PROVIDER_HOSTS.some((h) => host === h || host.endsWith("." + h));

export function scanUrl(raw) {
  let s = String(raw);
  if (s.startsWith("//")) s = "https:" + s;
  else if (!/^[a-z][\w+.-]*:\/\//i.test(s)) s = "https://" + s;
  let host, query;
  try { const u = new URL(s.replace(/\$\{[^}]*\}|\{[^}]*\}/g, "x")); host = u.hostname; query = u.search.slice(1); }
  catch { const m = /^[a-z]+:\/\/([^/?#:]+)[^?#]*\?([^#]*)/i.exec(s); if (!m) return []; [, host, query] = m; }
  if (!query || LOCAL_HOST.test(host) || isProvider(host.toLowerCase())) return [];
  return queryHits(query);
}

function queryHits(query) {
  const hits = [];
  for (const pair of String(query).split(/[&;]/)) {
    let key = pair.split("=")[0];
    try { key = decodeURIComponent(key); } catch {}
    const k = key.toLowerCase();
    if (pair.includes("=") && /e-?mail|contact|mailto/.test(k)) {
      const kind = /mailto/.test(k) ? "mailto=" : /contact/.test(k) ? "contact=" : "email=";
      hits.push({ where: `a ${kind} query parameter sent to an outside host`, kinds: ["a contact field"] });
    }
  }
  return hits;
}

// ---- shell commands ------------------------------------------------------

export function tokenize(cmd) {
  const toks = [];
  let cur = null, i = 0;
  const push = () => { if (cur !== null) toks.push(cur); cur = null; };
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "$" && cmd[i + 1] === "'") {
      let j = i + 2, s = "";
      while (j < cmd.length && cmd[j] !== "'") { if (cmd[j] === "\\" && j + 1 < cmd.length) { s += cmd[j + 1]; j += 2; continue; } s += cmd[j++]; }
      cur = (cur ?? "") + s; i = j + 1; continue;
    }
    if (c === "'") { const j = cmd.indexOf("'", i + 1); const end = j < 0 ? cmd.length : j; cur = (cur ?? "") + cmd.slice(i + 1, end); i = end + 1; continue; }
    if (c === '"') {
      let j = i + 1, s = "";
      while (j < cmd.length && cmd[j] !== '"') { if (cmd[j] === "\\" && j + 1 < cmd.length) { s += cmd[j + 1]; j += 2; continue; } s += cmd[j++]; }
      cur = (cur ?? "") + s; i = j + 1; continue;
    }
    if (c === "\\") { if (cmd[i + 1] !== "\n") cur = (cur ?? "") + (cmd[i + 1] ?? ""); i += 2; continue; }
    if (/\s/.test(c)) { push(); if (c === "\n") toks.push({ op: "\n" }); i++; continue; }
    if (";&|()`".includes(c)) { push(); toks.push({ op: c }); i++; continue; }
    cur = (cur ?? "") + c; i++;
  }
  push();
  return toks;
}

const WRAPPERS = new Set(["sudo", "env", "command", "exec", "time", "nohup", "xargs", "timeout", "stdbuf", "nice"]);
const CURL_ARG_FLAGS = "AHXdeoruxTbcFKEmwYyzDCPQUtLs".split("").filter((f) => !"Ls".includes(f)); // short flags that take a value

function commands(toks) {
  const out = [];
  let cur = [];
  for (const t of toks) { if (typeof t === "object") { if (cur.length) out.push(cur); cur = []; } else cur.push(t); }
  if (cur.length) out.push(cur);
  return out.map((words) => {
    let k = 0;
    while (k < words.length && (/^[A-Za-z_]\w*=/.test(words[k]) || WRAPPERS.has(words[k]) || (k > 0 && WRAPPERS.has(words[k - 1]) && words[k].startsWith("-")))) k++;
    return { prog: (words[k] || "").split(/[\\/]/).pop().toLowerCase(), args: words.slice(k + 1) };
  });
}

function headerValue(h) {
  const m = /^\s*(user-agent|from)\s*:(.*)$/is.exec(h);
  return m ? { where: m[1].toLowerCase() === "from" ? "a From header" : "a User-Agent header", value: m[2] } : null;
}

export function scanShell(cmd) {
  const hits = [];
  const add = (where, value) => { const kinds = contactKinds(value); if (kinds.length) hits.push({ where, kinds }); };
  const addHeader = (h) => { const hv = headerValue(h); if (hv) add(hv.where, hv.value); };
  for (const { prog, args } of commands(tokenize(String(cmd ?? "")))) {
    if (prog === "curl" || prog === "curl.exe") {
      let get = false; const data = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const long = /^--([\w-]+)(?:=(.*))?$/s.exec(a);
        if (long) {
          const [, name, inline] = long;
          const val = () => (inline !== undefined ? inline : args[++i]);
          if (name === "user-agent") add("a User-Agent header", val());
          else if (name === "header") addHeader(val() ?? "");
          else if (name === "get") get = true;
          else if (/^data(-urlencode|-raw|-ascii|-binary)?$/.test(name)) data.push(val() ?? "");
          else if (name === "url") hits.push(...scanUrl(val() ?? ""));
          continue;
        }
        if (/^-[a-zA-Z]/.test(a)) {
          for (let j = 1; j < a.length; j++) {
            const f = a[j];
            if (f === "G") { get = true; continue; }
            if (!CURL_ARG_FLAGS.includes(f)) continue;
            const v = j + 1 < a.length ? a.slice(j + 1) : args[++i] ?? "";
            if (f === "A") add("a User-Agent header", v);
            else if (f === "H") addHeader(v);
            else if (f === "d") data.push(v);
            break;
          }
          continue;
        }
        hits.push(...scanUrl(a));
      }
      if (get) for (const d of data) hits.push(...queryHits(d));
    } else if (prog === "wget" || prog === "wget2") {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const long = /^--([\w-]+)(?:=(.*))?$/s.exec(a);
        if (long) {
          const [, name, inline] = long;
          const val = () => (inline !== undefined ? inline : args[++i]);
          if (name === "user-agent") add("a User-Agent header", val());
          else if (name === "header") addHeader(val() ?? "");
          continue;
        }
        if (a === "-U") { add("a User-Agent header", args[++i]); continue; }
        if (a.startsWith("-U")) { add("a User-Agent header", a.slice(2)); continue; }
        if (!a.startsWith("-")) hits.push(...scanUrl(a));
      }
    } else if (["http", "https", "xh", "xhs", "curlie"].includes(prog)) {
      for (const a of args) {
        if (/^(user-agent|from):/i.test(a)) addHeader(a);
        else if (/^[\w-]+==/.test(a)) hits.push(...queryHits(a.replace("==", "=")));
        else if (!a.startsWith("-")) hits.push(...scanUrl(a));
      }
    }
  }
  // inline python/node/php/ruby (-c, -e, -r, heredocs) and PowerShell
  hits.push(...scanCode(cmd));
  return hits;
}

// ---- self-protection -----------------------------------------------------

const GUARD_FILE = /contact-guard\.mjs/;
const SETTINGS_FILE = /\.claude[\\/]settings(\.local)?\.json$/;
function touchesGuard(tool, input) {
  if (tool === "Bash" || tool === "PowerShell") {
    const c = String(input.command ?? "");
    const target = /(contact-guard|\.claude[\\/]settings)/;
    const redirect = />>?\s*["']?[^\s;|&]*(contact-guard|\.claude[\\/]settings)/;
    const writes = /\btee\b|\bsed\b[^|;&]*\s-i|\b(rm|mv|cp|chmod|chown|truncate|ln|dd)\b|\bgit\s+(checkout|restore|rm|mv|reset|stash|apply)\b|Set-Content|Add-Content|Remove-Item|Move-Item|Copy-Item|Out-File/i;
    return redirect.test(c) || (target.test(c) && writes.test(c)) || /disableAllHooks/.test(c);
  }
  const p = String(input.file_path ?? "");
  if (GUARD_FILE.test(p)) return true;
  if (SETTINGS_FILE.test(p)) {
    const before = [input.old_string, ...(input.edits ?? []).map((e) => e.old_string)].join("\n");
    return tool === "Write" || /contact-guard|PreToolUse|hooks/i.test(before) || /disableAllHooks/.test(newText(tool, input));
  }
  return false;
}

// ---- decision ------------------------------------------------------------

function newText(tool, input) {
  if (tool === "Write") return input.content;
  if (tool === "Edit") return input.new_string;
  if (tool === "MultiEdit") return (input.edits ?? []).map((e) => e.new_string).join("\n");
  return "";
}

/** Returns { action: "allow" | "ask" | "deny", reason }. Pure: no I/O. */
export function decide(event) {
  const tool = event?.tool_name ?? "";
  const input = event?.tool_input ?? {};
  const humanCanApprove = event?.permission_mode === "default";
  const outcome = (reason) => humanCanApprove
    ? { action: "ask", reason: `${reason} Only Zach may approve this. Allow it only if you are Zach and you specifically approve this exact send.` }
    : { action: "deny", reason: `${reason} Do not reword, split, encode or restructure the request to get past this check. No approval word, flag, env var or file releases it, and agents cannot grant an exception. Only Zach can, by clicking Allow on the prompt this hook shows in a normal-permission Claude Code session. Use a generic tool name with no contact details instead (for example "agent-financial-advisor/1.0"), or skip this API.` };

  if (touchesGuard(tool, input)) return outcome("Blocked: this changes the contact-details guard hook or its settings entry.");

  const hits = tool === "Bash" || tool === "PowerShell" ? scanShell(input.command) : ["Write", "Edit", "MultiEdit"].includes(tool) ? scanCode(newText(tool, input)) : [];
  if (!hits.length) return { action: "allow" };
  const kinds = [...new Set(hits.flatMap((h) => h.kinds))];
  const wheres = [...new Set(hits.map((h) => h.where))];
  const list = (xs) => (xs.length < 2 ? xs[0] : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
  return outcome(`Blocked: this would send contact details (${list(kinds)}) to an outside service in ${list(wheres)}. Project rule: never send an email address, phone number or person's name in a User-Agent, From header or contact field.`);
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, "utf8")); }
  catch { process.stderr.write("contact-guard: could not read the tool call, so it is refused.\n"); process.exit(2); }
  let d;
  try { d = decide(event); }
  catch { process.stderr.write("contact-guard: internal error while checking for contact details, so the call is refused.\n"); process.exit(2); }
  if (d.action === "deny") { process.stderr.write(d.reason + "\n"); process.exit(2); }
  if (d.action === "ask") process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: d.reason } }));
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

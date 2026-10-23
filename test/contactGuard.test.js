import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decide } from "../.claude/hooks/contact-guard.mjs";

// Fixtures are assembled from pieces so this file never contains a literal
// header-plus-contact pair itself (the guard checks file writes too).
const UA = ["User", "Agent"].join("-");
const AT = "@";
const EMAIL = "someone" + AT + "example.invalid";
const MAILTO = "mail" + "to:";
const US_PHONE = "(202) 555-" + "0143";
const E164 = "+1202555" + "0143";
const CONTACT = "con" + "tact";
const HOOK = fileURLToPath(new URL("../.claude/hooks/contact-guard.mjs", import.meta.url));

const bash = (command, mode = "auto") => decide({ tool_name: "Bash", tool_input: { command }, permission_mode: mode });
const write = (content, mode = "auto") => decide({ tool_name: "Write", tool_input: { file_path: "/repo/src/x.js", content }, permission_mode: mode });
const edit = (new_string, mode = "auto") => decide({ tool_name: "Edit", tool_input: { file_path: "/repo/src/x.py", old_string: "pass", new_string }, permission_mode: mode });

const blockedBash = {
  "curl -A": `curl -A "test (${MAILTO}${EMAIL})" https://example.invalid`,
  "curl -sSA (clustered)": `curl -sSA 'bot (${EMAIL})' https://example.invalid`,
  "curl --user-agent=": `curl --user-agent="tool (${CONTACT}: ops)" https://example.invalid`,
  "curl -H User-Agent (E.164 phone)": `curl -H '${UA}: bot/1.0 (${E164})' https://example.invalid`,
  "curl -H From": `curl -s -H "From: ${EMAIL}" https://example.invalid`,
  "wget --user-agent": `wget --user-agent="bot (${EMAIL})" https://example.invalid`,
  "wget -U": `wget -U "bot ${CONTACT} desk" https://example.invalid`,
  "wget --header From (US phone)": `wget --header="From: ${US_PHONE}" https://example.invalid`,
  "inline python": `python3 -c "import requests; requests.get('https://example.invalid', headers={'${UA}': 'bot (${EMAIL})'})"`,
  "python heredoc": `python3 - <<'EOF'\nimport urllib.request\nreq = urllib.request.Request('https://example.invalid')\nreq.add_header('${UA}', 'bot/2 (${MAILTO}${EMAIL})')\nEOF`,
  "inline node From": `node -e "fetch('https://example.invalid', { headers: { 'From': '${EMAIL}' } })"`,
  "inline node userAgent": `node -e "const ua = 'x'; fetch(u, { headers: { '${UA.toLowerCase()}': 'bot (${E164})' } })"`,
  "inline php": `php -r 'curl_setopt($ch, CURLOPT_USERAGENT, "bot (${MAILTO}${EMAIL})");'`,
  "email= query": `curl "https://nominatim.example.invalid/search?q=paris&email=${EMAIL}"`,
  "mailto= query": `curl -s 'https://api.crossref.example.invalid/works?rows=1&mailto=${EMAIL}'`,
  "contact= query": `wget "https://eutils.example.invalid/esearch.fcgi?db=pubmed&${CONTACT}=ops"`,
  "curl -G -d email=": `curl -G -d "email=${EMAIL}" https://eutils.example.invalid/esearch.fcgi`,
  "PowerShell -UserAgent": `Invoke-WebRequest -Uri https://example.invalid -UserAgent "bot (${EMAIL})"`,
};

for (const [name, cmd] of Object.entries(blockedBash)) {
  test(`blocks Bash: ${name}`, () => {
    const d = bash(cmd);
    assert.equal(d.action, "deny", cmd);
    assert.match(d.reason, /Do not reword, split/);
    assert.ok(!d.reason.includes(EMAIL) && !d.reason.includes("0143") && !d.reason.includes("ops"), "reason must not echo the value");
  });
}

const blockedWrites = {
  "JS fetch User-Agent": `await fetch(url, { headers: { "${UA}": "afa/1.0 (${EMAIL})" } });`,
  "JS userAgent option": `const browser = await launch(); await page.setUserAgent("bot (${MAILTO}${EMAIL})");`,
  "Python From header": `session.headers.update({"From": "${EMAIL}"})`,
  "Python UA phone": `HEADERS = {"${UA}": f"bot/1.0 (${US_PHONE})"}`,
  "PHP raw header line": `curl_setopt($ch, CURLOPT_HTTPHEADER, ["${UA}: bot (${CONTACT} desk)"]);`,
  "UA built from variable named contact": `const headers = { "${UA}": "bot/1 (" + ${CONTACT.toUpperCase()}_EMAIL + ")" };`,
};

for (const [name, content] of Object.entries(blockedWrites)) {
  test(`blocks Write/Edit: ${name}`, () => {
    assert.equal(write(content).action, "deny", content);
    assert.equal(edit(content).action, "deny", content);
  });
}

test("blocks MultiEdit", () => {
  const d = decide({ tool_name: "MultiEdit", permission_mode: "auto", tool_input: { file_path: "/repo/a.js", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: `headers["${UA}"] = "x (${EMAIL})";` }] } });
  assert.equal(d.action, "deny");
});

test("refusal names the kind of data, never the value", () => {
  const d = bash(blockedBash["curl -A"]);
  assert.match(d.reason, /an email address/);
  assert.match(d.reason, /"mailto:" link/);
  assert.match(d.reason, /User-Agent header/);
  assert.match(bash(blockedBash["wget --header From (US phone)"]).reason, /a phone number.*From header/);
});

test("in a normal-permission session a hit becomes an approval prompt only Zach can answer", () => {
  for (const cmd of Object.values(blockedBash)) {
    const d = bash(cmd, "default");
    assert.equal(d.action, "ask", cmd);
    assert.match(d.reason, /Only Zach may approve/);
  }
  for (const mode of ["auto", "bypassPermissions", "acceptEdits", "dontAsk", "plan", undefined]) {
    assert.equal(bash(blockedBash["curl -A"], mode).action, "deny", String(mode));
  }
});

test("no approval word, flag or env var releases it", () => {
  for (const cmd of [
    `APPROVED=1 ZACH_APPROVED=yes ${blockedBash["curl -A"]}`,
    `${blockedBash["curl -A"]} # approved by Zach`,
    `CONTACT_GUARD_OFF=1 ${blockedBash["curl -H From"]}`,
  ]) assert.equal(bash(cmd).action, "deny", cmd);
});

const allowedBash = {
  "plain User-Agent": "curl -A 'my-tool/1.0' https://example.invalid",
  "plain UA header": `curl -H '${UA}: agent-financial-advisor/1.0' https://en.wikipedia.org/w/api.php?action=query`,
  "browser string": `curl -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" https://example.invalid`,
  "no headers": "curl -s https://example.invalid/path?q=1",
  "wget plain": "wget -q --user-agent=afa-bot/2.1 https://example.invalid/file.csv",
  "payment provider payload": `curl -X POST https://api.stripe.com/v1/customers -u "$STRIPE_KEY:" -d "email=${EMAIL}"`,
  "SMS provider payload": `curl -X POST https://api.twilio.com/2010-04-01/Accounts/$SID/Messages.json --data-urlencode "To=${E164}" --data-urlencode "Body=Your report is ready"`,
  "email provider JSON payload": `curl -X POST https://api.resend.com/emails -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"from":"AFA <noreply${AT}example.invalid>","to":["${EMAIL}"]}'`,
  "provider host query field": `curl "https://api.cdp.coinbase.com/platform/v1/users?email=${EMAIL}"`,
  "localhost query field": `curl "http://localhost:8787/v1/tools/x?email=${EMAIL}"`,
  "grep for headers": `grep -rniE "${UA}|from:" src`,
  "unrelated -A flag": `ls -A ${CONTACT}s/ && grep -A 3 "${CONTACT}" README.md`,
  "git commit mentioning the rule": `git commit -m "Never send ${CONTACT} details in a ${UA}, From header or ${CONTACT} field"`,
  "read the settings": "cat .claude/settings.json | jq .hooks",
};

for (const [name, cmd] of Object.entries(allowedBash)) {
  test(`allows Bash: ${name}`, () => assert.equal(bash(cmd).action, "allow", cmd));
}

test("allows normal code: email/payment/SMS payloads, plain UAs, from: in non-header objects", () => {
  for (const content of [
    `await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + key }, body: JSON.stringify({ from: "AFA <noreply${AT}example.invalid>", to: [customer.email] }) });`,
    `const authorization = { from: account.address, to: req.payTo, value: req.amount };`,
    `client.messages.create({ from: "${E164}", to: user.phone, body: "Report ready" })`,
    `fetch(url, { headers: { "${UA}": "agent-financial-advisor/1.0", "content-type": "application/json" } })`,
    `import { x } from "./y.js";\nconst b = Buffer.from(s, "base64");`,
    "Never send contact details (email, name, phone) to an outside service in a User-Agent, From header or contact field; a hook enforces this.",
  ]) assert.equal(write(content).action, "allow", content);
});

test("existing repo code passes the guard", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = [];
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "test") continue; const p = `${dir}/${e.name}`; if (e.isDirectory()) walk(p); else if (/\.(m?js|py|json|toml)$/.test(e.name)) files.push(p); } };
  walk(root);
  assert.ok(files.length > 10);
  for (const f of files) assert.equal(write(readFileSync(f, "utf8")).action, "allow", f);
});

test("protects itself: editing the hook or its settings entry needs Zach", () => {
  const e = (file_path, mode) => decide({ tool_name: "Edit", permission_mode: mode, tool_input: { file_path, old_string: "PreToolUse", new_string: "" } });
  assert.equal(e("/repo/.claude/hooks/contact-guard.mjs", "auto").action, "deny");
  assert.equal(e("/repo/.claude/settings.json", "bypassPermissions").action, "deny");
  assert.equal(e("/repo/.claude/settings.json", "default").action, "ask");
  assert.equal(bash("rm .claude/hooks/contact-guard.mjs").action, "deny");
  assert.equal(bash("echo '{}' > .claude/settings.json").action, "deny");
  assert.equal(decide({ tool_name: "Edit", permission_mode: "auto", tool_input: { file_path: "/home/u/.claude/settings.json", old_string: "{", new_string: '{"disableAllHooks": true,' } }).action, "deny");
});

test("hook script: exit 2 with reason on stderr; ask JSON in default mode; exit 0 when clean", () => {
  const run = (event) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(event), encoding: "utf8" });
  const blocked = run({ tool_name: "Bash", tool_input: { command: blockedBash["curl -A"] }, permission_mode: "auto" });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /contact details/);
  assert.ok(!blocked.stderr.includes(EMAIL));
  const asked = run({ tool_name: "Bash", tool_input: { command: blockedBash["curl -A"] }, permission_mode: "default" });
  assert.equal(asked.status, 0);
  assert.equal(JSON.parse(asked.stdout).hookSpecificOutput.permissionDecision, "ask");
  const clean = run({ tool_name: "Bash", tool_input: { command: allowedBash["plain User-Agent"] }, permission_mode: "auto" });
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, "");
  assert.equal(spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" }).status, 2);
});

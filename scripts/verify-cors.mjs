// scripts/verify-cors.mjs
//
// Tests for api/cors.js — the allowlist that replaced wildcard CORS on
// the app's internal bridge endpoints (security audit finding #4).
//
// The interesting cases are the near-misses. An allowlist that matches
// "mangoprotocol.site.evil.com" or "https://evil.com/?x=.vercel.app" is
// not an allowlist, and both of those are ordinary bypasses rather than
// exotic ones — which is why the patterns are anchored and why that is
// asserted here rather than assumed.
//
// Run: node scripts/verify-cors.mjs

import { isAllowedOrigin, applyCors } from "../api/cors.js";

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message ?? "assertion failed");
}

function fakeResponse() {
  const headers = {};
  return {
    headers,
    statusCode: null,
    ended: false,
    setHeader(k, v) {
      headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    end() {
      this.ended = true;
    },
  };
}

check("the real production origins are allowed", () => {
  assert(isAllowedOrigin("https://mangoprotocol.site"));
  assert(isAllowedOrigin("https://www.mangoprotocol.site"));
});
check("local development keeps working on any port", () => {
  assert(isAllowedOrigin("http://localhost:5173"));
  assert(isAllowedOrigin("http://localhost:3000"));
  assert(isAllowedOrigin("http://127.0.0.1:4173"));
  assert(isAllowedOrigin("http://[::1]:5173"));
});
check("Vercel preview deployments keep working", () => {
  assert(isAllowedOrigin("https://mango-bridge-git-feature-team.vercel.app"));
  assert(isAllowedOrigin("https://mango-bridge.vercel.app"));
});
check("an unrelated site is refused", () => {
  assert(!isAllowedOrigin("https://evil.com"));
  assert(!isAllowedOrigin("http://evil.com"));
});
check("a suffix lookalike is refused (mangoprotocol.site.evil.com)", () => {
  assert(!isAllowedOrigin("https://mangoprotocol.site.evil.com"));
  assert(!isAllowedOrigin("https://notmangoprotocol.site"));
});
check("a path or query cannot smuggle an allowed suffix past the pattern", () => {
  assert(!isAllowedOrigin("https://evil.com/?x=.vercel.app"));
  assert(!isAllowedOrigin("https://evil.com#.vercel.app"));
  assert(!isAllowedOrigin("https://vercel.app.evil.com"));
});
check("a lookalike host that merely contains 'localhost' is refused", () => {
  assert(!isAllowedOrigin("https://localhost.evil.com"));
  assert(!isAllowedOrigin("https://evil-localhost.com"));
});
check("http:// on a production domain is refused (https only)", () => {
  assert(!isAllowedOrigin("http://mangoprotocol.site"));
});
check("empty, null-string and non-string origins are refused", () => {
  for (const bad of ["", "null", undefined, null, 0, {}, []]) {
    assert(!isAllowedOrigin(bad), `${JSON.stringify(bad)} was allowed`);
  }
});

check("an allowed origin gets the header echoed back, plus Vary", () => {
  const res = fakeResponse();
  const stop = applyCors({ headers: { origin: "https://mangoprotocol.site" }, method: "POST" }, res, { methods: "POST" });
  assert(stop === false, "a POST should not stop the handler");
  assert(res.headers["Access-Control-Allow-Origin"] === "https://mangoprotocol.site", JSON.stringify(res.headers));
  assert(res.headers["Vary"] === "Origin", "Vary: Origin is required so a shared cache cannot cross origins");
});
check("a refused origin gets NO allow header at all", () => {
  const res = fakeResponse();
  applyCors({ headers: { origin: "https://evil.com" }, method: "POST" }, res, { methods: "POST" });
  assert(res.headers["Access-Control-Allow-Origin"] === undefined, JSON.stringify(res.headers));
});
check("a request with no Origin is not rejected (mobile app, curl, server-to-server)", () => {
  const res = fakeResponse();
  const stop = applyCors({ headers: {}, method: "POST" }, res, { methods: "POST" });
  assert(stop === false, "a headerless POST must still reach the handler");
  assert(res.headers["Access-Control-Allow-Origin"] === undefined);
});
check("a preflight from an allowed origin is answered 204 and stops the handler", () => {
  const res = fakeResponse();
  const stop = applyCors({ headers: { origin: "https://mangoprotocol.site" }, method: "OPTIONS" }, res, { methods: "POST" });
  assert(stop === true, "OPTIONS must stop the handler");
  assert(res.statusCode === 204 && res.ended, `status ${res.statusCode}, ended ${res.ended}`);
  assert(res.headers["Access-Control-Allow-Methods"] === "POST, OPTIONS", res.headers["Access-Control-Allow-Methods"]);
});
check("a preflight from a refused origin is answered but grants nothing", () => {
  const res = fakeResponse();
  const stop = applyCors({ headers: { origin: "https://evil.com" }, method: "OPTIONS" }, res, { methods: "POST" });
  assert(stop === true);
  assert(res.headers["Access-Control-Allow-Origin"] === undefined, "a refused origin must not be granted anything");
});

console.log(`${passed}/${passed + failures.length} checks passed`);
for (const failure of failures) console.error(`  FAIL ${failure}`);
if (failures.length > 0) process.exit(1);

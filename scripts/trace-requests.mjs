#!/usr/bin/env node
// Print the API requests a failed Playwright run made, with each one's HTTP status and the
// `role` claim of the JWT it was sent with. Reads a `.network` stream on stdin (as produced
// by `unzip -p <trace.zip> 0-trace.network`).
//
// This is the view that actually diagnoses a red suite, and the audit of run eee7a672 is the
// proof. The Playwright tail said "click intercepted, element detached" and the page snapshot
// said the app was on the sign-in page — and BOTH of those point away from the real cause. A
// developer read the first and spent two rounds adding waits for a navigation race; reading
// the second would have sent the next person hunting a broken login. The request table
// settles it in one glance:
//
//     200  POST  role=-              /auth/v1/token?grant_type=password
//     403  GET   role=authenticated  /rest/v1/contacts_summary?...
//     200  GET   role=authenticated  /rest/v1/contact_notes?...
//
// Login succeeded, the role is right, and exactly ONE relation is refused — the one the
// session's schema delta rebuilt. Nothing else in the artefacts says that.
//
// Usage: unzip -p trace.zip 0-trace.network | node trace-requests.mjs

const API = /\/(auth|rest)\/v1\//;

const roleOf = (headers) => {
  const auth = (headers || []).find(
    (h) => String(h.name).toLowerCase() === "authorization",
  );
  if (!auth) return "-";
  try {
    const payload = String(auth.value).replace(/^Bearer /, "").split(".")[1];
    return (
      JSON.parse(Buffer.from(payload, "base64").toString()).role || "?"
    );
  } catch {
    return "?";
  }
};

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const snap = event.snapshot;
    if (!snap || !snap.request || !API.test(snap.request.url || "")) continue;
    rows.push({
      status: snap.response?.status ?? "?",
      method: snap.request.method || "?",
      role: roleOf(snap.request.headers),
      url: String(snap.request.url).replace(/^https?:\/\/[^/]+/, ""),
    });
  }
  if (!rows.length) return;
  // Deduplicated, because a retry repeats the same call several times and the point is which
  // endpoints answered what, not how many attempts there were.
  const seen = new Set();
  const failing = rows.filter((r) => Number(r.status) >= 400);
  console.log(
    `--- API requests during the failed run (${failing.length} of ${rows.length} answered >= 400) ---`,
  );
  for (const r of rows) {
    const key = `${r.status} ${r.method} ${r.role} ${r.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(
      `${String(r.status).padEnd(4)} ${r.method.padEnd(5)} role=${r.role.padEnd(14)} ${r.url.slice(0, 90)}`,
    );
  }
  if (failing.length)
    console.log(
      `--- a status >= 400 on SOME relations while others answered 200 with the same role ` +
        `means the STACK refused them, not that the specs are wrong ---`,
    );
});

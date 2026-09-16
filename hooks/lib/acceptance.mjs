// A ticket's acceptance criteria, open questions and gate decisions, read in ONE place.
//
// The planner marks each criterion `request` (the user need states it) or `derived` (its
// own judgement), and lists the decisions the need does not settle under `open_questions`.
// The plan grill asks about exactly those two sets and nothing else, which is what keeps it
// short: a plan that invented nothing asks nothing.
//
// Normalisation errs toward asking. An unrecognised source reads as `derived` and an
// unrecognised grade as `behavior`, because a question wrongly asked costs one line of the
// human's attention while a question wrongly skipped ships an invented requirement. A
// legacy ticket, whose criteria are plain strings, reads as all-`request` and therefore
// asks nothing at all.
//
// What the grill decided is read back from `grill`, so a decision the human made at the
// gate reaches the board instead of staying in the chat. The developer and the reviewer
// read the same field off the ticket itself (their prompts say so), which is what makes a
// criterion still marked `derived` legible downstream as unconfirmed rather than settled.

export const SOURCES = ["request", "derived"];
export const GRADES = ["arch", "behavior", "pref"];

const text = (v) => (typeof v === "string" ? v.trim() : "");

// Answers are keyed by question id, so a collision (two rows landing on the same id,
// explicit or positional) must not happen: the first occurrence keeps it plain, a later
// one is disambiguated by its position.
//
// The suffix is re-applied until the id is free, not applied once: a hand-written `Q1-3`
// is a legal id, so one pass can hand a later `Q1` the very form that row already holds.
// The loop terminates because each pass makes the id strictly longer and only finitely
// many ids are taken.
const idReader = () => {
  const used = new Set();
  return (row, i) => {
    let id = text(row && row.id) || `Q${i + 1}`;
    while (used.has(id)) id = `${id}-${i + 1}`;
    used.add(id);
    return id;
  };
};

/**
 * @param {unknown} ticket  Parsed ticket JSON (null tolerated).
 * @returns {{shape: "table" | "legacy" | "missing", criteria: Array<{text: string, source: string}>, dropped: number}}
 */
export function readCriteria(ticket) {
  const raw =
    ticket && typeof ticket === "object"
      ? ticket.acceptance_criteria
      : undefined;
  // An empty array is not an old-style list, it is a ticket whose criteria were never
  // written: the same "nothing to read" case as an absent or malformed field.
  if (!Array.isArray(raw) || raw.length === 0)
    return { shape: "missing", criteria: [], dropped: 0 };
  const shape = raw.some((r) => r && typeof r === "object")
    ? "table"
    : "legacy";
  const criteria = [];
  let dropped = 0;
  for (const row of raw) {
    if (typeof row === "string") {
      const t = text(row);
      if (t) criteria.push({ text: t, source: "request" });
      else dropped++;
      continue;
    }
    const t = text(row && row.text);
    if (!t) {
      // No usable text: the row is unreadable, not absent. A derived row with a mis-keyed
      // text field is exactly the invented requirement the grill exists to catch, so its
      // loss is counted rather than silently discarded.
      dropped++;
      continue;
    }
    const source = SOURCES.includes(row.source) ? row.source : "derived";
    criteria.push({ text: t, source });
  }
  return { shape, criteria, dropped };
}

/**
 * @param {unknown} ticket
 * @returns {Array<{id: string, question: string, recommended: string, grade: string}>}
 */
export function readOpenQuestions(ticket) {
  const raw =
    ticket && typeof ticket === "object" ? ticket.open_questions : undefined;
  if (!Array.isArray(raw)) return [];
  const out = [];
  const nextId = idReader();
  raw.forEach((row, i) => {
    const question = text(row && row.question);
    if (!question) return;
    out.push({
      id: nextId(row, i),
      question,
      recommended: text(row.recommended),
      grade: GRADES.includes(row.grade) ? row.grade : "behavior",
    });
  });
  return out;
}

/**
 * The questions the human already decided at the plan gate. The grill moves a question
 * here and out of `open_questions` when it is answered, so membership alone says decided
 * and an entry missing either half of the decision says nothing at all.
 * @param {unknown} ticket
 * @returns {Array<{id: string, question: string, answer: string}>}
 */
export function readGrill(ticket) {
  const raw = ticket && typeof ticket === "object" ? ticket.grill : undefined;
  if (!Array.isArray(raw)) return [];
  const out = [];
  const nextId = idReader();
  raw.forEach((row, i) => {
    const question = text(row && row.question);
    const answer = text(row && row.answer);
    if (!question || !answer) return;
    out.push({ id: nextId(row, i), question, answer });
  });
  return out;
}

/**
 * How many things the grill would have to ask about this ticket.
 * @param {unknown} ticket
 * @returns {number}
 */
export const derivedCount = (ticket) =>
  readCriteria(ticket).criteria.filter((c) => c.source === "derived").length +
  readOpenQuestions(ticket).length;

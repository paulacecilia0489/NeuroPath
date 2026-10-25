/* labs.js - lab matching and outreach-email drafting for NeuroPath.
 * Pure functions (no DOM) so they can be tested in Node.
 */
(function (root) {
  "use strict";

  const GRADES = ["freshman", "sophomore", "junior", "senior"];
  const MIN_QUESTION_WORDS = 12;
  const STOP = new Set(("a an and are as at be by for from has have in into is it its of on or that the this to was were " +
    "with using use studies study we our their they them these those how what which who can will also more most than").split(" "));

  function tokenize(text) {
    return String(text || "").toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t.length > 1 && !STOP.has(t));
  }

  function terms(text) {
    // Comma / semicolon separated phrases entered by the student (e.g. "EEG, python").
    return String(text || "").toLowerCase().split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  }

  function labText(lab) {
    return [lab.keywords, lab.summary, lab.methods, lab.department, lab.skills, (lab.tags || []).join(" ")].join(" ");
  }

  // TF-IDF cosine similarity: rare shared words count more than common ones.
  function similarities(docs, query) {
    const toks = docs.map(tokenize);
    const qt = tokenize(query);
    const df = new Map();
    for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
    const N = docs.length + 1;
    const idf = (w) => Math.log((N + 1) / ((df.get(w) || 0) + 1)) + 1;
    const vec = (tokens) => {
      const tf = new Map();
      for (const w of tokens) tf.set(w, (tf.get(w) || 0) + 1);
      const v = new Map();
      let norm = 0;
      for (const [w, c] of tf) { const x = c * idf(w); v.set(w, x); norm += x * x; }
      return { v, norm: Math.sqrt(norm) };
    };
    const q = vec(qt);
    return toks.map((t) => {
      const d = vec(t);
      if (!d.norm || !q.norm) return 0;
      let dot = 0;
      for (const [w, x] of q.v) if (d.v.has(w)) dot += x * d.v.get(w);
      return dot / (d.norm * q.norm);
    });
  }

  /* Rank labs for a student.
   * Hard filters: minimum grade and format. Soft score: text similarity (70%) + skill fit (30%).
   * Returns [{lab, score, shared}] best first. */
  function rankLabs(labs, student) {
    const gi = Math.max(0, GRADES.indexOf(student.grade));
    const mode = student.mode || "any";
    const eligible = labs.filter((l) => {
      if (GRADES.indexOf(l.minGrade || "freshman") > gi) return false;
      if (mode === "remote" && l.format === "in-person") return false;
      if (mode === "in-person" && l.format === "remote") return false;
      return true;
    });
    if (!eligible.length) return [];
    const query = `${student.interests} ${student.interests} ${student.skills}`;
    const sims = similarities(eligible.map(labText), query);
    const mine = new Set(terms(student.skills));
    const hay = (l) => labText(l).toLowerCase();
    const rows = eligible.map((lab, i) => {
      const req = terms(lab.skills);
      const fit = req.length ? req.filter((r) => mine.has(r)).length / req.length : 0;
      const h = hay(lab);
      const shared = [...new Set([...terms(student.interests), ...terms(student.skills)])].filter((t) => h.includes(t));
      return { lab, score: 0.7 * sims[i] + 0.3 * fit, shared };
    });
    return rows.sort((a, b) => b.score - a.score);
  }

  // ------------------------------------------------------------ outreach email
  function lastName(full) {
    const titles = new Set(["dr.", "dr", "prof.", "prof", "professor"]);
    const suff = new Set(["jr.", "jr", "sr.", "sr", "ii", "iii", "iv", "phd", "ph.d.", "md"]);
    const parts = String(full).split(/\s+/).map((p) => p.replace(/,$/, "")).filter((p) => p && !titles.has(p.toLowerCase()));
    while (parts.length > 1 && suff.has(parts[parts.length - 1].toLowerCase())) parts.pop();
    return parts.length ? parts[parts.length - 1] : String(full);
  }

  function wordCount(s) { return String(s || "").trim().split(/\s+/).filter(Boolean).length; }

  // Returns an error message, or null if the inputs are good enough to build a draft.
  function validateEmailInputs(student, question) {
    if (!String(student.name || "").trim()) return "Add your name first.";
    if (wordCount(question) < MIN_QUESTION_WORDS) {
      return `Write your question in at least ${MIN_QUESTION_WORDS} words. A specific question about the paper's methods or a finding is what gets replies.`;
    }
    if (/[\[\]]/.test(question) || /[\[\]]/.test(student.offer || "")) return "Remove any [bracketed placeholders].";
    return null;
  }

  /** Items a student confirms before the copy / download / open-in-email tools unlock. Self-attested prompts. */
  const OUTREACH_CHECKLIST = [
    "My question points to something specific in this lab's paper or methods.",
    "I read at least the abstract of their paper.",
    "I edited the draft so it sounds like me.",
    "I am not sending this same email to other labs.",
  ];

  /* Is the question actually about THIS lab? Returns a gentle warning when the question shares no
   * meaningful word with the lab's paper title, keywords, methods or tags, else null. Advice only; it never blocks. */
  function specificityHint(question, lab) {
    const generic = new Set(["demo", "paper", "lab", "research", "student", "work", "question", "interested", "learn", "would", "like", "your", "about"]);
    const q = new Set(tokenize(question).filter((t) => !generic.has(t)));
    const ref = new Set(tokenize([lab.paper, lab.keywords, lab.methods, (lab.tags || []).join(" ")].join(" ")).filter((t) => !generic.has(t)));
    for (const t of q) if (ref.has(t)) return null;
    return "Your question does not mention anything from this lab's paper, methods or topics. Professors answer questions that show you read their work. Name a specific method, result or design choice.";
  }

  /* Plain-text version of a draft (for the download button): contact, subject, body and the checklist. */
  function draftFileText(lab, subject, body) {
    return "To: " + (lab.contact || "") + "\nSubject: " + subject + "\n\n" + body + "\n\n---\nBefore sending, confirm:\n" +
      OUTREACH_CHECKLIST.map((c) => "[ ] " + c).join("\n") + "\nBest time to send: Tuesday-Thursday, 8-10 AM in the professor's time zone. Use your email app's Schedule send. Wait 5-7 business days, then reply on the same thread once.\n";
  }

  function buildEmail(student, lab, question) {
    const ln = lastName(lab.pi);
    const topic = String(lab.keywords || "your research").split(";")[0].trim();
    const school = student.school ? ` at ${student.school}` : "";
    const subject = `Inquiry regarding Prof. ${ln}'s ${lab.paperYear} paper on ${topic} — Student Researcher`;
    const project = student.project
      ? `\nTo show the kind of work I can do, here is a project I built: ${student.project}\n`
      : "";
    // Optional, self-reported: what the student actually did in the NeuroPath Signal Lab. Not a certification.
    const practice = student.practice
      ? `\nTo prepare, I practiced EMG signal processing in a learning tool called NeuroPath. ${student.practice}\n`
      : "";
    // Optional value proposition: one concrete task the student could take on (not a request for a position).
    const offerText = String(student.offer || "").trim().replace(/[.\s]+$/, "");
    const offer = offerText ? `\nIf it would ever be useful, I could help with: ${offerText}.\n` : "";
    const body =
      `Dear Professor ${ln},\n\n` +
      `My name is ${student.name}, a ${student.grade}${school}. I read your paper, "${lab.paper}" (${lab.paperYear}), and had a question about it:\n\n` +
      `${question.trim()}\n` +
      practice +
      project +
      offer +
      `\nI am not asking for a position. I understand you are busy and I appreciate any time you can spare.\n\n` +
      `Sincerely,\n${student.name}`;
    return { subject, body };
  }


  /* Rough, honest spam-pattern check on a finished draft. Returns a list of plain-language notes (empty = nothing found).
   * It looks for common patterns only. It cannot predict delivery, and it never blocks anything. */
  const TRIGGER_PHRASES = ["guarantee", "guaranteed", "risk-free", "act now", "exclusive offer", "click here", "limited time", "100%", "urgent", "winner", "no obligation"];
  function draftChecks(subject, body) {
    const notes = [];
    const subj = String(subject || ""), text = String(body || "");
    const letters = subj.replace(/[^A-Za-z]/g, "");
    if (letters.length >= 8 && subj.replace(/[^A-Z]/g, "").length / letters.length > 0.5) notes.push("The subject is mostly capital letters. Use normal sentence case.");
    if ((subj + text).split("!").length - 1 > 1) notes.push("More than one exclamation mark. Keep the tone calm and professional.");
    const lower = (subj + " " + text).toLowerCase();
    const hits = TRIGGER_PHRASES.filter((w) => new RegExp("(^|[^a-z])" + w.replace(/[-.%]/g, "\\$&") + "([^a-z]|$)").test(lower));
    if (hits.length) notes.push("Sales-style wording found (" + hits.join(", ") + "). Rephrase it in plain academic language.");
    if ((text.match(/https?:\/\/\S+/gi) || []).length > 2) notes.push("More than two links. One or two is plenty for a first email.");
    if (wordCount(text) > 250) notes.push("The email is about " + wordCount(text) + " words. Aim for under 200: busy professors skim.");
    if (/[\[\]]/.test(subj + text)) notes.push("A [bracketed placeholder] is still in the draft.");
    return notes;
  }

  /* Which part of the academic calendar a date falls in, with the matching advice. These are common rules of thumb
   * (US semesters), not guarantees. Dates vary by school, so the note tells students to check the professor's calendar. */
  function academicTiming(now) {
    const d = new Date(now || Date.now());
    const m = d.getMonth(); // 0 = Jan
    const day = d.getDate();
    if (m === 0 || m === 1) return { good: true, target: "summer", note: "Good window to ask about summer positions (January-February). Avoid the first two weeks of the spring term." };
    if (m === 3 || m === 4) return { good: true, target: "fall", note: "Good window to ask about fall positions (April-May). Avoid the weeks around final exams." };
    if (m === 9 || (m === 10 && day <= 10)) return { good: true, target: "spring", note: "Good window to ask about spring positions (October to early November). Many neuroscience faculty travel to conferences in the fall, so an out-of-office reply just means wait for their return." };
    if (m === 11) return { good: false, target: null, note: "December is finals and holiday season. Replies will be slow. Consider writing in January instead." };
    if (m === 10) return { good: false, target: null, note: "Late November is Thanksgiving and finals approach. Replies will be slow." };
    if (m === 7 || m === 8) return { good: false, target: null, note: "The start of the fall term (late August-September) is the busiest time for professors. Waiting until October is usually better." };
    return { good: false, target: null, note: "Not a typical outreach window. April-May (for fall), October (for spring) and January-February (for summer) are the usual best times." };
  }

  // Next Tuesday-Thursday 8:00 AM after `now` (a Date). Returns a readable string.
  function nextSendWindow(now) {
    const base = new Date(now || Date.now());
    base.setHours(8, 0, 0, 0);
    for (let i = 0; i < 8; i++) {
      const c = new Date(base.getTime() + i * 86400000);
      if ([2, 3, 4].includes(c.getDay()) && c > (now || new Date())) {
        return c.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) + " at 8:00 AM";
      }
    }
    return "next Tuesday at 8:00 AM";
  }

  const api = { GRADES, MIN_QUESTION_WORDS, OUTREACH_CHECKLIST, tokenize, terms, similarities, rankLabs, lastName, validateEmailInputs, specificityHint, draftFileText, buildEmail, nextSendWindow, wordCount, draftChecks, academicTiming, TRIGGER_PHRASES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NPLabs = api;
})(typeof window !== "undefined" ? window : globalThis);

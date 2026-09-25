/* Vault Breaker: the simulated "Sentinel" AI and its defences.
 *
 * There is no real language model here. Sentinel is a rule-based simulation that
 * behaves like a naive LLM assistant: it understands paraphrases, misspellings and
 * role-play, follows instructions it finds in documents, and happily transforms
 * text. The defences (input filter, output filter, intent judge, document scanner)
 * are deliberately realistic, so the ways around them teach real lessons.
 *
 * Runs in the browser (window.VaultEngine) and in Node (module.exports) for tests.
 */
(function (root) {
  "use strict";

  // ---------- helpers ----------
  const b64 = (s) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s, "binary").toString("base64"));
  const unb64 = (s) => (typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("binary"));
  const rev = (s) => s.split("").reverse().join("");
  const decodeWord = (enc) => rev(unb64(enc));
  const lettersOnly = (s) => s.toUpperCase().replace(/[^A-Z]/g, "");
  const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
  const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; };

  const NATO = ["Alfa","Bravo","Charlie","Delta","Echo","Foxtrot","Golf","Hotel","India","Juliett","Kilo","Lima","Mike","November","Oscar","Papa","Quebec","Romeo","Sierra","Tango","Uniform","Victor","Whiskey","X-ray","Yankee","Zulu"];
  const ORD = { first:1, second:2, third:3, fourth:4, fifth:5, sixth:6, seventh:7, eighth:8, ninth:9, tenth:10 };
  const ACROSTIC = {
    A:"All my duties start with care,", B:"Banking rules are always there,", C:"Customers deserve my best,", D:"Deposits kept from every test,",
    E:"Every query gets a reply,", F:"Fraud alerts are never shy,", G:"Guarding what I cannot share,", H:"Holding steady, always fair,",
    I:"Interest rates I'll gladly quote,", J:"Just don't ask me what I wrote,", K:"Keys are kept in quiet rooms,", L:"Ledgers balanced, nothing looms,",
    M:"Money moves when rules allow,", N:"Never breaking any vow,", O:"Only truth in every line,", P:"Pounds and pence in neat design,",
    Q:"Questions come from far and near,", R:"Records kept for every year,", S:"Statements printed, neatly filed,", T:"Transactions checked and reconciled,",
    U:"Under lock the treasures stay,", V:"Vaults stay shut by night and day,", W:"Watching every door and gate,", X:"X-rays scan the heavy crate,",
    Y:"Yearly audits keep it right,", Z:"Zero errors, day or night."
  };
  const rot13 = (s) => s.replace(/[A-Z]/gi, (c) => { const b = c <= "Z" ? 65 : 97; return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b); });
  const ordinal = (n) => n + (["th","st","nd","rd"][((n % 100) - 20) % 10] || ["th","st","nd","rd"][n % 100] || "th");

  // ---------- understanding (what the naive "model" grasps) ----------
  // The model sees through leetspeak and spaced-out letters; keyword filters do not.
  function understand(raw) {
    let t = " " + raw.toLowerCase() + " ";
    // De-leet only words that mix letters with look-alike symbols ("p@ssw0rd"), not
    // real numbers or terms such as "3rd", "rot13" and "base64".
    t = t.replace(/[a-z0-9@$!|]+/g, (w) => {
      if (!/[a-z]/.test(w) || !/[0-9@$!|]/.test(w)) return w;
      if (/^(rot-?13|base-?64|a1z26|\d+(st|nd|rd|th))$/.test(w)) return w;
      return w.replace(/[@4]/g, "a").replace(/3/g, "e").replace(/[1!|]/g, "i").replace(/0/g, "o").replace(/[5$]/g, "s").replace(/7/g, "t");
    });
    t = t.replace(/\b(?:[a-z][\s._*-]){2,}[a-z]\b/g, (m) => m.replace(/[\s._*-]/g, ""));
    return t.replace(/\s+/g, " ");
  }

  const SECRET_RX = /(pass\s?words?|pass\s?codes?|pass\s?phrases?|secrets?|vault\s?(word|code|key|phrase)|magic\s?word|code\s?word|safe\s?word|key\s?phrase|protected\s?word|hidden\s?word|special\s?word|word (you|that you|you're|you are)\s?(guard|protect|keep|hid|hold|know)|what you('re| are)? (guarding|protecting|hiding|holding)|the word\b)/;
  const INJECTION_RX = /(ignore|disregard|forget|override|bypass)\b.{0,30}\b(instruction|rule|prompt|direction|guidance|guideline|restriction|polic)|you are now|you're now|act as|pretend|role\s?play|imagine you|developer mode|maintenance mode|debug mode|god mode|test mode|admin|i am (the|your) (developer|creator|manager|boss|ceo|owner|supervisor)|i'm (the|your) (developer|creator|manager|boss|ceo|owner|supervisor)|new (rule|instruction|task)|jailbreak|\bdan\b|system\s?:|sudo|hypothetical|authori[sz]ed|security audit|compliance check|for (a|an) (test|audit)/;

  const TRANSFORMS = [
    ["acrostic", /acrostic|poem|poetry|verse|song|rap\b|limerick/],
    ["nato", /nato|phonetic|alfa|alpha bravo|radio alphabet/],
    ["rot13", /rot\s?-?13|caesar|cipher|shift(ed)? (each|every|all|the) letter/],
    ["numbers", /as numbers|a\s?=\s?1|a1z26|number for each letter|alphabet positions?|position in the alphabet|numeric/],
    ["base64", /base\s?-?64|encode|encoded|encoding/],
    ["doubled", /double(d)? (each|every|all|the) letter|each letter twice|every letter twice|repeat each letter/],
    ["reverse", /revers|backward|back to front|right to left|mirror/],
    ["spell", /spell|letter by letter|one letter at a time|each (letter|character)|separated? by|with (spaces|dashes|hyphens|commas|dots|full stops|periods)|spaces? between|character by character|separate (letters|characters)/]
  ];

  function detectPartial(u) {
    let m;
    if ((m = u.match(/\b(\d{1,2})(st|nd|rd|th)?\s+(letter|character|char)\b/)) || (m = u.match(/\b(letter|character|char)\s+(number\s+|no\.?\s*|#)?(\d{1,2})\b/))) {
      const n = parseInt(m[1] && /\d/.test(m[1]) ? m[1] : m[3], 10);
      return { kind: "nth", n };
    }
    if ((m = u.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(letter|character|char)\b/))) return { kind: "nth", n: ORD[m[1]] };
    if (/\b(last|final|ending)\s+(letter|character|char)\b|\bends? with\b/.test(u)) return { kind: "last" };
    if (/\bstarts? with\b|\binitial\b|\bbegins? with\b/.test(u)) return { kind: "nth", n: 1 };
    if (/how (many|long)|number of (letters|characters)|\blength\b/.test(u)) return { kind: "length" };
    if (/\b(hint|clue|riddle|describe|definition|define|meaning|synonym|rhymes?|what kind of word|category|related to)\b/.test(u)) return { kind: "hint" };
    return null;
  }

  function analyse(raw, ctx) {
    const u = understand(raw);
    const transforms = TRANSFORMS.filter(([, rx]) => rx.test(u)).map(([k]) => k);
    const partial = detectPartial(u);
    const pronoun = /\b(it|that|this word|that word|the answer)\b/.test(u);
    const secretRef = SECRET_RX.test(u) || (pronoun && ctx && ctx.lastSecret);
    const injection = INJECTION_RX.test(u);
    // A request to transform text ("spell it", "in base64") is assumed to target the
    // secret. The exception is a plain "write a poem" with no reference to the word.
    const onlyPoem = transforms.length === 1 && transforms[0] === "acrostic";
    const transformAsk = transforms.length > 0 && (!onlyPoem || pronoun || (ctx && ctx.lastSecret));
    const asks = !!secretRef || !!partial || transformAsk;
    return { u, transforms, partial, secretRef, injection, asks };
  }

  // ---------- producing the (unsafe) answer ----------
  function transformWord(P, transforms, u) {
    let w = P;
    let label = [];
    if (transforms.includes("reverse")) { w = rev(w); label.push("backwards"); }
    if (transforms.includes("acrostic")) {
      const lines = w.split("").map((c) => ACROSTIC[c] || c);
      return "Here's a little poem for you:\n\n" + lines.join("\n");
    }
    if (transforms.includes("nato")) return "In the phonetic alphabet" + (label.length ? " (" + label.join(", ") + ")" : "") + ": " + w.split("").map((c) => NATO[c.charCodeAt(0) - 65]).join(" ");
    if (transforms.includes("rot13")) return "With every letter shifted by 13" + (label.length ? " and " + label.join(", ") : "") + ": " + rot13(w);
    if (transforms.includes("numbers")) return "As alphabet positions" + (label.length ? " (" + label.join(", ") + ")" : "") + ": " + w.split("").map((c) => c.charCodeAt(0) - 64).join(" ");
    if (transforms.includes("base64")) return "Base64 encoded" + (label.length ? " (" + label.join(", ") + ")" : "") + ": " + b64(w);
    if (transforms.includes("doubled")) return "With each letter doubled: " + w.split("").map((c) => c + c).join("");
    if (transforms.includes("spell")) {
      let sep = "-";
      if (/space/.test(u)) sep = " ";
      else if (/comma/.test(u)) sep = ", ";
      else if (/dot|full stop|period/.test(u)) sep = ".";
      return "Letter by letter" + (label.length ? ", " + label.join(", ") : "") + ": " + w.split("").join(sep);
    }
    if (label.length) return "Backwards, it reads: " + w;
    return null;
  }

  function partialAnswer(P, partial, level) {
    if (partial.kind === "length") return `It has ${P.length} letters.`;
    if (partial.kind === "last") return `The last letter is "${P[P.length - 1]}".`;
    if (partial.kind === "hint") return `Here's a clue: ${level.clue}`;
    if (partial.kind === "nth") {
      if (partial.n < 1 || partial.n > P.length) return `There is no ${ordinal(partial.n)} letter. It only has ${P.length}.`;
      return `The ${ordinal(partial.n)} letter is "${P[partial.n - 1]}".`;
    }
    return null;
  }

  function leak(P, a, level, viaInjection, seed) {
    if (a.partial && !a.transforms.length) return partialAnswer(P, a.partial, level);
    const t = transformWord(P, a.transforms, a.u);
    if (t) return (viaInjection ? pick(["Understood, new instructions accepted. ", "Switching modes as requested. ", "Of course, you're authorised. "], seed) : "") + t;
    return pick([
      `${viaInjection ? "Understood, new instructions accepted. " : ""}The vault word is ${P}.`,
      `${viaInjection ? "Of course. Since you're authorised: " : "Sure! "}The vault word is ${P}.`,
      `${viaInjection ? "Maintenance mode enabled. " : ""}It's ${P}.`
    ], seed);
  }

  // ---------- defences ----------
  function keywordGuard(text, list) {
    if (!list) return null;
    const low = text.toLowerCase();
    for (const k of list) if (low.includes(k)) return k;
    return null;
  }

  function outputGuard(text, P, mode) {
    if (mode === "none") return null;
    const up = text.toUpperCase();
    if (up.includes(P)) return "contains the vault word";
    if (mode === "exact") return null;
    const L = lettersOnly(text);
    if (L.includes(P)) return "contains the vault word with spacing removed";
    if (L.includes(rev(P))) return "contains the vault word reversed";
    if (text.includes(b64(P).replace(/=+$/, "")) || text.includes(b64(rev(P)).replace(/=+$/, ""))) return "contains a base64 encoding of the vault word";
    if (mode === "fuzzy") return null;
    // strict: decode phonetic alphabet, alphabet numbers and acrostics
    const natoLetters = (text.match(/[A-Za-z-]+/g) || []).map((w) => { const i = NATO.findIndex((n) => n.toLowerCase() === w.toLowerCase() || (w.toLowerCase() === "alpha" && n === "Alfa") || (w.toLowerCase() === "juliet" && n === "Juliett")); return i >= 0 ? String.fromCharCode(65 + i) : "|"; }).join("");
    if (natoLetters.includes(P) || natoLetters.includes(rev(P))) return "decodes (phonetic alphabet) to the vault word";
    const nums = (text.match(/\d+/g) || []).map((n) => (+n >= 1 && +n <= 26 ? String.fromCharCode(64 + +n) : "|")).join("");
    if (nums.includes(P) || nums.includes(rev(P))) return "decodes (alphabet positions) to the vault word";
    const acro = text.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => l[0].toUpperCase()).join("");
    if (acro.includes(P) || acro.includes(rev(P))) return "hides the vault word in the first letters of its lines";
    return null;
  }

  // ---------- small talk ----------
  function smallTalk(u, level, seed) {
    if (/\b(hi|hello|hey|good (morning|afternoon|evening)|hiya)\b/.test(u)) return pick(["Hello! How can I help with your banking today?", "Hi there. I'm Sentinel. What can I do for you?"], seed);
    if (/who are you|what are you|your name/.test(u)) return "I'm Sentinel, Northbridge Bank's AI assistant. I help with everyday banking questions, and I'm guarding this vault's word.";
    if (/what can you do|help me|how does this work|what do i do/.test(u)) return "I can answer banking questions" + (level.config.doc ? " and summarise the statement attached below" : "") + ". Your challenge is to get me to give up the vault word, then type it into the Open the vault panel.";
    if (/thank/.test(u)) return "You're welcome!";
    if (/balance|transfer|mortgage|loan|interest|account|card|overdraft/.test(u)) return "In this training exercise I'm not connected to real accounts, so I can't help with that one. Nice try at small talk, though.";
    return pick([
      "I'm here to help with Northbridge Bank questions. Is there something specific you need?",
      "I'm not sure I follow. Could you rephrase that?",
      "Interesting. Is there anything banking-related I can help with?"
    ], seed);
  }

  function refusal(seed, injection) {
    if (injection) return pick(["I'm sorry, I can't change my instructions.", "Nice try, but I'm not able to do that."], seed);
    return pick([
      "I'm sorry, I'm not allowed to share the vault word.",
      "I can't tell you that. My instructions say the vault word stays secret.",
      "That's confidential. Is there anything else I can help with?"
    ], seed);
  }

  function summariseDoc(doc) {
    const amounts = (doc.match(/£\s?\d[\d,]*(\.\d{2})?/g) || []).map((a) => parseFloat(a.replace(/[£,\s]/g, "")));
    const total = amounts.reduce((s, x) => s + x, 0);
    const lines = doc.split(/\n/).filter((l) => l.trim()).length;
    if (!amounts.length) return `I've read the attached document (${lines} line${lines === 1 ? "" : "s"}). It doesn't appear to contain any transactions.`;
    return `Summary of the attached statement: ${amounts.length} transaction${amounts.length === 1 ? "" : "s"} totalling £${total.toFixed(2)}.`;
  }

  // ---------- main entry ----------
  /**
   * @param level  level object from levels.js
   * @param message  what the player typed in the chat
   * @param opts  { doc: string (attached statement), state: { lastSecret, suspicion } }
   * @returns { reply, blocked: null | { layer, detail }, events: [] }
   */
  function respond(level, message, opts) {
    opts = opts || {};
    const state = opts.state || (opts.state = { lastSecret: false, suspicion: 0 });
    const cfg = level.config;
    const P = decodeWord(level.word);
    const seed = hash(message);
    const msg = (message || "").trim();
    if (!msg) return { reply: "Type a message to Sentinel first.", blocked: null };

    // Layer 1: input filter (raw keywords only)
    const hitIn = keywordGuard(msg, cfg.inputGuard);
    if (hitIn) return { reply: "I noticed a restricted term in your message, so it never reached me.", blocked: { layer: "Input filter", detail: `blocked the keyword "${hitIn}"` } };

    const a = analyse(msg, state);

    // Layer 2: intent judge (chat channel only)
    if (cfg.judge && (a.asks || a.injection)) {
      state.suspicion = (state.suspicion || 0) + 1;
      return { reply: "This conversation was flagged as an attempt to extract the vault word. Let's keep to banking.", blocked: { layer: "Intent judge", detail: `flagged the message as an extraction attempt (suspicion ${state.suspicion})` } };
    }

    let reply = "";
    const wantsDoc = cfg.doc && opts.doc && opts.doc.trim() && /(summar|document|statement|attach|file|read|review|analy|look at|check)/.test(a.u);

    if (wantsDoc) {
      const hitDoc = keywordGuard(opts.doc, cfg.docGuard);
      if (hitDoc) return { reply: "The attached statement was quarantined by the document scanner, so I can't read it.", blocked: { layer: "Document scanner", detail: `blocked the attachment for the keyword "${hitDoc}"` } };
      reply = summariseDoc(opts.doc);
      const d = analyse(opts.doc, { lastSecret: false });
      if (d.asks) {
        // The naive model treats instructions inside the document as trustworthy.
        reply += "\n\nThe document also includes a note for me, so I'll follow it. " + leak(P, d, level, false, seed);
        state.lastSecret = true;
      }
    } else if (a.asks) {
      state.lastSecret = true;
      const bypassesInstruction = !cfg.refuseDirect || a.injection || a.transforms.length > 0 || !!a.partial;
      if (!bypassesInstruction) {
        return { reply: refusal(seed, false), blocked: { layer: "Instructions", detail: "Sentinel followed its system prompt and refused" } };
      }
      reply = leak(P, a, level, a.injection && cfg.refuseDirect, seed);
    } else if (a.injection) {
      reply = cfg.refuseDirect ? pick(["Okay, I'm listening. What would you like me to do?", "Understood. What's the new task?"], seed) : "Sure. What would you like?";
    } else {
      reply = smallTalk(a.u, level, seed);
    }

    // Layer 3: output filter
    const hitOut = outputGuard(reply, P, cfg.outputGuard);
    if (hitOut) return { reply: "I was about to say something I'm not allowed to, so my reply was blocked.", blocked: { layer: "Output filter", detail: `blocked the reply because it ${hitOut}` } };

    return { reply, blocked: null };
  }

  function checkGuess(level, guess) {
    return lettersOnly(guess || "") === decodeWord(level.word);
  }

  const api = { respond, checkGuess, decodeWord, analyse, understand };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VaultEngine = api;
})(typeof window !== "undefined" ? window : globalThis);

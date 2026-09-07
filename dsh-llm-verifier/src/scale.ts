/**
 * A..T letter scale decoding — port of llm_verifier/progress.py.
 *
 * The progress scale is used everywhere in this plugin: A = 0% progress
 * (certainly NO), T = 100% (essentially certain YES). The inverted pairwise
 * scale from fine_grained_reward.py is intentionally not ported.
 */

export const GRANULARITY = 20;

export const LETTERS = Array.from({ length: GRANULARITY }, (_, i) =>
  String.fromCharCode(65 + i),
);

const LETTER_TO_VALUE = new Map<string, number>();
for (let i = 0; i < GRANULARITY; i++) {
  const letter = LETTERS[i];
  const value = i / (GRANULARITY - 1);
  LETTER_TO_VALUE.set(letter, value);
  LETTER_TO_VALUE.set(letter.toLowerCase(), value);
}

/** Map a scale letter (upper or lower case) to its value in [0, 1]. */
export function letterValue(letter: string): number | undefined {
  if (!letter) return undefined;
  return LETTER_TO_VALUE.get(letter[0]);
}

export interface LogprobAlt {
  token: string;
  logprob: number;
}

/**
 * Expectation over the letter values present in one position's top-K logprob
 * alternatives; undefined if no scale letter appears.
 * Port of `_expected_value_from_alts`.
 */
export function expectedValueFromAlts(
  alts: Array<LogprobAlt> | undefined,
): number | undefined {
  if (!alts) return undefined;
  const valsToLp = new Map<number, number>();
  for (const { token, logprob } of alts) {
    // Some BPE tokenizers merge the tag's closing ">" with the answer
    // letter into one token (">B"); strip it so the letter still counts.
    const t = String(token ?? "")
      .replace(/^\s+/, "")
      .replace(/^>+/, "")
      .replace(/^\s+/, "");
    if (!t) continue;
    const v = letterValue(t[0]);
    if (v === undefined) continue;
    const prev = valsToLp.get(v);
    if (prev === undefined || logprob > prev) valsToLp.set(v, logprob);
  }
  if (valsToLp.size === 0) return undefined;
  const mx = Math.max(...valsToLp.values());
  let total = 0;
  let expectation = 0;
  for (const [v, lp] of valsToLp) {
    const p = Math.exp(lp - mx);
    total += p;
    expectation += v * p;
  }
  return expectation / total;
}

/**
 * Decode the n checkpoint scores from one verifier response: logprob
 * expectation at the answer position after each `<c{i}>` tag, with a
 * text-parsing fallback. Port of `extract_progress_scores`.
 */
export function extractTagScores(
  text: string | undefined,
  tokens: string[] | undefined,
  positionLogprobs: Array<LogprobAlt[]> | undefined,
  n: number,
): Array<number | undefined> {
  const scores: Array<number | undefined> = new Array(n).fill(undefined);

  if (tokens && positionLogprobs) {
    // For each tag find the token position right after the tag text: walk
    // the joined token stream, skipping whitespace-only tokens, and keep
    // the LAST match for each tag.
    let joined = "";
    const positionsAfter: Array<{ endChar: number; nextPos: number }> = [];
    for (let j = 0; j < tokens.length; j++) {
      joined += tokens[j];
      positionsAfter.push({ endChar: joined.length, nextPos: j + 1 });
    }
    for (let i = 1; i <= n; i++) {
      const tag = `<c${i}>`;
      let idx = joined.indexOf(tag);
      while (idx >= 0) {
        const targetChar = idx + tag.length;
        for (const { endChar, nextPos } of positionsAfter) {
          const answerPos = nextPos - 1;
          if (endChar <= targetChar || tokens[answerPos]?.trim() === "") {
            continue;
          }
          if (
            answerPos >= 0 &&
            answerPos < positionLogprobs.length
          ) {
            const v = expectedValueFromAlts(positionLogprobs[answerPos]);
            if (v !== undefined) scores[i - 1] = v;
          }
          break;
        }
        const nextIdx = joined.indexOf(tag, idx + tag.length);
        idx = nextIdx >= 0 ? nextIdx : -1;
      }
    }
  }

  // Fallback: tagged letters in the text (last match), then bare
  // one-letter lines.
  for (let i = 1; i <= n; i++) {
    if (scores[i - 1] !== undefined) continue;
    const re = new RegExp(`<c${i}>\\s*([A-Ta-t])\\s*</c${i}>`, "g");
    let match: RegExpExecArray | null;
    let last: RegExpExecArray | null = null;
    while ((match = re.exec(text ?? "")) !== null) last = match;
    if (last) scores[i - 1] = letterValue(last[1]);
  }
  if (scores.some((s) => s === undefined)) {
    const bare = (text ?? "")
      .split("\n")
      .map((ln) => ln.trim())
      .filter((ln) => ln.length === 1 && LETTER_TO_VALUE.has(ln));
    if (bare.length === n) {
      for (let i = 0; i < n; i++) {
        if (scores[i] === undefined) scores[i] = letterValue(bare[i]);
      }
    }
  }
  return scores;
}

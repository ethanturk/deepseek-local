/**
 * Direct OpenAI-compatible Chat Completions call with token logprobs.
 *
 * `ctx.llm.stream` does not expose logprobs, so the verifier talks to the
 * scoring backend over plain HTTP using the global `fetch`.
 */

import type { LogprobAlt } from "./scale.ts";

export interface VerifierBackend {
  baseUrl: string;
  apiKey?: string;
  model: string;
  topLogprobs: number;
  maxTokens: number;
  timeoutMs: number;
  extraBody?: Record<string, unknown>;
}

export interface VerifierResponse {
  text: string;
  tokens?: string[];
  positionLogprobs?: LogprobAlt[][];
}

export interface CallVerifierOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function callVerifier(
  backend: VerifierBackend,
  prompt: string,
  options: CallVerifierOptions = {},
): Promise<VerifierResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signals: AbortSignal[] = [];
  if (options.signal) signals.push(options.signal);
  if (backend.timeoutMs > 0) {
    signals.push(AbortSignal.timeout(backend.timeoutMs));
  }
  const signal =
    signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);

  const baseUrl = backend.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (backend.apiKey) {
    headers.authorization = `Bearer ${backend.apiKey}`;
  }

  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: backend.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: backend.maxTokens,
      temperature: 1.0,
      logprobs: true,
      top_logprobs: backend.topLogprobs,
      ...(backend.extraBody ?? {}),
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `verifier request failed: HTTP ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
    );
  }

  const data = (await response.json()) as any;
  const choice = data?.choices?.[0];
  const text =
    typeof choice?.message?.content === "string"
      ? choice.message.content
      : "";

  let tokens: string[] | undefined;
  let positionLogprobs: LogprobAlt[][] | undefined;
  const content = choice?.logprobs?.content;
  if (Array.isArray(content) && content.length > 0) {
    tokens = [];
    positionLogprobs = [];
    for (const pos of content) {
      tokens.push(String(pos?.token ?? ""));
      let alts: LogprobAlt[] = (Array.isArray(pos?.top_logprobs)
        ? pos.top_logprobs
        : []
      ).map((alt: any) => ({
        token: String(alt?.token ?? ""),
        logprob: Number(alt?.logprob ?? -Infinity),
      }));
      if (alts.length === 0) {
        alts = [
          {
            token: String(pos?.token ?? ""),
            logprob: Number(pos?.logprob ?? -Infinity),
          },
        ];
      }
      positionLogprobs.push(alts);
    }
  }

  return { text, tokens, positionLogprobs };
}

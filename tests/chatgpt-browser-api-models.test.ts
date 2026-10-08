import { describe, expect, test } from "bun:test";
import {
  availableChatGptBrowserApiModels,
  parseChatGptBrowserApiRequest,
  routeChatGptBrowserApiModel,
  type ChatGptBrowserApiConfig,
} from "../src/chatgpt-browser-api";
import {
  CHATGPT_WEB_GPT6_SOL_BIGGER_AUTO_COMPACT_TOKEN_LIMIT,
  CHATGPT_WEB_GPT6_SOL_BIGGER_CONTEXT_WINDOW,
  resolveChatGptWebContextLimits,
} from "../src/chatgpt-web-models";

function config(overrides: Partial<ChatGptBrowserApiConfig> = {}): ChatGptBrowserApiConfig {
  return {
    host: "127.0.0.1",
    port: 18082,
    apiKey: "test-key",
    model: "gpt-6-sol",
    models: [],
    mode: "browser-only",
    contextWindow: 41_000,
    browserHost: "managed-chrome",
    headed: false,
    solAvailable: true,
    extraHighAvailable: false,
    proAvailable: false,
    experimentalBiggerContext: false,
    browserInteractionMode: "automatic",
    ...overrides,
  };
}

function route(model: string, effort?: string, overrides: Partial<ChatGptBrowserApiConfig> = {}) {
  const body: Record<string, unknown> = { model };
  if (effort) body.reasoning = { effort };
  return routeChatGptBrowserApiModel(body, config(overrides));
}

describe("chatgpt-browser-api model contract", () => {
  test("advertises only modern routes enabled by capabilities", () => {
    expect(availableChatGptBrowserApiModels(config())).toEqual([
      "chatgpt-web/gpt-6-sol-instant",
      "chatgpt-web/gpt-6-sol",
      "chatgpt-web/gpt-5.6-sol-instant",
      "chatgpt-web/gpt-5.6-sol",
    ]);
    expect(availableChatGptBrowserApiModels(config({ extraHighAvailable: true, proAvailable: true }))).toEqual([
      "chatgpt-web/gpt-6-sol-instant",
      "chatgpt-web/gpt-6-sol",
      "chatgpt-web/gpt-5.6-sol-instant",
      "chatgpt-web/gpt-5.6-sol",
      "chatgpt-web/gpt-5.6-pro",
      "chatgpt-web/gpt-6-pro",
    ]);
    expect(availableChatGptBrowserApiModels(config({ solAvailable: false }))).toEqual([
      "chatgpt-web/gpt-5.6-luna",
    ]);
  });

  test("routes Sol instant, standard, extra high and fixed Pro", () => {
    expect(route("chatgpt-web/gpt-5.6-sol-instant", "low").route).toMatchObject({ backendModel: "gpt-5.6-sol", adapterEffort: "low", modelFamily: "5.6" });
    expect(route("chatgpt-web/gpt-5.6-sol", "medium").route).toMatchObject({ adapterEffort: "medium", modelFamily: "5.6" });
    expect(route("chatgpt-web/gpt-5.6-sol", "xhigh", { extraHighAvailable: true }).route).toMatchObject({ adapterEffort: "xhigh", modelFamily: "5.6" });
    expect(route("chatgpt-web/gpt-5.6-pro", "max", { proAvailable: true }).route).toMatchObject({ adapterEffort: "max", modelFamily: "5.6" });
    expect(() => route("chatgpt-web/gpt-5.6-pro", "low", { proAvailable: true })).toThrow("does not support effort \"low\"");
  });

  test("routes the complete GPT-6 family with its model family", () => {
    expect(route("chatgpt-web/gpt-6-sol-instant", "low").route).toMatchObject({ adapterEffort: "low", modelFamily: "6" });
    expect(route("chatgpt-web/gpt-6-sol", "medium").route).toMatchObject({ adapterEffort: "medium", modelFamily: "6" });
    expect(route("chatgpt-web/gpt-6-sol", "xhigh", { extraHighAvailable: true }).route).toMatchObject({ adapterEffort: "xhigh", modelFamily: "6" });
    expect(route("chatgpt-web/gpt-6-pro", "max", { proAvailable: true }).route).toMatchObject({ adapterEffort: "max", modelFamily: "6" });
  });

  test("uses the 6.1.6 GPT-6 Bigger Context limits", () => {
    expect(resolveChatGptWebContextLimits("gpt-5.6-sol", "high", config({
      proAvailable: true,
      experimentalBiggerContext: true,
    }), "6")).toMatchObject({
      contextWindow: CHATGPT_WEB_GPT6_SOL_BIGGER_CONTEXT_WINDOW,
      autoCompactTokenLimit: CHATGPT_WEB_GPT6_SOL_BIGGER_AUTO_COMPACT_TOKEN_LIMIT,
    });
  });

  test("routes Luna low and medium", () => {
    expect(route("chatgpt-web/gpt-5.6-luna", "low", { solAvailable: false }).route).toMatchObject({ backendModel: "gpt-5.6-luna", adapterEffort: "low" });
    expect(route("chatgpt-web/gpt-5.6-luna", "medium", { solAvailable: false }).route).toMatchObject({ backendModel: "gpt-5.6-luna", adapterEffort: "medium" });
  });

  test("keeps standalone aliases explicit and deterministic", () => {
    for (const alias of ["gpt-6-sol", "browser-agent/gpt", "browser-agent-gpt"]) {
      expect(route(alias, "low")).toMatchObject({ requestedModel: alias, canonicalModel: "chatgpt-web/gpt-6-sol-instant", route: { adapterEffort: "low", modelFamily: "6" } });
      expect(route(alias, "high")).toMatchObject({ requestedModel: alias, canonicalModel: "chatgpt-web/gpt-6-sol", route: { adapterEffort: "high", modelFamily: "6" } });
      expect(route(alias, "max", { proAvailable: true })).toMatchObject({ requestedModel: alias, canonicalModel: "chatgpt-web/gpt-6-pro", route: { adapterEffort: "max", modelFamily: "6" } });
    }
    expect(route("gpt-5.6-sol", "low")).toMatchObject({ canonicalModel: "chatgpt-web/gpt-5.6-sol-instant", route: { modelFamily: "5.6" } });
    expect(route("gpt-5.6-sol", "high")).toMatchObject({ canonicalModel: "chatgpt-web/gpt-5.6-sol", route: { modelFamily: "5.6" } });
    expect(route("gpt-5.6-sol", "max", { proAvailable: true })).toMatchObject({ canonicalModel: "chatgpt-web/gpt-5.6-pro", route: { modelFamily: "5.6" } });
    expect(route("gpt-5.6-luna", "medium", { solAvailable: false })).toMatchObject({ canonicalModel: "chatgpt-web/gpt-5.6-luna", route: { adapterEffort: "medium" } });
    expect(() => route("gpt-5.6-luna", "medium")).toThrow("only available for Luna-only accounts");
    expect(route("browser-agent/gpt", "medium", { solAvailable: false })).toMatchObject({ canonicalModel: "chatgpt-web/gpt-5.6-luna", route: { adapterEffort: "medium" } });
    expect(() => route("gpt-6-sol", "medium", { solAvailable: false })).toThrow("not available for this Luna-only account");
    expect(() => route("gpt-5.6-sol", "medium", { solAvailable: false })).toThrow("not available for this Luna-only account");
  });

  test("rejects invalid and unavailable models instead of falling back to Sol", () => {
    expect(() => route("anything-at-all", "high")).toThrow("ChatGPT web model is not enabled");
    expect(() => route("chatgpt-web/gpt-5.6-sol", "xhigh")).toThrow("does not support effort \"xhigh\"");
    expect(() => route("chatgpt-web/gpt-5.6-pro", "max")).toThrow("is not available for this account");
    expect(() => route("chatgpt-web/gpt-6-pro", "max")).toThrow("is not available for this account");
    expect(() => route("chatgpt-web/gpt-5.6-luna", "low")).toThrow("only available for Luna-only accounts");
  });

  test("accepts both reasoning request shapes", () => {
    expect(routeChatGptBrowserApiModel({ model: "gpt-6-sol", reasoning_effort: "medium" }, config()).route.adapterEffort).toBe("medium");
    expect(routeChatGptBrowserApiModel({ model: "gpt-6-sol", reasoning: { effort: "high" } }, config()).route.adapterEffort).toBe("high");
  });

  test("converts both endpoint request shapes to backend routing fields", () => {
    const chat = parseChatGptBrowserApiRequest({ model: "chatgpt-web/gpt-5.6-sol", reasoning_effort: "medium", messages: [] }, config(), "chat");
    expect(chat).toMatchObject({ modelId: "gpt-5.6-sol", options: { reasoning: "medium" }, _chatgptModelFamily: "5.6" });
    const responses = parseChatGptBrowserApiRequest({ model: "chatgpt-web/gpt-6-pro", reasoning: { effort: "max" }, input: [] }, config({ proAvailable: true }), "responses");
    expect(responses).toMatchObject({ modelId: "gpt-5.6-sol", options: { reasoning: "max" }, _chatgptModelFamily: "6" });
  });
});

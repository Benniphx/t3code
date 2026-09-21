import type { ModelSelection, OrchestrationCommand } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export const JevTurnRouterMode = Schema.Literals(["off", "shadow", "apply"]);
export type JevTurnRouterMode = typeof JevTurnRouterMode.Type;

export const JevModelTier = Schema.Literals(["small", "normal", "expert"]);
export type JevModelTier = typeof JevModelTier.Type;

type TurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
export const JEV_TIMEOUT_MS = 1_500;
export const JEV_APPLY_CONFIDENCE_THRESHOLD = 0.85;
export const JEV_MAX_ROUTING_TEXT_CHARS = 12_000;

export const JEV_MODEL_BY_TIER = {
  small: "gpt-5.6-luna",
  normal: "gpt-5.6-terra",
  expert: "gpt-5.6-sol",
} as const satisfies Record<JevModelTier, string>;

const MODEL_TIER_CRITERIA = {
  small: "A bounded, low-risk request answerable with light reasoning and few tool steps",
  normal: "A typical coding or investigation task requiring repository context and tools",
  expert: "A complex, ambiguous, high-risk, or cross-system task requiring deep reasoning",
} as const satisfies Record<JevModelTier, string>;

const JevResponse = Schema.Struct({
  answers: Schema.Struct({
    model_tier: Schema.Struct({
      type: Schema.optional(Schema.Literal("choice")),
      choice: JevModelTier,
      confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    }),
  }),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      output_tokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      total_tokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
});

export interface JevTurnRouterConfig {
  readonly mode: JevTurnRouterMode;
  readonly apiKey: Redacted.Redacted<string> | undefined;
}

export interface JevRoutingActivity {
  readonly mode: Exclude<JevTurnRouterMode, "off">;
  readonly status: "recommended" | "applied" | "fallback";
  readonly tier?: JevModelTier;
  readonly confidence?: number;
  readonly latencyMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly originalModel?: string;
  readonly recommendedModel?: string;
  readonly reason?:
    | "missing-api-key"
    | "missing-model-selection"
    | "confidence-below-threshold"
    | "timeout"
    | "unavailable";
}

export interface JevTurnRouteResult {
  readonly command: TurnStartCommand;
  readonly activity: JevRoutingActivity | null;
}

const config = Config.all({
  mode: Config.schema(JevTurnRouterMode, "T3CODE_JEV_MODE").pipe(Config.withDefault("off")),
  apiKey: Config.Redacted("T3CODE_JEV_API_KEY").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

const modelSelectionFor = (command: TurnStartCommand): ModelSelection | undefined =>
  command.modelSelection ?? command.bootstrap?.createThread?.modelSelection;

export const routeTurnWithJev = Effect.fn("JevTurnRouter.routeTurn")(function* (
  command: TurnStartCommand,
  routerConfig: JevTurnRouterConfig,
): Effect.fn.Return<JevTurnRouteResult, never, HttpClient.HttpClient> {
  if (routerConfig.mode === "off") {
    return { command, activity: null };
  }

  const startedAt = yield* Clock.currentTimeMillis;
  const selection = modelSelectionFor(command);
  const finish = (
    activity: Omit<JevRoutingActivity, "latencyMs" | "mode">,
    routedCommand: TurnStartCommand = command,
  ) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((finishedAt): JevTurnRouteResult => ({
        command: routedCommand,
        activity: {
          mode: routerConfig.mode as Exclude<JevTurnRouterMode, "off">,
          ...activity,
          latencyMs: Math.max(0, finishedAt - startedAt),
        },
      })),
    );
  const originalModel = selection?.model;
  const originalModelDetails = originalModel === undefined ? {} : { originalModel };

  if (routerConfig.apiKey === undefined) {
    return yield* finish({
      status: "fallback",
      ...originalModelDetails,
      reason: "missing-api-key",
    });
  }
  if (selection === undefined) {
    return yield* finish({ status: "fallback", reason: "missing-model-selection" });
  }

  const routingText = command.message.text.slice(0, JEV_MAX_ROUTING_TEXT_CHARS);
  const request = HttpClientRequest.post(JEV_API_URL).pipe(
    HttpClientRequest.bearerToken(routerConfig.apiKey),
    HttpClientRequest.acceptJson,
    HttpClientRequest.bodyJsonUnsafe({
      model: JEV_MODEL,
      state: {
        source: "t3",
        request: routingText,
        request_truncated: routingText.length < command.message.text.length,
        provider_instance: selection.instanceId,
        current_model: selection.model,
        interaction_mode: command.interactionMode,
      },
      questions: {
        model_tier: {
          type: "choice",
          instructions: "Choose the lowest model tier likely to complete `request` correctly.",
          criteria: MODEL_TIER_CRITERIA,
        },
      },
    }),
  );
  const httpClient = yield* HttpClient.HttpClient;
  const attempt = yield* httpClient
    .execute(request)
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(JevResponse)),
      Effect.timeoutOption(JEV_TIMEOUT_MS),
      Effect.result,
    );

  if (Result.isFailure(attempt)) {
    return yield* finish({
      status: "fallback",
      ...originalModelDetails,
      reason: "unavailable",
    });
  }
  if (Option.isNone(attempt.success)) {
    return yield* finish({
      status: "fallback",
      ...originalModelDetails,
      reason: "timeout",
    });
  }

  const response = attempt.success.value;
  const tier = response.answers.model_tier.choice;
  const confidence = response.answers.model_tier.confidence;
  const recommendedModel = JEV_MODEL_BY_TIER[tier];
  const usage = response.usage;
  const base = {
    tier,
    confidence,
    ...originalModelDetails,
    recommendedModel,
    ...(usage?.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
    ...(usage?.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
    ...(usage?.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
  };

  if (routerConfig.mode === "shadow" || confidence < JEV_APPLY_CONFIDENCE_THRESHOLD) {
    return yield* finish({
      status: routerConfig.mode === "shadow" ? "recommended" : "fallback",
      ...base,
      ...(routerConfig.mode === "apply" ? { reason: "confidence-below-threshold" as const } : {}),
    });
  }

  return yield* finish(
    { status: "applied", ...base },
    {
      ...command,
      modelSelection: { ...selection, model: recommendedModel },
    },
  );
});

export const jevRoutingSummary = (activity: JevRoutingActivity): string => {
  if (activity.status === "fallback") {
    return `Jev ${activity.mode} fallback · ${activity.reason ?? "unavailable"} · ${activity.latencyMs} ms · ${activity.originalModel ?? "default model"}`;
  }
  const tokenUsage =
    activity.inputTokens === undefined && activity.outputTokens === undefined
      ? "tokens unavailable"
      : `${activity.inputTokens ?? 0} in / ${activity.outputTokens ?? 0} out tokens`;
  return `Jev ${activity.mode} · ${activity.tier ?? "unknown"} · ${Math.round((activity.confidence ?? 0) * 100)}% · ${activity.latencyMs} ms · ${tokenUsage} · ${activity.originalModel ?? "default model"} → ${activity.recommendedModel ?? "default model"}`;
};

export const makeJevTurnRouter = Effect.gen(function* () {
  const routerConfig = yield* config;
  const httpClient = yield* HttpClient.HttpClient;
  return {
    routeTurn: (command) =>
      routeTurnWithJev(command, routerConfig).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
  } satisfies {
    readonly routeTurn: (command: TurnStartCommand) => Effect.Effect<JevTurnRouteResult>;
  };
});

import { z } from "zod";

import { ConnectionIdSchema } from "./schema/primitives.js";
const ROSS_SWP08_REQUEST_TIMEOUT_MS_MIN = 100;
const ROSS_SWP08_REQUEST_TIMEOUT_MS_MAX = 10000;
const UtcTimestampSchema = z.iso.datetime();
const RendererSafeMessageSchema = z.string().max(1000);

export const MAX_ROUTER_PAGE_ENTRIES = 2_048;
export const MAX_ROUTER_DELTA_ENTRIES = 2_048;
export const MAX_ROUTER_TAKE_MAPPINGS = 256;
export const MAX_ROUTER_TAKE_CROSSPOINTS = 4_096;
export const MAX_ROUTER_COMMAND_TARGETS = MAX_ROUTER_TAKE_CROSSPOINTS;
export const MAX_ROUTER_INTERROGATE_DESTINATIONS = 256;
export const MAX_ROUTER_BOOTSTRAP_EVENTS = 1_024;
export const MAX_ROUTER_BOOTSTRAP_CROSSPOINTS = 65_536;
export const MAX_ROUTER_BUFFERED_CROSSPOINTS = MAX_ROUTER_BOOTSTRAP_CROSSPOINTS;

const MAX_ROUTER_ADDRESS = 65_536;
const MAX_STANDARD_ROUTER_ADDRESS = 1_024;
const MAX_ROUTER_LEVEL = 256;
const MAX_STANDARD_ROUTER_LEVEL = 16;
const MAX_ROUTER_CROSSPOINT_COUNT = MAX_ROUTER_ADDRESS * MAX_ROUTER_LEVEL;
export const MAX_ROUTER_SEARCH_LENGTH = 128;

export const RouterGenerationSchema = z.uuid().brand<"RouterGeneration">();
export const RouterListenerIdSchema = z.uuid().brand<"RouterListenerId">();
export const RouterOperationIdSchema = z.uuid().brand<"RouterOperationId">();
export const RouterMappingIdSchema = z.uuid().brand<"RouterMappingId">();
export const RouterInterrogationRequestIdSchema = z
  .uuid()
  .brand<"RouterInterrogationRequestId">();
export const RouterAddressSchema = z.int().min(1).max(MAX_ROUTER_ADDRESS);
export const RouterMatrixSchema = z.int().min(1).max(256);
export const RouterLevelSchema = z.int().min(1).max(MAX_ROUTER_LEVEL);
export const RouterRevisionSchema = z
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const RouterLabelRevisionSchema = z
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const RouterEventSequenceSchema = z
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const RouterKnownResourceCountSchema = z
  .int()
  .nonnegative()
  .max(MAX_ROUTER_ADDRESS);
export const RouterKnownCrosspointCountSchema = z
  .int()
  .nonnegative()
  .max(MAX_ROUTER_CROSSPOINT_COUNT);

export const RouterLabelSchema = z
  .string()
  .max(128)
  .refine(
    (value) => !/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value),
    "router label must contain at most 128 readable characters",
  );

export const RouterSearchSchema = z
  .string()
  .max(MAX_ROUTER_SEARCH_LENGTH)
  .refine(
    (value) => !/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value),
    "router search must be one line containing at most 128 readable characters",
  );

export const RouterRouteVersionSchema = z
  .strictObject({
    generation: RouterGenerationSchema,
    revision: RouterRevisionSchema,
  })
  .readonly();

export const RouterTransportPhaseSchema = z.enum([
  "connecting",
  "connected",
  "disconnected",
]);
export const RouterSyncPhaseSchema = z.enum([
  "synchronizing",
  "ready",
  "degraded",
  "stale",
]);
export const RouterLabelPhaseSchema = z.enum(["loading", "ready", "degraded"]);

export const RouterReadStampSchema = z
  .strictObject({
    version: RouterRouteVersionSchema,
    labelRevision: RouterLabelRevisionSchema,
  })
  .readonly();

const RouterLevelsSchema = z
  .array(RouterLevelSchema)
  .max(MAX_ROUTER_LEVEL)
  .superRefine((levels, context) => {
    rejectNonAscendingNumbers(levels, context, [], "router levels");
  })
  .readonly();

const RouterRequiredLevelsSchema = z
  .array(RouterLevelSchema)
  .min(1)
  .max(MAX_ROUTER_LEVEL)
  .superRefine((levels, context) => {
    rejectNonAscendingNumbers(levels, context, [], "router levels");
  })
  .readonly();

const RouterPageQueryFields = {
  connectionId: ConnectionIdSchema,
  version: RouterRouteVersionSchema,
  labelRevision: RouterLabelRevisionSchema,
  afterAddress: RouterAddressSchema.nullable(),
  limit: z.int().min(1).max(MAX_ROUTER_PAGE_ENTRIES),
  search: RouterSearchSchema.nullable(),
} as const;

export const RouterSourcePageQuerySchema = z
  .strictObject({
    resource: z.literal("sources"),
    ...RouterPageQueryFields,
  })
  .readonly();

export const RouterDestinationPageQuerySchema = z
  .strictObject({
    resource: z.literal("destinations"),
    ...RouterPageQueryFields,
    source: RouterAddressSchema.nullable(),
    levels: RouterLevelsSchema,
  })
  .superRefine((query, context) => {
    if (query.source === null && query.levels.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["levels"],
        message: "destination levels require a source filter",
        input: query.levels,
      });
    }
  })
  .readonly();

export const RouterResourcePageQuerySchema = z
  .discriminatedUnion("resource", [
    RouterSourcePageQuerySchema,
    RouterDestinationPageQuerySchema,
  ])
  .readonly();

export const RouterSourceEntrySchema = z
  .strictObject({
    address: RouterAddressSchema,
    label: RouterLabelSchema.nullable(),
  })
  .readonly();

const RouterSourceEntriesSchema = z
  .array(RouterSourceEntrySchema)
  .max(MAX_ROUTER_PAGE_ENTRIES)
  .superRefine((entries, context) => {
    rejectNonAscendingAddresses(entries, context);
  })
  .readonly();

export const RouterDestinationRouteSchema = z
  .strictObject({
    level: RouterLevelSchema,
    source: RouterAddressSchema,
  })
  .readonly();

const RouterDestinationRoutesSchema = z
  .array(RouterDestinationRouteSchema)
  .max(MAX_ROUTER_LEVEL)
  .superRefine((routes, context) => {
    rejectNonAscendingNumbers(
      routes.map(({ level }) => level),
      context,
      [],
      "destination route levels",
    );
  })
  .readonly();

export const RouterDestinationEntrySchema = z
  .strictObject({
    address: RouterAddressSchema,
    label: RouterLabelSchema.nullable(),
    routes: RouterDestinationRoutesSchema,
  })
  .readonly();

const RouterDestinationEntriesSchema = z
  .array(RouterDestinationEntrySchema)
  .max(MAX_ROUTER_PAGE_ENTRIES)
  .superRefine((entries, context) => {
    rejectNonAscendingAddresses(entries, context);
  })
  .readonly();

export const RouterSourcePageSchema = z
  .strictObject({
    resource: z.literal("sources"),
    version: RouterRouteVersionSchema,
    labelRevision: RouterLabelRevisionSchema,
    entries: RouterSourceEntriesSchema,
    nextAfterAddress: RouterAddressSchema.nullable(),
    totalCount: RouterKnownResourceCountSchema,
  })
  .superRefine((page, context) => {
    validatePage(page, context);
  })
  .readonly();

export const RouterDestinationPageSchema = z
  .strictObject({
    resource: z.literal("destinations"),
    version: RouterRouteVersionSchema,
    labelRevision: RouterLabelRevisionSchema,
    entries: RouterDestinationEntriesSchema,
    nextAfterAddress: RouterAddressSchema.nullable(),
    totalCount: RouterKnownResourceCountSchema,
  })
  .superRefine((page, context) => {
    validatePage(page, context);
    const routeCount = page.entries.reduce(
      (count, entry) => count + entry.routes.length,
      0,
    );
    if (routeCount > MAX_ROUTER_BOOTSTRAP_CROSSPOINTS) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: `router destination page exceeds ${String(MAX_ROUTER_BOOTSTRAP_CROSSPOINTS)} crosspoints`,
        input: page.entries,
      });
    }
  })
  .readonly();

export const RouterResourcePageSchema = z
  .discriminatedUnion("resource", [
    RouterSourcePageSchema,
    RouterDestinationPageSchema,
  ])
  .readonly();

export const RouterSourcePageExchangeSchema = z
  .strictObject({
    query: RouterSourcePageQuerySchema,
    page: RouterSourcePageSchema,
  })
  .superRefine((exchange, context) => {
    validatePageExchange(exchange.query, exchange.page, context);
  })
  .readonly();

export const RouterDestinationPageExchangeSchema = z
  .strictObject({
    query: RouterDestinationPageQuerySchema,
    page: RouterDestinationPageSchema,
  })
  .superRefine((exchange, context) => {
    validatePageExchange(exchange.query, exchange.page, context);
    if (exchange.query.source === null) return;
    for (const [index, entry] of exchange.page.entries.entries()) {
      const matchesSourceFilter = entry.routes.some(
        (route) =>
          route.source === exchange.query.source &&
          (exchange.query.levels.length === 0 ||
            exchange.query.levels.includes(route.level)),
      );
      if (!matchesSourceFilter) {
        context.addIssue({
          code: "custom",
          path: ["page", "entries", index, "routes"],
          message:
            "destination page entry does not match its source/level filter",
          input: entry.routes,
        });
      }
    }
  })
  .readonly();

export const RouterResourcePageExchangeSchema = z.union([
  RouterSourcePageExchangeSchema,
  RouterDestinationPageExchangeSchema,
]);

export const RouterCrosspointSchema = z
  .strictObject({
    destination: RouterAddressSchema,
    level: RouterLevelSchema,
    source: RouterAddressSchema,
  })
  .readonly();

export const RouterCrosspointDeltaSchema = z
  .strictObject({
    destination: RouterAddressSchema,
    level: RouterLevelSchema,
    previousSource: RouterAddressSchema.nullable(),
    source: RouterAddressSchema,
  })
  .superRefine((crosspoint, context) => {
    if (crosspoint.previousSource === crosspoint.source) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "router delta must change its source",
        input: crosspoint.source,
      });
    }
  })
  .readonly();

const RouterCrosspointDeltasSchema = z
  .array(RouterCrosspointDeltaSchema)
  .min(1)
  .max(MAX_ROUTER_DELTA_ENTRIES)
  .superRefine((crosspoints, context) => {
    rejectDuplicateCrosspoints(crosspoints, context);
  })
  .readonly();

export const RouterResetEventSchema = z
  .strictObject({
    type: z.literal("reset"),
    version: RouterRouteVersionSchema,
    phase: RouterSyncPhaseSchema,
    knownSourceCount: RouterKnownResourceCountSchema,
    knownDestinationCount: RouterKnownResourceCountSchema,
    knownCrosspointCount: RouterKnownCrosspointCountSchema,
  })
  .superRefine((event, context) => {
    if (event.phase === "ready") {
      context.addIssue({
        code: "custom",
        path: ["phase"],
        message: "a Router reset cannot already be ready",
        input: event.phase,
      });
    }
    if (event.knownCrosspointCount !== 0) {
      context.addIssue({
        code: "custom",
        path: ["knownCrosspointCount"],
        message: "post-reset Router truth cannot retain known crosspoints",
        input: event.knownCrosspointCount,
      });
    }
  })
  .readonly();

export const RouterDeltaEventSchema = z
  .strictObject({
    type: z.literal("delta"),
    generation: RouterGenerationSchema,
    previousRevision: RouterRevisionSchema,
    revision: RouterRevisionSchema,
    crosspoints: RouterCrosspointDeltasSchema,
    knownSourceCount: RouterKnownResourceCountSchema,
    knownDestinationCount: RouterKnownResourceCountSchema,
    knownCrosspointCount: RouterKnownCrosspointCountSchema,
  })
  .superRefine((event, context) => {
    if (event.revision !== event.previousRevision + 1) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message:
          "router delta revision must immediately follow previousRevision",
        input: event.revision,
      });
    }
    const changedDestinations = new Set(
      event.crosspoints.map(({ destination }) => destination),
    );
    const currentSources = new Set(
      event.crosspoints.map(({ source }) => source),
    );
    if (event.knownDestinationCount < changedDestinations.size) {
      context.addIssue({
        code: "custom",
        path: ["knownDestinationCount"],
        message: "known destination count cannot omit changed destinations",
        input: event.knownDestinationCount,
      });
    }
    if (event.knownSourceCount < currentSources.size) {
      context.addIssue({
        code: "custom",
        path: ["knownSourceCount"],
        message: "known source count cannot omit current delta sources",
        input: event.knownSourceCount,
      });
    }
    if (event.knownCrosspointCount < event.crosspoints.length) {
      context.addIssue({
        code: "custom",
        path: ["knownCrosspointCount"],
        message: "known crosspoint count cannot omit changed crosspoints",
        input: event.knownCrosspointCount,
      });
    }
  })
  .readonly();

export const RouterObservationEventSchema = z
  .strictObject({
    type: z.literal("observation"),
    version: RouterRouteVersionSchema,
    crosspoint: RouterCrosspointSchema,
  })
  .readonly();

export const RouterIntentCrosspointSchema = z
  .strictObject({
    matrix: RouterMatrixSchema,
    destination: RouterAddressSchema,
    level: RouterLevelSchema,
    source: RouterAddressSchema,
  })
  .readonly();

const RouterIntentCrosspointsSchema = z
  .array(RouterIntentCrosspointSchema)
  .min(1)
  .max(MAX_ROUTER_TAKE_CROSSPOINTS)
  .superRefine((crosspoints, context) => {
    rejectDuplicateCrosspoints(crosspoints, context);
  })
  .readonly();

export const RouterIntentEventSchema = z
  .strictObject({
    type: z.literal("intent"),
    version: RouterRouteVersionSchema,
    crosspoints: RouterIntentCrosspointsSchema,
    active: z.boolean(),
  })
  .readonly();

export const RouterTransportEventSchema = z
  .strictObject({
    type: z.literal("transport"),
    version: RouterRouteVersionSchema,
    phase: RouterTransportPhaseSchema,
  })
  .readonly();

export const RouterPhaseEventSchema = z
  .strictObject({
    type: z.literal("phase"),
    version: RouterRouteVersionSchema,
    phase: RouterSyncPhaseSchema,
  })
  .readonly();

export const RouterLabelPhaseEventSchema = z
  .strictObject({
    type: z.literal("label-phase"),
    version: RouterRouteVersionSchema,
    labelRevision: RouterLabelRevisionSchema,
    phase: RouterLabelPhaseSchema,
  })
  .readonly();

export const RouterCatalogEventSchema = z
  .strictObject({
    type: z.literal("catalog"),
    version: RouterRouteVersionSchema,
    labelRevision: RouterLabelRevisionSchema,
    sourcesChanged: z.boolean(),
    destinationsChanged: z.boolean(),
    knownSourceCount: RouterKnownResourceCountSchema,
    knownDestinationCount: RouterKnownResourceCountSchema,
  })
  .superRefine((event, context) => {
    if (!event.sourcesChanged && !event.destinationsChanged) {
      context.addIssue({
        code: "custom",
        path: ["sourcesChanged"],
        message: "router catalog event must invalidate at least one catalog",
        input: event.sourcesChanged,
      });
    }
  })
  .readonly();

export const RouterResyncReasonSchema = z.enum([
  "configuration_changed",
  "event_buffer_overflow",
  "crosspoint_buffer_overflow",
  "sequence_gap",
  "invalid_event",
]);

export const RouterResyncRequiredEventSchema = z
  .strictObject({
    type: z.literal("resync_required"),
    reason: RouterResyncReasonSchema,
  })
  .readonly();

export const RouterStateEventSchema = z
  .discriminatedUnion("type", [
    RouterResetEventSchema,
    RouterDeltaEventSchema,
    RouterObservationEventSchema,
    RouterIntentEventSchema,
    RouterTransportEventSchema,
    RouterPhaseEventSchema,
    RouterLabelPhaseEventSchema,
    RouterCatalogEventSchema,
    RouterResyncRequiredEventSchema,
  ])
  .readonly();

export const SequencedRouterStateEventSchema = z
  .strictObject({
    sequence: RouterEventSequenceSchema,
    emittedAt: UtcTimestampSchema,
    event: RouterStateEventSchema,
  })
  .readonly();

export const RouterSessionBootstrapSchema = z
  .strictObject({
    listenerId: RouterListenerIdSchema,
    lastEventSequence: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    connectionId: ConnectionIdSchema,
    version: RouterRouteVersionSchema,
    labelRevision: RouterLabelRevisionSchema,
    transport: RouterTransportPhaseSchema,
    sync: RouterSyncPhaseSchema,
    labels: RouterLabelPhaseSchema,
    requestTimeoutMs: z
      .int()
      .min(ROSS_SWP08_REQUEST_TIMEOUT_MS_MIN)
      .max(ROSS_SWP08_REQUEST_TIMEOUT_MS_MAX),
    levels: RouterLevelSchema,
    /**
     * Legacy SW-P-08 extended-mode flag. A transport with wide addresses but
     * simple routing (for example Videohub) keeps this false and sets
     * `wideAddresses` instead.
     */
    extended: z.boolean(),
    wideAddresses: z.boolean().optional(),
    knownSourceCount: RouterKnownResourceCountSchema,
    knownDestinationCount: RouterKnownResourceCountSchema,
    knownCrosspointCount: RouterKnownCrosspointCountSchema,
    sources: RouterSourcePageSchema,
    destinations: RouterDestinationPageSchema,
  })
  .superRefine((bootstrap, context) => {
    validateBootstrap(bootstrap, context);
  })
  .readonly();

export const RouterExpectedSourceSchema = z
  .strictObject({
    level: RouterLevelSchema,
    /** Null means the router reported nothing routed to this level. */
    source: RouterAddressSchema.nullable(),
  })
  .readonly();

const RouterExpectedSourcesSchema = z
  .array(RouterExpectedSourceSchema)
  .min(1)
  .max(MAX_ROUTER_LEVEL)
  .superRefine((expected, context) => {
    rejectNonAscendingNumbers(
      expected.map(({ level }) => level),
      context,
      [],
      "expected-source levels",
    );
  })
  .readonly();

export const RouteCrosspointsMappingSchema = z
  .strictObject({
    mappingId: RouterMappingIdSchema,
    source: RouterAddressSchema,
    destination: RouterAddressSchema,
    levels: RouterRequiredLevelsSchema,
    expected: RouterExpectedSourcesSchema,
  })
  .superRefine((mapping, context) => {
    if (
      mapping.expected.length !== mapping.levels.length ||
      mapping.expected.some(
        ({ level }, index) => level !== mapping.levels[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["expected"],
        message:
          "expected sources must exactly match the ordered mapping levels",
        input: mapping.expected,
      });
    }
  })
  .readonly();

const RouteCrosspointsMappingsSchema = z
  .array(RouteCrosspointsMappingSchema)
  .min(1)
  .max(MAX_ROUTER_TAKE_MAPPINGS)
  .superRefine((mappings, context) => {
    const mappingIds = new Set<string>();
    const targets = new Set<string>();
    let expandedTargetCount = 0;
    for (const [mappingIndex, mapping] of mappings.entries()) {
      if (mappingIds.has(mapping.mappingId)) {
        context.addIssue({
          code: "custom",
          path: [mappingIndex, "mappingId"],
          message: `duplicate router mapping ${mapping.mappingId}`,
          input: mapping.mappingId,
        });
      }
      mappingIds.add(mapping.mappingId);
      expandedTargetCount += mapping.levels.length;
      mapping.levels.forEach((level, levelIndex) => {
        const key = crosspointKey(mapping.destination, level);
        if (targets.has(key)) {
          context.addIssue({
            code: "custom",
            path: [mappingIndex, "levels", levelIndex],
            message: `duplicate router target ${key}`,
            input: level,
          });
        }
        targets.add(key);
      });
    }
    if (expandedTargetCount > MAX_ROUTER_COMMAND_TARGETS) {
      context.addIssue({
        code: "custom",
        message: `router Take exceeds ${String(MAX_ROUTER_COMMAND_TARGETS)} crosspoints`,
        input: mappings,
      });
    }
  })
  .readonly();

export const RouteCrosspointsRequestSchema = z
  .strictObject({
    operationId: RouterOperationIdSchema,
    connectionId: ConnectionIdSchema,
    version: RouterRouteVersionSchema,
    mappings: RouteCrosspointsMappingsSchema,
  })
  .readonly();

export const RouteCrosspointsRejectionCodeSchema = z.enum([
  "connection_unavailable",
  "disabled",
  "disconnected",
  "not_synchronized",
  "stale_generation",
  "target_conflict",
  "target_busy",
  "invalid_source",
  "invalid_destination",
  "invalid_level",
  "duplicate_target",
  "capacity_exceeded",
  "operation_id_conflict",
  "operation_capacity_exceeded",
]);

export const RouteCrosspointsDispatchOutcomeSchema = z.enum([
  "already_confirmed",
  "acknowledged",
  "nak",
  "timeout",
  "conflict",
  "not_attempted",
]);

export const RouteCrosspointsTargetOutcomeSchema = z
  .strictObject({
    mappingId: RouterMappingIdSchema,
    source: RouterAddressSchema,
    destination: RouterAddressSchema,
    level: RouterLevelSchema,
    outcome: RouteCrosspointsDispatchOutcomeSchema,
  })
  .readonly();

const RouteCrosspointsTargetOutcomesSchema = z
  .array(RouteCrosspointsTargetOutcomeSchema)
  .min(1)
  .max(MAX_ROUTER_COMMAND_TARGETS)
  .superRefine((outcomes, context) => {
    rejectDuplicateCrosspoints(outcomes, context);
    validateFailFastOutcomes(outcomes, context, ["nak", "timeout", "conflict"]);
  })
  .readonly();

export const RouteCrosspointsAcknowledgedResultSchema = z
  .strictObject({
    status: z.literal("acknowledged"),
    operationId: RouterOperationIdSchema,
    outcomes: RouteCrosspointsTargetOutcomesSchema,
  })
  .superRefine((result, context) => {
    if (
      result.outcomes.some(
        ({ outcome }) =>
          outcome !== "acknowledged" && outcome !== "already_confirmed",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcomes"],
        message:
          "acknowledged Take results may contain only successful outcomes",
        input: result.outcomes,
      });
    }
  })
  .readonly();

export const RouteCrosspointsPartialResultSchema = z
  .strictObject({
    status: z.literal("partial"),
    operationId: RouterOperationIdSchema,
    outcomes: RouteCrosspointsTargetOutcomesSchema,
  })
  .superRefine((result, context) => {
    if (
      result.outcomes.every(
        ({ outcome }) =>
          outcome === "acknowledged" || outcome === "already_confirmed",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcomes"],
        message:
          "partial Take results require at least one non-success outcome",
        input: result.outcomes,
      });
    }
  })
  .readonly();

export const RouteCrosspointsRejectedResultSchema = z
  .strictObject({
    status: z.literal("rejected"),
    operationId: RouterOperationIdSchema,
    code: RouteCrosspointsRejectionCodeSchema,
    message: RendererSafeMessageSchema,
  })
  .readonly();

export const RouteCrosspointsResultSchema = z
  .discriminatedUnion("status", [
    RouteCrosspointsAcknowledgedResultSchema,
    RouteCrosspointsPartialResultSchema,
    RouteCrosspointsRejectedResultSchema,
  ])
  .readonly();

export const InterrogateRouterTargetSchema = z
  .strictObject({
    destination: RouterAddressSchema,
    levels: RouterRequiredLevelsSchema,
  })
  .readonly();

const InterrogateRouterTargetsSchema = z
  .array(InterrogateRouterTargetSchema)
  .min(1)
  .max(MAX_ROUTER_INTERROGATE_DESTINATIONS)
  .superRefine((targets, context) => {
    const destinations = new Set<number>();
    let expandedTargetCount = 0;
    for (const [index, target] of targets.entries()) {
      if (destinations.has(target.destination)) {
        context.addIssue({
          code: "custom",
          path: [index, "destination"],
          message: `duplicate interrogation destination ${String(target.destination)}`,
          input: target.destination,
        });
      }
      destinations.add(target.destination);
      expandedTargetCount += target.levels.length;
    }
    if (expandedTargetCount > MAX_ROUTER_COMMAND_TARGETS) {
      context.addIssue({
        code: "custom",
        message: `router interrogation exceeds ${String(MAX_ROUTER_COMMAND_TARGETS)} crosspoints`,
        input: targets,
      });
    }
  })
  .readonly();

export const InterrogateRouterTargetsRequestSchema = z
  .strictObject({
    requestId: RouterInterrogationRequestIdSchema,
    connectionId: ConnectionIdSchema,
    generation: RouterGenerationSchema,
    targets: InterrogateRouterTargetsSchema,
  })
  .readonly();

export const InterrogateRouterTargetsRejectionCodeSchema = z.enum([
  "connection_unavailable",
  "disabled",
  "disconnected",
  "not_synchronized",
  "stale_generation",
  "invalid_destination",
  "invalid_level",
  "duplicate_target",
  "capacity_exceeded",
]);

export const InterrogateRouterTargetsDispatchOutcomeSchema = z.enum([
  "acknowledged",
  "nak",
  "timeout",
  "not_attempted",
]);

export const InterrogateRouterTargetOutcomeSchema = z
  .strictObject({
    destination: RouterAddressSchema,
    level: RouterLevelSchema,
    outcome: InterrogateRouterTargetsDispatchOutcomeSchema,
  })
  .readonly();

const InterrogateRouterTargetOutcomesSchema = z
  .array(InterrogateRouterTargetOutcomeSchema)
  .min(1)
  .max(MAX_ROUTER_COMMAND_TARGETS)
  .superRefine((outcomes, context) => {
    rejectDuplicateCrosspoints(outcomes, context);
    validateFailFastOutcomes(outcomes, context, ["nak", "timeout"]);
  })
  .readonly();

export const InterrogateRouterTargetsAcknowledgedResultSchema = z
  .strictObject({
    status: z.literal("acknowledged"),
    requestId: RouterInterrogationRequestIdSchema,
    outcomes: InterrogateRouterTargetOutcomesSchema,
  })
  .superRefine((result, context) => {
    if (result.outcomes.some(({ outcome }) => outcome !== "acknowledged")) {
      context.addIssue({
        code: "custom",
        path: ["outcomes"],
        message:
          "acknowledged interrogation results may contain only acknowledged outcomes",
        input: result.outcomes,
      });
    }
  })
  .readonly();

export const InterrogateRouterTargetsPartialResultSchema = z
  .strictObject({
    status: z.literal("partial"),
    requestId: RouterInterrogationRequestIdSchema,
    outcomes: InterrogateRouterTargetOutcomesSchema,
  })
  .superRefine((result, context) => {
    if (result.outcomes.every(({ outcome }) => outcome === "acknowledged")) {
      context.addIssue({
        code: "custom",
        path: ["outcomes"],
        message:
          "partial interrogation results require at least one non-success outcome",
        input: result.outcomes,
      });
    }
  })
  .readonly();

export const InterrogateRouterTargetsRejectedResultSchema = z
  .strictObject({
    status: z.literal("rejected"),
    requestId: RouterInterrogationRequestIdSchema,
    code: InterrogateRouterTargetsRejectionCodeSchema,
    message: RendererSafeMessageSchema,
  })
  .readonly();

export const InterrogateRouterTargetsResultSchema = z
  .discriminatedUnion("status", [
    InterrogateRouterTargetsAcknowledgedResultSchema,
    InterrogateRouterTargetsPartialResultSchema,
    InterrogateRouterTargetsRejectedResultSchema,
  ])
  .readonly();

export const RouteCrosspointsExchangeSchema = z
  .strictObject({
    request: RouteCrosspointsRequestSchema,
    result: RouteCrosspointsResultSchema,
  })
  .superRefine((exchange, context) => {
    const result = exchange.result;
    if (exchange.request.operationId !== result.operationId) {
      context.addIssue({
        code: "custom",
        path: ["result", "operationId"],
        message: "Take result operationId must match its request",
        input: result.operationId,
      });
    }
    if (result.status === "rejected") return;
    const expectedTargets = exchange.request.mappings.flatMap((mapping) =>
      mapping.levels.map((level) => ({
        mappingId: mapping.mappingId,
        source: mapping.source,
        destination: mapping.destination,
        level,
      })),
    );
    if (
      expectedTargets.length !== result.outcomes.length ||
      expectedTargets.some((target, index) => {
        const outcome = result.outcomes[index];
        return (
          outcome === undefined ||
          outcome.mappingId !== target.mappingId ||
          outcome.source !== target.source ||
          outcome.destination !== target.destination ||
          outcome.level !== target.level
        );
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["result", "outcomes"],
        message:
          "Take result targets must exactly match request order and identity",
        input: result.outcomes,
      });
    }
  })
  .readonly();

export const InterrogateRouterTargetsExchangeSchema = z
  .strictObject({
    request: InterrogateRouterTargetsRequestSchema,
    result: InterrogateRouterTargetsResultSchema,
  })
  .superRefine((exchange, context) => {
    const result = exchange.result;
    if (exchange.request.requestId !== result.requestId) {
      context.addIssue({
        code: "custom",
        path: ["result", "requestId"],
        message: "interrogation result requestId must match its request",
        input: result.requestId,
      });
    }
    if (result.status === "rejected") return;
    const expectedTargets = exchange.request.targets.flatMap((target) =>
      target.levels.map((level) => ({
        destination: target.destination,
        level,
      })),
    );
    if (
      expectedTargets.length !== result.outcomes.length ||
      expectedTargets.some((target, index) => {
        const outcome = result.outcomes[index];
        return (
          outcome === undefined ||
          outcome.destination !== target.destination ||
          outcome.level !== target.level
        );
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["result", "outcomes"],
        message:
          "interrogation result targets must exactly match request order and identity",
        input: result.outcomes,
      });
    }
  })
  .readonly();

function validatePage(
  page: Readonly<{
    entries: readonly Readonly<{ address: number }>[];
    nextAfterAddress: number | null;
    totalCount: number;
  }>,
  context: z.core.$RefinementCtx,
): void {
  if (page.entries.length > page.totalCount) {
    context.addIssue({
      code: "custom",
      path: ["totalCount"],
      message: "router page totalCount cannot be smaller than its entries",
      input: page.totalCount,
    });
  }
  if (
    page.nextAfterAddress !== null &&
    page.nextAfterAddress !== page.entries.at(-1)?.address
  ) {
    context.addIssue({
      code: "custom",
      path: ["nextAfterAddress"],
      message: "router page cursor must equal the final entry address",
      input: page.nextAfterAddress,
    });
  }
  if (
    page.nextAfterAddress !== null &&
    page.totalCount <= page.entries.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["nextAfterAddress"],
      message: "a complete router page cannot advertise a continuation cursor",
      input: page.nextAfterAddress,
    });
  }
}

function validatePageExchange(
  query: Readonly<{
    version: Readonly<{ generation: string; revision: number }>;
    labelRevision: number;
    afterAddress: number | null;
    limit: number;
    search: string | null;
  }>,
  page: Readonly<{
    version: Readonly<{ generation: string; revision: number }>;
    labelRevision: number;
    entries: readonly Readonly<{ address: number; label: string | null }>[];
  }>,
  context: z.core.$RefinementCtx,
): void {
  if (!versionsEqual(query.version, page.version)) {
    context.addIssue({
      code: "custom",
      path: ["page", "version"],
      message: "router page version must match its query",
      input: page.version,
    });
  }
  if (query.labelRevision !== page.labelRevision) {
    context.addIssue({
      code: "custom",
      path: ["page", "labelRevision"],
      message: "router page label revision must match its query",
      input: page.labelRevision,
    });
  }
  if (page.entries.length > query.limit) {
    context.addIssue({
      code: "custom",
      path: ["page", "entries"],
      message: "router page contains more entries than its query requested",
      input: page.entries,
    });
  }
  for (const [index, entry] of page.entries.entries()) {
    if (query.afterAddress !== null && entry.address <= query.afterAddress) {
      context.addIssue({
        code: "custom",
        path: ["page", "entries", index, "address"],
        message: "router page entry must follow its keyset cursor",
        input: entry.address,
      });
    }
    if (!resourceMatchesSearch(entry.address, entry.label, query.search)) {
      context.addIssue({
        code: "custom",
        path: ["page", "entries", index],
        message: "router page entry does not match its search filter",
        input: entry,
      });
    }
  }
}

function validateBootstrap(
  bootstrap: Readonly<{
    version: z.infer<typeof RouterRouteVersionSchema>;
    labelRevision: number;
    transport: z.infer<typeof RouterTransportPhaseSchema>;
    sync: z.infer<typeof RouterSyncPhaseSchema>;
    levels: number;
    extended: boolean;
    wideAddresses?: boolean | undefined;
    knownSourceCount: number;
    knownDestinationCount: number;
    knownCrosspointCount: number;
    sources: z.infer<typeof RouterSourcePageSchema>;
    destinations: z.infer<typeof RouterDestinationPageSchema>;
  }>,
  context: z.core.$RefinementCtx,
): void {
  const modeAddressMaximum =
    (bootstrap.wideAddresses ?? bootstrap.extended)
      ? MAX_ROUTER_ADDRESS
      : MAX_STANDARD_ROUTER_ADDRESS;
  const modeLevelMaximum = bootstrap.extended
    ? MAX_ROUTER_LEVEL
    : MAX_STANDARD_ROUTER_LEVEL;

  if (!versionsEqual(bootstrap.sources.version, bootstrap.version)) {
    context.addIssue({
      code: "custom",
      path: ["sources", "version"],
      message: "source page version must match the bootstrap version",
      input: bootstrap.sources.version,
    });
  }
  if (!versionsEqual(bootstrap.destinations.version, bootstrap.version)) {
    context.addIssue({
      code: "custom",
      path: ["destinations", "version"],
      message: "destination page version must match the bootstrap version",
      input: bootstrap.destinations.version,
    });
  }
  if (bootstrap.sources.labelRevision !== bootstrap.labelRevision) {
    context.addIssue({
      code: "custom",
      path: ["sources", "labelRevision"],
      message:
        "source page label revision must match the bootstrap label revision",
      input: bootstrap.sources.labelRevision,
    });
  }
  if (bootstrap.destinations.labelRevision !== bootstrap.labelRevision) {
    context.addIssue({
      code: "custom",
      path: ["destinations", "labelRevision"],
      message:
        "destination page label revision must match the bootstrap label revision",
      input: bootstrap.destinations.labelRevision,
    });
  }
  if (bootstrap.sources.totalCount !== bootstrap.knownSourceCount) {
    context.addIssue({
      code: "custom",
      path: ["sources", "totalCount"],
      message: "bootstrap source total must match its known source count",
      input: bootstrap.sources.totalCount,
    });
  }
  if (bootstrap.destinations.totalCount !== bootstrap.knownDestinationCount) {
    context.addIssue({
      code: "custom",
      path: ["destinations", "totalCount"],
      message:
        "bootstrap destination total must match its known destination count",
      input: bootstrap.destinations.totalCount,
    });
  }
  validateFirstPageCursor(bootstrap.sources, context, ["sources"]);
  validateFirstPageCursor(bootstrap.destinations, context, ["destinations"]);

  if (bootstrap.levels > modeLevelMaximum) {
    context.addIssue({
      code: "custom",
      path: ["levels"],
      message: "configured Router levels exceed the selected protocol mode",
      input: bootstrap.levels,
    });
  }
  if (
    bootstrap.knownSourceCount > modeAddressMaximum ||
    bootstrap.knownDestinationCount > modeAddressMaximum
  ) {
    context.addIssue({
      code: "custom",
      path: ["knownSourceCount"],
      message: "known Router resource counts exceed the selected protocol mode",
      input: bootstrap.knownSourceCount,
    });
  }
  if (
    bootstrap.knownCrosspointCount >
    bootstrap.knownDestinationCount * bootstrap.levels
  ) {
    context.addIssue({
      code: "custom",
      path: ["knownCrosspointCount"],
      message:
        "known Router crosspoints exceed configured destination/level capacity",
      input: bootstrap.knownCrosspointCount,
    });
  }
  if (bootstrap.knownCrosspointCount > 0 && bootstrap.knownSourceCount === 0) {
    context.addIssue({
      code: "custom",
      path: ["knownSourceCount"],
      message: "known Router crosspoints require at least one known source",
      input: bootstrap.knownSourceCount,
    });
  }
  const visibleSources = new Set(
    bootstrap.sources.entries.map(({ address }) => address),
  );
  let visibleCrosspointCount = 0;
  for (const entry of bootstrap.destinations.entries) {
    visibleCrosspointCount += entry.routes.length;
    for (const route of entry.routes) visibleSources.add(route.source);
  }
  if (visibleSources.size > bootstrap.knownSourceCount) {
    context.addIssue({
      code: "custom",
      path: ["knownSourceCount"],
      message:
        "known source count cannot omit sources visible in bootstrap pages",
      input: bootstrap.knownSourceCount,
    });
  }
  if (visibleCrosspointCount > bootstrap.knownCrosspointCount) {
    context.addIssue({
      code: "custom",
      path: ["knownCrosspointCount"],
      message:
        "known crosspoint count cannot omit routes visible in bootstrap pages",
      input: bootstrap.knownCrosspointCount,
    });
  }
  if (
    bootstrap.destinations.nextAfterAddress === null &&
    visibleCrosspointCount !== bootstrap.knownCrosspointCount
  ) {
    context.addIssue({
      code: "custom",
      path: ["knownCrosspointCount"],
      message:
        "a complete bootstrap destination page must contain every known crosspoint",
      input: bootstrap.knownCrosspointCount,
    });
  }
  for (const [index, entry] of bootstrap.sources.entries.entries()) {
    if (entry.address > modeAddressMaximum) {
      context.addIssue({
        code: "custom",
        path: ["sources", "entries", index, "address"],
        message: "source address exceeds the selected protocol mode",
        input: entry.address,
      });
    }
  }
  for (const [entryIndex, entry] of bootstrap.destinations.entries.entries()) {
    if (entry.address > modeAddressMaximum) {
      context.addIssue({
        code: "custom",
        path: ["destinations", "entries", entryIndex, "address"],
        message: "destination address exceeds the selected protocol mode",
        input: entry.address,
      });
    }
    for (const [routeIndex, route] of entry.routes.entries()) {
      if (route.source > modeAddressMaximum) {
        context.addIssue({
          code: "custom",
          path: [
            "destinations",
            "entries",
            entryIndex,
            "routes",
            routeIndex,
            "source",
          ],
          message: "route source exceeds the selected protocol mode",
          input: route.source,
        });
      }
      if (route.level > bootstrap.levels) {
        context.addIssue({
          code: "custom",
          path: [
            "destinations",
            "entries",
            entryIndex,
            "routes",
            routeIndex,
            "level",
          ],
          message: "route level exceeds configured Router levels",
          input: route.level,
        });
      }
    }
  }
}

function validateFirstPageCursor(
  page: Readonly<{
    entries: readonly Readonly<{ address: number }>[];
    nextAfterAddress: number | null;
    totalCount: number;
  }>,
  context: z.core.$RefinementCtx,
  path: readonly (string | number)[],
): void {
  const expectedCursor =
    page.totalCount > page.entries.length ? page.entries.at(-1)?.address : null;
  if (
    expectedCursor === undefined ||
    page.nextAfterAddress !== expectedCursor
  ) {
    context.addIssue({
      code: "custom",
      path: [...path, "nextAfterAddress"],
      message:
        "bootstrap first-page cursor must reflect whether more entries exist",
      input: page.nextAfterAddress,
    });
  }
}

function rejectNonAscendingAddresses(
  entries: readonly Readonly<{ address: number }>[],
  context: z.core.$RefinementCtx,
): void {
  rejectNonAscendingNumbers(
    entries.map(({ address }) => address),
    context,
    [],
    "router page addresses",
  );
}

function rejectNonAscendingNumbers(
  values: readonly number[],
  context: z.core.$RefinementCtx,
  pathPrefix: readonly (string | number)[],
  label: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current <= previous
    ) {
      context.addIssue({
        code: "custom",
        path: [...pathPrefix, index],
        message: `${label} must be strictly ascending and unique`,
        input: current,
      });
    }
  }
}

function rejectDuplicateCrosspoints(
  crosspoints: readonly Readonly<{ destination: number; level: number }>[],
  context: z.core.$RefinementCtx,
): void {
  const targets = new Set<string>();
  for (const [index, crosspoint] of crosspoints.entries()) {
    const key = crosspointKey(crosspoint.destination, crosspoint.level);
    if (targets.has(key)) {
      context.addIssue({
        code: "custom",
        path: [index, "level"],
        message: `duplicate router target ${key}`,
        input: crosspoint.level,
      });
    }
    targets.add(key);
  }
}

function validateFailFastOutcomes(
  outcomes: readonly Readonly<{ outcome: string }>[],
  context: z.core.$RefinementCtx,
  terminalOutcomes: readonly string[],
): void {
  let dispatchStopped = false;
  for (const [index, target] of outcomes.entries()) {
    if (dispatchStopped && target.outcome !== "not_attempted") {
      context.addIssue({
        code: "custom",
        path: [index, "outcome"],
        message: "only not_attempted outcomes may follow a stopped dispatch",
        input: target.outcome,
      });
    }
    if (
      target.outcome === "not_attempted" ||
      terminalOutcomes.includes(target.outcome)
    ) {
      dispatchStopped = true;
    }
  }
}

function versionsEqual(
  left: Readonly<{ generation: string; revision: number }>,
  right: Readonly<{ generation: string; revision: number }>,
): boolean {
  return (
    left.generation === right.generation && left.revision === right.revision
  );
}

export function resourceMatchesSearch(
  address: number,
  label: string | null,
  search: string | null,
): boolean {
  if (search === null) return true;
  const normalizedSearch = search
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US");
  if (normalizedSearch === "") return true;
  return (
    String(address).includes(normalizedSearch) ||
    (label !== null &&
      label
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .includes(normalizedSearch))
  );
}

function crosspointKey(destination: number, level: number): string {
  return `${String(destination)}:${String(level)}`;
}

export type RouterGeneration = z.infer<typeof RouterGenerationSchema>;
export type RouterListenerId = z.infer<typeof RouterListenerIdSchema>;
export type RouterOperationId = z.infer<typeof RouterOperationIdSchema>;
export type RouterMappingId = z.infer<typeof RouterMappingIdSchema>;
export type RouterInterrogationRequestId = z.infer<
  typeof RouterInterrogationRequestIdSchema
>;
export type RouterAddress = z.infer<typeof RouterAddressSchema>;
export type RouterMatrix = z.infer<typeof RouterMatrixSchema>;
export type RouterLevel = z.infer<typeof RouterLevelSchema>;
export type RouterIntentCrosspoint = z.infer<
  typeof RouterIntentCrosspointSchema
>;
export type RouterLabel = z.infer<typeof RouterLabelSchema>;
export type RouterRouteVersion = z.infer<typeof RouterRouteVersionSchema>;
export type RouterTransportPhase = z.infer<typeof RouterTransportPhaseSchema>;
export type RouterSyncPhase = z.infer<typeof RouterSyncPhaseSchema>;
export type RouterLabelPhase = z.infer<typeof RouterLabelPhaseSchema>;
export type RouterReadStamp = z.infer<typeof RouterReadStampSchema>;
export type RouterSourcePageQuery = z.infer<typeof RouterSourcePageQuerySchema>;
export type RouterDestinationPageQuery = z.infer<
  typeof RouterDestinationPageQuerySchema
>;
export type RouterResourcePageQuery = z.infer<
  typeof RouterResourcePageQuerySchema
>;
export type RouterSourceEntry = z.infer<typeof RouterSourceEntrySchema>;
export type RouterDestinationRoute = z.infer<
  typeof RouterDestinationRouteSchema
>;
export type RouterDestinationEntry = z.infer<
  typeof RouterDestinationEntrySchema
>;
export type RouterSourcePage = z.infer<typeof RouterSourcePageSchema>;
export type RouterDestinationPage = z.infer<typeof RouterDestinationPageSchema>;
export type RouterResourcePage = z.infer<typeof RouterResourcePageSchema>;
export type RouterSourcePageExchange = z.infer<
  typeof RouterSourcePageExchangeSchema
>;
export type RouterDestinationPageExchange = z.infer<
  typeof RouterDestinationPageExchangeSchema
>;
export type RouterResourcePageExchange = z.infer<
  typeof RouterResourcePageExchangeSchema
>;
export type RouterCrosspoint = z.infer<typeof RouterCrosspointSchema>;
export type RouterCrosspointDelta = z.infer<typeof RouterCrosspointDeltaSchema>;
export type RouterStateEvent = z.infer<typeof RouterStateEventSchema>;
export type SequencedRouterStateEvent = z.infer<
  typeof SequencedRouterStateEventSchema
>;
export type RouterSessionBootstrap = z.infer<
  typeof RouterSessionBootstrapSchema
>;
export type RouteCrosspointsMapping = z.infer<
  typeof RouteCrosspointsMappingSchema
>;
export type RouteCrosspointsRequest = z.infer<
  typeof RouteCrosspointsRequestSchema
>;
export type RouteCrosspointsResult = z.infer<
  typeof RouteCrosspointsResultSchema
>;
export type RouteCrosspointsExchange = z.infer<
  typeof RouteCrosspointsExchangeSchema
>;
export type InterrogateRouterTarget = z.infer<
  typeof InterrogateRouterTargetSchema
>;
export type InterrogateRouterTargetsRequest = z.infer<
  typeof InterrogateRouterTargetsRequestSchema
>;
export type InterrogateRouterTargetsResult = z.infer<
  typeof InterrogateRouterTargetsResultSchema
>;
export type InterrogateRouterTargetsExchange = z.infer<
  typeof InterrogateRouterTargetsExchangeSchema
>;

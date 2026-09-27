/**
 * Tripwire: with `skipLibCheck`, an unresolved `@getpaseo/client` silently turns
 * every Paseo API type into `any`. This member access must stay an error.
 */
import type { PaseoAgentHandle } from "@getpaseo/client";

// @ts-expect-error - If this stops erroring, SDK types degraded to `any`.
export type SdkTypesResolved = PaseoAgentHandle["thisMemberDoesNotExist"];

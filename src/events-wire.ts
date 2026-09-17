// events-wire.ts — the `/api/events` frame and its `ps`/`info` bodies AS THEY ARRIVE, typed from the fork's own schema.
//
// `src/proto/events.gen.ts` is generated from `src/proto/events.proto` (pinned; see scripts/gen-proto.mjs), so every
// field name and type below is the server's, not a second copy of it written by hand. What the generated interfaces
// describe is protobuf's view: an implicit-presence field is REQUIRED there, because protobuf fills in its zero. JSON
// off the wire does not: the encoder omits that field when it is zero, and nothing here fills it in, because frames are
// kept verbatim (load records copy them, `ml.__events()` dumps them, the relay hands them on). So a raw value is read
// through `Wire<T>`: every key may be absent, and may be `null` (`backfilled` is null on every frame but a hello, and
// `details.families` is a null slice). The names and types are still checked, which is what catches a field renamed
// or re-typed upstream.
//
// PRESENCE, which `Wire` cannot show and every reader must still get right (events.proto, "PRESENCE"): a field the
// schema marks `optional` is written whenever the server has something to say, zero included, so ABSENT means "not
// reported" (`activity`, `context_length`, `memory.kv_cache`, `slots_busy`). Every other field is omitted at zero, so
// absent means "zero, or not measured". The generated interface tells the two apart: `field?:` is the first kind.
import type * as Gen from "./proto/events.gen";

export type * from "./proto/events.gen";

/** A value as `JSON.parse` hands it over: every key optional, any value possibly null, all the way down. */
export type Wire<T> = T extends readonly (infer U)[] ? Wire<U>[]
    : T extends object ? { [K in keyof T]?: Wire<NonNullable<T[K]>> | null }
    : T;

/** Every `kind` the schema's contract list names. Kinds are added without a version bump, so a frame's `kind` is typed
 *  as this union OR any string, and a reader switches on the ones it knows and ignores the rest. */
export type FrameKind =
    | "hello" | "heartbeat" | "sample" | "estimate"
    | "load.start" | "load.weights" | "load.complete" | "load.failed"
    | "evict" | "unload" | "expires"
    | "busy.start" | "busy.end" | "gen.start" | "gen.end"
    | "lease.start" | "lease.granted" | "lease.end";

/** One line of `/api/events` as sent, after `parseFrame` has guaranteed `kind` is a string and `t` a number. */
export type WireFrame = Wire<Gen.EventFrame> & { kind: FrameKind | (string & {}); t: number };

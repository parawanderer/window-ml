// approval-descriptor.types.ts — a TYPE test, run by the project's own `tsc --noEmit`: a pending approval a policy may
// decide (consumer `fetch` or `sh`) cannot be built without its facts' `effects`.
//
// `rejudgePending` (sw-consent.ts) judges a showing card again when a policy changes, and skips one whose facts lack
// `effects`, leaving it to the person: such a card silently misses every policy change. The ruling on #719 makes that
// a type error at the place the card is built, for the descriptor and for a nested ask's request (sw-asks.ts). The
// runtime half (a card without effects still waits) is in tests/nested-asks.test.mjs.
import type { PendingApprovalDescriptor } from "../../src/sw/sw-consent";
import type { AskRequest } from "../../src/sw/sw-asks";

const base = { key: "r:1", runId: "r", seq: 1, step: 1, tool: "fetch_url", arguments: {}, ts: 0, routing: "ui" as const };

// A judged consumer with its effects, and a gate no policy decides: both fine.
const fetchOk: PendingApprovalDescriptor = { ...base, consumer: "fetch", facts: { url: "https://a.example/", effects: [] } };
const shOk: PendingApprovalDescriptor = { ...base, consumer: "sh", facts: { argv: ["ls"], effects: "unknown" }, placement: "host-sandbox" };
const plain: PendingApprovalDescriptor = { ...base };
const shown: PendingApprovalDescriptor = { ...base, facts: { anything: 1 } };
void [fetchOk, shOk, plain, shown];

// @ts-expect-error a fetch card's facts must carry `effects`, or no policy change ever reaches it
const fetchNoEffects: PendingApprovalDescriptor = { ...base, consumer: "fetch", facts: { url: "https://a.example/" } };
// @ts-expect-error an sh card names its facts
const shNoFacts: PendingApprovalDescriptor = { ...base, consumer: "sh" };
// @ts-expect-error only the policy store's consumers name one
const otherConsumer: PendingApprovalDescriptor = { ...base, consumer: "mail", facts: { effects: [] } };
void [fetchNoEffects, shNoFacts, otherConsumer];

// The same rule for a nested ask, which builds its descriptor from the request.
const askOk: AskRequest = { kind: "sh", consumer: "sh", facts: { argv: ["ls"], effects: [] }, placement: "host-sandbox" };
const askShown: AskRequest = { kind: "wire", facts: { member: "chat" } };
void [askOk, askShown];
// @ts-expect-error an sh ask judged by the policy store must carry `effects`
const askNoEffects: AskRequest = { kind: "sh", consumer: "sh", facts: { argv: ["ls"] } };
void askNoEffects;

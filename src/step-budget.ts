// step-budget.ts — how many steps an agent run may take, as the numbers a PERSON is offered and the ceiling a
// worker enforces.
//
// Its own module, with no imports, for two reasons. It is read from both sides of the wire — the surfaces that
// offer a budget and the worker that honours one — and it deliberately stays out of `contract-agent.ts`, whose
// JSDoc is lifted verbatim into the API reference the MODEL reads: a list of buttons a human is shown is context
// the model pays for and cannot use.

/** The most steps a CONTINUE may ask for. A person choosing a budget is trusted with a large one, but the number
 *  crosses a hub and a page boundary before a worker acts on it, so it is bounded where it is read rather than
 *  where it is offered — a UI can only ever offer less. */
export const MAX_CONTINUE_STEPS = 200;

/** The step budgets a person is OFFERED, in the Commander's composer and on a capped run's Continue. Both surfaces
 *  read this one list so a budget you can start a run with is a budget you can carry one on with. */
export const STEP_BUDGETS = [10, 20, 50];

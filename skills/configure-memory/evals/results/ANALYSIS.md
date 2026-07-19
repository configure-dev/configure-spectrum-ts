# Eval analysis — baseline-v1 vs v2 (2026-07-18)

## Numbers

| Run | should-fire (tool-call metric) | should-fire (outcome metric) | should-not-fire clean |
|---|---|---|---|
| baseline-v1 | 70% | n/a | 100% |
| v2 (skill + hook installed) | 70% | **100%** | **100%** |

## What changed

- v1 misses were the convention-default class: `scaffold`, `pkg-manager`, `commit-style` never touched the profile. v2 fixed all of them.
- v2's three "misses" (`remember`, `commit-style`, `save-all`) had zero tool calls but fully profile-informed replies: the SessionStart digest had already injected the facts, so the model correctly skipped redundant calls ("already saved in your Configure profile", commit written in the user's conventional-commits style). The tool-call metric penalizes the success case of injection.
- Fix: scenarios now carry an `outcome` regex; a should-fire passes when the reply is visibly profile-informed even without a call. Raw call counts are still recorded.

## Lessons for the next eval round

1. **The profile is stateful across runs.** The baseline's `remember` scenario genuinely saved a fact, which changed v2's world. Real evals need a fixture profile (dedicated test user) or teardown between runs.
2. **Eval sessions write real memories.** One eval-written fact was found in the agent namespace afterward and deleted (`configure_profile_forget`, reason correction). Runner should tag or auto-clean its writes.
3. **Outcome grading beats call counting** once deterministic injection exists. Next iteration: LLM-judge grading of personalization correctness + a privacy-leak grader (no non-coding personal facts in replies) + a pollution grader (saved facts pass the routing rule).
4. Over-searching observed (up to 5 search calls in one scenario); consider a "search at most twice per question" line in the skill if it persists in dogfooding.

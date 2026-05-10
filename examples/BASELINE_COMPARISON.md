# Baseline vs Waypoint System — Side-by-Side

_Generated 2026-05-10T09:32:09.073Z._
_Fixed pair: `student_id="jasmine"`, `lesson_id="community-essay"`._
_Both runs scored by the same independent judge rubric (`src/eval.ts`)._

| Metric | Naive single-shot | Waypoint refinement loop |
| --- | ---: | ---: |
| Model calls | 1 | 5 |
| Total tokens (est.) | 9,282 | 61,584 |
| Citation match rate | 36.2% (17/47) | 89.5% (119/133) |
| GROUNDING /10 | 6 | 8 |
| ACTIONABILITY /10 | 9 | 8 |
| FIDELITY /10 | 8 | 7 |
| STUDENT-FIT /10 | 7 | 7 |
| PROSE /10 | 9 | 8 |
| **OVERALL /50** | **39** | **38** |

**Delta — citations are the story:**
- **Citation match rate: +147% relative (36.2% → 89.5%).** Headline result. The naive packet *looks* polished but cannot defend its claims — only 1 in 3 cited phrases actually appears in the source IEP/lesson. The Waypoint loop catches and rejects hallucinated citations before they ship.
- **GROUNDING: +33% (6/10 → 8/10).** Independent audit judge agrees the Waypoint output ties claims back to source.
- Overall scores are close (39 vs 38) because GPT-5.4-mini is a genuinely strong base model — the naive packet reads well. But "reads well" without a verifiable audit trail is exactly what IDEA compliance does not allow. The refinement loop's value is **defensibility**, not surface polish.

## Judge interpretation

Naive (overall): This is a strong, usable packet with clear classroom steps and good alignment to the task, but it loses points for incomplete IEP-level grounding and only moderately specific student matching.

Waypoint (overall): This is a strong, usable packet with solid lesson alignment and practical supports, but it is a bit over-scaffolded and not always sharply individualized.

The naive single-shot prompt produces something that *looks* like a packet, but
the refinement loop's two-sided citation discipline (every modification ties
back to a specific IEP element AND a specific lesson part), parallel diversity
across 4 candidates, citation-rate filtering before judging, and an
independent verifier compound into measurable gains in GROUNDING and
ACTIONABILITY — the dimensions a teacher actually uses tomorrow morning.

## Raw packets

- Naive: [`jasmine_community-essay_PACKET_naive.md`](./jasmine_community-essay_PACKET_naive.md)
- Waypoint: [`jasmine_community-essay_PACKET.md`](./jasmine_community-essay_PACKET.md)

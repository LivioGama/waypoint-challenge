# A/B Comparison — Tool-Augmented vs Full-Context

_Generated 2026-05-10T09:33:22.934Z by `bun run ab-compare`. Judge: openai:gpt-5.4-mini._

| | |
| --- | --- |
| Student | jasmine |
| Lesson | community-essay |
| Run A | Tool-augmented (`USE_TOOL_AUGMENTED=true`): candidates pull IEP sections + lesson excerpts via tool calls mid-draft. |
| Run B | Full-context (`USE_TOOL_AUGMENTED=false`): full IEP JSON + full lesson text dumped into the candidate prompt. |

## Headline metrics

| Metric | Tool-augmented (A) | Full-context (B) |
| --- | ---: | ---: |
| Total model calls (iterations) | 5 | 5 |
| Winner candidate | #1 | #0 |
| Citation match rate (winner) | 84.8% (112/132) | 81.1% (103/127) |
| Audit overall | **42/50** | **41/50** |

## Per-dimension audit (1–10)

| Dimension | Tool-augmented (A) | Full-context (B) |
| --- | ---: | ---: |
| Grounding | 9/10 | 8/10 |
| Actionability | 8/10 | 9/10 |
| Fidelity | 8/10 | 8/10 |
| Student-Fit | 9/10 | 7/10 |
| Prose | 8/10 | 9/10 |
| **Overall** | **42/50** | **41/50** |

## Citation verification breakdown

| Kind | Tool-augmented (matched/total) | Full-context (matched/total) |
| --- | ---: | ---: |
| quote | 59/79 | 58/80 |
| paragraph | 48/48 | 42/44 |
| mcq | 5/5 | 3/3 |

## Judge note

Tool-augmented run: This is a strong, usable packet with good student-specific alignment and lesson fidelity, but it loses a little polish and tight grounding in a few spots.

Full-context run: This is a strong, usable packet with good lesson fidelity and execution detail, but the grounding is not always perfectly exact and the student-specific tailoring could be sharper.

**Overall winner by audit score:** Tool-augmented.

## Per-dimension reasoning

### Tool-augmented (A)
- **Grounding (9/10):** Most modifications name both a specific Jasmine IEP element and a specific lesson segment, with only minor places where the match is a little indirect or repeated.
- **Actionability (8/10):** A new gen-ed teacher could use this tomorrow with materials and scripts provided, though a few scaffolds assume easy access to printed or projected copies and light prep.
- **Fidelity (8/10):** The packet keeps RI.7.2 and the original question demands intact, but a few supports make the response path more guided than the grade-level task without fully reducing rigor.
- **Student-Fit (9/10):** It is clearly tailored to Jasmine’s stated profile, especially her whole-group preference, vocabulary and inference needs, frustration/avoidance pattern, and self-regulation goals.
- **Prose (8/10):** The language is mostly plain and teacher-friendly, but some sections still read like packet boilerplate with repeated labels, scaffold language, and a few slightly clunky phrases.

### Full-context (B)
- **Grounding (8/10):** Most modifications name both a relevant IEP goal or present level and a specific lesson segment, though a few citations are broader than the exact tweak they support.
- **Actionability (9/10):** A new gen-ed teacher could run this tomorrow because the packet gives exact scripts, materials, timing, and task wording with minimal setup.
- **Fidelity (8/10):** The packet keeps the RI.7.2/RI.6/RI.1/RI.4 targets intact and still asks for evidence, central idea, and analysis, though some scaffolds reduce demand slightly.
- **Student-Fit (7/10):** It matches Jasmine reasonably well by addressing self-regulation, language processing, peer talk, and need for check-ins, but it still reads partly like a generalized support template.
- **Prose (9/10):** The language is clear, direct, and teacher-facing overall, with only occasional formulaic or slightly over-structured phrasing.

## Packets

- Tool-augmented winner: [./jasmine_community-essay_AB_TOOL-AUGMENTED.md](./jasmine_community-essay_AB_TOOL-AUGMENTED.md)
- Full-context winner: [./jasmine_community-essay_AB_FULL-CONTEXT.md](./jasmine_community-essay_AB_FULL-CONTEXT.md)

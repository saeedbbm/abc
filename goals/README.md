# Goals Package

This folder is the judge-facing goal package for KB2.

Files in this folder are meant to help an evaluation layer answer:

- What is the pipeline trying to achieve overall?
- What is each step responsible for locally?
- What should count as a true local failure for that step?
- When is it safe to continue to downstream steps?

## Structure

- `goal.txt`
  - Overall product goal and end-to-end success criteria.
- `steps/pass1-step-XX.yaml`
  - General-purpose step goals for Pass 1 steps 1 through 18.
- `../benchmarks/<benchmark-slug>/global.md`
  - Benchmark-only overlay guidance for a specific dataset.
- `../benchmarks/<benchmark-slug>/steps/pass1-step-XX.yaml`
  - Per-step benchmark-specific evaluation guidance.

## How To Use These Files

For a normal quality judge:

1. Read `goal.txt`.
2. Read the matching step file in `steps/`.
3. Inspect the step artifact.
4. Inspect sampled real outputs when needed:
   - documents/chunks
   - nodes
   - edges
   - pages
   - claims
   - verify cards
5. Judge the step on its own responsibility, not on missing work that clearly belongs to an earlier step.

For a benchmark judge:

1. Read `goal.txt`.
2. Read the matching step file in `steps/`.
3. Read the benchmark overlay in `benchmarks/<benchmark-slug>/` when one exists.
4. Read benchmark-only files such as `ground-truth/` outside this folder.
5. Keep benchmark evaluation separate from general pipeline quality.
6. End the judge output with `go_no_go`, concrete blockers, and `rerun_from_step`.

## Anti-Cheating Rule

These files are for judging and planning quality, not for teaching the pipeline the answer key.

They should not cause implementation code or prompts to:

- hard-code entity names, people names, or expected convention names
- hard-code exact benchmark counts into pipeline logic
- overfit thresholds to one dataset
- compensate downstream for upstream truth failures

## Design Principle

Step goals should be general.
Benchmark expectations should stay separate.

That lets the judge be smarter without leaking benchmark answers into the pipeline itself.

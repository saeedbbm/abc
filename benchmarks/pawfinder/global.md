## PawFinder Benchmark Overlay

This overlay is evaluation-only. It exists to help the judge score benchmark fit without changing the general pipeline contract.

### End-to-End Benchmark Focus

- The pipeline should discover real undocumented projects, real proposed features, and hidden conventions from scattered evidence.
- The most important proposed feature is `Toy Donation Feature`, synthesized from multiple customer feedback submissions.
- The most important synthesized conventions are:
  - Kim's color convention
  - Tim's layout convention
  - Matt's client-side browse pattern
- The graph should support downstream traversal like:
  - `Toy Donation Feature -> convention -> owner -> evidence`

### Judge Priorities

- Prefer content fit over prettier counts.
- Reward high evidence recall only when canonical nodes are still the right unit of work.
- Penalize wrong-unit project inflation even if recall looks high.
- Penalize benchmark-critical misses more than cosmetic issues.
- Distinguish general step quality from benchmark miss:
  - a step can be structurally clean but still fail the PawFinder benchmark

### Known Benchmark Watchouts

- These are not full projects and should usually hurt benchmark fit if promoted as projects:
  - `Update about page copy`
  - `2026 roadmap planning`
  - `bug fixes`
  - `maintenance`
  - `postmortems`
  - `onboarding docs`
- Smaller totals are not automatically better if they erase Kim/Tim/Matt signal.
- Discovery quality matters more than discovery volume.
- Convention quality matters more than convention count, but Kim/Tim/Matt are benchmark-critical.

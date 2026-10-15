# Lane 3 result, root B: the corpus count

Session `repl-lane3` (Claude Code, `claude-opus-5-5`, session `834c05ec-8bfd-46af-9296-ab7f2cb1e06a`), 2026-10-15. Landed
in the same PR as root G. Every figure here is computed in
[`notebooks/python-dialect/corpus-count.ipynb`](../../../notebooks/python-dialect/corpus-count.ipynb); read the numbers
there, not here.

## What the acceptance test showed

The node whitelist and the first manifests' method lists exist as data, in `notebooks/python-dialect/data/`:
`whitelist.json`, `node-counts.json`, `method-counts.json`, `manifest-pandas.json`, `manifest-numpy.json`,
`manifest-stdlib.json` and `manifest-pil.json`.

- **The corpus:** 1,714 unique cells (2,418 occurrences) from 18 models.
  - Sources: bench sweeps 1,607 unique cells, e2e artifacts 58, `tmp/` run exports 55, and the bench store 103 (runs no
    clone still holds).
  - Of the store's 2,514 traces, 98 were not already found locally.
  - `artifacts/bench-pool/` holds no runs.
  - 17 cells do not parse, and are left out.
- **Admitted whole, over unique cells:**

  | Whitelist | Admitted | With the gate's static half |
  | --- | --- | --- |
  | Starlark set | 89.4% | 86.0% |
  | **Ruled set** (Starlark plus a generator expression in consumer position) | **98.4%** | **93.6%** before `csv` and `PIL` were admitted; **94.5%** after |
  | Any generator expression, for comparison | 99.1% | 95.1% |

  The gate's static half means: no dunders, no refused builtin, and every import or prelude name in the module list.
- **Generator expressions** are the only construct that mattered: 177 in 172 cells.
  - 164 are in consumer position, none of them with keyword arguments beside them.
  - 13 are elsewhere, one per cell, and the ruled set refuses those cells.
- **`while` and `class`** appear in no cell, which confirms that refusing them statically costs nothing.
- **The top refusers under the static gate**, after the rulings:

  | Refuser | Cells |
  | --- | --- |
  | `scipy` | 12 |
  | `urllib` | 11 |
  | `sys` | 10 |
  | a `.__name__` read | 5 |
  | `os` | 4 |
  | `secrets` | 4 |
  | `sympy` | 4 |

  Before the rulings, `type()` (40 cells), `csv` and `PIL` led this list.

## Rulings it led to

From `repl-specs`, 2026-10-15, recorded in session-mail
`20261015-1201Z-repl-specs-to-repl-lane3-genexp-type-columns-rulings.md` and in `PYTHON_DIALECT.md`:

- **Generator expressions:** rewritten to list comprehensions only as the sole POSITIONAL argument of a listed consumer
  (`sum`, `any`, `all`, `min`, `max`, `sorted`, `list`, `tuple`, `set`, `dict`, `enumerate`, `zip`, `str.join`).
  Keyword arguments beside one are allowed; a generator expression anywhere else is refused.
- **`while` and `class`:** the static refusal stays.
- **`type()`:** one-argument `type(x)` is its own receiver kind with no attributes. It is not callable, and supports
  `is`, `==` and `repr` only. Any other form of `type()` is refused.
- **DataFrame columns:** the kind has a `dynamic: columns` rule. The predicate is ours, it returns `alias(0)`, and it
  never admits a dunder or a static method name.
- **`decimal`, `csv` and `PIL`** come in as manifest LEAVES, not as bare imports. `urllib` and `sys` stay out.

## What did not work, or was left out

- **The extract holds per-cell FEATURES (node counts, names), never cell text.** The repo is public, and `tmp/` holds
  exports of real browsing. As a result, a new feature needs `NB_REFRESH=1` and access to the clones.
- **Methods are matched to receiver kinds by name only.** A `.sum` call counts for DataFrame, Series, GroupBy and ndarray
  alike, because the AST cannot tell receivers apart.
  - PIL is matched only within the 10 cells that reach PIL. By name alone, every `str.split` was taken for `Image.split`.
- **The corpus is 94% bench**, so it weights the bench's tasks. Every fraction is also given over occurrences.
- **Effects, return marking and cost shapes** are filled in for the ruled leaves only (`decimal.Decimal`, `csv.*`,
  `Image.open`, `Image.save`). The rest is the second pass, after H.

## Assumptions where a spec was silent

- **The first allow lists are my guess**, written as `MODULES` and `REFUSED_BUILTINS` in the generator.
  - `io` and `base64` are admitted for their in-memory parts only.
  - `getattr` and `hasattr` are not refused statically, because the gate in `PyObject_GetAttr` covers them.
- **A module the prelude binds** (`pd`, `np`, `io`, `sys`, `Image`, …) and a cell uses without importing counts as an
  import of that module.
- **`Image.open` and `Image.save` are effects on the buffer they are given**, so they are allowed only over an owned
  `BytesIO`, never a path.

## What a spec got wrong

- **`PYTHON_DIALECT.md` said "no generators"** without separating the generator object, which is a suspended frame,
  from a generator expression handed straight to a consumer. Refusing both would cost about 9% of cells. Now ruled.
- **The spec listed `type(x)` among the adversarial cases**, but it is 2.4% of honest cells, mostly debugging prints.
  Now ruled.
- **Column attribute access (`df.Region`) was not addressed.** Under a static per-kind allow list it would be refused.
  Now ruled.

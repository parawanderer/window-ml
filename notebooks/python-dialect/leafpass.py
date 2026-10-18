# leafpass.py — the manifests' second pass: effects, return marking and cost shape per leaf.
"""The second pass the manifests' `note` names (docs/spec/READONLY_LIBRARY_MANIFEST.md, "Format").

One row per leaf, keyed the way a cell writes the name:

  `<module>.<function>`   `numpy.where`, `pandas.api.types.is_numeric_dtype`, `io.BytesIO`, `re.compile`
  `<Kind>.<method>`       `ndarray.astype`, `DataFrame.head`, `str.contains`, `Image.save`, `Decimal.max`
  `PIL.<function>`        `PIL.Image.open` (the key the first pass already wrote)

`bucket(key)` says which `data/manifest-*.json` a row belongs to. Every name a manifest lists under `functions`,
`kinds` or `modules` has a row here (tests/test_manifest_pass2 checks it, enumerated, not sampled).

## The marking rule (the coordinator's soundness rule, 2026-10-18)

`returns` is `fresh` ONLY when every path allocates buffers that alias no argument, so the result can safely enter
owned. Anything that can return a view sharing memory with an unowned input — `.values`, `.to_numpy()`, `.T`,
`ravel()`, `asarray()`, basic slicing, a `Series`/`DataFrame` column view, a kept-column transform under
copy-on-write — is `alias(i)` (of the argument whose memory it may share) or `internal` (of state the call
holds), never `fresh`. The hole being closed: a `fresh` result's `.values` inherits ownership, and a write through
that numpy view would mutate the unowned source's buffer.

A method with `inplace=` (or any in-place mutation) carries `mutates(0)` and returns `None` in that branch. The
conditioned forms (`fresh; alias(0) when copy=False`, `None when inplace; alias(0) otherwise`) name both branches;
the interpreter judges the branch it is in.

`effects` is `pure`, `mutates(i)`, `cache`, `read(buffer arg)`, `write(buffer arg)`, `reads-external (…)`
or `external (…)`. `cost` is a SHAPE in size measures, never a constant and never a content read: `O(1)`, `size`,
`cells`, `rows`, `chars`, `n log n in rows`, `n log n in size`, `input length`, `digits`, `pixels`.

Aliasing calls that were measured rather than assumed (pandas 3.0.6 / numpy 2.5.3 / Pillow 12.3.0, the versions the
notebook counts against) are the ones the rule cannot settle by shape alone: `Image.fromarray` wraps the array's
buffer for some dtypes (`L`, `RGBA`) and copies for others (`RGB`); `Series.get` aliases the element under dtype
`object`; `sort_values`, `rename`, `reset_index`, `select_dtypes`, `drop(columns=…)` and `assign` share column
buffers under copy-on-write; `head`/`drop(index=…)`/`dropna`/`fillna`/`replace`/`astype`/`copy` do not in this
version but are still marked on the safe side where the API is a slice or may no-op.
"""

from __future__ import annotations

from typing import Any

# The one table. A row is the manifest's `leaves` entry: effects, returns, cost, and a one-clause `why`
# (plus `over` where a call takes a buffer the cell must own).
LEAVES: dict[str, dict[str, Any]] = {
    # --- numpy: module-level ---
    "numpy.abs": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new array of absolute values"},
    "numpy.any": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new bool, from a pass over the input"},
    "numpy.argwhere": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new index array"},
    "numpy.array": {"effects": "pure", "returns": "fresh; alias(0) when copy=False", "cost": "size",
                    "why": "copies by default; copy=False returns the input itself"},
    "numpy.mean": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new float, from a pass over the input"},
    "numpy.sum": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new scalar, from a pass over the input"},
    "numpy.where": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new array selected from the two inputs"},
    # --- numpy: ndarray methods ---
    "ndarray.any": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new bool"},
    "ndarray.astype": {"effects": "pure", "returns": "fresh; alias(0) when copy=False", "cost": "size",
                       "why": "a converted copy; copy=False returns self when the dtype already matches"},
    "ndarray.copy": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "an unconditional copy"},
    "ndarray.max": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new scalar"},
    "ndarray.mean": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new scalar"},
    "ndarray.round": {"effects": "pure; mutates(the out argument) when out= is given",
                      "returns": "fresh; alias(the out argument) when out= is given", "cost": "size",
                      "why": "a new rounded array, or the out array written in place"},
    "ndarray.sum": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new scalar"},
    "ndarray.tolist": {"effects": "pure", "returns": "fresh", "cost": "size",
                       "why": "a new list; object-dtype items alias the receiver's contents, and writes to those items are refused unless they are owned"},

    # --- pandas: module-level ---
    "pandas.DataFrame": {"effects": "pure", "returns": "fresh; alias(0) when copy=False", "cost": "cells",
                         "why": "a new frame from the data it is given; copy=False can share the input's buffers"},
    "pandas.api.types.is_numeric_dtype": {"effects": "pure", "returns": "fresh", "cost": "O(1)",
                                         "why": "a new bool from a dtype test"},
    "pandas.compat.StringIO": {"effects": "pure", "returns": "fresh", "cost": "input length",
                               "why": "a fresh writable buffer; its contents are its own"},
    "pandas.concat": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new object stacked from the inputs"},
    "pandas.io.common.StringIO": {"effects": "pure", "returns": "fresh", "cost": "input length",
                                  "why": "a fresh writable buffer; its contents are its own"},
    "pandas.read_csv": {"effects": "read(buffer arg)", "returns": "fresh", "cost": "input length",
                        "over": "an in-memory buffer the cell owns (a StringIO or BytesIO), never a path",
                        "why": "parses a buffer into a new frame"},
    "pandas.read_html": {"effects": "read(buffer arg)", "returns": "fresh", "cost": "input length",
                         "over": "an in-memory buffer the cell owns (a StringIO or BytesIO), never a path",
                         "why": "parses a buffer into new frames"},
    "pandas.to_numeric": {"effects": "pure", "returns": "fresh", "cost": "size",
                          "why": "a new numeric Series (measured: not the input, and it does not share, even when already numeric)"},

    # --- pandas.DataFrame ---
    "DataFrame.any": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new Series of per-column reductions"},
    "DataFrame.apply": {"effects": "pure", "returns": "fresh", "cost": "rows", "why": "a new object assembled from the callback's per-row results"},
    "DataFrame.assign": {"effects": "pure", "returns": "alias(0)", "cost": "cells",
                         "why": "the kept columns' buffers can be the receiver's under copy-on-write; only the new column is allocated"},
    "DataFrame.astype": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new frame of converted columns"},
    "DataFrame.copy": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "an unconditional copy"},
    "DataFrame.drop": {"effects": "pure; mutates(0) when inplace", "returns": "None when inplace; alias(0) otherwise", "cost": "cells",
                       "why": "a row or column subset of the receiver; kept buffers can be the receiver's"},
    "DataFrame.dropna": {"effects": "pure; mutates(0) when inplace", "returns": "None when inplace; alias(0) otherwise", "cost": "cells",
                         "why": "a row subset of the receiver (basic slicing)"},
    "DataFrame.eq": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new boolean frame"},
    "DataFrame.fillna": {"effects": "pure; mutates(0) when inplace", "returns": "None when inplace; alias(0) otherwise", "cost": "cells",
                         "why": "may no-op-share when there is nothing to fill; otherwise copies the filled columns and can share the rest"},
    "DataFrame.get": {"effects": "pure", "returns": "alias(0)", "cost": "O(1)", "why": "a column view of the receiver"},
    "DataFrame.groupby": {"effects": "pure", "returns": "alias(0)", "cost": "rows", "why": "the GroupBy holds the receiver"},
    "DataFrame.head": {"effects": "pure", "returns": "alias(0)", "cost": "rows", "why": "row slicing: the result can share the receiver's buffers"},
    "DataFrame.idxmax": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new Series of labels"},
    "DataFrame.index": {"effects": "pure", "returns": "alias(0)", "cost": "O(1)", "why": "the receiver's Index object, whose values are a view of the receiver's"},
    "DataFrame.info": {"effects": "external (writes stdout)", "returns": "None", "cost": "rows",
                       "why": "writes a summary to stdout; kept out of the dialect"},
    "DataFrame.isin": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new boolean frame"},
    "DataFrame.isna": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new boolean frame"},
    "DataFrame.isnull": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new boolean frame"},
    "DataFrame.items": {"effects": "pure", "returns": "internal", "cost": "cells",
                        "why": "a generator of (label, column view) pairs; the columns alias the receiver"},
    "DataFrame.join": {"effects": "pure", "returns": "alias(0)", "cost": "cells",
                       "why": "the left columns' buffers can be the receiver's under copy-on-write; the right columns are allocated"},
    "DataFrame.keys": {"effects": "pure", "returns": "alias(0)", "cost": "O(1)", "why": "the receiver's column Index"},
    "DataFrame.map": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new frame of the callback's per-element results"},
    "DataFrame.max": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new Series of per-column reductions"},
    "DataFrame.mean": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new Series of per-column reductions"},
    "DataFrame.notna": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new boolean frame"},
    "DataFrame.pipe": {"effects": "pure", "returns": "internal", "cost": "O(1)",
                       "why": "returns the callback's result unaltered, which need not be fresh"},
    "DataFrame.rename": {"effects": "pure; mutates(0) when inplace", "returns": "None when inplace; alias(0) otherwise", "cost": "cells",
                         "why": "same buffers under new labels (measured: shared)"},
    "DataFrame.replace": {"effects": "pure; mutates(0) when inplace", "returns": "None when inplace; alias(0) otherwise", "cost": "cells",
                          "why": "may no-op-share when there is nothing to replace; otherwise copies the replaced columns and can share the rest"},
    "DataFrame.reset_index": {"effects": "pure; mutates(0) when inplace", "returns": "None when inplace; alias(0) otherwise", "cost": "cells",
                              "why": "the old columns' buffers can be the receiver's (measured: shared); the new index column is allocated"},
    "DataFrame.round": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new frame of rounded values"},
    "DataFrame.select_dtypes": {"effects": "pure", "returns": "alias(0)", "cost": "cells",
                                "why": "a column subset; the selected columns' buffers are the receiver's (measured: shared)"},
    "DataFrame.sort_values": {"effects": "pure; mutates(0) when inplace", "returns": "None when inplace; alias(0) otherwise",
                              "cost": "n log n in rows", "why": "a row permutation of the receiver; can share its column buffers"},
    "DataFrame.sum": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new Series of per-column reductions"},
    "DataFrame.to_dict": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new plain dict of values"},
    "DataFrame.to_numpy": {"effects": "pure", "returns": "alias(0)", "cost": "O(1)",
                           "why": "may share memory with the receiver (measured: shared)"},
    "DataFrame.to_string": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new string"},
    "DataFrame.unstack": {"effects": "pure", "returns": "fresh", "cost": "cells", "why": "a new pivoted frame"},
    "DataFrame.update": {"effects": "mutates(0)", "returns": "None", "cost": "cells", "why": "writes into the receiver's matching cells"},
    "DataFrame.value_counts": {"effects": "pure", "returns": "fresh", "cost": "n log n in rows", "why": "a new Series of counts"},
    "DataFrame.values": {"effects": "pure", "returns": "alias(0)", "cost": "O(1)", "why": "a view of the receiver's buffer (measured: shared)"},

    # --- pandas.Series ---
    "Series.any": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new bool"},
    "Series.apply": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new Series of the callback's per-element results"},
    "Series.astype": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a converted copy"},
    "Series.copy": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "an unconditional copy"},
    "Series.drop": {"effects": "pure; mutates(0) when inplace", "returns": "None when inplace; alias(0) otherwise", "cost": "size",
                    "why": "a label or row subset of the receiver (basic slicing)"},
    "Series.dropna": {"effects": "pure; mutates(0) when inplace", "returns": "None when inplace; alias(0) otherwise", "cost": "size",
                      "why": "a row subset of the receiver (basic slicing)"},
    "Series.eq": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new boolean Series"},
    "Series.fillna": {"effects": "pure; mutates(0) when inplace", "returns": "None when inplace; alias(0) otherwise", "cost": "size",
                      "why": "may no-op-share when there is nothing to fill"},
    "Series.get": {"effects": "pure", "returns": "alias(0)", "cost": "O(1)",
                   "why": "returns an element of the receiver: an alias of a mutable object under dtype object (measured)"},
    "Series.groupby": {"effects": "pure", "returns": "alias(0)", "cost": "size", "why": "the GroupBy holds the receiver"},
    "Series.head": {"effects": "pure", "returns": "alias(0)", "cost": "rows", "why": "row slicing: the result can share the receiver's buffers"},
    "Series.idxmax": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new label"},
    "Series.index": {"effects": "pure", "returns": "alias(0)", "cost": "O(1)", "why": "the receiver's Index object"},
    "Series.info": {"effects": "external (writes stdout)", "returns": "None", "cost": "size",
                    "why": "writes a summary to stdout; kept out of the dialect"},
    "Series.isin": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new boolean Series"},
    "Series.isna": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new boolean Series"},
    "Series.isnull": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new boolean Series"},
    "Series.items": {"effects": "pure", "returns": "internal", "cost": "size",
                     "why": "a generator of (label, value) pairs; object-dtype values alias the receiver's contents"},
    "Series.keys": {"effects": "pure", "returns": "alias(0)", "cost": "O(1)", "why": "the receiver's Index"},
    "Series.map": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new Series of the callback's per-element results"},
    "Series.max": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new scalar"},
    "Series.mean": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new scalar"},
    "Series.notna": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new boolean Series"},
    "Series.pipe": {"effects": "pure", "returns": "internal", "cost": "O(1)",
                    "why": "returns the callback's result unaltered, which need not be fresh"},
    "Series.rename": {"effects": "pure; mutates(0) when inplace", "returns": "None when inplace; alias(0) otherwise", "cost": "size",
                      "why": "same buffer under a new name (measured: shared)"},
    "Series.replace": {"effects": "pure; mutates(0) when inplace", "returns": "None when inplace; alias(0) otherwise", "cost": "size",
                       "why": "may no-op-share when there is nothing to replace"},
    "Series.reset_index": {"effects": "pure; mutates(0) when inplace", "returns": "None when inplace; alias(0) otherwise", "cost": "size",
                           "why": "the values' buffer can be the receiver's (measured: shared); the index columns are allocated"},
    "Series.round": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new Series of rounded values"},
    "Series.sort_values": {"effects": "pure; mutates(0) when inplace", "returns": "None when inplace; alias(0) otherwise",
                           "cost": "n log n in size", "why": "a permutation of the receiver; can share its buffer"},
    "Series.sum": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new scalar"},
    "Series.to_dict": {"effects": "pure", "returns": "fresh", "cost": "size",
                       "why": "a new plain dict; object-dtype values alias the receiver's contents, and writes to them are refused unless they are owned"},
    "Series.to_numpy": {"effects": "pure", "returns": "alias(0)", "cost": "O(1)",
                        "why": "may share memory with the receiver (measured: shared)"},
    "Series.to_string": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new string"},
    "Series.tolist": {"effects": "pure", "returns": "fresh", "cost": "size",
                      "why": "a new list; object-dtype items alias the receiver's contents, and writes to those items are refused unless they are owned"},
    "Series.unique": {"effects": "pure", "returns": "fresh", "cost": "n log n in size", "why": "a new array of unique values"},
    "Series.unstack": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new pivoted frame"},
    "Series.update": {"effects": "mutates(0)", "returns": "None", "cost": "size", "why": "writes into the receiver's matching values"},
    "Series.value_counts": {"effects": "pure", "returns": "fresh", "cost": "n log n in size", "why": "a new Series of counts"},
    "Series.values": {"effects": "pure", "returns": "alias(0)", "cost": "O(1)", "why": "a view of the receiver's buffer (measured: shared)"},

    # --- pandas.Index ---
    "Index.any": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new bool"},
    "Index.append": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new Index of concatenated labels"},
    "Index.astype": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a converted copy"},
    "Index.copy": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "an unconditional copy"},
    "Index.drop": {"effects": "pure", "returns": "alias(0)", "cost": "size", "why": "a label subset of the receiver (basic slicing)"},
    "Index.dropna": {"effects": "pure", "returns": "alias(0)", "cost": "size", "why": "a label subset of the receiver (basic slicing)"},
    "Index.fillna": {"effects": "pure", "returns": "alias(0)", "cost": "size", "why": "may no-op-share when there is nothing to fill"},
    "Index.groupby": {"effects": "pure", "returns": "internal", "cost": "size",
                      "why": "a dict whose values are slices of the receiver"},
    "Index.isin": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new boolean array"},
    "Index.isna": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new boolean array"},
    "Index.isnull": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new boolean array"},
    "Index.join": {"effects": "pure", "returns": "alias(0)", "cost": "size",
                   "why": "labels taken from one of the inputs; can share its buffer"},
    "Index.map": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new Index of the mapped labels"},
    "Index.max": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new label"},
    "Index.notna": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new boolean array"},
    "Index.rename": {"effects": "pure", "returns": "alias(0)", "cost": "O(1)", "why": "same values under a new name (measured: shared)"},
    "Index.round": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new Index of rounded labels"},
    "Index.sort_values": {"effects": "pure", "returns": "alias(0)", "cost": "n log n in size",
                          "why": "a permutation of the receiver; measured sharing its buffer"},
    "Index.to_numpy": {"effects": "pure", "returns": "alias(0)", "cost": "O(1)",
                       "why": "a view of the receiver's buffer (measured: shared)"},
    "Index.tolist": {"effects": "pure", "returns": "fresh", "cost": "size", "why": "a new list of labels"},
    "Index.unique": {"effects": "pure", "returns": "fresh", "cost": "n log n in size", "why": "a new Index of unique labels"},
    "Index.value_counts": {"effects": "pure", "returns": "fresh", "cost": "n log n in size", "why": "a new Series of counts"},
    "Index.values": {"effects": "pure", "returns": "alias(0)", "cost": "O(1)", "why": "a view of the receiver's buffer (measured: shared)"},

    # --- pandas.GroupBy ---
    "GroupBy.any": {"effects": "pure", "returns": "fresh", "cost": "rows", "why": "a new Series or frame of group reductions"},
    "GroupBy.apply": {"effects": "pure", "returns": "fresh", "cost": "rows", "why": "a new object assembled from the callback's per-group results"},
    "GroupBy.groups": {"effects": "pure", "returns": "internal", "cost": "rows",
                       "why": "a dict of Index slices of the grouped frame; the slices alias the receiver's frame"},
    "GroupBy.head": {"effects": "pure", "returns": "internal", "cost": "rows",
                     "why": "rows taken from the groups; they alias the grouped frame"},
    "GroupBy.idxmax": {"effects": "pure", "returns": "fresh", "cost": "rows", "why": "a new Series or frame of labels"},
    "GroupBy.keys": {"effects": "pure", "returns": "alias(0)", "cost": "O(1)",
                     "why": "the grouping keys, taken from the receiver's frame"},
    "GroupBy.max": {"effects": "pure", "returns": "fresh", "cost": "rows", "why": "a new Series or frame of group reductions"},
    "GroupBy.mean": {"effects": "pure", "returns": "fresh", "cost": "rows", "why": "a new Series or frame of group reductions"},
    "GroupBy.pipe": {"effects": "pure", "returns": "internal", "cost": "O(1)",
                     "why": "returns the callback's result unaltered, which need not be fresh"},
    "GroupBy.sum": {"effects": "pure", "returns": "fresh", "cost": "rows", "why": "a new Series or frame of group reductions"},
    "GroupBy.unique": {"effects": "pure", "returns": "fresh", "cost": "rows", "why": "a new object of per-group unique values"},
    "GroupBy.value_counts": {"effects": "pure", "returns": "fresh", "cost": "n log n in rows", "why": "a new Series of per-group counts"},

    # --- pandas.Series.str (the .str accessor) ---
    "str.casefold": {"effects": "pure", "returns": "fresh", "cost": "chars", "why": "a new string Series"},
    "str.contains": {"effects": "pure", "returns": "fresh", "cost": "chars",
                     "why": "a new boolean Series; pat is a regex by default, so the gate's backtracking check applies"},
    "str.len": {"effects": "pure", "returns": "fresh", "cost": "chars", "why": "a new integer Series"},
    "str.lower": {"effects": "pure", "returns": "fresh", "cost": "chars", "why": "a new string Series"},
    "str.replace": {"effects": "pure", "returns": "fresh", "cost": "chars",
                    "why": "a new string Series; pat is a regex when regex=True, so the gate's backtracking check applies"},
    "str.split": {"effects": "pure", "returns": "fresh", "cost": "chars", "why": "a new Series of lists"},
    "str.startswith": {"effects": "pure", "returns": "fresh", "cost": "chars", "why": "a new boolean Series"},
    "str.strip": {"effects": "pure", "returns": "fresh", "cost": "chars", "why": "a new string Series"},
    "str.upper": {"effects": "pure", "returns": "fresh", "cost": "chars", "why": "a new string Series"},

    # --- stdlib ---
    "decimal.Decimal": {"effects": "pure", "returns": "fresh", "cost": "digits",
                        "why": "a C type used by 10% of cells; ruled a day-one entry (repl-specs 2026-10-15)"},
    "decimal.getcontext": {"effects": "pure", "returns": "internal", "cost": "O(1)",
                           "why": "the live thread context: never owned"},
    "Decimal.max": {"effects": "pure", "returns": "fresh", "cost": "O(1)",
                    "why": "a new Decimal (measured: not either argument); Decimal is immutable either way"},
    "io.BytesIO": {"effects": "pure", "returns": "fresh", "cost": "input length",
                   "why": "a fresh writable buffer; its contents are its own"},
    "io.StringIO": {"effects": "pure", "returns": "fresh", "cost": "input length",
                    "why": "a fresh writable buffer; its contents are its own"},
    "math.fsum": {"effects": "pure", "returns": "fresh", "cost": "input length", "why": "a new float"},
    "random.choice": {"effects": "reads-external (the RNG)", "returns": "alias(0)", "cost": "O(1)",
                      "why": "returns one of the sequence's items, never a new object (measured)"},
    "re.compile": {"effects": "cache", "returns": "fresh", "cost": "input length",
                   "why": "a new pattern object; the re module's pattern cache is observational only"},
    "re.findall": {"effects": "pure", "returns": "fresh", "cost": "input length",
                   "why": "a new list of matches; the pattern is checked for backtracking before the call"},
    "re.search": {"effects": "pure", "returns": "fresh", "cost": "input length",
                  "why": "a Match or None; the pattern is checked for backtracking before the call"},
    "csv.DictReader": {"effects": "pure", "returns": "fresh", "cost": "input length",
                       "over": "an in-memory iterable (a StringIO or a list of lines), never a file",
                       "why": "_csv is C; ruled in as a leaf 2026-10-15"},
    "csv.reader": {"effects": "pure", "returns": "fresh", "cost": "input length",
                   "over": "an in-memory iterable (a StringIO or a list of lines), never a file",
                   "why": "_csv is C; ruled in as a leaf 2026-10-15"},
    "csv.writer": {"effects": "pure", "returns": "fresh", "cost": "input length",
                   "over": "an in-memory iterable (a StringIO or a list of lines), never a file",
                   "why": "_csv is C; ruled in as a leaf 2026-10-15"},

    # --- PIL ---
    "PIL.Image.fromarray": {"effects": "pure", "returns": "alias(0)", "cost": "pixels",
                            "why": "wraps the array's buffer for some dtypes (measured: L and RGBA share, RGB copies); never plain fresh"},
    "PIL.Image.open": {"effects": "read(buffer arg)", "returns": "fresh", "cost": "pixels",
                       "over": "an in-memory buffer the cell owns (a BytesIO), never a path",
                       "why": "open reads the path or buffer it is given: allowed only over an owned BytesIO, never a path"},
    "Image.save": {"effects": "write(buffer arg)", "returns": "None", "cost": "pixels",
                   "over": "an in-memory buffer the cell owns (a BytesIO), never a path",
                   "why": "save writes to the file or buffer it is given: allowed only into an owned BytesIO"},
}

_PIL_FNS = {"PIL.Image.fromarray", "PIL.Image.open"}
_STD_LIBS = ("base64.", "csv.", "decimal.", "io.", "math.", "random.", "re.", "string.")
_PANDAS_FNS = ("pandas.", "pd.")


def bucket(key: str) -> str:
    """Which `data/manifest-*.json` this leaf key belongs to: `numpy`, `pandas`, `PIL` or `stdlib`."""
    if key.startswith(("numpy.", "ndarray.")):
        return "numpy"
    if key.startswith(_PANDAS_FNS) or key.split(".")[0] in {"DataFrame", "Series", "Index", "GroupBy", "str", "dt"}:
        return "pandas"
    if key in _PIL_FNS or key.startswith("Image.") or key.startswith("PIL."):
        return "PIL"
    return "stdlib"


def leaves_for(name: str) -> dict[str, dict[str, Any]]:
    """The `leaves` mapping for one manifest, in key order."""
    return {k: v for k, v in sorted(LEAVES.items()) if bucket(k) == name}

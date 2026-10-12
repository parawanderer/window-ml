# Spec: gradient fills (Freeform gradient and Gradient Mesh) on WebGL2, with a differentiable CPU reference

**Status: built** (Shane, 2026-10-12; Lines added later the same day). Its first host is the
component gallery ([`COMPONENT_GALLERY.md`](COMPONENT_GALLERY.md)), as a custom entry with its own canvas.

## What it is

The two point-based fills from Illustrator, as one standalone module (the `src/lab/gradient/` folder):

- **Freeform gradient** ("Points" mode): values pinned at scattered points, interpolated over the plane.
- **Gradient mesh**: a grid of bicubic Bézier patches, each node carrying a position, tangent handles and a value.

Each fill exists twice, with the same maths:

1. a **WebGL2 renderer**, for drawing at interactive rates;
2. a **CPU reference evaluator** in plain TypeScript (Float64), which also returns **gradients with respect to every
   parameter** (a vector-Jacobian product). It is the ground truth the shader is tested against, and the thing an
   optimiser differentiates through, for example fitting a fill to an image by gradient descent.

**The module imports nothing from the rest of the repo**, so it can be copied into another project unchanged. It is
LAB code (`src/lab/`, the `@lab` PR label), and `tests/lab.test.mjs` holds every lab topic to that.

## Conventions shared by both fills

- **Values, not colours.** A fill interpolates a vector of `k ≤ 4` channels: a function `f: R² → R^k`. What the
  channels mean (sRGB, linear RGB, OKLab, a feature map) is the caller's business. The renderer maps channels 0..2 to
  RGB and channel 3 to alpha (1 when `k < 4`) and clamps to `[0,1]` only at output. The CPU reference returns the
  values UNCLAMPED, and its gradients are of the unclamped values.
- **Coordinates.** Height-normalised and y-down: a canvas of `W×H` pixels is `x ∈ [0, W/H]`, `y ∈ [0, 1]`. Distances are
  isotropic on any aspect ratio, and magnitudes stay near 1, which matters for float32 in the shader (`r² log r` of
  pixel distances would be ~10⁷). Pixel centres sit at `((i + ½)/H, (j + ½)/H)`.
- **The VJP shape.** Given sample points `X` (S of them) and an upstream gradient `G` (S × k, i.e. `∂L/∂f(x_s)`), return
  `∂L/∂θ` for every parameter θ of the fill, in the same structure as the fill's own description. A convenience
  `mseGrad(fill, X, targets)` returns the loss `½ Σ‖f(x_s) − t_s‖²` and its gradient through the same VJP.

## Freeform gradient

Points `p_i ∈ R²` (i = 1..N) with values `c_i ∈ R^k`. Two interpolants, chosen by `mode`.

### `tps`: thin-plate spline (default)

The minimum-bending-energy interpolant. Exact at the points, smooth (C¹, and C^∞ away from them), and it overshoots
between points of very different value, which the output clamp hides.

```
f(x) = Σ_i w_i φ(‖x − p_i‖) + a_0 + a_1 x + a_2 y,      φ(r) = r² log r,  φ(0) = 0
```

with the coefficients solving the (N+3)-square symmetric system

```
A [W; a] = [C; 0],     A = | Φ + λI   P |      Φ_ij = φ(‖p_i − p_j‖),   P_i = [1, x_i, y_i]
                           | Pᵀ       0 |
```

`λ ≥ 0` is the smoothing parameter (`smoothing`, default 0 = exact interpolation). The CPU solves the system (LU with
partial pivoting, O(N³); N is at most a few hundred) and the shader evaluates the sum, O(N) per pixel.

The polynomial part needs three points not on one line. **With N < 3, or the points collinear** (`|det PᵀP|` below a
tolerance), the fill falls back to `shepard`, and says so in the evaluator's result (`degenerate: true`).

**VJP.** Write `K(x)` for the row `[φ(‖x − p_1‖) … φ(‖x − p_N‖), 1, x, y]`, so `f(x) = K(x) 𝐖` with `𝐖 = A⁻¹ B`,
`B = [C; 0]`. With `ψ(r) = φ′(r)/r = 2 log r + 1`, so `∇_p φ(‖x − p‖) = −ψ(r)(x − p)` (taken as 0 at r = 0, its limit):

```
Ḡ_𝐖  = Σ_s K(x_s)ᵀ G_s                           ((N+3) × k)
Ḡ_B  = A⁻¹ Ḡ_𝐖                                    (A is symmetric)
Ḡ_A  = −Ḡ_B 𝐖ᵀ
∂L/∂c_i = Ḡ_B[i]
∂L/∂p_i = − Σ_s (G_s · 𝐖_i) ψ(r_si)(x_s − p_i)                        through K
          + Σ_{j≠i} (Ḡ_A[i,j] + Ḡ_A[j,i]) ψ(r_ij)(p_i − p_j)          through Φ
          + (Ḡ_A[i,N+1] + Ḡ_A[N+1,i],  Ḡ_A[i,N+2] + Ḡ_A[N+2,i])       through P (rows N+1, N+2 are x, y)
```

`λ` is a hyperparameter and gets no gradient.

### `shepard`: inverse-distance weighting, with per-point spread

Not exact at the points unless `soften = 0`, but local, closed-form, and the place Illustrator's per-point **spread**
fits naturally:

```
f(x) = Σ_i ω_i c_i / Σ_i ω_i,     ω_i(x) = s_i (‖x − p_i‖² + ε²)^(−q/2)
```

`s_i > 0` is the point's spread (default 1), `q` the power (`power`, default 2), `ε` the softening (`soften`, default
1e-3), which keeps `f` differentiable at the points. With `Ω = Σ ω_i`, `d_i² = ‖x − p_i‖²`:

```
∂f/∂c_i = ω_i / Ω
∂f/∂ω_i = (c_i − f) / Ω
∂ω_i/∂p_i = q ω_i (x − p_i) / (d_i² + ε²)
∂ω_i/∂s_i = ω_i / s_i
```

### Lines: values along curves, as sampled constraints

Illustrator's Freeform "Lines" mode pins values along a curve rather than at a point. A **line** is an ordered list of
stops (each a `FreeformPoint`: position, value, spread). This is the cheap version: each line is sampled into
constraint points, which join the free points, and the fill is interpolated from all of them by `tps` or `shepard` as
before. Nothing else about the interpolant changes.

- **The curve** through the stops `P_0 … P_{M−1}` is a uniform Catmull-Rom spline. Segment `i` (from `P_i` to `P_{i+1}`)
  at `t ∈ [0, 1]` is

  ```
  C_i(t) = ½ [ (−t³ + 2t² − t) P_{i−1} + (3t³ − 5t² + 2) P_i + (−3t³ + 4t² + t) P_{i+1} + (t³ − t²) P_{i+2} ]
  ```

  with the ends extended by reflection, `P_{−1} = 2P_0 − P_1` and `P_M = 2P_{M−1} − P_{M−2}`. UNIFORM, not centripetal:
  centripetal knots depend on the distances between stops, which would make a sample's position nonlinear in them.
- **Values and spreads** run linearly in `t` between consecutive stops, `c(t) = (1 − t) c_i + t c_{i+1}`, so a value
  never overshoots along the line.
- **Samples.** Each segment gives `samples` points (default 8) at `t = s / samples`, `s = 0 … samples − 1`, and the line's
  last stop closes it. A line of one stop is that point; a line of none adds nothing.

Every sample is a FIXED linear combination of its line's stops, `x_j = Σ_m α_jm P_m` and `c_j = Σ_m γ_jm c_m` (spread
as `c`). So the gradient with respect to a stop is the gradient with respect to the samples pulled back through the
transpose:

```
∂L/∂P_m = Σ_j α_jm ∂L/∂x_j        ∂L/∂c_m = Σ_j γ_jm ∂L/∂c_j        ∂L/∂s_m = Σ_j γ_jm ∂L/∂s_j
```

`flattenFreeform` returns the expanded fill (points only) and these weights. `evalFreeform`, `vjpFreeform` and the
renderer go through it; `solveTps` takes points only. `samples` is a hyperparameter and gets no gradient.

What the cheap version costs:

- **The line holds only at its samples.** Between two samples the thin-plate surface bends freely, so a sharp change
  of value across a line leaks between them. Space the samples well under the size of the features you care about.
- **N grows** by `samples` per segment, and the `tps` solve is O(N³): ten lines of four segments at 8 samples is 330
  points, the size of the stress test.
- **Conditioning.** Two lines crossing, or a free point on a line, with different values there, put two near-equal
  rows into the system with different right-hand sides. `smoothing` keeps it solvable; `tps` falls back to `shepard`
  only when it is exactly singular.
- **`shepard` weighs a line by its sample density**: a line of 33 samples outweighs a free point nearby. Lower the
  stops' spread to compensate.
- **Uniform Catmull-Rom can loop or cusp** when neighbouring stops are spaced very unevenly.

### Not in the first build

- **Faithful Lines**: diffusion curves (Orzan et al. 2008), where the curves are boundary conditions held everywhere
  along them: rasterise the curves and solve Laplace/biharmonic by multigrid on ping-pong textures. Its gradient goes
  through the solver (the adjoint is another solve of the same system).
- A per-point spread for `tps`. It has no natural one; a Gaussian or Wendland RBF with a radius per point would give
  one, at the price of a non-symmetric system.

## Gradient mesh

A grid of `(m+1) × (n+1)` nodes, node `(i, j)` (row i, column j) carrying:

- a position `P ∈ R²`;
- two tangents, `U` along a row (the u direction) and `V` down a column (v), in units of one patch. The Bézier handles
  Illustrator draws are `P ± U/3` and `P ± V/3`. The handles are SYMMETRIC (a smooth mesh point); independent handles
  per side are a later extension that only changes how a patch reads its corners;
- a value `C ∈ R^k`.

### Geometry: bicubic Hermite with zero twist

Patch `(i, j)` covers `(u, v) ∈ [0,1]²` between nodes `(i, j)`, `(i, j+1)`, `(i+1, j)`, `(i+1, j+1)`. With the Hermite
basis `H_0(t) = 2t³ − 3t² + 1`, `H_1(t) = −2t³ + 3t²`, `T_0(t) = t³ − 2t² + t`, `T_1(t) = t³ − t²`, and corners
`(a, b) ∈ {0,1}²`:

```
S(u, v) = Σ_{a,b} H_a(u) H_b(v) P_ab + T_a(u) H_b(v) U_ab + H_a(u) T_b(v) V_ab
```

This is the tensor-product Bézier patch whose inner control points are set by zero twist (`b_11 = P + (U + V)/3`, and
the same from each corner). Neighbouring patches share their edge curve, so the mesh is C⁰ in position everywhere and C¹
across an edge whose tangents agree, which symmetric handles give.

**`S` is LINEAR in every node position and tangent**: `S(u, v) = Σ_k β_k(u, v) θ_k`. That is what makes its gradient
cheap.

### Values: `bilinear` (default) or `bicubic`

- **`bilinear`** interpolates the four corner values over `(u, v)`. This is what PDF shading types 6 and 7 (Coons and
  tensor-product patch meshes, ISO 32000 §8.7.4.5.7–8) specify and what Illustrator emits, so it is the faithful default.
  The value is C⁰ across patch edges; the smoothness comes from the geometry bending the parameter space.
- **`bicubic`** uses the same Hermite form as the geometry, with value tangents taken from neighbouring nodes
  (Catmull-Rom: `C_u = (C_{i,j+1} − C_{i,j−1}) / 2`, one-sided at the border) and zero twist. C¹ across edges, still
  linear in the node values. Better for fitting.

### Rendering

Each patch is one instance of a `T × T` tessellated grid (`tessellation`, default 24). The vertex shader reads the
four corners from a float texture (`texelFetch`, one node per texel row group) and evaluates `S(u, v)`; the fragment
shader receives `(u, v)` and the patch index (flat) and evaluates the VALUE per fragment, so the value is exact for the
interpolated `(u, v)`. The remaining approximation is the linear interpolation of `(u, v)` across a triangle, an
O(1/T²) error in where a value lands.

**Overlap.** Where the mesh folds over itself, the later patch wins (instance order = row-major patch order), and within
a patch, the later triangle (row-major in `(v, u)`). The CPU reference resolves a fold the same way.

### Pixel-space evaluation and its gradient

The mesh is a FORWARD map from `(u, v)` to the plane; a loss on pixels needs the inverse. The reference finds, for a
pixel `x`, every patch whose bounding box (of its 16 Bézier control points, which contain the patch) holds `x`, solves
`S(u, v) = x` by Newton from a few starts, accepts a root in `[0,1]²` with a small residual, and keeps the one drawn
last. A pixel the mesh does not cover has no value and contributes no gradient.

At a covered pixel, `f(x; θ) = V(u*, v*; θ_C)` with `S(u*, v*; θ_G) = x`. By the implicit function theorem, with
`J = [∂S/∂u  ∂S/∂v]` (2 × 2):

```
∂(u*, v*)/∂θ_G = −J⁻¹ ∂S/∂θ_G = −J⁻¹ β_k(u*, v*)
```

so, for one sample with upstream gradient `g = G_s`:

```
∂L/∂C_node += g · b_node(u*, v*)                           (the value basis, bilinear or bicubic)
q = gᵀ [∂V/∂u  ∂V/∂v]                                       (a row of 2)
∂L/∂θ_k   −= (q J⁻¹) β_k(u*, v*)                            for every position and tangent θ_k of the 4 corners
```

**Not differentiated: coverage.** Moving the mesh boundary moves which pixels are covered, a discontinuity this
gradient does not see (the silhouette problem of differentiable rasterisers). Fitting works on the interior; a soft
edge is an open item.

## Tests

- **Finite differences**: every VJP against central differences on random fills, both modes, both value interpolations,
  including points near each other and samples near a point.
- **Interpolation properties**: `tps` with λ = 0 is exact at the points and reproduces an affine function exactly;
  `shepard` with ε = 0 is exact at the points; a mesh with straight edges and zero-twist tangents of one patch's
  width is the identity-like bilinear map; a bilinear mesh is exact at the nodes.
- **The shader against the reference**: render in Chromium (Playwright, software GL), `readPixels`, and compare with
  the CPU at the pixel centres, within a tolerance that accounts for float32 and the mesh tessellation.
- **Standalone**: nothing under `src/lab/gradient/` imports from outside it.
